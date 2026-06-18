// ZPass HarmonyOS —— 云同步本地状态持久化（非 vault、不参与 vault sync 本身）
//
// 落到应用沙箱 filesDir 下的 zpass-cloud-v1.json（与 VaultStorage / AppSettings 同源，
// filesDir 由 EntryAbility.onCreate 写入 AppStorage）。
//
// 多空间模型（与 desktop cloud_vaults 表对齐）：每个本地空间 ↔ 一个云 vault（1:1），
// 一份账户记录下挂多条 {spaceId, vaultId, cursor} 绑定。自动镜像：未绑定且未被显式
// 解绑（detached）的空间在登录/新建空间时自动创建云 vault。
//
// 存什么 / 不存什么（零知识取舍）：
//   - 存：baseUrl / email / accountId / secretKey(Z1) / JWT token / userId / tenantId /
//         每空间绑定 {spaceId, vaultId, cursor} / 每空间每条目同步水位 / 解绑空间清单 /
//         DEK 包裹的云主密码密文（wrappedPassword，仅 vault 解锁后可解，供静默重建会话）
//   - 不存：明文主密码、AUK、账户私钥、per-vault key —— 这些只在内存会话里，随锁定清除。
//   secretKey 单独无法解锁账户（2SKD 需要主密码），token 仅 24h；落沙箱（应用隔离 +
//   设备加密）可接受。更强的 HUKS 包裹留作后续硬化（见 MIGRATION）。
//
// 增量同步的 per-item 水位（对应 desktop cloud_item_state 表）按 [spaceId][本地 id] 嵌套存：
//   { seq, syncedHash, syncedAt, deleted } —— synced_hash 已是 vault-key 派生的不透明
//   token，不含密钥；用于判定「本地条目自上次收敛后是否变更」与 CAS base_seq。
//
// 写策略：读-改-写整份（与 AppSettings 一致）；损坏/缺失时回退空状态（可经重新登录恢复）。
// 旧版单 vault 格式（{vault, 扁平 syncState}）在 load 时迁移到默认空间。

import { fileIo as fs } from '@kit.CoreFileKit';
import { DEFAULT_SPACE_ID } from './Spaces';

const CLOUD_FILE: string = 'zpass-cloud-v1.json';
const FILES_DIR_KEY: string = 'filesDir';

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
  /** HUKS 加密的 {secretKey, token} base64 blob；非空时上方 secretKey/token 留空（明文回退才用）。 */
  secrets: string;
  /**
   * DEK 包裹的云账户主密码密文 base64（VaultService.sealCloudCredential 产物）。仅在本地 vault
   * 解锁后可解 —— 供解锁（含信任设备/生物识别，无主密码）时静默重建云会话，且兼容本地解锁密码
   * ≠ 云密码。这不是明文主密码：密文离开 DEK（受主密码或信任设备 HUKS 保护）即无用，符合零知识。
   */
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
 * 旧版 / 原始读入形状（兼容迁移用，逐字段 typeof 校验）
 * -------------------------------------------------------------------------- */

interface RawSingleVault {
  vaultId?: string;
  cursor?: number;
}

interface RawCloudState {
  account?: CloudAccountRecord | null;
  /** 旧版单 vault 绑定（无 spaceId）。 */
  vault?: RawSingleVault | null;
  /** 新版每空间绑定。 */
  vaults?: CloudVaultBinding[] | null;
  /** 形状二义：旧版为 Record<itemId, state>，新版为 Record<spaceId, Record<itemId, state>>。 */
  syncState?: Record<string, Object> | null;
  detached?: string[] | null;
  tombstoneCursor?: number;
  pendingRemoteDeletes?: string[] | null;
}

function cloudPath(): string | null {
  const dir = AppStorage.get<string>(FILES_DIR_KEY);
  if (!dir) return null;
  return `${dir}/${CLOUD_FILE}`;
}

function emptyState(): CloudState {
  return { account: null, vaults: [], syncState: null, detached: null, tombstoneCursor: 0, pendingRemoteDeletes: null };
}

/** 读云状态；不存在/损坏时回退空。旧版单 vault 格式自动迁移到默认空间。 */
export async function loadCloudState(): Promise<CloudState> {
  const path = cloudPath();
  if (!path) return emptyState();
  try {
    if (!(await fs.access(path))) return emptyState();
    const text = await fs.readText(path);
    const parsed = JSON.parse(text) as RawCloudState;
    return {
      account: normalizeAccount(parsed.account),
      vaults: normalizeVaults(parsed),
      syncState: normalizeSyncState(parsed.syncState),
      detached: normalizeDetached(parsed.detached),
      tombstoneCursor: typeof parsed.tombstoneCursor === 'number' ? parsed.tombstoneCursor : 0,
      pendingRemoteDeletes: normalizeDetached(parsed.pendingRemoteDeletes),
    };
  } catch (_e) {
    return emptyState();
  }
}

function normalizeAccount(a: CloudAccountRecord | null | undefined): CloudAccountRecord | null {
  if (!a || typeof a.email !== 'string') return null;
  return {
    baseUrl: typeof a.baseUrl === 'string' ? a.baseUrl : '',
    email: a.email,
    accountId: typeof a.accountId === 'string' ? a.accountId : '',
    secretKey: typeof a.secretKey === 'string' ? a.secretKey : '',
    token: typeof a.token === 'string' ? a.token : '',
    userId: typeof a.userId === 'string' ? a.userId : '',
    tenantId: typeof a.tenantId === 'string' ? a.tenantId : '',
    secrets: typeof a.secrets === 'string' ? a.secrets : '',
    wrappedPassword: typeof a.wrappedPassword === 'string' ? a.wrappedPassword : '',
  };
}

/** 归一化每空间绑定；新版优先，否则把旧版单 vault 迁移到默认空间。 */
function normalizeVaults(parsed: RawCloudState): CloudVaultBinding[] {
  const out: CloudVaultBinding[] = [];
  const seenSpace = new Set<string>();
  const seenVault = new Set<string>();
  const arr = parsed.vaults;
  if (arr && Array.isArray(arr)) {
    for (const v of arr) {
      if (!v || typeof v.vaultId !== 'string' || !v.vaultId) continue;
      const spaceId = typeof v.spaceId === 'string' && v.spaceId ? v.spaceId : DEFAULT_SPACE_ID;
      if (seenSpace.has(spaceId) || seenVault.has(v.vaultId)) continue; // 1:1 去重
      seenSpace.add(spaceId);
      seenVault.add(v.vaultId);
      out.push({ spaceId, vaultId: v.vaultId, cursor: typeof v.cursor === 'number' ? v.cursor : 0 });
    }
    return out;
  }
  // 旧版迁移：单 vault → 默认空间
  const legacy = parsed.vault;
  if (legacy && typeof legacy.vaultId === 'string' && legacy.vaultId) {
    out.push({
      spaceId: DEFAULT_SPACE_ID,
      vaultId: legacy.vaultId,
      cursor: typeof legacy.cursor === 'number' ? legacy.cursor : 0,
    });
  }
  return out;
}

/** 某个值是否「扁平 item 水位」（旧版形状判定）。 */
function looksLikeItemState(v: Object | undefined | null): boolean {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, Object>;
  return typeof r.seq === 'number';
}

function normalizeItemState(e: CloudItemSyncState | undefined | null): CloudItemSyncState | null {
  if (!e || typeof e.seq !== 'number') return null;
  return {
    seq: e.seq,
    syncedHash: typeof e.syncedHash === 'string' ? e.syncedHash : '',
    syncedAt: typeof e.syncedAt === 'number' ? e.syncedAt : 0,
    deleted: e.deleted === true,
  };
}

function normalizeFlatStates(
  s: Record<string, CloudItemSyncState>,
): Record<string, CloudItemSyncState> {
  const out: Record<string, CloudItemSyncState> = JSON.parse('{}') as Record<string, CloudItemSyncState>;
  for (const id of Object.keys(s)) {
    const st = normalizeItemState(s[id]);
    if (st) out[id] = st;
  }
  return out;
}

/**
 * 归一化 syncState；二义形状自动判定：
 *   - 旧版 Record<itemId, state>（值含数字 seq）→ 整体挪到默认空间。
 *   - 新版 Record<spaceId, Record<itemId, state>> → 逐空间归一化。
 */
function normalizeSyncState(
  s: Record<string, Object> | null | undefined,
): Record<string, Record<string, CloudItemSyncState>> | null {
  if (!s || typeof s !== 'object') return null;
  const keys = Object.keys(s);
  if (keys.length === 0) return null;
  const out: Record<string, Record<string, CloudItemSyncState>> =
    JSON.parse('{}') as Record<string, Record<string, CloudItemSyncState>>;
  // 旧版扁平：首个值像 item 水位
  if (looksLikeItemState(s[keys[0]])) {
    out[DEFAULT_SPACE_ID] = normalizeFlatStates(s as Record<string, CloudItemSyncState>);
    return out;
  }
  // 新版嵌套：每个 key 是 spaceId
  for (const spaceId of keys) {
    const inner = s[spaceId];
    if (!inner || typeof inner !== 'object') continue;
    out[spaceId] = normalizeFlatStates(inner as Record<string, CloudItemSyncState>);
  }
  return out;
}

function normalizeDetached(d: string[] | null | undefined): string[] | null {
  if (!d || !Array.isArray(d)) return null;
  const out: string[] = [];
  for (const id of d) {
    if (typeof id === 'string' && id && out.indexOf(id) < 0) out.push(id);
  }
  return out.length > 0 ? out : null;
}

/** 写整份云状态。失败抛错（调用方决定是否吞掉）。 */
export async function saveCloudState(state: CloudState): Promise<void> {
  const path = cloudPath();
  if (!path) throw new Error('filesDir 未初始化');
  const handle = await fs.open(
    path,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC,
  );
  try {
    await fs.write(handle.fd, JSON.stringify(state));
  } finally {
    await fs.close(handle.fd);
  }
}

/** 清空云状态（登出 / 重置）。 */
export async function clearCloudState(): Promise<void> {
  const path = cloudPath();
  if (!path) return;
  try {
    if (await fs.access(path)) await fs.unlink(path);
  } catch (_e) {
    // 静默：删失败不阻塞登出（下次写会覆盖）
  }
}

/* ----------------------------------------------------------------------------
 * 换账户归属残留（仅记录"上一个云账户绑定过哪些本地空间"，无任何密钥）
 *
 * 为什么要它：signOut 会 clearCloudState() 删整份主状态（含全部密钥/绑定），
 * 于是换账户登录 B 时已无从知道哪些本地空间曾属于上一个账户 A。若不区分，
 * doReconcile 会把 A 残留的云空间当作"本地待上云"撑爆 B 配额（致 B 无法同步）
 * 或按同名误领养（串账）。但又**不能整库重置**——用户可能有从不上云的纯本地空间，
 * 那些必须保留。
 *
 * 解法：signOut 把"当前账户 accountId + 它绑定过的 spaceId 列表"写入这份独立的
 * 无密钥残留文件。换账户 B 登录、其 accountId ≠ 残留 accountId 时，只清理残留里
 * 列出的（曾被 A 云绑定的）空间；纯本地空间从不进入此列表，天然保留。消费后删除。
 * -------------------------------------------------------------------------- */

const OWNER_FILE: string = 'zpass-cloud-owner-v1.json';

/** 上一个云账户的归属残留：哪个账户、绑定过哪些本地空间。 */
export interface CloudOwnerResidue {
  accountId: string;
  spaceIds: string[];
}

function ownerPath(): string | null {
  const dir = AppStorage.get<string>(FILES_DIR_KEY);
  if (!dir) return null;
  return `${dir}/${OWNER_FILE}`;
}

/** 写归属残留（signOut 调用）。失败静默——它只是优化换号清理的提示，不阻塞登出。 */
export async function saveCloudOwnerResidue(residue: CloudOwnerResidue): Promise<void> {
  const path = ownerPath();
  if (!path) return;
  try {
    const handle = await fs.open(
      path,
      fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC,
    );
    try {
      await fs.write(handle.fd, JSON.stringify(residue));
    } finally {
      await fs.close(handle.fd);
    }
  } catch (_e) {
    // 静默
  }
}

/** 读归属残留；不存在/损坏返回 null。 */
export async function loadCloudOwnerResidue(): Promise<CloudOwnerResidue | null> {
  const path = ownerPath();
  if (!path) return null;
  try {
    if (!(await fs.access(path))) return null;
    const parsed = JSON.parse(await fs.readText(path)) as CloudOwnerResidue;
    if (!parsed || typeof parsed.accountId !== 'string' || !Array.isArray(parsed.spaceIds)) return null;
    const spaceIds: string[] = [];
    for (const id of parsed.spaceIds) {
      if (typeof id === 'string' && id && spaceIds.indexOf(id) < 0) spaceIds.push(id);
    }
    return { accountId: parsed.accountId, spaceIds };
  } catch (_e) {
    return null;
  }
}

/** 删除归属残留（消费后 / 同账户重登）。 */
export async function clearCloudOwnerResidue(): Promise<void> {
  const path = ownerPath();
  if (!path) return;
  try {
    if (await fs.access(path)) await fs.unlink(path);
  } catch (_e) {
    // 静默
  }
}
