// ZPass Phone —— LAN 同步协议（server 模式）
//
// 手机作为同步服务端：别的设备（其它手机 / 鸿蒙 / PC）主动连过来同步。监听 socket
// 由原生 modules/zpass-crypto（Rust tiny_http，仅 Android）提供；本文件实现协议状态机，
// 复用 lib/sync-protocol.ts 导出的原语（SyncSession / 配对派生 / manifest & record 构建
// / AEAD），保证与 client / desktop 字节级一致。
//
// 请求流（Rust worker 单线程串行）：
//   onSyncRequest 事件 → handleSyncRequest 按 path 路由 → respondSyncRequest 回传
//
// 冲突归属（新方案）：client 本地检测冲突后 report-conflicts 上报到本机；本机把冲突
// 镜像成「本机 local / 对端 remote」存入 store，由 app/sync-conflicts.tsx 让本机用户决策；
// applyServerMerge 把决策落到本机 vault + 生成 action 列表，等 client 轮询 poll-resolutions
// 取走应用。整套语义移植自 desktop/internal/services/syncservice.go 的 server 分支。
//
// 仅 Android：isNativeSyncServerAvailable() 为 false 的平台上服务端入口应隐藏。

import { useSyncExternalStore } from "react";

import { fromB64, randomBytes, toB64, utf8, utf8Decode } from "./crypto";
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
  SyncSession,
  applyRemoteRecord,
  buildLocalManifest,
  buildRecordFromLocal,
  constantTimeEqual,
  deriveSyncSessionKey,
  hexDecode,
  hexEncode,
  hmacSha256,
  type SyncBatchResponse,
  type SyncConflict,
  type SyncFetchRequest,
  type SyncItemRecord,
  type SyncManifestResponse,
  type SyncPairConfirmRequest,
  type SyncPairConfirmResponse,
  type SyncPairRequest,
  type SyncPairResponse,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncReportConflictsRequest,
  type SyncReportConflictsResponse,
  type SyncResolutionAction,
  type SyncPollResolutionsResponse,
} from "./sync-protocol";
import { vaultService, type ItemPayload } from "./vault-service";
import { readVaultFile } from "./vault-storage";

import {
  addSyncRequestListener,
  isNativeSyncServerAvailable,
  nativeRespondSyncRequest,
  nativeStartSyncServer,
  nativeStopSyncServer,
  type SyncRequestEvent,
} from "../modules/zpass-crypto";

/* ----------------------------------------------------------------------------
 * 常量 —— 与 desktop syncservice.go 对齐
 * -------------------------------------------------------------------------- */

const SYNC_PIN_DIGITS = 6;
/** PIN 连续失败次数上限，达到即锁定 */
const SYNC_PIN_MAX_FAILURES = 3;
/** PIN 锁定时长（毫秒）—— 与 syncPinLockoutDur 对齐 */
const SYNC_PIN_LOCKOUT_MS = 60 * 1000;
/** 配对窗口（毫秒）：pair → confirm 须在此时间内完成 —— 与 syncPairWindow 对齐 */
const SYNC_PAIR_WINDOW_MS = 5 * 60 * 1000;
/** 会话总时长（毫秒）—— 与 syncSessionTimeout 对齐 */
const SYNC_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/* ----------------------------------------------------------------------------
 * 对外类型
 * -------------------------------------------------------------------------- */

export type ConflictChoice = "local" | "remote" | "duplicate" | "skip";

/** server 视角的单条冲突：local = 本机自己的条目，remote = 连入端上报的条目 */
export interface ServerConflict extends SyncConflict {
  resolution?: ConflictChoice;
}

export type SyncServerStatus =
  | "idle"
  | "starting"
  | "listening"
  | "paired"
  | "merge"
  | "applying"
  | "done"
  | "error";

export interface SyncServerProgress {
  stage: string;
  processed: number;
  total: number;
  message?: string;
}

export interface SyncServerSnapshot {
  available: boolean;
  running: boolean;
  pin: string;
  hosts: string[];
  port: number;
  qrPayload: string;
  status: SyncServerStatus;
  progress: SyncServerProgress;
  pendingConflicts: ServerConflict[];
  error?: string;
}

/* ----------------------------------------------------------------------------
 * 内部错误 —— 携带 HTTP 状态码，dispatcher 映射回响应
 * -------------------------------------------------------------------------- */

class SyncHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ----------------------------------------------------------------------------
 * 服务端会话状态（镜像 Go SyncService 的 server 字段）
 * -------------------------------------------------------------------------- */

interface PendingPair {
  sessionId: string;
  salt: Uint8Array;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  sessionKey: Uint8Array;
  createdAt: number;
}

let running = false;
let pin = "";
let salt: Uint8Array = new Uint8Array(0);
let hosts: string[] = [];
let port = 0;
let pinFailures = 0;
let pinLockedAt = 0;
let pending: PendingPair | null = null;
let session: SyncSession | null = null;
let pairedAt = 0;
let conflicts: ServerConflict[] = [];
let pendingResolutions: SyncResolutionAction[] | null = null;
let status: SyncServerStatus = "idle";
let progress: SyncServerProgress = { stage: "idle", processed: 0, total: 0 };
let lastError: string | undefined;
let subscription: ReturnType<typeof addSyncRequestListener> | null = null;

function wipe(b: Uint8Array): void {
  b.fill(0);
}

function resetSessionState(): void {
  if (pending) wipe(pending.sessionKey);
  pending = null;
  session = null;
  pairedAt = 0;
  pinFailures = 0;
  pinLockedAt = 0;
  conflicts = [];
  pendingResolutions = null;
  progress = { stage: "idle", processed: 0, total: 0 };
}

/* ----------------------------------------------------------------------------
 * 可订阅 store（请求处理在 React 之外变更 state，用 useSyncExternalStore 桥接）
 * -------------------------------------------------------------------------- */

const listeners = new Set<() => void>();
let snapshot: SyncServerSnapshot = buildSnapshot();

function buildSnapshot(): SyncServerSnapshot {
  const qrPayload =
    running && hosts.length > 0
      ? `zpass-sync://${hosts[0]}:${port}?pin=${pin}`
      : "";
  return {
    available: isNativeSyncServerAvailable(),
    running,
    pin,
    hosts: hosts.slice(),
    port,
    qrPayload,
    status,
    progress: { ...progress },
    pendingConflicts: conflicts.slice(),
    error: lastError,
  };
}

function notify(): void {
  snapshot = buildSnapshot();
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): SyncServerSnapshot {
  return snapshot;
}

/* ----------------------------------------------------------------------------
 * 生命周期
 * -------------------------------------------------------------------------- */

async function startServer(): Promise<void> {
  if (!isNativeSyncServerAvailable()) {
    throw new Error("本设备不支持作为同步服务端");
  }
  if (!vaultService.isUnlocked()) {
    throw new Error("vault 已锁定，请先解锁");
  }
  if (running) return;

  resetSessionState();
  pin = generateNumericPin(SYNC_PIN_DIGITS);
  salt = randomBytes(SYNC_PAIR_SALT_LEN);
  lastError = undefined;
  status = "starting";
  notify();

  subscription = addSyncRequestListener((e) => {
    void onRequest(e);
  });

  try {
    const info = await nativeStartSyncServer();
    port = info.port;
    hosts = info.hosts;
    running = true;
    status = "listening";
    progress = { stage: "listening", processed: 0, total: 0 };
  } catch (e) {
    subscription?.remove();
    subscription = null;
    status = "error";
    lastError = e instanceof Error ? e.message : String(e);
    notify();
    throw e;
  }
  notify();
}

async function stopServer(): Promise<void> {
  subscription?.remove();
  subscription = null;
  try {
    await nativeStopSyncServer();
  } catch {
    /* ignore */
  }
  running = false;
  resetSessionState();
  status = "idle";
  notify();
}

/** 处理单个入站请求并把响应回传给 Rust worker */
async function onRequest(e: SyncRequestEvent): Promise<void> {
  let result: { status: number; body: Uint8Array };
  try {
    result = await handleSyncRequest(e.method, e.path, fromB64(e.body));
  } catch (err) {
    console.warn("[sync-server] unhandled:", err);
    result = { status: 500, body: new Uint8Array(0) };
  }
  try {
    await nativeRespondSyncRequest(e.reqId, result.status, toB64(result.body));
  } catch (err) {
    console.warn("[sync-server] respond failed:", err);
  }
}

/* ----------------------------------------------------------------------------
 * 路由
 * -------------------------------------------------------------------------- */

async function handleSyncRequest(
  _method: string,
  path: string,
  body: Uint8Array,
): Promise<{ status: number; body: Uint8Array }> {
  try {
    switch (path) {
      case "/v1/pair":
        return { status: 200, body: await handlePair(body) };
      case "/v1/pair/confirm":
        return { status: 200, body: await handlePairConfirm(body) };
      case "/v1/sync/manifest":
        return { status: 200, body: await handleManifest(body) };
      case "/v1/sync/fetch":
        return { status: 200, body: await handleFetch(body) };
      case "/v1/sync/push":
        return { status: 200, body: await handlePush(body) };
      case "/v1/sync/commit":
        return { status: 200, body: await handleCommit(body) };
      case "/v1/sync/report-conflicts":
        return { status: 200, body: await handleReportConflicts(body) };
      case "/v1/sync/poll-resolutions":
        return { status: 200, body: await handlePollResolutions(body) };
      default:
        throw new SyncHttpError(404, "not found");
    }
  } catch (e) {
    if (e instanceof SyncHttpError) {
      return { status: e.status, body: new Uint8Array(0) };
    }
    console.warn("[sync-server] handler error:", e);
    return { status: 500, body: new Uint8Array(0) };
  }
}

function requireSession(): SyncSession {
  if (!vaultService.isUnlocked()) throw new SyncHttpError(401, "vault locked");
  if (!session) throw new SyncHttpError(401, "no active session");
  if (Date.now() - pairedAt > SYNC_SESSION_TIMEOUT_MS) {
    throw new SyncHttpError(410, "session expired");
  }
  return session;
}

function openOr401<T>(sess: SyncSession, body: Uint8Array, aad: Uint8Array): T {
  try {
    return sess.openJSON<T>(body, aad);
  } catch {
    throw new SyncHttpError(401, "decrypt failed");
  }
}

/* ----------------------------------------------------------------------------
 * 配对（server 角色）—— 移植 Go handlePair / handlePairConfirm
 * -------------------------------------------------------------------------- */

async function handlePair(body: Uint8Array): Promise<Uint8Array> {
  let req: SyncPairRequest;
  try {
    req = JSON.parse(utf8Decode(body)) as SyncPairRequest;
  } catch {
    throw new SyncHttpError(400, "bad request");
  }
  let clientNonce: Uint8Array;
  try {
    clientNonce = hexDecode(req.clientNonce);
  } catch {
    throw new SyncHttpError(400, "bad clientNonce");
  }
  if (clientNonce.length !== SYNC_PAIR_NONCE_LEN) {
    throw new SyncHttpError(400, "bad clientNonce");
  }
  if (pinLockedAt > 0 && Date.now() - pinLockedAt < SYNC_PIN_LOCKOUT_MS) {
    throw new SyncHttpError(429, "pin locked");
  }
  // 允许新 pair 覆盖未完成的 pending（旧 pending 可能是上次失败残留）
  if (pending) {
    wipe(pending.sessionKey);
    pending = null;
  }
  const serverNonce = randomBytes(SYNC_PAIR_NONCE_LEN);
  const sessionId = hexEncode(randomBytes(SYNC_SESSION_ID_LEN));
  const sessionKey = await deriveSyncSessionKey(
    pin,
    salt,
    sessionId,
    clientNonce,
    serverNonce,
  );
  pending = {
    sessionId,
    salt,
    clientNonce,
    serverNonce,
    sessionKey,
    createdAt: Date.now(),
  };
  const resp: SyncPairResponse = {
    protoVersion: SYNC_PROTO_VERSION,
    sessionId,
    salt: hexEncode(salt),
    serverNonce: hexEncode(serverNonce),
  };
  return utf8(JSON.stringify(resp));
}

async function handlePairConfirm(body: Uint8Array): Promise<Uint8Array> {
  const pp = pending;
  if (!pp) throw new SyncHttpError(409, "no pending pair");
  if (Date.now() - pp.createdAt > SYNC_PAIR_WINDOW_MS) {
    throw new SyncHttpError(410, "pair expired");
  }
  // 临时 session 解 confirm；成功后晋升为长期 session（计数器状态需延续）
  const tmp = new SyncSession(pp.sessionId, pp.sessionKey, "server");
  let req: SyncPairConfirmRequest;
  try {
    req = tmp.openJSON<SyncPairConfirmRequest>(body, SYNC_AAD_PAIR);
  } catch {
    recordPinFailure();
    throw new SyncHttpError(401, "decrypt failed");
  }
  const want = await hmacSha256(pp.sessionKey, "client:confirm");
  let got: Uint8Array;
  try {
    got = hexDecode(req.confirm);
  } catch {
    recordPinFailure();
    throw new SyncHttpError(401, "bad confirm");
  }
  if (!constantTimeEqual(got, want)) {
    recordPinFailure();
    throw new SyncHttpError(401, "wrong pin");
  }
  // 配对成功
  session = tmp;
  pairedAt = Date.now();
  pending = null;
  pinFailures = 0;
  pinLockedAt = 0;
  status = "paired";
  progress = { stage: "manifest", processed: 0, total: 0 };
  notify();

  const serverConfirm = await hmacSha256(pp.sessionKey, "server:confirm");
  const resp: SyncPairConfirmResponse = { confirm: hexEncode(serverConfirm) };
  return tmp.sealJSON(resp, SYNC_AAD_PAIR);
}

function recordPinFailure(): void {
  pinFailures++;
  if (pinFailures >= SYNC_PIN_MAX_FAILURES) {
    pinLockedAt = Date.now();
    pinFailures = 0;
    if (pending) {
      wipe(pending.sessionKey);
      pending = null;
    }
  }
}

/* ----------------------------------------------------------------------------
 * 数据端点 —— manifest / fetch / push / commit
 * -------------------------------------------------------------------------- */

async function handleManifest(body: Uint8Array): Promise<Uint8Array> {
  const sess = requireSession();
  openOr401(sess, body, SYNC_AAD_MANIFEST);
  const entries = await buildLocalManifest();
  const resp: SyncManifestResponse = {
    protoVersion: SYNC_PROTO_VERSION,
    sessionId: sess.id,
    entries,
    generatedAt: Date.now(),
  };
  return sess.sealJSON(resp, SYNC_AAD_MANIFEST);
}

async function handleFetch(body: Uint8Array): Promise<Uint8Array> {
  const sess = requireSession();
  const req = openOr401<SyncFetchRequest>(sess, body, SYNC_AAD_FETCH);
  const items: SyncItemRecord[] = [];
  for (const id of req.ids) {
    const rec = await buildRecordFromLocal(id);
    if (rec) items.push(rec);
  }
  const resp: SyncBatchResponse = {
    sessionId: sess.id,
    items,
    total: req.ids.length,
  };
  return sess.sealJSON(resp, SYNC_AAD_FETCH);
}

async function handlePush(body: Uint8Array): Promise<Uint8Array> {
  const sess = requireSession();
  const req = openOr401<SyncPushRequest>(sess, body, SYNC_AAD_PUSH);
  let accepted = 0;
  for (const rec of req.items) {
    if (await applyRemoteRecord(rec)) accepted++;
  }
  const resp: SyncPushResponse = { sessionId: sess.id, accepted };
  return sess.sealJSON(resp, SYNC_AAD_PUSH);
}

interface SyncCommitRequest {
  sessionId: string;
  apply?: SyncItemRecord[];
  delete?: string[];
}

async function handleCommit(body: Uint8Array): Promise<Uint8Array> {
  const sess = requireSession();
  const req = openOr401<SyncCommitRequest>(sess, body, SYNC_AAD_COMMIT);
  let applied = 0;
  for (const rec of req.apply ?? []) {
    if (await applyRemoteRecord(rec)) applied++;
  }
  const resp = { sessionId: sess.id, applied, deleted: 0 };
  return sess.sealJSON(resp, SYNC_AAD_COMMIT);
}

/* ----------------------------------------------------------------------------
 * 冲突上报 / 决策轮询 —— 移植 Go handleReportConflictsServer / handlePollResolutionsServer
 * -------------------------------------------------------------------------- */

async function handleReportConflicts(body: Uint8Array): Promise<Uint8Array> {
  const sess = requireSession();
  const req = openOr401<SyncReportConflictsRequest>(
    sess,
    body,
    SYNC_AAD_REPORT_CONFLICTS,
  );
  const ui: ServerConflict[] = [];
  for (const rc of req.conflicts) {
    // 镜像反转：client 的 local 是本机视角的 remote，反之亦然
    const c: ServerConflict = {
      id: rc.id,
      kind: rc.kind as SyncConflict["kind"],
      local: null,
      remote: null,
      localManifest: rc.remoteManifest, // 本机 manifest
      remoteManifest: rc.localManifest, // 连入端 manifest
      suggestedRemote: !rc.suggestedRemote,
    };
    c.local = await safeGetItem(rc.id);
    if (rc.localPayload) {
      try {
        const payload = JSON.parse(
          utf8Decode(fromB64(rc.localPayload)),
        ) as ItemPayload;
        payload.id = rc.id;
        c.remote = payload;
      } catch {
        /* 对端 payload 不可解析：仅凭 manifest 决策 */
      }
    }
    ui.push(c);
  }
  conflicts = ui;
  status = "merge";
  progress = {
    stage: "merge",
    processed: 0,
    total: ui.length,
    message: `${ui.length} 项冲突待决`,
  };
  notify();

  const resp: SyncReportConflictsResponse = {
    sessionId: sess.id,
    accepted: ui.length,
  };
  return sess.sealJSON(resp, SYNC_AAD_REPORT_CONFLICTS);
}

async function handlePollResolutions(body: Uint8Array): Promise<Uint8Array> {
  const sess = requireSession();
  openOr401(sess, body, SYNC_AAD_POLL_RESOLUTIONS);
  const ready = pendingResolutions !== null;
  const actions = ready ? (pendingResolutions ?? []) : undefined;
  if (ready) pendingResolutions = null;
  const resp: SyncPollResolutionsResponse = {
    sessionId: sess.id,
    ready,
    actions,
  };
  return sess.sealJSON(resp, SYNC_AAD_POLL_RESOLUTIONS);
}

/* ----------------------------------------------------------------------------
 * 用户决策 + 应用 —— 移植 Go ResolveConflict / applyServerMerge
 * -------------------------------------------------------------------------- */

function resolveConflict(id: string, choice: ConflictChoice): void {
  const idx = conflicts.findIndex((c) => c.id === id);
  if (idx === -1) return;
  conflicts[idx] = { ...conflicts[idx], resolution: choice };
  notify();
}

async function safeGetItem(id: string): Promise<ItemPayload | null> {
  try {
    return await vaultService.getItem(id);
  } catch {
    return null;
  }
}

/** 本机该 id 当前是否为 tombstone（getItem 会过滤 tombstone，故直读 vault 文件） */
async function localRowIsTombstone(id: string): Promise<boolean> {
  const file = await readVaultFile();
  const row = file.items.find((r) => r.id === id);
  return !!row && typeof row.deletedAt === "number" && row.deletedAt > 0;
}

/**
 * 把本机用户在 UI 上的决策落地：写本机 vault + 生成 client 应用用的 action 列表。
 * 移植自 desktop applyServerMerge，决策→action 映射逐项对齐。
 */
async function applyMerge(): Promise<number> {
  const pendingChoice = conflicts.find((c) => !c.resolution);
  if (pendingChoice) {
    throw new Error("还有冲突未选择");
  }
  status = "applying";
  notify();

  let applied = 0;
  // bump 用的单调时间戳，须 > 两端 manifest，且与本机写入共用同一时钟
  const now = vaultService.nextTimestamp();
  const actions: SyncResolutionAction[] = [];

  for (const c of conflicts) {
    const choice = c.resolution ?? "skip";
    if (choice === "skip") {
      actions.push({ id: c.id, op: "noop" });
      continue;
    }

    if (choice === "local") {
      // 保留本机版本
      if (await localRowIsTombstone(c.id)) {
        // 本机是 tombstone：通知对端也删
        actions.push({ id: c.id, op: "delete" });
        applied++;
        continue;
      }
      const local = c.local ?? (await safeGetItem(c.id));
      if (!local) {
        actions.push({ id: c.id, op: "noop" });
        continue;
      }
      try {
        await vaultService.ingestForeignPayload(
          c.id,
          local,
          local.createdAt,
          now,
        );
      } catch {
        actions.push({ id: c.id, op: "noop" });
        continue;
      }
      const latest = (await safeGetItem(c.id)) ?? local;
      actions.push({
        id: c.id,
        op: "overwrite",
        payload: toB64(utf8(JSON.stringify(latest))),
        createdAt: latest.createdAt,
        updatedAt: now,
      });
      applied++;
      continue;
    }

    if (choice === "remote") {
      if (!c.remote) {
        // 对端是 tombstone：本机也删，对端不动
        try {
          await vaultService.deleteItem(c.id);
          applied++;
        } catch {
          /* ignore */
        }
        actions.push({ id: c.id, op: "noop" });
        continue;
      }
      const existing = await safeGetItem(c.id);
      const createdAt = existing?.createdAt ?? c.remote.createdAt;
      try {
        await vaultService.ingestForeignPayload(c.id, c.remote, createdAt, now);
      } catch {
        actions.push({ id: c.id, op: "noop" });
        continue;
      }
      const latest = (await safeGetItem(c.id)) ?? { ...c.remote, updatedAt: now };
      actions.push({
        id: c.id,
        op: "overwrite",
        payload: toB64(utf8(JSON.stringify(latest))),
        createdAt: latest.createdAt,
        updatedAt: now,
      });
      applied++;
      continue;
    }

    if (choice === "duplicate") {
      if (!c.remote) {
        actions.push({ id: c.id, op: "noop" });
        continue;
      }
      let created: ItemPayload;
      try {
        created = await vaultService.createItem(
          c.remote.type,
          c.remote.name,
          c.remote.fields,
        );
      } catch {
        actions.push({ id: c.id, op: "noop" });
        continue;
      }
      // 原 id 保持本机版本；额外创建一份 newId 副本承载对端版本
      const local = await safeGetItem(c.id);
      if (local) {
        actions.push({
          id: c.id,
          op: "overwrite",
          payload: toB64(utf8(JSON.stringify(local))),
          createdAt: local.createdAt,
          updatedAt: local.updatedAt,
        });
      }
      actions.push({
        id: c.id,
        op: "duplicate",
        payload: toB64(utf8(JSON.stringify(c.remote))),
        newId: created.id,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      });
      applied++;
    }
  }

  pendingResolutions = actions;
  conflicts = [];
  status = "done";
  progress = {
    stage: "done",
    processed: applied,
    total: applied,
  };
  notify();
  return applied;
}

/* ----------------------------------------------------------------------------
 * 工具
 * -------------------------------------------------------------------------- */

function generateNumericPin(digits: number): string {
  const raw = randomBytes(digits);
  let s = "";
  for (let i = 0; i < digits; i++) s += String(raw[i] % 10);
  return s;
}

/* ----------------------------------------------------------------------------
 * React hook
 * -------------------------------------------------------------------------- */

export interface SyncServerApi extends SyncServerSnapshot {
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;
  resolveConflict: (id: string, choice: ConflictChoice) => void;
  applyMerge: () => Promise<number>;
}

export function useSyncServer(): SyncServerApi {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snap,
    startServer,
    stopServer,
    resolveConflict,
    applyMerge,
  };
}

/** 非 React 调用方（如锁屏时强制停服）可直接用 */
export const syncServer = {
  startServer,
  stopServer,
  resolveConflict,
  applyMerge,
  getSnapshot,
  subscribe,
  isRunning: () => running,
};
