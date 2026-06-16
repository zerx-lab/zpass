// ZPass HarmonyOS —— 云同步本地状态持久化（非 vault、不参与 vault sync 本身）
//
// 落到应用沙箱 filesDir 下的 zpass-cloud-v1.json（与 VaultStorage / AppSettings 同源，
// filesDir 由 EntryAbility.onCreate 写入 AppStorage）。
//
// 存什么 / 不存什么（零知识取舍）：
//   - 存：baseUrl / email / accountId / secretKey(Z1) / JWT token / userId / tenantId /
//         已绑定云 vault 的 {vaultId, cursor} / 每条目同步水位（增量同步用）
//   - 不存：主密码、AUK、账户私钥、per-vault key —— 这些只在内存会话里，随锁定清除。
//   secretKey 单独无法解锁账户（2SKD 需要主密码），token 仅 24h；落沙箱（应用隔离 +
//   设备加密）可接受。更强的 HUKS 包裹留作后续硬化（见 MIGRATION）。
//
// 增量同步的 per-item 水位（对应 desktop cloud_item_state 表）按本地 id 键存：
//   { seq, syncedHash, syncedAt, deleted } —— synced_hash 已是 vault-key 派生的不透明
//   token，不含密钥；用于判定「本地条目自上次收敛后是否变更」与 CAS base_seq。
//
// 写策略：读-改-写整份（与 AppSettings 一致）；损坏/缺失时回退空状态（可经重新登录恢复）。

import { fileIo as fs } from '@kit.CoreFileKit';

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
}

/** 已绑定的云 vault（鸿蒙单文件 vault ↔ 单云 vault，1:1）。 */
export interface CloudVaultBinding {
  vaultId: string;
  /** 上次拉取 snapshot 的高水位 current_seq（增量同步的 delta 起点；0 = 从未对账）。 */
  cursor: number;
}

/** 单条目同步水位（对应 desktop cloud_item_state 行），按本地 id 键存。 */
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
  vault: CloudVaultBinding | null;
  /** 按本地 id 键的 per-item 同步水位（增量同步用）。 */
  syncState: Record<string, CloudItemSyncState> | null;
}

function cloudPath(): string | null {
  const dir = AppStorage.get<string>(FILES_DIR_KEY);
  if (!dir) return null;
  return `${dir}/${CLOUD_FILE}`;
}

function emptyState(): CloudState {
  return { account: null, vault: null, syncState: null };
}

/** 读云状态；不存在/损坏时回退空。 */
export async function loadCloudState(): Promise<CloudState> {
  const path = cloudPath();
  if (!path) return emptyState();
  try {
    if (!(await fs.access(path))) return emptyState();
    const text = await fs.readText(path);
    const parsed = JSON.parse(text) as CloudState;
    return {
      account: normalizeAccount(parsed.account),
      vault: normalizeVault(parsed.vault),
      syncState: normalizeSyncState(parsed.syncState),
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
  };
}

function normalizeVault(v: CloudVaultBinding | null | undefined): CloudVaultBinding | null {
  if (!v || typeof v.vaultId !== 'string' || !v.vaultId) return null;
  return { vaultId: v.vaultId, cursor: typeof v.cursor === 'number' ? v.cursor : 0 };
}

function normalizeSyncState(
  s: Record<string, CloudItemSyncState> | null | undefined,
): Record<string, CloudItemSyncState> | null {
  if (!s || typeof s !== 'object') return null;
  const out: Record<string, CloudItemSyncState> = JSON.parse('{}') as Record<string, CloudItemSyncState>;
  for (const id of Object.keys(s)) {
    const e = s[id];
    if (!e || typeof e.seq !== 'number') continue;
    out[id] = {
      seq: e.seq,
      syncedHash: typeof e.syncedHash === 'string' ? e.syncedHash : '',
      syncedAt: typeof e.syncedAt === 'number' ? e.syncedAt : 0,
      deleted: e.deleted === true,
    };
  }
  return out;
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
