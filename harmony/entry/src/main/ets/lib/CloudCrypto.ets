// ZPass HarmonyOS —— 云同步加密 + web_vault 条目编解码
//
// 与 desktop internal/cloudcrypto/* + internal/services/webvaultcodec.go 字节级一致，
// 让鸿蒙端产出与 desktop / web_vault / 服务端完全互通的认证物与密文。
// 零知识：主密码 + Secret Key + AUK + SRP-x + 账户私钥 + per-vault key 永不出设备；
// 服务端只见 SRP verifier/salt、AUK 包裹的账户私钥、账户公钥包裹的 vault key、
// 不透明条目密文、加密 vault meta 与 HMAC content-hash。
//
// 分层：本模块只做「密码学原语编排 + 条目格式转码」，不持有会话/不发网络请求。
//   - 重原语（Argon2id / SRP modexp / X25519）全部走 cryptocore（RustCryptoCore.ets）
//   - SHA-256 / HMAC-SHA256 走系统 cryptoFramework（复用 SyncProtocol.hmacSha256）
//   - Z1 Secret Key 编解码 / web_vault 转码 / content-hash 规范化为纯 ArkTS 逻辑

import {
  deriveAuk as nativeDeriveAuk,
  deriveSrpX as nativeDeriveSrpX,
  keysetGenerate as nativeKeysetGenerate,
  openWithPrivkey,
  sealToPubkey,
  srpClientFinish,
  srpClientStart,
  srpRegister,
  type KeysetPair,
  type SrpClientFinish,
  type SrpClientStart,
  type SrpRegistration,
} from './RustCryptoCore';
import {
  constantTimeEqual,
  openAEAD,
  randomBytes,
  sealAEAD,
  utf8,
  utf8Decode,
} from './Crypto';
import { hexEncode, hmacSha256 } from './SyncProtocol';
import type { ItemPayload, VaultItemType } from './VaultService';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

export type { KeysetPair, SrpClientFinish, SrpClientStart, SrpRegistration };

/* ----------------------------------------------------------------------------
 * 常量 —— 与 desktop cloudcrypto / 服务端对齐
 * -------------------------------------------------------------------------- */

/** 生产 Argon2id 参数（2SKD slow 路径）：64 MiB / 3 / 4。 */
export const CLOUD_ARGON2_MEM_KIB: number = 64 * 1024;
export const CLOUD_ARGON2_ITER: number = 3;
export const CLOUD_ARGON2_PAR: number = 4;
/** kdf_params.alg / sk_version 线值。 */
export const CLOUD_KDF_ALG: string = 'argon2id';
export const CLOUD_SK_VERSION: string = 'Z1';
/** SRP / keyset 盐与 verifier 字节长度。 */
export const CLOUD_SALT_LEN: number = 32;

/** keyset 私钥包裹（AUK 下 AEAD）的 aad。 */
const AAD_KEYSET_PRIV: string = 'zpass-keyset-priv-v1';
/** web_vault VAULT_MANIFEST_ID（hyphenless）—— 非真实条目，pull 时跳过。 */
const VAULT_MANIFEST_LOCAL_ID: string = '000000000000000000000000000000ff';
/** web_vault 信封键（不并入 fields）。 */
const WEB_ENVELOPE_KEYS: string[] = ['v', 'type', 'title', 'createdAt', 'updatedAt'];

const HEX32 = new RegExp('^[0-9a-f]{32}$');

/* ----------------------------------------------------------------------------
 * 错误
 * -------------------------------------------------------------------------- */

export class CloudCryptoError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/* ----------------------------------------------------------------------------
 * SHA-256（系统 cryptoFramework）—— 仅供 M2 校验；HMAC 复用 SyncProtocol
 * -------------------------------------------------------------------------- */

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const md = cryptoFramework.createMd('SHA256');
  md.updateSync({ data });
  const out = md.digestSync();
  return new Uint8Array(out.data);
}

/* ----------------------------------------------------------------------------
 * Secret Key（Z1 编码）—— 与 desktop secretkey.go / skeleton-cli 字节级一致
 *
 * 格式：Z1-<account_id:6>-<g1:26>-<g2:26>-<g3:26>（字母表 A-Z）。
 *   - account_id 的 ASCII 字节 = 2SKD 的 HKDF salt
 *   - body 78 字符各取 (ch - 'A')（0..25）= 78 字节 = 2SKD 的 HKDF IKM（skRaw）
 * Secret Key 永不出设备，仅与主密码一起喂 2SKD；服务端从不接触。
 * -------------------------------------------------------------------------- */

const SK_ALPHABET: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SK_ACCOUNT_ID_LEN: number = 6;
const SK_GROUP_LEN: number = 26;
const SK_BODY_LEN: number = 78; // 3 * 26
const SK_TOTAL_CHARS: number = SK_ACCOUNT_ID_LEN + SK_BODY_LEN; // 84

export interface ParsedSecretKey {
  /** 6 字符账户 id（A-Z）。 */
  accountId: string;
  /** account_id 的 ASCII 字节（HKDF salt）。 */
  accountIdBytes: Uint8Array;
  /** 78 字节熵（HKDF IKM），raw[i] = body[i] - 'A'。 */
  skRaw: Uint8Array;
}

/** 生成新的 Secret Key（注册时一次性产出，展示给用户离线备份）。 */
export function generateSecretKey(): string {
  const rnd = randomBytes(SK_TOTAL_CHARS);
  let chars = '';
  for (let i = 0; i < SK_TOTAL_CHARS; i++) {
    chars += SK_ALPHABET.charAt(rnd[i] % 26);
  }
  const aid = chars.slice(0, SK_ACCOUNT_ID_LEN);
  const g1 = chars.slice(6, 32);
  const g2 = chars.slice(32, 58);
  const g3 = chars.slice(58, 84);
  return `Z1-${aid}-${g1}-${g2}-${g3}`;
}

/** 规范化（去空白/连字符、大写）+ 校验 + 解码 Secret Key。失败抛 CloudCryptoError。 */
export function parseSecretKey(input: string): ParsedSecretKey {
  const canon = (input ?? '')
    .replace(new RegExp('\\s+', 'g'), '')
    .replace(new RegExp('-', 'g'), '')
    .toUpperCase();
  if (canon.indexOf('Z1') !== 0) {
    throw new CloudCryptoError('Secret Key 缺少 Z1 前缀');
  }
  const remainder = canon.slice(2);
  if (remainder.length !== SK_TOTAL_CHARS) {
    throw new CloudCryptoError(`Secret Key 长度非法：${remainder.length}（应为 ${SK_TOTAL_CHARS}）`);
  }
  for (let i = 0; i < remainder.length; i++) {
    if (SK_ALPHABET.indexOf(remainder.charAt(i)) < 0) {
      throw new CloudCryptoError('Secret Key 含非法字符（仅 A-Z）');
    }
  }
  const accountId = remainder.slice(0, SK_ACCOUNT_ID_LEN);
  const accountIdBytes = utf8(accountId); // A-Z 的 UTF-8 == ASCII
  const body = remainder.slice(SK_ACCOUNT_ID_LEN);
  const skRaw = new Uint8Array(SK_BODY_LEN);
  for (let i = 0; i < SK_BODY_LEN; i++) {
    skRaw[i] = body.charCodeAt(i) - 65; // 'A' = 65
  }
  return { accountId, accountIdBytes, skRaw };
}

/** 校验 Secret Key 结构是否合法（不解码）。 */
export function validateSecretKey(input: string): boolean {
  try {
    parseSecretKey(input);
    return true;
  } catch (_e) {
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * 2SKD —— Argon2id(NFKD(trim(pw)), slowSalt) XOR HKDF(ikm=skRaw, salt=accountId, info)
 *
 * password 走原始串（规范化在 cryptocore 内完成）；Argon2id 重活在原生 AsyncTask。
 * -------------------------------------------------------------------------- */

/** 派生 AUK（slowSalt = salt_enc，info = zpass-auk-v1）。 */
export async function deriveAuk(
  password: string,
  saltEnc: Uint8Array,
  sk: ParsedSecretKey,
  memKib: number,
  iter: number,
  par: number,
): Promise<Uint8Array> {
  return nativeDeriveAuk(password, saltEnc, sk.skRaw, sk.accountIdBytes, memKib, iter, par);
}

/** 派生 SRP-x（32B，slowSalt = srp_salt，info = zpass-srpx-v1）。 */
export async function deriveSrpX(
  password: string,
  saltAuth: Uint8Array,
  sk: ParsedSecretKey,
  memKib: number,
  iter: number,
  par: number,
): Promise<Uint8Array> {
  return nativeDeriveSrpX(password, saltAuth, sk.skRaw, sk.accountIdBytes, memKib, iter, par);
}

/* ----------------------------------------------------------------------------
 * SRP-6a 客户端编排
 * -------------------------------------------------------------------------- */

/** 注册：x = big-endian(32B SRP-x)，返回 {salt, verifier(256B)}。 */
export function srpMakeVerifier(srpX: Uint8Array, saltAuth: Uint8Array): SrpRegistration {
  return srpRegister(srpX, saltAuth);
}

/** 客户端 start：生成一次性 a + A（256B PAD）。 */
export function srpStart(): SrpClientStart {
  return srpClientStart();
}

/** 客户端 finish：算 M1 + K。identity = 小写邮箱。 */
export function srpFinish(
  secretA: Uint8Array,
  aPub: Uint8Array,
  bPub: Uint8Array,
  srpX: Uint8Array,
  saltAuth: Uint8Array,
  email: string,
): SrpClientFinish {
  return srpClientFinish(secretA, aPub, bPub, srpX, saltAuth, utf8(email.toLowerCase()));
}

/** 校验服务端 M2 = SHA-256(PAD(A) ‖ M1 ‖ K)，常数时间比较。aPub 即 256B PAD(A)。 */
export async function verifyServerM2(
  aPub: Uint8Array,
  m1: Uint8Array,
  k: Uint8Array,
  serverM2: Uint8Array,
): Promise<boolean> {
  const input = new Uint8Array(aPub.length + m1.length + k.length);
  input.set(aPub, 0);
  input.set(m1, aPub.length);
  input.set(k, aPub.length + m1.length);
  const expected = await sha256(input);
  return constantTimeEqual(expected, serverM2);
}

/* ----------------------------------------------------------------------------
 * 账户 keyset + per-vault key 包裹
 * -------------------------------------------------------------------------- */

/** 生成账户 X25519 keyset（pub32 / priv32）。 */
export function generateKeyset(): KeysetPair {
  return nativeKeysetGenerate();
}

/** 用 AUK 包裹账户私钥（aad=zpass-keyset-priv-v1），输出 72 字节 = /v1/keyset.encrypted_private_key。 */
export function wrapAccountPrivKey(auk: Uint8Array, priv: Uint8Array): Uint8Array {
  return sealAEAD(auk, priv, utf8(AAD_KEYSET_PRIV));
}

/** 用 AUK 解封账户私钥。 */
export function unwrapAccountPrivKey(auk: Uint8Array, wrapped: Uint8Array): Uint8Array {
  return openAEAD(auk, wrapped, utf8(AAD_KEYSET_PRIV));
}

/** 用账户公钥封装 per-vault key（X25519 sealed-box）= wrapped_vault_key。 */
export function sealVaultKey(accountPub: Uint8Array, vaultKey: Uint8Array): Uint8Array {
  return sealToPubkey(accountPub, vaultKey);
}

/** 用账户私钥解封 wrapped_vault_key → per-vault key。 */
export function openVaultKey(accountPriv: Uint8Array, wrapped: Uint8Array): Uint8Array {
  return openWithPrivkey(accountPriv, wrapped);
}

/** 随机生成新的 per-vault key（32 字节）。 */
export function generateVaultKey(): Uint8Array {
  return randomBytes(32);
}

/* ----------------------------------------------------------------------------
 * 条目密文（vault key AEAD，aad = 连字符 UUID）
 * -------------------------------------------------------------------------- */

/** 用 vault key 封装 web_vault 记录明文。aad = cloudId（连字符小写 UUID）。 */
export function sealItemRecord(
  vaultKey: Uint8Array,
  recordPlaintext: Uint8Array,
  cloudId: string,
): Uint8Array {
  return sealAEAD(vaultKey, recordPlaintext, utf8(cloudId));
}

/** 用 vault key 解封条目密文（aad = cloudId）。 */
export function openItemRecord(
  vaultKey: Uint8Array,
  ciphertext: Uint8Array,
  cloudId: string,
): Uint8Array {
  return openAEAD(vaultKey, ciphertext, utf8(cloudId));
}

/* ----------------------------------------------------------------------------
 * 条目 id 映射（本地 hyphenless 32-hex ↔ 云端连字符 UUID）
 * -------------------------------------------------------------------------- */

/** 云端连字符 UUID → 本地 id（小写、去连字符）。 */
export function localItemId(cloudId: string): string {
  return cloudId.replace(new RegExp('-', 'g'), '').toLowerCase();
}

/** 本地 id → 云端连字符 UUID（32-hex 时连字符化，否则原样透传）。 */
export function cloudItemId(localId: string): string {
  const norm = localId.replace(new RegExp('-', 'g'), '').toLowerCase();
  if (HEX32.test(norm)) {
    return `${norm.slice(0, 8)}-${norm.slice(8, 12)}-${norm.slice(12, 16)}-${norm.slice(16, 20)}-${norm.slice(20, 32)}`;
  }
  return localId;
}

/** 是否 web_vault 的 manifest 哨兵 id（非真实条目，pull 时跳过）。 */
export function isVaultManifestId(localId: string): boolean {
  return localId.replace(new RegExp('-', 'g'), '').toLowerCase() === VAULT_MANIFEST_LOCAL_ID;
}

/* ----------------------------------------------------------------------------
 * web_vault ItemRecord 转码
 *
 * 类型：本地 'ssh' ↔ web 'sshKey'，其余原样。
 * 字段重命名（按 web 记录类型）：
 *   card:     number→cardNumber, expiry→cardExpiry, cvv→cardCvv
 *   identity: fullname→fullName, email→identityEmail
 *   sshKey:   private_key→sshPrivateKey, passphrase→sshPassphrase
 * -------------------------------------------------------------------------- */

function recordTypeForLocal(t: string): string {
  return t === 'ssh' ? 'sshKey' : t;
}

function localTypeForRecord(t: string): string {
  return t === 'sshKey' ? 'ssh' : t;
}

function fieldKeyToWeb(recordType: string, key: string): string {
  if (recordType === 'card') {
    if (key === 'number') return 'cardNumber';
    if (key === 'expiry') return 'cardExpiry';
    if (key === 'cvv') return 'cardCvv';
  } else if (recordType === 'identity') {
    if (key === 'fullname') return 'fullName';
    if (key === 'email') return 'identityEmail';
  } else if (recordType === 'sshKey') {
    if (key === 'private_key') return 'sshPrivateKey';
    if (key === 'passphrase') return 'sshPassphrase';
  }
  return key;
}

function fieldKeyFromWeb(recordType: string, key: string): string {
  if (recordType === 'card') {
    if (key === 'cardNumber') return 'number';
    if (key === 'cardExpiry') return 'expiry';
    if (key === 'cardCvv') return 'cvv';
  } else if (recordType === 'identity') {
    if (key === 'fullName') return 'fullname';
    if (key === 'identityEmail') return 'email';
  } else if (recordType === 'sshKey') {
    if (key === 'sshPrivateKey') return 'private_key';
    if (key === 'sshPassphrase') return 'passphrase';
  }
  return key;
}

function isEmptyFieldValue(v: Object): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return (v as string) === '';
  if (typeof v === 'boolean') return (v as boolean) === false;
  if (Array.isArray(v)) return (v as Object[]).length === 0;
  return false;
}

/** 本地 ItemPayload → web_vault 记录明文（JSON 字符串）。空值丢弃，与 web_vault 一致。 */
export function payloadToWebVaultRecord(payload: ItemPayload): string {
  const rec: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
  const recordType = recordTypeForLocal(payload.type);
  rec.v = 2;
  rec.type = recordType;
  rec.title = payload.name;
  if (payload.createdAt > 0) rec.createdAt = payload.createdAt;
  if (payload.updatedAt > 0) rec.updatedAt = payload.updatedAt;
  const fields = payload.fields ?? (JSON.parse('{}') as Record<string, Object>);
  for (const k of Object.keys(fields)) {
    if (WEB_ENVELOPE_KEYS.indexOf(k) >= 0) continue;
    const v = fields[k];
    if (isEmptyFieldValue(v)) continue;
    rec[fieldKeyToWeb(recordType, k)] = v;
  }
  return JSON.stringify(rec);
}

/** web_vault 记录明文 → 本地 ItemPayload。updatedAt/revision 由调用方用 snapshot 值覆盖。 */
export function webVaultRecordToPayload(recordPlaintext: Uint8Array, localId: string): ItemPayload {
  const rec = JSON.parse(utf8Decode(recordPlaintext)) as Record<string, Object>;
  const recordType = typeof rec.type === 'string' ? (rec.type as string) : 'note';
  const localType = localTypeForRecord(recordType) as VaultItemType;
  const name = typeof rec.title === 'string' ? (rec.title as string) : '';
  const createdAt = typeof rec.createdAt === 'number' ? (rec.createdAt as number) : 0;
  const fields: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
  for (const k of Object.keys(rec)) {
    if (WEB_ENVELOPE_KEYS.indexOf(k) >= 0) continue;
    fields[fieldKeyFromWeb(recordType, k)] = rec[k];
  }
  return {
    id: localId,
    type: localType,
    name,
    fields,
    createdAt,
    updatedAt: 0,
    revision: 1,
    deletedAt: null,
  };
}

/* ----------------------------------------------------------------------------
 * content_hash —— hex(HMAC-SHA256(vaultKey, canonicalJSON)[:16])
 *
 * canonicalJSON = {"fields":{<sorted,reduced>},"name":...,"type":<本地类型>}
 * 两端各自从解密后的 payload 重算，故只需本端确定性（键排序）。
 * -------------------------------------------------------------------------- */

function canonicalSerialize(v: Object): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    const arr = v as Object[];
    let s = '[';
    for (let i = 0; i < arr.length; i++) {
      if (i > 0) s += ',';
      s += canonicalSerialize(arr[i]);
    }
    return s + ']';
  }
  const obj = v as Record<string, Object>;
  const keys = Object.keys(obj).sort();
  let s = '{';
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) s += ',';
    s += JSON.stringify(keys[i]) + ':' + canonicalSerialize(obj[keys[i]]);
  }
  return s + '}';
}

/** 计算 content_hash（32 hex 字符）。 */
export async function cloudContentHash(vaultKey: Uint8Array, payload: ItemPayload): Promise<string> {
  const reduced: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
  const fields = payload.fields ?? (JSON.parse('{}') as Record<string, Object>);
  for (const k of Object.keys(fields)) {
    if (WEB_ENVELOPE_KEYS.indexOf(k) >= 0) continue;
    const v = fields[k];
    if (isEmptyFieldValue(v)) continue;
    reduced[k] = v;
  }
  const canonical =
    '{"fields":' + canonicalSerialize(reduced) +
    ',"name":' + JSON.stringify(payload.name) +
    ',"type":' + JSON.stringify(payload.type) + '}';
  const mac = await hmacSha256(vaultKey, utf8(canonical));
  return hexEncode(mac.subarray(0, 16));
}
