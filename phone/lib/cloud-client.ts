// ZPass Phone —— 云同步 HTTP 线缆客户端
//
// 从 harmony/entry/src/main/ets/lib/CloudClient.ets 移植，行为/字节逐一对应；后者又与
// desktop internal/cloud/client.go 一一对应：所有端点、请求/响应 JSON 形状、Bearer 鉴权、
// 以及「CAS 冲突走 HTTP 200（body.status='conflict'）而非错误」契约。
//
// 与 harmony 的差异：HTTP 改用全局 fetch（+ AbortController 30s 超时）替代 @kit.NetworkKit
// 的 http；SSE 改用 XMLHttpRequest 增量读 responseText 替代 requestInStream 的 dataReceive。
// 本层不持有任何密钥 —— 只搬运 base64 字符串与标量（与 client.go「holds NO crypto」一致）。
//
// base64：服务端全程 Go base64.StdEncoding（标准字母表 + '=' 补位）。
// 路径：全部挂在 /v1 下；baseURL 形如 http(s)://host:port（不含尾斜杠、不含 /v1）。

/** HTTP 方法字面量 —— 替代 harmony 的 http.RequestMethod。 */
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/* ----------------------------------------------------------------------------
 * 错误
 * -------------------------------------------------------------------------- */

/** 云端 API 错误。status=0 表示网络/传输层失败。 */
export class APIError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }

  /** 401 —— 会话失效/被吊销/token 过期，终态：须重新登录。 */
  isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** 403 vault_frozen —— vault 因套餐降级冻结（读放行、写被拒）。 */
  isVaultFrozen(): boolean {
    return this.status === 403 && this.message === "vault_frozen";
  }

  /** 403 plan_limit_exceeded —— 触达套餐额度上限（如云保险库数量 max_vaults）。 */
  isPlanLimit(): boolean {
    return this.status === 403 && this.message === "plan_limit_exceeded";
  }

  /** 404 —— vault/keyset 不存在或非成员。 */
  isNotFound(): boolean {
    return this.status === 404;
  }

  /** 410 —— snapshot cursor 低于保留水位，须清缓存全量重同步。 */
  isGone(): boolean {
    return this.status === 410;
  }

  /** 409 —— 冲突（如重复邮箱 / 删除最后一个 vault）。 */
  isConflict(): boolean {
    return this.status === 409;
  }

  isNetwork(): boolean {
    return this.status === 0;
  }
}

/* ----------------------------------------------------------------------------
 * 线缆类型 —— 字段名即 JSON key（直接 stringify/parse），与 client.go json tag 对齐
 * -------------------------------------------------------------------------- */

export interface KdfParams {
  alg: string;
  m: number;
  t: number;
  p: number;
  salt_enc: string;
  sk_version: string;
}

export interface RegisterRequest {
  email: string;
  srp_salt: string;
  srp_verifier: string;
  kdf_params: KdfParams;
}

export interface RegisterResponse {
  user_id: string;
  tenant_id: string;
  session_token: string;
}

export interface LoginStartRequest {
  email: string;
  A: string;
}

export interface LoginStartResponse {
  srp_salt: string;
  B: string;
  kdf_params: KdfParams;
  login_id: string;
}

export interface LoginFinishRequest {
  login_id: string;
  M1: string;
}

export interface LoginFinishResponse {
  M2: string;
  session_token?: string;
  mfa_required?: boolean;
  mfa_token?: string;
}

export interface LoginMfaRequest {
  mfa_token: string;
  code: string;
}

export interface LoginMfaResponse {
  session_token: string;
}

export interface KeysetRequest {
  public_key: string;
  encrypted_private_key: string;
  algo: string;
}

export interface KeysetResponse {
  public_key: string;
  encrypted_private_key: string;
  algo: string;
}

export interface CreateVaultRequest {
  wrapped_vault_key: string;
  encrypted_meta?: string;
}

export interface CreateVaultResponse {
  vault_id: string;
}

export interface MemberSelfResponse {
  wrapped_vault_key: string;
}

export interface VaultSummary {
  vault_id: string;
  created_at: string;
  current_seq: number;
  item_count: number;
  role: string;
  encrypted_meta?: string;
  frozen: boolean;
}

export interface ListVaultsResponse {
  vaults: VaultSummary[];
}

/** 一条 vault 删除墓碑（GET /v1/vaults/deleted 返回元素；零知识：只含 id + seq + 时间）。 */
export interface DeletedVault {
  vault_id: string;
  seq: number;
  deleted_at: string;
}

/** vault 删除墓碑增量页。next_cursor 为本页末尾 seq（空页保持 since 不回退）。 */
export interface DeletedVaultsResponse {
  deleted: DeletedVault[];
  next_cursor: number;
  has_more: boolean;
}

export interface UpdateVaultMetaRequest {
  encrypted_meta: string;
}

export interface EntitlementDimension {
  dimension: string;
  limit: number | null;
  current: number;
}

export interface Entitlements {
  plan: string;
  dimensions: EntitlementDimension[];
  frozen_vault_ids: string[];
}

export interface SnapshotItem {
  item_id: string;
  seq: number;
  /** base64 密文；删除墓碑为 ''。 */
  ciphertext: string;
  content_hash?: string;
  updated_at: number;
  revision: number;
  deleted: boolean;
}

export interface SnapshotResponse {
  items: SnapshotItem[];
  has_more: boolean;
  next_cursor: number;
  current_seq: number;
}

export interface ChangeRequest {
  item_id: string;
  base_seq: number;
  deleted: boolean;
  ciphertext?: string;
  content_hash?: string;
  updated_at: number;
  revision: number;
  client_mutation_id: string;
}

export interface ServerItem {
  seq: number;
  ciphertext: string;
  content_hash: string;
  deleted: boolean;
  updated_at: number;
  revision: number;
}

export interface ChangeResponse {
  /** 'ok' | 'conflict'。冲突也是 HTTP 200。 */
  status: string;
  assigned_seq: number;
  expected_base_seq: number;
  server?: ServerItem;
}

/* ----------------------------------------------------------------------------
 * 错误体解析 —— 2xx 外的响应体：JSON {error} 或纯文本（401 等）
 * -------------------------------------------------------------------------- */

function parseErrorMessage(text: string, code: number): string {
  if (text) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const e = obj.error;
      if (typeof e === "string" && e.length > 0) return e;
    } catch {
      // 非 JSON（如 401 文本体）—— 原样返回
    }
    return text;
  }
  return `status ${code}`;
}

/* ----------------------------------------------------------------------------
 * 客户端
 * -------------------------------------------------------------------------- */

/** 单次请求超时（与 harmony readTimeout 30s 对齐）。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** SSE 静默看门狗：75s 无字节即判定流失活并重连（> 服务端 20s keepalive 间隔）。 */
const EVENTS_STALE_MS = 75_000;

/** 长连接事件流句柄；close() 显式关闭且不触发 onClosed/重连。 */
export interface EventStreamHandle {
  close(): void;
}

export class CloudClient {
  private baseURL = "";
  private token = "";

  constructor(baseURL: string) {
    this.setBaseURL(baseURL);
  }

  /** 设置 baseURL（去尾斜杠）。 */
  setBaseURL(baseURL: string): void {
    let b = (baseURL ?? "").trim();
    while (b.endsWith("/")) b = b.slice(0, b.length - 1);
    this.baseURL = b;
  }

  getBaseURL(): string {
    return this.baseURL;
  }

  setToken(token: string): void {
    this.token = token ?? "";
  }

  clearToken(): void {
    this.token = "";
  }

  hasToken(): boolean {
    return this.token.length > 0;
  }

  /* -------------------------------- 传输 ---------------------------------- */

  private async send<O>(
    method: HttpMethod,
    path: string,
    body: object | null,
    authed: boolean,
  ): Promise<O> {
    const text = await this.sendRaw(method, path, body, authed);
    return JSON.parse(text) as O;
  }

  private async sendVoid(
    method: HttpMethod,
    path: string,
    body: object | null,
    authed: boolean,
  ): Promise<void> {
    await this.sendRaw(method, path, body, authed);
  }

  private async sendRaw(
    method: HttpMethod,
    path: string,
    body: object | null,
    authed: boolean,
  ): Promise<string> {
    if (!this.baseURL) {
      throw new APIError(0, "云服务地址未配置");
    }
    const headers: Record<string, string> = {};
    headers["accept"] = "application/json";
    if (body !== null) headers["content-type"] = "application/json";
    if (authed) {
      if (!this.token) throw new APIError(401, "缺少云会话凭证");
      headers["authorization"] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout((): void => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.baseURL + path, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new APIError(res.status, parseErrorMessage(text, res.status));
      }
      return text;
    } catch (e) {
      if (e instanceof APIError) throw e;
      throw new APIError(0, e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  /* -------------------------------- 鉴权 ---------------------------------- */

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    return this.send<RegisterResponse>("POST", "/v1/auth/register", req, false);
  }

  async loginStart(req: LoginStartRequest): Promise<LoginStartResponse> {
    return this.send<LoginStartResponse>("POST", "/v1/auth/login/start", req, false);
  }

  async loginFinish(req: LoginFinishRequest): Promise<LoginFinishResponse> {
    return this.send<LoginFinishResponse>("POST", "/v1/auth/login/finish", req, false);
  }

  /** 完成 MFA（TOTP）二次验证 → session_token。公开端点，无需 Bearer。 */
  async loginMfa(req: LoginMfaRequest): Promise<LoginMfaResponse> {
    return this.send<LoginMfaResponse>("POST", "/v1/auth/login/mfa", req, false);
  }

  /* -------------------------------- keyset -------------------------------- */

  async putKeyset(req: KeysetRequest): Promise<void> {
    await this.sendVoid("POST", "/v1/keyset", req, true);
  }

  async getKeyset(): Promise<KeysetResponse> {
    return this.send<KeysetResponse>("GET", "/v1/keyset", null, true);
  }

  /* -------------------------------- vault --------------------------------- */

  async createVault(req: CreateVaultRequest): Promise<CreateVaultResponse> {
    return this.send<CreateVaultResponse>("POST", "/v1/vaults", req, true);
  }

  async getVaultMemberSelf(vaultId: string): Promise<MemberSelfResponse> {
    return this.send<MemberSelfResponse>(
      "GET",
      `/v1/vaults/${encodeURIComponent(vaultId)}/members/self`,
      null,
      true,
    );
  }

  async listVaults(): Promise<ListVaultsResponse> {
    return this.send<ListVaultsResponse>("GET", "/v1/vaults", null, true);
  }

  async updateVaultMeta(vaultId: string, req: UpdateVaultMetaRequest): Promise<void> {
    await this.sendVoid(
      "PUT",
      `/v1/vaults/${encodeURIComponent(vaultId)}/meta`,
      req,
      true,
    );
  }

  async deleteVault(vaultId: string): Promise<void> {
    await this.sendVoid(
      "DELETE",
      `/v1/vaults/${encodeURIComponent(vaultId)}`,
      null,
      true,
    );
  }

  /** 拉取本租户的 vault 删除墓碑（增量，按 seq 单调游标）。limit<=0 用服务端默认。 */
  async listDeletedVaults(since: number, limit: number): Promise<DeletedVaultsResponse> {
    let query = `?since=${since}`;
    if (limit > 0) query += `&limit=${limit}`;
    return this.send<DeletedVaultsResponse>(
      "GET",
      `/v1/vaults/deleted${query}`,
      null,
      true,
    );
  }

  async activateVault(vaultId: string): Promise<void> {
    await this.sendVoid(
      "POST",
      `/v1/vaults/${encodeURIComponent(vaultId)}/activate`,
      null,
      true,
    );
  }

  async getEntitlements(): Promise<Entitlements> {
    return this.send<Entitlements>("GET", "/v1/entitlements", null, true);
  }

  /* -------------------------------- sessions ------------------------------ */

  /** 吊销指定会话（登出时解析自身 token 的 sid 自吊销）。 */
  async revokeSession(sessionId: string): Promise<void> {
    await this.sendVoid(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      null,
      true,
    );
  }

  /* -------------------------------- sync ---------------------------------- */

  /** 分页拉快照/增量。limit<=0 时不带 limit；includeDeleted 仅在 true 时带。 */
  async getSnapshot(
    vaultId: string,
    cursor: number,
    limit: number,
    includeDeleted: boolean,
  ): Promise<SnapshotResponse> {
    let query = `?cursor=${cursor}`;
    if (limit > 0) query += `&limit=${limit}`;
    if (includeDeleted) query += "&include_deleted=true";
    return this.send<SnapshotResponse>(
      "GET",
      `/v1/vaults/${encodeURIComponent(vaultId)}/snapshot${query}`,
      null,
      true,
    );
  }

  /** 提交单条变更（乐观 CAS）。冲突走 HTTP 200，体现在返回值 status。 */
  async postChange(vaultId: string, req: ChangeRequest): Promise<ChangeResponse> {
    return this.send<ChangeResponse>(
      "POST",
      `/v1/vaults/${encodeURIComponent(vaultId)}/changes`,
      req,
      true,
    );
  }

  /* -------------------------------- 实时事件流 (SSE) ------------------------- */

  /**
   * 打开 GET /v1/events SSE 流。onEvent(name,data) 每解析出一个事件触发；
   * onClosed(err) 在流"非显式关闭地"结束时触发（正常轮转 err=null / 75s 静默 /
   * 网络或鉴权错误），供调用方重连。close() 显式关闭，不触发 onClosed。
   *
   * 用 XMLHttpRequest 增量读 responseText（readOffset 记已消费位置）+ 75s 看门狗：
   * 静默时 abort 流以中止 body 读取（与 desktop events.go / harmony 同构）。
   */
  openEventStream(
    onEvent: (name: string, data: string) => void,
    onClosed: (err: APIError | null) => void,
  ): EventStreamHandle {
    const xhr = new XMLHttpRequest();
    let buffer = "";
    let readOffset = 0;
    let eventName = "";
    let dataBuf = "";
    let closed = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    const finish = (err: APIError | null, fromClose: boolean): void => {
      if (closed) return;
      closed = true;
      clearTimeout(watchdog);
      watchdog = undefined;
      try {
        xhr.abort();
      } catch {
        // ignore
      }
      if (!fromClose) onClosed(err);
    };

    const armWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout((): void => {
        watchdog = undefined;
        finish(null, false);
      }, EVENTS_STALE_MS);
    };

    const dispatch = (): void => {
      const name = eventName;
      const data = dataBuf;
      eventName = "";
      dataBuf = "";
      if (name.length > 0) onEvent(name, data);
    };

    const processLine = (line: string): void => {
      if (line.length === 0) {
        dispatch();
        return;
      }
      if (line.charAt(0) === ":") return; // keepalive 注释
      const idx = line.indexOf(":");
      const field = idx < 0 ? line : line.slice(0, idx);
      let value = idx < 0 ? "" : line.slice(idx + 1);
      if (value.charAt(0) === " ") value = value.slice(1);
      if (field === "event") eventName = value.trim();
      else if (field === "data") {
        dataBuf = dataBuf.length > 0 ? `${dataBuf}\n${value}` : value;
      }
    };

    // 从 xhr.responseText 增量消费（responseText 累积，readOffset 记录已读位置）。
    const consume = (): void => {
      const full = xhr.responseText;
      if (full.length <= readOffset) return;
      armWatchdog();
      buffer += full.slice(readOffset);
      readOffset = full.length;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        let line = buffer.slice(0, nl);
        if (line.endsWith("\r")) line = line.slice(0, line.length - 1);
        buffer = buffer.slice(nl + 1);
        processLine(line);
        nl = buffer.indexOf("\n");
      }
    };

    // load/error/abort 共用收尾：2xx 视为正常结束，其余转 APIError。
    const settle = (): void => {
      const code = xhr.status;
      if (code >= 200 && code < 300) finish(null, false);
      else finish(new APIError(code || 0, `events status ${code || 0}`), false);
    };

    xhr.onprogress = (): void => {
      consume();
    };
    xhr.onreadystatechange = (): void => {
      // 3=LOADING（流式增量）、4=DONE（收尾前最后一次 flush）
      if (xhr.readyState === XMLHttpRequest.LOADING || xhr.readyState === XMLHttpRequest.DONE) {
        consume();
      }
    };
    xhr.onload = (): void => {
      settle();
    };
    xhr.onerror = (): void => {
      settle();
    };
    xhr.onabort = (): void => {
      settle();
    };

    try {
      xhr.open("GET", `${this.baseURL}/v1/events`);
      xhr.setRequestHeader("accept", "text/event-stream");
      xhr.setRequestHeader("cache-control", "no-cache");
      if (this.token) xhr.setRequestHeader("authorization", `Bearer ${this.token}`);
      armWatchdog();
      xhr.send();
    } catch (e) {
      finish(new APIError(0, e instanceof Error ? e.message : String(e)), false);
    }

    return {
      close(): void {
        finish(null, true);
      },
    };
  }
}
