// 云同步敏感数据的 HUKS 静态包裹（at-rest 加密）
//
// 目的：把云账户的 Secret Key + JWT token 以**设备绑定**的 HUKS 密钥加密后再落沙箱，
// 而非明文 JSON —— 即使沙箱文件被提取，密文也因 HUKS 密钥不可导出（TEE 绑定）而无用。
//
// 与 TrustedDeviceHuks 的区别：那把 key 受 USER_AUTH（生物识别）保护、用于 vault 解锁；
// 这把 key **不带 USER_AUTH**，供 app 自由读写（云密钥在每次同步持久化时都要读写，不能弹窗）。
// 算法 AES-256-CBC + PKCS7（非 USER_AUTH 下 CBC/GCM 均可；沿用项目已验证的 CBC 会话流，
// GCM 的 AE_TAG 处理在无设备环境下风险更高）。完整性由上层兜底（密文被篡改 → 解出乱码 →
// JSON.parse 失败 / 服务端 401 → 重新登录），与信任设备「verifier 兜底」同理。
//
// 落盘形态：调用方拿到 iv(16) || ciphertext 的 blob，base64 后存进 CloudStorage 的
// account.secrets 字段。HUKS 不可用（如模拟器）时由 CloudService 退化为明文存储。

import { huks } from '@kit.UniversalKeystoreKit';
import { randomBytes } from './Crypto';

const HUKS_ALIAS: string = 'zpass.cloud.secrets.v1';
const IV_LEN: number = 16;

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
  ];
}

function cipherProps(iv: Uint8Array, encrypt: boolean): huks.HuksParam[] {
  return [
    { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
    { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
    {
      tag: huks.HuksTag.HUKS_TAG_PURPOSE,
      value: encrypt ? huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT : huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT,
    },
    { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_CBC },
    { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_PKCS7 },
    { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
  ];
}

async function keyExists(): Promise<boolean> {
  try {
    return await huks.isKeyItemExist(HUKS_ALIAS, { properties: [] });
  } catch (_e) {
    return false;
  }
}

async function ensureKey(): Promise<void> {
  if (await keyExists()) return;
  await huks.generateKeyItem(HUKS_ALIAS, { properties: generateKeyProps() });
}

/** 加密 plaintext → iv(16) ‖ ciphertext。HUKS 不可用时抛错（调用方退化为明文）。 */
export async function sealCloudSecrets(plaintext: Uint8Array): Promise<Uint8Array> {
  await ensureKey();
  const iv = randomBytes(IV_LEN);
  const props = cipherProps(iv, true);
  const inBuf = new ArrayBuffer(plaintext.length);
  new Uint8Array(inBuf).set(plaintext);
  const sess = await huks.initSession(HUKS_ALIAS, { properties: props });
  const handle = sess.handle;
  try {
    const ret = await huks.finishSession(handle, { properties: props, inData: new Uint8Array(inBuf) });
    const ct = ret.outData ?? new Uint8Array();
    const blob = new Uint8Array(IV_LEN + ct.length);
    blob.set(iv, 0);
    blob.set(ct, IV_LEN);
    return blob;
  } catch (e) {
    try {
      await huks.abortSession(handle, { properties: props });
    } catch (_e) {
      // best-effort
    }
    throw e as Error;
  }
}

/** 解密 sealCloudSecrets 输出。HUKS 密钥缺失 / 密文损坏时抛错。 */
export async function openCloudSecrets(blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length <= IV_LEN) throw new Error('cloud secrets blob too short');
  if (!(await keyExists())) throw new Error('cloud secrets HUKS key missing');
  const iv = blob.slice(0, IV_LEN);
  const ct = blob.slice(IV_LEN);
  const props = cipherProps(iv, false);
  const inBuf = new ArrayBuffer(ct.length);
  new Uint8Array(inBuf).set(ct);
  const sess = await huks.initSession(HUKS_ALIAS, { properties: props });
  const handle = sess.handle;
  try {
    const ret = await huks.finishSession(handle, { properties: props, inData: new Uint8Array(inBuf) });
    return ret.outData ?? new Uint8Array();
  } catch (e) {
    try {
      await huks.abortSession(handle, { properties: props });
    } catch (_e) {
      // best-effort
    }
    throw e as Error;
  }
}

/** 删除云密钥 HUKS key（登出时清理）。幂等。 */
export async function deleteCloudSecretsKey(): Promise<void> {
  try {
    await huks.deleteKeyItem(HUKS_ALIAS, { properties: [] });
  } catch (_e) {
    // 不存在 → 幂等吞
  }
}
