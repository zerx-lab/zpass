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
  type VaultFile,
  type VaultMeta,
} from "./vault-storage";
import {
  buildDefaultSpace,
  DEFAULT_SPACE_ID,
  newSpaceId,
  sortSpaces,
  type Space,
} from "./spaces";

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
  | "io"
  | "space-invalid"
  | "space-last";

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
    const def = buildDefaultSpace();
    await writeVaultFile({
      meta,
      items: [],
      spaces: [def],
      activeSpaceId: def.id,
    });

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

    // 兼容旧 vault 文件：解锁后保证至少有一个空间存在；旧 item 的
    // 缺省 spaceId 会被 ItemPayload.fields 默认视为 DEFAULT_SPACE_ID。
    await this.ensureSpacesPersisted();
  }

  /** 若文件里没有 spaces，落盘一个默认空间；幂等 */
  private async ensureSpacesPersisted(): Promise<void> {
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    if (
      file.spaces.length === fixed.spaces.length &&
      file.activeSpaceId === fixed.activeSpaceId
    ) {
      return;
    }
    await writeVaultFile({
      ...file,
      spaces: fixed.spaces,
      activeSpaceId: fixed.activeSpaceId,
    });
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
  /* 空间（Space）管理                                                          */
  /* ------------------------------------------------------------------------ */
  //
  // 设计要点：
  //   - 空间列表 plaintext 存在 vault file 顶层 `spaces` 字段
  //   - activeSpaceId 也 plaintext 存顶层，方便锁定后下次解锁还原现场
  //   - "默认空间"由 ensureDefaultSpace 在解锁 / Initialize 后保证存在；
  //     即使用户删光了空间，下次读取也会自动补一个 default
  //   - 空间不参与加密路径，删除空间不需要重写 items（只是按 spaceId 归位）

  /** 拉取空间快照（不修改文件）。未初始化或锁定状态下也允许只读。 */
  async listSpaces(): Promise<{ spaces: Space[]; activeSpaceId: string }> {
    const file = await readVaultFile();
    const { spaces, activeSpaceId } = ensureDefaultsInSnapshot(file);
    return { spaces: sortSpaces(spaces), activeSpaceId };
  }

  /** 切换激活空间。id 必须存在；不抛错则保证落盘。 */
  async setActiveSpace(id: string): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const exists = fixed.spaces.some((s) => s.id === id);
    if (!exists) throw new VaultError("space-invalid", "空间不存在");
    await writeVaultFile({
      ...file,
      spaces: fixed.spaces,
      activeSpaceId: id,
    });
  }

  /**
   * 新建空间 —— 名称必填、去空白；返回完整记录。
   * order 取当前最大 order + 1，与 UI 显示编号一致。
   */
  async createSpace(name: string): Promise<Space> {
    this.requireUnlocked();
    const trimmed = (name ?? "").trim();
    if (!trimmed) throw new VaultError("space-invalid", "空间名不能为空");
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const maxOrder = fixed.spaces.reduce(
      (m, s) => (s.order > m ? s.order : m),
      0,
    );
    const created: Space = {
      id: newSpaceId(),
      name: trimmed,
      order: maxOrder + 1,
      createdAt: this.nowMs(),
    };
    await writeVaultFile({
      ...file,
      spaces: [...fixed.spaces, created],
      activeSpaceId: fixed.activeSpaceId,
    });
    return created;
  }

  /** 重命名空间（含默认空间） */
  async renameSpace(id: string, name: string): Promise<void> {
    this.requireUnlocked();
    const trimmed = (name ?? "").trim();
    if (!trimmed) throw new VaultError("space-invalid", "空间名不能为空");
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const idx = fixed.spaces.findIndex((s) => s.id === id);
    if (idx === -1) throw new VaultError("space-invalid", "空间不存在");
    const next = fixed.spaces.slice();
    next[idx] = { ...next[idx], name: trimmed };
    await writeVaultFile({
      ...file,
      spaces: next,
      activeSpaceId: fixed.activeSpaceId,
    });
  }

  /**
   * 删除空间 —— 该空间下的所有 item 被迁回默认空间。
   * 不允许删除最后一个空间（至少保留 1 个）。
   */
  async deleteSpace(id: string): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    if (fixed.spaces.length <= 1) {
      throw new VaultError("space-last", "至少需要保留一个空间");
    }
    const target = fixed.spaces.find((s) => s.id === id);
    if (!target) throw new VaultError("space-invalid", "空间不存在");
    const remaining = fixed.spaces.filter((s) => s.id !== id);
    // 选迁移目标：保留集合里的第一个（按 order）
    const fallback = sortSpaces(remaining)[0]?.id ?? DEFAULT_SPACE_ID;
    // 把目标空间下的 item 解密 -> 改 spaceId -> 重新加密
    const nextItems: EncryptedItemRow[] = [];
    for (const row of file.items) {
      try {
        const payload = this.decryptRow(row);
        const curSpace = readSpaceIdFromFields(payload.fields) ?? fixed.activeSpaceId;
        if (curSpace === id) {
          payload.fields = {
            ...(payload.fields ?? {}),
            spaceId: fallback,
          };
          payload.updatedAt = this.nowMs();
          nextItems.push(this.encryptPayload(payload));
        } else {
          nextItems.push(row);
        }
      } catch {
        // 解密失败的 row 原样保留
        nextItems.push(row);
      }
    }
    const nextActive =
      fixed.activeSpaceId === id ? fallback : fixed.activeSpaceId;
    await writeVaultFile({
      ...file,
      items: nextItems,
      spaces: remaining,
      activeSpaceId: nextActive,
    });
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
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    // 显式 spaceId 优先；缺省回落到 activeSpaceId（首次解锁后保证非空）
    const finalFields = { ...(fields ?? {}) };
    if (typeof finalFields.spaceId !== "string" || !finalFields.spaceId) {
      finalFields.spaceId = fixed.activeSpaceId;
    }
    const payload: ItemPayload = {
      id,
      type,
      name: name.trim(),
      fields: finalFields,
      createdAt: now,
      updatedAt: now,
    };
    const row = this.encryptPayload(payload);
    file.items = [row, ...file.items];
    file.spaces = fixed.spaces;
    file.activeSpaceId = fixed.activeSpaceId;
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

  /** 批量导入：每条用新 id + 重新加密；缺省 spaceId 注入当前激活空间 */
  async importItems(
    incoming: Omit<ItemPayload, "id" | "createdAt" | "updatedAt">[],
  ): Promise<number> {
    this.requireUnlocked();
    if (incoming.length === 0) return 0;
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const now = this.nowMs();
    const rows: EncryptedItemRow[] = incoming.map((it) => {
      const id = genItemId();
      const fields = { ...(it.fields ?? {}) };
      if (typeof fields.spaceId !== "string" || !fields.spaceId) {
        fields.spaceId = fixed.activeSpaceId;
      }
      const payload: ItemPayload = {
        id,
        type: it.type,
        name: it.name?.trim() || "未命名",
        fields,
        createdAt: now,
        updatedAt: now,
      };
      return this.encryptPayload(payload);
    });
    file.items = [...rows, ...file.items];
    file.spaces = fixed.spaces;
    file.activeSpaceId = fixed.activeSpaceId;
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

/* ----------------------------------------------------------------------------
 * 空间帮助函数
 * -------------------------------------------------------------------------- */

/**
 * 给 VaultFile 快照补齐"至少一个空间 + 一个有效 activeSpaceId"。
 * 不写入文件，仅返回校准后的值。调用方决定是否落盘。
 */
function ensureDefaultsInSnapshot(file: VaultFile): {
  spaces: Space[];
  activeSpaceId: string;
} {
  const spaces = file.spaces.length > 0 ? file.spaces : [buildDefaultSpace()];
  let active = file.activeSpaceId ?? "";
  const exists = spaces.some((s) => s.id === active);
  if (!exists) active = sortSpaces(spaces)[0].id;
  return { spaces, activeSpaceId: active };
}

/** 从 ItemPayload.fields 安全取出 spaceId（兼容字符串以外的脏值） */
export function readSpaceIdFromFields(
  fields: Record<string, unknown> | undefined,
): string | undefined {
  if (!fields) return undefined;
  const v = fields.spaceId;
  return typeof v === "string" && v ? v : undefined;
}
