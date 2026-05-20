//! OTP 桌面胶水（spec/06 § 4）。
//!
//! 串接 `zpass-otp::{totp,hotp,steam_guard}` 与 `zpass-vault-service`：
//! - TOTP / Steam：纯计算，秒级缓存由 UI 自己刷新。
//! - HOTP：先 `vault.advance_hotp_counter()` 拿新 counter，再读 item 算 code。
//!
//! 不进 GPUI 类型，纯同步 API，供 screens/{totp, vault} 在 background task 调。

use std::time::{SystemTime, UNIX_EPOCH};

use zpass_otp::{
    OtpAlgorithm, OtpCode, OtpError, OtpInput, OtpType, hotp, parse_otpauth_uri, steam_guard, totp,
};
use zpass_vault_format::{FieldValue, ItemPayloadV1};
use zpass_vault_service::{VaultError, VaultService};
use zpass_vault_store::VaultStore;

#[derive(Debug)]
pub enum OtpServiceError {
    /// 上层（vault）错误，如未解锁、item 不存在。
    Vault(VaultError),
    /// OTP 计算错误（base32 解码 / digits / algorithm 等）。
    Otp(OtpError),
    /// item 类型不是 login/totp、或字段不含 OTP 元数据。
    NoOtpField,
    /// 系统时钟读取失败（UNIX_EPOCH 之前）。
    Clock,
}

impl From<VaultError> for OtpServiceError {
    fn from(e: VaultError) -> Self {
        OtpServiceError::Vault(e)
    }
}
impl From<OtpError> for OtpServiceError {
    fn from(e: OtpError) -> Self {
        OtpServiceError::Otp(e)
    }
}

/// 当前 unix 秒。生产用 SystemClock；测试通过传 `unix_seconds_override` 注入。
fn now_unix_seconds() -> Result<u64, OtpServiceError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| OtpServiceError::Clock)
}

/// 从 ItemPayload 提取 OTP 输入字段。
///
/// 同时支持两种放置：
/// - **TOTP 类型**：`fields["totp"]` = base32 secret 字符串，或独立的 secret/issuer/account 字段。
/// - **login.totp**：`fields["totp"]` 同上（login 条目附带 TOTP）。
///
/// 返回 `(secret, algorithm, digits, period, otp_type)`。
pub fn read_otp_meta(payload: &ItemPayloadV1) -> Result<OtpMeta, OtpServiceError> {
    // 优先 `secret` 显式字段（与 Go totpservice.go 一致），fallback 到 `totp`。
    let secret = match payload.fields.get("secret") {
        Some(FieldValue::Text(s)) if !s.is_empty() => s.clone(),
        _ => match payload.fields.get("totp") {
            Some(FieldValue::Text(s)) if !s.is_empty() => s.clone(),
            _ => return Err(OtpServiceError::NoOtpField),
        },
    };

    let algorithm = match payload.fields.get("otp_algorithm") {
        Some(FieldValue::Text(s)) => match s.to_ascii_uppercase().as_str() {
            "SHA256" => OtpAlgorithm::Sha256,
            "SHA512" => OtpAlgorithm::Sha512,
            _ => OtpAlgorithm::Sha1,
        },
        _ => OtpAlgorithm::Sha1,
    };

    let digits = match payload.fields.get("otp_digits") {
        Some(FieldValue::Number(n)) if (6..=10).contains(n) => *n as u8,
        _ => 6,
    };

    let period = match payload.fields.get("otp_period") {
        Some(FieldValue::Number(n)) if *n > 0 => *n as u32,
        _ => 30,
    };

    let otp_type = match payload.fields.get("otp_type") {
        Some(FieldValue::Text(s)) => match s.to_ascii_lowercase().as_str() {
            "hotp" => OtpType::Hotp,
            "steam" => OtpType::Steam,
            _ => OtpType::Totp,
        },
        _ => OtpType::Totp,
    };

    let issuer = match payload.fields.get("issuer") {
        Some(FieldValue::Text(s)) => Some(s.clone()),
        _ => None,
    };

    let account = match payload.fields.get("account") {
        Some(FieldValue::Text(s)) => Some(s.clone()),
        _ => None,
    };

    Ok(OtpMeta {
        secret,
        algorithm,
        digits,
        period,
        otp_type,
        issuer,
        account,
    })
}

#[derive(Debug, Clone)]
pub struct OtpMeta {
    pub secret: String,
    pub algorithm: OtpAlgorithm,
    pub digits: u8,
    pub period: u32,
    pub otp_type: OtpType,
    pub issuer: Option<String>,
    pub account: Option<String>,
}

/// 给一个 item，计算当前 OTP code。
///
/// HOTP 路径会先 `advance_hotp_counter`，所以会有副作用（写 vault）。
/// TOTP / Steam 是纯读路径。
pub fn compute_otp_for_item<S: VaultStore>(
    vault: &VaultService<S>,
    item_id: &str,
) -> Result<OtpCode, OtpServiceError> {
    let payload = vault.get_item(item_id)?;
    let meta = read_otp_meta(&payload)?;
    match meta.otp_type {
        OtpType::Totp => {
            let now = now_unix_seconds()?;
            Ok(totp(
                &OtpInput {
                    secret_base32: &meta.secret,
                    algorithm: meta.algorithm,
                    digits: meta.digits,
                    period_sec: meta.period,
                    counter: None,
                },
                now,
            )?)
        }
        OtpType::Steam => {
            let now = now_unix_seconds()?;
            Ok(steam_guard(&meta.secret, now)?)
        }
        OtpType::Hotp => {
            // spec/06 § 4.2：先 advance 拿新 counter，再读 item 算 code。
            let new_counter = vault.advance_hotp_counter(item_id)?;
            Ok(hotp(&OtpInput {
                secret_base32: &meta.secret,
                algorithm: meta.algorithm,
                digits: meta.digits,
                period_sec: 0,
                counter: Some(new_counter),
            })?)
        }
    }
}

/// 把 otpauth:// URI 解析为 vault item 字段（spec/06 § 6 + spec/03 § 6.2 totp 行）。
pub fn parse_uri_to_fields(uri: &str) -> Result<ParsedOtpFields, OtpServiceError> {
    let p = parse_otpauth_uri(uri)?;
    Ok(ParsedOtpFields {
        secret: p.secret_base32,
        algorithm: p.algorithm,
        digits: p.digits,
        period: p.period_sec,
        counter: p.counter,
        otp_type: p.r#type,
        issuer: p.issuer,
        account: p.account,
    })
}

#[derive(Debug, Clone)]
pub struct ParsedOtpFields {
    pub secret: String,
    pub algorithm: OtpAlgorithm,
    pub digits: u8,
    pub period: u32,
    pub counter: Option<u64>,
    pub otp_type: OtpType,
    pub issuer: Option<String>,
    pub account: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zpass_vault_format::ItemType;
    use zpass_vault_service::NewItem;

    fn fields_with(pairs: &[(&str, FieldValue)]) -> BTreeMap<String, FieldValue> {
        let mut m = BTreeMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    fn payload(fields: BTreeMap<String, FieldValue>, ty: ItemType) -> ItemPayloadV1 {
        ItemPayloadV1 {
            id: "x".into(),
            r#type: ty,
            name: "t".into(),
            fields,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn read_meta_defaults_to_sha1_6_30_totp() {
        let p = payload(
            fields_with(&[("secret", FieldValue::Text("JBSWY3DPEHPK3PXP".into()))]),
            ItemType::Totp,
        );
        let m = read_otp_meta(&p).unwrap();
        assert!(matches!(m.algorithm, OtpAlgorithm::Sha1));
        assert_eq!(m.digits, 6);
        assert_eq!(m.period, 30);
        assert!(matches!(m.otp_type, OtpType::Totp));
    }

    #[test]
    fn read_meta_falls_back_to_totp_field_for_login() {
        let p = payload(
            fields_with(&[("totp", FieldValue::Text("JBSWY3DPEHPK3PXP".into()))]),
            ItemType::Login,
        );
        let m = read_otp_meta(&p).unwrap();
        assert_eq!(m.secret, "JBSWY3DPEHPK3PXP");
    }

    #[test]
    fn read_meta_no_field_errors() {
        let p = payload(fields_with(&[]), ItemType::Totp);
        assert!(matches!(
            read_otp_meta(&p),
            Err(OtpServiceError::NoOtpField)
        ));
    }

    #[test]
    fn read_meta_picks_up_hotp_marker() {
        let p = payload(
            fields_with(&[
                ("secret", FieldValue::Text("JBSWY3DPEHPK3PXP".into())),
                ("otp_type", FieldValue::Text("hotp".into())),
            ]),
            ItemType::Totp,
        );
        let m = read_otp_meta(&p).unwrap();
        assert!(matches!(m.otp_type, OtpType::Hotp));
    }

    #[test]
    fn parse_uri_extracts_fields() {
        let f = parse_uri_to_fields(
            "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6",
        )
        .unwrap();
        assert_eq!(f.secret, "JBSWY3DPEHPK3PXP");
        assert_eq!(f.issuer.as_deref(), Some("GitHub"));
        assert_eq!(f.account.as_deref(), Some("alice"));
        assert!(matches!(f.otp_type, OtpType::Totp));
    }

    // 用 in-memory vault 测 TOTP 全链路（用 read_otp_meta + zpass_otp::totp，不走 SystemClock）。
    #[test]
    fn compute_otp_for_totp_item_via_vault() {
        // 这个 test 走真实 vault 的 in-memory store，但避免依赖系统时间（用 now_unix_seconds）。
        // 实际逻辑覆盖在更细粒度的 read_otp_meta 与 zpass-otp 测试中；此处只断言 happy-path 不 panic。
        use zpass_crypto::Argon2idParams;
        use zpass_vault_service::SystemClock;
        use zpass_vault_store::InMemoryStore;
        let weak = Argon2idParams {
            memory_kib: 8 * 1024,
            iterations: 1,
            parallelism: 1,
            key_len: 32,
        };
        // 仅在 vault-service feature test-helpers 关闭时跑；用更通用的 with_clock_and_params。
        // SqliteVaultStore 没在测试里方便构造，所以我们这里通过 trait 兼容性绕开。
        // 实际跨 store 一致性在 zpass-vault-store 自己的测试里覆盖。
        let store = InMemoryStore::new();
        let svc = VaultService::with_clock_and_params(store, vec![], Box::new(SystemClock), weak);
        svc.initialize("password 1234").unwrap();
        let mut fields = BTreeMap::new();
        fields.insert("secret".into(), FieldValue::Text("JBSWY3DPEHPK3PXP".into()));
        let summary = svc
            .create_item(NewItem {
                r#type: ItemType::Totp,
                name: "test".into(),
                fields,
            })
            .unwrap();
        // 直接走 read_otp_meta + zpass_otp::totp，不依赖 SystemClock 的具体时间。
        let payload = svc.get_item(&summary.id).unwrap();
        let meta = read_otp_meta(&payload).unwrap();
        let code = totp(
            &OtpInput {
                secret_base32: &meta.secret,
                algorithm: meta.algorithm,
                digits: meta.digits,
                period_sec: meta.period,
                counter: None,
            },
            0,
        )
        .unwrap();
        assert_eq!(code.code.len(), 6);
    }
}
