// ZPass HarmonyOS —— LAN 同步协议（client 模式）
//
// 与 phone/lib/sync-protocol.ts 行为对齐；与 desktop/internal/services/syncservice.go
// 字节级一致：
//   - Argon2id 派生 session key（PSK 模式）
//   - XChaCha20-Poly1305 AEAD body
//   - 24-byte nonce = [dir(1)][rand(16)][counter(7-byte BE)]
//   - JSON body（双方用同一字段顺序的 Go struct / ArkTS interface）
//   - HMAC-SHA256 pair confirm tag
//   - SHA-256 contentHash
//
// 鸿蒙端仅实现 client 角色（主动连 desktop 当 server）。原因同 phone：
//   - 鸿蒙端起 HTTP server 需要额外 native 模块
//   - 用户已确认「冲突 UI 在 PC 端」—— 鸿蒙不需要展示冲突列表
//
// 流程：
//   1. POST /v1/pair { clientNonce } → { sessionId, salt, serverNonce }
//   2. argon2idRaw(pin, salt||sid||cn||sn) → sessionKey (32B)
//   3. POST /v1/pair/confirm (AEAD body) → server confirm
//   4. POST /v1/sync/manifest → 对端 manifest
//   5. 本端 manifest + mergeManifests → plan
//   6. fetch / push（分批进度回调）
//   7. report-conflicts + 轮询 poll-resolutions 等桌面端用户决策

import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  fromB64,
  toB64,
  utf8,
  utf8Decode,
} from './Crypto';
import {
  argon2idRaw,
  openAeadWithNonce,
  randomBytes,
  sealAeadWithNonce,
} from './RustCryptoCore';
import {
  vaultService,
  type ItemPayload,
} from './VaultService';
import {
  readVaultFile,
  type EncryptedItemRow,
} from './VaultStorage';

/* ----------------------------------------------------------------------------
 * 常量 —— 与 desktop syncservice.go / phone sync-protocol.ts 对齐
 * -------------------------------------------------------------------------- */

const SYNC_PROTO_VERSION: number = 1;
const SYNC_PSK_MEMORY_KIB: number = 8 * 1024;
const SYNC_PSK_ITERATIONS: number = 2;
const SYNC_PSK_PARALLELISM: number = 1;
const SYNC_PSK_KEY_LEN: number = 32;
const SYNC_SESSION_ID_LEN: number = 16;
const SYNC_PAIR_NONCE_LEN: number = 16;

const SYNC_DIR_SERVER: number = 0x01;
const SYNC_DIR_CLIENT: number = 0x02;

const SYNC_AAD_PAIR: Uint8Array = utf8('zpass-sync:pair-confirm');
const SYNC_AAD_MANIFEST: Uint8Array = utf8('zpass-sync:manifest');
const SYNC_AAD_FETCH: Uint8Array = utf8('zpass-sync:fetch');
const SYNC_AAD_PUSH: Uint8Array = utf8('zpass-sync:push');
const SYNC_AAD_REPORT_CONFLICTS: Uint8Array = utf8('zpass-sync:report-conflicts');
const SYNC_AAD_POLL_RESOLUTIONS: Uint8Array = utf8('zpass-sync:poll-resolutions');

/** 轮询桌面端冲突解决的间隔（毫秒） */
const SYNC_POLL_INTERVAL_MS: number = 2_000;
/** 最长等待桌面端用户决策的时间（毫秒）—— 30 分钟，与 syncSessionTimeout 对齐 */
const SYNC_POLL_TIMEOUT_MS: number = 30 * 60 * 1_000;

const SYNC_DEFAULT_BATCH_SIZE: number = 50;

/* ----------------------------------------------------------------------------
 * Wire types —— 与 Go / phone 一一对应
 * -------------------------------------------------------------------------- */

interface SyncPairRequest {
  clientNonce: string;
}

interface SyncPairResponse {
  protoVersion: number;
  sessionId: string;
  salt: string;
  serverNonce: string;
}

interface SyncPairConfirmRequest {
  confirm: string;
}

interface SyncPairConfirmResponse {
  confirm: string;
}

export interface SyncManifestEntry {
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
  /** wire 上是 base64(JSON(plaintext payload))，命名是历史遗留 */
  ciphertext: string;
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
  op: string;
  payload?: string;
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
 * 错误
 * -------------------------------------------------------------------------- */

export type SyncErrorCode =
  | 'BAD_PROTOCOL'
  | 'WRONG_DIRECTION'
  | 'REPLAYED'
  | 'AEAD_FAIL'
  | 'PAIR_FAILED'
  | 'PIN_LOCKED'
  | 'NETWORK'
  | 'BAD_RESPONSE';

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/* ----------------------------------------------------------------------------
 * Session —— 与 phone SyncSession 一致
 * -------------------------------------------------------------------------- */

class SyncSession {
  readonly id: string;
  readonly sessionKey: Uint8Array;
  /** 'server' 或 'client'；鸿蒙端固定 'client' */
  readonly role: string;
  private sendCounter: bigint = 0n;
  private lastRecvCounter: bigint = 0n;

  constructor(id: string, sessionKey: Uint8Array, role: string) {
    this.id = id;
    this.sessionKey = sessionKey;
    this.role = role;
  }

  private sendDir(): number {
    return this.role === 'server' ? SYNC_DIR_SERVER : SYNC_DIR_CLIENT;
  }

  private recvDir(): number {
    return this.role === 'server' ? SYNC_DIR_CLIENT : SYNC_DIR_SERVER;
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

  sealJSON(payload: Object, aad: Uint8Array): Uint8Array {
    const plaintextBytes = utf8(JSON.stringify(payload));
    const nonce = this.buildNonce();
    const ct = sealAeadWithNonce(this.sessionKey, plaintextBytes, aad, nonce);
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce, 0);
    out.set(ct, nonce.length);
    return out;
  }

  openJSON<T>(frame: Uint8Array, aad: Uint8Array): T {
    if (frame.length < 24 + 16) {
      throw new SyncError('BAD_PROTOCOL', 'frame too short');
    }
    const nonce = frame.subarray(0, 24);
    const ct = frame.subarray(24);
    if (nonce[0] !== this.recvDir()) {
      throw new SyncError('WRONG_DIRECTION', 'direction mismatch');
    }
    let counter: bigint = 0n;
    for (let i = 0; i < 7; i++) {
      counter = (counter << 8n) | BigInt(nonce[17 + i]);
    }
    if (counter <= this.lastRecvCounter) {
      throw new SyncError('REPLAYED', 'counter rollback');
    }
    let plain: Uint8Array;
    try {
      plain = openAeadWithNonce(this.sessionKey, ct, aad, nonce);
    } catch (_e) {
      throw new SyncError('AEAD_FAIL', 'decryption failed');
    }
    this.lastRecvCounter = counter;
    return JSON.parse(utf8Decode(plain)) as T;
  }
}

/* ----------------------------------------------------------------------------
 * 进度回调 + 冲突
 * -------------------------------------------------------------------------- */

export type SyncStage =
  | 'pairing'
  | 'manifest'
  | 'fetch'
  | 'push'
  | 'merge'
  | 'commit'
  | 'done';

export interface SyncProgress {
  stage: SyncStage;
  processed: number;
  total: number;
  message?: string;
}

export type SyncConflictKind = 'concurrent_edit' | 'divergent_content' | 'delete_vs_edit';

export interface SyncConflict {
  id: string;
  kind: SyncConflictKind;
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
 * 主流程：connectAndSync
 * -------------------------------------------------------------------------- */

export async function connectAndSync(
  baseUrl: string,
  pin: string,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  if (!vaultService.isUnlocked()) {
    throw new SyncError('PAIR_FAILED', 'vault is locked');
  }
  baseUrl = baseUrl.replace(/\/+$/, '');

  // 1. Pair
  if (onProgress) onProgress({ stage: 'pairing', processed: 0, total: 1 });
  const clientNonce = randomBytes(SYNC_PAIR_NONCE_LEN);
  const pairReq: SyncPairRequest = { clientNonce: hexEncode(clientNonce) };
  const pairResp = await postJSON<SyncPairRequest, SyncPairResponse>(
    `${baseUrl}/v1/pair`,
    pairReq,
  );
  if (pairResp.protoVersion !== SYNC_PROTO_VERSION) {
    throw new SyncError('PAIR_FAILED', 'proto version mismatch');
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
  const sess = new SyncSession(pairResp.sessionId, sessionKey, 'client');

  // 2. Confirm
  const clientConfirm = await hmacSha256(sessionKey, utf8('client:confirm'));
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
  const wantServerConfirm = await hmacSha256(sessionKey, utf8('server:confirm'));
  const gotServerConfirm = hexDecode(confirmResp.confirm);
  if (!constantTimeEqual(gotServerConfirm, wantServerConfirm)) {
    throw new SyncError('PAIR_FAILED', 'server confirm mismatch');
  }

  // 3. Manifest
  if (onProgress) onProgress({ stage: 'manifest', processed: 0, total: 1 });
  const manReq: SyncManifestRequest = { sessionId: sess.id, role: 'phone' };
  const encReq = sess.sealJSON(manReq, SYNC_AAD_MANIFEST);
  const manRespBytes = await postBinary(
    `${baseUrl}/v1/sync/manifest`,
    encReq,
  );
  const manResp = sess.openJSON<SyncManifestResponse>(
    manRespBytes,
    SYNC_AAD_MANIFEST,
  );

  // 4. Local manifest + 合并
  const localManifest = await buildLocalManifest();
  const plan = mergeManifests(localManifest, manResp.entries);

  // 5. Pull / Push
  let applied = 0;
  let pushed = 0;
  const pullIds: string[] = plan.pullApply
    .filter((s) => s.action !== 'delete')
    .map((s) => s.id);
  if (pullIds.length > 0) {
    if (onProgress) onProgress({ stage: 'fetch', processed: 0, total: pullIds.length });
    for (let off = 0; off < pullIds.length; off += SYNC_DEFAULT_BATCH_SIZE) {
      const batch = pullIds.slice(off, off + SYNC_DEFAULT_BATCH_SIZE);
      const req: SyncFetchRequest = {
        sessionId: sess.id,
        ids: batch,
        offset: 0,
        limit: batch.length,
      };
      const enc = sess.sealJSON(req, SYNC_AAD_FETCH);
      const respBytes = await postBinary(`${baseUrl}/v1/sync/fetch`, enc);
      const resp = sess.openJSON<SyncBatchResponse>(respBytes, SYNC_AAD_FETCH);
      for (const rec of resp.items) {
        if (await applyRemoteRecord(rec)) applied++;
      }
      if (onProgress) {
        onProgress({
          stage: 'fetch',
          processed: Math.min(off + batch.length, pullIds.length),
          total: pullIds.length,
        });
      }
    }
  }
  // pull deletes
  for (const step of plan.pullApply) {
    if (step.action === 'delete') {
      try {
        await vaultService.deleteItem(step.id);
        applied++;
      } catch (_e) {
        // 忽略：可能本端已无此条目
      }
    }
  }

  // 6. Push（本端独有 / 较新）
  const pushRecords: SyncItemRecord[] = [];
  for (const step of plan.push) {
    const rec = await buildRecordFromLocal(step.id);
    if (rec) pushRecords.push(rec);
  }
  if (pushRecords.length > 0) {
    if (onProgress) onProgress({ stage: 'push', processed: 0, total: pushRecords.length });
    for (let off = 0; off < pushRecords.length; off += SYNC_DEFAULT_BATCH_SIZE) {
      const batch = pushRecords.slice(off, off + SYNC_DEFAULT_BATCH_SIZE);
      const req: SyncPushRequest = { sessionId: sess.id, items: batch };
      const enc = sess.sealJSON(req, SYNC_AAD_PUSH);
      const respBytes = await postBinary(`${baseUrl}/v1/sync/push`, enc);
      const resp = sess.openJSON<SyncPushResponse>(respBytes, SYNC_AAD_PUSH);
      pushed += resp.accepted;
      if (onProgress) {
        onProgress({
          stage: 'push',
          processed: Math.min(off + batch.length, pushRecords.length),
          total: pushRecords.length,
        });
      }
    }
  }

  // 7. 报告冲突 + 等待桌面端用户决策
  const conflicts: SyncConflict[] = [];
  const reported: SyncReportedConflict[] = [];
  for (const c of plan.conflicts) {
    const local = await safeGetLocalPayload(c.id);
    let remote: ItemPayload | null = null;
    try {
      const records = await fetchRemoteRecords(baseUrl, sess, [c.id]);
      if (records.length > 0) {
        remote = decryptRemoteRecord(records[0]);
      }
    } catch (_e) {
      // 忽略：拉取失败不阻塞冲突列表
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
    let localPayloadB64 = '';
    if (local) {
      try {
        localPayloadB64 = toB64(utf8(JSON.stringify(local)));
      } catch (_e) {
        // 留空，桌面端会按 manifest 走
      }
    }
    const reportedItem: SyncReportedConflict = {
      id: c.id,
      kind: c.kind,
      suggestedRemote: c.suggestedRemote,
      localManifest: c.local,
      remoteManifest: c.remote,
    };
    if (localPayloadB64) reportedItem.localPayload = localPayloadB64;
    reported.push(reportedItem);
  }

  let conflictsResolved = false;
  if (reported.length > 0) {
    if (onProgress) {
      onProgress({
        stage: 'merge',
        processed: 0,
        total: reported.length,
        message: '等待桌面端解决冲突',
      });
    }
    try {
      const req: SyncReportConflictsRequest = {
        sessionId: sess.id,
        conflicts: reported,
      };
      const enc = sess.sealJSON(req, SYNC_AAD_REPORT_CONFLICTS);
      const respBytes = await postBinary(
        `${baseUrl}/v1/sync/report-conflicts`,
        enc,
      );
      sess.openJSON<SyncReportConflictsResponse>(respBytes, SYNC_AAD_REPORT_CONFLICTS);
    } catch (_e) {
      // 上报冲突失败不阻塞后续轮询
    }
    const result = await waitAndApplyResolutions(
      baseUrl,
      sess,
      reported.length,
      onProgress,
    );
    applied += result.applied;
    conflictsResolved = result.resolved;
  }

  if (onProgress) {
    onProgress({
      stage: 'done',
      processed: applied + pushed,
      total: applied + pushed,
    });
  }
  return {
    applied,
    pushed,
    conflicts: conflictsResolved ? [] : conflicts,
  };
}

async function waitAndApplyResolutions(
  baseUrl: string,
  sess: SyncSession,
  totalConflicts: number,
  onProgress?: (p: SyncProgress) => void,
): Promise<ResolutionsResult> {
  const deadline = Date.now() + SYNC_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const req: SyncPollResolutionsRequest = { sessionId: sess.id };
      const enc = sess.sealJSON(req, SYNC_AAD_POLL_RESOLUTIONS);
      const respBytes = await postBinary(
        `${baseUrl}/v1/sync/poll-resolutions`,
        enc,
      );
      const resp = sess.openJSON<SyncPollResolutionsResponse>(
        respBytes,
        SYNC_AAD_POLL_RESOLUTIONS,
      );
      if (!resp.ready) {
        if (onProgress) {
          onProgress({
            stage: 'merge',
            processed: 0,
            total: totalConflicts,
            message: '等待桌面端解决冲突…',
          });
        }
        await sleep(SYNC_POLL_INTERVAL_MS);
        continue;
      }
      const actions = resp.actions ?? [];
      if (onProgress) {
        onProgress({
          stage: 'commit',
          processed: 0,
          total: actions.length,
          message: '应用桌面端决策',
        });
      }
      let appliedCount = 0;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        if (await applyResolutionAction(a)) appliedCount++;
        if (onProgress) {
          onProgress({
            stage: 'commit',
            processed: i + 1,
            total: actions.length,
          });
        }
      }
      return { applied: appliedCount, resolved: true };
    } catch (_e) {
      await sleep(SYNC_POLL_INTERVAL_MS);
    }
  }
  return { applied: 0, resolved: false };
}

interface ResolutionsResult {
  applied: number;
  resolved: boolean;
}

async function applyResolutionAction(a: SyncResolutionAction): Promise<boolean> {
  switch (a.op) {
    case 'noop':
      return true;
    case 'delete':
      try {
        await vaultService.deleteItem(a.id);
        return true;
      } catch (_e) {
        return false;
      }
    case 'overwrite': {
      if (!a.payload) return false;
      try {
        const bytes = fromB64(a.payload);
        const payload = JSON.parse(utf8Decode(bytes)) as ItemPayload;
        const updatedAt = a.updatedAt ?? payload.updatedAt;
        const createdAt = a.createdAt ?? payload.createdAt;
        await vaultService.ingestForeignPayload(a.id, payload, createdAt, updatedAt);
        return true;
      } catch (_e) {
        return false;
      }
    }
    case 'duplicate': {
      if (!a.payload || !a.newId) return false;
      try {
        const bytes = fromB64(a.payload);
        const payload = JSON.parse(utf8Decode(bytes)) as ItemPayload;
        const createdAt = a.createdAt ?? payload.createdAt;
        const updatedAt = a.updatedAt ?? payload.updatedAt;
        await vaultService.ingestForeignPayload(a.newId, payload, createdAt, updatedAt);
        return true;
      } catch (_e) {
        return false;
      }
    }
    default:
      return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
    if (typeof row.deletedAt === 'number' && row.deletedAt > 0) {
      entry.deletedAt = row.deletedAt;
    }
    if (!entry.deletedAt) {
      const payload = await vaultService.getItem(row.id);
      if (payload) {
        entry.contentHash = await contentHashOf(payload);
        if (typeof payload.revision === 'number') {
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
  } catch (_e) {
    return null;
  }
}

async function buildRecordFromLocal(id: string): Promise<SyncItemRecord | null> {
  const file = await readVaultFile();
  const row: EncryptedItemRow | undefined = file.items.find((r) => r.id === id);
  if (!row) return null;
  const rec: SyncItemRecord = {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ciphertext: toB64(row.payload),
  };
  if (typeof row.deletedAt === 'number' && row.deletedAt > 0) {
    rec.deletedAt = row.deletedAt;
  }
  return rec;
}

async function applyRemoteRecord(rec: SyncItemRecord): Promise<boolean> {
  if (rec.deletedAt && rec.deletedAt > 0) {
    try {
      await vaultService.deleteItem(rec.id);
      return true;
    } catch (_e) {
      return false;
    }
  }
  if (!rec.ciphertext) return false;
  try {
    const plaintextBytes = fromB64(rec.ciphertext);
    const payload = JSON.parse(utf8Decode(plaintextBytes)) as ItemPayload;
    const result = await vaultService.ingestForeignPayload(
      rec.id,
      payload,
      rec.createdAt,
      rec.updatedAt,
    );
    return result !== 'skipped';
  } catch (_e) {
    return false;
  }
}

function decryptRemoteRecord(rec: SyncItemRecord): ItemPayload | null {
  if (!rec.ciphertext) return null;
  try {
    const plaintextBytes = fromB64(rec.ciphertext);
    const payload = JSON.parse(utf8Decode(plaintextBytes)) as ItemPayload;
    payload.id = rec.id;
    if (rec.deletedAt && rec.deletedAt > 0) payload.deletedAt = rec.deletedAt;
    return payload;
  } catch (_e) {
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
    const enc = sess.sealJSON(req, SYNC_AAD_FETCH);
    const respBytes = await postBinary(`${baseUrl}/v1/sync/fetch`, enc);
    const resp = sess.openJSON<SyncBatchResponse>(respBytes, SYNC_AAD_FETCH);
    for (const it of resp.items) out.push(it);
  }
  return out;
}

async function contentHashOf(p: ItemPayload): Promise<string> {
  const stable: StableHashPayload = {
    type: p.type,
    name: p.name,
    fields: p.fields ?? ({} as Record<string, Object>),
  };
  const bytes = utf8(stableStringify(stable));
  const hash = await sha256(bytes);
  return hexEncode(hash.subarray(0, 16));
}

interface StableHashPayload {
  type: string;
  name: string;
  fields: Record<string, Object>;
}

/**
 * stableStringify 模拟 Go 的 `json.Marshal(map[string]any)` —— 按 key 字典序
 * 递归输出，**不**做 HTMLEscape。跨端 hash 必须用这个而非 JSON.stringify。
 */
function stableStringify(value: Object | null | undefined): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const arr = value as Object[];
    const parts: string[] = [];
    for (const v of arr) parts.push(stableStringify(v));
    return '[' + parts.join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, Object>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]));
    }
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(value);
}

/* ----------------------------------------------------------------------------
 * Merge algorithm —— 与 desktop mergeManifests 字节级一致
 * -------------------------------------------------------------------------- */

interface MergeStep {
  id: string;
  action: string;
}

interface MergeConflict {
  id: string;
  kind: SyncConflictKind;
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
  const plan: MergePlan = { pullApply: [], push: [], conflicts: [], identical: [] };
  const localMap = new Map<string, SyncManifestEntry>();
  for (const e of local) localMap.set(e.id, e);
  const remoteMap = new Map<string, SyncManifestEntry>();
  for (const e of remote) remoteMap.set(e.id, e);

  for (const r of remote) {
    const l = localMap.get(r.id);
    if (!l) {
      if (!r.deletedAt || r.deletedAt === 0) {
        plan.pullApply.push({ id: r.id, action: 'insert' });
      }
      continue;
    }
    decideBoth(l, r, plan);
  }
  for (const l of local) {
    if (!remoteMap.has(l.id)) {
      plan.push.push({ id: l.id, action: 'insert' });
    }
  }
  return plan;
}

function decideBoth(
  local: SyncManifestEntry,
  remote: SyncManifestEntry,
  plan: MergePlan,
): void {
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
  if (localDel && remoteDel) {
    plan.identical.push(local.id);
    return;
  }
  if (localDel !== remoteDel) {
    plan.conflicts.push({
      id: local.id,
      kind: 'delete_vs_edit',
      local,
      remote,
      suggestedRemote: remote.updatedAt > local.updatedAt,
    });
    return;
  }
  if (sameTS) {
    plan.conflicts.push({
      id: local.id,
      kind: 'concurrent_edit',
      local,
      remote,
      suggestedRemote: (remote.revision ?? 0) > (local.revision ?? 0),
    });
    return;
  }
  if (sameHash) {
    if (remote.updatedAt > local.updatedAt) {
      plan.pullApply.push({ id: local.id, action: remoteDel ? 'delete' : 'replace' });
    } else {
      plan.push.push({ id: local.id, action: localDel ? 'delete' : 'replace' });
    }
    return;
  }
  plan.conflicts.push({
    id: local.id,
    kind: 'divergent_content',
    local,
    remote,
    suggestedRemote: remote.updatedAt > local.updatedAt,
  });
}

/* ----------------------------------------------------------------------------
 * Crypto helpers —— Argon2id 走 cryptocore；SHA-256/HMAC 走系统 cryptoFramework
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
  combined.set(serverNonce, salt.length + sidBytes.length + clientNonce.length);
  return argon2idRaw(
    utf8(pin),
    combined,
    SYNC_PSK_MEMORY_KIB,
    SYNC_PSK_ITERATIONS,
    SYNC_PSK_PARALLELISM,
    SYNC_PSK_KEY_LEN,
  );
}

/**
 * HMAC-SHA256 —— RFC 2104 标准实现，基于系统 SHA-256
 *
 * 不走 cryptoFramework.createMac 是因为 OHOS HMAC API 需要先用
 * createSymKeyGenerator('HMAC|SHA256') 把字节 key 包装成 SymKey，
 * 然后调 convertKey；总共调用栈太长，反而比手写 HMAC 复杂。
 * HMAC = H(K' ⊕ opad ‖ H(K' ⊕ ipad ‖ msg))；SHA-256 block size = 64。
 */
async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const blockSize = 64;
  // 1. 规整 key 到 blockSize：超长则先 SHA-256，过短则右填 0
  let k0: Uint8Array;
  if (key.length > blockSize) {
    const hashed = await sha256(key);
    k0 = new Uint8Array(blockSize);
    k0.set(hashed, 0);
  } else {
    k0 = new Uint8Array(blockSize);
    k0.set(key, 0);
  }
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = k0[i] ^ 0x36;
    opad[i] = k0[i] ^ 0x5c;
  }
  // 2. inner = SHA-256(ipad ‖ msg)
  const innerInput = new Uint8Array(blockSize + message.length);
  innerInput.set(ipad, 0);
  innerInput.set(message, blockSize);
  const inner = await sha256(innerInput);
  // 3. outer = SHA-256(opad ‖ inner)
  const outerInput = new Uint8Array(blockSize + inner.length);
  outerInput.set(opad, 0);
  outerInput.set(inner, blockSize);
  return sha256(outerInput);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const md = cryptoFramework.createMd('SHA256');
  md.updateSync({ data });
  const out = md.digestSync();
  return new Uint8Array(out.data);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function hexEncode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new SyncError('BAD_RESPONSE', 'bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * HTTP helpers —— @ohos.net.http
 * -------------------------------------------------------------------------- */

async function postJSON<I, O>(url: string, body: I): Promise<O> {
  const request = http.createHttp();
  try {
    const resp = await request.request(url, {
      method: http.RequestMethod.POST,
      header: { 'content-type': 'application/json' },
      extraData: JSON.stringify(body),
      connectTimeout: 10_000,
      readTimeout: 15_000,
    });
    if (resp.responseCode === 429) {
      const text = typeof resp.result === 'string' ? resp.result : 'pin locked';
      throw new SyncError('PIN_LOCKED', text);
    }
    if (resp.responseCode < 200 || resp.responseCode >= 300) {
      const text = typeof resp.result === 'string' ? resp.result : '';
      throw new SyncError('NETWORK', `status ${resp.responseCode}: ${text}`);
    }
    const text = typeof resp.result === 'string' ? resp.result : '';
    return JSON.parse(text) as O;
  } catch (e) {
    if (e instanceof SyncError) throw e;
    const err = e as BusinessError;
    throw new SyncError('NETWORK', `${err.code ?? ''} ${err.message ?? String(e)}`.trim());
  } finally {
    request.destroy();
  }
}

async function postBinary(url: string, body: Uint8Array): Promise<Uint8Array> {
  const request = http.createHttp();
  try {
    const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    const resp = await request.request(url, {
      method: http.RequestMethod.POST,
      header: { 'content-type': 'application/octet-stream' },
      extraData: ab,
      connectTimeout: 10_000,
      readTimeout: 60_000,
      // 期望 server 返回二进制；ohos http 默认按文本解析，开启 array_buffer 模式
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
    });
    if (resp.responseCode < 200 || resp.responseCode >= 300) {
      const text = typeof resp.result === 'string' ? resp.result : '';
      throw new SyncError('NETWORK', `status ${resp.responseCode}: ${text}`);
    }
    if (resp.result instanceof ArrayBuffer) {
      return new Uint8Array(resp.result);
    }
    // 兜底：服务端返回了文本（开发期偶发）—— 按二进制解
    if (typeof resp.result === 'string') {
      return utf8(resp.result);
    }
    throw new SyncError('BAD_RESPONSE', 'unexpected binary response type');
  } catch (e) {
    if (e instanceof SyncError) throw e;
    const err = e as BusinessError;
    throw new SyncError('NETWORK', `${err.code ?? ''} ${err.message ?? String(e)}`.trim());
  } finally {
    request.destroy();
  }
}

/* ----------------------------------------------------------------------------
 * QR helpers
 * -------------------------------------------------------------------------- */

export interface SyncQRParsed {
  baseUrl: string;
  pin: string;
}

/** 解析 `zpass-sync://host:port?pin=xxxxxx` */
export function parseSyncQRPayload(payload: string): SyncQRParsed | null {
  try {
    const trimmed = payload.replace(/^zpass-sync:\/\//, 'http://');
    // ArkTS 没有全局 URL，手解：http://host:port?pin=...
    const m = trimmed.match(/^https?:\/\/([^\/\?]+)(?:\/[^\?]*)?\?(.*)$/);
    if (!m) return null;
    const host = m[1];
    const query = m[2];
    const params = new Map<string, string>();
    for (const seg of query.split('&')) {
      const eq = seg.indexOf('=');
      if (eq <= 0) continue;
      const k = decodeURIComponent(seg.slice(0, eq));
      const v = decodeURIComponent(seg.slice(eq + 1));
      params.set(k, v);
    }
    const pin = params.get('pin');
    if (!pin) return null;
    return { baseUrl: `http://${host}`, pin };
  } catch (_e) {
    return null;
  }
}
