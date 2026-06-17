// ZPass Phone —— 云同步加密业务封装
//
// 在 cloud-crypto-core（纯 @noble，可单测）之上补齐运行时副作用：CSPRNG、
// Argon2id 三层加速、ItemPayload 适配。导出 API 与 harmony CloudCrypto.ets 对齐，
// 供 cloud-service / cloud-sync 直接消费。字节布局已对 cryptocore KAT 向量验证。
//
// 零知识：主密码 + Secret Key + AUK + SRP-x + 账户私钥 + per-vault key 永不出设备。

import { argon2idRawAsync, randomBytes, type Argon2idParams } from "./crypto";
import type { ItemPayload, VaultItemType } from "./vault-service";
import {
  AAD_KEYSET_PRIV,
  AAD_VAULT_META,
  cloudContentHash as coreContentHash,
  cloudItemId,
  derive2skdAuk,
  derive2skdSrpX,
  isVaultManifestId,
  keysetPublicFromPriv,
  localItemId,
  openAEAD,
  openWithPrivkey,
  parseSecretKey,
  payloadToWebVaultRecord as corePayloadToWebVaultRecord,
  sealAEADWithNonce,
  sealToPubkeyDet,
  secretKeyFromRandom,
  srpClientFinish,
  srpClientStartFromSecret,
  srpRegister,
  utf8,
  utf8Decode,
  validateSecretKey,
  verifyServerM2 as coreVerifyServerM2,
  webVaultRecordToPayload as coreWebVaultRecordToPayload,
  type ParsedSecretKey,
  type SrpClientFinish,
  type SrpClientStart,
  type SrpRegistration,
  NONCE_SIZE,
} from "./cloud-crypto-core";

export { parseSecretKey, validateSecretKey };
export type { ParsedSecretKey, SrpClientFinish, SrpClientStart, SrpRegistration };

/* ----------------------------------------------------------------------------
 * 常量 —— 与 desktop cloudcrypto / 服务端对齐
 * -------------------------------------------------------------------------- */

/** 生产 Argon2id 参数（2SKD slow 路径）：64 MiB / 3 / 4。 */
export const CLOUD_ARGON2_MEM_KIB = 64 * 1024;
export const CLOUD_ARGON2_ITER = 3;
export const CLOUD_ARGON2_PAR = 4;
/** kdf_params.alg / sk_version 线值。 */
export const CLOUD_KDF_ALG = "argon2id";
export const CLOUD_SK_VERSION = "Z1";
/** SRP / keyset 盐字节长度。 */
export const CLOUD_SALT_LEN = 32;

export class CloudCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudCryptoError";
  }
}

export interface KeysetPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface CloudVaultMeta {
  name: string;
  glyph: string;
}

/* ----------------------------------------------------------------------------
 * Secret Key
 * -------------------------------------------------------------------------- */

/** 生成新的 Secret Key（注册时一次性产出，展示给用户离线备份）。 */
export function generateSecretKey(): string {
  return secretKeyFromRandom(randomBytes(84));
}

/* ----------------------------------------------------------------------------
 * 2SKD —— Argon2id(NFKD(trim(pw)), slowSalt) XOR HKDF(skRaw, accountId, info)
 * Argon2id 走 lib/crypto 三层加速（native → wasm → noble），password 先做 NFKD(trim)。
 * -------------------------------------------------------------------------- */

async function argon2Slow(
  password: string,
  slowSalt: Uint8Array,
  memKib: number,
  iter: number,
  par: number,
): Promise<Uint8Array> {
  const params: Argon2idParams = {
    memoryKiB: memKib,
    iterations: iter,
    parallelism: par,
    keyLen: 32,
  };
  return argon2idRawAsync(utf8(password.trim().normalize("NFKD")), slowSalt, params);
}

/** 派生 AUK（slowSalt = salt_enc，info = zpass-auk-v1）。 */
export async function deriveAuk(
  password: string,
  saltEnc: Uint8Array,
  sk: ParsedSecretKey,
  memKib: number,
  iter: number,
  par: number,
): Promise<Uint8Array> {
  const slow = await argon2Slow(password, saltEnc, memKib, iter, par);
  return derive2skdAuk(slow, sk.skRaw, sk.accountIdBytes);
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
  const slow = await argon2Slow(password, saltAuth, memKib, iter, par);
  return derive2skdSrpX(slow, sk.skRaw, sk.accountIdBytes);
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
  // RFC 5054 §2.5.4：ephemeral 非零。CSPRNG 给全零概率约 2^-256，仍重试以求稳健。
  for (;;) {
    const a = randomBytes(32);
    let nonzero = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== 0) {
        nonzero = true;
        break;
      }
    }
    if (nonzero) return srpClientStartFromSecret(a);
  }
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

/** 校验服务端 M2 = SHA-256(PAD(A) ‖ M1 ‖ K)，常数时间比较。 */
export function verifyServerM2(
  aPub: Uint8Array,
  m1: Uint8Array,
  k: Uint8Array,
  serverM2: Uint8Array,
): boolean {
  return coreVerifyServerM2(aPub, m1, k, serverM2);
}

/* ----------------------------------------------------------------------------
 * 账户 keyset + per-vault key 包裹
 * -------------------------------------------------------------------------- */

/** 生成账户 X25519 keyset（pub32 / priv32）。 */
export function generateKeyset(): KeysetPair {
  const privateKey = randomBytes(32);
  return { privateKey, publicKey: keysetPublicFromPriv(privateKey) };
}

/** 用 AUK 包裹账户私钥（aad=zpass-keyset-priv-v1）→ /v1/keyset.encrypted_private_key。 */
export function wrapAccountPrivKey(auk: Uint8Array, priv: Uint8Array): Uint8Array {
  return sealAEADWithNonce(auk, priv, AAD_KEYSET_PRIV, randomBytes(NONCE_SIZE));
}

/** 用 AUK 解封账户私钥。 */
export function unwrapAccountPrivKey(auk: Uint8Array, wrapped: Uint8Array): Uint8Array {
  return openAEAD(auk, wrapped, AAD_KEYSET_PRIV);
}

/** 用账户公钥封装 per-vault key（X25519 sealed-box）= wrapped_vault_key。 */
export function sealVaultKey(accountPub: Uint8Array, vaultKey: Uint8Array): Uint8Array {
  return sealToPubkeyDet(accountPub, vaultKey, randomBytes(32), randomBytes(NONCE_SIZE));
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
  return sealAEADWithNonce(vaultKey, recordPlaintext, utf8(cloudId), randomBytes(NONCE_SIZE));
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
 * vault meta（空间名/字形）—— vault key AEAD，aad=zpass:vault-meta:v1
 * -------------------------------------------------------------------------- */

/** 用 vault key 封装 vault meta → encrypted_meta 明文字节。 */
export function sealVaultMeta(vaultKey: Uint8Array, meta: CloudVaultMeta): Uint8Array {
  const json = '{"name":' + JSON.stringify(meta.name) + ',"glyph":' + JSON.stringify(meta.glyph) + "}";
  return sealAEADWithNonce(vaultKey, utf8(json), AAD_VAULT_META, randomBytes(NONCE_SIZE));
}

/** 用 vault key 解封 vault meta。失败抛错（调用方按「无名」回退）。 */
export function openVaultMeta(vaultKey: Uint8Array, sealed: Uint8Array): CloudVaultMeta {
  const plain = openAEAD(vaultKey, sealed, AAD_VAULT_META);
  const obj = JSON.parse(utf8Decode(plain)) as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : "";
  const glyph = typeof obj.glyph === "string" ? obj.glyph : "";
  return { name, glyph };
}

/* ----------------------------------------------------------------------------
 * 条目 id 映射 + web_vault 转码 + content_hash（适配 ItemPayload）
 * -------------------------------------------------------------------------- */

export { cloudItemId, isVaultManifestId, localItemId };

/** 本地 ItemPayload → web_vault 记录明文（JSON 字符串）。 */
export function payloadToWebVaultRecord(payload: ItemPayload): string {
  return corePayloadToWebVaultRecord({
    type: payload.type,
    name: payload.name,
    fields: payload.fields,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  });
}

/** web_vault 记录明文 → 本地 ItemPayload。updatedAt/revision 由调用方用 snapshot 值覆盖。 */
export function webVaultRecordToPayload(recordPlaintext: Uint8Array, localId: string): ItemPayload {
  const rec = coreWebVaultRecordToPayload(recordPlaintext);
  return {
    id: localId,
    type: rec.type as VaultItemType,
    name: rec.name,
    fields: rec.fields,
    createdAt: rec.createdAt,
    updatedAt: 0,
    revision: 1,
    deletedAt: null,
  };
}

/** 计算 content_hash（32 hex 字符）。 */
export async function cloudContentHash(vaultKey: Uint8Array, payload: ItemPayload): Promise<string> {
  return coreContentHash(vaultKey, payload.fields, payload.name, payload.type);
}
