// 一次性验证码 (OTP) —— phone 端实现
//
// 与 desktop 的 totpservice.go + parse-otpauth.ts 行为对齐：支持
//   - 协议：RFC 6238 TOTP / RFC 4226 HOTP / Steam Guard
//   - 哈希：SHA1 (默认) / SHA256 / SHA512
//   - 位数：自定义 (TOTP 默认 6，Steam 默认 5)
//   - 周期：自定义 (默认 30s)
//   - 输入：裸 base32 / 含空格大小写 base32 / 完整 otpauth:// URI
//
// 加密原语用 @noble/hashes（已在 dependencies 中）：
//   - sha1   ← @noble/hashes/legacy
//   - sha256 ← @noble/hashes/sha2
//   - sha512 ← @noble/hashes/sha2
//   - hmac   ← @noble/hashes/hmac
//
// 旧 API（TOTP_PERIOD / TOTP_DIGITS / generateTotp / totpElapsed /
// totpRemaining / formatTotpCode）保留，保证现有调用点零迁移。

import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";

/* ----------------------------------------------------------------------------
 * 类型
 * -------------------------------------------------------------------------- */

export type OtpType = "totp" | "hotp" | "steam";
export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";

/** 解析得到的 OTP 元信息快照 —— 既可用于 UI 预览也可直接喂给 computeOtp */
export interface OtpMeta {
  type: OtpType;
  /** 规范化后的 base32 密钥（已去空格 / 转大写 / 去 padding） */
  secret: string;
  /** 发行者，可能为空 */
  issuer: string;
  /** 账户标识，可能为空 */
  account: string;
  algorithm: OtpAlgorithm;
  digits: number;
  /** TOTP/Steam 周期秒数；HOTP 为 0 */
  period: number;
  /** HOTP 计数器；TOTP/Steam 为 0 */
  counter: number;
}

/** otpauth URI 解析错误 —— 让调用方据此映射不同 UI 文案 */
export type OtpParseError =
  | "not-otpauth" // 不是 otpauth:// 开头
  | "invalid-uri" // otpauth:// 但 URL 解析失败
  | "missing-secret" // 缺 secret 参数
  | "invalid-type"; // type 段不是 totp/hotp/steam

export interface OtpParseResult {
  ok: boolean;
  meta?: OtpMeta;
  error?: OtpParseError;
  /** 成功时是规范化的 URI；失败时是原始内容 */
  raw: string;
}

/* ----------------------------------------------------------------------------
 * base32 编解码
 * -------------------------------------------------------------------------- */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 规范化裸 base32：去空白 + 转大写 + 去尾部 padding —— 与 desktop normalizeBase32 等价 */
export function normalizeBase32(s: string): string {
  return s
    .replace(/[\s\t\n\r]+/g, "")
    .toUpperCase()
    .replace(/=+$/, "");
}

/** base32 解码 —— 容忍空格 / 小写 / padding；返回 null 表示输入完全没有合法字符 */
function base32Decode(input: string): Uint8Array | null {
  const clean = input.toUpperCase().replace(/[\s=]/g, "");
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
 * otpauth:// URI 解析
 * -------------------------------------------------------------------------- */

/** 抽出 URI type 段（host），容忍 net/url 不一致行为 —— 与 desktop extractType 等价 */
function extractType(raw: string, parsedHost: string): string {
  if (parsedHost) return parsedHost.toLowerCase();
  const rest = raw.slice("otpauth://".length);
  const slash = rest.indexOf("/");
  const q = rest.indexOf("?");
  const end =
    slash > 0 && (q < 0 || slash < q) ? slash : q > 0 ? q : rest.length;
  return rest.slice(0, end).toLowerCase();
}

/** 从 label 里拆 issuer/account —— 与 desktop splitLabel 等价 */
function splitLabel(pathname: string): { issuer: string; account: string } {
  let raw = pathname.replace(/^\/+/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // 保持原样
  }
  raw = raw.trim();
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    return {
      issuer: raw.slice(0, colonIdx).trim(),
      account: raw.slice(colonIdx + 1).trim(),
    };
  }
  return { issuer: "", account: raw };
}

function parseAlgorithm(s: string): OtpAlgorithm | null {
  switch (s.toUpperCase().trim()) {
    case "SHA1":
      return "SHA1";
    case "SHA256":
      return "SHA256";
    case "SHA512":
      return "SHA512";
  }
  return null;
}

/**
 * 严格解析 otpauth:// URI —— 与 desktop parseOtpauth 行为完全一致
 *
 * 行为：
 *   1. 非 otpauth:// 开头 → not-otpauth
 *   2. URL 解析失败       → invalid-uri
 *   3. type 不在 totp/hotp/steam → invalid-type
 *   4. 缺 secret           → missing-secret
 *   5. 其余                → ok=true + 完整 meta
 *
 * Steam 推断：path=steam 或 issuer=Steam (不区分大小写)。
 */
export function parseOtpauth(raw: string): OtpParseResult {
  const trimmed = raw.trim();
  if (!/^otpauth:\/\//i.test(trimmed)) {
    return { ok: false, error: "not-otpauth", raw };
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid-uri", raw };
  }

  const typePath = extractType(trimmed, u.host);
  if (typePath !== "totp" && typePath !== "hotp" && typePath !== "steam") {
    return { ok: false, error: "invalid-type", raw };
  }

  const params = u.searchParams;
  const secret = normalizeBase32(params.get("secret") ?? "");
  if (!secret) {
    return { ok: false, error: "missing-secret", raw };
  }

  const { issuer: labelIssuer, account } = splitLabel(u.pathname);
  const qIssuer = (params.get("issuer") ?? "").trim();
  const issuer = qIssuer || labelIssuer;

  let type: OtpType = typePath as OtpType;
  if (typePath === "totp" && issuer.toLowerCase() === "steam") {
    type = "steam";
  }

  const algorithm = parseAlgorithm(params.get("algorithm") ?? "") ?? "SHA1";
  const digitsRaw = Number.parseInt(params.get("digits") ?? "", 10);
  const periodRaw = Number.parseInt(params.get("period") ?? "", 10);
  const counterRaw = Number.parseInt(params.get("counter") ?? "", 10);

  const digits = Number.isFinite(digitsRaw)
    ? digitsRaw
    : type === "steam"
      ? 5
      : 6;
  const period =
    type === "hotp" ? 0 : Number.isFinite(periodRaw) ? periodRaw : 30;
  const counter =
    type === "hotp" ? (Number.isFinite(counterRaw) ? counterRaw : 0) : 0;

  return {
    ok: true,
    raw: trimmed,
    meta: { type, secret, issuer, account, algorithm, digits, period, counter },
  };
}

/**
 * 把"原始 secret 字段值"统一解析成 OtpMeta —— 输入既可是 otpauth:// URI
 * 也可是裸 base32 字符串。
 *
 * fieldOverrides 来自 vault 条目的 fields map（与 desktop extractOTPParams
 * 一致的优先级）：
 *   - URI 元信息 < 显式 fields 字段
 *   - 显式字段：otp_type / otp_algorithm / otp_digits / otp_period / hotp_counter
 *
 * 返回 null 表示密钥为空 / 无法识别为合法 base32。
 */
export function resolveOtpMeta(
  rawSecret: string,
  fieldOverrides?: {
    otp_type?: string;
    otp_algorithm?: string;
    otp_digits?: number | string;
    otp_period?: number | string;
    hotp_counter?: number | string;
    issuer?: string;
    account?: string;
  },
): OtpMeta | null {
  const trimmed = (rawSecret ?? "").trim();
  if (!trimmed) return null;

  let meta: OtpMeta;
  if (/^otpauth:\/\//i.test(trimmed)) {
    const parsed = parseOtpauth(trimmed);
    if (!parsed.ok || !parsed.meta) return null;
    meta = { ...parsed.meta };
  } else {
    const secret = normalizeBase32(trimmed);
    if (!secret) return null;
    meta = {
      type: "totp",
      secret,
      issuer: "",
      account: "",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      counter: 0,
    };
  }

  if (fieldOverrides) {
    const ot = (fieldOverrides.otp_type ?? "").toString().trim().toLowerCase();
    if (ot === "totp" || ot === "hotp" || ot === "steam") {
      meta.type = ot;
      // Steam 默认 5 位回退仅在「digits 没有任何显式来源时」适用
      if (ot === "steam" && meta.digits === 6) {
        meta.digits = 5;
      }
      if (ot !== "hotp" && meta.period === 0) meta.period = 30;
    }
    const alg = parseAlgorithm(
      (fieldOverrides.otp_algorithm ?? "").toString(),
    );
    if (alg) meta.algorithm = alg;
    const d = readNumeric(fieldOverrides.otp_digits);
    if (d != null && d > 0 && d <= 10) meta.digits = d;
    const p = readNumeric(fieldOverrides.otp_period);
    if (p != null && p > 0) meta.period = p;
    const c = readNumeric(fieldOverrides.hotp_counter);
    if (c != null && c >= 0) meta.counter = c;
    if (fieldOverrides.issuer && !meta.issuer)
      meta.issuer = fieldOverrides.issuer;
    if (fieldOverrides.account && !meta.account)
      meta.account = fieldOverrides.account;
  }

  return meta;
}

function readNumeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/* ----------------------------------------------------------------------------
 * OTP 计算核心
 * -------------------------------------------------------------------------- */

const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

function hashFn(algo: OtpAlgorithm) {
  if (algo === "SHA256") return sha256;
  if (algo === "SHA512") return sha512;
  return sha1;
}

/** 把 64 位 counter 拆成 8 字节大端表示（用 BigInt 避免 JS number 53 位精度问题） */
function counterToBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return buf;
}

/** RFC 4226 动态截断 + 取模 —— 适用于 TOTP / HOTP 数字码 */
function dynamicTruncate(mac: Uint8Array): number {
  const offset = mac[mac.length - 1] & 0x0f;
  return (
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff)
  );
}

/** Steam Guard 编码：把动态截断结果按 26 字符字母表展开 digits 位 */
function steamEncode(value: number, digits: number): string {
  let s = "";
  let v = value >>> 0;
  for (let i = 0; i < digits; i++) {
    s += STEAM_ALPHABET[v % STEAM_ALPHABET.length];
    v = Math.floor(v / STEAM_ALPHABET.length);
  }
  return s;
}

/**
 * 根据元信息计算当前 OTP 码
 *
 * - TOTP / Steam: 用 now (毫秒) ÷ 周期得到 counter
 * - HOTP        : 用 meta.counter
 *
 * 密钥非法（base32 解码失败 / 空）时返回 digits 长度的占位串（全 0 或全字符表首字符）。
 */
export function computeOtp(meta: OtpMeta, nowMs: number = Date.now()): string {
  const key = base32Decode(meta.secret);
  if (!key || key.length === 0) {
    return meta.type === "steam"
      ? STEAM_ALPHABET[0].repeat(meta.digits)
      : "0".repeat(meta.digits);
  }

  const counter =
    meta.type === "hotp"
      ? meta.counter
      : Math.floor(nowMs / 1000 / (meta.period || 30));

  const mac = hmac(hashFn(meta.algorithm), key, counterToBytes(counter));
  const bin = dynamicTruncate(mac);

  if (meta.type === "steam") {
    return steamEncode(bin, meta.digits);
  }
  return (bin % 10 ** meta.digits).toString().padStart(meta.digits, "0");
}

/** 当前周期剩余秒数（1‥period）；HOTP 返回 0 */
export function otpRemaining(meta: OtpMeta, nowMs: number = Date.now()): number {
  if (meta.type === "hotp" || !meta.period) return 0;
  const elapsed = Math.floor(nowMs / 1000) % meta.period;
  return meta.period - elapsed;
}

/** 当前周期已过秒数（0‥period-1）；HOTP 返回 0 */
export function otpElapsed(meta: OtpMeta, nowMs: number = Date.now()): number {
  if (meta.type === "hotp" || !meta.period) return 0;
  return Math.floor(nowMs / 1000) % meta.period;
}

/* ----------------------------------------------------------------------------
 * 旧 API 别名 —— 保留以减少现有调用点的迁移成本
 * -------------------------------------------------------------------------- */

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

/** 旧 API：默认 TOTP/SHA1/6 位/30s。新代码请用 computeOtp(meta)。 */
export function generateTotp(
  secret: string,
  digits = TOTP_DIGITS,
  period = TOTP_PERIOD,
): string {
  const meta = resolveOtpMeta(secret);
  if (!meta) return "0".repeat(digits);
  // 调用方显式覆盖位数/周期时尊重之
  if (digits !== meta.digits) meta.digits = digits;
  if (period !== meta.period && meta.type !== "hotp") meta.period = period;
  return computeOtp(meta);
}

/** 旧 API：默认 30s 周期。新代码请用 otpRemaining(meta)。 */
export function totpRemaining(period = TOTP_PERIOD): number {
  return period - (Math.floor(Date.now() / 1000) % period);
}

/** 旧 API：默认 30s 周期。新代码请用 otpElapsed(meta)。 */
export function totpElapsed(period = TOTP_PERIOD): number {
  return Math.floor(Date.now() / 1000) % period;
}

/** 把 "068508" 格式化为 "068 508"；非 6 位原样返回 */
export function formatTotpCode(code: string): string {
  if (code.length === 6) return code.slice(0, 3) + " " + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + " " + code.slice(4);
  if (code.length === 5) return code; // Steam 5 位不分组
  return code;
}

/** 把 base32 按 4 字符分组：JBSWY3DPEHPK3PXP → JBSW Y3DP EHPK 3PXP */
export function formatBase32Groups(secret: string): string {
  return secret.replace(/(.{4})(?!$)/g, "$1 ");
}
