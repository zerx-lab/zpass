// ZPass Phone —— 加密 vault 持久化
//
// 与 desktop/internal/services/vaultdb.go 的角色一致：
//   - 单文件 + 原子写（tmp + rename），相当于 SQLite 的 ACID 替代
//   - 顶层 `meta` 区：salt / kdf params / wrappedDEK / verifier
//   - 顶层 `items` 区：每条 item 的密文（aad=item.id 绑定）
//
// 文件落到 `expo-file-system` 的 documentDirectory（受沙盒保护，应用卸载时清除）。
// JSON 内部全部以 base64 持有二进制，便于跨平台调试与未来导入。

import * as FileSystem from "expo-file-system/legacy";

import {
  type Argon2idParams,
  defaultArgon2idParams,
  fromB64,
  toB64,
  validateArgon2idParams,
} from "./crypto";
import type { Space } from "./spaces";

/* ----------------------------------------------------------------------------
 * 文件路径
 * -------------------------------------------------------------------------- */

const VAULT_FILE = "zpass-vault-v1.json";

function vaultPath(): string {
  return (FileSystem.documentDirectory ?? "") + VAULT_FILE;
}

function tmpPath(): string {
  return vaultPath() + ".tmp";
}

/* ----------------------------------------------------------------------------
 * 内存模型
 * -------------------------------------------------------------------------- */

export interface VaultMeta {
  /** vault 文件 schema 版本 */
  version: number;
  /** KDF 名称（恒为 argon2id，预留升级） */
  kdf: "argon2id";
  /** KDF 盐（每个 vault 一份） */
  salt: Uint8Array;
  /** KDF 参数（Initialize 时记录的版本） */
  params: Argon2idParams;
  /** 用 KEK 包装的 DEK（aad="zpass:dek"） */
  wrappedDEK: Uint8Array;
  /** 用 DEK 加密的 verifier 明文 "zpass-vault-verifier-v1"（aad="zpass:verifier"） */
  verifier: Uint8Array;
  createdAt: number;
  updatedAt: number;
}

export interface EncryptedItemRow {
  /** item 唯一 id（同时作为 AEAD aad） */
  id: string;
  /** 密文（含 nonce + tag），由 VaultService 用 DEK 解出 ItemPayload */
  payload: Uint8Array;
  createdAt: number;
  updatedAt: number;
}

/** 持久化层完整快照（内存中持有的解码后形态） */
export interface VaultFile {
  meta: VaultMeta | null;
  items: EncryptedItemRow[];
  /**
   * 空间列表（plaintext）—— 空间名敏感度低于条目内容，放顶层方便未来
   * 在锁定态下也能展示。旧 vault 文件没有此字段时回退为空数组。
   */
  spaces: Space[];
  /**
   * 当前激活空间 id（plaintext）—— 解锁后用于过滤 items。
   * 没有持久化值时由 VaultService 选择默认空间补齐。
   */
  activeSpaceId: string | null;
}

/* ----------------------------------------------------------------------------
 * JSON wire format
 * -------------------------------------------------------------------------- */

interface MetaJSON {
  version: number;
  kdf: "argon2id";
  salt: string; // base64
  params: Argon2idParams;
  wrappedDEK: string; // base64
  verifier: string; // base64
  createdAt: number;
  updatedAt: number;
}

interface ItemJSON {
  id: string;
  payload: string; // base64
  createdAt: number;
  updatedAt: number;
}

interface FileJSON {
  schema: string;
  meta: MetaJSON | null;
  items: ItemJSON[];
  /** v1 没有此字段；v2 起始落盘 */
  spaces?: Space[];
  activeSpaceId?: string | null;
}

const FILE_SCHEMA = "zpass-vault-file-v1";

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
  return {
    id: r.id,
    payload: toB64(r.payload),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function itemFromJSON(j: ItemJSON): EncryptedItemRow {
  return {
    id: j.id,
    payload: fromB64(j.payload),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

/* ----------------------------------------------------------------------------
 * 读 / 写
 * -------------------------------------------------------------------------- */

/** 读取整个 vault 文件；不存在时返回空快照 */
export async function readVaultFile(): Promise<VaultFile> {
  const path = vaultPath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    return { meta: null, items: [], spaces: [], activeSpaceId: null };
  }
  const text = await FileSystem.readAsStringAsync(path, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  let parsed: FileJSON;
  try {
    parsed = JSON.parse(text) as FileJSON;
  } catch {
    throw new Error("vault 文件解析失败：JSON 损坏");
  }
  if (!parsed || parsed.schema !== FILE_SCHEMA) {
    throw new Error(`vault 文件 schema 不兼容：${parsed?.schema ?? "missing"}`);
  }
  return {
    meta: parsed.meta ? metaFromJSON(parsed.meta) : null,
    items: Array.isArray(parsed.items) ? parsed.items.map(itemFromJSON) : [],
    spaces: Array.isArray(parsed.spaces) ? parsed.spaces : [],
    activeSpaceId:
      typeof parsed.activeSpaceId === "string" ? parsed.activeSpaceId : null,
  };
}

/** 写入整个 vault 文件，使用 tmp + rename 原子替换 */
export async function writeVaultFile(file: VaultFile): Promise<void> {
  const json: FileJSON = {
    schema: FILE_SCHEMA,
    meta: file.meta ? metaToJSON(file.meta) : null,
    items: file.items.map(itemToJSON),
    spaces: file.spaces ?? [],
    activeSpaceId: file.activeSpaceId ?? null,
  };
  const text = JSON.stringify(json);
  const tmp = tmpPath();
  const dst = vaultPath();
  // 写 tmp
  await FileSystem.writeAsStringAsync(tmp, text, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  // 删旧 dst，再 rename tmp → dst（expo-file-system 没有 rename，moveAsync 等价）
  try {
    await FileSystem.deleteAsync(dst, { idempotent: true });
  } catch {
    /* ignore */
  }
  await FileSystem.moveAsync({ from: tmp, to: dst });
}

/** 物理删除 vault（用于"重置保险库"） */
export async function deleteVaultFile(): Promise<void> {
  await FileSystem.deleteAsync(vaultPath(), { idempotent: true });
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
    kdf: "argon2id",
    salt,
    params: defaultArgon2idParams(),
    wrappedDEK,
    verifier,
    createdAt: now,
    updatedAt: now,
  };
}
