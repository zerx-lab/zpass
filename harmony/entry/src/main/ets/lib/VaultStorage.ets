// ZPass HarmonyOS —— 加密 vault 持久化
//
// 与 phone/lib/vault-storage.ts 行为对齐：
//   - 单文件 + 原子写（tmp + rename）
//   - 顶层 meta 区：salt / kdf params / wrappedDEK / verifier
//   - 顶层 items 区：每条 item 的密文（aad=item.id）
//
// 文件落到应用沙箱 filesDir（卸载随之清除），由 EntryAbility 初始化时
// 写入 AppStorage 的 'filesDir' 上下文字段。

import { fileIo as fs } from '@kit.CoreFileKit';
import {
  defaultArgon2idParams,
  fromB64,
  toB64,
  validateArgon2idParams,
  type Argon2idParams,
} from './Crypto';
import type { Space } from './Spaces';

/* ----------------------------------------------------------------------------
 * 文件路径
 *
 * filesDir 由 EntryAbility.onCreate 时写入 AppStorage。VaultStorage 在每次
 * 操作前从 AppStorage 读取，避免硬编码绝对路径（沙箱路径在 OHOS 5+ 可变）。
 * -------------------------------------------------------------------------- */

const VAULT_FILE: string = 'zpass-vault-v1.json';
const FILES_DIR_KEY: string = 'filesDir';

function filesDir(): string {
  const dir = AppStorage.get<string>(FILES_DIR_KEY);
  if (!dir) {
    throw new Error(
      'filesDir 未初始化；请确保 EntryAbility.onCreate 已写入 AppStorage',
    );
  }
  return dir;
}

function vaultPath(): string {
  return `${filesDir()}/${VAULT_FILE}`;
}

function tmpPath(): string {
  return `${vaultPath()}.tmp`;
}

/* ----------------------------------------------------------------------------
 * 内存模型
 * -------------------------------------------------------------------------- */

export interface VaultMeta {
  /** vault 文件 schema 版本 */
  version: number;
  /** KDF 名称（恒为 argon2id） */
  kdf: 'argon2id';
  /** KDF 盐 */
  salt: Uint8Array;
  /** KDF 参数 */
  params: Argon2idParams;
  /** 用 KEK 包装的 DEK（aad="zpass:dek"） */
  wrappedDEK: Uint8Array;
  /** 用 DEK 加密的 verifier（aad="zpass:verifier"） */
  verifier: Uint8Array;
  createdAt: number;
  updatedAt: number;
}

export interface EncryptedItemRow {
  id: string;
  payload: Uint8Array;
  createdAt: number;
  updatedAt: number;
  /** 软删除时间戳 —— null/缺省 = 未删除 */
  deletedAt?: number | null;
}

/** 信任设备包装 DEK 的单例行 —— 与 desktop / phone 表对齐 */
export interface TrustedDeviceRow {
  method: string;
  blob: Uint8Array;
  createdAt: number;
}

/** 持久化层完整快照 */
export interface VaultFile {
  meta: VaultMeta | null;
  items: EncryptedItemRow[];
  spaces: Space[];
  activeSpaceId: string | null;
  trustedDevice: TrustedDeviceRow | null;
}

/* ----------------------------------------------------------------------------
 * JSON wire format
 * -------------------------------------------------------------------------- */

interface MetaJSON {
  version: number;
  kdf: 'argon2id';
  salt: string; // base64
  params: Argon2idParams;
  wrappedDEK: string;
  verifier: string;
  createdAt: number;
  updatedAt: number;
}

interface ItemJSON {
  id: string;
  payload: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

interface TrustedDeviceJSON {
  method: string;
  blob: string;
  createdAt: number;
}

interface FileJSON {
  schema: string;
  meta: MetaJSON | null;
  items: ItemJSON[];
  spaces?: Space[];
  activeSpaceId?: string | null;
  trustedDevice?: TrustedDeviceJSON | null;
}

const FILE_SCHEMA: string = 'zpass-vault-file-v1';

/* ----------------------------------------------------------------------------
 * 编解码
 * -------------------------------------------------------------------------- */

function metaToJSON(m: VaultMeta): MetaJSON {
  return {
    version: m.version,
    kdf: m.kdf,
    salt: toB64(m.salt),
    params: m.params,
    wrappedDEK: toB64(m.wrappedDEK),
    verifier: toB64(m.verifier),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function metaFromJSON(j: MetaJSON): VaultMeta {
  validateArgon2idParams(j.params);
  return {
    version: j.version,
    kdf: j.kdf,
    salt: fromB64(j.salt),
    params: j.params,
    wrappedDEK: fromB64(j.wrappedDEK),
    verifier: fromB64(j.verifier),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

function itemToJSON(r: EncryptedItemRow): ItemJSON {
  const out: ItemJSON = {
    id: r.id,
    payload: toB64(r.payload),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (typeof r.deletedAt === 'number' && r.deletedAt > 0) {
    out.deletedAt = r.deletedAt;
  }
  return out;
}

function itemFromJSON(j: ItemJSON): EncryptedItemRow {
  return {
    id: j.id,
    payload: fromB64(j.payload),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    deletedAt:
      typeof j.deletedAt === 'number' && j.deletedAt > 0 ? j.deletedAt : null,
  };
}

function trustedDeviceToJSON(r: TrustedDeviceRow): TrustedDeviceJSON {
  return {
    method: r.method,
    blob: toB64(r.blob),
    createdAt: r.createdAt,
  };
}

function trustedDeviceFromJSON(
  j: TrustedDeviceJSON | null | undefined,
): TrustedDeviceRow | null {
  if (!j) return null;
  if (typeof j.method !== 'string' || !j.method) return null;
  if (typeof j.blob !== 'string' || !j.blob) return null;
  const blob = fromB64(j.blob);
  if (blob.length === 0) return null;
  const createdAt = typeof j.createdAt === 'number' ? j.createdAt : 0;
  return { method: j.method, blob, createdAt };
}

/* ----------------------------------------------------------------------------
 * 底层 IO —— @ohos.file.fs
 *
 * 鸿蒙的 fs 接口与 Node.js 有差异：
 *  - open + write/read + close 三步（不是 writeFile 一步搞定）
 *  - fs.access(path) 是 boolean Promise
 *  - rename 用 fs.moveFile(src, dst)；目标若存在需要先 unlink
 * -------------------------------------------------------------------------- */

async function exists(path: string): Promise<boolean> {
  try {
    return await fs.access(path);
  } catch (_e) {
    return false;
  }
}

async function readText(path: string): Promise<string> {
  // OHOS fs.readText 是顶层便捷函数；读 UTF-8 文本一行流式
  return fs.readText(path);
}

async function writeText(path: string, text: string): Promise<void> {
  // O_WRONLY | O_CREAT | O_TRUNC = 0o2 | 0o100 | 0o1000 = 0x4002 in OHOS
  // 直接用 fs.OpenMode 常量更稳
  const handle = await fs.open(
    path,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC,
  );
  try {
    await fs.write(handle.fd, text);
  } finally {
    await fs.close(handle.fd);
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  if (await exists(path)) {
    await fs.unlink(path);
  }
}

/* ----------------------------------------------------------------------------
 * 读 / 写
 * -------------------------------------------------------------------------- */

/** 读取整个 vault 文件；不存在时返回空快照 */
export async function readVaultFile(): Promise<VaultFile> {
  const path = vaultPath();
  if (!(await exists(path))) {
    return {
      meta: null,
      items: [],
      spaces: [],
      activeSpaceId: null,
      trustedDevice: null,
    };
  }
  const text = await readText(path);
  let parsed: FileJSON;
  try {
    parsed = JSON.parse(text) as FileJSON;
  } catch {
    throw new Error('vault 文件解析失败：JSON 损坏');
  }
  if (!parsed || parsed.schema !== FILE_SCHEMA) {
    const got = parsed && parsed.schema ? parsed.schema : 'missing';
    throw new Error(`vault 文件 schema 不兼容：${got}`);
  }
  return {
    meta: parsed.meta ? metaFromJSON(parsed.meta) : null,
    items: Array.isArray(parsed.items) ? parsed.items.map(itemFromJSON) : [],
    spaces: Array.isArray(parsed.spaces) ? parsed.spaces : [],
    activeSpaceId:
      typeof parsed.activeSpaceId === 'string' ? parsed.activeSpaceId : null,
    trustedDevice: trustedDeviceFromJSON(parsed.trustedDevice),
  };
}

/** 写入整个 vault 文件，tmp + rename 原子替换 */
export async function writeVaultFile(file: VaultFile): Promise<void> {
  const json: FileJSON = {
    schema: FILE_SCHEMA,
    meta: file.meta ? metaToJSON(file.meta) : null,
    items: file.items.map(itemToJSON),
    spaces: file.spaces ?? [],
    activeSpaceId: file.activeSpaceId ?? null,
    trustedDevice: file.trustedDevice
      ? trustedDeviceToJSON(file.trustedDevice)
      : null,
  };
  const text = JSON.stringify(json);
  const tmp = tmpPath();
  const dst = vaultPath();
  await writeText(tmp, text);
  // OHOS fs.moveFile 在目标存在时会失败 —— 先 unlink 旧文件
  await unlinkIfExists(dst);
  await fs.moveFile(tmp, dst);
}

/** 物理删除 vault */
export async function deleteVaultFile(): Promise<void> {
  await unlinkIfExists(vaultPath());
  await unlinkIfExists(tmpPath());
}

/* ----------------------------------------------------------------------------
 * 工厂
 * -------------------------------------------------------------------------- */

/** 初始 meta —— Initialize 时构造（params 取当前默认） */
export function buildInitialMeta(
  salt: Uint8Array,
  wrappedDEK: Uint8Array,
  verifier: Uint8Array,
): VaultMeta {
  const now = Date.now();
  return {
    version: 1,
    kdf: 'argon2id',
    salt,
    params: defaultArgon2idParams(),
    wrappedDEK,
    verifier,
    createdAt: now,
    updatedAt: now,
  };
}
