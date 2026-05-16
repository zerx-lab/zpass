// 纯 JS 实现的 TOTP（RFC 6238）—— 移动端无原生 crypto，自带 SHA-1 / HMAC。
//
// 与 desktop 的 totpservice.go 行为一致：默认 SHA-1 / 6 位 / 30 秒周期。
// 用于在 phone 端为带 totp 密钥的登录条目生成真实可用的验证码。

/* ----------------------------------------------------------------------------
 * SHA-1
 * -------------------------------------------------------------------------- */

function rotl(n: number, s: number): number {
  return ((n << s) | (n >>> (32 - s))) >>> 0;
}

/** 对字节数组做 SHA-1，返回 20 字节摘要 */
function sha1(bytes: number[]): number[] {
  const ml = bytes.length * 8;
  const msg = bytes.slice();
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 64 位长度（高 32 位补 0，消息长度远不到 2^32）
  for (let i = 0; i < 4; i++) msg.push(0);
  for (let i = 3; i >= 0; i--) msg.push((ml >>> (i * 8)) & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array<number>(80);
  for (let chunk = 0; chunk < msg.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        (msg[chunk + i * 4] << 24) |
        (msg[chunk + i * 4 + 1] << 16) |
        (msg[chunk + i * 4 + 2] << 8) |
        msg[chunk + i * 4 + 3];
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out: number[] = [];
  for (const h of [h0, h1, h2, h3, h4]) {
    out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * HMAC-SHA1
 * -------------------------------------------------------------------------- */

function hmacSha1(key: number[], msg: number[]): number[] {
  let k = key.slice();
  if (k.length > 64) k = sha1(k);
  while (k.length < 64) k.push(0);

  const oKey = k.map((b) => b ^ 0x5c);
  const iKey = k.map((b) => b ^ 0x36);

  return sha1(oKey.concat(sha1(iKey.concat(msg))));
}

/* ----------------------------------------------------------------------------
 * base32 解码（RFC 4648，忽略空格 / 大小写 / padding）
 * -------------------------------------------------------------------------- */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): number[] {
  const clean = input
    .toUpperCase()
    .replace(/[\s=]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * TOTP
 * -------------------------------------------------------------------------- */

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

/** 当前周期已过秒数（0‥period-1） */
export function totpElapsed(period = TOTP_PERIOD): number {
  return Math.floor(Date.now() / 1000) % period;
}

/** 当前周期剩余秒数（1‥period） */
export function totpRemaining(period = TOTP_PERIOD): number {
  return period - totpElapsed(period);
}

/**
 * 根据 base32 密钥生成当前 TOTP 码。
 * 密钥非法时返回全 0 占位串，避免抛错中断 UI。
 */
export function generateTotp(
  secret: string,
  digits = TOTP_DIGITS,
  period = TOTP_PERIOD,
): string {
  const key = base32Decode(secret);
  if (key.length === 0) return "0".repeat(digits);

  let counter = Math.floor(Date.now() / 1000 / period);
  const msg: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 7; i >= 0; i--) {
    msg[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }

  const hmac = hmacSha1(key, msg);
  const offset = hmac[19] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** 将 "068508" 格式化为 "068 508" */
export function formatTotpCode(code: string): string {
  if (code.length === 6) return code.slice(0, 3) + " " + code.slice(3);
  return code;
}
