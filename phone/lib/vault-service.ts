// ZPass Phone —— Vault 业务层
//
// 对齐 desktop/internal/services/vaultservice.go：
//   - Status / Initialize / Unlock / Lock / ChangeMasterPassword
//   - ListItems / GetItem / CreateItem / UpdateItem / DeleteItem
//
// 与 desktop 的差异：单进程单实例（RN runtime），无 mutex；
//   状态机以 in-memory dek 是否非空表达「已解锁」。

import {
  AAD_DEK,
  AAD_VERIFIER,
  KEY_SIZE,
  SALT_SIZE,
  VERIFIER_PLAINTEXT,
  constantTimeEqual,
  defaultArgon2idParams,
  deriveKEKAsync,
  openAEAD,
  randomBytes,
  sealAEAD,
  utf8,
  utf8Decode,
  validatePasswordStrength,
  wipeBytes,
} from "./crypto";
import {
  buildInitialMeta,
  deleteVaultFile,
  readVaultFile,
  writeVaultFile,
  type EncryptedItemRow,
  type VaultMeta,
} from "./vault-storage";

/* ----------------------------------------------------------------------------
 * 错误类型（前端按 message 分支）
 * -------------------------------------------------------------------------- */

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type VaultErrorCode =
  | "not-initialized"
  | "already-initialized"
  | "locked"
  | "invalid-password"
  | "password-too-weak"
  | "not-found"
  | "corrupt"
  | "io";

/* ----------------------------------------------------------------------------
 * 状态查询
 * -------------------------------------------------------------------------- */

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  itemCount: number;
}

/* ----------------------------------------------------------------------------
 * Item payload —— 后端不解释字段，按 type 透传给前端
 *
 * 与 desktop ItemPayload 一致：id / type / name / fields (任意 record)
 * -------------------------------------------------------------------------- */

export type VaultItemType =
  | "login"
  | "card"
  | "note"
  | "identity"
  | "ssh"
  | "passkey"
  | "totp";

export interface ItemPayload {
  id: string;
  type: VaultItemType;
  name: string;
  fields: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

const VALID_TYPES: ReadonlySet<VaultItemType> = new Set<VaultItemType>([
  "login",
  "card",
  "note",
  "identity",
  "ssh",
  "passkey",
  "totp",
]);

/* ----------------------------------------------------------------------------
 * VaultService —— 单例
 *
 * 内存状态：dek（解锁后持有的明文 DEK，锁定时抹零并置 null）
 * -------------------------------------------------------------------------- */

class VaultService {
  private dek: Uint8Array | null = null;
  private lastTsMs = 0;

  /** 进程内单调时间戳，避免同毫秒冲突 / 时钟回拨 */
  private nowMs(): number {
    const wall = Date.now();
    const next = wall > this.lastTsMs ? wall : this.lastTsMs + 1;
    this.lastTsMs = next;
    return next;
  }

  /** 返回当前 vault 状态（前端路由守卫用） */
  async status(): Promise<VaultStatus> {
    const file = await readVaultFile();
    return {
      initialized: !!file.meta,
      unlocked: this.dek !== null,
      itemCount: this.dek !== null ? file.items.length : 0,
    };
  }

  isUnlocked(): boolean {
    return this.dek !== null;
  }

  /* ------------------------------------------------------------------------ */
  /* Initialize / Unlock / Lock                                               */
  /* ------------------------------------------------------------------------ */

  /** 首次设置主密码，写入 meta，并进入已解锁态 */
  async initialize(password: string): Promise<void> {
    validatePasswordStrength(password);
    const file = await readVaultFile();
    if (file.meta) {
      throw new VaultError("already-initialized", "vault 已初始化");
    }

    const salt = randomBytes(SALT_SIZE);
    const dek = randomBytes(KEY_SIZE);
    const params = defaultArgon2idParams();

    const kek = await deriveKEKAsync(password, salt, params);
    let wrappedDEK: Uint8Array;
    let verifier: Uint8Array;
    try {
      wrappedDEK = sealAEAD(kek, dek, utf8(AAD_DEK));
      verifier = sealAEAD(dek, utf8(VERIFIER_PLAINTEXT), utf8(AAD_VERIFIER));
    } finally {
      wipeBytes(kek);
    }

    const meta = buildInitialMeta(salt, wrappedDEK, verifier);
    await writeVaultFile({ meta, items: [] });

    if (this.dek) wipeBytes(this.dek);
    this.dek = dek;
  }

  /** 输入主密码解锁；任何失败统一返回 invalid-password，不区分原因 */
  async unlock(password: string): Promise<void> {
    if (!password) throw new VaultError("invalid-password", "请输入主密码");

    const file = await readVaultFile();
    if (!file.meta) throw new VaultError("not-initialized", "vault 未初始化");

    let kek: Uint8Array | null = null;
    let dek: Uint8Array | null = null;
    try {
      kek = await deriveKEKAsync(password, file.meta.salt, file.meta.params);
      try {
        dek = openAEAD(kek, file.meta.wrappedDEK, utf8(AAD_DEK));
      } catch {
        throw new VaultError("invalid-password", "主密码错误");
      }
      let verifierPlain: Uint8Array;
      try {
        verifierPlain = openAEAD(dek, file.meta.verifier, utf8(AAD_VERIFIER));
      } catch {
        throw new VaultError("invalid-password", "主密码错误");
      }
      if (utf8Decode(verifierPlain) !== VERIFIER_PLAINTEXT) {
        wipeBytes(verifierPlain);
        throw new VaultError("invalid-password", "主密码错误");
      }
      wipeBytes(verifierPlain);

      if (this.dek) wipeBytes(this.dek);
      this.dek = dek;
      dek = null; // 防止 finally 抹掉刚 install 的 DEK
    } finally {
      if (kek) wipeBytes(kek);
      if (dek) wipeBytes(dek);
    }
  }

  lock(): void {
    if (this.dek) {
      wipeBytes(this.dek);
      this.dek = null;
    }
  }

  /** 修改主密码：用新 KEK 重新包装 DEK，不重写 items */
  async changeMasterPassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    validatePasswordStrength(newPassword);
    if (!this.dek) throw new VaultError("locked", "vault 已锁定");

    const file = await readVaultFile();
    if (!file.meta) throw new VaultError("not-initialized", "vault 未初始化");

    const oldKEK = await deriveKEKAsync(
      oldPassword,
      file.meta.salt,
      file.meta.params,
    );
    let dekFromOld: Uint8Array | null = null;
    try {
      try {
        dekFromOld = openAEAD(oldKEK, file.meta.wrappedDEK, utf8(AAD_DEK));
      } catch {
        throw new VaultError("invalid-password", "原主密码错误");
      }
      if (!constantTimeEqual(dekFromOld, this.dek)) {
        throw new VaultError("invalid-password", "原主密码错误");
      }
    } finally {
      wipeBytes(oldKEK);
      if (dekFromOld) wipeBytes(dekFromOld);
    }

    const newSalt = randomBytes(SALT_SIZE);
    const newParams = defaultArgon2idParams();
    const newKEK = await deriveKEKAsync(newPassword, newSalt, newParams);
    let newWrapped: Uint8Array;
    try {
      newWrapped = sealAEAD(newKEK, this.dek, utf8(AAD_DEK));
    } finally {
      wipeBytes(newKEK);
    }

    const newMeta: VaultMeta = {
      ...file.meta,
      salt: newSalt,
      params: newParams,
      wrappedDEK: newWrapped,
      updatedAt: this.nowMs(),
    };
    await writeVaultFile({ ...file, meta: newMeta });
  }

  /** 物理重置：删除 vault 文件，状态切回未初始化 */
  async reset(): Promise<void> {
    this.lock();
    await deleteVaultFile();
  }

  /* ------------------------------------------------------------------------ */
  /* CRUD                                                                     */
  /* ------------------------------------------------------------------------ */

  /** 获取并解密所有 item */
  async listItems(): Promise<ItemPayload[]> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const out: ItemPayload[] = [];
    for (const row of file.items) {
      try {
        const payload = this.decryptRow(row);
        out.push(payload);
      } catch {
        // 单条解密失败不阻塞全表
        continue;
      }
    }
    return out;
  }

  async getItem(id: string): Promise<ItemPayload | null> {
    this.requireUnlocked();
    if (!id) return null;
    const file = await readVaultFile();
    const row = file.items.find((r) => r.id === id);
    if (!row) return null;
    return this.decryptRow(row);
  }

  /** 新增 item，返回带后端补全字段的完整 payload */
  async createItem(
    type: VaultItemType,
    name: string,
    fields: Record<string, unknown>,
  ): Promise<ItemPayload> {
    this.requireUnlocked();
    if (!VALID_TYPES.has(type)) {
      throw new Error(`非法 item 类型：${type}`);
    }
    if (!name?.trim()) throw new Error("名称不能为空");

    const id = genItemId();
    const now = this.nowMs();
    const payload: ItemPayload = {
      id,
      type,
      name: name.trim(),
      fields: fields ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const file = await readVaultFile();
    const row = this.encryptPayload(payload);
    file.items = [row, ...file.items];
    await writeVaultFile(file);
    return payload;
  }

  /** 整体覆盖 item（按 id 匹配），不存在抛 not-found */
  async updateItem(
    id: string,
    patch: { name?: string; type?: VaultItemType; fields?: Record<string, unknown> },
  ): Promise<ItemPayload> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const idx = file.items.findIndex((r) => r.id === id);
    if (idx === -1) throw new VaultError("not-found", "条目不存在");

    const existing = this.decryptRow(file.items[idx]);
    const next: ItemPayload = {
      ...existing,
      name: patch.name?.trim() ?? existing.name,
      type: patch.type ?? existing.type,
      fields: patch.fields ?? existing.fields,
      updatedAt: this.nowMs(),
    };
    file.items[idx] = this.encryptPayload(next);
    await writeVaultFile(file);
    return next;
  }

  async deleteItem(id: string): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const next = file.items.filter((r) => r.id !== id);
    if (next.length === file.items.length) return; // 静默幂等
    file.items = next;
    await writeVaultFile(file);
  }

  /** 批量导入：每条用新 id + 重新加密 */
  async importItems(
    incoming: Omit<ItemPayload, "id" | "createdAt" | "updatedAt">[],
  ): Promise<number> {
    this.requireUnlocked();
    if (incoming.length === 0) return 0;
    const file = await readVaultFile();
    const now = this.nowMs();
    const rows: EncryptedItemRow[] = incoming.map((it) => {
      const id = genItemId();
      const payload: ItemPayload = {
        id,
        type: it.type,
        name: it.name?.trim() || "未命名",
        fields: it.fields ?? {},
        createdAt: now,
        updatedAt: now,
      };
      return this.encryptPayload(payload);
    });
    file.items = [...rows, ...file.items];
    await writeVaultFile(file);
    return rows.length;
  }

  /** 清空所有 item（保留 meta，不触发重新解锁） */
  async clearAllItems(): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    file.items = [];
    await writeVaultFile(file);
  }

  /* ------------------------------------------------------------------------ */
  /* internals                                                                */
  /* ------------------------------------------------------------------------ */

  private requireUnlocked(): void {
    if (!this.dek) throw new VaultError("locked", "vault 已锁定");
  }

  private encryptPayload(payload: ItemPayload): EncryptedItemRow {
    const plaintext = utf8(JSON.stringify(payload));
    const ciphertext = sealAEAD(this.dek!, plaintext, utf8(payload.id));
    wipeBytes(plaintext);
    return {
      id: payload.id,
      payload: ciphertext,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    };
  }

  private decryptRow(row: EncryptedItemRow): ItemPayload {
    const plaintext = openAEAD(this.dek!, row.payload, utf8(row.id));
    const parsed = JSON.parse(utf8Decode(plaintext)) as ItemPayload;
    // DB 行的时间戳是事实来源
    parsed.createdAt = row.createdAt;
    parsed.updatedAt = row.updatedAt;
    parsed.id = row.id;
    return parsed;
  }
}

/* ----------------------------------------------------------------------------
 * 进程级单例
 * -------------------------------------------------------------------------- */

export const vaultService = new VaultService();

/* ----------------------------------------------------------------------------
 * id 生成 —— 与 desktop newItemID 等价：随机 16 字节 hex
 * -------------------------------------------------------------------------- */

function genItemId(): string {
  const bytes = randomBytes(16);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
