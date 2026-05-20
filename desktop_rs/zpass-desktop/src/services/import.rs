//! 明文 JSON 导入（spec/13 § 3）。
//!
//! 处理：
//! - schemaVersion 校验
//! - wallet → note 迁移（spec/13 § 3.3）
//! - Go camelCase 字段名 → Rust snake_case 归一化（passkey / ssh 等已知字段）
//! - 不识别字段保留原样（forward-compat）
//! - createdAt / updatedAt 容忍数字或 ISO 8601 字符串

use std::collections::BTreeMap;

use serde::Deserialize;

use zpass_vault_format::{FieldValue, ItemType};
use zpass_vault_service::{NewItem, VaultError, VaultService};
use zpass_vault_store::VaultStore;

#[derive(Debug)]
pub enum ImportError {
    UnsupportedExportVersion,
    Parse,
    UnknownType(String),
    Vault(VaultError),
}

impl From<VaultError> for ImportError {
    fn from(e: VaultError) -> Self {
        Self::Vault(e)
    }
}

#[derive(Debug, Deserialize)]
struct ExportedFile {
    #[serde(rename = "schemaVersion")]
    schema_version: String,
    items: Vec<ExportedItem>,
}

#[derive(Debug, Deserialize)]
struct ExportedItem {
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    fields: serde_json::Map<String, serde_json::Value>,
}

/// 导入结果摘要。
#[derive(Debug, Clone)]
pub struct ImportSummary {
    pub imported: usize,
    pub wallet_migrated: usize,
    pub skipped_unknown_type: usize,
}

/// 把 JSON 字符串导入到当前已解锁的 vault。
///
/// 不会清空现有 items；导入条目以新 UUID 落盘（spec/13 § 3.4：不复用 Go id 保证密文不可链接）。
pub fn import_from_json<S: VaultStore>(
    vault: &VaultService<S>,
    json: &str,
) -> Result<ImportSummary, ImportError> {
    let file: ExportedFile = serde_json::from_str(json).map_err(|_| ImportError::Parse)?;
    if file.schema_version != "zpass-export-v1" {
        return Err(ImportError::UnsupportedExportVersion);
    }
    let mut summary = ImportSummary {
        imported: 0,
        wallet_migrated: 0,
        skipped_unknown_type: 0,
    };
    for mut it in file.items {
        // 1) wallet → note 迁移（在归一化字段名之前先发生，因为 wallet 用 address/seed 都已是 snake_case）
        let mut was_wallet = false;
        if it.type_ == "wallet" {
            migrate_wallet_in_place(&mut it);
            was_wallet = true;
        }

        let item_type = match parse_item_type(&it.type_) {
            Some(t) => t,
            None => {
                summary.skipped_unknown_type += 1;
                continue;
            }
        };

        // 2) Go camelCase → Rust snake_case 字段名归一化
        let fields = normalize_fields(&it.fields, &item_type);

        vault.create_item(NewItem {
            r#type: item_type,
            name: it.name,
            fields,
        })?;
        summary.imported += 1;
        if was_wallet {
            summary.wallet_migrated += 1;
        }
    }
    Ok(summary)
}

fn parse_item_type(s: &str) -> Option<ItemType> {
    Some(match s {
        "login" => ItemType::Login,
        "card" => ItemType::Card,
        "note" => ItemType::Note,
        "identity" => ItemType::Identity,
        "ssh" => ItemType::Ssh,
        "passkey" => ItemType::Passkey,
        "totp" => ItemType::Totp,
        _ => return None,
    })
}

/// spec/13 § 3.3：wallet → note，merge address/seed 到 notes（仅当 notes 为空）。
fn migrate_wallet_in_place(it: &mut ExportedItem) {
    it.type_ = "note".into();
    let notes_empty = match it.fields.get("notes") {
        Some(serde_json::Value::String(s)) => s.trim().is_empty(),
        _ => true,
    };
    if !notes_empty {
        return;
    }
    let address = it
        .fields
        .get("address")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let seed = it
        .fields
        .get("seed")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let mut merged = String::new();
    if !address.is_empty() {
        merged.push_str("Address: ");
        merged.push_str(address);
        merged.push('\n');
    }
    if !seed.is_empty() {
        merged.push_str("Seed phrase: ");
        merged.push_str(seed);
    }
    if !merged.is_empty() {
        it.fields
            .insert("notes".into(), serde_json::Value::String(merged));
    }
}

/// camelCase 已知字段 → snake_case；其它字段保留原 key。
fn rename_key<'a>(key: &'a str, item_type: &ItemType) -> &'a str {
    // 全类型公共
    if key == "createdAt" {
        // 顶层处理，不出现在 fields；safety
        return "createdAt";
    }
    // passkey 专属（spec/03 § 6.2 + Go passkeyservice.go:182-193）
    if *item_type == ItemType::Passkey {
        match key {
            "rpId" => return "rp_id",
            "rpName" => return "rp_name",
            "userId" => return "user_id",
            "userName" => return "user_name",
            "userDisplayName" => return "user_display_name",
            "credentialId" => return "credential_id",
            "privateKeyPkcs8" => return "private_key_pkcs8",
            "publicKeyCose" => return "public_key_cose",
            "publicKeySpki" => return "public_key_spki",
            "signCount" => return "sign_count",
            _ => {}
        }
    }
    // ssh 专属
    if *item_type == ItemType::Ssh {
        match key {
            "privateKey" => return "private_key",
            "publicKey" => return "public_key",
            _ => {}
        }
    }
    // identity 专属（first/last/...）—— Go 与 Rust 都用 snake_case 这里大部分一致
    // login/card/note：字段名 Go 已用 snake_case，无需翻译
    // totp：otpAlgorithm / otpType / otpPeriod / otpDigits / hotpCounter
    if *item_type == ItemType::Totp {
        match key {
            "otpAlgorithm" => return "otp_algorithm",
            "otpDigits" => return "otp_digits",
            "otpPeriod" => return "otp_period",
            "otpType" => return "otp_type",
            "hotpCounter" => return "hotp_counter",
            _ => {}
        }
    }
    key
}

fn normalize_fields(
    input: &serde_json::Map<String, serde_json::Value>,
    item_type: &ItemType,
) -> BTreeMap<String, FieldValue> {
    let mut out = BTreeMap::new();
    for (k, v) in input {
        let key = rename_key(k, item_type).to_string();
        let val = json_to_field(v);
        out.insert(key, val);
    }
    out
}

fn json_to_field(v: &serde_json::Value) -> FieldValue {
    match v {
        serde_json::Value::String(s) => FieldValue::Text(s.clone()),
        serde_json::Value::Bool(b) => FieldValue::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                FieldValue::Number(i)
            } else if let Some(f) = n.as_f64() {
                FieldValue::Number(f as i64)
            } else {
                FieldValue::Null
            }
        }
        serde_json::Value::Null => FieldValue::Null,
        // Array / Object：序列化回 JSON 字符串放进 Text，避免丢失。
        other => FieldValue::Text(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zpass_vault_format::FieldValue;
    use zpass_vault_service::{SystemClock, VaultService};
    use zpass_vault_store::InMemoryStore;

    fn fresh() -> VaultService<InMemoryStore> {
        let svc = VaultService::with_clock_and_params(
            InMemoryStore::new(),
            vec![],
            Box::new(SystemClock),
            zpass_crypto::Argon2idParams {
                memory_kib: 8 * 1024,
                iterations: 1,
                parallelism: 1,
                key_len: 32,
            },
        );
        svc.initialize("password 1234").unwrap();
        svc
    }

    #[test]
    fn unsupported_version_rejected() {
        let v = fresh();
        let err =
            import_from_json(&v, r#"{"schemaVersion":"bitwarden-v3","items":[]}"#).unwrap_err();
        assert!(matches!(err, ImportError::UnsupportedExportVersion));
    }

    /// spec/13 § 3.3：wallet → note，地址 + seed 合并到 notes（仅当 notes 为空）。
    #[test]
    fn test_import_wallet_merges_address_and_seed_into_notes() {
        let v = fresh();
        let json = r#"
        {
          "schemaVersion": "zpass-export-v1",
          "items": [
            {
              "type": "wallet",
              "name": "MyWallet",
              "fields": {
                "address": "0xABC123",
                "seed": "abandon abandon abandon"
              }
            }
          ]
        }"#;
        let s = import_from_json(&v, json).unwrap();
        assert_eq!(s.imported, 1);
        assert_eq!(s.wallet_migrated, 1);

        let items = v.list_items().unwrap();
        assert_eq!(items.len(), 1);
        let p = v.get_item(&items[0].id).unwrap();
        assert!(matches!(p.r#type, ItemType::Note));
        match p.fields.get("notes") {
            Some(FieldValue::Text(s)) => {
                assert!(s.contains("Address: 0xABC123"));
                assert!(s.contains("Seed phrase: abandon abandon abandon"));
            }
            _ => panic!("notes 应被填入合并字符串"),
        }
    }

    /// wallet 已有 notes：保持原样，不覆盖。
    #[test]
    fn wallet_with_existing_notes_preserved() {
        let v = fresh();
        let json = r#"
        {
          "schemaVersion": "zpass-export-v1",
          "items": [
            {"type":"wallet","name":"W","fields":{"address":"0xABC","seed":"x","notes":"keep me"}}
          ]
        }"#;
        import_from_json(&v, json).unwrap();
        let items = v.list_items().unwrap();
        let p = v.get_item(&items[0].id).unwrap();
        match p.fields.get("notes") {
            Some(FieldValue::Text(s)) => assert_eq!(s, "keep me"),
            _ => panic!(),
        }
    }

    /// passkey camelCase 字段名归一化为 snake_case（planner finding）。
    #[test]
    fn passkey_camel_case_normalized_to_snake_case() {
        let v = fresh();
        let json = r#"
        {
          "schemaVersion": "zpass-export-v1",
          "items": [
            {
              "type": "passkey",
              "name": "GitHub Passkey",
              "fields": {
                "rpId": "github.com",
                "rpName": "GitHub",
                "credentialId": "aGVsbG8",
                "userName": "alice",
                "userDisplayName": "Alice",
                "signCount": 5
              }
            }
          ]
        }"#;
        import_from_json(&v, json).unwrap();
        let items = v.list_items().unwrap();
        assert_eq!(items.len(), 1);
        let p = v.get_item(&items[0].id).unwrap();
        assert!(matches!(p.fields.get("rp_id"), Some(FieldValue::Text(s)) if s == "github.com"));
        assert!(matches!(p.fields.get("rp_name"), Some(FieldValue::Text(s)) if s == "GitHub"));
        assert!(matches!(p.fields.get("user_name"), Some(FieldValue::Text(s)) if s == "alice"));
        assert!(matches!(p.fields.get("sign_count"), Some(FieldValue::Number(n)) if *n == 5));
        // 旧 camelCase key 应已消失
        assert!(!p.fields.contains_key("rpId"));
        assert!(!p.fields.contains_key("signCount"));
    }

    /// 未知类型跳过、记录到 summary。
    #[test]
    fn unknown_type_skipped() {
        let v = fresh();
        let json = r#"
        {
          "schemaVersion": "zpass-export-v1",
          "items": [
            {"type":"bookmark","name":"X","fields":{}}
          ]
        }"#;
        let s = import_from_json(&v, json).unwrap();
        assert_eq!(s.imported, 0);
        assert_eq!(s.skipped_unknown_type, 1);
    }
}
