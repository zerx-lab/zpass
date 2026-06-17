// ZPass Phone —— 云同步本地状态持久化（非 vault、不参与 vault sync 本身）
//
// 落到 expo-file-system 的 documentDirectory 下的 zpass-cloud-v1.json
// （与 vault-storage 同源沙盒，应用卸载时清除）。
//
// 多空间模型（与 desktop cloud_vaults 表对齐）：每个本地空间 ↔ 一个云 vault（1:1），
// 一份账户记录下挂多条 {spaceId, vaultId, cursor} 绑定。
//
// 存什么 / 不存什么（零知识取舍）：
//   - 存：baseUrl / email / accountId / secretKey(Z1) / JWT token / userId / tenantId /
//         secrets（加密的 {secretKey, token} blob）/ 每空间绑定 {spaceId, vaultId, cursor} /
//         每空间每条目同步水位 / 解绑空间清单 / 墓碑游标 / 待删除云 vault 清单。
//   - 不存：明文主密码、AUK、账户私钥、per-vault key —— 这些只在内存会话里，随锁定清除。
//   主密码不落盘：自动恢复时由 vault 解锁事件回灌（cloud-service.onVaultUnlocked）。
//
// 增量同步的 per-item 水位（对应 desktop cloud_item_state 表）按 [spaceId][本地 id] 嵌套存：
//   { seq, syncedHash, syncedAt, deleted } —— syncedHash 已是 vault-key 派生的不透明
//   token，不含密钥；用于判定「本地条目自上次收敛后是否变更」与 CAS base_seq。
//
// 写策略：读-改-写整份；损坏/缺失时回退空状态（可经重新登录恢复）。

import * as FileSystem from "expo-file-system/legacy";

import { DEFAULT_SPACE_ID } from "./spaces";

const CLOUD_FILE = "zpass-cloud-v1.json";

/* ----------------------------------------------------------------------------
 * 内存模型（字段名即 JSON wire key，跨端逐字段对齐）
 * -------------------------------------------------------------------------- */

/** 持久化的云账户记录。 */
export interface CloudAccountRecord {
  baseUrl: string;
  email: string;
  /** Secret Key 的 6 字符 account id（便于展示，派生时从 secretKey 重解析）。 */
  accountId: string;
  /** 完整 Z1 Secret Key 串。 */
  secretKey: string;
  /** 当前 JWT 会话 token（24h）。 */
  token: string;
  userId: string;
  tenantId: string;
  /** 加密的 {secretKey, token} base64 blob；非空时上方 secretKey/token 留空（明文回退才用）。 */
  secrets: string;
  /** DEK 包裹的云主密码密文（base64）；仅本机解锁后解出静默重建会话，'' 表示未封装。 */
  wrappedPassword: string;
}

/** 一条空间 ↔ 云 vault 绑定（多空间下每空间一条；对应 desktop cloud_vaults 行）。 */
export interface CloudVaultBinding {
  /** 本地空间 id（默认空间为 'default'）。 */
  spaceId: string;
  /** 服务端分配的云 vault id。 */
  vaultId: string;
  /** 上次拉取 snapshot 的高水位 current_seq（增量同步的 delta 起点；0 = 从未对账）。 */
  cursor: number;
}

/** 单条目同步水位（对应 desktop cloud_item_state 行），按 [spaceId][本地 id] 嵌套键存。 */
export interface CloudItemSyncState {
  /** 该条目最后已知的服务端 seq —— CAS base_seq 来源。 */
  seq: number;
  /** 收敛时的本地规范化 content hash（cloudContentHash）；墓碑为 ''。 */
  syncedHash: string;
  /** 收敛时本地行的 updatedAt —— 本地 updatedAt 超过它即视为本地变更候选。 */
  syncedAt: number;
  /** 收敛时服务端是否为墓碑。 */
  deleted: boolean;
}

export interface CloudState {
  account: CloudAccountRecord | null;
  /** 每空间绑定（无绑定为空数组）。 */
  vaults: CloudVaultBinding[];
  /** 嵌套 per-space per-item 同步水位：syncState[spaceId][itemId]。 */
  syncState: Record<string, Record<string, CloudItemSyncState>> | null;
  /** 用户显式解绑、不参与自动镜像的 spaceId 列表。 */
  detached: string[] | null;
  /** vault 删除墓碑游标（已处理到的最大 seq；单调推进，按当前账户解释）。 */
  tombstoneCursor: number;
  /** 待删除的云 vault id 列表（本端发起删除失败，reconcile 幂等重试）。 */
  pendingRemoteDeletes: string[] | null;
}

/* ----------------------------------------------------------------------------
 * 原始读入形状（逐字段 typeof 校验，不信任磁盘上的 JSON）
 * -------------------------------------------------------------------------- */

interface RawAccount {
  baseUrl?: unknown;
  email?: unknown;
  accountId?: unknown;
  secretKey?: unknown;
  token?: unknown;
  userId?: unknown;
  tenantId?: unknown;
  secrets?: unknown;
  wrappedPassword?: unknown;
}

interface RawVault {
  spaceId?: unknown;
  vaultId?: unknown;
  cursor?: unknown;
}

interface RawItemState {
  seq?: unknown;
  syncedHash?: unknown;
  syncedAt?: unknown;
  deleted?: unknown;
}

interface RawCloudState {
  account?: unknown;
  vaults?: unknown;
  syncState?: unknown;
  detached?: unknown;
  tombstoneCursor?: unknown;
  pendingRemoteDeletes?: unknown;
}

/* ----------------------------------------------------------------------------
 * 路径
 * -------------------------------------------------------------------------- */

function cloudPath(): string {
  return (FileSystem.documentDirectory ?? "") + CLOUD_FILE;
}

/* ----------------------------------------------------------------------------
 * 读 / 写 / 清空
 * -------------------------------------------------------------------------- */

/** 读云状态；不存在/损坏时回退空。 */
export async function loadCloudState(): Promise<CloudState> {
  const path = cloudPath();
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      const text = await FileSystem.readAsStringAsync(path, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const parsed = JSON.parse(text) as RawCloudState;
      return {
        account: normalizeAccount(parsed.account),
        vaults: normalizeVaults(parsed.vaults),
        syncState: normalizeSyncState(parsed.syncState),
        detached: normalizeDetached(parsed.detached),
        tombstoneCursor:
          typeof parsed.tombstoneCursor === "number"
            ? parsed.tombstoneCursor
            : 0,
        pendingRemoteDeletes: normalizeDetached(parsed.pendingRemoteDeletes),
      };
    }
  } catch {
    // 缺失 / 损坏 → 回退空状态
  }
  return {
    account: null,
    vaults: [],
    syncState: null,
    detached: null,
    tombstoneCursor: 0,
    pendingRemoteDeletes: null,
  };
}

/** 写整份云状态。失败抛错（调用方决定是否吞掉）。 */
export async function saveCloudState(state: CloudState): Promise<void> {
  const json = JSON.stringify(state);
  await FileSystem.writeAsStringAsync(cloudPath(), json, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

/** 清空云状态（登出 / 重置）。删失败静默吞掉，不阻塞流程。 */
export async function clearCloudState(): Promise<void> {
  try {
    await FileSystem.deleteAsync(cloudPath(), { idempotent: true });
  } catch {
    // 静默：删失败不阻塞登出（下次写会覆盖）
  }
}

/* ----------------------------------------------------------------------------
 * 归一化（逐字段 typeof 校验）
 * -------------------------------------------------------------------------- */

function normalizeAccount(a: unknown): CloudAccountRecord | null {
  if (!a || typeof a !== "object") return null;
  const r = a as RawAccount;
  if (typeof r.email !== "string") return null;
  return {
    baseUrl: typeof r.baseUrl === "string" ? r.baseUrl : "",
    email: r.email,
    accountId: typeof r.accountId === "string" ? r.accountId : "",
    secretKey: typeof r.secretKey === "string" ? r.secretKey : "",
    token: typeof r.token === "string" ? r.token : "",
    userId: typeof r.userId === "string" ? r.userId : "",
    tenantId: typeof r.tenantId === "string" ? r.tenantId : "",
    secrets: typeof r.secrets === "string" ? r.secrets : "",
    wrappedPassword: typeof r.wrappedPassword === "string" ? r.wrappedPassword : "",
  };
}

/** 归一化每空间绑定（仅新版数组形态）；按 spaceId 与 vaultId 1:1 去重。 */
function normalizeVaults(arr: unknown): CloudVaultBinding[] {
  const out: CloudVaultBinding[] = [];
  if (!Array.isArray(arr)) return out;
  const seenSpace = new Set<string>();
  const seenVault = new Set<string>();
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as RawVault;
    if (typeof v.vaultId !== "string" || !v.vaultId) continue;
    const spaceId =
      typeof v.spaceId === "string" && v.spaceId ? v.spaceId : DEFAULT_SPACE_ID;
    if (seenSpace.has(spaceId) || seenVault.has(v.vaultId)) continue; // 1:1 去重
    seenSpace.add(spaceId);
    seenVault.add(v.vaultId);
    out.push({
      spaceId,
      vaultId: v.vaultId,
      cursor: typeof v.cursor === "number" ? v.cursor : 0,
    });
  }
  return out;
}

function normalizeItemState(e: unknown): CloudItemSyncState | null {
  if (!e || typeof e !== "object") return null;
  const r = e as RawItemState;
  if (typeof r.seq !== "number") return null;
  return {
    seq: r.seq,
    syncedHash: typeof r.syncedHash === "string" ? r.syncedHash : "",
    syncedAt: typeof r.syncedAt === "number" ? r.syncedAt : 0,
    deleted: r.deleted === true,
  };
}

/** 归一化嵌套 syncState[spaceId][itemId]；全空时回退 null。 */
function normalizeSyncState(
  s: unknown,
): Record<string, Record<string, CloudItemSyncState>> | null {
  if (!s || typeof s !== "object") return null;
  const src = s as Record<string, unknown>;
  const out: Record<string, Record<string, CloudItemSyncState>> = {};
  for (const spaceId of Object.keys(src)) {
    const inner = src[spaceId];
    if (!inner || typeof inner !== "object") continue;
    const innerSrc = inner as Record<string, unknown>;
    const innerOut: Record<string, CloudItemSyncState> = {};
    for (const itemId of Object.keys(innerSrc)) {
      const st = normalizeItemState(innerSrc[itemId]);
      if (st) innerOut[itemId] = st;
    }
    out[spaceId] = innerOut;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 归一化字符串 id 列表：去空、去重；空列表回退 null。 */
function normalizeDetached(d: unknown): string[] | null {
  if (!Array.isArray(d)) return null;
  const out: string[] = [];
  for (const id of d) {
    if (typeof id === "string" && id && out.indexOf(id) < 0) out.push(id);
  }
  return out.length > 0 ? out : null;
}
