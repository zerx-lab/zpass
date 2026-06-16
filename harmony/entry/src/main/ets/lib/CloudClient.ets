// ZPass HarmonyOS —— 云同步 HTTP 线缆客户端
//
// 与 desktop internal/cloud/client.go 一一对应：所有端点、请求/响应 JSON 形状、
// Bearer 鉴权、以及「CAS 冲突走 HTTP 200（body.status='conflict'）而非错误」契约。
// 本层不持有任何密钥 —— 字节 ↔ base64 的转换由 CloudCrypto / CloudAccount / CloudSync
// 负责，这里只搬运 base64 字符串与标量（与 client.go「holds NO crypto」一致）。
//
// base64：服务端全程 Go base64.StdEncoding（标准字母表 + '=' 补位），与本端
// Crypto.toB64/fromB64 一致。
//
// 路径：全部挂在 /v1 下；baseURL 形如 http(s)://host:port（不含尾斜杠、不含 /v1）。

import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { utf8Decode } from './Crypto';

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
    return this.status === 403 && this.message === 'vault_frozen';
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
      const obj = JSON.parse(text) as Record<string, Object>;
      const e = obj.error;
      if (typeof e === 'string' && (e as string).length > 0) return e as string;
    } catch (_e) {
      // 非 JSON（如 401 文本体）—— 原样返回
    }
    return text;
  }
  return `status ${code}`;
}

/* ----------------------------------------------------------------------------
 * 客户端
 * -------------------------------------------------------------------------- */

/** SSE 静默看门狗：75s 无字节即判定流失活并重连（> 服务端 20s keepalive 间隔）。 */
const EVENTS_STALE_MS: number = 75_000;

/** 长连接事件流句柄；close() 显式关闭且不触发 onClosed/重连。 */
export interface EventStreamHandle {
  close(): void;
}

/** EventStreamHandle 的具体实现：把 close 委托给关闭回调（避免对象字面量受限于 arkts-no-untyped-obj-literals）。 */
class EventStreamHandleImpl implements EventStreamHandle {
  private readonly onClose: () => void;
  constructor(onClose: () => void) {
    this.onClose = onClose;
  }
  close(): void {
    this.onClose();
  }
}

export class CloudClient {
  private baseURL: string = '';
  private token: string = '';

  constructor(baseURL: string) {
    this.setBaseURL(baseURL);
  }

  /** 设置 baseURL（去尾斜杠）。 */
  setBaseURL(baseURL: string): void {
    let b = (baseURL ?? '').trim();
    while (b.endsWith('/')) b = b.slice(0, b.length - 1);
    this.baseURL = b;
  }

  getBaseURL(): string {
    return this.baseURL;
  }

  setToken(token: string): void {
    this.token = token ?? '';
  }

  clearToken(): void {
    this.token = '';
  }

  hasToken(): boolean {
    return this.token.length > 0;
  }

  /* -------------------------------- 传输 ---------------------------------- */

  private async send<O>(
    method: http.RequestMethod,
    path: string,
    body: Object | null,
    authed: boolean,
  ): Promise<O> {
    const text = await this.sendRaw(method, path, body, authed);
    return JSON.parse(text) as O;
  }

  private async sendVoid(
    method: http.RequestMethod,
    path: string,
    body: Object | null,
    authed: boolean,
  ): Promise<void> {
    await this.sendRaw(method, path, body, authed);
  }

  private async sendRaw(
    method: http.RequestMethod,
    path: string,
    body: Object | null,
    authed: boolean,
  ): Promise<string> {
    if (!this.baseURL) {
      throw new APIError(0, '云服务地址未配置');
    }
    const request = http.createHttp();
    try {
      const header: Record<string, string> = JSON.parse('{}') as Record<string, string>;
      header['accept'] = 'application/json';
      if (body !== null) header['content-type'] = 'application/json';
      if (authed) {
        if (!this.token) throw new APIError(401, '缺少云会话凭证');
        header['authorization'] = `Bearer ${this.token}`;
      }
      const options: http.HttpRequestOptions = {
        method,
        header,
        connectTimeout: 15_000,
        readTimeout: 30_000,
      };
      if (body !== null) options.extraData = JSON.stringify(body);
      const resp = await request.request(this.baseURL + path, options);
      const code = resp.responseCode;
      const text = typeof resp.result === 'string' ? resp.result : '';
      if (code < 200 || code >= 300) {
        throw new APIError(code, parseErrorMessage(text, code));
      }
      return text;
    } catch (e) {
      if (e instanceof APIError) throw e;
      const err = e as BusinessError;
      throw new APIError(0, `${err.code ?? ''} ${err.message ?? String(e)}`.trim());
    } finally {
      request.destroy();
    }
  }

  /* -------------------------------- 鉴权 ---------------------------------- */

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    return this.send<RegisterResponse>(http.RequestMethod.POST, '/v1/auth/register', req, false);
  }

  async loginStart(req: LoginStartRequest): Promise<LoginStartResponse> {
    return this.send<LoginStartResponse>(http.RequestMethod.POST, '/v1/auth/login/start', req, false);
  }

  async loginFinish(req: LoginFinishRequest): Promise<LoginFinishResponse> {
    return this.send<LoginFinishResponse>(http.RequestMethod.POST, '/v1/auth/login/finish', req, false);
  }

  /** 完成 MFA（TOTP）二次验证 → session_token。公开端点，无需 Bearer。 */
  async loginMfa(req: LoginMfaRequest): Promise<LoginMfaResponse> {
    return this.send<LoginMfaResponse>(http.RequestMethod.POST, '/v1/auth/login/mfa', req, false);
  }

  /* -------------------------------- keyset -------------------------------- */

  async putKeyset(req: KeysetRequest): Promise<void> {
    await this.sendVoid(http.RequestMethod.POST, '/v1/keyset', req, true);
  }

  async getKeyset(): Promise<KeysetResponse> {
    return this.send<KeysetResponse>(http.RequestMethod.GET, '/v1/keyset', null, true);
  }

  /* -------------------------------- vault --------------------------------- */

  async createVault(req: CreateVaultRequest): Promise<CreateVaultResponse> {
    return this.send<CreateVaultResponse>(http.RequestMethod.POST, '/v1/vaults', req, true);
  }

  async getVaultMemberSelf(vaultId: string): Promise<MemberSelfResponse> {
    return this.send<MemberSelfResponse>(
      http.RequestMethod.GET,
      `/v1/vaults/${encodeURIComponent(vaultId)}/members/self`,
      null,
      true,
    );
  }

  async listVaults(): Promise<ListVaultsResponse> {
    return this.send<ListVaultsResponse>(http.RequestMethod.GET, '/v1/vaults', null, true);
  }

  async updateVaultMeta(vaultId: string, req: UpdateVaultMetaRequest): Promise<void> {
    await this.sendVoid(
      http.RequestMethod.PUT,
      `/v1/vaults/${encodeURIComponent(vaultId)}/meta`,
      req,
      true,
    );
  }

  async deleteVault(vaultId: string): Promise<void> {
    await this.sendVoid(
      http.RequestMethod.DELETE,
      `/v1/vaults/${encodeURIComponent(vaultId)}`,
      null,
      true,
    );
  }

  async activateVault(vaultId: string): Promise<void> {
    await this.sendVoid(
      http.RequestMethod.POST,
      `/v1/vaults/${encodeURIComponent(vaultId)}/activate`,
      null,
      true,
    );
  }

  async getEntitlements(): Promise<Entitlements> {
    return this.send<Entitlements>(http.RequestMethod.GET, '/v1/entitlements', null, true);
  }

  /* -------------------------------- sessions ------------------------------ */

  /** 吊销指定会话（登出时解析自身 token 的 sid 自吊销）。 */
  async revokeSession(sessionId: string): Promise<void> {
    await this.sendVoid(
      http.RequestMethod.DELETE,
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
    if (includeDeleted) query += '&include_deleted=true';
    return this.send<SnapshotResponse>(
      http.RequestMethod.GET,
      `/v1/vaults/${encodeURIComponent(vaultId)}/snapshot${query}`,
      null,
      true,
    );
  }

  /** 提交单条变更（乐观 CAS）。冲突走 HTTP 200，体现在返回值 status。 */
  async postChange(vaultId: string, req: ChangeRequest): Promise<ChangeResponse> {
    return this.send<ChangeResponse>(
      http.RequestMethod.POST,
      `/v1/vaults/${encodeURIComponent(vaultId)}/changes`,
      req,
      true,
    );
  }

  /* -------------------------------- 实时事件流 (SSE) ------------------------- */

  /**
   * 打开 GET /v1/events SSE 流。onEvent(name,data) 每解析出一个事件触发；
   * onClosed(err) 在流"非显式关闭地"结束时触发（正常 15min 轮转 err=null / 75s 静默 /
   * 网络或鉴权错误），供调用方重连。close() 显式关闭，不触发 onClosed。
   *
   * 用独立 http 实例 + 16min readTimeout（> 服务端 15min cap）+ 75s 看门狗：ohos 无
   * 逐读超时，看门狗在静默时 destroy 流以中止 body 读取（与 desktop events.go 同构）。
   */
  openEventStream(
    onEvent: (name: string, data: string) => void,
    onClosed: (err: APIError | null) => void,
  ): EventStreamHandle {
    const req = http.createHttp();
    let buffer = '';
    let eventName = '';
    let dataBuf = '';
    let closed = false;
    let watchdog = -1;

    const finish = (err: APIError | null, fromClose: boolean): void => {
      if (closed) return;
      closed = true;
      if (watchdog >= 0) {
        clearTimeout(watchdog);
        watchdog = -1;
      }
      try {
        req.off('dataReceive');
      } catch (_e) {
        // ignore
      }
      try {
        req.destroy();
      } catch (_e) {
        // ignore
      }
      if (!fromClose) onClosed(err);
    };
    const armWatchdog = (): void => {
      if (watchdog >= 0) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        watchdog = -1;
        finish(null, false);
      }, EVENTS_STALE_MS);
    };
    const dispatch = (): void => {
      const name = eventName;
      const data = dataBuf;
      eventName = '';
      dataBuf = '';
      if (name.length > 0) onEvent(name, data);
    };
    const processLine = (line: string): void => {
      if (line.length === 0) {
        dispatch();
        return;
      }
      if (line.charAt(0) === ':') return; // keepalive 注释
      const idx = line.indexOf(':');
      const field = idx < 0 ? line : line.slice(0, idx);
      let value = idx < 0 ? '' : line.slice(idx + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (field === 'event') eventName = value.trim();
      else if (field === 'data') dataBuf = dataBuf.length > 0 ? `${dataBuf}\n${value}` : value;
    };

    req.on('dataReceive', (data: ArrayBuffer) => {
      armWatchdog();
      buffer += utf8Decode(new Uint8Array(data));
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        let line = buffer.slice(0, nl);
        if (line.endsWith('\r')) line = line.slice(0, line.length - 1);
        buffer = buffer.slice(nl + 1);
        processLine(line);
        nl = buffer.indexOf('\n');
      }
    });

    const header: Record<string, string> = JSON.parse('{}') as Record<string, string>;
    header['accept'] = 'text/event-stream';
    header['cache-control'] = 'no-cache';
    if (this.token) header['authorization'] = `Bearer ${this.token}`;
    armWatchdog();
    req.requestInStream(`${this.baseURL}/v1/events`, {
      method: http.RequestMethod.GET,
      header,
      connectTimeout: 15_000,
      readTimeout: 16 * 60 * 1000,
    }).then((code: number) => {
      if (code >= 200 && code < 300) finish(null, false);
      else finish(new APIError(code, `events status ${code}`), false);
    }).catch((e: BusinessError) => {
      finish(new APIError(0, `${e.code ?? ''} ${e.message ?? String(e)}`.trim()), false);
    });

    return new EventStreamHandleImpl((): void => finish(null, true));
  }
}
