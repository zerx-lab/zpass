import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  powerMonitor,
  shell,
  Tray,
} from "electron";
import { type FSWatcher, watch as fsWatch } from "node:fs";
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startBackend, type Backend } from "./backend";
import { installNativeMessagingHosts } from "./nmh-install";
import {
  checkForUpdates,
  initAutoUpdater,
  openReleasePage,
  quitAndInstall,
} from "./updater";

// Boot trace: emit labelled deltas to stderr when RELAY_BOOT_TRACE=1. Used to
// measure cold-start phase distribution without shipping the noise to users.
const bootTraceEnabled = process.env.RELAY_BOOT_TRACE === "1";
const bootTraceStart = Date.now();
function bootTrace(label: string) {
  if (!bootTraceEnabled) return;
  process.stderr.write(
    `[trace:main] ${label} +${(Date.now() - bootTraceStart).toFixed(0)}ms\n`,
  );
}
bootTrace("module-load");

// These globals are injected by @electron-forge/plugin-vite at build time.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Pin the app name so Wayland's xdg_toplevel.app_id is stable ("zpass").
app.setName("zpass");

// Chromium command-line tuning. MUST run before app.whenReady() resolves
// because these flags are read when the GPU/utility processes spawn.
//
// - `CalculateNativeWinOcclusion` is a Windows-only background-window tracker
//   that adds 200-300ms to first paint on cold start. We never minimize-to-tray
//   so the occlusion data is unused.
// - `Vulkan` is force-disabled because the bundled libvk_swiftshader fallback
//   crashes the GPU process on Wayland sessions ("'--ozone-platform=wayland'
//   is not compatible with Vulkan"), causing a ~500ms retry storm before
//   Chromium falls back to GLES. Verified locally with RELAY_BOOT_TRACE=1.
app.commandLine.appendSwitch(
  "disable-features",
  "CalculateNativeWinOcclusion,Vulkan",
);
// Keeps the renderer at full priority when the window is occluded/minimized.
// We're a single-window app; throttling background renderers buys us nothing
// and delays the first post-show interaction.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
// Skips Chromium's "is this the default browser?" probe on first launch.
app.commandLine.appendSwitch("no-default-browser-check");

if (process.platform === "linux") {
  // Let Chromium pick the Ozone backend based on the active session:
  // native Wayland when WAYLAND_DISPLAY is set, X11 otherwise.
  //
  // History: we briefly pinned `ozone-platform=x11` to silence two harmless
  // log ERRORs (`wayland_surface_factory.cc: '--ozone-platform=wayland' is
  // not compatible with Vulkan` and `viz/.../display.cc: Frame latency is
  // negative`). That trade-off backfires on NVIDIA + Wayland: the XWayland
  // GPU process crashes (`exit_code=139`, `XGetWindowAttributes failed`)
  // immediately on first command-buffer creation and the window never
  // appears. Going back to `ozone-platform-hint=auto` restores those two
  // ERROR lines but keeps the app actually launchable on common Linux
  // setups. The Vulkan crash itself is still suppressed by the
  // `disable-features=Vulkan` switch above.
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  // Set WM_CLASS so the window manager can match the window to
  // /usr/share/applications/zpass.desktop and use the hicolor `zpass` icon.
  // The value must match the .desktop file's basename (`zpass.desktop`)
  // and its `StartupWMClass=zpass` field. Applies to both X11 (WM_CLASS)
  // and Wayland (xdg_toplevel.app_id) backends.
  app.commandLine.appendSwitch("class", "zpass");
}

let backend: Backend | null = null;
// Tracks the in-flight or resolved backend so the handshake IPC can await it
// without blocking window creation. Replaced atomically on hot restart.
let backendPromise: Promise<Backend> | null = null;
let reloading = false;

const RELOAD_FILE = join(app.getAppPath(), ".dev-reload");

// -------- Tray & close-behavior state --------------------------------------
//
// `closeBehavior` is mirrored from the renderer's `prefs.closeBehavior`
// preference via the `desktop:window:set-close-behavior` IPC. The renderer
// pushes the current value at startup (after prefs hydrate) and again on
// every change. We default to "quit" so before the first push lands the
// app behaves like a vanilla Electron desktop app.
//
// `quittingForReal` flips to true when the user explicitly chooses Quit
// (tray menu, Cmd+Q via macOS, `before-quit` from another path). The
// BrowserWindow 'close' handler uses it to bypass the hide-to-tray override
// — without this flag, calling `app.quit()` while in tray mode would just
// hide the window again and the process would never exit.
//
// `tray` is null until `app.whenReady()` resolves; the tray icon must be
// constructed on the UI thread, after Electron's GPU/IPC is up.
let closeBehavior: "quit" | "tray" = "quit";
let quittingForReal = false;
let tray: Tray | null = null;
// 开机免打扰启动：登录项注册时带上 `--hidden`（Linux autostart 的 Exec 同理），
// 本次进程若由登录项以该参数拉起，首个窗口创建为隐藏、直接驻留托盘。
// macOS 额外认 `wasOpenedAsHidden`（openAsHidden 登录项不传 argv）。
const startHidden =
  process.argv.includes("--hidden") ||
  (process.platform === "darwin" &&
    app.getLoginItemSettings().wasOpenedAsHidden);
// We track the primary window globally so the tray (which is created in
// `app.whenReady`, not inside `createWindow`) can show/focus it without
// re-querying BrowserWindow.getAllWindows() every click.
let mainWindow: BrowserWindow | null = null;

// Spawn the Go sidecar as early as possible — at module load, BEFORE
// app.whenReady() resolves. The Go binary is independent of Electron init, so
// running them in parallel shaves ~100ms off the time-to-first-API-call on a
// cold start. `ipcMain.handle` is a JS-only event emitter and can be set up
// here too; the renderer cannot call it until its WebContents exist anyway.
//
// Errors are captured so the handler can re-raise them once a renderer asks
// — we never want a rejected promise to be left dangling unhandled.
backendPromise = startBackend();
bootTrace("backend-spawned");
backendPromise.then(
  (b) => {
    backend = b;
    bootTrace("backend-handshake");
  },
  (err) => {
    process.stderr.write(`[boot] backend failed to start: ${String(err)}\n`);
  },
);

// macOS / Windows 浏览器 native messaging host 静默自检 / 更新。
// 跑在 backend spawn 之后、whenReady 之前 —— 与 Go sidecar 启动并行,纯文件 IO
// (Windows 额外走 reg.exe 写 HKCU),不阻塞窗口创建。不支持的平台内部 early
// return。任何失败都不能让 GUI 起不来,所以 catch 兜底,异常只走 stderr。
void installNativeMessagingHosts().catch((err) => {
  process.stderr.write(`[nmh] install task failed: ${String(err)}\n`);
});

// Re-reads `backendPromise` on every call so post-reload renderers get the
// fresh port/token. The renderer never sees Node APIs.
ipcMain.handle("desktop:handshake", async () => {
  if (!backendPromise) throw new Error("backend not started");
  const b = await backendPromise;
  bootTrace("handshake-ipc-resolved");
  return b.handshake;
});

// Window control IPC handlers. The renderer talks to BrowserWindow indirectly
// via the preload bridge; we look up the focused window per-call so the
// handlers work uniformly across multi-window setups (currently we only
// create one, but future feature work like a popup minivault should be able
// to reuse the same IPC surface).
function focusedWin(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  );
}
ipcMain.handle("desktop:window:minimise", () => {
  focusedWin()?.minimize();
});
ipcMain.handle("desktop:window:maximise", () => {
  focusedWin()?.maximize();
});
ipcMain.handle("desktop:window:unmaximise", () => {
  focusedWin()?.unmaximize();
});
ipcMain.handle("desktop:window:toggle-maximise", () => {
  const w = focusedWin();
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.handle("desktop:window:is-maximised", () => {
  return focusedWin()?.isMaximized() ?? false;
});
ipcMain.handle("desktop:window:is-fullscreen", () => {
  return focusedWin()?.isFullScreen() ?? false;
});
ipcMain.handle("desktop:window:unfullscreen", () => {
  focusedWin()?.setFullScreen(false);
});
ipcMain.handle("desktop:window:close", () => {
  // Always go through `win.close()` so the BrowserWindow 'close' handler
  // installed in createWindow() can intercept it when closeBehavior=="tray".
  // (Calling `win.hide()` directly here would also work, but routing through
  // 'close' keeps a single code path and lets the OS-level Cmd+W / Alt+F4
  // keep the same behavior as our custom titlebar X.)
  focusedWin()?.close();
});

// Windows-only: pop the native window system menu (Restore / Move / Resize /
// Minimize / Maximize / Close) at the given client-area coordinates. Routed
// through IPC so the renderer's custom titlebar can fire it on right-click
// in the drag region (Windows 11 expectation — frameless windows that don't
// implement this lose the system menu entirely, breaking accessibility for
// keyboard-only users who reach this menu via Alt+Space).
//
// On macOS/Linux this is a no-op: macOS has no equivalent window system menu
// (Apple uses application menu bar + Mission Control), and Linux WMs handle
// alt+drag/super+drag natively without an in-window menu.
ipcMain.handle(
  "desktop:window:show-system-menu",
  (_ev, coords: { x?: number; y?: number }) => {
    if (process.platform !== "win32") return;
    const win = focusedWin();
    if (!win) return;
    const point: { x: number; y: number } | undefined =
      typeof coords?.x === "number" && typeof coords?.y === "number"
        ? { x: Math.round(coords.x), y: Math.round(coords.y) }
        : undefined;
    // Electron 35+: win.showSystemMenu(opts) was deprecated in favor of
    // hwnd.popupSystemMenu via webContents. The simplest cross-version
    // approach is to manually emit WM_SYSMENU via setBackgroundMaterial
    // proxy — but that's brittle. Instead we call win.showSystemMenu()
    // when available (Electron 30.0.0+), falling back to a synthesized
    // Menu.popup for older shells.
    type WinWithSysMenu = typeof win & {
      showSystemMenu?: (opts?: { x: number; y: number }) => void;
    };
    const w = win as WinWithSysMenu;
    if (typeof w.showSystemMenu === "function") {
      try {
        w.showSystemMenu(point);
        return;
      } catch (err) {
        process.stderr.write(
          `[sysmenu] showSystemMenu failed: ${String(err)}\n`,
        );
      }
    }
  },
);

ipcMain.handle("desktop:window:toggle-fullscreen", () => {
  const win = focusedWin();
  if (!win) return;
  win.setFullScreen(!win.isFullScreen());
});
ipcMain.handle(
  "desktop:window:set-close-behavior",
  (_ev, mode: "quit" | "tray") => {
    if (mode !== "quit" && mode !== "tray") return;
    closeBehavior = mode;
  },
);

// -------- Launch-at-login (开机启动) ---------------------------------------
//
// 跨三端落地"系统登录时自动启动 ZPass"。该偏好的真源是渲染层 prefs
// (`launchAtLogin`)，ThemeSync 在 hydrate 与每次变更时通过下面的 IPC 推送，
// 主进程把它翻译成各平台的原生登录项。push 是幂等的：重复写同一状态无副作用。
//
// 平台差异：
//   - macOS / Windows：Electron 原生 `app.setLoginItemSettings({openAtLogin})`。
//   - Linux：Electron 无原生支持，按 XDG autostart 规范手写 / 删除
//     `$XDG_CONFIG_HOME/autostart/zpass.desktop`（默认 `~/.config/autostart`）。
//
// 关键陷阱：
//   - **dev 守护**：非打包构建下注册登录项会把开发用的 electron 二进制写进
//     系统登录项，污染开发者机器。`app.isPackaged` 为假时一律 no-op。
//   - **AppImage 路径**：AppImage 运行时 `process.execPath` 指向临时挂载点
//     （/tmp/.mount_xxx），退出即失效。autostart 必须写 `$APPIMAGE`
//     （AppImage 运行时注入的、指向 .AppImage 文件本身的稳定路径），
//     回退到 `process.execPath`（deb/rpm/pacman 安装的固定路径）。

/** Linux autostart .desktop 文件的绝对路径（尊重 XDG_CONFIG_HOME）。 */
function linuxAutostartFile(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configHome, "autostart", "zpass.desktop");
}

/**
 * 应用"开机启动"偏好到操作系统。enabled=true 注册登录项，false 移除。
 * 任何失败都吞掉并记录到 stderr —— 登录项写入不该阻断应用主流程。
 */
async function applyLaunchAtLogin(
  enabled: boolean,
  hidden: boolean,
): Promise<void> {
  // dev 下不碰系统登录项，避免把开发用 electron 二进制注册进去。
  if (!app.isPackaged) {
    process.stderr.write(
      `[autostart] skipped in dev (isPackaged=false), would set openAtLogin=${enabled} hidden=${hidden}\n`,
    );
    return;
  }

  if (process.platform === "linux") {
    const file = linuxAutostartFile();
    try {
      if (enabled) {
        // AppImage 下 execPath 是临时挂载点；$APPIMAGE 才是稳定的可执行路径。
        const exec = process.env.APPIMAGE ?? process.execPath;
        const content = [
          "[Desktop Entry]",
          "Type=Application",
          "Version=1.0",
          "Name=ZPass",
          "Comment=ZPass password manager",
          `Exec="${exec}"${hidden ? " --hidden" : ""}`,
          "Icon=zpass",
          "Terminal=false",
          "X-GNOME-Autostart-enabled=true",
          "",
        ].join("\n");
        await fsMkdir(join(file, ".."), { recursive: true });
        await fsWriteFile(file, content, "utf8");
      } else {
        await fsRm(file, { force: true });
      }
    } catch (err) {
      process.stderr.write(
        `[autostart] linux autostart write failed: ${String(err)}\n`,
      );
    }
    return;
  }

  // macOS / Windows：Electron 原生 API。Windows 通过 args 传 `--hidden`，
  // macOS 用 openAsHidden（登录项不传 argv，启动侧认 wasOpenedAsHidden）。
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: hidden,
      args: hidden ? ["--hidden"] : [],
    });
  } catch (err) {
    process.stderr.write(
      `[autostart] setLoginItemSettings failed: ${String(err)}\n`,
    );
  }
}

ipcMain.handle(
  "desktop:app:set-launch-at-login",
  async (_ev, enabled, hidden) => {
    if (typeof enabled !== "boolean") return;
    await applyLaunchAtLogin(enabled, hidden === true);
  },
);

// Auto-update IPC — renderer-driven manual check / install / open-download.
// State transitions are pushed back over the `zpass:update:event` channel.
ipcMain.handle("desktop:update:check", () => checkForUpdates());
ipcMain.handle("desktop:update:install", () => {
  quitAndInstall();
});
ipcMain.handle("desktop:update:open", (_ev, url: string) => {
  if (typeof url !== "string" || url === "") return;
  openReleasePage(url);
});

// Save-file dialog — replaces the Wails 3 ExportService dialog. The Go side
// now takes a path argument (or empty for cancel); we pick the path here.
ipcMain.handle(
  "desktop:dialog:save-file",
  async (
    _ev,
    opts: {
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
    },
  ) => {
    const win = focusedWin();
    const result = win
      ? await dialog.showSaveDialog(win, {
          defaultPath: opts.defaultPath,
          filters: opts.filters,
        })
      : await dialog.showSaveDialog({
          defaultPath: opts.defaultPath,
          filters: opts.filters,
        });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  },
);

// Reveal a file in the OS file manager (Finder / Explorer / Nautilus). Used by
// the export-success toast's "open folder" action so users don't have to copy
// the long backup path by hand. shell.showItemInFolder selects the file as
// well — we open the parent dir and highlight the freshly-written backup.
//
// `path` must be an absolute path the renderer just received from a trusted
// backend call (e.g. ExportService.ExportAllToFile). We do NOT take arbitrary
// renderer-supplied paths to navigate to; the renderer is sandboxed but this
// IPC still touches the user's shell so we keep the contract narrow.
ipcMain.handle("desktop:shell:show-in-folder", (_ev, path: string) => {
  if (typeof path !== "string" || path === "") return;
  shell.showItemInFolder(path);
});

/**
 * Dev-only hot restart triggered when scripts/dev-watcher.mjs touches the
 * `.dev-reload` trigger file after a successful Go rebuild. Respawns the
 * sidecar — the new handshake carries fresh port/token — then reloads
 * renderers so the cached API client is rebuilt.
 *
 * The Go rebuild itself is owned by the watcher, NOT this function: keeping
 * orchestration in one place (a Node script invoking `task`) avoids running
 * the toolchain inside Electron's main process.
 */
async function reloadBackend() {
  if (reloading) return;
  reloading = true;
  // Start the new sidecar BEFORE killing the old one. If the new binary
  // fails to hand-shake (panic, port bind failure, parse error), the old
  // one stays alive and the renderer keeps working — failing dev should
  // not break a running session.
  const oldBackend = backend;
  try {
    process.stderr.write("[dev] restarting Go sidecar...\n");
    const nextPromise = startBackend();
    // Publish the in-flight promise immediately so any handshake IPC arriving
    // during the restart awaits the new sidecar rather than the dying one.
    backendPromise = nextPromise;
    const next = await nextPromise;
    backend = next;
    oldBackend?.stop();
    process.stderr.write(`[dev] sidecar up on ${next.handshake.baseUrl}\n`);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.reloadIgnoringCache();
    }
  } catch (err) {
    // Roll back to the still-alive previous sidecar so subsequent handshake
    // IPCs don't await the rejected promise forever.
    if (oldBackend) backendPromise = Promise.resolve(oldBackend);
    process.stderr.write(
      `[dev] restart failed (keeping previous sidecar): ${String(err)}\n`,
    );
  } finally {
    reloading = false;
  }
}

/**
 * Watch `.dev-reload`; any write (mtime change) triggers reloadBackend().
 * Cross-platform: works the same on Linux (inotify), macOS (FSEvents) and
 * Windows (ReadDirectoryChangesW). No POSIX signals involved.
 *
 * Implementation note: fs.watch fires on a file only if the file exists at
 * watch-start time. We watch the parent directory and filter by filename so
 * the trigger file can be created on the fly by the watcher script.
 */
function installDevReloader() {
  if (app.isPackaged) return;
  const dir = app.getAppPath();
  let lastMtimeMs = 0;
  let fsWatcher: FSWatcher;

  // Async to avoid blocking the main thread on stat() (slow on Windows
  // with antivirus or network drives). fs.watch's `filename` argument is
  // documented as possibly null on some platforms (older Linux kernels,
  // network filesystems), so we don't filter on it — we stat unconditionally
  // and dedupe by mtime.
  const onEvent = async () => {
    let mtimeMs: number;
    try {
      ({ mtimeMs } = await fsStat(RELOAD_FILE));
    } catch {
      return; // trigger file not yet present, or vanished between events
    }
    if (mtimeMs === lastMtimeMs) return;
    lastMtimeMs = mtimeMs;
    void reloadBackend();
  };

  try {
    fsWatcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
      // Soft filter: if the platform reports filename (Linux/macOS/Windows
      // all do in modern Node), skip work for unrelated changes. When
      // filename is null we still stat to be safe.
      if (filename != null && filename !== ".dev-reload") return;
      void onEvent();
    });
  } catch (err) {
    process.stderr.write(
      `[dev] cannot watch ${dir} for hot restart: ${String(err)}\n`,
    );
    return;
  }
  app.on("before-quit", () => fsWatcher.close());
  process.stderr.write(
    "[dev] hot-restart armed (watching .dev-reload). Save any *.go to trigger.\n",
  );
}

/**
 * Resolve the window/tray icon. In dev the working dir is the repo root, in
 * a packaged app the PNGs live next to the asar under `resources/assets/`.
 *
 * `preferredSize` lets the tray pick the right pixel density (Linux/Windows
 * tray icons want 16-32px; macOS template icons want 22pt @1x/@2x). When
 * omitted we return the 256px master which is what BrowserWindow's
 * titlebar/taskbar wants.
 */
function resolveIcon(preferredSize?: 16 | 32 | 48 | 64 | 128 | 256) {
  const size = preferredSize ?? 256;
  // `extraResource: ["./assets/logo"]` 把目录复制到 resources/logo/ (只保留
  // 末段目录名), 所以 packaged 时正确路径是 resources/logo/png/...,
  // 不是 resources/assets/logo/png/... — 后者只是 dev 时 __dirname 解析的
  // 副产物. 两条都保留, 避免未来 extraResource 改回 ./assets 时再炸.
  const candidates = [
    join(__dirname, `../../assets/logo/png/zpass-${size}.png`),
    join(process.resourcesPath ?? "", `logo/png/zpass-${size}.png`),
    join(process.resourcesPath ?? "", `assets/logo/png/zpass-${size}.png`),
    join(process.cwd(), `assets/logo/png/zpass-${size}.png`),
  ];
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  return undefined;
}

/**
 * Show / focus the main window. Used by the tray's left-click handler and
 * Show menu item. On Linux a hidden BrowserWindow needs `show()` to map
 * back onto the compositor before `focus()` can take effect; on Windows the
 * same window also needs `restore()` if it was minimised to taskbar.
 */
function showMainWindow() {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win) {
    // Edge case: tray clicked after window-all-closed but before activate.
    // Just rebuild the window.
    void createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * Tray menu — rebuilt on every right-click so labels can be re-localized
 * later (Electron has no built-in "rerender on locale change" hook, but
 * since the menu is rebuilt every time, swapping the strings just requires
 * piping the current i18n bundle into here — TODO for when we wire that).
 *
 * Current labels are English fallbacks; the renderer can override them via
 * a future `desktop:tray:set-labels` IPC if we want full i18n parity.
 */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Show ZPass",
      click: () => showMainWindow(),
    },
    { type: "separator" },
    {
      label: "Quit ZPass",
      click: () => {
        // Mark intent so the BrowserWindow 'close' handler stops intercepting,
        // then ask Electron to perform a clean shutdown (fires before-quit,
        // will-quit, etc. — sidecar cleanup runs in our before-quit listener).
        quittingForReal = true;
        app.quit();
      },
    },
  ]);
}

/**
 * Install the system tray icon. Called once after `app.whenReady()`.
 *
 * Design choices:
 *   - The tray icon is ALWAYS visible while the app runs, regardless of
 *     `closeBehavior`. Hiding/showing the tray based on preference would
 *     surprise users mid-session (their reference point disappears).
 *   - Left-click on Linux/Windows toggles show/focus; macOS doesn't fire
 *     a "click" event for trays — there only the menu is exposed (system
 *     UX convention).
 *   - We attach the context menu via `setContextMenu` rather than
 *     `popUpContextMenu` so platforms that have native right-click
 *     handling (GNOME via AppIndicator, KDE Plasma) drive it for us.
 */
function installTray() {
  // 16px master is the right size for Windows/Linux trays; macOS template
  // icons are usually 22pt at 1x — close enough for our non-template icon.
  const img =
    resolveIcon(32) ?? resolveIcon(16) ?? resolveIcon(64) ?? resolveIcon(256);
  if (!img) {
    process.stderr.write(
      "[tray] could not locate tray icon, skipping tray install\n",
    );
    return;
  }
  try {
    tray = new Tray(img);
  } catch (err) {
    // On Linux, Tray() throws when no StatusNotifier (AppIndicator) host is
    // running. We don't want this to bring down the whole app — the user
    // can still close-to-quit normally.
    process.stderr.write(
      `[tray] failed to create system tray (no indicator host?): ${String(
        err,
      )}\n`,
    );
    return;
  }
  tray.setToolTip("ZPass");
  tray.setContextMenu(buildTrayMenu());

  // Left-click on the tray icon → show/focus window. This is the Linux
  // expectation (especially when minimised-to-tray is enabled) and matches
  // most Windows users' muscle memory. macOS doesn't fire this event for
  // tray icons — there the menu is the only interaction surface, by OS
  // convention.
  tray.on("click", () => {
    showMainWindow();
  });
  // Some Linux DEs (KDE) and Windows fire 'right-click' for the context
  // menu; we let setContextMenu handle that on macOS/Win, but explicitly
  // popping ensures it always works on Linux AppIndicator hosts that don't
  // route right-clicks to the menu automatically.
  tray.on("right-click", () => {
    tray?.popUpContextMenu();
  });
}

/**
 * Build & install the native application menu.
 * -----------------------------------------------------------------------------
 * Without `Menu.setApplicationMenu(...)` Electron renders its default English
 * menu — "Electron / File / Edit / View / Window / Help" with developer items
 * like "Toggle DevTools" shown to end users. macOS treats the application
 * menu as required (Apple HIG); Windows / Linux can hide it but we install a
 * minimal version anyway so accelerators (Ctrl+Q, Ctrl+,) line up with the
 * renderer's own shortcuts.
 *
 * Cross-platform notes:
 *   - On macOS the first menu item label is replaced by the app's binary
 *     name automatically; we still set `label: "ZPass"` so it survives an
 *     unsigned dev build where the binary is `Electron`.
 *   - DevTools / Reload items are only added when not packaged.
 *   - Accelerator strings use Electron's CommandOrCtrl modifier so the
 *     mapping is automatic (⌘ on mac, Ctrl elsewhere).
 *   - The menu does NOT include i18n strings — those live in the renderer.
 *     Re-localising the native menu on the fly requires re-building it on
 *     locale change; not done in this pass.
 */
function installAppMenu() {
  const isMac = process.platform === "darwin";
  const isDev = !app.isPackaged;

  const macAppMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: "ZPass",
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: "Lock Vault",
              accelerator: "Cmd+L",
              click: () => {
                const win = focusedWin();
                win?.webContents.send("desktop:menu:lock");
              },
            },
            {
              label: "Preferences…",
              accelerator: "Cmd+,",
              click: () => {
                const win = focusedWin();
                win?.webContents.send("desktop:menu:open-settings");
              },
            },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac
        ? ([
            { role: "pasteAndMatchStyle" } as MenuItemConstructorOptions,
            { role: "delete" } as MenuItemConstructorOptions,
            { role: "selectAll" } as MenuItemConstructorOptions,
          ] satisfies MenuItemConstructorOptions[])
        : ([
            { role: "delete" } as MenuItemConstructorOptions,
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "selectAll" } as MenuItemConstructorOptions,
          ] satisfies MenuItemConstructorOptions[])),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      {
        label: "Toggle Full Screen",
        accelerator: isMac ? "Ctrl+Cmd+F" : "F11",
        click: () => {
          const win = focusedWin();
          if (!win) return;
          win.setFullScreen(!win.isFullScreen());
        },
      },
      ...(isDev
        ? ([
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "reload" } as MenuItemConstructorOptions,
            { role: "forceReload" } as MenuItemConstructorOptions,
            { role: "toggleDevTools" } as MenuItemConstructorOptions,
          ] satisfies MenuItemConstructorOptions[])
        : ([] as MenuItemConstructorOptions[])),
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac
        ? ([
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "front" } as MenuItemConstructorOptions,
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "window" } as MenuItemConstructorOptions,
          ] satisfies MenuItemConstructorOptions[])
        : ([
            { role: "close" } as MenuItemConstructorOptions,
          ] satisfies MenuItemConstructorOptions[])),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: "help",
    submenu: [
      {
        label: "ZPass on GitHub",
        click: () => {
          void shell.openExternal("https://github.com/zerx-lab/zpass");
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...macAppMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];

  // On Linux & Windows we explicitly null-out the menu so the renderer-only
  // command surface (Topbar + Settings page + ⌘K palette) is the canonical
  // chrome. Native menu bar takes vertical space and duplicates the in-app
  // commands. macOS keeps the menu — Apple HIG requires it.
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ────────────── Window bounds persistence ───────────────────────────────────
//
// Electron does not remember last window position/size by default. We persist
// to `~/.config/zpass/window-bounds.json` (`app.getPath("userData")` is the
// canonical writable location across the three OSes). On read failure or
// schema mismatch we fall back to the design default 1280x820 centered.
//
// We intentionally do NOT use the renderer's `ConfigService` (AGENTS.md hard
// rule says renderer prefs route through that service): window bounds are
// shell state owned by the main process, written before the renderer is even
// ready to receive IPC. Putting them in a sibling JSON keeps the two storage
// strata separate.
type WindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
};

const BOUNDS_FILENAME = "window-bounds.json";

function boundsFilePath() {
  return join(app.getPath("userData"), BOUNDS_FILENAME);
}

async function loadWindowBounds(): Promise<WindowBounds | null> {
  try {
    const raw = await fsReadFile(boundsFilePath(), "utf8");
    const data = JSON.parse(raw) as unknown;
    if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as WindowBounds).width === "number" &&
      typeof (data as WindowBounds).height === "number"
    ) {
      return data as WindowBounds;
    }
  } catch {
    // missing / corrupt — fall back to defaults
  }
  return null;
}

async function saveWindowBounds(win: BrowserWindow) {
  // Save the "normal" (non-maximised/non-fullscreen) bounds so that next
  // launch restores a usable window. If currently maximised we still want
  // to remember the maximised flag so the user keeps that state.
  const maximized = win.isMaximized();
  const fullScreen = win.isFullScreen();
  if (fullScreen) {
    // Don't capture fullscreen bounds — those collapse to the display rect
    // and would force a full-screen launch even after the user exits.
    return;
  }
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  const payload: WindowBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized,
  };
  try {
    await fsMkdir(app.getPath("userData"), { recursive: true });
    await fsWriteFile(boundsFilePath(), JSON.stringify(payload), "utf8");
  } catch (err) {
    process.stderr.write(`[bounds] save failed: ${String(err)}\n`);
  }
}

async function createWindow(hidden = false) {
  // Match the Wails 3 window options the ported frontend was designed for:
  //   - frameless + custom titlebar (rendered by React's <Titlebar/>)
  //   - 1280x820 default, 960x620 min — the dashboard layout assumes this
  //   - solid #0c0c0d background so the first paint is not a white flash
  //   - macOS keeps OS traffic lights but hides the title text (the React
  //     Titlebar reserves 80px on the left for them)
  // Restore persisted bounds so the user finds the window where they left it.
  // Three-platform consistency: Electron centers a 1280x820 frame as fallback
  // when no JSON is present (cold first launch).
  const saved = await loadWindowBounds();
  const winOptions: Electron.BrowserWindowConstructorOptions = {
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    minWidth: 960,
    minHeight: 620,
    center: saved?.x === undefined || saved?.y === undefined,
    // 开机免打扰启动：窗口隐藏创建，直接驻留托盘，由托盘/dock 激活时再显示。
    show: !hidden,
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    backgroundColor: "#0c0c0d",
    icon: resolveIcon(),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (saved?.x !== undefined) winOptions.x = saved.x;
  if (saved?.y !== undefined) winOptions.y = saved.y;
  const win = new BrowserWindow(winOptions);
  // If the persisted state was maximised, re-apply after construction so the
  // saved normal-bounds become the "restore" target.
  if (saved?.maximized) {
    if (hidden) {
      // maximize() 会把隐藏窗口显示出来，推迟到首次真正 show 时再恢复。
      win.once("show", () => {
        if (!win.isDestroyed() && !win.isMaximized()) win.maximize();
      });
    } else {
      win.once("ready-to-show", () => {
        win.maximize();
      });
      // ready-to-show may never fire if show:true short-circuits it; also
      // maximize on first paint via an immediate call as belt + braces.
      setImmediate(() => {
        if (!win.isDestroyed() && !win.isMaximized()) win.maximize();
      });
    }
  }

  // Persist bounds when the user closes or moves the window. We debounce by
  // only saving on 'close' (final) and on 'resize'/'move' (~every change is
  // fine — writes are small and async). Failures are best-effort.
  const persistBounds = () => {
    void saveWindowBounds(win);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
  win.on("maximize", persistBounds);
  win.on("unmaximize", persistBounds);

  // Window focus tracking → notify renderer so titlebar / topbar can render
  // a "blurred" visual (Linear / Things style: text-3 drops to text-4 when
  // the window loses focus). All three platforms emit blur/focus reliably.
  const sendFocusState = (focused: boolean) => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send("desktop:window:focus", focused);
    } catch {
      // webContents may be tearing down — ignore
    }
  };
  win.on("focus", () => sendFocusState(true));
  win.on("blur", () => sendFocusState(false));

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Dev-only: forward renderer console.warn / console.error to the main
  // process stderr so users can see them in the same terminal as the Go
  // sidecar logs without opening DevTools. Filtering to warn+ keeps the
  // signal/noise ratio sane (React HMR fires console.info constantly).
  //
  // Uses the WebContentsConsoleMessageEventParams object (Electron 31+);
  // the old positional-args overload is deprecated.
  if (!app.isPackaged) {
    win.webContents.on("console-message", (ev) => {
      // levels in the new API are strings: 'debug' | 'info' | 'warning' | 'error'
      if (ev.level !== "warning" && ev.level !== "error") return;
      const tag = ev.level === "error" ? "error" : "warn";
      process.stderr.write(
        `[renderer:${tag}] ${ev.message}  (${ev.sourceId}:${ev.lineNumber})\n`,
      );
    });
  }

  // Intercept the window's close request when the user has chosen
  // "minimise to tray" behaviour. We preventDefault + hide so the
  // BrowserWindow stays alive (and the Go sidecar with it); the tray
  // icon's Show menu item brings it back. macOS Cmd+Q sets
  // `quittingForReal` indirectly via app.on('before-quit') so we always
  // honour the system "quit the app" intent.
  //
  // Why we plant a global timestamp BEFORE hide() instead of just
  // sending an IPC message:
  //   `win.hide()` synchronously toggles document.visibilityState to
  //   `hidden`, and Chromium synchronously dispatches the
  //   `visibilitychange` event to the renderer's main thread. An IPC
  //   message sent via `webContents.send` is queued on the IPC pipe and
  //   only delivered on the next renderer task tick — *after* the
  //   synchronous visibilitychange handler has already run. AutoLock
  //   would see visibilitychange first, lock the vault, and the
  //   suppression flag would arrive too late to matter.
  //
  //   `webContents.executeJavaScript` is the only main→renderer channel
  //   that runs to completion before we return, because it bounces
  //   through the renderer's JS context synchronously from V8's POV
  //   (the Promise resolves on the next microtask in the main process,
  //   but the actual JS string has executed in the renderer by then).
  //   We use it to set a `__zpassTrayHideAt` timestamp on the
  //   renderer's `window` object; AutoLock checks this timestamp at the
  //   top of every triggerLock() call.
  //
  //   Notifying via `desktop:hiding-to-tray` IPC is still emitted as a
  //   secondary signal so AutoLock can also extend the suppression
  //   window via its event handler (defense in depth, and so any
  //   future renderer-side hook has a real event to subscribe to).
  win.on("close", async (event) => {
    process.stderr.write(
      `[tray-close] close event fired (quitting=${quittingForReal}, behavior=${closeBehavior})\n`,
    );
    if (quittingForReal) return; // real shutdown — let it close
    if (closeBehavior !== "tray") return; // user wants to quit on close
    event.preventDefault();

    // Plant the suppression marker BEFORE hide() so the synchronous
    // visibilitychange / blur handlers triggered by hide() see it.
    // 800ms covers slow systems while staying short enough that a real
    // app-switch a second later still locks as expected.
    try {
      await win.webContents.executeJavaScript(
        `window.__zpassTrayHideAt = Date.now();`,
        true /* userGesture: helps run even if page is suspended */,
      );
      process.stderr.write(
        "[tray-close] planted __zpassTrayHideAt in renderer\n",
      );
    } catch (err) {
      // If executeJavaScript fails (page nav in progress, devtools
      // attached weirdly) we still proceed with hide — worst case the
      // user gets locked, which is the pre-fix behaviour.
      process.stderr.write(
        `[tray-close] failed to plant suppression marker: ${String(err)}\n`,
      );
    }

    // Secondary IPC notification (best-effort, eventually delivered).
    // Lets renderer-side subscribers extend the suppression window if
    // they want, and serves as a hookable event for future features.
    try {
      win.webContents.send("desktop:hiding-to-tray");
    } catch {
      /* webContents may be destroyed during shutdown races */
    }
    if (win.isFullScreen()) {
      // Leaving fullscreen while hiding avoids the empty desktop space
      // that some compositors (notably macOS Spaces) leave behind.
      win.once("leave-full-screen", () => win.hide());
      win.setFullScreen(false);
    } else {
      win.hide();
    }
  });

  // Note on perceived startup: we deliberately do NOT use the textbook
  // `show: false` + 'ready-to-show' pattern. On Wayland that event can fire
  // many hundreds of ms after loadFile/loadURL resolves (it waits for a
  // compositor-side "showable" signal), which makes the user wait *longer*
  // before seeing the window than the default behaviour does. With the
  // default (`show: true`), Electron maps the window once the renderer has
  // produced its first paint; because `index.html` ships inline CSS and
  // "loading…" placeholders, that first paint already shows the real layout
  // — there is no white-flash to hide. Verified with RELAY_BOOT_TRACE=1.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(
      join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
    // NB: Forge's Vite plugin places renderer output one level above the
    // main process bundle (see `.vite/renderer/<name>/`).
  }
}

/**
 * Forward OS power/session events to the renderer.
 *
 * 系统挂起恢复 / 锁屏解锁后，Go sidecar 与云端的 SSE 长连接大概率已经半开
 * （TCP 看似存活但对端早已超时丢弃）。把事件推给渲染层，由 CloudEventSync
 * 调用 CloudService.PokeRealtime 杀掉旧流立即重连并触发一次补偿同步。
 *
 * Called once after `app.whenReady()` — powerMonitor must not be touched
 * before the ready event. `unlock-screen` only fires on macOS/Windows;
 * registering it on Linux is harmless (it just never fires).
 */
function installPowerMonitor() {
  const notifyResumed = () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send("zpass:system-resumed");
    } catch {
      // webContents may be tearing down — ignore
    }
  };
  powerMonitor.on("resume", notifyResumed);
  powerMonitor.on("unlock-screen", notifyResumed);
}

app.whenReady().then(async () => {
  bootTrace("app-ready");
  // Sidecar + IPC handler were registered at module load (above) so they
  // run in parallel with Electron's own init. Here we only need work that
  // genuinely requires `ready`: creating windows, dev reload watcher,
  // and the system tray (Tray requires the GPU/UI thread to be up).
  installDevReloader();
  installTray();
  installAppMenu();
  installPowerMonitor();

  // Auto-update: attach listeners (Windows/packaged), then a delayed startup
  // check that won't compete with cold-start. Failures stay silent (the
  // updater emits an `error` event but UpdateEventSync shows no global toast).
  initAutoUpdater();
  setTimeout(() => void checkForUpdates(), 8000);

  // 免打扰启动只有在托盘可用时才生效 —— 托盘创建失败（Linux 无 indicator
  // host）时隐藏窗口会让应用彻底不可见，降级为正常显示。
  await createWindow(startHidden && tray !== null);
  bootTrace("window-loaded");

  app.on("activate", () => {
    // macOS dock click. If we have a hidden window (close-to-tray on mac),
    // bring it back; otherwise rebuild.
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    } else {
      showMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // When close-to-tray is active the BrowserWindow 'close' handler stops
  // the window from actually closing, so this event won't fire anyway.
  // It DOES fire when the user explicitly chose Quit (tray menu) on a
  // platform where Quit closes the window first (Linux/Windows). On macOS
  // we keep the historical behavior: window-all-closed alone does NOT quit
  // the app (Cmd+Q does, and our tray Quit forces it).
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Any "real" quit path — tray Quit, Cmd+Q on macOS, OS shutdown, etc.
  // — flips the flag so windows can close instead of being intercepted by
  // the close-to-tray handler.
  quittingForReal = true;
  backend?.stop();
  backend = null;
});
