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
    /**
     * Toggle fullscreen on the focused window. Bound to F11 (Win/Linux) and
     * ⌃⌘F (macOS) by the renderer's Shortcuts component; the native menu
     * triggers the same IPC. We funnel both paths here so the keymap stays
     * single-source-of-truth.
     */
    toggleFullscreen: () =>
      ipcRenderer.invoke("desktop:window:toggle-fullscreen") as Promise<void>,
    /**
     * Windows-only: pop the native window system menu (Restore / Move /
     * Minimize / Maximize / Close) at the given client-area point. On
     * macOS/Linux this is a no-op — see main.ts comment for rationale.
     * The renderer's Titlebar wires this to onContextMenu over the
     * drag region so right-clicking the titlebar matches Windows 11 native
     * windows.
     */
    showSystemMenu: (x: number, y: number) =>
      ipcRenderer.invoke("desktop:window:show-system-menu", {
        x,
        y,
      }) as Promise<void>,
    /**
     * Notify the main process whether closing the window should quit the
     * app or hide it into the system tray. Called from ThemeSync whenever
     * the user-facing preference (`prefs.closeBehavior`) changes.
     */
    setCloseBehavior: (mode: "quit" | "tray") =>
      ipcRenderer.invoke(
        "desktop:window:set-close-behavior",
        mode,
      ) as Promise<void>,
    /**
     * Subscribe to window focus/blur events emitted by the BrowserWindow.
     * Renderer uses this to drive `<html data-window-blurred>` so the
     * titlebar / topbar can render a subtly-dimmed "inactive window" look
     * matching macOS / Windows / GNOME native behavior. Returns an
     * unsubscribe function.
     */
    onFocusChange: (handler: (focused: boolean) => void) => {
      const wrapped = (_ev: Electron.IpcRendererEvent, focused: boolean) => {
        handler(focused);
      };
      ipcRenderer.on("desktop:window:focus", wrapped);
      return () => {
        ipcRenderer.removeListener("desktop:window:focus", wrapped);
      };
    },
    /**
     * Subscribe to native menu commands (macOS App Menu items). Renderer
     * binds Settings / Lock so the menu and the in-app buttons share the
     * same handlers. Returns an unsubscribe function.
     */
    onMenuCommand: (
      command: "lock" | "open-settings",
      handler: () => void,
    ) => {
      const channel = `desktop:menu:${command}`;
      const wrapped = () => handler();
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },
    /**
     * Subscribe to "about-to-hide-to-tray" notifications.
     *
     * Fired by the main process immediately BEFORE `win.hide()` runs in
     * tray-close mode. Hiding the window unavoidably triggers
     * `window blur` and `visibilitychange -> hidden`, which AutoLock
     * normally treats as "user switched apps / display slept" and uses
     * to lock the vault. Renderer code (AutoLock) listens for this
     * event and opens a brief suppression window so the user's
     * intentional minimise-to-tray doesn't immediately lock them out.
     *
     * Returns an unsubscribe function. Safe to call repeatedly; each
     * call registers an independent listener.
     */
    onHidingToTray: (handler: () => void) => {
      const wrapped = () => handler();
      ipcRenderer.on("desktop:hiding-to-tray", wrapped);
      return () => {
        ipcRenderer.removeListener("desktop:hiding-to-tray", wrapped);
      };
    },
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

  shell: {
    /**
     * Reveal a file in the OS file manager and select it. Used by the
     * export-success toast's "open folder" action.
     */
    showInFolder: (path: string) =>
      ipcRenderer.invoke(
        "desktop:shell:show-in-folder",
        path,
      ) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld("desktop", api);

// Re-exported as a type for the renderer to import.
export type DesktopBridge = typeof api;
