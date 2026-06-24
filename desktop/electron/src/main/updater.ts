// Auto-update — electron-updater (GitHub provider) + cross-platform fallback.
// =============================================================================
//
// Windows (NSIS): full silent auto-update via electron-updater. Background
// download (autoDownload) + install on next quit (autoInstallOnAppQuit), with a
// renderer-driven "restart & install" prompt. The repo uses per-component
// releases (tag = desktop-vX.Y.Z), and this electron-updater version's GitHub
// provider has no tagPrefix support, so before each check we resolve the newest
// desktop-v* release via the GitHub API and point the updater at that release's
// download dir with a `generic` feed (setFeedURL). `latest.yml` + the installer
// are produced by electron-builder and uploaded under that release's tag.
//
// macOS / Linux: electron-updater cannot install here (macOS is only ad-hoc
// signed so Squirrel.Mac can't validate; the Linux AppImage is built by Forge,
// not electron-builder, so there's no latest-linux.yml). Instead we resolve the
// newest desktop release the same way and surface a notice that opens the
// release page in the browser.
//
// Every state transition is forwarded to the renderer over a single IPC channel
// (`zpass:update:event`) as a discriminated union, mirroring main.ts's
// powerMonitor `webContents.send` pattern.

import { app, BrowserWindow, shell } from "electron";
import { autoUpdater } from "electron-updater";

const OWNER = "zerx-lab";
const REPO = "zpass";
const RELEASES_LATEST_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

export type UpdateEvent =
  | { kind: "checking" }
  | {
      kind: "available";
      version: string;
      mode: "auto" | "manual-open";
      downloadUrl?: string;
    }
  | { kind: "none" }
  | { kind: "progress"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

function send(ev: UpdateEvent): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("zpass:update:event", ev);
  } catch {
    // webContents may be tearing down — ignore
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Compare two `X.Y.Z` versions; true iff `remote` is strictly newer than
 * `local`. Releases are always plain semver (see the CI tag regex), so a
 * numeric triple compare is sufficient; prerelease suffixes are not ranked.
 */
function isNewer(local: string, remote: string): boolean {
  const a = local.split(/[.+-]/).map(Number);
  const b = remote.split(/[.+-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

/**
 * Resolve the newest desktop release from the GitHub API.
 *
 * 仓库是「每端独立 release」模式: release tag = <component>-vX.Y.Z。GitHub 的
 * /releases/latest 返回的是"最新发布的任一端 release"(可能是 phone/extension),
 * 且 electron-updater 26.x 的内置 GitHub provider 不支持 tagPrefix 过滤,会认错
 * 版本。所以我们自己列全部 release, 只挑 tag 形如 desktop-vX.Y.Z 的, 取版本最大者。
 *
 * 返回该 release 的版本、download 目录(供 Windows 的 generic provider feed)、
 * 与 html_url(供 mac/Linux 跳转)。无匹配 release 时返回 null。
 */
async function resolveDesktopRelease(): Promise<{
  version: string;
  tag: string;
  downloadDir: string;
  htmlUrl: string;
} | null> {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`,
    {
      // GitHub rejects requests without a User-Agent (HTTP 403).
      headers: {
        "User-Agent": "ZPass-Desktop",
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const releases = (await res.json()) as Array<{
    tag_name?: string;
    html_url?: string;
    draft?: boolean;
    prerelease?: boolean;
  }>;

  let best: { version: string; tag: string; htmlUrl: string } | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const tag = r.tag_name ?? "";
    const m = /^desktop-v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(tag);
    if (!m) continue;
    const version = m[1];
    if (!best || isNewer(best.version, version)) {
      best = {
        version,
        tag,
        htmlUrl: r.html_url ?? RELEASES_LATEST_PAGE,
      };
    }
  }
  if (!best) return null;
  return {
    version: best.version,
    tag: best.tag,
    downloadDir: `https://github.com/${OWNER}/${REPO}/releases/download/${best.tag}/`,
    htmlUrl: best.htmlUrl,
  };
}

let wired = false;

/**
 * Attach electron-updater listeners. No-op unless packaged on Windows
 * (dev has no installer; electron-updater install is Windows-only here).
 * Idempotent.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged || process.platform !== "win32") return;
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // electron-builder.win.yml 用 differentialPackage:false, 不产 .blockmap;
  // 若不关闭差分下载, electron-updater 仍会去拉 .blockmap → 404 → 报错后才
  // 回退全量。显式关掉, 直接走全量下载, 干净无噪声。
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on("checking-for-update", () => send({ kind: "checking" }));
  autoUpdater.on("update-available", (info) =>
    send({ kind: "available", version: info.version, mode: "auto" }),
  );
  autoUpdater.on("update-not-available", () => send({ kind: "none" }));
  autoUpdater.on("download-progress", (p) =>
    send({ kind: "progress", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    send({ kind: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (e) => send({ kind: "error", message: msg(e) }));
}

/**
 * Trigger an update check.
 *
 * Windows (packaged): resolve the newest `desktop-v*` release ourselves, point
 * electron-updater at that release's download dir via a `generic` feed, then
 * check — autoDownload starts the NSIS download on `update-available`. We can't
 * use the built-in GitHub provider: this electron-builder/-updater version has
 * no tagPrefix support and would pick GitHub's cross-component "latest" release.
 *
 * macOS / Linux (dev + packaged): same release resolution, but report a
 * "go download" notice (no in-app install here).
 */
export async function checkForUpdates(): Promise<void> {
  if (process.platform === "win32") {
    if (!app.isPackaged) {
      send({ kind: "none" });
      return;
    }
    send({ kind: "checking" });
    try {
      const rel = await resolveDesktopRelease();
      if (!rel || !isNewer(app.getVersion(), rel.version)) {
        send({ kind: "none" });
        return;
      }
      // Point the updater at this specific desktop release's download dir; the
      // generic provider fetches `<dir>/latest.yml` and the installer beside it.
      // setFeedURL → checkForUpdates re-emits checking/available/progress/...
      // through the listeners wired in initAutoUpdater.
      autoUpdater.setFeedURL({ provider: "generic", url: rel.downloadDir });
      await autoUpdater.checkForUpdates();
    } catch (e) {
      send({ kind: "error", message: msg(e) });
    }
    return;
  }

  // macOS / Linux (dev + packaged): notify + open download page.
  send({ kind: "checking" });
  try {
    const rel = await resolveDesktopRelease();
    if (rel && isNewer(app.getVersion(), rel.version)) {
      send({
        kind: "available",
        version: rel.version,
        mode: "manual-open",
        downloadUrl: rel.htmlUrl,
      });
    } else {
      send({ kind: "none" });
    }
  } catch (e) {
    send({ kind: "error", message: msg(e) });
  }
}

/** Quit and run the downloaded installer (Windows only). */
export function quitAndInstall(): void {
  if (process.platform === "win32") autoUpdater.quitAndInstall();
}

/** Open a release/download page in the user's browser. */
export function openReleasePage(url: string): void {
  void shell.openExternal(url);
}
