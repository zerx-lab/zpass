/**
 * ZPass HarmonyOS —— LAN 同步协议（server 模式驱动）
 *
 * 鸿蒙设备作为同步服务端：别的设备（手机 / 桌面 / 其它鸿蒙）主动连进来同步。
 * 监听 socket 由原生 cryptocore（Rust tiny_http + napi TSFN 反向回调）提供；本文件
 * 实现协议状态机，复用 SyncProtocol.ets 导出的原语（SyncSession / 配对派生 / manifest &
 * record 构建 / AEAD），保证与 client / desktop 字节级一致。
 *
 * 与 phone/lib/sync-server.ts 行为对齐，关键差异：
 *   - 状态不走 useSyncExternalStore，而是 @ObservedV2 + @Trace 字段，页面直接订阅。
 *   - 入站请求 body 是原始 Uint8Array（napi 直传），不再走 base64。
 *   - addSyncRequestListener 在 Rust 端 sticky 注册一次，无 remove；停服仅 stop socket。
 *
 * 冲突归属：client 本地检测冲突后 report-conflicts 上报到本机；本机镜像成「本机 local /
 * 对端 remote」存入 pendingConflicts，由 SyncConflicts 页让本机用户决策；applyMerge 把决策
 * 落到本机 vault + 生成 action 列表，等 client 轮询 poll-resolutions 取走应用。
 */

import {
  SYNC_AAD_COMMIT,
  SYNC_AAD_FETCH,
  SYNC_AAD_MANIFEST,
  SYNC_AAD_PAIR,
  SYNC_AAD_POLL_RESOLUTIONS,
  SYNC_AAD_PUSH,
  SYNC_AAD_REPORT_CONFLICTS,
  SYNC_PAIR_NONCE_LEN,
  SYNC_PAIR_SALT_LEN,
  SYNC_PROTO_VERSION,
  SYNC_SESSION_ID_LEN,
  SyncConflict,
  SyncConflictKind,
  SyncItemRecord,
  SyncManifestEntry,
  SyncSession,
  applyRemoteRecord,
  buildLocalManifest,
  buildRecordFromLocal,
  constantTimeEqual,
  deriveSyncSessionKey,
  hexDecode,
  hexEncode,
  hmacSha256,
} from './SyncProtocol';
import { fromB64, randomBytes, toB64, utf8, utf8Decode } from './Crypto';
import { ItemPayload, vaultService } from './VaultService';
import { readVaultFile } from './VaultStorage';
import {
  SyncRequest,
  addSyncRequestListener,
  isNativeSyncServerAvailable,
  nativeRespondSyncRequest,
  nativeStartSyncServer,
  nativeStopSyncServer,
} from './RustCryptoCore';

/* ----------------------------------------------------------------------------
 * 常量 —— 与 desktop syncservice.go / phone sync-server.ts 对齐
 * -------------------------------------------------------------------------- */

const SYNC_PIN_DIGITS = 6;
/** PIN 连续失败次数上限，达到即锁定 */
const SYNC_PIN_MAX_FAILURES = 3;
/** PIN 锁定时长（毫秒） */
const SYNC_PIN_LOCKOUT_MS = 60 * 1000;
/** 配对窗口（毫秒）：pair → confirm 须在此时间内完成 */
const SYNC_PAIR_WINDOW_MS = 5 * 60 * 1000;
/** 会话总时长（毫秒） */
const SYNC_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/* ----------------------------------------------------------------------------
 * 对外类型
 * -------------------------------------------------------------------------- */

export type ConflictChoice = 'local' | 'remote' | 'duplicate' | 'skip';

/** server 视角的单条冲突：local = 本机自己的条目，remote = 连入端上报的条目 */
export interface ServerConflict extends SyncConflict {
  resolution?: ConflictChoice;
}

export type SyncServerStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'paired'
  | 'merge'
  | 'applying'
  | 'done'
  | 'error';

export interface SyncServerProgress {
  stage: string;
  processed: number;
  total: number;
  message?: string;
}

/* ----------------------------------------------------------------------------
 * 协议 JSON 形状（本机仅作 server，局部定义即可；字段与 SyncProtocol/desktop 对齐）
 * -------------------------------------------------------------------------- */

interface SyncHttpResult {
  status: number;
  body: Uint8Array;
}

interface PairRequestJSON {
  protoVersion?: number;
  clientNonce: string;
}
interface PairResponseJSON {
  protoVersion: number;
  sessionId: string;
  salt: string;
  serverNonce: string;
}
interface PairConfirmRequestJSON {
  confirm: string;
}
interface PairConfirmResponseJSON {
  confirm: string;
}
interface ManifestResponseJSON {
  protoVersion: number;
  sessionId: string;
  entries: SyncManifestEntry[];
  generatedAt: number;
}
interface FetchRequestJSON {
  ids: string[];
}
interface BatchResponseJSON {
  sessionId: string;
  items: SyncItemRecord[];
  total: number;
}
interface PushRequestJSON {
  items: SyncItemRecord[];
}
interface PushResponseJSON {
  sessionId: string;
  accepted: number;
}
interface CommitRequestJSON {
  sessionId: string;
  apply?: SyncItemRecord[];
}
interface CommitResponseJSON {
  sessionId: string;
  applied: number;
  deleted: number;
}
interface ReportedConflictJSON {
  id: string;
  kind: string;
  localManifest: SyncManifestEntry;
  remoteManifest: SyncManifestEntry;
  suggestedRemote: boolean;
  localPayload?: string;
}
interface ReportConflictsRequestJSON {
  conflicts: ReportedConflictJSON[];
}
interface ReportConflictsResponseJSON {
  sessionId: string;
  accepted: number;
}
interface ResolutionActionJSON {
  id: string;
  op: string;
  payload?: string;
  newId?: string;
  createdAt?: number;
  updatedAt?: number;
}
interface PollResolutionsResponseJSON {
  sessionId: string;
  ready: boolean;
  actions?: ResolutionActionJSON[];
}

/** 内部错误 —— 携带 HTTP 状态码，dispatcher 映射回响应 */
class SyncHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface PendingPair {
  sessionId: string;
  salt: Uint8Array;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  sessionKey: Uint8Array;
  createdAt: number;
}

/* ----------------------------------------------------------------------------
 * 响应式服务端单例
 * -------------------------------------------------------------------------- */

@ObservedV2
export class SyncServer {
  /** 本设备是否支持作为同步服务端（原生 .so 是否带 server 桥） */
  @Trace available: boolean = false;
  @Trace running: boolean = false;
  /** 6 位数字 PIN，startServer 时生成 */
  @Trace pin: string = '';
  /** 本机 LAN IPv4 列表（原生 enumerate_lan_ipv4） */
  @Trace hosts: string[] = [];
  /** 系统分配的监听端口 */
  @Trace port: number = 0;
  /** 扫码连接串：zpass-sync://host:port?pin=，running 且有 host 时非空 */
  @Trace qrPayload: string = '';
  @Trace status: SyncServerStatus = 'idle';
  @Trace progress: SyncServerProgress = { stage: 'idle', processed: 0, total: 0 };
  /** 待本机用户决策的冲突；每次变更重新赋新数组以触发 @Trace */
  @Trace pendingConflicts: ServerConflict[] = [];
  @Trace error: string = '';

  /* ----- 内部会话状态（不参与渲染，故非 @Trace） ----- */
  private salt: Uint8Array = new Uint8Array(0);
  private pinFailures: number = 0;
  private pinLockedAt: number = 0;
  private pending: PendingPair | null = null;
  private session: SyncSession | null = null;
  private pairedAt: number = 0;
  private pendingResolutions: ResolutionActionJSON[] | null = null;
  private listenerBound: boolean = false;

  constructor() {
    try {
      this.available = isNativeSyncServerAvailable();
    } catch (_e) {
      this.available = false;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private wipe(b: Uint8Array): void {
    b.fill(0);
  }

  private resetSessionState(): void {
    if (this.pending) this.wipe(this.pending.sessionKey);
    this.pending = null;
    this.session = null;
    this.pairedAt = 0;
    this.pinFailures = 0;
    this.pinLockedAt = 0;
    this.pendingConflicts = [];
    this.pendingResolutions = null;
    this.progress = { stage: 'idle', processed: 0, total: 0 };
  }

  private updateQr(): void {
    this.qrPayload =
      this.running && this.hosts.length > 0
        ? `zpass-sync://${this.hosts[0]}:${this.port}?pin=${this.pin}`
        : '';
  }

  /* ----- 生命周期 ----- */

  async startServer(): Promise<void> {
    if (!this.available) {
      throw new Error('本设备不支持作为同步服务端');
    }
    if (!vaultService.isUnlocked()) {
      throw new Error('vault 已锁定，请先解锁');
    }
    if (this.running) return;

    this.resetSessionState();
    this.pin = this.generateNumericPin(SYNC_PIN_DIGITS);
    this.salt = randomBytes(SYNC_PAIR_SALT_LEN);
    this.error = '';
    this.status = 'starting';

    // Rust 端 handler sticky 注册，仅首次生效；多次调用安全。
    if (!this.listenerBound) {
      addSyncRequestListener((req: SyncRequest) => {
        this.onRequest(req).catch(() => {});
      });
      this.listenerBound = true;
    }

    try {
      const info = await nativeStartSyncServer();
      this.port = info.port;
      this.hosts = info.hosts;
      this.running = true;
      this.status = 'listening';
      this.progress = { stage: 'listening', processed: 0, total: 0 };
      this.updateQr();
    } catch (e) {
      this.status = 'error';
      this.error = e instanceof Error ? e.message : String(e);
      this.updateQr();
      throw new Error(this.error);
    }
  }

  async stopServer(): Promise<void> {
    try {
      await nativeStopSyncServer();
    } catch (_e) {
      /* ignore */
    }
    this.running = false;
    this.resetSessionState();
    this.status = 'idle';
    this.updateQr();
  }

  /** 处理单个入站请求并把响应回传给 Rust worker */
  private async onRequest(req: SyncRequest): Promise<void> {
    let result: SyncHttpResult;
    try {
      result = await this.handleSyncRequest(req.method, req.path, req.body);
    } catch (_e) {
      result = { status: 500, body: new Uint8Array(0) };
    }
    try {
      await nativeRespondSyncRequest(req.reqId, result.status, result.body);
    } catch (_e) {
      /* ignore respond failure */
    }
  }

  /* ----- 路由 ----- */

  private async handleSyncRequest(
    _method: string,
    path: string,
    body: Uint8Array,
  ): Promise<SyncHttpResult> {
    try {
      if (path === '/v1/pair') {
        return { status: 200, body: await this.handlePair(body) };
      } else if (path === '/v1/pair/confirm') {
        return { status: 200, body: await this.handlePairConfirm(body) };
      } else if (path === '/v1/sync/manifest') {
        return { status: 200, body: await this.handleManifest(body) };
      } else if (path === '/v1/sync/fetch') {
        return { status: 200, body: await this.handleFetch(body) };
      } else if (path === '/v1/sync/push') {
        return { status: 200, body: await this.handlePush(body) };
      } else if (path === '/v1/sync/commit') {
        return { status: 200, body: await this.handleCommit(body) };
      } else if (path === '/v1/sync/report-conflicts') {
        return { status: 200, body: await this.handleReportConflicts(body) };
      } else if (path === '/v1/sync/poll-resolutions') {
        return { status: 200, body: await this.handlePollResolutions(body) };
      }
      throw new SyncHttpError(404, 'not found');
    } catch (e) {
      if (e instanceof SyncHttpError) {
        return { status: e.status, body: new Uint8Array(0) };
      }
      return { status: 500, body: new Uint8Array(0) };
    }
  }

  private requireSession(): SyncSession {
    if (!vaultService.isUnlocked()) throw new SyncHttpError(401, 'vault locked');
    if (!this.session) throw new SyncHttpError(401, 'no active session');
    if (Date.now() - this.pairedAt > SYNC_SESSION_TIMEOUT_MS) {
      throw new SyncHttpError(410, 'session expired');
    }
    return this.session;
  }

  private openOr401<T>(sess: SyncSession, body: Uint8Array, aad: Uint8Array): T {
    try {
      return sess.openJSON<T>(body, aad);
    } catch (_e) {
      throw new SyncHttpError(401, 'decrypt failed');
    }
  }

  /* ----- 配对（server 角色） ----- */

  private async handlePair(body: Uint8Array): Promise<Uint8Array> {
    let req: PairRequestJSON;
    try {
      req = JSON.parse(utf8Decode(body)) as PairRequestJSON;
    } catch (_e) {
      throw new SyncHttpError(400, 'bad request');
    }
    let clientNonce: Uint8Array;
    try {
      clientNonce = hexDecode(req.clientNonce);
    } catch (_e) {
      throw new SyncHttpError(400, 'bad clientNonce');
    }
    if (clientNonce.length !== SYNC_PAIR_NONCE_LEN) {
      throw new SyncHttpError(400, 'bad clientNonce');
    }
    if (this.pinLockedAt > 0 && Date.now() - this.pinLockedAt < SYNC_PIN_LOCKOUT_MS) {
      throw new SyncHttpError(429, 'pin locked');
    }
    if (this.pending) {
      this.wipe(this.pending.sessionKey);
      this.pending = null;
    }
    const serverNonce = randomBytes(SYNC_PAIR_NONCE_LEN);
    const sessionId = hexEncode(randomBytes(SYNC_SESSION_ID_LEN));
    const sessionKey = await deriveSyncSessionKey(
      this.pin,
      this.salt,
      sessionId,
      clientNonce,
      serverNonce,
    );
    this.pending = {
      sessionId,
      salt: this.salt,
      clientNonce,
      serverNonce,
      sessionKey,
      createdAt: Date.now(),
    };
    const resp: PairResponseJSON = {
      protoVersion: SYNC_PROTO_VERSION,
      sessionId,
      salt: hexEncode(this.salt),
      serverNonce: hexEncode(serverNonce),
    };
    return utf8(JSON.stringify(resp));
  }

  private async handlePairConfirm(body: Uint8Array): Promise<Uint8Array> {
    const pp = this.pending;
    if (!pp) throw new SyncHttpError(409, 'no pending pair');
    if (Date.now() - pp.createdAt > SYNC_PAIR_WINDOW_MS) {
      throw new SyncHttpError(410, 'pair expired');
    }
    const tmp = new SyncSession(pp.sessionId, pp.sessionKey, 'server');
    let _req: PairConfirmRequestJSON;
    try {
      _req = tmp.openJSON<PairConfirmRequestJSON>(body, SYNC_AAD_PAIR);
    } catch (_e) {
      this.recordPinFailure();
      throw new SyncHttpError(401, 'decrypt failed');
    }
    const want = await hmacSha256(pp.sessionKey, utf8('client:confirm'));
    let got: Uint8Array;
    try {
      got = hexDecode(_req.confirm);
    } catch (_e) {
      this.recordPinFailure();
      throw new SyncHttpError(401, 'bad confirm');
    }
    if (!constantTimeEqual(got, want)) {
      this.recordPinFailure();
      throw new SyncHttpError(401, 'wrong pin');
    }
    // 配对成功
    this.session = tmp;
    this.pairedAt = Date.now();
    this.pending = null;
    this.pinFailures = 0;
    this.pinLockedAt = 0;
    this.status = 'paired';
    this.progress = { stage: 'manifest', processed: 0, total: 0 };

    const serverConfirm = await hmacSha256(pp.sessionKey, utf8('server:confirm'));
    const resp: PairConfirmResponseJSON = { confirm: hexEncode(serverConfirm) };
    return tmp.sealJSON(resp, SYNC_AAD_PAIR);
  }

  private recordPinFailure(): void {
    this.pinFailures++;
    if (this.pinFailures >= SYNC_PIN_MAX_FAILURES) {
      this.pinLockedAt = Date.now();
      this.pinFailures = 0;
      if (this.pending) {
        this.wipe(this.pending.sessionKey);
        this.pending = null;
      }
    }
  }

  /* ----- 数据端点 ----- */

  private async handleManifest(body: Uint8Array): Promise<Uint8Array> {
    const sess = this.requireSession();
    this.openOr401<Record<string, Object>>(sess, body, SYNC_AAD_MANIFEST);
    const entries = await buildLocalManifest();
    const resp: ManifestResponseJSON = {
      protoVersion: SYNC_PROTO_VERSION,
      sessionId: sess.id,
      entries,
      generatedAt: Date.now(),
    };
    return sess.sealJSON(resp, SYNC_AAD_MANIFEST);
  }

  private async handleFetch(body: Uint8Array): Promise<Uint8Array> {
    const sess = this.requireSession();
    const req = this.openOr401<FetchRequestJSON>(sess, body, SYNC_AAD_FETCH);
    const items: SyncItemRecord[] = [];
    for (const id of req.ids) {
      const rec = await buildRecordFromLocal(id);
      if (rec) items.push(rec);
    }
    const resp: BatchResponseJSON = {
      sessionId: sess.id,
      items,
      total: req.ids.length,
    };
    return sess.sealJSON(resp, SYNC_AAD_FETCH);
  }

  private async handlePush(body: Uint8Array): Promise<Uint8Array> {
    const sess = this.requireSession();
    const req = this.openOr401<PushRequestJSON>(sess, body, SYNC_AAD_PUSH);
    let accepted = 0;
    for (const rec of req.items) {
      if (await applyRemoteRecord(rec)) accepted++;
    }
    const resp: PushResponseJSON = { sessionId: sess.id, accepted };
    return sess.sealJSON(resp, SYNC_AAD_PUSH);
  }

  private async handleCommit(body: Uint8Array): Promise<Uint8Array> {
    const sess = this.requireSession();
    const req = this.openOr401<CommitRequestJSON>(sess, body, SYNC_AAD_COMMIT);
    let applied = 0;
    const apply = req.apply ?? [];
    for (const rec of apply) {
      if (await applyRemoteRecord(rec)) applied++;
    }
    const resp: CommitResponseJSON = { sessionId: sess.id, applied, deleted: 0 };
    return sess.sealJSON(resp, SYNC_AAD_COMMIT);
  }

  /* ----- 冲突上报 / 决策轮询 ----- */

  private async handleReportConflicts(body: Uint8Array): Promise<Uint8Array> {
    const sess = this.requireSession();
    const req = this.openOr401<ReportConflictsRequestJSON>(
      sess,
      body,
      SYNC_AAD_REPORT_CONFLICTS,
    );
    const ui: ServerConflict[] = [];
    for (const rc of req.conflicts) {
      // 镜像反转：client 的 local 是本机视角的 remote，反之亦然
      const c: ServerConflict = {
        id: rc.id,
        kind: rc.kind as SyncConflictKind,
        local: null,
        remote: null,
        localManifest: rc.remoteManifest,
        remoteManifest: rc.localManifest,
        suggestedRemote: !rc.suggestedRemote,
      };
      c.local = await this.safeGetItem(rc.id);
      if (rc.localPayload) {
        try {
          const payload = JSON.parse(
            utf8Decode(fromB64(rc.localPayload)),
          ) as ItemPayload;
          payload.id = rc.id;
          c.remote = payload;
        } catch (_e) {
          /* 对端 payload 不可解析：仅凭 manifest 决策 */
        }
      }
      ui.push(c);
    }
    this.pendingConflicts = ui;
    this.status = 'merge';
    this.progress = {
      stage: 'merge',
      processed: 0,
      total: ui.length,
      message: `${ui.length} 项冲突待决`,
    };

    const resp: ReportConflictsResponseJSON = {
      sessionId: sess.id,
      accepted: ui.length,
    };
    return sess.sealJSON(resp, SYNC_AAD_REPORT_CONFLICTS);
  }

  private async handlePollResolutions(body: Uint8Array): Promise<Uint8Array> {
    const sess = this.requireSession();
    this.openOr401<Record<string, Object>>(sess, body, SYNC_AAD_POLL_RESOLUTIONS);
    const ready = this.pendingResolutions !== null;
    const actions = ready ? (this.pendingResolutions ?? []) : undefined;
    if (ready) this.pendingResolutions = null;
    const resp: PollResolutionsResponseJSON = {
      sessionId: sess.id,
      ready,
      actions,
    };
    return sess.sealJSON(resp, SYNC_AAD_POLL_RESOLUTIONS);
  }

  /* ----- 用户决策 + 应用 ----- */

  resolveConflict(id: string, choice: ConflictChoice): void {
    const idx = this.pendingConflicts.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const next = this.pendingConflicts.slice();
    next[idx] = {
      id: next[idx].id,
      kind: next[idx].kind,
      local: next[idx].local,
      remote: next[idx].remote,
      localManifest: next[idx].localManifest,
      remoteManifest: next[idx].remoteManifest,
      suggestedRemote: next[idx].suggestedRemote,
      resolution: choice,
    };
    this.pendingConflicts = next;
  }

  private async safeGetItem(id: string): Promise<ItemPayload | null> {
    try {
      return await vaultService.getItem(id);
    } catch (_e) {
      return null;
    }
  }

  /** 本机该 id 当前是否为 tombstone（getItem 过滤 tombstone，故直读 vault 文件） */
  private async localRowIsTombstone(id: string): Promise<boolean> {
    const file = await readVaultFile();
    const row = file.items.find((r) => r.id === id);
    return !!row && typeof row.deletedAt === 'number' && row.deletedAt > 0;
  }

  /**
   * 把本机用户在 UI 上的决策落地：写本机 vault + 生成 client 应用用的 action 列表。
   * 决策 → action 映射逐项对齐 phone sync-server.ts::applyMerge。
   */
  async applyMerge(): Promise<number> {
    const pendingChoice = this.pendingConflicts.find((c) => !c.resolution);
    if (pendingChoice) {
      throw new Error('还有冲突未选择');
    }
    this.status = 'applying';

    let applied = 0;
    const now = vaultService.nextTimestamp();
    const actions: ResolutionActionJSON[] = [];

    for (const c of this.pendingConflicts) {
      const choice: ConflictChoice = c.resolution ?? 'skip';
      if (choice === 'skip') {
        actions.push({ id: c.id, op: 'noop' });
        continue;
      }

      if (choice === 'local') {
        if (await this.localRowIsTombstone(c.id)) {
          actions.push({ id: c.id, op: 'delete' });
          applied++;
          continue;
        }
        const local = c.local ?? (await this.safeGetItem(c.id));
        if (!local) {
          actions.push({ id: c.id, op: 'noop' });
          continue;
        }
        try {
          await vaultService.ingestForeignPayload(c.id, local, local.createdAt, now);
        } catch (_e) {
          actions.push({ id: c.id, op: 'noop' });
          continue;
        }
        const latest = (await this.safeGetItem(c.id)) ?? local;
        actions.push({
          id: c.id,
          op: 'overwrite',
          payload: toB64(utf8(JSON.stringify(latest))),
          createdAt: latest.createdAt,
          updatedAt: now,
        });
        applied++;
        continue;
      }

      if (choice === 'remote') {
        if (!c.remote) {
          try {
            await vaultService.deleteItem(c.id);
            applied++;
          } catch (_e) {
            /* ignore */
          }
          actions.push({ id: c.id, op: 'noop' });
          continue;
        }
        const existing = await this.safeGetItem(c.id);
        const createdAt = existing?.createdAt ?? c.remote.createdAt;
        try {
          await vaultService.ingestForeignPayload(c.id, c.remote, createdAt, now);
        } catch (_e) {
          actions.push({ id: c.id, op: 'noop' });
          continue;
        }
        const latest = (await this.safeGetItem(c.id)) ?? c.remote;
        actions.push({
          id: c.id,
          op: 'overwrite',
          payload: toB64(utf8(JSON.stringify(latest))),
          createdAt: latest.createdAt,
          updatedAt: now,
        });
        applied++;
        continue;
      }

      if (choice === 'duplicate') {
        if (!c.remote) {
          actions.push({ id: c.id, op: 'noop' });
          continue;
        }
        let created: ItemPayload;
        try {
          created = await vaultService.createItem(
            c.remote.type,
            c.remote.name,
            c.remote.fields,
          );
        } catch (_e) {
          actions.push({ id: c.id, op: 'noop' });
          continue;
        }
        const local = await this.safeGetItem(c.id);
        if (local) {
          actions.push({
            id: c.id,
            op: 'overwrite',
            payload: toB64(utf8(JSON.stringify(local))),
            createdAt: local.createdAt,
            updatedAt: local.updatedAt,
          });
        }
        actions.push({
          id: c.id,
          op: 'duplicate',
          payload: toB64(utf8(JSON.stringify(c.remote))),
          newId: created.id,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        });
        applied++;
      }
    }

    this.pendingResolutions = actions;
    this.pendingConflicts = [];
    this.status = 'done';
    this.progress = { stage: 'done', processed: applied, total: applied };
    return applied;
  }

  /* ----- 工具 ----- */

  private generateNumericPin(digits: number): string {
    const raw = randomBytes(digits);
    let s = '';
    for (let i = 0; i < digits; i++) s += String(raw[i] % 10);
    return s;
  }
}

/** 进程级单例 —— 页面 @Local srv: SyncServer = syncServer 取引用 */
export const syncServer: SyncServer = new SyncServer();
