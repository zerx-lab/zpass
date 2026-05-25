// Shared ambient declarations for the renderer.
//
// The preload script exposes `window.desktop` via contextBridge; both the
// compat shim (wails-runtime.ts) and feature code (renderer.ts, library
// modules) consume the same surface. Declaring it once here avoids the
// "subsequent property declarations must have the same type" TS error that
// fires when multiple files independently augment the Window interface.
//
// `DesktopBridgeShape` mirrors preload/preload.ts; if you add a method
// there, mirror it here. The two cannot share a literal type import because
// the preload file is built into a separate CJS bundle and the renderer
// build never imports its source.

export interface DesktopHandshake {
	port: number;
	token: string;
	baseUrl: string;
}

export interface DesktopPlatform {
	os: "darwin" | "linux" | "win32";
	isMac: boolean;
	isWindows: boolean;
	isLinux: boolean;
	arch: string;
}

export interface DesktopBridgeShape {
	handshake(): Promise<DesktopHandshake>;
	platform(): DesktopPlatform;
	window: {
		minimise(): Promise<void>;
		maximise(): Promise<void>;
		unmaximise(): Promise<void>;
		toggleMaximise(): Promise<void>;
		isMaximised(): Promise<boolean>;
		isFullscreen(): Promise<boolean>;
		unfullscreen(): Promise<void>;
		close(): Promise<void>;
		setCloseBehavior(mode: "quit" | "tray"): Promise<void>;
		/**
		 * Subscribe to "about-to-hide-to-tray" notifications from the main
		 * process. Returns an unsubscribe function.
		 *
		 * Consumed by AutoLock so the user's intentional minimise-to-tray
		 * does not trigger lockOnSwitch / lockOnSleep.
		 */
		onHidingToTray(handler: () => void): () => void;
	};
	dialog: {
		saveFile(opts: {
			defaultPath?: string;
			filters?: { name: string; extensions: string[] }[];
		}): Promise<string | null>;
	};
	shell: {
		showInFolder(path: string): Promise<void>;
	};
}

declare global {
	interface Window {
		desktop: DesktopBridgeShape;
		// Wails 3 used to inject this object; the compat shim seeds a
		// stand-in so legacy code paths that probe `window._wails` keep
		// working. The shape is intentionally minimal — only what
		// `lib/platform.ts` reads.
		_wails?: {
			environment: { OS: string; Arch: string };
			clientId: string;
		};
	}
}

export {};
