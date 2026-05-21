import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { startBackend, type Backend } from "./backend";

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
  // Let Electron pick Wayland natively when the session is Wayland, instead
  // of going through XWayland. Matters for HiDPI scaling and IME latency.
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  // Set the Wayland xdg_toplevel.app_id (and X11 WM_CLASS) so the
  // compositor can match the window to /usr/share/applications/zpass.desktop
  // and use the hicolor `zpass` icon. Without this, Chromium leaves app_id
  // unset on Wayland and the taskbar falls back to a generic "Wayland"
  // placeholder icon. `app.setName()` does NOT affect this — only the
  // Chromium `--class` switch is read by the Ozone Wayland backend.
  // The value must match the .desktop file's basename (`zpass.desktop`)
  // and its `StartupWMClass=zpass` field.
  app.commandLine.appendSwitch("class", "zpass");
}

let backend: Backend | null = null;
// Tracks the in-flight or resolved backend so the handshake IPC can await it
// without blocking window creation. Replaced atomically on hot restart.
let backendPromise: Promise<Backend> | null = null;
let reloading = false;

const RELOAD_FILE = join(app.getAppPath(), ".dev-reload");

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
  focusedWin()?.close();
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

// Resolve the window icon. In dev the working dir is the repo root, in a
// packaged app the PNGs live next to the asar under `resources/assets/`.
// We bundle a 256×256 ZPass dotted-Z mark; the OS picks the best size at
// render time, but Electron only loads one image so 256px is the sweet
// spot (large enough for HiDPI titlebars, small enough to avoid bloat).
function resolveIcon() {
  const candidates = [
    join(__dirname, "../../assets/logo/png/zpass-256.png"),
    join(process.resourcesPath ?? "", "assets/logo/png/zpass-256.png"),
    join(process.cwd(), "assets/logo/png/zpass-256.png"),
  ];
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  return undefined;
}

async function createWindow() {
  // Match the Wails 3 window options the ported frontend was designed for:
  //   - frameless + custom titlebar (rendered by React's <Titlebar/>)
  //   - 1280x820 default, 960x620 min — the dashboard layout assumes this
  //   - solid #0c0c0d background so the first paint is not a white flash
  //   - macOS keeps OS traffic lights but hides the title text (the React
  //     Titlebar reserves 80px on the left for them)
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    center: true,
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

app.whenReady().then(async () => {
  bootTrace("app-ready");
  // Sidecar + IPC handler were registered at module load (above) so they
  // run in parallel with Electron's own init. Here we only need work that
  // genuinely requires `ready`: creating windows, dev reload watcher.
  installDevReloader();

  await createWindow();
  bootTrace("window-loaded");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  backend?.stop();
  backend = null;
});
