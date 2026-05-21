// @wailsio/runtime compatibility shim
// =============================================================================
//
// The ported frontend imports its IPC + window-control primitives from
// `@wailsio/runtime`. We do not ship that package: the desktop runs on
// Electron + a Go HTTP sidecar (Huma + a generic /wails/call dispatcher), so
// every export here translates a Wails call into either:
//
//   - an HTTP POST to the Go backend (Call.ByName / Call.ByID)
//   - an SSE subscription to the backend's event bus (Events.On/Off/Once)
//   - an Electron IPC call to the main process (Window.*, System.*)
//
// The shim is the ONLY allowed translation point. New frontend code should
// import typed helpers from `electron/src/api/client.ts` instead — this
// surface exists to keep the ported code (~16 KLOC) compiling unchanged.
//
// Wire details:
//   - The Go handshake (baseUrl + token) is delivered by the main process via
//     `window.desktop.handshake()`. Both the HTTP client and the SSE
//     EventSource depend on it; we cache the promise so any number of
//     callers share a single fetch round-trip.
//   - The auth token rides in `X-Desktop-Token` for HTTP and as a query-string
//     parameter for SSE (the native EventSource API forbids custom headers).
//   - Window controls and platform identification are NOT proxied through
//     Go — they live in the renderer process and we expose them via
//     `window.desktop.*`. The preload bridge defines that surface.

// ---------- shared types ----------
//
// The DesktopBridge surface is declared once in `./window-globals.d.ts`;
// importing nothing from here keeps the global augmentation single-source.

import type {} from "./window-globals";

// ---------- handshake cache ----------

let cachedHandshake: Promise<{
  port: number;
  token: string;
  baseUrl: string;
}> | null = null;

/**
 * Resolve the backend handshake exactly once per process. Subsequent calls
 * return the cached promise; if it ever rejects (e.g. backend died), the next
 * caller re-fetches.
 */
function handshake() {
  if (!cachedHandshake) {
    cachedHandshake = window.desktop.handshake().catch((err) => {
      cachedHandshake = null;
      throw err;
    });
  }
  return cachedHandshake;
}

const AUTH_HEADER = "X-Desktop-Token";

// ---------- Call ----------

/**
 * Translate `Call.ByName("main.Service.Method", ...args)` into
 * `POST /wails/call`. The reflection-based dispatcher in Go decodes args
 * positionally into the method's parameter types.
 *
 * Error contract: a non-nil Go error becomes `{ error: "..." }` in the
 * response body; we surface it as a thrown `Error`. The vault-api
 * `normalizeError` helper expects to see standard Error instances, so we
 * preserve `Error` over custom subclasses.
 */
async function ByName<T = unknown>(
  method: string,
  ...args: unknown[]
): Promise<T> {
  const hs = await handshake();
  const resp = await fetch(`${hs.baseUrl}/wails/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [AUTH_HEADER]: hs.token,
    },
    body: JSON.stringify({ method, args }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`wails call ${method} failed (${resp.status}): ${text}`);
  }
  const body = (await resp.json()) as { result?: T; error?: string };
  if (body.error) {
    throw new Error(body.error);
  }
  return body.result as T;
}

/**
 * `Call.ByID(numeric)` was a Wails 3 optimisation that pre-registered method
 * names → numeric IDs at handshake time. We do not maintain such a registry
 * (it would defeat the goal of "no codegen"), so this is a no-op stub: the
 * generated bindings under `electron/src/renderer/bindings/` always call
 * ByName instead, which is the only path actually exercised at runtime.
 */
function ByID<T = unknown>(_id: number, ..._args: unknown[]): Promise<T> {
  return Promise.reject(
    new Error(
      "Call.ByID is not supported by the wailscompat shim — use Call.ByName",
    ),
  );
}

/** Cancellation handle returned by the original Wails Call API. */
interface CancellableCall<T> extends Promise<T> {
  cancel(): void;
}

/**
 * Wrap a plain Promise in the CancellablePromise surface the old API
 * promised. We do not actually cancel in-flight HTTP requests today; the
 * shape exists so callers that store `.cancel()` for later don't crash.
 */
function withCancel<T>(p: Promise<T>): CancellableCall<T> {
  const cp = p as CancellableCall<T>;
  cp.cancel = () => {
    /* TODO: AbortController once we have a frontend caller that uses it */
  };
  return cp;
}

export const Call = {
  ByName<T = unknown>(method: string, ...args: unknown[]) {
    return withCancel(ByName<T>(method, ...args));
  },
  ByID,
};

// ---------- Events ----------

type EventHandler = (event: any) => void;

/** Shape the legacy frontend expects from event listener callbacks. */
export interface WailsEvent {
  name: string;
  data?: unknown;
  sender?: string;
}

interface Subscription {
  name: string;
  handler: EventHandler;
  once: boolean;
}

/**
 * Server-Sent Events client.
 *
 * One EventSource per renderer process: the backend's hub fans out to every
 * subscriber, and the shim then re-dispatches to the local handlers
 * registered through Events.On/Once/Off. Reconnect is automatic (EventSource
 * does that for us); we re-attach our internal listener after the open
 * lifecycle so duplicate subscribe loops cannot happen.
 */
class EventBus {
  private subs: Subscription[] = [];
  private source: EventSource | null = null;
  private starting: Promise<void> | null = null;
  private attachedNames = new Set<string>();

  subscribe(name: string, handler: EventHandler, once = false): () => void {
    const sub: Subscription = { name, handler, once };
    this.subs.push(sub);
    void this.ensureOpen().then(() => this.attach(name));
    return () => this.removeSub(sub);
  }

  emitLocal(name: string, data: unknown) {
    const ev: WailsEvent = { name, data, sender: "wailscompat" };
    // Snapshot to allow `once` handlers to remove themselves mid-iteration.
    for (const sub of [...this.subs]) {
      if (sub.name !== name) continue;
      try {
        sub.handler(ev);
      } catch (err) {
        console.error(`[wailscompat] event handler for ${name} threw:`, err);
      }
      if (sub.once) this.removeSub(sub);
    }
  }

  private removeSub(sub: Subscription) {
    const i = this.subs.indexOf(sub);
    if (i >= 0) this.subs.splice(i, 1);
  }

  private async ensureOpen() {
    if (this.source) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const hs = await handshake();
      // EventSource forbids custom headers, so the token rides on the
      // query string. The loopback-only bind + per-launch random token
      // keep this from being meaningfully exfiltratable.
      const url = `${hs.baseUrl}/wails/events?token=${encodeURIComponent(hs.token)}`;
      const es = new EventSource(url);
      es.addEventListener("error", (err) => {
        // EventSource auto-reconnects; we only log so silent broken
        // pipes are visible during dev.
        console.warn("[wailscompat] event stream error", err);
      });
      es.addEventListener("ready", () => {
        /* connection accepted by server */
      });
      this.source = es;
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private attach(name: string) {
    if (this.attachedNames.has(name) || !this.source) return;
    this.attachedNames.add(name);
    this.source.addEventListener(name, (ev) => {
      let data: unknown = undefined;
      try {
        data = (ev as MessageEvent).data
          ? JSON.parse((ev as MessageEvent).data as string)
          : undefined;
      } catch (err) {
        console.error(`[wailscompat] bad SSE payload for ${name}:`, err);
      }
      this.emitLocal(name, data);
    });
  }
}

// The Go backend ignores the X-Desktop-Token rule for /wails/events when it
// is delivered via query string; we encode it server-side too.
//
// Because authMux currently checks the *header*, EventSource — which cannot
// set headers — fails. The backend therefore also accepts the token as
// `?token=`. (Implementation note for whoever modifies the Go side: see
// server.authMux.)
const bus = new EventBus();

export const Events = {
  On(name: string, handler: EventHandler) {
    return bus.subscribe(name, handler, false);
  },
  Once(name: string, handler: EventHandler) {
    return bus.subscribe(name, handler, true);
  },
  Off(name: string, _handler?: EventHandler) {
    // The original Wails API returns an "unlistener" from On — modern
    // callers in the ported frontend use the returned function and
    // rarely call Off explicitly. We accept the call as a no-op so
    // legacy code paths that try both don't crash.
    void name;
  },
  Emit(event: WailsEvent | string, data?: unknown) {
    const name = typeof event === "string" ? event : event.name;
    const payload = typeof event === "string" ? data : event.data;
    // Local-only dispatch; the backend hub does not accept emits from
    // the renderer side. Useful for app-internal pub/sub.
    bus.emitLocal(name, payload);
  },
};

// ---------- Window ----------
//
// Window controls live entirely in the Electron main process; the Go backend
// has no opinion. We proxy via the preload bridge installed on window.desktop.
// Method names mirror the Wails 3 surface (Minimise / Maximise / etc.).

export const Window = {
  Minimise() {
    return window.desktop.window.minimise();
  },
  Maximise() {
    return window.desktop.window.maximise();
  },
  UnMaximise() {
    return window.desktop.window.unmaximise();
  },
  ToggleMaximise() {
    return window.desktop.window.toggleMaximise();
  },
  IsMaximised() {
    return window.desktop.window.isMaximised();
  },
  IsFullscreen() {
    return window.desktop.window.isFullscreen();
  },
  UnFullscreen() {
    return window.desktop.window.unfullscreen();
  },
  Close() {
    return window.desktop.window.close();
  },
};

// ---------- System ----------
//
// The renderer's `lib/platform.ts` reads `_wails.environment.OS` directly
// from `window` in addition to importing `System.*`. We replicate both
// surfaces here: provide synchronous helpers that read from the platform
// object exposed by preload, AND seed `window._wails` so the legacy
// `isWailsRuntime()` helper returns true.

(function installLegacyWailsGlobal() {
  if (typeof window === "undefined") return;
  const existing = window._wails;
  if (existing) return;
  const p = window.desktop?.platform();
  if (!p) return;
  window._wails = {
    environment: { OS: p.os, Arch: p.arch },
    clientId: "wailscompat",
  };
})();

export const System = {
  IsMac() {
    return window.desktop.platform().isMac;
  },
  IsWindows() {
    return window.desktop.platform().isWindows;
  },
  IsLinux() {
    return window.desktop.platform().isLinux;
  },
  OSInfo() {
    const p = window.desktop.platform();
    return { OS: p.os, Arch: p.arch };
  },
};

// ---------- default export ----------
//
// The original `@wailsio/runtime` ships as a namespace ESM. Re-export the
// individual sections as both named exports (above) and a default object so
// `import wails from "@wailsio/runtime"` continues to work.

export default { Call, Events, Window, System };
