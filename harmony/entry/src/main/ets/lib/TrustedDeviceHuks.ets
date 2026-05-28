// 信任设备 WrapKey 存储 —— HUKS + UserAuth 实现
//
// 角色对应 phone/lib/vault-service.ts 中的 SecureStore 三件套
// (writeTrustedDeviceWrapKey / readTrustedDeviceWrapKey / deleteTrustedDeviceWrapKey)。
//
// 算法选型：
//   HarmonyOS HUKS 文档约束：AES + 同时启用 ENC+DEC + USER_AUTH 仅支持 CBC 模式
//   （GCM/CTR/ECB 都不支持细粒度访问控制；尝试 GCM 会以 -4 NOT_SUPPORTED 拒绝
//    initSession）。因此取 AES-256-CBC + PKCS7，与 phone SecureStore
//    `requireAuthentication: true` 一致：write 和 read 都要弹一次生物识别。
//
// 设计：
//   1. HUKS 内生成一把 AES-256-CBC key（alias 固定），生物识别保护，
//      新指纹/人脸录入即失效（HUKS_AUTH_ACCESS_INVALID_NEW_BIO_ENROLL）
//      —— 与 phone biometryCurrentSet 语义对齐
//   2. WrapKey（32B）由 HUKS key 用 AES-CBC + PKCS7 加密；
//      IV(16B) || ciphertext(48B = 32B + 1 完整 padding block) = 64B 落 filesDir
//   3. 加密/解密都需要 initSession 拿 challenge → userAuth.start() 弹生物识别 →
//      AuthResult.token 灌进 HUKS_TAG_AUTH_TOKEN，再 finishSession
//   4. 完整性由上层 verifier 校验兜底（VaultService.tryUnlockWithTrustedDevice
//      解出 DEK 后必须能解 vault.meta.verifier，等于约定明文才认）—— 损失 GCM
//      的 AEAD 没有降低整体安全性
//   5. 三态返回（ok=true / 'absent' / 'transient'）与 phone 一一对齐
//
// 单 class 结构（避免 ArkTS 不识别 discriminated union）

import { huks } from '@kit.UniversalKeystoreKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { KEY_SIZE, randomBytes, wipeBytes } from './Crypto';

const LOG_DOMAIN: number = 0xff00;
const LOG_TAG: string = 'TrustedDeviceHuks';

/* ----------------------------------------------------------------------------
 * 常量
 * -------------------------------------------------------------------------- */

const HUKS_ALIAS: string = 'zpass.trusted_device.wrapkey.v1';
const WRAPKEY_FILE_NAME: string = 'zpass.trusted_device.wrapkey.bin';
const FILES_DIR_KEY: string = 'filesDir';

/** AES block size */
const IV_LEN: number = 16;
/** PKCS7-padded 32B → 48B（32 已是 block 倍数，所以加一整个 16B padding block） */
const CIPHERTEXT_LEN: number = KEY_SIZE + 16;
const WRAPKEY_BLOB_LEN: number = IV_LEN + CIPHERTEXT_LEN; // 64

/* ----------------------------------------------------------------------------
 * 三态返回（与 phone readTrustedDeviceWrapKey 契约一致）
 * -------------------------------------------------------------------------- */

export class ReadWrapKeyResult {
  ok: boolean;
  key: Uint8Array | null;
  /** 'absent' = 永久失效（清孤儿）; 'transient' = 用户取消（可重试）; '' = ok=true */
  reason: string;
  constructor(ok: boolean, key: Uint8Array | null, reason: string) {
    this.ok = ok;
    this.key = key;
    this.reason = reason;
  }
}

/* ----------------------------------------------------------------------------
 * 路径辅助
 * -------------------------------------------------------------------------- */

function filesDir(): string {
  const dir = AppStorage.get<string>(FILES_DIR_KEY);
  if (!dir) {
    throw new Error(
      'filesDir 未初始化；请确保 EntryAbility.onCreate 已写入 AppStorage',
    );
  }
  return dir;
}

function wrapKeyPath(): string {
  return `${filesDir()}/${WRAPKEY_FILE_NAME}`;
}

function tmpPath(): string {
  return `${wrapKeyPath()}.tmp`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return await fs.access(path);
  } catch (_e) {
    return false;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  if (await fileExists(path)) {
    try {
      await fs.unlink(path);
    } catch (_e) {
      // 不存在 / 已被并发删除 —— 静默吞
    }
  }
}

/* ----------------------------------------------------------------------------
 * HUKS 参数工厂 —— AES-256-CBC + PKCS7
 *
 * 该组合是 HUKS 在 USER_AUTH 保护下对 ENC+DEC 双向 AES key 的**唯一**合法模式。
 * GCM/CTR/ECB 在 USER_AUTH 下会被 initSession 以 -4 NOT_SUPPORTED 拒绝。
 * -------------------------------------------------------------------------- */

function generateKeyProps(): huks.HuksParam[] {
  return [
    { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
    { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
    {
      tag: huks.HuksTag.HUKS_TAG_PURPOSE,
      value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT,
    },
    { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_CBC },
    { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_PKCS7 },
    {
      tag: huks.HuksTag.HUKS_TAG_USER_AUTH_TYPE,
      value:
        huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FINGERPRINT |
        huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FACE |
        huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_PIN,
    },
    {
      // PIN 凭证清除时也让 key 失效 —— 与 phone WHEN_UNLOCKED_THIS_DEVICE_ONLY
      // 中 PIN/biometric 任一被清就失效的语义对齐
      tag: huks.HuksTag.HUKS_TAG_KEY_AUTH_ACCESS_TYPE,
      value:
        huks.HuksAuthAccessType.HUKS_AUTH_ACCESS_INVALID_NEW_BIO_ENROLL |
        huks.HuksAuthAccessType.HUKS_AUTH_ACCESS_INVALID_CLEAR_PASSWORD,
    },
    { tag: huks.HuksTag.HUKS_TAG_CHALLENGE_TYPE, value: huks.HuksChallengeType.HUKS_CHALLENGE_TYPE_NORMAL },
  ];
}

function encryptProps(iv: Uint8Array): huks.HuksParam[] {
  return [
    { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
    { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
    { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT },
    { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_CBC },
    { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_PKCS7 },
    { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
  ];
}

function decryptProps(iv: Uint8Array): huks.HuksParam[] {
  return [
    { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
    { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
    { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
    { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_CBC },
    { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_PKCS7 },
    { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
  ];
}

/* ----------------------------------------------------------------------------
 * UserAuth Promise 化
 *
 * 关键约束：authType 数组中**每一项**都必须在指定 trustLevel 下被设备支持；
 * 任何一项不支持都会让整个 getUserAuthInstance 抛 401。所以必须先用
 * getAvailableStatus 过滤，再塞进 authParam。
 *
 * trustLevel = ATL2（应用解锁标准；ATL3 是设备解锁强活体级别，许多设备
 * 的指纹只过 ATL2）。
 *
 * 流程：HUKS initSession 返回 challenge → userAuth.start() 弹生物识别 →
 * onResult 拿 AuthResult.token → 灌进后续 HUKS finishSession 的
 * HUKS_TAG_AUTH_TOKEN 完成操作。
 * -------------------------------------------------------------------------- */

/** 应用解锁的最低 trust level。
 *  ATL3 是设备解锁强活体；ATL2 是应用登录；ATL1 是个人数据访问（含 PIN）。
 *  采用 ATL1 兼容性最佳——许多设备指纹/人脸硬件强度只到 ATL1，
 *  PIN 在 ATL1 才可用作 fallback；官方示例本身就用 PIN+ATL3 / FACE+PIN+ATL3
 *  的组合，说明加 PIN 是标准实践。 */
const AUTH_TRUST_LEVEL: userAuth.AuthTrustLevel = userAuth.AuthTrustLevel.ATL1;

class UserAuthError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** 探测当前设备实际可用的认证类型（FINGERPRINT / FACE / PIN 子集） */
function detectAvailableAuthTypes(): userAuth.UserAuthType[] {
  const out: userAuth.UserAuthType[] = [];
  const candidates: userAuth.UserAuthType[] = [
    userAuth.UserAuthType.FINGERPRINT,
    userAuth.UserAuthType.FACE,
    userAuth.UserAuthType.PIN,
  ];
  for (const t of candidates) {
    try {
      userAuth.getAvailableStatus(t, AUTH_TRUST_LEVEL);
      out.push(t);
      hilog.info(LOG_DOMAIN, LOG_TAG, 'authType=%{public}d available at ATL=%{public}d', t, AUTH_TRUST_LEVEL);
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(LOG_DOMAIN, LOG_TAG, 'authType=%{public}d unavailable: code=%{public}d msg=%{public}s', t, err.code, err.message);
    }
  }
  return out;
}

function runUserAuth(challenge: Uint8Array): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const types = detectAvailableAuthTypes();
    if (types.length === 0) {
      reject(new UserAuthError(12500005, 'no available biometric type'));
      return;
    }

    const authParam: userAuth.AuthParam = {
      challenge,
      authType: types,
      authTrustLevel: AUTH_TRUST_LEVEL,
    };
    const widgetParam: userAuth.WidgetParam = { title: '解锁 ZPass 保险库' };

    let inst: userAuth.UserAuthInstance;
    try {
      inst = userAuth.getUserAuthInstance(authParam, widgetParam);
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(LOG_DOMAIN, LOG_TAG, 'getUserAuthInstance failed: code=%{public}d msg=%{public}s', err.code, err.message);
      reject(new UserAuthError(err.code, err.message));
      return;
    }

    let settled = false;
    const cleanup = (): void => {
      try {
        inst.off('result');
      } catch (_e) {
        // 已经 off 过 / 实例释放 —— 静默
      }
    };

    inst.on('result', {
      onResult: (r: userAuth.UserAuthResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (
          r.result === userAuth.UserAuthResultCode.SUCCESS &&
          r.token &&
          r.token.length > 0
        ) {
          resolve(r.token);
        } else {
          hilog.error(LOG_DOMAIN, LOG_TAG, 'userAuth onResult result=%{public}d', r.result);
          reject(new UserAuthError(r.result, `userAuth result=${r.result}`));
        }
      },
    });

    try {
      inst.start();
    } catch (e) {
      if (settled) return;
      settled = true;
      cleanup();
      const err = e as BusinessError;
      hilog.error(LOG_DOMAIN, LOG_TAG, 'userAuth.start() failed: code=%{public}d msg=%{public}s', err.code, err.message);
      reject(new UserAuthError(err.code, err.message));
    }
  });
}

/* ----------------------------------------------------------------------------
 * 错误码 → 三态映射
 *
 * 参考：
 *   - @ohos.userIAM.userAuth UserAuthResultCode
 *   - @ohos.security.huks HuksExceptionErrCode
 * 默认未识别错误 → 'transient'（与 phone 防御策略一致：宁可让用户再点）
 * -------------------------------------------------------------------------- */

const ABSENT_CODES: ReadonlySet<number> = new Set<number>([
  // HUKS
  12000011, // HUKS_ERR_CODE_ITEM_NOT_EXIST
  12000009, // HUKS_ERR_CODE_KEY_AUTH_PERMANENTLY_INVALIDATED（新生物识别录入）
  // userAuth
  12500005, // TYPE_NOT_SUPPORT
  12500010, // NOT_ENROLLED
]);

function classifyError(code: number): string {
  return ABSENT_CODES.has(code) ? 'absent' : 'transient';
}

/* ----------------------------------------------------------------------------
 * HUKS 会话辅助
 * -------------------------------------------------------------------------- */

async function huksKeyExists(): Promise<boolean> {
  try {
    return await huks.isKeyItemExist(HUKS_ALIAS, { properties: [] });
  } catch (_e) {
    return false;
  }
}

async function deleteHuksKey(): Promise<void> {
  try {
    await huks.deleteKeyItem(HUKS_ALIAS, { properties: [] });
  } catch (_e) {
    // 不存在 → 幂等吞
  }
}

/* ----------------------------------------------------------------------------
 * 二进制文件原子写
 *
 * 与 VaultStorage 同模式：写 tmp + moveFile 覆盖。WrapKey blob 是定长
 * 60B，无需分块。
 * -------------------------------------------------------------------------- */

async function writeBlob(blob: Uint8Array): Promise<void> {
  if (blob.length !== WRAPKEY_BLOB_LEN) {
    throw new Error(`wrapkey blob length must be ${WRAPKEY_BLOB_LEN}, got ${blob.length}`);
  }
  const tmp = tmpPath();
  const dst = wrapKeyPath();
  const handle = await fs.open(
    tmp,
    fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC,
  );
  try {
    const buf = new ArrayBuffer(blob.length);
    new Uint8Array(buf).set(blob);
    await fs.write(handle.fd, buf);
  } finally {
    await fs.close(handle.fd);
  }
  await unlinkIfExists(dst);
  await fs.moveFile(tmp, dst);
}

async function readBlob(): Promise<Uint8Array | null> {
  const path = wrapKeyPath();
  if (!(await fileExists(path))) return null;
  const handle = await fs.open(path, fs.OpenMode.READ_ONLY);
  try {
    const buf = new ArrayBuffer(WRAPKEY_BLOB_LEN + 1);
    const n = await fs.read(handle.fd, buf);
    if (n !== WRAPKEY_BLOB_LEN) return null;
    return new Uint8Array(buf.slice(0, n));
  } finally {
    await fs.close(handle.fd);
  }
}

/* ----------------------------------------------------------------------------
 * 对外契约
 * -------------------------------------------------------------------------- */

export async function isTrustedKeystoreSupported(): Promise<boolean> {
  // 任一生物识别可用即认为支持；trust level 与 runUserAuth 一致用 ATL2，
  // 否则探测和实际调用不一致会导致 enable 时弹窗失败
  return detectAvailableAuthTypes().length > 0;
}

export async function writeTrustedWrapKey(key: Uint8Array): Promise<void> {
  if (key.length !== KEY_SIZE) {
    throw new Error(`trusted wrap key length must be ${KEY_SIZE}, got ${key.length}`);
  }

  // 旧 key 兜底（重新启用场景）—— 重新生成即可，旧 blob 文件随之被新文件覆盖
  await deleteHuksKey();

  // 1. 生成 HUKS key
  try {
    await huks.generateKeyItem(HUKS_ALIAS, { properties: generateKeyProps() });
  } catch (e) {
    const err = e as BusinessError;
    hilog.error(LOG_DOMAIN, LOG_TAG, 'generateKeyItem failed: code=%{public}d msg=%{public}s', err.code, err.message);
    throw new Error(`生物识别密钥生成失败 (code=${err.code})`);
  }

  const iv = randomBytes(IV_LEN);
  const props = encryptProps(iv);
  const inBuf = new ArrayBuffer(key.length);
  new Uint8Array(inBuf).set(key);

  // 2. initSession 拿 handle + challenge
  let handle: number;
  let challenge: Uint8Array;
  try {
    const sess = await huks.initSession(HUKS_ALIAS, { properties: props });
    handle = sess.handle;
    challenge = sess.challenge ?? new Uint8Array();
  } catch (e) {
    await deleteHuksKey();
    const err = e as BusinessError;
    hilog.error(LOG_DOMAIN, LOG_TAG, 'initSession(encrypt) failed: code=%{public}d msg=%{public}s', err.code, err.message);
    throw new Error(`HUKS 初始化失败 (code=${err.code})`);
  }

  // 3. userAuth 弹生物识别拿 authToken
  let authToken: Uint8Array;
  try {
    authToken = await runUserAuth(challenge);
  } catch (e) {
    try {
      await huks.abortSession(handle, { properties: props });
    } catch (_e) {
      // best-effort
    }
    await deleteHuksKey();
    if (e instanceof UserAuthError) {
      hilog.error(LOG_DOMAIN, LOG_TAG, 'userAuth(encrypt) failed: code=%{public}d', e.code);
      throw new Error(`生物识别失败 (code=${e.code})`);
    }
    throw e as Error;
  }

  // 4. finishSession with HUKS_TAG_AUTH_TOKEN
  const finishProps: huks.HuksParam[] = encryptProps(iv);
  finishProps.push({ tag: huks.HuksTag.HUKS_TAG_AUTH_TOKEN, value: authToken });
  let outBytes: Uint8Array;
  try {
    const finishRet = await huks.finishSession(
      handle,
      { properties: finishProps, inData: new Uint8Array(inBuf) },
    );
    outBytes = finishRet.outData ?? new Uint8Array();
  } catch (e) {
    try {
      await huks.abortSession(handle, { properties: props });
    } catch (_e) {
      // best-effort
    }
    await deleteHuksKey();
    const err = e as BusinessError;
    hilog.error(LOG_DOMAIN, LOG_TAG, 'finishSession(encrypt) failed: code=%{public}d msg=%{public}s', err.code, err.message);
    throw new Error(`HUKS 加密失败 (code=${err.code})`);
  } finally {
    wipeBytes(authToken);
  }

  // AES-CBC + PKCS7：32B 明文 → 48B 密文（含一整个 padding block）
  if (outBytes.length !== CIPHERTEXT_LEN) {
    await deleteHuksKey();
    throw new Error(`HUKS 加密输出长度异常: ${outBytes.length}`);
  }

  // 5. 拼 IV || ciphertext 落盘
  const blob = new Uint8Array(WRAPKEY_BLOB_LEN);
  blob.set(iv, 0);
  blob.set(outBytes, IV_LEN);
  try {
    await writeBlob(blob);
  } catch (e) {
    await deleteHuksKey();
    await unlinkIfExists(tmpPath());
    if (e instanceof Error) throw e;
    throw new Error(String(e));
  } finally {
    wipeBytes(blob);
    wipeBytes(outBytes);
  }
}

export async function readTrustedWrapKey(): Promise<ReadWrapKeyResult> {
  // 1. 读 blob
  let blob: Uint8Array | null;
  try {
    blob = await readBlob();
  } catch (_e) {
    return new ReadWrapKeyResult(false, null, 'absent');
  }
  if (!blob || blob.length !== WRAPKEY_BLOB_LEN) {
    return new ReadWrapKeyResult(false, null, 'absent');
  }

  // 2. 拆 IV / ciphertext（CBC + PKCS7 无 tag）
  const iv = blob.slice(0, IV_LEN);
  const ciphertext = blob.slice(IV_LEN);
  wipeBytes(blob);

  // 3. HUKS key 存在性检查
  if (!(await huksKeyExists())) {
    return new ReadWrapKeyResult(false, null, 'absent');
  }

  const props = decryptProps(iv);

  // 4. initSession 拿 challenge
  let handle: number;
  let challenge: Uint8Array;
  try {
    const sess = await huks.initSession(HUKS_ALIAS, { properties: props });
    handle = sess.handle;
    challenge = sess.challenge ?? new Uint8Array();
  } catch (e) {
    const err = e as BusinessError;
    hilog.error(LOG_DOMAIN, LOG_TAG, 'initSession(decrypt) failed: code=%{public}d msg=%{public}s', err.code, err.message);
    return new ReadWrapKeyResult(false, null, classifyError(err.code));
  }

  // 5. userAuth → authToken
  let authToken: Uint8Array;
  try {
    authToken = await runUserAuth(challenge);
  } catch (e) {
    try {
      await huks.abortSession(handle, { properties: props });
    } catch (_e) {
      // best-effort
    }
    if (e instanceof UserAuthError) {
      return new ReadWrapKeyResult(false, null, classifyError(e.code));
    }
    return new ReadWrapKeyResult(false, null, 'transient');
  }

  // 6. finishSession 解密
  const finishProps: huks.HuksParam[] = decryptProps(iv);
  finishProps.push({ tag: huks.HuksTag.HUKS_TAG_AUTH_TOKEN, value: authToken });
  const inBuf = new ArrayBuffer(ciphertext.length);
  new Uint8Array(inBuf).set(ciphertext);
  try {
    const finishRet = await huks.finishSession(
      handle,
      { properties: finishProps, inData: new Uint8Array(inBuf) },
    );
    const plain = finishRet.outData ?? new Uint8Array();
    if (plain.length !== KEY_SIZE) {
      return new ReadWrapKeyResult(false, null, 'absent');
    }
    return new ReadWrapKeyResult(true, plain, '');
  } catch (e) {
    try {
      await huks.abortSession(handle, { properties: props });
    } catch (_e) {
      // best-effort
    }
    const err = e as BusinessError;
    hilog.error(LOG_DOMAIN, LOG_TAG, 'finishSession(decrypt) failed: code=%{public}d msg=%{public}s', err.code, err.message);
    return new ReadWrapKeyResult(false, null, classifyError(err.code));
  } finally {
    wipeBytes(authToken);
  }
}

export async function deleteTrustedWrapKey(): Promise<void> {
  // 顺序：先删 HUKS key（与 phone "先清 SecureStore" 同样语义），再删文件。
  // 两边都幂等；中间崩溃下次启动 readTrustedWrapKey 会落到 'absent' 分支
  // 由 VaultService.clearTrustedDeviceArtifacts 兜底清行。
  await deleteHuksKey();
  await unlinkIfExists(wrapKeyPath());
  await unlinkIfExists(tmpPath());
}
