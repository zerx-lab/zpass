//! 明文 JSON 导出（spec/13 § 3）。
//!
//! 顶层：`{ schemaVersion: "zpass-export-v1", appVersion, exportedAt, itemCount, items }`。
//! `items` 内字段名采用 **camelCase**（与 Go exportservice.go 保持一致，方便 ZPass 互导）。

use serde::Serialize;
use std::collections::BTreeMap;

use zpass_vault_format::{FieldValue, ItemPayloadV1, ItemType};
use zpass_vault_service::{VaultError, VaultService};
use zpass_vault_store::VaultStore;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedFile<'a> {
    schema_version: &'a str,
    app_version: &'a str,
    exported_at: String,
    item_count: usize,
    items: Vec<ExportedItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedItem {
    id: String,
    #[serde(rename = "type")]
    type_: String,
    name: String,
    fields: BTreeMap<String, serde_json::Value>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug)]
#[allow(dead_code)] // Vault(_) 仅通过 {:?} Debug 路径传到 UI；UI 不读其内部
pub enum ExportError {
    Vault(VaultError),
    Serialize,
}
impl From<VaultError> for ExportError {
    fn from(e: VaultError) -> Self {
        Self::Vault(e)
    }
}

/// 导出当前 vault 所有 items 为 JSON 字符串（明文）。
pub fn export_to_json<S: VaultStore>(vault: &VaultService<S>) -> Result<String, ExportError> {
    let summaries = vault.list_items()?;
    let mut items = Vec::with_capacity(summaries.len());
    for s in &summaries {
        let payload = vault.get_item(&s.id)?;
        items.push(payload_to_exported(payload));
    }
    let file = ExportedFile {
        schema_version: "zpass-export-v1",
        app_version: env!("CARGO_PKG_VERSION"),
        exported_at: chrono_now_iso8601(),
        item_count: items.len(),
        items,
    };
    serde_json::to_string_pretty(&file).map_err(|_| ExportError::Serialize)
}

fn payload_to_exported(p: ItemPayloadV1) -> ExportedItem {
    let mut fields = BTreeMap::new();
    for (k, v) in p.fields {
        fields.insert(k, field_to_json(v));
    }
    ExportedItem {
        id: p.id,
        type_: item_type_to_string(&p.r#type),
        name: p.name,
        fields,
        created_at: p.created_at,
        updated_at: p.updated_at,
    }
}

fn field_to_json(v: FieldValue) -> serde_json::Value {
    use serde_json::Value;
    match v {
        FieldValue::Text(s) => Value::String(s),
        FieldValue::Number(n) => Value::Number(n.into()),
        FieldValue::Bool(b) => Value::Bool(b),
        FieldValue::Bytes(b) => {
            // 用 base64 url-safe no-pad（与 Go 一致）
            Value::String(base64_url_no_pad(&b))
        }
        FieldValue::Null => Value::Null,
    }
}

fn item_type_to_string(t: &ItemType) -> String {
    match t {
        ItemType::Login => "login",
        ItemType::Card => "card",
        ItemType::Note => "note",
        ItemType::Identity => "identity",
        ItemType::Ssh => "ssh",
        ItemType::Passkey => "passkey",
        ItemType::Totp => "totp",
    }
    .into()
}

/// 不引 chrono；手写一个最小 ISO 8601 UTC：YYYY-MM-DDTHH:MM:SSZ。
fn chrono_now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso8601_from_unix(secs as i64)
}

/// 把 unix 秒转 ISO 8601 字符串（UTC，不带毫秒）。
fn iso8601_from_unix(secs: i64) -> String {
    // 简化算法：days since epoch + time of day。
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let hh = (tod / 3600) as u8;
    let mm = ((tod % 3600) / 60) as u8;
    let ss = (tod % 60) as u8;
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Howard Hinnant 公式，days since epoch → (y, m, d)。
fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

/// base64 url-safe no-pad（手写避免引 base64 crate）。
fn base64_url_no_pad(input: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((input.len() * 4).div_ceil(3));
    let chunks = input.chunks(3);
    for c in chunks {
        let b0 = c[0];
        let b1 = c.get(1).copied().unwrap_or(0);
        let b2 = c.get(2).copied().unwrap_or(0);
        let triple = ((b0 as u32) << 16) | ((b1 as u32) << 8) | b2 as u32;
        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        if c.len() >= 2 {
            out.push(ALPHABET[((triple >> 6) & 0x3F) as usize] as char);
        }
        if c.len() >= 3 {
            out.push(ALPHABET[(triple & 0x3F) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_basic() {
        // 1970-01-01T00:00:00Z = 0
        assert_eq!(iso8601_from_unix(0), "1970-01-01T00:00:00Z");
        // 2024-01-01T00:00:00Z = 1704067200
        assert_eq!(iso8601_from_unix(1_704_067_200), "2024-01-01T00:00:00Z");
        // 2024-03-01T12:34:56Z
        let secs = 1_704_067_200 + (31 + 29) * 86_400 + 12 * 3600 + 34 * 60 + 56;
        assert_eq!(iso8601_from_unix(secs), "2024-03-01T12:34:56Z");
    }

    #[test]
    fn base64_url_safe_basic() {
        assert_eq!(base64_url_no_pad(b""), "");
        assert_eq!(base64_url_no_pad(b"f"), "Zg");
        assert_eq!(base64_url_no_pad(b"fo"), "Zm8");
        assert_eq!(base64_url_no_pad(b"foo"), "Zm9v");
        assert_eq!(base64_url_no_pad(b"foob"), "Zm9vYg");
        // URL-safe alphabet uses `-` / `_`, no `+` / `/`
        assert!(!base64_url_no_pad(&[0xfb, 0xff]).contains('+'));
        assert!(!base64_url_no_pad(&[0xfb, 0xff]).contains('/'));
    }

    #[test]
    fn export_round_trip_basic() {
        use std::collections::BTreeMap;
        use zpass_vault_format::{FieldValue, ItemType};
        use zpass_vault_service::{NewItem, SystemClock, VaultService};
        use zpass_vault_store::InMemoryStore;
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
        let mut fields = BTreeMap::new();
        fields.insert("username".into(), FieldValue::Text("alice".into()));
        fields.insert("password".into(), FieldValue::Text("hunter2".into()));
        svc.create_item(NewItem {
            r#type: ItemType::Login,
            name: "GitHub".into(),
            fields,
        })
        .unwrap();
        let json = export_to_json(&svc).unwrap();
        assert!(json.contains("\"schemaVersion\": \"zpass-export-v1\""));
        assert!(json.contains("\"type\": \"login\""));
        assert!(json.contains("\"username\": \"alice\""));
        assert!(json.contains("\"createdAt\""));
    }
}
