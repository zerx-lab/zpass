//! Passkey 桌面胶水（spec/07）。
//!
//! Phase C 只暴露**只读视图**所需 API：解码 vault item 中持久化的 passkey 元数据。
//! 注册 / 断言流程在浏览器扩展通过 native-host 触发（Phase E），所以这里不主动
//! 实现完整注册 UX —— 但留出 `sign_assertion_for_item`，供 Phase E 直接接入。

use zeroize::Zeroizing;
use zpass_passkey::{
    AssertionInput, AssertionOutput, PasskeyError, PasskeyKeypair, sign_assertion,
};
use zpass_vault_format::{FieldValue, ItemPayloadV1};
use zpass_vault_service::{VaultError, VaultService};
use zpass_vault_store::VaultStore;

#[derive(Debug)]
pub enum PasskeyServiceError {
    Vault(VaultError),
    Passkey(PasskeyError),
    /// item 类型不是 passkey 或缺关键字段。
    InvalidItem,
}

impl From<VaultError> for PasskeyServiceError {
    fn from(e: VaultError) -> Self {
        Self::Vault(e)
    }
}
impl From<PasskeyError> for PasskeyServiceError {
    fn from(e: PasskeyError) -> Self {
        Self::Passkey(e)
    }
}

/// 只读视图：从 vault item.fields 构造 PasskeySummary。
///
/// 字段名按 spec/03 § 6.2 passkey 行（snake_case）。
#[derive(Debug, Clone)]
pub struct PasskeySummary {
    pub rp_id: String,
    pub rp_name: Option<String>,
    pub user_name: Option<String>,
    pub user_display_name: Option<String>,
    pub sign_count: u32,
    pub credential_id_b64url: String,
}

pub fn read_passkey_summary(
    payload: &ItemPayloadV1,
) -> Result<PasskeySummary, PasskeyServiceError> {
    let rp_id = match payload.fields.get("rp_id") {
        Some(FieldValue::Text(s)) => s.clone(),
        _ => return Err(PasskeyServiceError::InvalidItem),
    };
    let credential_id_b64url = match payload.fields.get("credential_id") {
        Some(FieldValue::Text(s)) => s.clone(),
        _ => return Err(PasskeyServiceError::InvalidItem),
    };
    let rp_name = match payload.fields.get("rp_name") {
        Some(FieldValue::Text(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    let user_name = match payload.fields.get("user_name") {
        Some(FieldValue::Text(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    let user_display_name = match payload.fields.get("user_display_name") {
        Some(FieldValue::Text(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    let sign_count = match payload.fields.get("sign_count") {
        Some(FieldValue::Number(n)) if *n >= 0 => *n as u32,
        _ => 0,
    };
    Ok(PasskeySummary {
        rp_id,
        rp_name,
        user_name,
        user_display_name,
        sign_count,
        credential_id_b64url,
    })
}

/// 从 vault item 还原 PasskeyKeypair，调用 `sign_assertion`，并把新 sign_count
/// 写回 vault（spec/07 § 7）。
///
/// **Phase E 入口**：Phase C 不主动调用此函数，但实现完整以便桥服务直接接入。
pub fn sign_assertion_for_item<S: VaultStore>(
    vault: &VaultService<S>,
    item_id: &str,
    client_data_hash: &[u8; 32],
    user_present: bool,
    user_verified: bool,
) -> Result<AssertionOutput, PasskeyServiceError> {
    let mut payload = vault.get_item(item_id)?;
    let summary = read_passkey_summary(&payload)?;

    let pkcs8 = match payload.fields.get("private_key_pkcs8") {
        Some(FieldValue::Bytes(b)) => b.clone(),
        _ => return Err(PasskeyServiceError::InvalidItem),
    };
    let spki = match payload.fields.get("public_key_spki") {
        Some(FieldValue::Bytes(b)) => b.clone(),
        _ => return Err(PasskeyServiceError::InvalidItem),
    };
    let cose = match payload.fields.get("public_key_cose") {
        Some(FieldValue::Bytes(b)) => b.clone(),
        _ => return Err(PasskeyServiceError::InvalidItem),
    };
    let kp = PasskeyKeypair {
        private_key_pkcs8: Zeroizing::new(pkcs8),
        public_key_spki: spki,
        public_key_cose: cose,
    };
    let out = sign_assertion(&AssertionInput {
        rp_id: &summary.rp_id,
        keypair: &kp,
        sign_count: summary.sign_count,
        client_data_hash,
        user_present,
        user_verified,
    })?;
    // 回写 sign_count
    payload.fields.insert(
        "sign_count".into(),
        FieldValue::Number(out.new_sign_count as i64),
    );
    vault.update_item(payload)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zpass_vault_format::ItemType;

    fn payload(fields: BTreeMap<String, FieldValue>) -> ItemPayloadV1 {
        ItemPayloadV1 {
            id: "x".into(),
            r#type: ItemType::Passkey,
            name: "t".into(),
            fields,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn summary_extracts_basics() {
        let mut f = BTreeMap::new();
        f.insert("rp_id".into(), FieldValue::Text("github.com".into()));
        f.insert("rp_name".into(), FieldValue::Text("GitHub".into()));
        f.insert("credential_id".into(), FieldValue::Text("aGVsbG8".into()));
        f.insert("sign_count".into(), FieldValue::Number(7));
        f.insert("user_name".into(), FieldValue::Text("alice".into()));
        let p = payload(f);
        let s = read_passkey_summary(&p).unwrap();
        assert_eq!(s.rp_id, "github.com");
        assert_eq!(s.rp_name.as_deref(), Some("GitHub"));
        assert_eq!(s.user_name.as_deref(), Some("alice"));
        assert_eq!(s.sign_count, 7);
        assert_eq!(s.credential_id_b64url, "aGVsbG8");
    }

    #[test]
    fn summary_missing_rp_id_errors() {
        let p = payload(BTreeMap::new());
        assert!(matches!(
            read_passkey_summary(&p),
            Err(PasskeyServiceError::InvalidItem)
        ));
    }

    #[test]
    fn summary_negative_sign_count_treated_as_zero() {
        let mut f = BTreeMap::new();
        f.insert("rp_id".into(), FieldValue::Text("x".into()));
        f.insert("credential_id".into(), FieldValue::Text("x".into()));
        f.insert("sign_count".into(), FieldValue::Number(-5));
        let p = payload(f);
        let s = read_passkey_summary(&p).unwrap();
        assert_eq!(s.sign_count, 0);
    }
}
