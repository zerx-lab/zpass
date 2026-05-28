// 一次性验证码 (TOTP / HOTP / Steam) —— HarmonyOS 实现
//
// 与 phone/lib/totp.ts 严格对齐。
// ArkTS strict 规避：所有 obj literal 走 helper 构造；spread 用显式赋值。

/* ----------------------------------------------------------------------------
 * 类型
 * -------------------------------------------------------------------------- */

export type OtpType = 'totp' | 'hotp' | 'steam';
export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface OtpMeta {
  type: OtpType;
  secret: string;
  issuer: string;
  account: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  counter: number;
}

function newOtpMeta(
  type: OtpType, secret: string, issuer: string, account: string,
  algorithm: OtpAlgorithm, digits: number, period: number, counter: number,
): OtpMeta {
  return { type, secret, issuer, account, algorithm, digits, period, counter };
}

function copyOtpMeta(m: OtpMeta): OtpMeta {
  return {
    type: m.type, secret: m.secret, issuer: m.issuer, account: m.account,
    algorithm: m.algorithm, digits: m.digits, period: m.period, counter: m.counter,
  };
}

export type OtpParseError = 'not-otpauth' | 'invalid-uri' | 'missing-secret' | 'invalid-type';

export interface OtpParseResult {
  ok: boolean;
  meta?: OtpMeta;
  error?: OtpParseError;
  raw: string;
}

interface LabelParts {
  issuer: string;
  account: string;
}

/* ----------------------------------------------------------------------------
 * base32
 * -------------------------------------------------------------------------- */

const B32_ALPHABET: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function normalizeBase32(s: string): string {
  return s.replace(/[\s\t\n\r]+/g, '').toUpperCase().replace(/=+$/, '');
}

function base32Decode(input: string): Uint8Array | null {
  const clean = input.toUpperCase().replace(/[\s=]/g, '');
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/* ----------------------------------------------------------------------------
 * SHA-1 / SHA-256 (纯 JS)
 * -------------------------------------------------------------------------- */

interface Hasher {
  blockSize: number;
  digestSize: number;
  hash(data: Uint8Array): Uint8Array;
}

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function padBlocks(data: Uint8Array, bitLen: number): Uint8Array {
  const padLen = ((data.length + 9 + 63) & ~63) - data.length;
  const out = new Uint8Array(data.length + padLen);
  out.set(data, 0);
  out[data.length] = 0x80;
  const dv = new DataView(out.buffer);
  dv.setUint32(out.length - 4, bitLen >>> 0, false);
  dv.setUint32(out.length - 8, Math.floor(bitLen / 0x100000000), false);
  return out;
}

function sha1Block(state: Uint32Array, block: DataView): void {
  const w = new Uint32Array(80);
  for (let i = 0; i < 16; i++) w[i] = block.getUint32(i * 4, false);
  for (let i = 16; i < 80; i++) {
    w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  }
  let a = state[0], b = state[1], c = state[2], d = state[3], e = state[4];
  for (let i = 0; i < 80; i++) {
    let f: number; let k: number;
    if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
    else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
    else { f = b ^ c ^ d; k = 0xca62c1d6; }
    const t = (rotl32(a, 5) + f + e + k + w[i]) >>> 0;
    e = d; d = c; c = rotl32(b, 30); b = a; a = t;
  }
  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
}

function sha1Hash(data: Uint8Array): Uint8Array {
  const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const padded = padBlocks(data, data.length * 8);
  for (let off = 0; off < padded.length; off += 64) {
    sha1Block(state, new DataView(padded.buffer, padded.byteOffset + off, 64));
  }
  const out = new Uint8Array(20);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) dv.setUint32(i * 4, state[i], false);
  return out;
}

class Sha1Hasher implements Hasher {
  blockSize: number = 64;
  digestSize: number = 20;
  hash(data: Uint8Array): Uint8Array { return sha1Hash(data); }
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Block(state: Uint32Array, block: DataView): void {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) w[i] = block.getUint32(i * 4, false);
  for (let i = 16; i < 64; i++) {
    const s0 = rotl32(w[i - 15], 25) ^ rotl32(w[i - 15], 14) ^ (w[i - 15] >>> 3);
    const s1 = rotl32(w[i - 2], 15) ^ rotl32(w[i - 2], 13) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let a = state[0], b = state[1], c = state[2], d = state[3];
  let e = state[4], f = state[5], g = state[6], h = state[7];
  for (let i = 0; i < 64; i++) {
    const S1 = rotl32(e, 26) ^ rotl32(e, 21) ^ rotl32(e, 7);
    const ch = (e & f) ^ ((~e) & g);
    const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
    const S0 = rotl32(a, 30) ^ rotl32(a, 19) ^ rotl32(a, 10);
    const mj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + mj) >>> 0;
    h = g; g = f; f = e;
    e = (d + t1) >>> 0;
    d = c; c = b; b = a;
    a = (t1 + t2) >>> 0;
  }
  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

function sha256Hash(data: Uint8Array): Uint8Array {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const padded = padBlocks(data, data.length * 8);
  for (let off = 0; off < padded.length; off += 64) {
    sha256Block(state, new DataView(padded.buffer, padded.byteOffset + off, 64));
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, state[i], false);
  return out;
}

class Sha256Hasher implements Hasher {
  blockSize: number = 64;
  digestSize: number = 32;
  hash(data: Uint8Array): Uint8Array { return sha256Hash(data); }
}

class Sha512Hasher implements Hasher {
  blockSize: number = 128;
  digestSize: number = 64;
  hash(_data: Uint8Array): Uint8Array {
    throw new Error('SHA512 OTP not yet implemented on harmony');
  }
}

const SHA1: Hasher = new Sha1Hasher();
const SHA256: Hasher = new Sha256Hasher();
const SHA512: Hasher = new Sha512Hasher();

function hasherFor(algo: OtpAlgorithm): Hasher {
  if (algo === 'SHA256') return SHA256;
  if (algo === 'SHA512') return SHA512;
  return SHA1;
}

/* ----------------------------------------------------------------------------
 * HMAC
 * -------------------------------------------------------------------------- */

function hmac(h: Hasher, key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > h.blockSize) k = h.hash(k);
  if (k.length < h.blockSize) {
    const padded = new Uint8Array(h.blockSize);
    padded.set(k, 0);
    k = padded;
  }
  const opad = new Uint8Array(h.blockSize);
  const ipad = new Uint8Array(h.blockSize);
  for (let i = 0; i < h.blockSize; i++) {
    opad[i] = k[i] ^ 0x5c;
    ipad[i] = k[i] ^ 0x36;
  }
  const inner = new Uint8Array(h.blockSize + msg.length);
  inner.set(ipad, 0);
  inner.set(msg, h.blockSize);
  const innerHash = h.hash(inner);
  const outer = new Uint8Array(h.blockSize + innerHash.length);
  outer.set(opad, 0);
  outer.set(innerHash, h.blockSize);
  return h.hash(outer);
}

/* ----------------------------------------------------------------------------
 * OTP
 * -------------------------------------------------------------------------- */

const STEAM_ALPHABET: string = '23456789BCDFGHJKMNPQRTVWXY';

function counterToBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return buf;
}

function dynamicTruncate(mac: Uint8Array): number {
  const offset = mac[mac.length - 1] & 0x0f;
  return ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16)
    | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
}

function steamEncode(value: number, digits: number): string {
  let s = '';
  let v = value >>> 0;
  for (let i = 0; i < digits; i++) {
    s += STEAM_ALPHABET[v % STEAM_ALPHABET.length];
    v = Math.floor(v / STEAM_ALPHABET.length);
  }
  return s;
}

export function computeOtp(meta: OtpMeta, nowMs: number = Date.now()): string {
  const key = base32Decode(meta.secret);
  if (!key || key.length === 0) {
    return meta.type === 'steam'
      ? STEAM_ALPHABET[0].repeat(meta.digits)
      : '0'.repeat(meta.digits);
  }
  const counter =
    meta.type === 'hotp'
      ? meta.counter
      : Math.floor(nowMs / 1000 / (meta.period || 30));
  const mac = hmac(hasherFor(meta.algorithm), key, counterToBytes(counter));
  const bin = dynamicTruncate(mac);
  if (meta.type === 'steam') return steamEncode(bin, meta.digits);
  return (bin % Math.pow(10, meta.digits)).toString().padStart(meta.digits, '0');
}

export function otpRemaining(meta: OtpMeta, nowMs: number = Date.now()): number {
  if (meta.type === 'hotp' || !meta.period) return 0;
  const elapsed = Math.floor(nowMs / 1000) % meta.period;
  return meta.period - elapsed;
}

export function otpElapsed(meta: OtpMeta, nowMs: number = Date.now()): number {
  if (meta.type === 'hotp' || !meta.period) return 0;
  return Math.floor(nowMs / 1000) % meta.period;
}

/* ----------------------------------------------------------------------------
 * otpauth:// 解析
 * -------------------------------------------------------------------------- */

function parseAlgorithm(s: string): OtpAlgorithm | null {
  const v = s.toUpperCase().trim();
  if (v === 'SHA1') return 'SHA1';
  if (v === 'SHA256') return 'SHA256';
  if (v === 'SHA512') return 'SHA512';
  return null;
}

function splitLabel(pathname: string): LabelParts {
  let raw = pathname.replace(/^\/+/, '');
  try {
    raw = decodeURIComponent(raw);
  } catch (_e) { /* keep raw */ }
  raw = raw.trim();
  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0) {
    return { issuer: raw.slice(0, colonIdx).trim(), account: raw.slice(colonIdx + 1).trim() };
  }
  return { issuer: '', account: raw };
}

function failResult(err: OtpParseError, raw: string): OtpParseResult {
  return { ok: false, error: err, raw };
}

function okResult(meta: OtpMeta, raw: string): OtpParseResult {
  return { ok: true, meta, raw };
}

export function parseOtpauth(raw: string): OtpParseResult {
  const trimmed = raw.trim();
  if (!/^otpauth:\/\//i.test(trimmed)) return failResult('not-otpauth', raw);

  const body = trimmed.slice('otpauth://'.length);
  let typePath = '';
  let labelAndQuery = '';
  const slash = body.indexOf('/');
  if (slash < 0) {
    typePath = body.toLowerCase();
  } else {
    typePath = body.slice(0, slash).toLowerCase();
    labelAndQuery = body.slice(slash + 1);
  }

  if (typePath !== 'totp' && typePath !== 'hotp' && typePath !== 'steam') {
    return failResult('invalid-type', raw);
  }

  let labelPath = labelAndQuery;
  let queryString = '';
  const qmark = labelAndQuery.indexOf('?');
  if (qmark >= 0) {
    labelPath = labelAndQuery.slice(0, qmark);
    queryString = labelAndQuery.slice(qmark + 1);
  }

  const params = new Map<string, string>();
  if (queryString) {
    for (const pair of queryString.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        params.set(decodeURIComponent(pair), '');
      } else {
        const k = decodeURIComponent(pair.slice(0, eq));
        let v = pair.slice(eq + 1);
        try { v = decodeURIComponent(v); } catch (_e) { /* keep raw */ }
        params.set(k, v);
      }
    }
  }

  const secret = normalizeBase32(params.get('secret') ?? '');
  if (!secret) return failResult('missing-secret', raw);

  const split = splitLabel('/' + labelPath);
  const qIssuer = (params.get('issuer') ?? '').trim();
  const issuer = qIssuer || split.issuer;

  let type: OtpType = typePath as OtpType;
  if (typePath === 'totp' && issuer.toLowerCase() === 'steam') type = 'steam';

  const algorithm = parseAlgorithm(params.get('algorithm') ?? '') ?? 'SHA1';
  const digitsRaw = Number.parseInt(params.get('digits') ?? '', 10);
  const periodRaw = Number.parseInt(params.get('period') ?? '', 10);
  const counterRaw = Number.parseInt(params.get('counter') ?? '', 10);

  const digits = Number.isFinite(digitsRaw) ? digitsRaw : type === 'steam' ? 5 : 6;
  const period = type === 'hotp' ? 0 : (Number.isFinite(periodRaw) ? periodRaw : 30);
  const counter = type === 'hotp' ? (Number.isFinite(counterRaw) ? counterRaw : 0) : 0;

  return okResult(
    newOtpMeta(type, secret, issuer, split.account, algorithm, digits, period, counter),
    trimmed,
  );
}

/** 把 raw secret（base32 或 otpauth://）统一解析成 OtpMeta */
export function resolveOtpMeta(rawSecret: string, fieldOverrides?: Map<string, string>): OtpMeta | null {
  const trimmed = (rawSecret ?? '').trim();
  if (!trimmed) return null;

  let meta: OtpMeta;
  if (/^otpauth:\/\//i.test(trimmed)) {
    const parsed = parseOtpauth(trimmed);
    if (!parsed.ok || !parsed.meta) return null;
    meta = copyOtpMeta(parsed.meta);
  } else {
    const secret = normalizeBase32(trimmed);
    if (!secret) return null;
    meta = newOtpMeta('totp', secret, '', '', 'SHA1', 6, 30, 0);
  }

  if (fieldOverrides) {
    const otRaw = fieldOverrides.get('otp_type');
    if (typeof otRaw === 'string') {
      const ot = otRaw.trim().toLowerCase();
      if (ot === 'totp' || ot === 'hotp' || ot === 'steam') {
        meta.type = ot as OtpType;
        if (ot === 'steam' && meta.digits === 6) meta.digits = 5;
        if (ot !== 'hotp' && meta.period === 0) meta.period = 30;
      }
    }
    const algRaw = fieldOverrides.get('otp_algorithm');
    if (typeof algRaw === 'string') {
      const alg = parseAlgorithm(algRaw);
      if (alg) meta.algorithm = alg;
    }
    const d = readNumeric(fieldOverrides.get('otp_digits'));
    if (d !== null && d > 0 && d <= 10) meta.digits = d;
    const p = readNumeric(fieldOverrides.get('otp_period'));
    if (p !== null && p > 0) meta.period = p;
    const c = readNumeric(fieldOverrides.get('hotp_counter'));
    if (c !== null && c >= 0) meta.counter = c;
    const iss = fieldOverrides.get('issuer');
    if (iss && !meta.issuer) meta.issuer = iss;
    const acc = fieldOverrides.get('account');
    if (acc && !meta.account) meta.account = acc;
  }

  return meta;
}

function readNumeric(v: string | undefined): number | null {
  if (typeof v === 'string') {
    const n = Number.parseInt(v.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/* ----------------------------------------------------------------------------
 * 旧 API 别名
 * -------------------------------------------------------------------------- */

export const TOTP_PERIOD: number = 30;
export const TOTP_DIGITS: number = 6;

export function generateTotp(secret: string, digits: number = TOTP_DIGITS, period: number = TOTP_PERIOD): string {
  const meta = resolveOtpMeta(secret);
  if (!meta) return '0'.repeat(digits);
  if (digits !== meta.digits) meta.digits = digits;
  if (period !== meta.period && meta.type !== 'hotp') meta.period = period;
  return computeOtp(meta);
}

export function totpRemaining(period: number = TOTP_PERIOD): number {
  return period - (Math.floor(Date.now() / 1000) % period);
}

export function totpElapsed(period: number = TOTP_PERIOD): number {
  return Math.floor(Date.now() / 1000) % period;
}

export function formatTotpCode(code: string): string {
  if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
  if (code.length === 5) return code;
  return code;
}

export function formatBase32Groups(secret: string): string {
  return secret.replace(/(.{4})(?!$)/g, '$1 ');
}
