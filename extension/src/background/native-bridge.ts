import {
  NATIVE_HOST_NAME,
  type GenerateLoginTotpRequest,
  type LaunchDesktopResult,
  type LoginSecret,
  type LoginTotpCode,
  type NativeRequest,
  type NativeResponse,
  type PageContext,
  type PasskeyAssertion,
  type PasskeyCreateRequest,
  type PasskeyCredential,
  type PasskeyDeleteRequest,
  type PasskeyDeleteResult,
  type PasskeyListRequest,
  type PasskeyListResult,
  type PasskeySignRequest,
  type PingResult,
  type QueryLoginsResult,
  type RevealLoginRequest,
  type VaultStatus,
} from "../shared/messages";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
};

const REQUEST_TIMEOUT_MS = 8000;

export class NativeBridge {
  private port: Browser.runtime.Port | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  // ping 探测 GUI 是否在线，不会触发 spawn。用于 popup 首屏 liveness 判断。
  // 超时取较短值，避免用户在「desktop 未启」状态下看到长时间 spinner。
  async ping(): Promise<PingResult> {
    return this.send("ping", undefined, 2000);
  }

  // launchDesktop 显式拉起 GUI（用户点「启动 Desktop」按钮触发）。
  async launchDesktop(): Promise<LaunchDesktopResult> {
    return this.send("launchDesktop");
  }

  async status(): Promise<VaultStatus> {
    return this.send("status");
  }

  async queryLogins(payload: PageContext): Promise<QueryLoginsResult> {
    return this.send("queryLogins", payload);
  }

  async revealLogin(payload: RevealLoginRequest): Promise<LoginSecret> {
    return this.send("revealLogin", payload);
  }

  async passkeyList(payload: PasskeyListRequest): Promise<PasskeyListResult> {
    return this.send("passkeyList", payload);
  }

  async passkeyCreate(
    payload: PasskeyCreateRequest,
  ): Promise<PasskeyCredential> {
    return this.send("passkeyCreate", payload);
  }

  async passkeySign(payload: PasskeySignRequest): Promise<PasskeyAssertion> {
    return this.send("passkeySign", payload);
  }

  async passkeyDelete(
    payload: PasskeyDeleteRequest,
  ): Promise<PasskeyDeleteResult> {
    return this.send("passkeyDelete", payload);
  }

  async generateLoginTotp(
    payload: GenerateLoginTotpRequest,
  ): Promise<LoginTotpCode> {
    return this.send("generateLoginTotp", payload);
  }

  private send<TResult, TPayload = unknown>(
    type: NativeRequest<TPayload>["type"],
    payload?: TPayload,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<TResult> {
    const port = this.ensurePort();
    const id = `${Date.now().toString(36)}-${++this.seq}`;
    const message: NativeRequest<TPayload> = { id, type };
    if (payload !== undefined) {
      message.payload = payload;
    }

    return new Promise<TResult>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ZPass Desktop did not respond."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });
      port.postMessage(message);
    });
  }

  private ensurePort(): Browser.runtime.Port {
    if (this.port) return this.port;
    const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    port.onMessage.addListener((raw: unknown) => this.handleMessage(raw));
    port.onDisconnect.addListener(() => {
      this.port = null;
      const error = new Error(
        browser.runtime.lastError?.message ?? "ZPass Desktop disconnected.",
      );
      for (const [id, pending] of this.pending) {
        globalThis.clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    });
    this.port = port;
    return port;
  }

  private handleMessage(raw: unknown): void {
    const response = raw as NativeResponse;
    if (!response || typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    globalThis.clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new Error(response.error || "ZPass Desktop request failed."),
      );
    }
  }
}
