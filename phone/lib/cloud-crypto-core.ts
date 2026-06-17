// ZPass Phone —— 云同步加密「纯」核心层（仅依赖 @noble，可在 node/bun 下单测）
//
// 与 cryptocore/src/{kdf2,srp,keyset,envelope}.rs + harmony CloudCrypto.ets
// 字节级一致。本文件刻意**不**引入任何 expo / react-native / 原生桥依赖，
// 因此可被 node/bun 直接 import 做跨端字节回归（见 tests/cloud-crypto-vectors）。
//
// 随机数 / Argon2id 三层加速等运行时副作用留在 cloud-crypto.ts，本层只做
// 确定性的密码学编排：SRP-6a transcript、X25519 sealed-box、2SKD 的 HKDF+XOR、
// Secret Key 编解码、web_vault 条目转码、content_hash 规范化。

import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

/* ----------------------------------------------------------------------------
 * 基础字节工具
 * -------------------------------------------------------------------------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}
export function utf8Decode(b: Uint8Array): string {
  return dec.decode(b);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function hexEncode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** 常量时间比较，避免时序侧信道。 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bytesToBigint(b: Uint8Array): bigint {
  let r = 0n;
  for (let i = 0; i < b.length; i++) r = (r << 8n) | BigInt(b[i]);
  return r;
}

function bigintToBytesBE(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/* ----------------------------------------------------------------------------
 * AEAD：XChaCha20-Poly1305 —— 与 lib/crypto.ts sealAEAD/openAEAD 字节一致
 * 封装格式：[24B nonce][ciphertext+16B tag]。nonce 由调用方提供（便于纯函数化）。
 * -------------------------------------------------------------------------- */

export const NONCE_SIZE = 24;
const TAG_SIZE = 16;
const KEY_SIZE = 32;

export function sealAEADWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_SIZE) throw new Error(`aead key length must be ${KEY_SIZE}`);
  if (nonce.length !== NONCE_SIZE) throw new Error(`aead nonce length must be ${NONCE_SIZE}`);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return concatBytes(nonce, ct);
}

export function openAEAD(
  key: Uint8Array,
  envelope: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_SIZE) throw new Error(`aead key length must be ${KEY_SIZE}`);
  if (envelope.length < NONCE_SIZE + TAG_SIZE) throw new Error("aead envelope too short");
  const nonce = envelope.subarray(0, NONCE_SIZE);
  const ct = envelope.subarray(NONCE_SIZE);
  return xchacha20poly1305(key, nonce, aad).decrypt(ct);
}

/* ----------------------------------------------------------------------------
 * 域分离常量（envelope.rs）
 * -------------------------------------------------------------------------- */

const INFO_AUK_V1 = utf8("zpass-auk-v1");
const INFO_SRPX_V1 = utf8("zpass-srpx-v1");
const INFO_VAULTKEY_V1 = utf8("zpass-vaultkey-v1");
export const AAD_KEYSET_PRIV = utf8("zpass-keyset-priv-v1");
export const AAD_VAULT_META = utf8("zpass:vault-meta:v1");

/* ----------------------------------------------------------------------------
 * 2SKD —— out = Argon2id(NFKD(pw), slowSalt) XOR HKDF(ikm=skRaw, salt=accountId, info)
 * 慢哈希（Argon2id）由调用方算好传入 `slow`；本层只做 HKDF + XOR（确定性）。
 * -------------------------------------------------------------------------- */

/** out = slow XOR HKDF-SHA256(ikm=skRaw, salt=accountId, info, 32)（2SKD 混合，T1.d 字节序）。 */
function derive2skd(
  slow: Uint8Array,
  skRaw: Uint8Array,
  accountId: Uint8Array,
  info: Uint8Array,
): Uint8Array {
  const mix = hkdf(sha256, skRaw, accountId, info, 32);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = slow[i] ^ mix[i];
  return out;
}

export function derive2skdAuk(slow: Uint8Array, skRaw: Uint8Array, accountId: Uint8Array): Uint8Array {
  return derive2skd(slow, skRaw, accountId, INFO_AUK_V1);
}

export function derive2skdSrpX(slow: Uint8Array, skRaw: Uint8Array, accountId: Uint8Array): Uint8Array {
  return derive2skd(slow, skRaw, accountId, INFO_SRPX_V1);
}

/* ----------------------------------------------------------------------------
 * Secret Key（Z1 编码）—— Z1-<aid:6>-<g1:26>-<g2:26>-<g3:26>，字母表 A-Z
 * -------------------------------------------------------------------------- */

export const SK_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const SK_ACCOUNT_ID_LEN = 6;
const SK_BODY_LEN = 78; // 3 * 26
export const SK_TOTAL_CHARS = SK_ACCOUNT_ID_LEN + SK_BODY_LEN; // 84

export interface ParsedSecretKey {
  accountId: string;
  accountIdBytes: Uint8Array;
  skRaw: Uint8Array;
}

export function parseSecretKey(input: string): ParsedSecretKey {
  const canon = (input ?? "")
    .replace(/\s+/g, "")
    .replace(/-/g, "")
    .toUpperCase();
  if (canon.indexOf("Z1") !== 0) throw new Error("Secret Key 缺少 Z1 前缀");
  const remainder = canon.slice(2);
  if (remainder.length !== SK_TOTAL_CHARS) {
    throw new Error(`Secret Key 长度非法：${remainder.length}（应为 ${SK_TOTAL_CHARS}）`);
  }
  for (let i = 0; i < remainder.length; i++) {
    if (SK_ALPHABET.indexOf(remainder.charAt(i)) < 0) {
      throw new Error("Secret Key 含非法字符（仅 A-Z）");
    }
  }
  const accountId = remainder.slice(0, SK_ACCOUNT_ID_LEN);
  const accountIdBytes = utf8(accountId); // A-Z 的 UTF-8 == ASCII
  const body = remainder.slice(SK_ACCOUNT_ID_LEN);
  const skRaw = new Uint8Array(SK_BODY_LEN);
  for (let i = 0; i < SK_BODY_LEN; i++) skRaw[i] = body.charCodeAt(i) - 65; // 'A' = 65
  return { accountId, accountIdBytes, skRaw };
}

export function validateSecretKey(input: string): boolean {
  try {
    parseSecretKey(input);
    return true;
  } catch {
    return false;
  }
}

/** 把 84 个 0..255 随机字节映射成 A-Z 串，组装 Z1 Secret Key。 */
export function secretKeyFromRandom(rnd: Uint8Array): string {
  if (rnd.length < SK_TOTAL_CHARS) throw new Error("secret key entropy too short");
  let chars = "";
  for (let i = 0; i < SK_TOTAL_CHARS; i++) chars += SK_ALPHABET.charAt(rnd[i] % 26);
  const aid = chars.slice(0, SK_ACCOUNT_ID_LEN);
  const g1 = chars.slice(6, 32);
  const g2 = chars.slice(32, 58);
  const g3 = chars.slice(58, 84);
  return `Z1-${aid}-${g1}-${g2}-${g3}`;
}

/* ----------------------------------------------------------------------------
 * SRP-6a —— RFC 5054 §2.5-2.6，2048-bit 群，g=2，哈希 SHA-256
 * -------------------------------------------------------------------------- */

const N_HEX =
  "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050" +
  "A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50" +
  "E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8" +
  "55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B" +
  "CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748" +
  "544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6" +
  "AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6" +
  "94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73";

const N_BYTE_LEN = 256;
const N = BigInt("0x" + N_HEX);
const G = 2n;
const N_BYTES = bigintToBytesBE(N, N_BYTE_LEN);

function pad(x: bigint): Uint8Array {
  return bigintToBytesBE(x, N_BYTE_LEN);
}

function sha256Chunks(...chunks: Uint8Array[]): Uint8Array {
  return sha256(concatBytes(...chunks));
}

/** k = H(N | PAD(g))（RFC 5054 §2.5.3）。 */
function computeK(): bigint {
  return bytesToBigint(sha256Chunks(N_BYTES, pad(G)));
}

/** u = H(PAD(A) | PAD(B))（RFC 5054 §2.6）。 */
function computeU(a: bigint, b: bigint): bigint {
  return bytesToBigint(sha256Chunks(pad(a), pad(b)));
}

export interface SrpRegistration {
  salt: Uint8Array;
  verifier: Uint8Array;
}
export interface SrpClientStart {
  secretA: Uint8Array;
  aPub: Uint8Array;
}
export interface SrpClientFinish {
  m1: Uint8Array;
  k: Uint8Array;
}

/** 注册：v = g^x mod N（PAD 到 256 字节）。x = big-endian(32B srpX)，不 mod N。 */
export function srpRegister(xBytes: Uint8Array, salt: Uint8Array): SrpRegistration {
  if (xBytes.length !== 32) throw new Error("srp x must be 32 bytes");
  const x = bytesToBigint(xBytes);
  const v = modpow(G, x, N);
  return { salt: salt.slice(), verifier: pad(v) };
}

/** 客户端 start：A = g^a mod N（PAD 256）。a 为调用方提供的 32B 一次性私钥。 */
export function srpClientStartFromSecret(aSecret: Uint8Array): SrpClientStart {
  const a = bytesToBigint(aSecret);
  const aPub = modpow(G, a, N);
  return { secretA: aSecret.slice(), aPub: pad(aPub) };
}

/**
 * 客户端 finish：S = (B - k·g^x)^(a + u·x) mod N，K = H(PAD(S))，
 * M1 = H( (H(N) XOR H(g)) | H(I) | s | PAD(A) | PAD(B) | K )。identity = utf8(lowercase email)。
 */
export function srpClientFinish(
  aSecret: Uint8Array,
  aPub: Uint8Array,
  bPub: Uint8Array,
  xBytes: Uint8Array,
  salt: Uint8Array,
  identity: Uint8Array,
): SrpClientFinish {
  if (xBytes.length !== 32) throw new Error("srp x must be 32 bytes");
  const aPriv = bytesToBigint(aSecret);
  const a = bytesToBigint(aPub);
  const b = bytesToBigint(bPub);
  if (b % N === 0n) throw new Error("srp server B ≡ 0 mod N");
  const x = bytesToBigint(xBytes);
  const k = computeK();
  const u = computeU(a, b);
  const gx = modpow(G, x, N);
  const kgx = (k * gx) % N;
  const base = ((b % N) + N - kgx) % N;
  const exp = aPriv + u * x;
  const s = modpow(base, exp, N);
  const sessionKey = sha256(pad(s));
  const hn = sha256(N_BYTES);
  const hg = sha256(pad(G));
  const hnXorHg = new Uint8Array(32);
  for (let i = 0; i < 32; i++) hnXorHg[i] = hn[i] ^ hg[i];
  const hi = sha256(identity);
  const m1 = sha256Chunks(hnXorHg, hi, salt, pad(a), pad(b), sessionKey);
  return { m1, k: sessionKey };
}

/** 校验服务端 M2 = H(PAD(A) | M1 | K)，常数时间比较。aPub 为 256B PAD(A)。 */
export function verifyServerM2(
  aPub: Uint8Array,
  m1: Uint8Array,
  k: Uint8Array,
  serverM2: Uint8Array,
): boolean {
  const a = bytesToBigint(aPub);
  const expected = sha256Chunks(pad(a), m1, k);
  return constantTimeEqual(expected, serverM2);
}

/* ----------------------------------------------------------------------------
 * X25519 sealed-box（keyset.rs）
 *   out = eph_pub(32) || seal_aead(sym, plaintext, aad=INFO_VAULTKEY_V1)
 *   sym = HKDF-SHA256(ikm=ECDH, salt=eph_pub||recipient_pub, info=INFO_VAULTKEY_V1, 32)
 * -------------------------------------------------------------------------- */

export const X25519_KEY_SIZE = 32;

export function keysetPublicFromPriv(priv: Uint8Array): Uint8Array {
  return x25519.getPublicKey(priv);
}

function deriveSym(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(ephPub, recipientPub), INFO_VAULTKEY_V1, 32);
}

/** sealed-box 封装（eph 私钥 + AEAD nonce 由调用方注入，便于纯函数化与测试）。 */
export function sealToPubkeyDet(
  recipientPub: Uint8Array,
  plaintext: Uint8Array,
  ephSeed: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  if (recipientPub.length !== X25519_KEY_SIZE) throw new Error("recipient pub must be 32 bytes");
  const ephPub = x25519.getPublicKey(ephSeed);
  const shared = x25519.getSharedSecret(ephSeed, recipientPub);
  const sym = deriveSym(shared, ephPub, recipientPub);
  const ct = sealAEADWithNonce(sym, plaintext, INFO_VAULTKEY_V1, nonce);
  return concatBytes(ephPub, ct);
}

export function openWithPrivkey(priv: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (priv.length !== X25519_KEY_SIZE) throw new Error("priv must be 32 bytes");
  if (sealed.length < X25519_KEY_SIZE + NONCE_SIZE + TAG_SIZE) throw new Error("sealed too short");
  const ephPub = sealed.subarray(0, X25519_KEY_SIZE);
  const ct = sealed.subarray(X25519_KEY_SIZE);
  const recipientPub = x25519.getPublicKey(priv);
  const shared = x25519.getSharedSecret(priv, ephPub);
  const sym = deriveSym(shared, ephPub, recipientPub);
  return openAEAD(sym, ct, INFO_VAULTKEY_V1);
}

/* ----------------------------------------------------------------------------
 * 条目 id 映射（本地 hyphenless 32-hex ↔ 云端连字符 UUID）
 * -------------------------------------------------------------------------- */

const HEX32 = /^[0-9a-f]{32}$/;
const VAULT_MANIFEST_LOCAL_ID = "000000000000000000000000000000ff";

export function localItemId(cloudId: string): string {
  return cloudId.replace(/-/g, "").toLowerCase();
}

export function cloudItemId(localId: string): string {
  const norm = localId.replace(/-/g, "").toLowerCase();
  if (HEX32.test(norm)) {
    return `${norm.slice(0, 8)}-${norm.slice(8, 12)}-${norm.slice(12, 16)}-${norm.slice(16, 20)}-${norm.slice(20, 32)}`;
  }
  return localId;
}

export function isVaultManifestId(localId: string): boolean {
  return localId.replace(/-/g, "").toLowerCase() === VAULT_MANIFEST_LOCAL_ID;
}

/* ----------------------------------------------------------------------------
 * web_vault ItemRecord 转码（与 desktop webvaultcodec.go 一致）
 * -------------------------------------------------------------------------- */

export const WEB_ENVELOPE_KEYS = ["v", "type", "title", "createdAt", "updatedAt", "spaceId"];

export interface RecordShape {
  type: string;
  name: string;
  fields: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function recordTypeForLocal(t: string): string {
  return t === "ssh" ? "sshKey" : t;
}
function localTypeForRecord(t: string): string {
  return t === "sshKey" ? "ssh" : t;
}

function fieldKeyToWeb(recordType: string, key: string): string {
  if (recordType === "card") {
    if (key === "number") return "cardNumber";
    if (key === "expiry") return "cardExpiry";
    if (key === "cvv") return "cardCvv";
  } else if (recordType === "identity") {
    if (key === "fullname") return "fullName";
    if (key === "email") return "identityEmail";
  } else if (recordType === "sshKey") {
    if (key === "private_key") return "sshPrivateKey";
    if (key === "passphrase") return "sshPassphrase";
  }
  return key;
}

function fieldKeyFromWeb(recordType: string, key: string): string {
  if (recordType === "card") {
    if (key === "cardNumber") return "number";
    if (key === "cardExpiry") return "expiry";
    if (key === "cardCvv") return "cvv";
  } else if (recordType === "identity") {
    if (key === "fullName") return "fullname";
    if (key === "identityEmail") return "email";
  } else if (recordType === "sshKey") {
    if (key === "sshPrivateKey") return "private_key";
    if (key === "sshPassphrase") return "passphrase";
  }
  return key;
}

function isEmptyFieldValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (typeof v === "boolean") return v === false;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 本地记录 → web_vault 明文（JSON 字符串）。空值丢弃。 */
export function payloadToWebVaultRecord(rec: RecordShape): string {
  const out: Record<string, unknown> = {};
  const recordType = recordTypeForLocal(rec.type);
  out.v = 2;
  out.type = recordType;
  out.title = rec.name;
  if (rec.createdAt > 0) out.createdAt = rec.createdAt;
  if (rec.updatedAt > 0) out.updatedAt = rec.updatedAt;
  const fields = rec.fields ?? {};
  for (const k of Object.keys(fields)) {
    if (WEB_ENVELOPE_KEYS.indexOf(k) >= 0) continue;
    const v = fields[k];
    if (isEmptyFieldValue(v)) continue;
    out[fieldKeyToWeb(recordType, k)] = v;
  }
  return JSON.stringify(out);
}

/** web_vault 明文 → 本地记录形状（updatedAt/revision 由调用方覆盖）。 */
export function webVaultRecordToPayload(recordPlaintext: Uint8Array): RecordShape {
  const rec = JSON.parse(utf8Decode(recordPlaintext)) as Record<string, unknown>;
  const recordType = typeof rec.type === "string" ? rec.type : "note";
  const localType = localTypeForRecord(recordType);
  const name = typeof rec.title === "string" ? rec.title : "";
  const createdAt = typeof rec.createdAt === "number" ? rec.createdAt : 0;
  const fields: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    if (WEB_ENVELOPE_KEYS.indexOf(k) >= 0) continue;
    fields[fieldKeyFromWeb(recordType, k)] = rec[k];
  }
  return { type: localType, name, fields, createdAt, updatedAt: 0 };
}

/* ----------------------------------------------------------------------------
 * content_hash —— hex(HMAC-SHA256(vaultKey, canonicalJSON)[:16])
 * canonicalJSON = {"fields":{<sorted,reduced>},"name":...,"type":<本地类型>}
 * -------------------------------------------------------------------------- */

function canonicalSerialize(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    let s = "[";
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ",";
      s += canonicalSerialize(v[i]);
    }
    return s + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  let s = "{";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) s += ",";
    s += JSON.stringify(keys[i]) + ":" + canonicalSerialize(obj[keys[i]]);
  }
  return s + "}";
}

export function cloudContentHash(
  vaultKey: Uint8Array,
  fields: Record<string, unknown>,
  name: string,
  type: string,
): string {
  const reduced: Record<string, unknown> = {};
  const f = fields ?? {};
  for (const k of Object.keys(f)) {
    if (WEB_ENVELOPE_KEYS.indexOf(k) >= 0) continue;
    const v = f[k];
    if (isEmptyFieldValue(v)) continue;
    reduced[k] = v;
  }
  const canonical =
    '{"fields":' +
    canonicalSerialize(reduced) +
    ',"name":' +
    JSON.stringify(name) +
    ',"type":' +
    JSON.stringify(type) +
    "}";
  const mac = hmac(sha256, vaultKey, utf8(canonical));
  return hexEncode(mac.subarray(0, 16));
}
