//! CBOR proto messages — request/response bodies after PAKE handshake.
//!
//! Each message type maps one-to-one with an HTTP endpoint defined in
//! [`crate::sync::server`] (PR4). We use CBOR for two reasons:
//!   1. Cross-language: Go's `github.com/fxamacker/cbor` and the
//!      [`ciborium`] crate produce byte-identical canonical encodings,
//!      letting the desktop Go end interoperate without JSON ambiguity.
//!   2. Compactness: vault items hold base64-encoded ciphertext blobs
//!      already; further JSON re-encoding inflates them; CBOR keeps them
//!      as `bstr` natively.
//!
//! The on-wire shape is intentionally narrow — every request includes the
//! sync session ID so a multiplexed connection (rare but plausible) can
//! route. Each response includes [`crate::PROTO_VERSION`] so clients can
//! detect schema drift early.
//!
//! Rust guideline compliant 2026-02-21

use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;

/// CBOR encode any `Serialize` into a `Vec<u8>`.
///
/// We use the canonical encoding (sorted map keys, shortest int encoding)
/// emitted by `ciborium` so two implementations encoding the same logical
/// value produce identical bytes. This is important when the message body
/// participates in additional cryptographic hashing.
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtoError> {
    let mut buf = Vec::with_capacity(256);
    ciborium::ser::into_writer(value, &mut buf).map_err(|e| ProtoError::Encode(e.to_string()))?;
    Ok(buf)
}

/// CBOR decode the byte slice into `T`.
///
/// `T: DeserializeOwned` because `ciborium::de::from_reader` materialises a
/// fully owned value rather than borrowing into the input buffer.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ProtoError> {
    ciborium::de::from_reader(bytes).map_err(|e| ProtoError::Decode(e.to_string()))
}

/// Errors surfaced by encode/decode helpers.
#[derive(Debug)]
pub enum ProtoError {
    Encode(String),
    Decode(String),
}

impl core::fmt::Display for ProtoError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Encode(e) => write!(f, "cbor encode: {e}"),
            Self::Decode(e) => write!(f, "cbor decode: {e}"),
        }
    }
}

impl std::error::Error for ProtoError {}

/// `POST /v1/pair/init`  body sent by the client.
///
/// `msg_a` is the SPAKE2 message produced by [`crate::sync::pake::PakeClient::message`].
#[derive(Debug, Serialize, Deserialize)]
pub struct PairInitRequest {
    #[serde(with = "serde_bytes")]
    pub msg_a: Vec<u8>,
}

/// `POST /v1/pair/init`  response from the server.
///
/// `session_id` identifies the in-flight handshake; the client must include
/// it in subsequent `pair/confirm` requests so a server with many concurrent
/// pairings can route. `msg_b` is the SPAKE2 reply.
#[derive(Debug, Serialize, Deserialize)]
pub struct PairInitResponse {
    pub session_id: String,
    #[serde(with = "serde_bytes")]
    pub msg_b: Vec<u8>,
}

/// `POST /v1/pair/confirm` body sent by the client.
///
/// `confirm_a` is the SPAKE2-derived MAC proving the client really knew the
/// PIN. The server checks it constant-time and replies with `confirm_b`.
#[derive(Debug, Serialize, Deserialize)]
pub struct PairConfirmRequest {
    pub session_id: String,
    #[serde(with = "serde_bytes")]
    pub confirm_a: Vec<u8>,
}

/// `POST /v1/pair/confirm` response.
#[derive(Debug, Serialize, Deserialize)]
pub struct PairConfirmResponse {
    #[serde(with = "serde_bytes")]
    pub confirm_b: Vec<u8>,
}

/// `GET /v1/sync/manifest` request body (encrypted with session key).
///
/// `vault_role` lets either peer declare itself "phone" or "desktop" purely
/// for logging — it has no protocol effect.
#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestRequest {
    pub session_id: String,
    pub vault_role: String,
}

/// Per-item entry returned in [`ManifestResponse`].
///
/// We send `updated_at` + `deleted_at` + `content_hash` plaintext (encrypted
/// at the session layer) so the receiver can build a `MergePlan` without
/// fetching individual ciphertexts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestEntryWire {
    pub id: String,
    pub updated_at: i64,
    /// 0 = not deleted; otherwise the tombstone timestamp.
    #[serde(default)]
    pub deleted_at: i64,
    /// 16-byte hex SHA-256 (first 16 bytes) of canonical plaintext. May be
    /// empty when the sender chose not to include it (e.g. legacy vaults).
    #[serde(default)]
    pub content_hash: String,
    #[serde(default)]
    pub revision: i64,
}

/// `GET /v1/sync/manifest` response.
#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestResponse {
    pub proto_version: u32,
    pub session_id: String,
    pub entries: Vec<ManifestEntryWire>,
    /// Wall-clock unix ms when the manifest was produced. Lets the client
    /// estimate "the peer is X minutes ahead/behind".
    pub generated_at: i64,
}

/// `POST /v1/sync/fetch` request — ask for full ciphertexts of the given ids.
#[derive(Debug, Serialize, Deserialize)]
pub struct BatchRequest {
    pub session_id: String,
    pub ids: Vec<String>,
    /// Pagination offset; 0 = first batch.
    #[serde(default)]
    pub offset: u32,
    /// Maximum number of items to return; capped to [`crate::MAX_BATCH_SIZE`].
    #[serde(default)]
    pub limit: u32,
}

/// One ciphertext + metadata wire frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncItemRecord {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: i64,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

/// `POST /v1/sync/fetch` or `POST /v1/sync/push` response/body container.
#[derive(Debug, Serialize, Deserialize)]
pub struct BatchResponse {
    pub session_id: String,
    pub items: Vec<SyncItemRecord>,
    /// Total number of items the peer holds matching the request — lets the
    /// client compute progress as `(offset + items.len()) / total`.
    pub total: u32,
    /// Server-set next offset, or 0 when there's nothing left.
    #[serde(default)]
    pub next_offset: u32,
}

/// `POST /v1/sync/commit` payload — final resolution applied by the peer.
#[derive(Debug, Serialize, Deserialize)]
pub struct CommitRequest {
    pub session_id: String,
    /// Final ciphertexts the peer should overwrite/insert.
    pub apply: Vec<SyncItemRecord>,
    /// IDs the peer should tombstone (if not already).
    pub delete: Vec<String>,
}

/// `POST /v1/sync/commit` response.
#[derive(Debug, Serialize, Deserialize)]
pub struct CommitResponse {
    pub session_id: String,
    pub applied: u32,
    pub deleted: u32,
}

/// `GET /v1/sync/progress` payload — server-side progress reporting.
///
/// When the server is doing long-running work (e.g. applying a commit on a
/// large vault) the client polls this endpoint to drive the UI.
#[derive(Debug, Serialize, Deserialize)]
pub struct ProgressResponse {
    pub session_id: String,
    /// Free-form stage label: "manifest" / "fetch" / "merge" / "commit".
    pub stage: String,
    /// 0..=total; equal to total when the stage is done.
    pub processed: u32,
    pub total: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_roundtrip() {
        let m = ManifestResponse {
            proto_version: 1,
            session_id: "abc".into(),
            entries: vec![ManifestEntryWire {
                id: "x".into(),
                updated_at: 100,
                deleted_at: 0,
                content_hash: "deadbeef".into(),
                revision: 1,
            }],
            generated_at: 12345,
        };
        let bytes = encode(&m).unwrap();
        let back: ManifestResponse = decode(&bytes).unwrap();
        assert_eq!(back.session_id, "abc");
        assert_eq!(back.entries[0].id, "x");
        assert_eq!(back.entries[0].updated_at, 100);
    }

    #[test]
    fn item_record_carries_binary_ciphertext() {
        let r = SyncItemRecord {
            id: "i1".into(),
            created_at: 1,
            updated_at: 2,
            deleted_at: 0,
            ciphertext: vec![0xff, 0x00, 0x42],
        };
        let bytes = encode(&r).unwrap();
        let back: SyncItemRecord = decode(&bytes).unwrap();
        assert_eq!(back.ciphertext, vec![0xff, 0x00, 0x42]);
    }

    #[test]
    fn default_values_apply_on_decode() {
        // Encode a minimal map manually; decode should fill defaults.
        let mut buf = Vec::new();
        ciborium::ser::into_writer(
            &serde_cbor_minimal_record("only-id"),
            &mut buf,
        )
        .unwrap();
        let back: SyncItemRecord = decode(&buf).unwrap();
        assert_eq!(back.id, "only-id");
        assert_eq!(back.deleted_at, 0);
        assert!(back.ciphertext.is_empty());
    }

    fn serde_cbor_minimal_record(id: &str) -> SyncItemRecord {
        SyncItemRecord {
            id: id.into(),
            created_at: 0,
            updated_at: 0,
            deleted_at: 0,
            ciphertext: Vec::new(),
        }
    }
}
