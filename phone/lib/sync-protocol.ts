// ZPass Phone —— LAN 同步协议（client 模式）
//
// 与 desktop/internal/services/syncservice.go 字节级一致：
//   - Argon2id 派生 session key（PSK 模式）
//   - XChaCha20-Poly1305 AEAD body
//   - 24-byte nonce = [dir(1)][rand(16)][counter(7-byte BE)]
//   - JSON body（双方用同一字段顺序的 Go struct / TS interface）
//
// phone 端只实现 client 角色（主动连 desktop 当 server）；future PR 可以加
// phone server。原因：
//   - phone 端在 RN 中起 HTTP server 需要额外 native 模块
//   - 用户已确认「冲突 UI 在 PC 端」—— phone 不需要展示冲突列表
//
// 流程：
//   1. POST /v1/pair { clientNonce } → { sessionId, salt, serverNonce }
//   2. argon2id(pin, salt||sid||cn||sn) → sessionKey (32B)
//   3. POST /v1/pair/confirm (AEAD body) → server confirm
//   4. POST /v1/sync/manifest → 对端 manifest
//   5. 客户端构建本端 manifest，跑 mergeManifests → plan
//   6. fetch / push（带进度回调）
//   7. 冲突清单返回给调用方；调用方在 UI 上展示给用户决策 → 调 ApplyMerge

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

import {
  fromB64,
  openAEAD,
  randomBytes,
  sealAEAD,
  toB64,
  utf8,
  utf8Decode,
} from "./crypto";
import {
  vaultService,
  type ItemPayload,
  type VaultItemType,
} from "./vault-service";
import {
  readVaultFile,
  type EncryptedItemRow,
} from "./vault-storage";

/* ----------------------------------------------------------------------------
 * 常量 —— 与 desktop syncservice.go 对齐
 * -------------------------------------------------------------------------- */

const SYNC_PROTO_VERSION = 1;
const SYNC_PSK_MEMORY_KIB = 8 * 1024;
const SYNC_PSK_ITERATIONS = 2;
const SYNC_PSK_PARALLELISM = 1;
const SYNC_PSK_KEY_LEN = 32;
const SYNC_SESSION_ID_LEN = 16;
const SYNC_PAIR_NONCE_LEN = 16;

const SYNC_DIR_SERVER = 0x01;
const SYNC_DIR_CLIENT = 0x02;

const SYNC_AAD_PAIR = utf8("zpass-sync:pair-confirm");
const SYNC_AAD_MANIFEST = utf8("zpass-sync:manifest");
const SYNC_AAD_FETCH = utf8("zpass-sync:fetch");
const SYNC_AAD_PUSH = utf8("zpass-sync:push");
const SYNC_AAD_COMMIT = utf8("zpass-sync:commit");
const SYNC_AAD_REPORT_CONFLICTS = utf8("zpass-sync:report-conflicts");
const SYNC_AAD_POLL_RESOLUTIONS = utf8("zpass-sync:poll-resolutions");

/** 轮询桌面端冲突解决的间隔（毫秒） */
const SYNC_POLL_INTERVAL_MS = 2000;
/** 最长等待桌面端用户决策的时间（毫秒）—— 30 分钟，与 syncSessionTimeout 对齐 */
const SYNC_POLL_TIMEOUT_MS = 30 * 60 * 1000;

const SYNC_DEFAULT_BATCH_SIZE = 50;

/* ----------------------------------------------------------------------------
 * Wire types —— 与 Go SyncPairResponse / SyncManifestEntry / SyncItemRecord 对齐
 * -------------------------------------------------------------------------- */

interface SyncPairRequest {
  clientNonce: string; // hex 16B
}

interface SyncPairResponse {
  protoVersion: number;
  sessionId: string; // hex 16B
  salt: string; // hex 16B
  serverNonce: string; // hex 16B
}

interface SyncPairConfirmRequest {
  confirm: string;
}

interface SyncPairConfirmResponse {
  confirm: string;
}

interface SyncManifestEntry {
  id: string;
  updatedAt: number;
  deletedAt?: number;
  contentHash?: string;
  revision?: number;
}

interface SyncManifestRequest {
  sessionId: string;
  role?: string;
}

interface SyncManifestResponse {
  protoVersion: number;
  sessionId: string;
  entries: SyncManifestEntry[];
  generatedAt: number;
}

interface SyncItemRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  ciphertext: string; // base64
}

interface SyncFetchRequest {
  sessionId: string;
  ids: string[];
  offset?: number;
  limit?: number;
}

interface SyncBatchResponse {
  sessionId: string;
  items: SyncItemRecord[];
  total: number;
  nextOffset?: number;
}

interface SyncPushRequest {
  sessionId: string;
  items: SyncItemRecord[];
}

interface SyncPushResponse {
  sessionId: string;
  accepted: number;
}

interface SyncReportedConflict {
  id: string;
  kind: string;
  suggestedRemote: boolean;
  localManifest: SyncManifestEntry;
  remoteManifest: SyncManifestEntry;
  /** base64(JSON(plaintext payload)) for the local-side item */
  localPayload?: string;
}

interface SyncReportConflictsRequest {
  sessionId: string;
  conflicts: SyncReportedConflict[];
}

interface SyncReportConflictsResponse {
  sessionId: string;
  accepted: number;
}

interface SyncResolutionAction {
  id: string;
  op: "noop" | "overwrite" | "delete" | "duplicate";
  payload?: string; // base64 JSON plaintext
  updatedAt?: number;
  createdAt?: number;
  newId?: string;
}

interface SyncPollResolutionsRequest {
  sessionId: string;
}

interface SyncPollResolutionsResponse {
  sessionId: string;
  ready: boolean;
  actions?: SyncResolutionAction[];
}

/* ----------------------------------------------------------------------------
 * Session
 * -------------------------------------------------------------------------- */

class SyncSession {
  readonly id: string;
  readonly sessionKey: Uint8Array;
  readonly role: "server" | "client";
  private sendCounter = 0n;
  private lastRecvCounter = 0n;

  constructor(id: string, sessionKey: Uint8Array, role: "server" | "client") {
    this.id = id;
    this.sessionKey = sessionKey;
    this.role = role;
  }

  private sendDir(): number {
    return this.role === "server" ? SYNC_DIR_SERVER : SYNC_DIR_CLIENT;
  }

  private recvDir(): number {
    return this.role === "server" ? SYNC_DIR_CLIENT : SYNC_DIR_SERVER;
  }

  private buildNonce(): Uint8Array {
    this.sendCounter += 1n;
    const counter = this.sendCounter;
    const rnd = randomBytes(16);
    const nonce = new Uint8Array(24);
    nonce[0] = this.sendDir();
    nonce.set(rnd, 1);
    // 7-byte BE counter at offset 17
    for (let i = 0; i < 7; i++) {
      nonce[17 + i] = Number((counter >> BigInt((6 - i) * 8)) & 0xffn);
    }
    return nonce;
  }

  sealJSON(payload: unknown, aad: Uint8Array): Uint8Array {
    // 用 sealAEAD 但替换为协议 nonce：sealAEAD 内部自己生成随机 nonce，
    // 我们需要协议定义的 nonce 格式（含 dir + counter），因此手写一遍。
    const plaintextBytes = utf8(JSON.stringify(payload));
    const nonce = this.buildNonce();
    const wrapped = sealAEADWithNonce(this.sessionKey, plaintextBytes, aad, nonce);
    const out = new Uint8Array(nonce.length + wrapped.length);
    out.set(nonce, 0);
    out.set(wrapped, nonce.length);
    return out;
  }

  openJSON<T>(frame: Uint8Array, aad: Uint8Array): T {
    if (frame.length < 24 + 16) {
      throw new SyncError("BAD_PROTOCOL", "frame too short");
    }
    const nonce = frame.subarray(0, 24);
    const ct = frame.subarray(24);
    if (nonce[0] !== this.recvDir()) {
      throw new SyncError("WRONG_DIRECTION", "direction mismatch");
    }
    let counter = 0n;
    for (let i = 0; i < 7; i++) {
      counter = (counter << 8n) | BigInt(nonce[17 + i]);
    }
    if (counter <= this.lastRecvCounter) {
      throw new SyncError("REPLAYED", "counter rollback");
    }
    let plain: Uint8Array;
    try {
      plain = openAEADWithNonce(this.sessionKey, ct, aad, nonce);
    } catch {
      throw new SyncError("AEAD_FAIL", "decryption failed");
    }
    this.lastRecvCounter = counter;
    return JSON.parse(utf8Decode(plain)) as T;
  }
}

/** 用协议 nonce 包装 sealAEAD —— 复用 lib/crypto.ts 但替换 nonce 来源 */
function sealAEADWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.encrypt(plaintext);
}

function openAEADWithNonce(
  key: Uint8Array,
  ct: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ct);
}

/* ----------------------------------------------------------------------------
 * 错误
 * -------------------------------------------------------------------------- */

export type SyncErrorCode =
  | "BAD_PROTOCOL"
  | "WRONG_DIRECTION"
  | "REPLAYED"
  | "AEAD_FAIL"
  | "PAIR_FAILED"
  | "PIN_LOCKED"
  | "NETWORK"
  | "BAD_RESPONSE";

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/* ----------------------------------------------------------------------------
 * 进度回调 + 冲突类型
 * -------------------------------------------------------------------------- */

export interface SyncProgress {
  stage:
    | "pairing"
    | "manifest"
    | "fetch"
    | "push"
    | "merge"
    | "commit"
    | "done";
  processed: number;
  total: number;
  message?: string;
}

export interface SyncConflict {
  id: string;
  kind: "concurrent_edit" | "divergent_content" | "delete_vs_edit";
  local: ItemPayload | null;
  remote: ItemPayload | null;
  localManifest: SyncManifestEntry;
  remoteManifest: SyncManifestEntry;
  suggestedRemote: boolean;
}

export interface SyncResult {
  applied: number;
  pushed: number;
  conflicts: SyncConflict[];
}

/* ----------------------------------------------------------------------------
 * 高阶 API
 * -------------------------------------------------------------------------- */

/**
 * 主动连接对端 sync server 并完成「拉 manifest + 自动合并 + 收集冲突」
 *
 * 返回的 conflicts 列表交给 UI；UI 不展示决策（按用户要求，phone 不做冲突
 * UI），phone 端会等待 desktop 端在 commit endpoint 推回最终决策。
 *
 * 实际上对于 phone 作为 client + desktop 作为 server 的场景，desktop 主动
 * 计算 plan 并展示冲突 UI；phone 只在 pair / 拉数据 / 等 push 阶段参与。
 *
 * 因此本函数在 phone 端被调用时主要做 server 端事先未做的部分：暴露本端
 * manifest 给 desktop（通过对端 manifest 拉取）—— 实际上对端 GET
 * /v1/sync/manifest 由 desktop 端发起到 phone 当 server 时才需要。
 *
 * 当前实现：把 phone 当成 client 连 desktop server 时，phone 把对端 vault
 * 完整 pull 下来覆盖本地（按 LWW 策略），冲突列表展示给用户但 phone 不
 * 做决策 UI —— 用户应当在 desktop 端解决冲突。
 *
 * 这意味着 phone 端 connect 时如果有冲突，应当在 UI 提示「请到 desktop
 * 端完成冲突解决」。
 */
export async function connectAndSync(
  baseUrl: string,
  pin: string,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  if (!vaultService.isUnlocked()) {
    throw new SyncError("PAIR_FAILED", "vault is locked");
  }
  baseUrl = baseUrl.replace(/\/+$/, "");

  // 1. Pair
  onProgress?.({ stage: "pairing", processed: 0, total: 1 });
  const clientNonce = randomBytes(SYNC_PAIR_NONCE_LEN);
  const pairReq: SyncPairRequest = { clientNonce: hexEncode(clientNonce) };
  const pairResp = await postJSON<SyncPairRequest, SyncPairResponse>(
    `${baseUrl}/v1/pair`,
    pairReq,
  );
  if (pairResp.protoVersion !== SYNC_PROTO_VERSION) {
    throw new SyncError("PAIR_FAILED", "proto version mismatch");
  }
  const saltBytes = hexDecode(pairResp.salt);
  const serverNonce = hexDecode(pairResp.serverNonce);
  const sessionKey = await deriveSyncSessionKey(
    pin,
    saltBytes,
    pairResp.sessionId,
    clientNonce,
    serverNonce,
  );
  const sess = new SyncSession(pairResp.sessionId, sessionKey, "client");

  // 2. Confirm
  const clientConfirm = await hmacSha256(sessionKey, "client:confirm");
  const confirmReq: SyncPairConfirmRequest = {
    confirm: hexEncode(clientConfirm),
  };
  const encryptedConfirm = sess.sealJSON(confirmReq, SYNC_AAD_PAIR);
  const confirmRespBytes = await postBinary(
    `${baseUrl}/v1/pair/confirm`,
    encryptedConfirm,
  );
  const confirmResp = sess.openJSON<SyncPairConfirmResponse>(
    confirmRespBytes,
    SYNC_AAD_PAIR,
  );
  const wantServerConfirm = await hmacSha256(sessionKey, "server:confirm");
  const gotServerConfirm = hexDecode(confirmResp.confirm);
  if (!constantTimeEqual(gotServerConfirm, wantServerConfirm)) {
    throw new SyncError("PAIR_FAILED", "server confirm mismatch");
  }

  // 3. Manifest
  onProgress?.({ stage: "manifest", processed: 0, total: 1 });
  const manReq: SyncManifestRequest = { sessionId: sess.id, role: "phone" };
  const encReq = sess.sealJSON(manReq, SYNC_AAD_MANIFEST);
  const manRespBytes = await postBinary(
    `${baseUrl}/v1/sync/manifest`,
    encReq,
  );
  const manResp = sess.openJSON<SyncManifestResponse>(
    manRespBytes,
    SYNC_AAD_MANIFEST,
  );

  // 4. Local manifest
  const localManifest = await buildLocalManifest();
  const plan = mergeManifests(localManifest, manResp.entries);

  // 5. Pull / Push
  let applied = 0;
  let pushed = 0;
  const pullIds = plan.pullApply
    .filter((s) => s.action !== "delete")
    .map((s) => s.id);
  if (pullIds.length > 0) {
    onProgress?.({ stage: "fetch", processed: 0, total: pullIds.length });
    for (let off = 0; off < pullIds.length; off += SYNC_DEFAULT_BATCH_SIZE) {
      const batch = pullIds.slice(off, off + SYNC_DEFAULT_BATCH_SIZE);
      const req: SyncFetchRequest = {
        sessionId: sess.id,
        ids: batch,
        offset: 0,
        limit: batch.length,
      };
      const encReq = sess.sealJSON(req, SYNC_AAD_FETCH);
      const respBytes = await postBinary(`${baseUrl}/v1/sync/fetch`, encReq);
      const resp = sess.openJSON<SyncBatchResponse>(respBytes, SYNC_AAD_FETCH);
      for (const rec of resp.items) {
        if (await applyRemoteRecord(rec)) applied++;
      }
      onProgress?.({
        stage: "fetch",
        processed: Math.min(off + batch.length, pullIds.length),
        total: pullIds.length,
      });
    }
  }
  // pull deletes
  for (const step of plan.pullApply) {
    if (step.action === "delete") {
      try {
        await vaultService.deleteItem(step.id);
        applied++;
      } catch {
        /* ignore */
      }
    }
  }

  // 6. Push (本端独有 / 较新)
  const pushRecords: SyncItemRecord[] = [];
  for (const step of plan.push) {
    const rec = await buildRecordFromLocal(step.id);
    if (rec) pushRecords.push(rec);
  }
  if (pushRecords.length > 0) {
    onProgress?.({ stage: "push", processed: 0, total: pushRecords.length });
    for (let off = 0; off < pushRecords.length; off += SYNC_DEFAULT_BATCH_SIZE) {
      const batch = pushRecords.slice(off, off + SYNC_DEFAULT_BATCH_SIZE);
      const req: SyncPushRequest = { sessionId: sess.id, items: batch };
      const encReq = sess.sealJSON(req, SYNC_AAD_PUSH);
      const respBytes = await postBinary(`${baseUrl}/v1/sync/push`, encReq);
      const resp = sess.openJSON<SyncPushResponse>(respBytes, SYNC_AAD_PUSH);
      pushed += resp.accepted;
      onProgress?.({
        stage: "push",
        processed: Math.min(off + batch.length, pushRecords.length),
        total: pushRecords.length,
      });
    }
  }

  // 7. 收集冲突 + 把每条 local plaintext 推给 desktop server，让 desktop UI
  //    （轮询 GetStatus）能看到完整冲突清单并让用户决策。phone 端不做 UI。
  const conflicts: SyncConflict[] = [];
  const reported: SyncReportedConflict[] = [];
  for (const c of plan.conflicts) {
    const local = await safeGetLocalPayload(c.id);
    let remote: ItemPayload | null = null;
    try {
      const records = await fetchRemoteRecords(baseUrl, sess, [c.id]);
      if (records.length > 0) {
        remote = await decryptRemoteRecord(records[0]);
      }
    } catch {
      /* ignore */
    }
    conflicts.push({
      id: c.id,
      kind: c.kind,
      local,
      remote,
      localManifest: c.local,
      remoteManifest: c.remote,
      suggestedRemote: c.suggestedRemote,
    });
    let localPayloadB64 = "";
    if (local) {
      try {
        localPayloadB64 = toB64(utf8(JSON.stringify(local)));
      } catch {
        /* leave empty */
      }
    }
    reported.push({
      id: c.id,
      kind: c.kind,
      suggestedRemote: c.suggestedRemote,
      localManifest: c.local,
      remoteManifest: c.remote,
      localPayload: localPayloadB64 || undefined,
    });
  }

  let conflictsResolved = false;
  if (reported.length > 0) {
    onProgress?.({
      stage: "merge",
      processed: 0,
      total: reported.length,
      message: "等待桌面端解决冲突",
    });
    try {
      const req: SyncReportConflictsRequest = {
        sessionId: sess.id,
        conflicts: reported,
      };
      const encReq = sess.sealJSON(req, SYNC_AAD_REPORT_CONFLICTS);
      const respBytes = await postBinary(
        `${baseUrl}/v1/sync/report-conflicts`,
        encReq,
      );
      sess.openJSON<SyncReportConflictsResponse>(
        respBytes,
        SYNC_AAD_REPORT_CONFLICTS,
      );
    } catch (e) {
      console.warn("[sync] report conflicts failed:", e);
    }
    // 轮询直到桌面端用户解决完，拿到 action plan 应用本端
    const result = await waitAndApplyResolutions(
      baseUrl,
      sess,
      reported.length,
      onProgress,
    );
    applied += result.applied;
    conflictsResolved = result.resolved;
  }

  onProgress?.({
    stage: "done",
    processed: applied + pushed,
    total: applied + pushed,
    message: undefined,
  });
  // 冲突已经被桌面端决策并 push 给 phone 应用了 —— UI result 卡片不应再
  // 显示"N 项冲突待解决"，把 conflicts 数组清空。如果轮询超时未解决，保留
  // 原 conflicts 让 UI 提示用户去桌面端继续。
  return {
    applied,
    pushed,
    conflicts: conflictsResolved ? [] : conflicts,
  };
}

/** 轮询桌面端冲突决策；拿到 actions 后应用到本端 vault。 */
async function waitAndApplyResolutions(
  baseUrl: string,
  sess: SyncSession,
  totalConflicts: number,
  onProgress?: (p: SyncProgress) => void,
): Promise<{ applied: number; resolved: boolean }> {
  const deadline = Date.now() + SYNC_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const req: SyncPollResolutionsRequest = { sessionId: sess.id };
      const encReq = sess.sealJSON(req, SYNC_AAD_POLL_RESOLUTIONS);
      const respBytes = await postBinary(
        `${baseUrl}/v1/sync/poll-resolutions`,
        encReq,
      );
      const resp = sess.openJSON<SyncPollResolutionsResponse>(
        respBytes,
        SYNC_AAD_POLL_RESOLUTIONS,
      );
      if (!resp.ready) {
        onProgress?.({
          stage: "merge",
          processed: 0,
          total: totalConflicts,
          message: "等待桌面端解决冲突…",
        });
        await sleep(SYNC_POLL_INTERVAL_MS);
        continue;
      }
      const actions = resp.actions ?? [];
      onProgress?.({
        stage: "commit",
        processed: 0,
        total: actions.length,
        message: "应用桌面端决策",
      });
      let appliedCount = 0;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        if (await applyResolutionAction(a)) {
          appliedCount++;
        }
        onProgress?.({
          stage: "commit",
          processed: i + 1,
          total: actions.length,
        });
      }
      return { applied: appliedCount, resolved: true };
    } catch (e) {
      console.warn("[sync] poll-resolutions failed:", e);
      await sleep(SYNC_POLL_INTERVAL_MS);
    }
  }
  console.warn("[sync] wait for resolutions timed out");
  return { applied: 0, resolved: false };
}

async function applyResolutionAction(
  a: SyncResolutionAction,
): Promise<boolean> {
  switch (a.op) {
    case "noop":
      return true;
    case "delete":
      try {
        await vaultService.deleteItem(a.id);
        return true;
      } catch (e) {
        console.warn(`[sync] apply delete ${a.id} failed:`, e);
        return false;
      }
    case "overwrite": {
      if (!a.payload) return false;
      try {
        const bytes = fromB64(a.payload);
        const payload = JSON.parse(utf8Decode(bytes)) as ItemPayload;
        const updatedAt = a.updatedAt ?? payload.updatedAt;
        const createdAt = a.createdAt ?? payload.createdAt;
        // 强制覆盖：用 desktop 端时间戳，绕过本端 LWW 防止 phone 端"较新"
        // 的旧版本不被覆盖。手段：先 deleteItem 把本端记录推进，再 ingest。
        // 但 ingestForeignPayload 自带 LWW；这里 desktop 已经 bump 过 updatedAt
        // 之类不必要 —— "local" 决策保留 desktop 的原 updatedAt，phone 端
        // updatedAt 与 desktop 一致即可避免循环冲突。
        await vaultService.ingestForeignPayload(
          a.id,
          payload,
          createdAt,
          updatedAt,
        );
        return true;
      } catch (e) {
        console.warn(`[sync] apply overwrite ${a.id} failed:`, e);
        return false;
      }
    }
    case "duplicate": {
      if (!a.payload || !a.newId) return false;
      try {
        const bytes = fromB64(a.payload);
        const payload = JSON.parse(utf8Decode(bytes)) as ItemPayload;
        const createdAt = a.createdAt ?? payload.createdAt;
        const updatedAt = a.updatedAt ?? payload.updatedAt;
        // 使用 desktop 生成的 newId 在本端创建副本（保持跨端 id 一致）
        await vaultService.ingestForeignPayload(
          a.newId,
          payload,
          createdAt,
          updatedAt,
        );
        return true;
      } catch (e) {
        console.warn(`[sync] apply duplicate ${a.id}→${a.newId} failed:`, e);
        return false;
      }
    }
    default:
      console.warn(`[sync] unknown action op: ${a.op}`);
      return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ----------------------------------------------------------------------------
 * Manifest / record helpers
 * -------------------------------------------------------------------------- */

async function buildLocalManifest(): Promise<SyncManifestEntry[]> {
  const file = await readVaultFile();
  const out: SyncManifestEntry[] = [];
  for (const row of file.items) {
    const entry: SyncManifestEntry = {
      id: row.id,
      updatedAt: row.updatedAt,
    };
    if (typeof row.deletedAt === "number" && row.deletedAt > 0) {
      entry.deletedAt = row.deletedAt;
    }
    // 解密以拿 contentHash / revision —— vaultService.getItem 过滤了
    // tombstone 会返回 null，所以这里走 readVaultFile + 直接解密。
    // 简化：复用 vault-service.ts 没有 export 的解密能力，我们通过
    // getItem 拿到（已过滤 tombstone）；对 tombstone 的 hash 没意义。
    if (!entry.deletedAt) {
      const payload = await vaultService.getItem(row.id);
      if (payload) {
        entry.contentHash = await contentHashOf(payload);
        if (typeof payload.revision === "number") {
          entry.revision = payload.revision;
        }
      }
    }
    out.push(entry);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

async function safeGetLocalPayload(id: string): Promise<ItemPayload | null> {
  try {
    return await vaultService.getItem(id);
  } catch {
    return null;
  }
}

async function buildRecordFromLocal(id: string): Promise<SyncItemRecord | null> {
  const file = await readVaultFile();
  const row = file.items.find((r) => r.id === id);
  if (!row) return null;
  const rec: SyncItemRecord = {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ciphertext: toB64(row.payload),
  };
  if (typeof row.deletedAt === "number" && row.deletedAt > 0) {
    rec.deletedAt = row.deletedAt;
  }
  return rec;
}

async function applyRemoteRecord(rec: SyncItemRecord): Promise<boolean> {
  // 两端 vault 独立 DEK：wire 上 rec.ciphertext 字段实际是 base64(JSON(plaintext payload))。
  // 解析后用本端 vault 路径重新加密落盘。
  if (rec.deletedAt && rec.deletedAt > 0) {
    try {
      await vaultService.deleteItem(rec.id);
      return true;
    } catch (e) {
      console.warn(`[sync] deleteItem(${rec.id}) failed:`, e);
      return false;
    }
  }
  if (!rec.ciphertext) {
    console.warn(`[sync] rec ${rec.id} has empty ciphertext but no deletedAt`);
    return false;
  }
  try {
    const plaintextBytes = fromB64(rec.ciphertext);
    const payload = JSON.parse(utf8Decode(plaintextBytes)) as ItemPayload;
    const result = await vaultService.ingestForeignPayload(
      rec.id,
      payload,
      rec.createdAt,
      rec.updatedAt,
    );
    console.log(
      `[sync] ingest ${rec.id} (${payload.type}, ${payload.name}) → ${result}`,
    );
    return result !== "skipped";
  } catch (e) {
    console.warn(`[sync] ingest ${rec.id} failed:`, e);
    return false;
  }
}

async function decryptRemoteRecord(rec: SyncItemRecord): Promise<ItemPayload | null> {
  // 命名是历史遗留 —— wire 上 rec.ciphertext 实际是 plaintext bytes（外层 session AEAD 保护）。
  if (!rec.ciphertext) return null;
  try {
    const plaintextBytes = fromB64(rec.ciphertext);
    const payload = JSON.parse(utf8Decode(plaintextBytes)) as ItemPayload;
    payload.id = rec.id;
    if (rec.deletedAt && rec.deletedAt > 0) payload.deletedAt = rec.deletedAt;
    return payload;
  } catch {
    return null;
  }
}

async function fetchRemoteRecords(
  baseUrl: string,
  sess: SyncSession,
  ids: string[],
): Promise<SyncItemRecord[]> {
  if (ids.length === 0) return [];
  const out: SyncItemRecord[] = [];
  for (let off = 0; off < ids.length; off += SYNC_DEFAULT_BATCH_SIZE) {
    const batch = ids.slice(off, off + SYNC_DEFAULT_BATCH_SIZE);
    const req: SyncFetchRequest = {
      sessionId: sess.id,
      ids: batch,
      offset: 0,
      limit: batch.length,
    };
    const encReq = sess.sealJSON(req, SYNC_AAD_FETCH);
    const respBytes = await postBinary(`${baseUrl}/v1/sync/fetch`, encReq);
    const resp = sess.openJSON<SyncBatchResponse>(respBytes, SYNC_AAD_FETCH);
    out.push(...resp.items);
  }
  return out;
}

async function contentHashOf(p: ItemPayload): Promise<string> {
  // 必须与 desktop/internal/services/syncservice.go:contentHashOf 字节级对齐：
  //   - 顶层 + 内嵌对象都按 key 字典序输出（stableStringify 递归 sort）
  //   - 不做 HTMLEscape（与 desktop 端 SetEscapeHTML(false) 配合）
  //   - 仅 hash type / name / fields，不含其它元数据字段
  const stable = {
    type: p.type,
    name: p.name,
    fields: p.fields ?? {},
  };
  const bytes = utf8(stableStringify(stable));
  const hash = await sha256(bytes);
  return hexEncode(hash.subarray(0, 16));
}

/**
 * stableStringify 模拟 Go 的 `json.Marshal(map[string]any)` —— 按 key 字典序
 * 递归输出，**不**做 HTMLEscape。跨端 hash 必须用这个而非 JSON.stringify。
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // 跳过 undefined 字段以匹配 JSON.stringify / Go json.Marshal 行为
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

/* ----------------------------------------------------------------------------
 * Merge algorithm —— 与 desktop mergeManifests 一致
 * -------------------------------------------------------------------------- */

interface MergeStep {
  id: string;
  action: "insert" | "replace" | "delete";
}

interface MergeConflict {
  id: string;
  kind: "concurrent_edit" | "divergent_content" | "delete_vs_edit";
  local: SyncManifestEntry;
  remote: SyncManifestEntry;
  suggestedRemote: boolean;
}

interface MergePlan {
  pullApply: MergeStep[];
  push: MergeStep[];
  conflicts: MergeConflict[];
  identical: string[];
}

function mergeManifests(
  local: SyncManifestEntry[],
  remote: SyncManifestEntry[],
): MergePlan {
  const plan: MergePlan = {
    pullApply: [],
    push: [],
    conflicts: [],
    identical: [],
  };
  const localMap = new Map<string, SyncManifestEntry>();
  for (const e of local) localMap.set(e.id, e);
  const remoteMap = new Map<string, SyncManifestEntry>();
  for (const e of remote) remoteMap.set(e.id, e);

  for (const r of remote) {
    const l = localMap.get(r.id);
    if (!l) {
      if (!r.deletedAt || r.deletedAt === 0) {
        plan.pullApply.push({ id: r.id, action: "insert" });
      }
      continue;
    }
    decideBoth(l, r, plan);
  }
  for (const l of local) {
    if (!remoteMap.has(l.id)) {
      plan.push.push({ id: l.id, action: "insert" });
    }
  }
  return plan;
}

function decideBoth(
  local: SyncManifestEntry,
  remote: SyncManifestEntry,
  plan: MergePlan,
) {
  const sameTS = local.updatedAt === remote.updatedAt;
  const sameHash =
    !!local.contentHash &&
    !!remote.contentHash &&
    local.contentHash === remote.contentHash;
  if (sameTS && sameHash) {
    plan.identical.push(local.id);
    return;
  }
  const localDel = (local.deletedAt ?? 0) > 0;
  const remoteDel = (remote.deletedAt ?? 0) > 0;
  // 双方都已删 → identical（不要求 sameTS：两端 deleteItem 各自取本端 nowMs，
  // tombstone 的 updatedAt 几乎必然不同；不在这里 identical 会被误判为 divergent_content）
  if (localDel && remoteDel) {
    plan.identical.push(local.id);
    return;
  }
  if (localDel !== remoteDel) {
    plan.conflicts.push({
      id: local.id,
      kind: "delete_vs_edit",
      local,
      remote,
      suggestedRemote: remote.updatedAt > local.updatedAt,
    });
    return;
  }
  if (sameTS) {
    plan.conflicts.push({
      id: local.id,
      kind: "concurrent_edit",
      local,
      remote,
      suggestedRemote: (remote.revision ?? 0) > (local.revision ?? 0),
    });
    return;
  }
  if (sameHash) {
    if (remote.updatedAt > local.updatedAt) {
      plan.pullApply.push({
        id: local.id,
        action: remoteDel ? "delete" : "replace",
      });
    } else {
      plan.push.push({
        id: local.id,
        action: localDel ? "delete" : "replace",
      });
    }
    return;
  }
  plan.conflicts.push({
    id: local.id,
    kind: "divergent_content",
    local,
    remote,
    suggestedRemote: remote.updatedAt > local.updatedAt,
  });
}

/* ----------------------------------------------------------------------------
 * Crypto helpers
 * -------------------------------------------------------------------------- */

async function deriveSyncSessionKey(
  pin: string,
  salt: Uint8Array,
  sessionId: string,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
): Promise<Uint8Array> {
  const sidBytes = hexDecode(sessionId);
  const combined = new Uint8Array(
    salt.length + sidBytes.length + clientNonce.length + serverNonce.length,
  );
  combined.set(salt, 0);
  combined.set(sidBytes, salt.length);
  combined.set(clientNonce, salt.length + sidBytes.length);
  combined.set(
    serverNonce,
    salt.length + sidBytes.length + clientNonce.length,
  );
  // 不走 hash-wasm：Hermes 不暴露 WebAssembly 全局，会直接抛
  // 「WebAssembly is not supported in this environment」。也不走 nativeDeriveKEK：
  // cryptocore::derive_kek 强校验 salt.len() == 32，64 字节 sync salt 会被拒。
  // 用 @noble/hashes 纯 JS：Hermes 完全兼容，配对是一次性操作（数秒），可接受。
  return nobleArgon2id(pin, combined, {
    m: SYNC_PSK_MEMORY_KIB,
    t: SYNC_PSK_ITERATIONS,
    p: SYNC_PSK_PARALLELISM,
    dkLen: SYNC_PSK_KEY_LEN,
  });
}

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  return hmac(nobleSha256, key, utf8(message));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return nobleSha256(data);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let v = 0;
  for (let i = 0; i < a.length; i++) v |= a[i] ^ b[i];
  return v === 0;
}

function hexEncode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new SyncError("BAD_RESPONSE", "bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * HTTP helpers
 * -------------------------------------------------------------------------- */

async function postJSON<I, O>(url: string, body: I): Promise<O> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 429) {
      throw new SyncError("PIN_LOCKED", text || "pin locked");
    }
    throw new SyncError("NETWORK", `status ${resp.status}: ${text}`);
  }
  return (await resp.json()) as O;
}

async function postBinary(url: string, body: Uint8Array): Promise<Uint8Array> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: body as BodyInit,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new SyncError("NETWORK", `status ${resp.status}: ${text}`);
  }
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

/* ----------------------------------------------------------------------------
 * QR helpers
 * -------------------------------------------------------------------------- */

/** 解析 `zpass-sync://host:port?pin=xxxxxx` */
export function parseSyncQRPayload(
  payload: string,
): { baseUrl: string; pin: string } | null {
  try {
    const url = new URL(payload.replace(/^zpass-sync:\/\//, "http://"));
    const pin = url.searchParams.get("pin");
    if (!pin) return null;
    return { baseUrl: `http://${url.host}`, pin };
  } catch {
    return null;
  }
}
