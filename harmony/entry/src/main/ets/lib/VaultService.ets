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
  AAD_CLOUD_CRED,
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

/** 批量导入草稿 —— 由 Transfer.normalizeToDraft 产出，喂给 VaultService.importItems。 */
export interface ImportItemDraft {
  type: VaultItemType;
  name: string;
  fields: Record<string, Object>;
}

/** importItems 循环让出 UI 线程的步长（每 N 条 await 一次事件循环，保证进度条可重绘）。 */
const IMPORT_YIELD_EVERY: number = 16;

const VALID_TYPES: ReadonlySet<VaultItemType> = new Set<VaultItemType>([
  'login',
  'card',
  'note',
  'identity',
  'ssh',
  'passkey',
  'totp',
]);

/**
 * 是否应归入「验证码」视图。
 *
 * 两类来源（与 phone data/vault.ts itemHasTotp 对齐）：
 *   - 独立 totp 条目（fields.secret）
 *   - 携带 totp 密钥的 login 条目（fields.totp，即 2FA / MFA 二次验证码）
 */
export function itemHasTotp(it: ItemPayload): boolean {
  if (it.type === 'totp') {
    const s = it.fields.secret;
    return typeof s === 'string' && s.trim().length > 0;
  }
  if (it.type === 'login') {
    const t = it.fields.totp;
    return typeof t === 'string' && t.trim().length > 0;
  }
  return false;
}

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

  /** 本地用户改动钩子（云同步注册 → 去抖增量推送）。sync 摄取不触发，避免回环。 */
  private mutationHook: (() => void) | null = null;

  /** 空间增删钩子（云同步注册 → 自动镜像新空间 / 解绑已删空间）。 */
  private spaceHook: ((e: SpaceMutationEvent) => void) | null = null;

  /** 注册本地改动钩子（CloudService.hydrate 调用一次）。 */
  registerMutationHook(cb: () => void): void {
    this.mutationHook = cb;
  }

  /** 注册空间增删钩子（CloudService.hydrate 调用一次；驱动自动镜像）。 */
  registerSpaceHook(cb: (e: SpaceMutationEvent) => void): void {
    this.spaceHook = cb;
  }

  private fireMutation(): void {
    if (this.mutationHook) this.mutationHook();
  }

  private fireSpaceMutation(kind: string, spaceId: string): void {
    if (this.spaceHook) this.spaceHook({ kind, spaceId });
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

  /**
   * 二次验证主密码（不改锁定态）：用候选密码派生 KEK 解出 DEK，与当前内存 DEK 常量时间比对。
   * 供「信任设备」「清空云端数据」等二次确认复用。锁定 / 未初始化抛错；密码错返回 false。
   */
  async verifyPassword(password: string): Promise<boolean> {
    if (!this.dek) throw new VaultError('locked', 'vault 已锁定');
    if (!password) return false;
    const file = await readVaultFile();
    if (!file.meta) throw new VaultError('not-initialized', 'vault 未初始化');
    const kek = await deriveKEKAsync(password, file.meta.salt, file.meta.params);
    let candidate: Uint8Array | null = null;
    try {
      try {
        candidate = openAEAD(kek, file.meta.wrappedDEK, utf8(AAD_DEK));
      } catch {
        return false;
      }
      return constantTimeEqual(candidate, this.dek);
    } finally {
      wipeBytes(kek);
      if (candidate) wipeBytes(candidate);
    }
  }

  /**
   * 清空所有数据：删除全部条目与全部空间，回到单个空的默认空间；保留主密码与加密元数据
   * （区别于 reset 的整库物理删）。**不触发**空间/条目钩子——云端数据由 CloudService 单独清理，
   * 避免回环触发云镜像 / 删除。调用方负责刷新 store。
   */
  async purgeAllData(): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    file.items = [];
    file.spaces = [buildDefaultSpace()];
    file.activeSpaceId = DEFAULT_SPACE_ID;
    await writeVaultFile(file);
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

    // 二次验证主密码（复用 verifyPassword：派生 KEK 解 DEK 与当前 DEK 常量时间比对）
    if (!(await this.verifyPassword(confirmPassword))) {
      throw new VaultError('invalid-password', '主密码错误');
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
  /* 云自动登录凭据（DEK 包裹云主密码）                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * 用本地保险库 DEK 加密一段云自动登录凭据（云主密码）。与 desktop SealCloudCredential 对齐。
   *
   * 供 CloudService 在登录成功后把云账户主密码以「仅本地解锁后可解」的形式落盘——这样即便
   * 本地解锁密码与云密码不同、或本次解锁走的是信任设备（生物识别，无主密码），解锁后也能
   * 重建云会话。CloudService 只传明文、拿密文，永不接触 DEK，保持「只有 vault 持有 DEK」不变量。
   * vault 锁定（DEK 不在内存）时抛 locked。
   */
  sealCloudCredential(plaintext: Uint8Array): Uint8Array {
    if (!this.dek) throw new VaultError('locked', 'vault 已锁定');
    return sealAEAD(this.dek, plaintext, utf8(AAD_CLOUD_CRED));
  }

  /** 用 DEK 解密 sealCloudCredential 落盘的云凭据密文。vault 锁定时抛 locked；密文损坏/被篡改 → AEAD 校验失败抛错。 */
  openCloudCredential(ciphertext: Uint8Array): Uint8Array {
    if (!this.dek) throw new VaultError('locked', 'vault 已锁定');
    return openAEAD(this.dek, ciphertext, utf8(AAD_CLOUD_CRED));
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

  /**
   * 新建空间。silent=true 时不触发空间增删钩子（fireSpaceMutation）——
   * 供云同步「下拉云端 vault 落地为本地空间」使用：该空间随即被绑定到一个**已存在**
   * 的云 vault，绝不能再触发自动镜像去 mint 一个新 vault（对应 desktop
   * createSpaceWithoutAutoLink）。
   */
  async createSpace(name: string, silent: boolean = false): Promise<Space> {
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
    if (!silent) this.fireSpaceMutation('create', created.id);
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
    this.fireSpaceMutation('rename', id);
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
    // 删除空间内的 item 已重指派到 fallback（updatedAt bump），通知云同步：解绑被删空间、
    // 让 fallback 空间的 vault 接管这些条目。
    this.fireSpaceMutation('delete', id);
    this.fireMutation();
  }

  /**
   * 物理删除一个空间及其全部条目（HARD delete：不合并到 fallback、不落墓碑）。
   * 供云同步消费「vault 删除墓碑」：该空间绑定的云 vault 已被其它设备主动删除，本端据此把
   * 对应本地空间与其条目一并清除（与 desktop VaultService.PurgeSpace 一致，区别于 deleteSpace
   * 的「重指派到 fallback」语义）。不触发空间增删钩子（避免回环触发云端删除 / 对已删 vault 重复
   * 发删）；拆绑定与刷新由调用方（CloudService）负责。删到不剩空间时回落为新建空默认空间。
   */
  async purgeSpace(id: string): Promise<void> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    // 丢弃该空间下的全部条目（live + 墓碑）；解密失败的行保留（无法判定归属）。
    const nextItems: EncryptedItemRow[] = [];
    for (const row of file.items) {
      try {
        const payload = this.decryptRow(row);
        const curSpace = readSpaceIdFromFields(payload.fields) ?? fixed.activeSpaceId;
        if (curSpace === id) continue; // 物理删
      } catch {
        // 解密失败 → 保留
      }
      nextItems.push(row);
    }
    const remaining = fixed.spaces.filter((s) => s.id !== id);
    const nextSpaces = remaining.length > 0 ? remaining : [buildDefaultSpace()];
    const nextActive = fixed.activeSpaceId === id ? sortSpaces(nextSpaces)[0].id : fixed.activeSpaceId;
    file.items = nextItems;
    file.spaces = nextSpaces;
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
    this.fireMutation();
    return payload;
  }

  /**
   * 批量导入 —— 一次读盘、循环加密、一次写盘（O(N)，而非逐条 createItem 的 O(N²)）。
   *
   * 行为与「连续 N 次 createItem」一致：每条独立 genItemId() + 单调 nowMs() + 注入缺省
   * spaceId，整批以「最新在前」顺序前插到现有条目之上。区别在于中途只持有内存快照，
   * 结束时一次原子写 —— 若进程被杀则整批不落库，不会留下半截脏数据。
   *
   * onProgress(done, total) 在每条加密后回调，驱动进度条。加密为同步 napi 调用，长循环
   * 会饿死 UI 线程，故每 IMPORT_YIELD_EVERY 条让出一次事件循环，使 ArkUI 有机会重绘。
   */
  async importItems(
    drafts: ImportItemDraft[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    this.requireUnlocked();
    const total = drafts.length;
    if (onProgress) onProgress(0, total);
    if (total === 0) return 0;

    const file = await readVaultFile();
    const fixed = ensureDefaultsInSnapshot(file);
    const newRows: EncryptedItemRow[] = [];
    let imported = 0;
    for (let i = 0; i < total; i++) {
      const d = drafts[i];
      if (VALID_TYPES.has(d.type)) {
        const name = d.name.trim();
        if (name.length > 0) {
          const now = this.nowMs();
          const finalFields: Record<string, Object> = cloneFieldsRecord(d.fields);
          if (typeof finalFields.spaceId !== 'string' || !finalFields.spaceId) {
            finalFields.spaceId = fixed.activeSpaceId;
          }
          const payload: ItemPayload = {
            id: genItemId(),
            type: d.type,
            name,
            fields: finalFields,
            createdAt: now,
            updatedAt: now,
            revision: 1,
            deletedAt: null,
          };
          try {
            newRows.push(this.encryptPayload(payload));
            imported++;
          } catch (_e) {
            // 单条加密失败不中断整体（与旧逐条 createItem 容错一致）
          }
        }
      }
      if (onProgress) onProgress(i + 1, total);
      if ((i + 1) % IMPORT_YIELD_EVERY === 0) {
        await new Promise<void>((resolve: () => void) => { setTimeout(() => resolve(), 0); });
      }
    }
    if (newRows.length === 0) return 0;
    // 「最新在前」：与连续 createItem 的逐条前插效果一致（最后创建的排在最上）
    file.items = newRows.reverse().concat(file.items);
    file.spaces = fixed.spaces;
    file.activeSpaceId = fixed.activeSpaceId;
    await writeVaultFile(file);
    this.fireMutation();
    return imported;
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
    this.fireMutation();
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
    this.fireMutation();
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
      this.fireMutation();
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
    this.fireMutation();
  }

  /** 列出回收站（软删除 tombstone）条目，按删除时间倒序 */
  async listDeleted(): Promise<ItemPayload[]> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const out: ItemPayload[] = [];
    for (const row of file.items) {
      const deletedRow = typeof row.deletedAt === 'number' && row.deletedAt > 0;
      try {
        const payload = this.decryptRow(row);
        const deleted = deletedRow || (typeof payload.deletedAt === 'number' && payload.deletedAt > 0);
        if (deleted) out.push(payload);
      } catch {
        // 解密失败的损坏行跳过
      }
    }
    out.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    return out;
  }

  /**
   * 列出某空间下的 live 条目（云同步按空间构建本地 manifest 用）。
   *
   * 多空间模型：每个云 vault 1:1 绑定一个本地空间，故拉/推都按 spaceId 切分。无 spaceId 字段
   * 的历史条目归入默认空间（与 spaceIdOfPayload 一致）。
   */
  async listItemsForSpace(spaceId: string): Promise<ItemPayload[]> {
    const all = await this.listItems();
    return all.filter((p) => spaceIdOfPayload(p) === spaceId);
  }

  /** 列出某空间下的回收站（墓碑）条目（云同步推送墓碑用）。 */
  async listDeletedForSpace(spaceId: string): Promise<ItemPayload[]> {
    const all = await this.listDeleted();
    return all.filter((p) => spaceIdOfPayload(p) === spaceId);
  }

  /**
   * 从回收站恢复 —— 清除 deletedAt 并 LWW bump（updatedAt 单调递增 + revision++）。
   *
   * 不做物理 purge：sync 模型下其它端仍保有 tombstone，本地物理删除会在下次
   * 同步时被对端 tombstone 复活，purge 名不副实，故只提供「恢复」。
   */
  async restoreItem(id: string): Promise<ItemPayload> {
    this.requireUnlocked();
    const file = await readVaultFile();
    const idx = file.items.findIndex((r) => r.id === id);
    if (idx === -1) throw new VaultError('not-found', '条目不存在');
    const existing = this.decryptRow(file.items[idx]);
    const restored: ItemPayload = {
      id: existing.id,
      type: existing.type,
      name: existing.name,
      fields: existing.fields,
      createdAt: existing.createdAt,
      updatedAt: this.nowMs(),
      revision: (existing.revision ?? 0) + 1,
      deletedAt: null,
    };
    file.items[idx] = this.encryptPayload(restored);
    await writeVaultFile(file);
    this.fireMutation();
    return restored;
  }

  /** sync 合并 LWW bump 用的单调时钟（ms）—— 保证 > 上次发放，且与本机写入同源 */
  private lastIssuedTs: number = 0;

  /**
   * 发放单调递增时间戳（毫秒）。
   *
   * 与 phone/lib/vault-service.ts nextTimestamp 一致：取 Date.now()，若不大于上次发放值
   * 则 +1，保证严格递增（sync server 端把冲突决策落地时 bump updatedAt 用，须 > 两端 manifest）。
   */
  nextTimestamp(): number {
    const now = Date.now();
    this.lastIssuedTs = now > this.lastIssuedTs ? now : this.lastIssuedTs + 1;
    return this.lastIssuedTs;
  }

  /**
   * 摄取来自对端 sync 的 plaintext payload —— LWW（last-write-wins）策略
   *
   * 与 phone/lib/vault-service.ts ingestForeignPayload 行为一致：
   *   - 强制对齐 id / createdAt / updatedAt 到对端值（保证跨端 id 一致）
   *   - 本端不存在则插入；存在但本端较新则跳过；否则覆盖
   *   - tombstone 走 deleteItem 路径，本函数 payload 视作非删除
   *   - force=true 跳过 LWW 比较强制覆盖（云同步「采用对端」冲突解决用）
   *   - spaceId 非空时改写 fields.spaceId 为目标空间——多空间模型下「条目归属由其所在云 vault
   *     的绑定空间决定」，与 desktop space_id 列对齐；这使换绑 vault 到另一空间时条目随之迁移。
   *     空（''）时保留 payload 自带的 spaceId（P2P/LAN 同步传整份 payload，无需改写）。
   *
   * 返回 'inserted' / 'updated' / 'skipped' 用于调用方进度统计。
   */
  async ingestForeignPayload(
    id: string,
    payload: ItemPayload,
    createdAt: number,
    updatedAt: number,
    spaceId: string = '',
    force: boolean = false,
  ): Promise<'inserted' | 'updated' | 'skipped'> {
    this.requireUnlocked();
    if (!id) throw new VaultError('not-found', 'ingest: empty id');
    const fields = cloneFieldsRecord(payload.fields);
    if (spaceId) fields.spaceId = spaceId;
    const normalized: ItemPayload = {
      id,
      type: payload.type,
      name: payload.name,
      fields,
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
    if (!force && file.items[idx].updatedAt >= updatedAt) {
      return 'skipped';
    }
    const encrypted = this.encryptPayload(normalized);
    file.items[idx] = encrypted;
    await writeVaultFile(file);
    return 'updated';
  }

  /**
   * 摄取来自云端的删除墓碑 —— LWW，保留对端 deletedAt 时间戳（不用本机时钟）。
   *
   * 与 ingestForeignPayload 对称，但应用的是删除态。deleteItem 会盖上 nowMs，
   * 导致下次同步把"刚应用的删除"当成更新再 push 回云端造成抖动；本方法用对端
   * updatedAt 落墓碑，确保两端时间戳一致、立即收敛。
   *
   *   - 本端不存在该 id → 'skipped'（无可删）
   *   - 本端较新（updatedAt >= 对端）→ 'skipped'（本端编辑胜出，留给 push 阶段）
   *   - 否则 → 落 tombstone，deletedAt/updatedAt 对齐对端
   */
  async ingestForeignDeletion(id: string, updatedAt: number, spaceId: string = '', force: boolean = false): Promise<'deleted' | 'skipped'> {
    this.requireUnlocked();
    if (!id) throw new VaultError('not-found', 'ingest: empty id');
    const file = await readVaultFile();
    const idx = file.items.findIndex((r) => r.id === id);
    if (idx === -1) return 'skipped';
    const row = file.items[idx];
    if (!force && row.updatedAt >= updatedAt) return 'skipped';
    let existing: ItemPayload;
    try {
      existing = this.decryptRow(row);
    } catch {
      // 损坏行：payload 不可读，直接落墓碑占位（保留原密文字节）
      file.items[idx] = {
        id: row.id,
        payload: row.payload,
        createdAt: row.createdAt,
        updatedAt,
        deletedAt: updatedAt,
      };
      await writeVaultFile(file);
      return 'deleted';
    }
    const tfields = cloneFieldsRecord(existing.fields);
    if (spaceId) tfields.spaceId = spaceId;
    const tombstone: ItemPayload = {
      id: existing.id,
      type: existing.type,
      name: existing.name,
      fields: tfields,
      createdAt: existing.createdAt,
      updatedAt,
      deletedAt: updatedAt,
      revision: (existing.revision ?? 0) + 1,
    };
    file.items[idx] = this.encryptPayload(tombstone);
    await writeVaultFile(file);
    return 'deleted';
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

/** 空间增删事件（registerSpaceHook 回调入参）。kind: 'create' | 'rename' | 'delete'。 */
export interface SpaceMutationEvent {
  kind: string;
  spaceId: string;
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

/** 取条目所属空间 id（无 spaceId 字段的历史条目归入默认空间）—— 云同步按空间切分的统一口径。 */
export function spaceIdOfPayload(p: ItemPayload): string {
  return readSpaceIdFromFields(p.fields) ?? DEFAULT_SPACE_ID;
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
