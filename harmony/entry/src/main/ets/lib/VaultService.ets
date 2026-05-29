// ZPass HarmonyOS —— Vault 业务层
//
// 与 phone/lib/vault-service.ts / desktop vaultservice.go 行为对齐：
//   - Status / Initialize / Unlock / Lock / ChangeMasterPassword
//   - ListItems / GetItem / CreateItem / UpdateItem / DeleteItem
//   - Space CRUD
//   - IsTrustedDeviceSupported / Enable / Disable / TryUnlock
//
// 鸿蒙特有：信任设备 WrapKey 走 @kit.UniversalKeystoreKit (HUKS)，
// 与 phone 的 expo-secure-store 角色一致（绑定设备的密钥仓 + 生物识别保护）。

import {
  AAD_DEK,
  AAD_TRUSTED_DEVICE,
  AAD_VERIFIER,
  constantTimeEqual,
  defaultArgon2idParams,
  deriveKEKAsync,
  KEY_SIZE,
  openAEAD,
  randomBytes,
  SALT_SIZE,
  sealAEAD,
  utf8,
  utf8Decode,
  validatePasswordStrength,
  VERIFIER_PLAINTEXT,
  wipeBytes,
} from './Crypto';
import {
  buildInitialMeta,
  deleteVaultFile,
  readVaultFile,
  writeVaultFile,
  type EncryptedItemRow,
  type TrustedDeviceRow,
  type VaultFile,
  type VaultMeta,
} from './VaultStorage';
import {
  buildDefaultSpace,
  DEFAULT_SPACE_ID,
  newSpaceId,
  sortSpaces,
  type Space,
} from './Spaces';
import { readTrustedWrapKey, writeTrustedWrapKey, deleteTrustedWrapKey, isTrustedKeystoreSupported } from './TrustedDeviceHuks';

/* ----------------------------------------------------------------------------
 * 错误类型
 * -------------------------------------------------------------------------- */

export type VaultErrorCode =
  | 'not-initialized'
  | 'already-initialized'
  | 'locked'
  | 'invalid-password'
  | 'password-too-weak'
  | 'not-found'
  | 'corrupt'
  | 'io'
  | 'space-invalid'
  | 'space-last'
  | 'trusted-unsupported';

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/* ----------------------------------------------------------------------------
 * 信任设备 method 标识
 *
 * 与 desktop / phone 并列：
 *   - desktop: dpapi / keychain / libsecret
 *   - phone:   keystore-ios / keystore-android
 *   - harmony: huks-harmony
 * -------------------------------------------------------------------------- */

export const TRUSTED_DEVICE_METHOD_HUKS_HARMONY: string = 'huks-harmony';

/* ----------------------------------------------------------------------------
 * 状态查询
 * -------------------------------------------------------------------------- */

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  itemCount: number;
}

/* ----------------------------------------------------------------------------
 * Item payload
 * -------------------------------------------------------------------------- */

export type VaultItemType =
  | 'login'
  | 'card'
  | 'note'
  | 'identity'
  | 'ssh'
  | 'passkey'
  | 'totp';

export interface ItemPayload {
  id: string;
  type: VaultItemType;
  name: string;
  fields: Record<string, Object>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  revision?: number;
}

const VALID_TYPES: ReadonlySet<VaultItemType> = new Set<VaultItemType>([
  'login',
  'card',
  'note',
  'identity',
  'ssh',
  'passkey',
  'totp',
]);

/* ----------------------------------------------------------------------------
 * VaultService —— 单例
 * -------------------------------------------------------------------------- */

export class VaultService {
  private dek: Uint8Array | null = null;
  private lastTsMs: number = 0;

  /** 进程内单调时间戳 */
  private nowMs(): number {
    const wall = Date.now();
    const next = wall > this.lastTsMs ? wall : this.lastTsMs + 1;
    this.lastTsMs = next;
    return next;
  }

  async status(): Promise<VaultStatus> {
    const file = await readVaultFile();
    const liveCount = file.items.filter(
      (r) => !(typeof r.deletedAt === 'number' && r.deletedAt > 0),
    ).length;
    return {
      initialized: !!file.meta,
      unlocked: this.dek !== null,
      itemCount: this.dek !== null ? liveCount : 0,
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
      throw new VaultError('already-initialized', 'vault 已初始化');
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
      trustedDevice: null,
    });

    if (this.dek) wipeBytes(this.dek);
    this.dek = dek;
  }

  /** 输入主密码解锁；任何失败统一返回 invalid-password */
  async unlock(password: string): Promise<void> {
    if (!password) throw new VaultError('invalid-password', '请输入主密码');

    const file = await readVaultFile();
    if (!file.meta) throw new VaultError('not-initialized', 'vault 未初始化');

    let kek: Uint8Array | null = null;
    let dek: Uint8Array | null = null;
    try {
      kek = await deriveKEKAsync(password, file.meta.salt, file.meta.params);
      try {
        dek = openAEAD(kek, file.meta.wrappedDEK, utf8(AAD_DEK));
      } catch {
        throw new VaultError('invalid-password', '主密码错误');
      }
      let verifierPlain: Uint8Array;
      try {
        verifierPlain = openAEAD(dek, file.meta.verifier, utf8(AAD_VERIFIER));
      } catch {
        throw new VaultError('invalid-password', '主密码错误');
      }
      if (utf8Decode(verifierPlain) !== VERIFIER_PLAINTEXT) {
        wipeBytes(verifierPlain);
        throw new VaultError('invalid-password', '主密码错误');
      }
      wipeBytes(verifierPlain);

      if (this.dek) wipeBytes(this.dek);
      this.dek = dek;
      dek = null; // 防止 finally 抹掉刚装上的 DEK
    } finally {
      if (kek) wipeBytes(kek);
      if (dek) wipeBytes(dek);
    }

    await this.ensureSpacesPersisted();
  }

  private async ensureSpacesPersisted(): Promise<void> {
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    if (
      file.spaces.length === fixed.spaces.length &&
      file.activeSpaceId === fixed.activeSpaceId
    ) {
      return;
    }
    file.spaces = fixed.spaces;
    file.activeSpaceId = fixed.activeSpaceId;
    await writeVaultFile(file);
  }

  lock(): void {
    if (this.dek) {
      wipeBytes(this.dek);
      this.dek = null;
    }
  }

  /** 修改主密码 */
  async changeMasterPassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    validatePasswordStrength(newPassword);
    if (!this.dek) throw new VaultError('locked', 'vault 已锁定');

    const file = await readVaultFile();
    if (!file.meta) throw new VaultError('not-initialized', 'vault 未初始化');

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
        throw new VaultError('invalid-password', '原主密码错误');
      }
      if (!constantTimeEqual(dekFromOld, this.dek)) {
        throw new VaultError('invalid-password', '原主密码错误');
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
      version: file.meta.version,
      kdf: file.meta.kdf,
      salt: newSalt,
      params: newParams,
      wrappedDEK: newWrapped,
      verifier: file.meta.verifier,
      createdAt: file.meta.createdAt,
      updatedAt: this.nowMs(),
    };
    file.meta = newMeta;
    await writeVaultFile(file);
  }

  /** 物理重置 */
  async reset(): Promise<void> {
    this.lock();
    await deleteTrustedWrapKey();
    await deleteVaultFile();
  }

  /* ------------------------------------------------------------------------ */
  /* 信任设备 / 自动解锁 —— 与 phone 同 contract，WrapKey 走 HUKS                */
  /* ------------------------------------------------------------------------ */

  async isTrustedDeviceSupported(): Promise<boolean> {
    return isTrustedKeystoreSupported();
  }

  async isTrustedDeviceEnabled(): Promise<boolean> {
    const file = await readVaultFile();
    return file.trustedDevice !== null;
  }

  async enableTrustedDevice(confirmPassword: string): Promise<void> {
    if (!(await this.isTrustedDeviceSupported())) {
      throw new VaultError(
        'trusted-unsupported',
        '当前设备不支持信任设备解锁',
      );
    }
    if (!confirmPassword) {
      throw new VaultError('invalid-password', '请输入主密码');
    }
    if (!this.dek) {
      throw new VaultError('locked', 'vault 已锁定');
    }

    const file = await readVaultFile();
    if (!file.meta) {
      throw new VaultError('not-initialized', 'vault 未初始化');
    }

    // 二次验证主密码
    const kek = await deriveKEKAsync(
      confirmPassword,
      file.meta.salt,
      file.meta.params,
    );
    let candidateDEK: Uint8Array | null = null;
    try {
      try {
        candidateDEK = openAEAD(kek, file.meta.wrappedDEK, utf8(AAD_DEK));
      } catch {
        throw new VaultError('invalid-password', '主密码错误');
      }
      if (!constantTimeEqual(candidateDEK, this.dek)) {
        throw new VaultError('invalid-password', '主密码错误');
      }
    } finally {
      wipeBytes(kek);
      if (candidateDEK) wipeBytes(candidateDEK);
    }

    // 生成 WrapKey + 用 WrapKey 包 DEK 得 blob + WrapKey 落 HUKS
    const wrapKey = randomBytes(KEY_SIZE);
    let blob: Uint8Array;
    try {
      blob = sealAEAD(wrapKey, this.dek, utf8(AAD_TRUSTED_DEVICE));
      await writeTrustedWrapKey(wrapKey);
    } finally {
      wipeBytes(wrapKey);
    }

    const row: TrustedDeviceRow = {
      method: TRUSTED_DEVICE_METHOD_HUKS_HARMONY,
      blob,
      createdAt: this.nowMs(),
    };

    try {
      const latest = await readVaultFile();
      if (!latest.meta) {
        throw new VaultError('not-initialized', 'vault 未初始化');
      }
      latest.trustedDevice = row;
      await writeVaultFile(latest);
    } catch (e) {
      // 写盘失败：清掉刚写的 WrapKey，避免 SecureStore/HUKS 留孤儿
      await deleteTrustedWrapKey();
      if (e instanceof Error) {
        throw e;
      }
      throw new Error(String(e));
    }
  }

  async disableTrustedDevice(): Promise<void> {
    await deleteTrustedWrapKey();
    const file = await readVaultFile();
    if (!file.trustedDevice) return;
    file.trustedDevice = null;
    await writeVaultFile(file);
  }

  async tryUnlockWithTrustedDevice(): Promise<boolean> {
    if (this.dek) return true;
    if (!(await this.isTrustedDeviceSupported())) return false;

    const file = await readVaultFile();
    if (!file.meta) return false;
    const row = file.trustedDevice;
    if (!row) return false;

    if (row.method !== TRUSTED_DEVICE_METHOD_HUKS_HARMONY) {
      // method 不匹配（跨端拷 vault）→ 静默清行
      await this.clearTrustedDeviceArtifacts();
      return false;
    }

    let wrapKey: Uint8Array | null = null;
    let dek: Uint8Array | null = null;
    try {
      const r = await readTrustedWrapKey();
      if (!r.ok) {
        if (r.reason === 'absent') {
          await this.clearTrustedDeviceArtifacts();
        }
        return false;
      }
      wrapKey = r.key;
      if (!wrapKey) {
        await this.clearTrustedDeviceArtifacts();
        return false;
      }
      try {
        dek = openAEAD(wrapKey, row.blob, utf8(AAD_TRUSTED_DEVICE));
      } catch {
        await this.clearTrustedDeviceArtifacts();
        return false;
      }
      if (dek.length !== KEY_SIZE) {
        await this.clearTrustedDeviceArtifacts();
        return false;
      }
      // verifier 校验
      let verPlain: Uint8Array | null = null;
      try {
        verPlain = openAEAD(dek, file.meta.verifier, utf8(AAD_VERIFIER));
      } catch {
        await this.clearTrustedDeviceArtifacts();
        return false;
      }
      try {
        if (utf8Decode(verPlain) !== VERIFIER_PLAINTEXT) {
          await this.clearTrustedDeviceArtifacts();
          return false;
        }
      } finally {
        wipeBytes(verPlain);
      }

      if (this.dek) wipeBytes(this.dek);
      this.dek = dek;
      dek = null;
    } finally {
      if (wrapKey) wipeBytes(wrapKey);
      if (dek) wipeBytes(dek);
    }

    await this.ensureSpacesPersisted();
    return true;
  }

  private async clearTrustedDeviceArtifacts(): Promise<void> {
    await deleteTrustedWrapKey();
    try {
      const file = await readVaultFile();
      if (file.trustedDevice) {
        file.trustedDevice = null;
        await writeVaultFile(file);
      }
    } catch (_e) {
      // 写盘失败不阻塞主密码兜底
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 空间（Space）                                                            */
  /* ------------------------------------------------------------------------ */

  async listSpaces(): Promise<SpacesSnapshot> {
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    return { spaces: sortSpaces(fixed.spaces), activeSpaceId: fixed.activeSpaceId };
  }

  async setActiveSpace(id: string): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const exists = fixed.spaces.some((s) => s.id === id);
    if (!exists) throw new VaultError('space-invalid', '空间不存在');
    file.spaces = fixed.spaces;
    file.activeSpaceId = id;
    await writeVaultFile(file);
  }

  async createSpace(name: string): Promise<Space> {
    this.requireUnlocked();
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new VaultError('space-invalid', '空间名不能为空');
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const maxOrder = fixed.spaces.reduce((m, s) => (s.order > m ? s.order : m), 0);
    const created: Space = {
      id: newSpaceId(),
      name: trimmed,
      order: maxOrder + 1,
      createdAt: this.nowMs(),
    };
    file.spaces = [...fixed.spaces, created];
    file.activeSpaceId = fixed.activeSpaceId;
    await writeVaultFile(file);
    return created;
  }

  async renameSpace(id: string, name: string): Promise<void> {
    this.requireUnlocked();
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new VaultError('space-invalid', '空间名不能为空');
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const idx = fixed.spaces.findIndex((s) => s.id === id);
    if (idx === -1) throw new VaultError('space-invalid', '空间不存在');
    const next = fixed.spaces.slice();
    next[idx] = { id: next[idx].id, name: trimmed, order: next[idx].order, createdAt: next[idx].createdAt };
    file.spaces = next;
    file.activeSpaceId = fixed.activeSpaceId;
    await writeVaultFile(file);
  }

  async deleteSpace(id: string): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    if (fixed.spaces.length <= 1) {
      throw new VaultError('space-last', '至少需要保留一个空间');
    }
    const target = fixed.spaces.find((s) => s.id === id);
    if (!target) throw new VaultError('space-invalid', '空间不存在');
    const remaining = fixed.spaces.filter((s) => s.id !== id);
    const fallback = sortSpaces(remaining)[0]?.id ?? DEFAULT_SPACE_ID;

    // 把目标空间下的 item 改 spaceId -> 重新加密
    const nextItems: EncryptedItemRow[] = [];
    for (const row of file.items) {
      if (typeof row.deletedAt === 'number' && row.deletedAt > 0) {
        nextItems.push(row);
        continue;
      }
      try {
        const payload = this.decryptRow(row);
        const curSpace = readSpaceIdFromFields(payload.fields) ?? fixed.activeSpaceId;
        if (curSpace === id) {
          payload.fields = cloneFieldsRecord(payload.fields);
          payload.fields.spaceId = fallback;
          payload.updatedAt = this.nowMs();
          payload.revision = (payload.revision ?? 0) + 1;
          nextItems.push(this.encryptPayload(payload));
        } else {
          nextItems.push(row);
        }
      } catch {
        nextItems.push(row);
      }
    }
    const nextActive = fixed.activeSpaceId === id ? fallback : fixed.activeSpaceId;
    file.items = nextItems;
    file.spaces = remaining;
    file.activeSpaceId = nextActive;
    await writeVaultFile(file);
  }

  /* ------------------------------------------------------------------------ */
  /* CRUD                                                                     */
  /* ------------------------------------------------------------------------ */

  async listItems(): Promise<ItemPayload[]> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const out: ItemPayload[] = [];
    for (const row of file.items) {
      if (typeof row.deletedAt === 'number' && row.deletedAt > 0) continue;
      try {
        const payload = this.decryptRow(row);
        if (typeof payload.deletedAt === 'number' && payload.deletedAt > 0) continue;
        out.push(payload);
      } catch {
        // 单条解密失败不阻塞
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
    if (typeof row.deletedAt === 'number' && row.deletedAt > 0) return null;
    const payload = this.decryptRow(row);
    if (typeof payload.deletedAt === 'number' && payload.deletedAt > 0) return null;
    return payload;
  }

  async createItem(
    type: VaultItemType,
    name: string,
    fields: Record<string, Object>,
  ): Promise<ItemPayload> {
    this.requireUnlocked();
    if (!VALID_TYPES.has(type)) {
      throw new Error(`非法 item 类型：${type}`);
    }
    if (!name || !name.trim()) throw new Error('名称不能为空');

    const id = genItemId();
    const now = this.nowMs();
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const finalFields: Record<string, Object> = cloneFieldsRecord(fields);
    if (typeof finalFields.spaceId !== 'string' || !finalFields.spaceId) {
      finalFields.spaceId = fixed.activeSpaceId;
    }
    const payload: ItemPayload = {
      id,
      type,
      name: name.trim(),
      fields: finalFields,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      deletedAt: null,
    };
    const row = this.encryptPayload(payload);
    file.items = [row, ...file.items];
    file.spaces = fixed.spaces;
    file.activeSpaceId = fixed.activeSpaceId;
    await writeVaultFile(file);
    return payload;
  }

  async updateItem(
    id: string,
    patch: UpdateItemPatch,
  ): Promise<ItemPayload> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const idx = file.items.findIndex((r) => r.id === id);
    if (idx === -1) throw new VaultError('not-found', '条目不存在');
    const row = file.items[idx];
    if (typeof row.deletedAt === 'number' && row.deletedAt > 0) {
      throw new VaultError('not-found', '条目不存在');
    }

    const existing = this.decryptRow(row);
    const next: ItemPayload = {
      id: existing.id,
      type: patch.type ?? existing.type,
      name: (patch.name?.trim()) ?? existing.name,
      fields: patch.fields ?? existing.fields,
      createdAt: existing.createdAt,
      updatedAt: this.nowMs(),
      revision: (existing.revision ?? 0) + 1,
      deletedAt: null,
    };
    file.items[idx] = this.encryptPayload(next);
    await writeVaultFile(file);
    return next;
  }

  /**
   * 切换收藏 —— 与 phone toggleFavorite 行为一致
   *
   * 实现：取条目，合并 fields，favorite = !existing.fields.favorite。
   * 不接受外部 patch.fields，自己控制以避免调用方覆盖其它字段。
   */
  async toggleFavorite(id: string): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const idx = file.items.findIndex((r) => r.id === id);
    if (idx === -1) throw new VaultError('not-found', '条目不存在');
    const row = file.items[idx];
    if (typeof row.deletedAt === 'number' && row.deletedAt > 0) {
      throw new VaultError('not-found', '条目不存在');
    }
    const existing = this.decryptRow(row);
    const current = (existing.fields.favorite as boolean | undefined) ?? false;
    const merged: Record<string, Object> = {};
    Object.keys(existing.fields).forEach((k) => {
      merged[k] = existing.fields[k];
    });
    merged.favorite = !current;
    const next: ItemPayload = {
      id: existing.id,
      type: existing.type,
      name: existing.name,
      fields: merged,
      createdAt: existing.createdAt,
      updatedAt: this.nowMs(),
      revision: (existing.revision ?? 0) + 1,
      deletedAt: null,
    };
    file.items[idx] = this.encryptPayload(next);
    await writeVaultFile(file);
  }

  async deleteItem(id: string): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const idx = file.items.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const row = file.items[idx];
    if (typeof row.deletedAt === 'number' && row.deletedAt > 0) return;
    let existing: ItemPayload;
    try {
      existing = this.decryptRow(row);
    } catch {
      // 损坏行物理移除
      file.items = file.items.filter((r) => r.id !== id);
      await writeVaultFile(file);
      return;
    }
    const now = this.nowMs();
    const tombstone: ItemPayload = {
      id: existing.id,
      type: existing.type,
      name: existing.name,
      fields: existing.fields,
      createdAt: existing.createdAt,
      updatedAt: now,
      deletedAt: now,
      revision: (existing.revision ?? 0) + 1,
    };
    file.items[idx] = this.encryptPayload(tombstone);
    await writeVaultFile(file);
  }

  /**
   * 摄取来自对端 sync 的 plaintext payload —— LWW（last-write-wins）策略
   *
   * 与 phone/lib/vault-service.ts ingestForeignPayload 行为一致：
   *   - 强制对齐 id / createdAt / updatedAt 到对端值（保证跨端 id 一致）
   *   - 本端不存在则插入；存在但本端较新则跳过；否则覆盖
   *   - tombstone 走 deleteItem 路径，本函数 payload 视作非删除
   *
   * 返回 'inserted' / 'updated' / 'skipped' 用于调用方进度统计。
   */
  async ingestForeignPayload(
    id: string,
    payload: ItemPayload,
    createdAt: number,
    updatedAt: number,
  ): Promise<'inserted' | 'updated' | 'skipped'> {
    this.requireUnlocked();
    if (!id) throw new VaultError('not-found', 'ingest: empty id');
    const normalized: ItemPayload = {
      id,
      type: payload.type,
      name: payload.name,
      fields: payload.fields ?? ({} as Record<string, Object>),
      createdAt,
      updatedAt,
      revision: payload.revision ?? 1,
      deletedAt: null,
    };
    const file = await readVaultFile();
    const idx = file.items.findIndex((r) => r.id === id);
    if (idx === -1) {
      const encrypted = this.encryptPayload(normalized);
      file.items = [encrypted, ...file.items];
      await writeVaultFile(file);
      return 'inserted';
    }
    if (file.items[idx].updatedAt >= updatedAt) {
      return 'skipped';
    }
    const encrypted = this.encryptPayload(normalized);
    file.items[idx] = encrypted;
    await writeVaultFile(file);
    return 'updated';
  }

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
    if (!this.dek) throw new VaultError('locked', 'vault 已锁定');
  }

  private encryptPayload(payload: ItemPayload): EncryptedItemRow {
    const plaintext = utf8(JSON.stringify(payload));
    const ciphertext = sealAEAD(this.dek!, plaintext, utf8(payload.id));
    wipeBytes(plaintext);
    const deletedAt =
      typeof payload.deletedAt === 'number' && payload.deletedAt > 0
        ? payload.deletedAt
        : null;
    return {
      id: payload.id,
      payload: ciphertext,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      deletedAt,
    };
  }

  private decryptRow(row: EncryptedItemRow): ItemPayload {
    const plaintext = openAEAD(this.dek!, row.payload, utf8(row.id));
    const parsed = JSON.parse(utf8Decode(plaintext)) as ItemPayload;
    parsed.createdAt = row.createdAt;
    parsed.updatedAt = row.updatedAt;
    parsed.id = row.id;
    if (parsed.deletedAt === undefined) parsed.deletedAt = null;
    if (parsed.revision === undefined) parsed.revision = 1;
    return parsed;
  }
}

export interface UpdateItemPatch {
  name?: string;
  type?: VaultItemType;
  fields?: Record<string, Object>;
}

export interface SpacesSnapshot {
  spaces: Space[];
  activeSpaceId: string;
}

/* ----------------------------------------------------------------------------
 * 进程级单例
 * -------------------------------------------------------------------------- */

export const vaultService = new VaultService();

/* ----------------------------------------------------------------------------
 * 帮助函数
 * -------------------------------------------------------------------------- */

/** 生成 16 字节随机 id，hex 编码 —— 与 phone genItemId 一致 */
function genItemId(): string {
  const bytes = randomBytes(16);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** 给快照补"至少一个空间 + 一个有效 activeSpaceId" */
function ensureDefaultsInSnapshot(file: VaultFile): SpacesSnapshot {
  const spaces = file.spaces.length > 0 ? file.spaces : [buildDefaultSpace()];
  let active = file.activeSpaceId ?? '';
  const exists = spaces.some((s) => s.id === active);
  if (!exists) active = sortSpaces(spaces)[0].id;
  return { spaces, activeSpaceId: active };
}

/** 从 ItemPayload.fields 安全取出 spaceId */
export function readSpaceIdFromFields(
  fields: Record<string, Object> | undefined,
): string | undefined {
  if (!fields) return undefined;
  const v = fields.spaceId;
  return typeof v === 'string' && v ? (v as string) : undefined;
}

/**
 * 浅拷贝 fields 对象 —— ArkTS strict 禁用 `{ ...obj }` spread，
 * 也禁用 `Object.create(null)` 与裸 `{}` 字面量；用 JSON.parse('{}')
 * 拿到一个可索引的纯对象再逐键拷贝。
 */
function cloneFieldsRecord(
  src: Record<string, Object> | undefined,
): Record<string, Object> {
  const out: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
  if (!src) return out;
  for (const k of Object.keys(src)) {
    out[k] = src[k];
  }
  return out;
}
