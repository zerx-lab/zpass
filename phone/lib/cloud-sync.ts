// ZPass Phone —— 云同步引擎（全量 + 增量）
//
// 移植 harmony CloudSync.ets / desktop cloudsync.go：两条路径共享一套 LWW 决策核
// （applyDecision，按 updatedAt + vault-key 重算的 content_hash）：
//   - syncVaultFull：从 cursor 0 拉全量 snapshot，重建所有 per-item 水位
//     （首次绑定 / 手动 / SSE resync / 410 恢复）。
//   - syncVaultIncremental：拉 seq>cursor 的 delta（含墓碑），只解密 updatedAt 推进过
//     的本地条目 → 大幅省解密/哈希。
//
// per-item 水位 CloudItemSyncState{seq,syncedHash,syncedAt,deleted}（按本地 id 键）
// 是增量的关键。引擎就地修改传入的 state Map，调用方（CloudService）同步后整体持久化。
//
// 零知识边界：本地 DEK 与云端 vault key 两条独立通道，只在明文 payload 转码处相遇。
// CAS 冲突是终态 LWW（拉对端 / 同内容收敛 / 记冲突），常规推送不重试；只有用户显式
// 「采用本端」(resolveConflictLocal) 才 forcePush 重试。

import {
  APIError,
  type ChangeRequest,
  type ChangeResponse,
  type CloudClient,
  type ServerItem,
  type SnapshotItem,
  type SnapshotResponse,
} from "./cloud-client";
import {
  cloudContentHash,
  cloudItemId,
  isVaultManifestId,
  localItemId,
  openItemRecord,
  payloadToWebVaultRecord,
  sealItemRecord,
  webVaultRecordToPayload,
} from "./cloud-crypto";
import { fromB64, randomBytes, toB64, utf8 } from "./crypto";
import { vaultService, spaceIdOfPayload, type ItemPayload } from "./vault-service";
import { readVaultFile, type EncryptedItemRow } from "./vault-storage";
import { type CloudItemSyncState } from "./cloud-storage";

/* ----------------------------------------------------------------------------
 * 常量 / 错误
 * -------------------------------------------------------------------------- */

const SNAPSHOT_PAGE_LIMIT = 500;
const FORCE_PUSH_MAX_RETRY = 5;

export type CloudSyncErrorCode = "decrypt-failed" | "unauthorized" | "frozen" | "network";

export class CloudSyncError extends Error {
  readonly code: CloudSyncErrorCode;
  constructor(code: CloudSyncErrorCode, message: string) {
    super(message);
    this.name = "CloudSyncError";
    this.code = code;
  }
}

export type CloudSyncStateMap = Map<string, CloudItemSyncState>;

/* ----------------------------------------------------------------------------
 * 对外类型
 * -------------------------------------------------------------------------- */

export interface SyncContext {
  client: CloudClient;
  vaultId: string;
  /** 该 vault 绑定的本地空间 id —— 决定本地 manifest 切分与拉取条目的归属空间。 */
  spaceId: string;
  /** 解封后的 per-vault key（32B，仅内存）。 */
  vaultKey: Uint8Array;
}

/** 捕获的真冲突 —— 交 UI 决策（local / remote）。 */
export interface CloudConflict {
  localId: string;
  cloudId: string;
  spaceId: string;
  /** 'concurrent_edit' | 'delete_vs_edit' */
  kind: string;
  suggestedRemote: boolean;
  localName: string;
  remoteName: string;
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  remoteSeq: number;
  remoteDeleted: boolean;
  remoteCreatedAt: number;
  remoteRevision: number;
  /** 解密后的对端 payload（对端为墓碑时 null）—— resolve('remote') 时落地。 */
  remotePayload: ItemPayload | null;
}

export interface CloudSyncOutcome {
  applied: number;
  pushed: number;
  /** 新的 cursor（snapshot 高水位）；调用方据此持久化。 */
  newCursor: number;
  conflicts: CloudConflict[];
  frozen: boolean;
}

export type CloudSyncStage = "pull" | "merge" | "push" | "done";

export interface CloudSyncProgress {
  stage: CloudSyncStage;
  processed: number;
  total: number;
}

export type CloudSyncProgressCb = (p: CloudSyncProgress) => void;

/* ----------------------------------------------------------------------------
 * 内部条目表示
 * -------------------------------------------------------------------------- */

interface RemoteEntry {
  cloudId: string;
  localId: string;
  seq: number;
  deleted: boolean;
  updatedAt: number;
  revision: number;
  createdAt: number;
  hash: string;
  payload: ItemPayload | null;
}

interface LocalEntry {
  localId: string;
  deleted: boolean;
  deletedAt: number;
  updatedAt: number;
  revision: number;
  hash: string;
  payload: ItemPayload | null;
}

type PushKind = "pushed" | "pulled" | "conflict" | "frozen" | "noop";

interface PushOutcome {
  kind: PushKind;
  conflict: CloudConflict | null;
}

/* ----------------------------------------------------------------------------
 * 水位记录助手
 * -------------------------------------------------------------------------- */

function recordItemState(
  state: CloudSyncStateMap,
  id: string,
  seq: number,
  syncedHash: string,
  syncedAt: number,
): void {
  state.set(id, { seq, syncedHash, syncedAt, deleted: false });
}

function recordLocalState(state: CloudSyncStateMap, id: string, seq: number, l: LocalEntry): void {
  state.set(id, { seq, syncedHash: l.hash, syncedAt: l.updatedAt, deleted: l.deleted });
}

function recordTombstoneState(state: CloudSyncStateMap, id: string, seq: number, syncedAt: number): void {
  state.set(id, { seq, syncedHash: "", syncedAt, deleted: true });
}

/* ----------------------------------------------------------------------------
 * 拉取（分页 snapshot）
 * -------------------------------------------------------------------------- */

interface FetchResult {
  items: SnapshotItem[];
  currentSeq: number;
}

/** 从 cursor 分页拉 snapshot/delta。绝不信 has_more、不因空页提前中断（墓碑窗口可能整页空）。 */
async function fetchSnapshotFrom(
  ctx: SyncContext,
  fromCursor: number,
  includeDeleted: boolean,
): Promise<FetchResult> {
  let cursor = fromCursor;
  let currentSeq = fromCursor;
  const out: SnapshotItem[] = [];
  for (;;) {
    const resp: SnapshotResponse = await ctx.client.getSnapshot(
      ctx.vaultId,
      cursor,
      SNAPSHOT_PAGE_LIMIT,
      includeDeleted,
    );
    currentSeq = resp.current_seq;
    for (const it of resp.items) out.push(it);
    const next = resp.next_cursor;
    if (next <= cursor) break;
    cursor = next;
    if (cursor >= currentSeq) break;
  }
  return { items: out, currentSeq };
}

async function buildRemoteEntry(ctx: SyncContext, it: SnapshotItem): Promise<RemoteEntry> {
  const cloudId = it.item_id;
  const lid = localItemId(cloudId);
  if (it.deleted || !it.ciphertext) {
    return {
      cloudId,
      localId: lid,
      seq: it.seq,
      deleted: true,
      updatedAt: it.updated_at,
      revision: it.revision,
      createdAt: 0,
      hash: "",
      payload: null,
    };
  }
  let payload: ItemPayload;
  try {
    const plain = openItemRecord(ctx.vaultKey, fromB64(it.ciphertext), cloudId);
    payload = webVaultRecordToPayload(plain, lid);
  } catch {
    throw new CloudSyncError("decrypt-failed", "无法解密云端条目（vault key 不匹配？）");
  }
  payload.updatedAt = it.updated_at;
  payload.revision = it.revision;
  const hash = await cloudContentHash(ctx.vaultKey, payload);
  return {
    cloudId,
    localId: lid,
    seq: it.seq,
    deleted: false,
    updatedAt: it.updated_at,
    revision: it.revision,
    createdAt: payload.createdAt,
    hash,
    payload,
  };
}

/* ----------------------------------------------------------------------------
 * 本地条目构造
 * -------------------------------------------------------------------------- */

function isRowDeleted(row: EncryptedItemRow): boolean {
  return typeof row.deletedAt === "number" && row.deletedAt > 0;
}

/** 本地墓碑 entry（不解密；revision 仅作冲突 tie-breaker，取 1 即可）。 */
function localTombstoneEntry(row: EncryptedItemRow): LocalEntry {
  const delAt = typeof row.deletedAt === "number" && row.deletedAt > 0 ? row.deletedAt : row.updatedAt;
  return {
    localId: row.id,
    deleted: true,
    deletedAt: delAt,
    updatedAt: row.updatedAt,
    revision: 1,
    hash: "",
    payload: null,
  };
}

/** 本地 live entry（解密 + 算 hash）。不存在/已删 → null。 */
async function localLiveEntry(ctx: SyncContext, id: string): Promise<LocalEntry | null> {
  const p = await vaultService.getItem(id);
  if (!p) return null;
  const hash = await cloudContentHash(ctx.vaultKey, p);
  return {
    localId: id,
    deleted: false,
    deletedAt: 0,
    updatedAt: p.updatedAt,
    revision: p.revision ?? 1,
    hash,
    payload: p,
  };
}

/* ----------------------------------------------------------------------------
 * 推送（终态 CAS 桥接，常规路径不重试）
 * -------------------------------------------------------------------------- */

function newMutationId(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  let hex = "";
  for (let i = 0; i < 16; i++) hex += b[i].toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildChangeRequest(ctx: SyncContext, l: LocalEntry, baseSeq: number): ChangeRequest {
  const cloudId = cloudItemId(l.localId);
  if (l.deleted) {
    return {
      item_id: cloudId,
      base_seq: baseSeq,
      deleted: true,
      updated_at: l.updatedAt,
      revision: l.revision,
      client_mutation_id: newMutationId(),
    };
  }
  const recordPlain = utf8(payloadToWebVaultRecord(l.payload!));
  const ct = sealItemRecord(ctx.vaultKey, recordPlain, cloudId);
  return {
    item_id: cloudId,
    base_seq: baseSeq,
    deleted: false,
    ciphertext: toB64(ct),
    content_hash: l.hash,
    updated_at: l.updatedAt,
    revision: l.revision,
    client_mutation_id: newMutationId(),
  };
}

async function decodeServerItem(
  ctx: SyncContext,
  localId: string,
  server: ServerItem,
): Promise<ItemPayload | null> {
  if (server.deleted || !server.ciphertext) return null;
  const plain = openItemRecord(ctx.vaultKey, fromB64(server.ciphertext), cloudItemId(localId));
  const payload = webVaultRecordToPayload(plain, localId);
  payload.updatedAt = server.updated_at;
  payload.revision = server.revision;
  return payload;
}

/** 单次 CAS 推送；冲突走终态桥接（不在此重试）。成功/收敛即写水位。 */
async function pushItem(
  ctx: SyncContext,
  l: LocalEntry,
  baseSeq: number,
  state: CloudSyncStateMap,
): Promise<PushOutcome> {
  const req = buildChangeRequest(ctx, l, baseSeq);
  let resp: ChangeResponse;
  try {
    resp = await ctx.client.postChange(ctx.vaultId, req);
  } catch (e) {
    if (e instanceof APIError && e.isVaultFrozen()) return { kind: "frozen", conflict: null };
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (resp.status === "ok") {
    recordLocalState(state, l.localId, resp.assigned_seq, l);
    return { kind: "pushed", conflict: null };
  }
  const server = resp.server;
  if (!server) return { kind: "noop", conflict: null }; // 无服务端历史 → 下轮再评估
  return bridgeConflict(ctx, l, server, state);
}

/** CAS 冲突的终态 LWW 桥接：拉对端 / 同内容收敛 / 记冲突。 */
async function bridgeConflict(
  ctx: SyncContext,
  l: LocalEntry,
  server: ServerItem,
  state: CloudSyncStateMap,
): Promise<PushOutcome> {
  if (server.deleted) {
    if (l.deleted) {
      recordTombstoneState(state, l.localId, server.seq, server.updated_at);
      return { kind: "noop", conflict: null };
    }
    if (l.updatedAt <= server.updated_at) {
      await vaultService.ingestForeignDeletion(l.localId, server.updated_at, ctx.spaceId, true);
      recordTombstoneState(state, l.localId, server.seq, server.updated_at);
      return { kind: "pulled", conflict: null };
    }
    return { kind: "conflict", conflict: makeConflict(ctx, l, server, null, "delete_vs_edit", false) };
  }
  // server live
  const remotePayload = await decodeServerItem(ctx, l.localId, server);
  const serverHash = remotePayload ? await cloudContentHash(ctx.vaultKey, remotePayload) : "";
  if (l.hash !== "" && l.hash === serverHash) {
    recordItemState(state, l.localId, server.seq, l.hash, server.updated_at);
    return { kind: "noop", conflict: null };
  }
  if (l.updatedAt < server.updated_at) {
    if (remotePayload) {
      await vaultService.ingestForeignPayload(
        l.localId,
        remotePayload,
        remotePayload.createdAt,
        server.updated_at,
        ctx.spaceId,
        true,
      );
      recordItemState(state, l.localId, server.seq, serverHash, server.updated_at);
    }
    return { kind: "pulled", conflict: null };
  }
  const kind = l.deleted ? "delete_vs_edit" : "concurrent_edit";
  return {
    kind: "conflict",
    conflict: makeConflict(ctx, l, server, remotePayload, kind, server.revision > l.revision),
  };
}

function makeConflict(
  ctx: SyncContext,
  l: LocalEntry,
  server: ServerItem,
  remotePayload: ItemPayload | null,
  kind: string,
  suggestedRemote: boolean,
): CloudConflict {
  return {
    localId: l.localId,
    cloudId: cloudItemId(l.localId),
    spaceId: ctx.spaceId,
    kind,
    suggestedRemote,
    localName: l.payload ? l.payload.name : "",
    remoteName: remotePayload ? remotePayload.name : "",
    localUpdatedAt: l.updatedAt,
    remoteUpdatedAt: server.updated_at,
    remoteSeq: server.seq,
    remoteDeleted: server.deleted,
    remoteCreatedAt: remotePayload ? remotePayload.createdAt : 0,
    remoteRevision: server.revision,
    remotePayload,
  };
}

function conflictFromEntries(
  ctx: SyncContext,
  l: LocalEntry,
  r: RemoteEntry,
  kind: string,
  suggestedRemote: boolean,
): CloudConflict {
  return {
    localId: l.localId,
    cloudId: r.cloudId,
    spaceId: ctx.spaceId,
    kind,
    suggestedRemote,
    localName: l.payload ? l.payload.name : "",
    remoteName: r.payload ? r.payload.name : "",
    localUpdatedAt: l.updatedAt,
    remoteUpdatedAt: r.updatedAt,
    remoteSeq: r.seq,
    remoteDeleted: r.deleted,
    remoteCreatedAt: r.createdAt,
    remoteRevision: r.revision,
    remotePayload: r.payload,
  };
}

async function pushAndTally(
  ctx: SyncContext,
  l: LocalEntry,
  baseSeq: number,
  state: CloudSyncStateMap,
  outcome: CloudSyncOutcome,
): Promise<void> {
  if (outcome.frozen) return;
  const res = await pushItem(ctx, l, baseSeq, state);
  if (res.kind === "pushed") outcome.pushed++;
  else if (res.kind === "pulled") outcome.applied++;
  else if (res.kind === "frozen") outcome.frozen = true;
  else if (res.kind === "conflict" && res.conflict) outcome.conflicts.push(res.conflict);
}

/* ----------------------------------------------------------------------------
 * 决策核（LWW）—— 全量/增量共用。baseSeq 由调用方解析。
 * -------------------------------------------------------------------------- */

async function applyDecision(
  ctx: SyncContext,
  l: LocalEntry | undefined,
  r: RemoteEntry | undefined,
  baseSeq: number,
  state: CloudSyncStateMap,
  outcome: CloudSyncOutcome,
): Promise<void> {
  // 仅远端
  if (r && !l) {
    if (r.deleted || !r.payload) {
      recordTombstoneState(state, r.localId, r.seq, r.updatedAt);
      return;
    }
    await vaultService.ingestForeignPayload(r.localId, r.payload, r.payload.createdAt, r.updatedAt, ctx.spaceId);
    outcome.applied++;
    recordItemState(state, r.localId, r.seq, r.hash, r.updatedAt);
    return;
  }
  // 仅本地
  if (l && !r) {
    if (l.deleted) {
      const st = state.get(l.localId);
      if (st && !st.deleted) await pushAndTally(ctx, l, baseSeq, state, outcome); // 传播本地删除
      // 否则孤儿删除 / 已收敛 → 跳过
      return;
    }
    await pushAndTally(ctx, l, baseSeq, state, outcome); // 仅本地 live → push
    return;
  }
  if (!l || !r) return;

  // 双方都有
  if (l.deleted) {
    if (r.deleted) {
      recordTombstoneState(state, l.localId, r.seq, Math.max(l.deletedAt, r.updatedAt));
      return;
    }
    if (l.deletedAt >= r.updatedAt) {
      await pushAndTally(ctx, l, baseSeq, state, outcome); // 本端删除胜出 → 推墓碑
    } else {
      outcome.conflicts.push(conflictFromEntries(ctx, l, r, "delete_vs_edit", true));
    }
    return;
  }

  // 本地 live
  if (r.deleted) {
    if (l.updatedAt > r.updatedAt) {
      await pushAndTally(ctx, l, baseSeq, state, outcome); // 本端编辑胜出 → 复活
    } else {
      await vaultService.ingestForeignDeletion(l.localId, r.updatedAt, ctx.spaceId);
      outcome.applied++;
      recordTombstoneState(state, l.localId, r.seq, r.updatedAt);
    }
    return;
  }

  // 双方 live —— LWW
  const sameHash = l.hash !== "" && l.hash === r.hash;
  const bothHashed = l.hash !== "" && r.hash !== "";
  if (sameHash && l.updatedAt === r.updatedAt) {
    recordItemState(state, l.localId, r.seq, r.hash, r.updatedAt); // 完全一致
    return;
  }
  if (l.updatedAt > r.updatedAt) {
    await pushAndTally(ctx, l, baseSeq, state, outcome);
    return;
  }
  if (l.updatedAt < r.updatedAt) {
    if (r.payload) {
      await vaultService.ingestForeignPayload(l.localId, r.payload, r.payload.createdAt, r.updatedAt, ctx.spaceId);
      outcome.applied++;
      recordItemState(state, l.localId, r.seq, r.hash, r.updatedAt);
    }
    return;
  }
  // 同时戳
  if (bothHashed && l.hash !== r.hash) {
    outcome.conflicts.push(conflictFromEntries(ctx, l, r, "concurrent_edit", r.revision > l.revision));
    return;
  }
  recordItemState(state, l.localId, r.seq, r.hash, r.updatedAt); // 同戳缺 hash → 视为收敛
}

/* ----------------------------------------------------------------------------
 * 全量对账
 * -------------------------------------------------------------------------- */

async function syncVaultFull(
  ctx: SyncContext,
  state: CloudSyncStateMap,
  outcome: CloudSyncOutcome,
): Promise<void> {
  const fetched = await fetchSnapshotFrom(ctx, 0, true);
  outcome.newCursor = fetched.currentSeq;

  // 远端：每条目取最新 seq
  const latest = new Map<string, SnapshotItem>();
  for (const it of fetched.items) {
    const lid = localItemId(it.item_id);
    if (isVaultManifestId(lid)) continue;
    const prev = latest.get(lid);
    if (!prev || it.seq > prev.seq) latest.set(lid, it);
  }
  const remoteByLocal = new Map<string, RemoteEntry>();
  const remoteList: SnapshotItem[] = [];
  latest.forEach((it) => remoteList.push(it));
  for (const it of remoteList) {
    const entry = await buildRemoteEntry(ctx, it);
    remoteByLocal.set(entry.localId, entry);
  }

  // 本地全量（仅本空间——多空间下每 vault 1:1 绑定一个空间）
  const localByLocal = new Map<string, LocalEntry>();
  const live = await vaultService.listItemsForSpace(ctx.spaceId);
  for (const p of live) {
    const hash = await cloudContentHash(ctx.vaultKey, p);
    localByLocal.set(p.id, {
      localId: p.id,
      deleted: false,
      deletedAt: 0,
      updatedAt: p.updatedAt,
      revision: p.revision ?? 1,
      hash,
      payload: p,
    });
  }
  const deleted = await vaultService.listDeletedForSpace(ctx.spaceId);
  for (const p of deleted) {
    const delAt = typeof p.deletedAt === "number" && p.deletedAt > 0 ? p.deletedAt : p.updatedAt;
    localByLocal.set(p.id, {
      localId: p.id,
      deleted: true,
      deletedAt: delAt,
      updatedAt: p.updatedAt,
      revision: p.revision ?? 1,
      hash: "",
      payload: p,
    });
  }

  // union（迁出守护：远端仍有、但本地已不在本空间的条目——若它仍 live 于其它空间，跳过）
  const ids: string[] = [];
  const seen = new Set<string>();
  const remoteIds: string[] = [];
  remoteByLocal.forEach((_v, k) => remoteIds.push(k));
  for (const k of remoteIds) {
    if (!localByLocal.has(k)) {
      const elsewhere = await vaultService.getItem(k);
      if (elsewhere) continue; // 已迁往其它空间 → 不拉回
    }
    if (!seen.has(k)) {
      seen.add(k);
      ids.push(k);
    }
  }
  localByLocal.forEach((_v, k) => {
    if (!seen.has(k)) {
      seen.add(k);
      ids.push(k);
    }
  });

  for (const id of ids) {
    const r = remoteByLocal.get(id);
    const l = localByLocal.get(id);
    const baseSeq = r ? r.seq : state.get(id)?.seq ?? 0;
    await applyDecision(ctx, l, r, baseSeq, state, outcome);
  }
}

/* ----------------------------------------------------------------------------
 * 增量对账
 * -------------------------------------------------------------------------- */

interface Shortlist {
  candidates: Map<string, LocalEntry>;
  refresh: Map<string, number>;
}

/** 本地变更短名单：只对 updatedAt 推进过的行解密+算哈希。 */
async function localChangeShortlist(
  ctx: SyncContext,
  rows: EncryptedItemRow[],
  state: CloudSyncStateMap,
): Promise<Shortlist> {
  const candidates = new Map<string, LocalEntry>();
  const refresh = new Map<string, number>();
  for (const row of rows) {
    const id = row.id;
    const st = state.get(id);
    if (isRowDeleted(row)) {
      if (!st) continue; // 孤儿删除：从未同步过 → 跳过
      if (!st.deleted) candidates.set(id, localTombstoneEntry(row)); // 删除尚未推送
      continue;
    }
    if (!st) {
      // 全新本地条目（或属于其它空间）
      const e = await localLiveEntry(ctx, id);
      if (e && spaceIdOfPayload(e.payload!) === ctx.spaceId) candidates.set(id, e);
      continue; // 非本空间 → 跳过
    }
    if (row.updatedAt < st.syncedAt) continue; // 早于收敛 → 未变
    const e = await localLiveEntry(ctx, id);
    if (!e) continue;
    if (spaceIdOfPayload(e.payload!) !== ctx.spaceId) {
      // 已迁出本空间 → 清本空间水位、跳过
      state.delete(id);
      continue;
    }
    if (e.hash === st.syncedHash && !st.deleted) {
      refresh.set(id, row.updatedAt); // 内容未变、仅时间戳推进 → 只刷新 synced_at
    } else {
      candidates.set(id, e);
    }
  }
  return { candidates, refresh };
}

async function syncVaultIncremental(
  ctx: SyncContext,
  state: CloudSyncStateMap,
  cursor: number,
  outcome: CloudSyncOutcome,
): Promise<void> {
  // 引导：无 cursor / 无水位 → 全量
  if (cursor <= 0 || state.size === 0) {
    await syncVaultFull(ctx, state, outcome);
    return;
  }

  let delta: FetchResult;
  try {
    delta = await fetchSnapshotFrom(ctx, cursor, true);
  } catch (e) {
    if (e instanceof APIError && e.isGone()) {
      // cursor 低于服务端保留水位 → 清水位、cursor 归零、全量重建
      state.clear();
      await syncVaultFull(ctx, state, outcome);
      return;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
  outcome.newCursor = delta.currentSeq;

  // delta 每条目取最新 seq；分墓碑 / live
  const deltaByID = new Map<string, SnapshotItem>();
  for (const it of delta.items) {
    const lid = localItemId(it.item_id);
    if (isVaultManifestId(lid)) continue;
    const prev = deltaByID.get(lid);
    if (!prev || it.seq > prev.seq) deltaByID.set(lid, it);
  }

  const file = await readVaultFile();
  const rowById = new Map<string, EncryptedItemRow>();
  for (const row of file.items) rowById.set(row.id, row);

  // 本地变更短名单（先算，墓碑 delta 需要判断本地是否为候选）
  const sl = await localChangeShortlist(ctx, file.items, state);
  sl.refresh.forEach((ts, id) => {
    const st = state.get(id);
    if (st) state.set(id, { seq: st.seq, syncedHash: st.syncedHash, syncedAt: ts, deleted: st.deleted });
  });
  const candidates = sl.candidates;

  // 收集 delta 的墓碑与 live
  const deltaTombstones: SnapshotItem[] = [];
  const deltaLiveIds: string[] = [];
  deltaByID.forEach((it, lid) => {
    if (it.deleted || !it.ciphertext) deltaTombstones.push(it);
    else deltaLiveIds.push(lid);
  });

  // 步骤 1：远端墓碑
  for (const it of deltaTombstones) {
    const lid = localItemId(it.item_id);
    const row = rowById.get(lid);
    if (!row || isRowDeleted(row)) {
      recordTombstoneState(state, lid, it.seq, it.updated_at); // 双删 / 从未有过 → 收敛
      candidates.delete(lid);
      continue;
    }
    // 本地 live
    if (candidates.has(lid)) {
      // 本地有编辑：LWW
      if (row.updatedAt > it.updated_at) {
        const l = candidates.get(lid)!;
        outcome.conflicts.push({
          localId: lid,
          cloudId: it.item_id,
          spaceId: ctx.spaceId,
          kind: "delete_vs_edit",
          suggestedRemote: true,
          localName: l.payload ? l.payload.name : "",
          remoteName: "",
          localUpdatedAt: row.updatedAt,
          remoteUpdatedAt: it.updated_at,
          remoteSeq: it.seq,
          remoteDeleted: true,
          remoteCreatedAt: 0,
          remoteRevision: it.revision,
          remotePayload: null,
        });
      } else {
        await vaultService.ingestForeignDeletion(lid, it.updated_at, ctx.spaceId);
        outcome.applied++;
        recordTombstoneState(state, lid, it.seq, it.updated_at);
      }
    } else {
      await vaultService.ingestForeignDeletion(lid, it.updated_at, ctx.spaceId); // 本地未改 → 远端删除胜出
      outcome.applied++;
      recordTombstoneState(state, lid, it.seq, it.updated_at);
    }
    candidates.delete(lid);
  }

  // 步骤 2：live 工作集 = delta-live ids ∪ 剩余候选
  const workIds: string[] = [];
  const workSeen = new Set<string>();
  for (const id of deltaLiveIds) {
    if (!workSeen.has(id)) {
      workSeen.add(id);
      workIds.push(id);
    }
  }
  candidates.forEach((_v, id) => {
    if (!workSeen.has(id)) {
      workSeen.add(id);
      workIds.push(id);
    }
  });

  for (const id of workIds) {
    const it = deltaByID.get(id);
    let r: RemoteEntry | undefined = undefined;
    if (it && !it.deleted && it.ciphertext) {
      r = await buildRemoteEntry(ctx, it);
    }
    let l = candidates.get(id);
    if (!l) {
      // delta-live 但本地未列为候选：构造本地 entry（live 或墓碑或不存在）
      const row = rowById.get(id);
      if (row && isRowDeleted(row)) l = localTombstoneEntry(row);
      else {
        const built = await localLiveEntry(ctx, id);
        l = built ?? undefined;
      }
    }
    const baseSeq = it ? it.seq : state.get(id)?.seq ?? 0;
    await applyDecision(ctx, l, r, baseSeq, state, outcome);
  }
}

/* ----------------------------------------------------------------------------
 * 入口
 * -------------------------------------------------------------------------- */

export async function runCloudSync(
  ctx: SyncContext,
  full: boolean,
  state: CloudSyncStateMap,
  cursor: number,
  onProgress?: CloudSyncProgressCb,
): Promise<CloudSyncOutcome> {
  if (!vaultService.isUnlocked()) {
    throw new CloudSyncError("decrypt-failed", "vault 已锁定，无法同步");
  }
  const outcome: CloudSyncOutcome = { applied: 0, pushed: 0, newCursor: cursor, conflicts: [], frozen: false };
  if (onProgress) onProgress({ stage: "pull", processed: 0, total: 0 });
  try {
    if (full) await syncVaultFull(ctx, state, outcome);
    else await syncVaultIncremental(ctx, state, cursor, outcome);
  } catch (e) {
    throw wrapNetworkError(e);
  }
  if (onProgress) onProgress({ stage: "done", processed: 0, total: 0 });
  return outcome;
}

function wrapNetworkError(e: unknown): Error {
  if (e instanceof CloudSyncError) return e;
  if (e instanceof APIError) {
    if (e.isUnauthorized()) return new CloudSyncError("unauthorized", "云会话已失效，请重新登录");
    if (e.isNetwork()) return new CloudSyncError("network", e.message);
    return new Error(e.message);
  }
  if (e instanceof Error) return e;
  return new Error(String(e));
}

/* ----------------------------------------------------------------------------
 * 冲突解决（UI 决策后调用）—— 同步更新水位
 * -------------------------------------------------------------------------- */

/** 采用对端：强制落地对端 payload / 墓碑，并把水位对齐对端。 */
export async function resolveConflictRemote(conflict: CloudConflict, state: CloudSyncStateMap): Promise<void> {
  if (conflict.remoteDeleted || !conflict.remotePayload) {
    await vaultService.ingestForeignDeletion(conflict.localId, conflict.remoteUpdatedAt, conflict.spaceId, true);
    recordTombstoneState(state, conflict.localId, conflict.remoteSeq, conflict.remoteUpdatedAt);
    return;
  }
  await vaultService.ingestForeignPayload(
    conflict.localId,
    conflict.remotePayload,
    conflict.remoteCreatedAt,
    conflict.remoteUpdatedAt,
    conflict.spaceId,
    true,
  );
  recordItemState(state, conflict.localId, conflict.remoteSeq, "", conflict.remoteUpdatedAt);
}

/** 采用本端：把本端当前态强推到云端（CAS 重试对齐 live seq），并写水位。 */
export async function resolveConflictLocal(
  ctx: SyncContext,
  conflict: CloudConflict,
  state: CloudSyncStateMap,
): Promise<void> {
  const localId = conflict.localId;
  const live = await localLiveEntry(ctx, localId);
  let l: LocalEntry;
  if (live) {
    l = live;
  } else {
    const file = await readVaultFile();
    const row = file.items.find((x) => x.id === localId);
    l = row
      ? localTombstoneEntry(row)
      : {
          localId,
          deleted: true,
          deletedAt: conflict.localUpdatedAt,
          updatedAt: conflict.localUpdatedAt,
          revision: 1,
          hash: "",
          payload: null,
        };
  }
  await forcePushLocal(ctx, l, conflict.remoteSeq, state);
}

async function forcePushLocal(
  ctx: SyncContext,
  l: LocalEntry,
  baseSeq: number,
  state: CloudSyncStateMap,
): Promise<void> {
  let curBase = baseSeq;
  for (let i = 0; i < FORCE_PUSH_MAX_RETRY; i++) {
    const req = buildChangeRequest(ctx, l, curBase);
    let resp: ChangeResponse;
    try {
      resp = await ctx.client.postChange(ctx.vaultId, req);
    } catch (e) {
      if (e instanceof APIError && e.isVaultFrozen()) {
        throw new CloudSyncError("frozen", "vault 已冻结（套餐降级），无法推送本端版本");
      }
      throw wrapNetworkError(e);
    }
    if (resp.status === "ok") {
      recordLocalState(state, l.localId, resp.assigned_seq, l);
      return;
    }
    curBase = resp.server ? resp.server.seq : resp.expected_base_seq;
  }
  throw new CloudSyncError("network", "强制推送本端版本失败（多次 CAS 冲突）");
}
