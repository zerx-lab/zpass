import { contextBridge, ipcRenderer } from "electron";

// Renderer-facing bridge for the ported ZPass app.
// =============================================================================
//
// The legacy Wails frontend used three orthogonal APIs that we replicate here:
//
//   1. Backend handshake (port + token) — was Wails' implicit injection;
//      now an explicit IPC the renderer awaits before issuing HTTP calls.
//   2. Window controls (Minimise / Maximise / Close) — were calls into the
//      Wails runtime; now Electron IPC into BrowserWindow.
//   3. Platform identification (System.IsMac / IsLinux / IsWindows) — was
//      synchronous on `window._wails.environment.OS`; we keep it synchronous
//      by inlining the process.platform value into the preload module so
//      the renderer never awaits to check the OS.
//
// Save-file dialogs are also routed through here (Wails used to own those;
// Electron owns them now). The renderer calls `desktop.dialog.saveFile(opts)`
// and gets back the picked absolute path or null on cancel.
//
// Every entry here is a security boundary — extra surface area means extra
// privileges to a compromised renderer. Keep this file small and explicit.

const platform = {
  os: process.platform as "darwin" | "linux" | "win32",
  isMac: process.platform === "darwin",
  isWindows: process.platform === "win32",
  isLinux: process.platform === "linux",
  arch: process.arch,
};

const api = {
  /** Fetch the backend handshake (baseUrl + auth token) from the main process. */
  handshake: () =>
    ipcRenderer.invoke("desktop:handshake") as Promise<{
      port: number;
      token: string;
      baseUrl: string;
    }>,

  /**
   * Synchronous platform info. Implemented in preload (process.platform is
   * available here) so the renderer's `lib/platform.ts` does not have to
   * await for FOUC-sensitive code like the Titlebar component.
   */
  platform: () => platform,

  /** Window controls — proxied to the focused BrowserWindow's WebContents. */
  window: {
    minimise: () =>
      ipcRenderer.invoke("desktop:window:minimise") as Promise<void>,
    maximise: () =>
      ipcRenderer.invoke("desktop:window:maximise") as Promise<void>,
    unmaximise: () =>
      ipcRenderer.invoke("desktop:window:unmaximise") as Promise<void>,
    toggleMaximise: () =>
      ipcRenderer.invoke("desktop:window:toggle-maximise") as Promise<void>,
    isMaximised: () =>
      ipcRenderer.invoke("desktop:window:is-maximised") as Promise<boolean>,
    isFullscreen: () =>
      ipcRenderer.invoke("desktop:window:is-fullscreen") as Promise<boolean>,
    unfullscreen: () =>
      ipcRenderer.invoke("desktop:window:unfullscreen") as Promise<void>,
    close: () => ipcRenderer.invoke("desktop:window:close") as Promise<void>,
  },

  dialog: {
    /**
     * Show a native save-file dialog and resolve with the selected
     * absolute path. null means the user cancelled.
     */
    saveFile: (opts: {
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
    }) =>
      ipcRenderer.invoke("desktop:dialog:save-file", opts) as Promise<
        string | null
      >,
  },
};

contextBridge.exposeInMainWorld("desktop", api);

// Re-exported as a type for the renderer to import.
export type DesktopBridge = typeof api;
