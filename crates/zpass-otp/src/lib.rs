//! `zpass-otp` — TOTP / HOTP / Steam Guard 纯计算 crate（spec/06）。
//!
//! 设计原则（与 spec/06 § 1 一致）：
//! - **不**触碰 vault / 文件系统 / 时钟（unix_seconds 由调用方传入）
//! - **不**异步、**不** std
//! - 输入 = `secret_base32` + 算法参数 + 时间或计数器；输出 = `OtpCode`
//!
//! HOTP 计数器持久化由 `zpass-vault-service::advance_hotp_counter` 负责
//! （详见 spec/06 § 4）。

#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::fmt;

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};

// ===================== 公开类型 =====================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtpAlgorithm {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtpType {
    Totp,
    Hotp,
    Steam,
}

#[derive(Debug, Clone)]
pub struct OtpInput<'a> {
    pub secret_base32: &'a str,
    pub algorithm: OtpAlgorithm,
    /// TOTP / HOTP 默认 6；Steam 固定 5（由 `steam_guard()` 自行处理）。
    pub digits: u8,
    /// 仅 TOTP / Steam 使用（典型 30 秒）。
    pub period_sec: u32,
    /// 仅 HOTP 使用。
    pub counter: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtpCode {
    pub code: String,
    pub r#type: OtpType,
    /// TOTP/Steam: period_sec；HOTP: 0。
    pub period: u32,
    /// TOTP/Steam: `period - (unix_seconds % period)`；HOTP: 0。
    pub remaining: u32,
    /// HOTP: 当前 counter（计算时输入的值）；TOTP/Steam: 0。
    pub counter: u64,
    pub algorithm: OtpAlgorithm,
    pub digits: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOtp {
    pub r#type: OtpType,
    pub secret_base32: String,
    pub algorithm: OtpAlgorithm,
    pub digits: u8,
    pub period_sec: u32,
    pub counter: Option<u64>,
    pub issuer: Option<String>,
    pub account: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtpError {
    /// base32 解码失败。
    InvalidSecret,
    /// digits 不在 6..=10。
    InvalidDigits,
    /// period_sec = 0。
    InvalidPeriod,
    /// otpauth:// 解析失败。
    InvalidUri,
    /// HOTP URI 缺 counter 参数（spec/06 § 7 测试 `parse_otpauth_uri_hotp_with_counter`）。
    MissingCounter,
    UnsupportedAlgorithm,
}

impl fmt::Display for OtpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSecret => f.write_str("invalid base32 secret"),
            Self::InvalidDigits => f.write_str("digits must be 6..=10"),
            Self::InvalidPeriod => f.write_str("period must be > 0"),
            Self::InvalidUri => f.write_str("invalid otpauth:// URI"),
            Self::MissingCounter => f.write_str("HOTP URI missing counter parameter"),
            Self::UnsupportedAlgorithm => f.write_str("unsupported algorithm"),
        }
    }
}

// ===================== 内部工具 =====================

/// Spec/06 § 3：大小写归一 + 去空白 + 去 `=` 填充。
///
/// 注意：此函数只做形态规整；非 base32 字符（如 `'0'`, `'1'`, `'8'`, `'9'`）
/// 由后续 `BASE32_NOPAD.decode()` 验证并以 `InvalidSecret` 返回。
fn normalize_base32(input: &str) -> String {
    input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn decode_secret(secret_base32: &str) -> Result<Vec<u8>, OtpError> {
    let normalized = normalize_base32(secret_base32);
    BASE32_NOPAD
        .decode(normalized.as_bytes())
        .map_err(|_| OtpError::InvalidSecret)
}

/// 计算 HMAC(algorithm, key, counter_be_bytes)。
fn hmac_bytes(algorithm: OtpAlgorithm, key: &[u8], counter: u64) -> Vec<u8> {
    let msg = counter.to_be_bytes();
    match algorithm {
        OtpAlgorithm::Sha1 => {
            let mut mac =
                <Hmac<Sha1> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
            mac.update(&msg);
            mac.finalize().into_bytes().to_vec()
        }
        OtpAlgorithm::Sha256 => {
            let mut mac =
                <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
            mac.update(&msg);
            mac.finalize().into_bytes().to_vec()
        }
        OtpAlgorithm::Sha512 => {
            let mut mac =
                <Hmac<Sha512> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
            mac.update(&msg);
            mac.finalize().into_bytes().to_vec()
        }
    }
}

/// RFC 4226 § 5.3 dynamic truncation → digits 位数字字符串。
fn truncate(hs: &[u8], digits: u8) -> String {
    let offset = (hs[hs.len() - 1] & 0x0F) as usize;
    let bin_code = u32::from_be_bytes([
        hs[offset] & 0x7F,
        hs[offset + 1],
        hs[offset + 2],
        hs[offset + 3],
    ]);
    let modulus = 10u32.pow(digits as u32);
    let code_num = bin_code % modulus;
    let mut s = String::with_capacity(digits as usize);
    // 左侧补 0 到 digits 位。
    let raw = {
        // alloc::format! 在 no_std 下要通过 fmt::Write。
        use core::fmt::Write as _;
        let mut buf = String::new();
        // 安全：write! 到 String 不会失败。
        let _ = write!(&mut buf, "{code_num}");
        buf
    };
    for _ in 0..(digits as usize).saturating_sub(raw.len()) {
        s.push('0');
    }
    s.push_str(&raw);
    s
}

fn validate_digits(digits: u8) -> Result<(), OtpError> {
    if !(6..=10).contains(&digits) {
        return Err(OtpError::InvalidDigits);
    }
    Ok(())
}

// ===================== 公开 API =====================

/// RFC 6238 TOTP。
pub fn totp(input: &OtpInput, unix_seconds: u64) -> Result<OtpCode, OtpError> {
    validate_digits(input.digits)?;
    if input.period_sec == 0 {
        return Err(OtpError::InvalidPeriod);
    }
    let key = decode_secret(input.secret_base32)?;
    let counter = unix_seconds / input.period_sec as u64;
    let hs = hmac_bytes(input.algorithm, &key, counter);
    let code = truncate(&hs, input.digits);
    let remaining = input.period_sec - (unix_seconds % input.period_sec as u64) as u32;
    Ok(OtpCode {
        code,
        r#type: OtpType::Totp,
        period: input.period_sec,
        remaining,
        counter: 0,
        algorithm: input.algorithm,
        digits: input.digits,
    })
}

/// RFC 4226 HOTP。
pub fn hotp(input: &OtpInput) -> Result<OtpCode, OtpError> {
    validate_digits(input.digits)?;
    let counter = input.counter.ok_or(OtpError::MissingCounter)?;
    let key = decode_secret(input.secret_base32)?;
    let hs = hmac_bytes(input.algorithm, &key, counter);
    let code = truncate(&hs, input.digits);
    Ok(OtpCode {
        code,
        r#type: OtpType::Hotp,
        period: 0,
        remaining: 0,
        counter,
        algorithm: input.algorithm,
        digits: input.digits,
    })
}

/// Steam Guard（非标准 TOTP；spec/06 § 5）。
///
/// 字母表 = `"23456789BCDFGHJKMNPQRTVWXY"`（26 字符；去掉 `0/1/A/E/I/L/O/S/U/Z`）。
/// 算法 = HMAC-SHA1(secret, counter=unix_seconds / 30)，
/// 然后用 RFC 4226 truncation 取 32-bit，再用 26 进制映射成 5 字符。
pub fn steam_guard(secret_base32: &str, unix_seconds: u64) -> Result<OtpCode, OtpError> {
    const PERIOD: u32 = 30;
    let key = decode_secret(secret_base32)?;
    let counter = unix_seconds / PERIOD as u64;
    let hs = hmac_bytes(OtpAlgorithm::Sha1, &key, counter);
    let code = steam_truncate(&hs);
    let remaining = PERIOD - (unix_seconds % PERIOD as u64) as u32;
    Ok(OtpCode {
        code,
        r#type: OtpType::Steam,
        period: PERIOD,
        remaining,
        counter: 0,
        algorithm: OtpAlgorithm::Sha1,
        digits: 5,
    })
}

const STEAM_ALPHABET: &[u8] = b"23456789BCDFGHJKMNPQRTVWXY";

/// 编译期常量：STEAM_ALPHABET 必须是 26 字符。
const _STEAM_ALPHA_LEN_OK: [(); 26] = [(); STEAM_ALPHABET.len()];

fn steam_truncate(hs: &[u8]) -> String {
    let offset = (hs[hs.len() - 1] & 0x0F) as usize;
    let bin_code = u32::from_be_bytes([
        hs[offset] & 0x7F,
        hs[offset + 1],
        hs[offset + 2],
        hs[offset + 3],
    ]);
    let mut x = bin_code;
    let mut out = String::with_capacity(5);
    let n = STEAM_ALPHABET.len() as u32;
    for _ in 0..5 {
        let idx = (x % n) as usize;
        out.push(STEAM_ALPHABET[idx] as char);
        x /= n;
    }
    out
}

// ===================== otpauth:// URI 解析 =====================

/// 解析 `otpauth://TYPE/LABEL?secret=...&...` URI。
///
/// 不做完整 URL 解析（避免 `url` 依赖）；遵循 RFC 3986 子集即可（实际所有
/// authenticator 实现导出的格式都很规整）。
pub fn parse_otpauth_uri(uri: &str) -> Result<ParsedOtp, OtpError> {
    let after_scheme = uri.strip_prefix("otpauth://").ok_or(OtpError::InvalidUri)?;

    let (type_segment, rest) = match after_scheme.find('/') {
        Some(i) => (&after_scheme[..i], &after_scheme[i + 1..]),
        None => return Err(OtpError::InvalidUri),
    };
    let (label_part, query) = match rest.find('?') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let label = percent_decode(label_part);

    // type
    let r#type = match type_segment.to_ascii_lowercase().as_str() {
        "totp" => OtpType::Totp,
        "hotp" => OtpType::Hotp,
        "steam" => OtpType::Steam,
        _ => return Err(OtpError::InvalidUri),
    };

    // query params
    let mut secret = None;
    let mut algorithm = OtpAlgorithm::Sha1;
    let mut digits: u8 = 6;
    let mut period_sec: u32 = 30;
    let mut counter: Option<u64> = None;
    let mut issuer_q: Option<String> = None;

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => continue,
        };
        let v = percent_decode(v);
        match k.to_ascii_lowercase().as_str() {
            "secret" => secret = Some(v),
            "algorithm" => {
                algorithm = match v.to_ascii_uppercase().as_str() {
                    "SHA1" => OtpAlgorithm::Sha1,
                    "SHA256" => OtpAlgorithm::Sha256,
                    "SHA512" => OtpAlgorithm::Sha512,
                    _ => return Err(OtpError::UnsupportedAlgorithm),
                }
            }
            "digits" => {
                digits = v.parse().map_err(|_| OtpError::InvalidUri)?;
            }
            "period" => {
                period_sec = v.parse().map_err(|_| OtpError::InvalidUri)?;
            }
            "counter" => {
                counter = Some(v.parse().map_err(|_| OtpError::InvalidUri)?);
            }
            "issuer" => issuer_q = Some(v),
            _ => {}
        }
    }

    let secret = secret.ok_or(OtpError::InvalidUri)?;

    // HOTP 必须有 counter（spec/06 § 7 mandatory test）。
    if r#type == OtpType::Hotp && counter.is_none() {
        return Err(OtpError::MissingCounter);
    }

    // label = "Issuer:Account" 或 "Account"
    let (label_issuer, account) = split_label(&label);
    let issuer = issuer_q.or(label_issuer);

    Ok(ParsedOtp {
        r#type,
        secret_base32: secret,
        algorithm,
        digits,
        period_sec,
        counter,
        issuer,
        account,
    })
}

fn split_label(label: &str) -> (Option<String>, Option<String>) {
    if label.is_empty() {
        return (None, None);
    }
    match label.find(':') {
        Some(i) => {
            let issuer = label[..i].trim().to_string();
            let account = label[i + 1..].trim().to_string();
            (
                if issuer.is_empty() {
                    None
                } else {
                    Some(issuer)
                },
                if account.is_empty() {
                    None
                } else {
                    Some(account)
                },
            )
        }
        None => (None, Some(label.trim().to_string())),
    }
}

/// 最小 percent-decode（仅处理 `%HH`）。避免引 `percent-encoding` crate。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ===================== 测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// spec/06 § 7 test `totp_rfc6238_vectors`：
    /// RFC 6238 Appendix B 标准向量（key = ASCII "12345678901234567890" → base32）。
    #[test]
    fn totp_rfc6238_vectors() {
        // RFC 6238 Appendix B：SHA1, digits=8, T0=0, X=30。
        // key ASCII "12345678901234567890" → base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let cases: &[(u64, &str)] = &[
            (59, "94287082"),
            (1111111109, "07081804"),
            (1111111111, "14050471"),
            (1234567890, "89005924"),
            (2000000000, "69279037"),
            // 2^32 测试向量略，避免 32-bit 截断歧义。
        ];
        for (t, expected) in cases {
            let input = OtpInput {
                secret_base32: secret,
                algorithm: OtpAlgorithm::Sha1,
                digits: 8,
                period_sec: 30,
                counter: None,
            };
            let code = totp(&input, *t).unwrap();
            assert_eq!(code.code, *expected, "t = {t}");
            assert_eq!(code.r#type, OtpType::Totp);
            assert_eq!(code.digits, 8);
        }
    }

    /// spec/06 § 7 test `hotp_rfc4226_vectors`：
    /// RFC 4226 Appendix D 标准向量（key ASCII "12345678901234567890"，counter 0–9）。
    #[test]
    fn hotp_rfc4226_vectors() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let cases: &[(u64, &str)] = &[
            (0, "755224"),
            (1, "287082"),
            (2, "359152"),
            (3, "969429"),
            (4, "338314"),
            (5, "254676"),
            (6, "287922"),
            (7, "162583"),
            (8, "399871"),
            (9, "520489"),
        ];
        for (c, expected) in cases {
            let input = OtpInput {
                secret_base32: secret,
                algorithm: OtpAlgorithm::Sha1,
                digits: 6,
                period_sec: 0,
                counter: Some(*c),
            };
            let code = hotp(&input).unwrap();
            assert_eq!(code.code, *expected, "counter = {c}");
            assert_eq!(code.counter, *c);
            assert_eq!(code.r#type, OtpType::Hotp);
        }
    }

    /// spec/06 § 7 test `steam_known_vector`：
    /// 与独立 Steam Guard 算法实现（Python 参考）跨实现一致。
    ///
    /// 参考实现脚本：见 commit message。
    /// seed = base32("12345678901234567890") (RFC 测试 key)，验证多个时间点。
    #[test]
    fn steam_known_vector() {
        let seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

        // 用 Python 独立实现算出的参考向量（hmac-sha1 + Steam 26-字母表）：
        //   t=0          → "GG5F5"
        //   t=30         → "PV9M4"
        //   t=59         → "PV9M4"（counter 同为 1）
        //   t=1111111109 → "PY4YB"
        let cases: &[(u64, &str)] = &[
            (0, "GG5F5"),
            (30, "PV9M4"),
            (59, "PV9M4"),
            (1111111109, "PY4YB"),
        ];
        for (t, expected) in cases {
            let code = steam_guard(seed, *t).unwrap();
            assert_eq!(code.code, *expected, "t = {t}");
            assert_eq!(code.digits, 5);
            assert_eq!(code.r#type, OtpType::Steam);
            assert_eq!(code.period, 30);
        }
    }

    /// spec/06 § 7 test `base32_normalize_strips_whitespace`：
    /// `"AABB CCDD\t"` → `"AABBCCDD"`。
    #[test]
    fn base32_normalize_strips_whitespace() {
        assert_eq!(normalize_base32("AABB CCDD\t"), "AABBCCDD");
        assert_eq!(normalize_base32("aabb ccdd"), "AABBCCDD");
        assert_eq!(normalize_base32("AABB=CCDD=="), "AABBCCDD");
        assert_eq!(normalize_base32("aA bB\ncC=dD"), "AABBCCDD");
    }

    /// 文档化 normalize_base32 的契约：非 base32 字符（如 `0`）由 decode 把关。
    #[test]
    fn normalize_does_not_validate_non_base32_chars() {
        // normalize 仅做大小写 / 空白 / `=` 处理：
        assert_eq!(normalize_base32("AB0C"), "AB0C");
        // decode_secret 这一步必须把 `0` 拒掉（base32 字母表为 A-Z 2-7）。
        let err = decode_secret("AB0C").unwrap_err();
        assert_eq!(err, OtpError::InvalidSecret);
    }

    /// spec/06 § 7 test `parse_otpauth_uri_login`：完整 query 解析。
    #[test]
    fn parse_otpauth_uri_login() {
        let uri = "otpauth://totp/GitHub:alice%40example.com?\
                   secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60";
        let parsed = parse_otpauth_uri(uri).unwrap();
        assert_eq!(parsed.r#type, OtpType::Totp);
        assert_eq!(parsed.secret_base32, "JBSWY3DPEHPK3PXP");
        assert_eq!(parsed.algorithm, OtpAlgorithm::Sha256);
        assert_eq!(parsed.digits, 8);
        assert_eq!(parsed.period_sec, 60);
        assert_eq!(parsed.counter, None);
        assert_eq!(parsed.issuer.as_deref(), Some("GitHub"));
        assert_eq!(parsed.account.as_deref(), Some("alice@example.com"));
    }

    /// spec/06 § 7 test `parse_otpauth_uri_hotp_with_counter`：HOTP counter 必填。
    #[test]
    fn parse_otpauth_uri_hotp_with_counter() {
        // 有 counter：成功
        let ok =
            parse_otpauth_uri("otpauth://hotp/alice?secret=JBSWY3DPEHPK3PXP&counter=42").unwrap();
        assert_eq!(ok.r#type, OtpType::Hotp);
        assert_eq!(ok.counter, Some(42));

        // 缺 counter：必须返回 MissingCounter（不是泛用 InvalidUri）
        let err = parse_otpauth_uri("otpauth://hotp/alice?secret=JBSWY3DPEHPK3PXP").unwrap_err();
        assert_eq!(err, OtpError::MissingCounter);
    }

    /// spec/06 § 7 test `digits_8_round_trip`：digits = 8 时输出确为 8 位。
    #[test]
    fn digits_8_round_trip() {
        let input = OtpInput {
            secret_base32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
            algorithm: OtpAlgorithm::Sha1,
            digits: 8,
            period_sec: 30,
            counter: None,
        };
        let code = totp(&input, 59).unwrap();
        assert_eq!(code.code.len(), 8);
        assert_eq!(code.digits, 8);

        let input = OtpInput {
            counter: Some(0),
            period_sec: 0,
            ..input
        };
        let code = hotp(&input).unwrap();
        assert_eq!(code.code.len(), 8);
    }

    // ----- 额外的边界用例（非 spec mandatory，但配合 planner findings 补强）-----

    #[test]
    fn invalid_digits_rejected() {
        let input = OtpInput {
            secret_base32: "GEZDGNBVGY3TQOJQ",
            algorithm: OtpAlgorithm::Sha1,
            digits: 5,
            period_sec: 30,
            counter: None,
        };
        assert_eq!(totp(&input, 0).unwrap_err(), OtpError::InvalidDigits);
        let input = OtpInput {
            digits: 11,
            ..input
        };
        assert_eq!(totp(&input, 0).unwrap_err(), OtpError::InvalidDigits);
    }

    #[test]
    fn zero_period_rejected() {
        let input = OtpInput {
            secret_base32: "GEZDGNBVGY3TQOJQ",
            algorithm: OtpAlgorithm::Sha1,
            digits: 6,
            period_sec: 0,
            counter: None,
        };
        assert_eq!(totp(&input, 0).unwrap_err(), OtpError::InvalidPeriod);
    }

    #[test]
    fn hotp_missing_counter_rejected() {
        let input = OtpInput {
            secret_base32: "GEZDGNBVGY3TQOJQ",
            algorithm: OtpAlgorithm::Sha1,
            digits: 6,
            period_sec: 0,
            counter: None,
        };
        assert_eq!(hotp(&input).unwrap_err(), OtpError::MissingCounter);
    }

    #[test]
    fn parse_uri_label_only_account() {
        let parsed = parse_otpauth_uri("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!(parsed.issuer, None);
        assert_eq!(parsed.account.as_deref(), Some("alice"));
    }

    #[test]
    fn parse_uri_missing_secret() {
        let err = parse_otpauth_uri("otpauth://totp/alice").unwrap_err();
        assert_eq!(err, OtpError::InvalidUri);
    }

    #[test]
    fn parse_uri_unknown_type() {
        let err = parse_otpauth_uri("otpauth://oops/alice?secret=JBSWY3DPEHPK3PXP").unwrap_err();
        assert_eq!(err, OtpError::InvalidUri);
    }

    #[test]
    fn parse_uri_unsupported_algorithm() {
        let err = parse_otpauth_uri("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")
            .unwrap_err();
        assert_eq!(err, OtpError::UnsupportedAlgorithm);
    }

    /// totp 的 `remaining` 字段必须等于 `period - (t mod period)`。
    #[test]
    fn totp_remaining_field_correct() {
        let input = OtpInput {
            secret_base32: "GEZDGNBVGY3TQOJQ",
            algorithm: OtpAlgorithm::Sha1,
            digits: 6,
            period_sec: 30,
            counter: None,
        };
        let code = totp(&input, 0).unwrap();
        assert_eq!(code.remaining, 30);
        let code = totp(&input, 1).unwrap();
        assert_eq!(code.remaining, 29);
        let code = totp(&input, 29).unwrap();
        assert_eq!(code.remaining, 1);
        let code = totp(&input, 30).unwrap();
        assert_eq!(code.remaining, 30);
    }

    /// Steam 字母表必须恰好 26 字符（planner 注意：spec 注释"25 字符"实际有误）。
    #[test]
    fn steam_alphabet_has_26_chars() {
        assert_eq!(STEAM_ALPHABET.len(), 26);
    }
}
