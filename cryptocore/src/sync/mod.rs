//! ZPass LAN sync protocol — shared by phone (Rust) and desktop (Go via fixtures).
//!
//! High-level flow:
//!   1. Server picks a random 6-digit PIN, shows it on screen + QR
//!      (`zpass-sync://<ip>:<port>?pin=<pin>`).
//!   2. Client enters / scans the PIN.
//!   3. SPAKE2 handshake derives a 32-byte session key from the low-entropy PIN.
//!   4. All further request/response bodies are XChaCha20-Poly1305 encrypted
//!      with that session key + a per-direction monotonic 64-bit counter.
//!   5. Either side can request `/sync/manifest` to compare item versions,
//!      then `fetch` / `push` payloads in chunks of `BATCH_SIZE`.
//!   6. Conflicts surface via [`merge::MergePlan`]; the PC end resolves them
//!      and `commit`s the chosen resolutions back to both vaults.
//!
//! Threat model:
//!   - We accept plaintext HTTP on the LAN (per project decision) because the
//!     PAKE-derived session key already encrypts every body. Anyone sniffing
//!     the wire only sees nonce + ciphertext + tag.
//!   - PIN brute force: the server tracks attempts and locks out after
//!     [`pake::MAX_PIN_ATTEMPTS`] failures.
//!   - Replay: each direction maintains a strictly increasing 64-bit counter;
//!     receiver rejects any frame whose counter <= last accepted.
//!
//! Modules:
//!   - [`proto`] — CBOR-encoded request/response types.
//!   - [`pake`]  — SPAKE2 handshake helpers + PIN attempt accounting.
//!   - [`session`] — bidirectional AEAD channel built on the SPAKE2-derived key.
//!   - [`merge`] — manifest diff + [`merge::MergePlan`] generation (PR3).
//!
//! Rust guideline compliant 2026-02-21

pub mod merge;
pub mod pake;
pub mod proto;
pub mod server;
pub mod session;

pub use merge::{ConflictKind, ManifestEntry, MergePlan, PerItemConflict, plan_merge};
pub use pake::{
    ClientHandshakeOutput, PairingError, PakeClient, PakeServer, PinAttemptGuard,
    ServerSecrets, generate_pin, verify_client_confirm,
};
pub use proto::{
    BatchRequest, BatchResponse, CommitRequest, CommitResponse, ManifestRequest,
    ManifestResponse, PairConfirmRequest, PairConfirmResponse, PairInitRequest,
    PairInitResponse, ProgressResponse, ProtoError, SyncItemRecord, decode, encode,
};
pub use server::{SyncError, SyncServer};
pub use session::{Direction, Session, SessionError};

/// CBOR proto version embedded in [`proto::ManifestResponse::proto_version`].
///
/// Bump only when the on-wire schema changes incompatibly so the receiver can
/// reject mismatched peers up-front instead of failing deep in deserialization.
pub const PROTO_VERSION: u32 = 1;

/// Default batch size for `fetch` / `push` chunked transfer.
///
/// Sized to keep a single response under ~1 MiB of plaintext for typical
/// vaults (login items average ~500 bytes encrypted). The client uses this
/// for progress display granularity; the server enforces an upper bound at
/// [`MAX_BATCH_SIZE`].
pub const DEFAULT_BATCH_SIZE: usize = 50;

/// Upper bound the server enforces on a single batch request.
///
/// Picked large enough for "give me everything" calls on small vaults to
/// finish in one round trip, but small enough to keep per-frame memory and
/// decode time predictable on phones.
pub const MAX_BATCH_SIZE: usize = 500;
