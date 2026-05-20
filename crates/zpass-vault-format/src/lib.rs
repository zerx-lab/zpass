//! `zpass-vault-format` —— 磁盘字节布局与 AAD 常量。
//!
//! 见 `spec/03-vault-format.md`。本 crate 不感知 SQLite，仅定义：
//!
//! - AAD 上下文常量。
//! - `VaultMetaBlob`：vault_meta 表的 Rust 形态（明文字段 + 密文 blob）。
//! - `ItemPayloadV1` / `FieldValue` / `ItemType`：item payload 解密后的形状。
//! - `AuditEntry`：审计日志 payload。
//! - CBOR 编 / 解码 helper。
//!
//! `#![no_std] + extern crate alloc`，桌面与移动端共享。

#![no_std]

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

pub use zpass_crypto::{AEAD_TAG_SIZE, NONCE_SIZE, SALT_SIZE};

// ===================== AAD 上下文常量（spec/03 § 4）=====================

pub const AAD_DEK: &[u8] = b"zpass:dek";
pub const AAD_VERIFIER: &[u8] = b"zpass:verifier";
pub const AAD_AUDIT_PREFIX: &[u8] = b"zpass:audit:";
pub const AAD_AUDIT_PENDING: &[u8] = b"zpass:audit:pending";
pub const AAD_TRUSTED_DEVICE_V1: &[u8] = b"zpass:trusted-device:v1";

/// item payload 的 AAD = item id 的 UTF-8 字节（不加前缀）。
pub fn item_aad(item_id: &str) -> &[u8] {
    item_id.as_bytes()
}

/// 审计 row 的最终 AAD：`"zpass:audit:<id>"`。
pub fn audit_final_aad(id: i64) -> Vec<u8> {
    let s = alloc::format!("zpass:audit:{}", id);
    s.into_bytes()
}

pub const VAULT_SCHEMA_VERSION: u32 = 1;

/// verifier 固定明文（spec/03 § 3.1）。
pub const VERIFIER_PLAINTEXT: &[u8] = b"zpass-vault-verifier-v1";

// ===================== VaultMetaBlob（明文部分 + 密文 blob）=====================

/// 与 SQL `vault_meta` 表列一一对应。所有 BLOB 列保持密文形态；上层 crypto 才解。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultMetaBlob {
    pub schema_version: u32,
    pub kdf: KdfKind,
    pub kdf_salt: Vec<u8>,
    pub kdf_params: KdfParams,
    pub wrapped_dek: Vec<u8>,
    pub verifier: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KdfKind {
    Argon2id,
}

impl KdfKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            KdfKind::Argon2id => "argon2id",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "argon2id" => Some(KdfKind::Argon2id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u8,
}

// ===================== ItemPayloadV1（CBOR 加密前 / 解密后形态）=====================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    Login,
    Card,
    Note,
    Identity,
    Ssh,
    Passkey,
    Totp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FieldValue {
    Text(String),
    Number(i64),
    Bool(bool),
    Bytes(Vec<u8>),
    Null,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemPayloadV1 {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: ItemType,
    pub name: String,
    pub fields: BTreeMap<String, FieldValue>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub kind: String,
    pub timestamp_ms: i64,
    pub details: BTreeMap<String, FieldValue>,
}

// ===================== CBOR 编 / 解码 =====================

#[derive(Debug, PartialEq, Eq)]
pub enum FormatError {
    EncodeFailed,
    DecodeFailed,
}

impl core::fmt::Display for FormatError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            FormatError::EncodeFailed => write!(f, "cbor encode failed"),
            FormatError::DecodeFailed => write!(f, "cbor decode failed"),
        }
    }
}

pub fn encode_item_payload(p: &ItemPayloadV1) -> Result<Vec<u8>, FormatError> {
    let mut buf = Vec::new();
    ciborium::ser::into_writer(p, &mut buf).map_err(|_| FormatError::EncodeFailed)?;
    Ok(buf)
}

pub fn decode_item_payload(bytes: &[u8]) -> Result<ItemPayloadV1, FormatError> {
    ciborium::de::from_reader(bytes).map_err(|_| FormatError::DecodeFailed)
}

pub fn encode_audit(p: &AuditEntry) -> Result<Vec<u8>, FormatError> {
    let mut buf = Vec::new();
    ciborium::ser::into_writer(p, &mut buf).map_err(|_| FormatError::EncodeFailed)?;
    Ok(buf)
}

pub fn decode_audit(bytes: &[u8]) -> Result<AuditEntry, FormatError> {
    ciborium::de::from_reader(bytes).map_err(|_| FormatError::DecodeFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload() -> ItemPayloadV1 {
        let mut fields = BTreeMap::new();
        fields.insert("username".into(), FieldValue::Text("alice".into()));
        fields.insert("password".into(), FieldValue::Text("hunter2".into()));
        fields.insert("notes".into(), FieldValue::Null);
        ItemPayloadV1 {
            id: "00000000-0000-4000-8000-000000000001".into(),
            r#type: ItemType::Login,
            name: "Example".into(),
            fields,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_001_000,
        }
    }

    #[test]
    fn cbor_round_trip() {
        let p = sample_payload();
        let bytes = encode_item_payload(&p).unwrap();
        let back = decode_item_payload(&bytes).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn cbor_deterministic_via_btreemap() {
        let p = sample_payload();
        let a = encode_item_payload(&p).unwrap();
        let b = encode_item_payload(&p).unwrap();
        assert_eq!(a, b, "BTreeMap 排序应保证位级一致");
    }

    #[test]
    fn aad_constants_stable() {
        assert_eq!(AAD_DEK, b"zpass:dek");
        assert_eq!(AAD_VERIFIER, b"zpass:verifier");
        assert_eq!(AAD_AUDIT_PREFIX, b"zpass:audit:");
        assert_eq!(AAD_AUDIT_PENDING, b"zpass:audit:pending");
        assert_eq!(VERIFIER_PLAINTEXT, b"zpass-vault-verifier-v1");
        assert_eq!(audit_final_aad(42), b"zpass:audit:42");
    }

    #[test]
    fn item_aad_is_raw_bytes() {
        let id = "abc-123";
        assert_eq!(item_aad(id), b"abc-123");
    }

    #[test]
    fn decode_garbage_fails() {
        assert!(matches!(
            decode_item_payload(&[0xFF, 0xFF, 0xFF]),
            Err(FormatError::DecodeFailed)
        ));
    }

    #[test]
    fn audit_round_trip() {
        let mut details = BTreeMap::new();
        details.insert("item_id".into(), FieldValue::Text("xyz".into()));
        details.insert("counter".into(), FieldValue::Number(7));
        let entry = AuditEntry {
            kind: "ssh_sign".into(),
            timestamp_ms: 12345,
            details,
        };
        let bytes = encode_audit(&entry).unwrap();
        let back = decode_audit(&bytes).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn kdf_kind_parse() {
        assert_eq!(KdfKind::parse("argon2id"), Some(KdfKind::Argon2id));
        assert_eq!(KdfKind::parse("scrypt"), None);
        assert_eq!(KdfKind::Argon2id.as_str(), "argon2id");
    }
}
