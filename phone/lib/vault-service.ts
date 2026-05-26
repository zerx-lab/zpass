// ZPass Phone —— Vault 业务层
//
// 对齐 desktop/internal/services/vaultservice.go：
//   - Status / Initialize / Unlock / Lock / ChangeMasterPassword
//   - ListItems / GetItem / CreateItem / UpdateItem / DeleteItem
//   - IsTrustedDeviceSupported / IsTrustedDeviceEnabled
//     / EnableTrustedDevice / DisableTrustedDevice / TryUnlockWithTrustedDevice
//
// 与 desktop 的差异：单进程单实例（RN runtime），无 mutex；
//   状态机以 in-memory dek 是否非空表达「已解锁」。

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

import {
  AAD_DEK,
  AAD_TRUSTED_DEVICE,
  AAD_VERIFIER,
  KEY_SIZE,
  SALT_SIZE,
  VERIFIER_PLAINTEXT,
  constantTimeEqual,
  defaultArgon2idParams,
  deriveKEKAsync,
  fromB64,
  openAEAD,
  randomBytes,
  sealAEAD,
  toB64,
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
  type TrustedDeviceRow,
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
  | "space-last"
  /** 当前平台不支持「信任设备」自动解锁 —— 与 desktop ErrTrustedDeviceUnsupported 对齐 */
  | "trusted-unsupported";

/* ----------------------------------------------------------------------------
 * 信任设备 —— Method 标识 & SecureStore key
 *
 * 与 desktop trusteddevice.go 的常量并列：
 *   - desktop: dpapi / keychain / libsecret
 *   - phone:   keystore-ios / keystore-android
 *
 * Method 字段在 vault file 里持久化；Unprotect 时校验当前平台 method 是否
 * 匹配，不匹配走静默清行回退 —— 与 desktop TryUnlockWithTrustedDevice 一致。
 * -------------------------------------------------------------------------- */

export const TRUSTED_DEVICE_METHOD_KEYSTORE_IOS = "keystore-ios";
export const TRUSTED_DEVICE_METHOD_KEYSTORE_ANDROID = "keystore-android";

/**
 * SecureStore 内 WrapKey 的 key 名 —— 进程级常量，不进 vault 文件。
 *
 * 命名规则：仅含 SecureStore 允许的 `[A-Za-z0-9._-]`（见 setItemAsync doc），
 * 避免触发原生层 key 名校验失败。
 */
const TRUSTED_DEVICE_WRAPKEY_NAME = "zpass.trusted_device.wrapkey.v1";

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
      trustedDevice: null,
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

  /** 物理重置：删除 vault 文件，状态切回未初始化
   *
   * 必须同时清掉 SecureStore 里的 WrapKey —— 否则用户重置后再次启用信任
   * 设备时会复用旧 WrapKey，旧 vault 备份若被拷回还能被解。
   */
  async reset(): Promise<void> {
    this.lock();
    await this.deleteTrustedDeviceWrapKey();
    await deleteVaultFile();
  }

  /* ------------------------------------------------------------------------ */
  /* 信任设备 / 自动解锁                                                       */
  /* ------------------------------------------------------------------------ */
  //
  // 与 desktop/internal/services/vaultservice.go 的同名方法一一对齐。
  // 详见 desktop trusteddevice.go 头部安全模型注释 —— 此处仅记录 phone
  // 端落差：blob 字节布局是 AEAD(WrapKey, DEK, AAD_TRUSTED_DEVICE)，WrapKey
  // 由 expo-secure-store 托管（iOS Keychain + biometryCurrentSet / Android
  // Keystore + setUserAuthenticationRequired），desktop 则把整个 DEK 直接交
  // 给 DPAPI/Keychain/libsecret。差异由 method 字段隔离。

  /** 当前平台是否支持信任设备自动解锁
   *
   * 锁定状态下也能安全调用 —— 仅探测 OS API 可用性，与 desktop 一致。
   */
  async isTrustedDeviceSupported(): Promise<boolean> {
    return this.detectTrustedDeviceSupport();
  }

  /** 当前 vault 是否已经在此设备启用了自动解锁
   *
   * 锁定状态下也能调用 —— 仅查 vault 文件是否有 trustedDevice 行。
   * 与 desktop IsTrustedDeviceEnabled 行为对齐：返回 true 仅表示行存在，
   * 不保证 blob 真的能解开（WrapKey 可能已被 OS 失效）。
   */
  async isTrustedDeviceEnabled(): Promise<boolean> {
    const file = await readVaultFile();
    return file.trustedDevice !== null;
  }

  /** 启用「在此设备上自动解锁」
   *
   * 校验链与 desktop EnableTrustedDevice 等价：
   *   1. 平台支持
   *   2. confirmPassword 非空
   *   3. 已解锁（持有 DEK）
   *   4. 用 confirmPassword 跑完整 KDF + AEAD 派生 candidateDEK
   *   5. constantTimeEqual(candidateDEK, dek) —— 不等就拒，防内存被污染
   *   6. 调 Protect(dek) 写入 trustedDevice 行
   */
  async enableTrustedDevice(confirmPassword: string): Promise<void> {
    if (!(await this.detectTrustedDeviceSupport())) {
      throw new VaultError("trusted-unsupported", "当前平台不支持信任设备解锁");
    }
    if (!confirmPassword) {
      throw new VaultError("invalid-password", "请输入主密码");
    }
    if (!this.dek) {
      throw new VaultError("locked", "vault 已锁定");
    }

    const file = await readVaultFile();
    if (!file.meta) {
      throw new VaultError("not-initialized", "vault 未初始化");
    }

    // 二次验证主密码 —— 与 unlock 同等强度。若 confirmPassword 错，KDF 推
    // 出的 KEK 解 wrappedDEK 会失败 / 解出来的 DEK 与内存 DEK 不等。
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
        throw new VaultError("invalid-password", "主密码错误");
      }
      if (!constantTimeEqual(candidateDEK, this.dek)) {
        // 派生的 DEK 与内存中的不一致 —— 极端异常（vault 文件被外部改过 /
        // DEK 内存损坏），拒绝继续，避免把错误的 DEK 封进 trusted blob。
        throw new VaultError("invalid-password", "主密码错误");
      }
    } finally {
      wipeBytes(kek);
      if (candidateDEK) wipeBytes(candidateDEK);
    }

    // 生成 WrapKey + 用 WrapKey 包装 DEK 得 blob + WrapKey 落 SecureStore
    const wrapKey = randomBytes(KEY_SIZE);
    let blob: Uint8Array;
    try {
      blob = sealAEAD(wrapKey, this.dek, utf8(AAD_TRUSTED_DEVICE));
      await this.writeTrustedDeviceWrapKey(wrapKey);
    } finally {
      wipeBytes(wrapKey);
    }

    const row: TrustedDeviceRow = {
      method: this.currentTrustedDeviceMethod(),
      blob,
      createdAt: this.nowMs(),
    };
    // 二次读取 vault 文件（中间 KDF 期间用户可能改了别的字段）—— 与 createItem
    // 等其它写路径一致，永远基于最新快照写回。
    //
    // 此时 SecureStore 里已经有 WrapKey，但 vault 文件里还没有对应行；任何
    // 后续步骤抛错都必须清掉刚写的 WrapKey，避免孤儿——下次再启用会被覆盖
    // 但表象上"启用按钮换了 WrapKey 却跟旧 blob 不匹配"是个隐 bug。
    try {
      const latest = await readVaultFile();
      if (!latest.meta) {
        throw new VaultError("not-initialized", "vault 未初始化");
      }
      latest.trustedDevice = row;
      await writeVaultFile(latest);
    } catch (e) {
      await this.deleteTrustedDeviceWrapKey();
      throw e;
    }
  }

  /** 关闭「在此设备上自动解锁」
   *
   * 不需要主密码确认 —— 关闭只是降低安全等级，没有提权风险。
   * 幂等：未启用时调用也返回成功。
   */
  async disableTrustedDevice(): Promise<void> {
    // 先清 SecureStore，再清 vault 文件 —— 反向顺序在中途崩溃时会留下
    // "vault 没行但 SecureStore 有孤儿 key"，下次启用时会被新 setItemAsync
    // 覆盖，无害；但正向顺序遇到崩溃则会留下"vault 有行但 WrapKey 已删"，
    // 启动 tryUnlock 时 Unprotect 会失败 → 静默清行，最终一致。两种顺序都
    // 安全收敛，选先清 SecureStore 是因为它更可能失败（生物识别拒绝）。
    await this.deleteTrustedDeviceWrapKey();
    const file = await readVaultFile();
    if (!file.trustedDevice) return;
    file.trustedDevice = null;
    await writeVaultFile(file);
  }

  /** 启动时尝试用「信任设备」自动解锁
   *
   * 返回 true 表示已解锁；false 涵盖"未启用 / Unprotect 失败 / OS 凭据已变化"
   * 等所有需要让用户走主密码流程的情况（与 desktop TryUnlockWithTrustedDevice
   * 的 (bool, error) 语义一致，错误仅在真异常时抛）。
   *
   * 失败时**静默清除** vault.trustedDevice 行 + SecureStore WrapKey，让下次
   * 启动直接进主密码界面，不向用户暴露内部错误。
   */
  async tryUnlockWithTrustedDevice(): Promise<boolean> {
    if (this.dek) return true; // 已解锁 —— 与 desktop 幂等返回一致

    if (!(await this.detectTrustedDeviceSupport())) return false;

    const file = await readVaultFile();
    if (!file.meta) return false; // vault 未初始化
    const row = file.trustedDevice;
    if (!row) return false; // 未启用

    // method 不匹配（理论上只有跨平台拷 vault 文件才会触发）→ 静默清行
    if (row.method !== this.currentTrustedDeviceMethod()) {
      await this.clearTrustedDeviceArtifacts();
      return false;
    }

    let wrapKey: Uint8Array | null = null;
    let dek: Uint8Array | null = null;
    try {
      const r = await this.readTrustedDeviceWrapKey();
      if (!r.ok) {
        if (r.reason === "absent") {
          // key 永久不可恢复（OS 凭据失效 / 备份恢复后 SecureStore 没回来）
          // → 静默清行，下次启动直接进主密码界面
          await this.clearTrustedDeviceArtifacts();
        }
        // transient（用户取消生物识别）→ 不清行，下次还能再点
        return false;
      }
      wrapKey = r.key;
      try {
        dek = openAEAD(wrapKey, row.blob, utf8(AAD_TRUSTED_DEVICE));
      } catch {
        // blob 已损坏 / WrapKey 跟 blob 不配对 → 静默清行
        await this.clearTrustedDeviceArtifacts();
        return false;
      }
      if (dek.length !== KEY_SIZE) {
        await this.clearTrustedDeviceArtifacts();
        return false;
      }
      // verifier 校验：用解出的 DEK 解 vault.meta.verifier，必须等于约定明文。
      // 防御攻击者直接改 vault 文件、塞别的 DEK 进 trustedDevice.blob。
      // 与 desktop TryUnlockWithTrustedDevice 第 7 步一致。
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

      // 全部校验通过 —— 安装 DEK
      if (this.dek) wipeBytes(this.dek);
      this.dek = dek;
      dek = null; // 防止 finally 抹掉刚安装的 DEK
    } finally {
      if (wrapKey) wipeBytes(wrapKey);
      if (dek) wipeBytes(dek);
    }

    // 兼容旧 vault：与 unlock() 同样保证至少一个空间存在
    await this.ensureSpacesPersisted();
    return true;
  }

  /* ---------------- 信任设备 内部辅助 ---------------- */

  /** 探测当前平台是否能用 SecureStore + 生物识别 */
  private async detectTrustedDeviceSupport(): Promise<boolean> {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return false;
    try {
      if (!(await SecureStore.isAvailableAsync())) return false;
    } catch {
      return false;
    }
    try {
      // 必须有生物识别 / 设备 PIN，否则 requireAuthentication 没意义
      if (!SecureStore.canUseBiometricAuthentication()) return false;
    } catch {
      return false;
    }
    return true;
  }

  /** 返回当前平台写入 trustedDevice.method 的标识 */
  private currentTrustedDeviceMethod(): string {
    if (Platform.OS === "ios") return TRUSTED_DEVICE_METHOD_KEYSTORE_IOS;
    if (Platform.OS === "android") return TRUSTED_DEVICE_METHOD_KEYSTORE_ANDROID;
    return ""; // 不支持平台 —— 调用方应当先经 detectTrustedDeviceSupport 拒绝
  }

  /** 把 WrapKey 写进 SecureStore；触发 Android 生物识别弹窗 */
  private async writeTrustedDeviceWrapKey(key: Uint8Array): Promise<void> {
    await SecureStore.setItemAsync(
      TRUSTED_DEVICE_WRAPKEY_NAME,
      toB64(key),
      {
        requireAuthentication: true,
        authenticationPrompt: "启用 ZPass 设备解锁",
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      },
    );
  }

  /** 从 SecureStore 读 WrapKey；触发 iOS / Android 生物识别弹窗
   *
   * 三态返回：
   *   - { ok: true, key }                  成功拿到 WrapKey
   *   - { ok: false, reason: "absent" }    key 不存在 / 已被系统永久失效
   *   - { ok: false, reason: "transient" } 用户按取消 / 一次性失败
   *
   * 区分两种失败的目的：absent 表示数据已经实质不可恢复，调用方应清掉 vault
   * 文件里的 trustedDevice 行；transient 表示这次没用上但下次还能再试，不能
   * 让用户因一次 cancel 就被强制回主密码流程并需要重新启用（曾经的 bug）。
   */
  private async readTrustedDeviceWrapKey(): Promise<
    | { ok: true; key: Uint8Array }
    | { ok: false; reason: "absent" | "transient" }
  > {
    let b64: string | null;
    try {
      b64 = await SecureStore.getItemAsync(TRUSTED_DEVICE_WRAPKEY_NAME, {
        requireAuthentication: true,
        authenticationPrompt: "解锁 ZPass 保险库",
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    } catch {
      // expo-secure-store 在用户取消生物识别 / 多次失败时抛错；这种是 transient
      // —— 用户能再点一次按钮重试。绝不当作 absent 清行。
      return { ok: false, reason: "transient" };
    }
    if (!b64) {
      // getItemAsync 在 key 不存在 / key 被 OS 永久失效（用户改了生物识别配置）
      // 时返回 null。这种是 absent —— vault 文件里的孤儿行该清。
      return { ok: false, reason: "absent" };
    }
    let bytes: Uint8Array;
    try {
      bytes = fromB64(b64);
    } catch {
      return { ok: false, reason: "absent" };
    }
    if (bytes.length !== KEY_SIZE) {
      wipeBytes(bytes);
      return { ok: false, reason: "absent" };
    }
    return { ok: true, key: bytes };
  }

  /** 删 SecureStore 里的 WrapKey；幂等，删不存在的 key 也不抛 */
  private async deleteTrustedDeviceWrapKey(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(TRUSTED_DEVICE_WRAPKEY_NAME);
    } catch {
      // 不存在 / 平台不支持 → 静默吞
    }
  }

  /** 同时清掉 vault.trustedDevice 行 + SecureStore WrapKey
   *
   * tryUnlockWithTrustedDevice 在任何校验失败时调用，让下次启动直接走
   * 主密码流程，与 desktop 一致。
   */
  private async clearTrustedDeviceArtifacts(): Promise<void> {
    await this.deleteTrustedDeviceWrapKey();
    try {
      const file = await readVaultFile();
      if (file.trustedDevice) {
        file.trustedDevice = null;
        await writeVaultFile(file);
      }
    } catch {
      // 写盘失败不阻塞主密码兜底路径 —— 下次再清也行
    }
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
