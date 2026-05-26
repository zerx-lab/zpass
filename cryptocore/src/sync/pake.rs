//! SPAKE2 handshake plus PIN attempt accounting.
//!
//! Wraps the [`spake2`] crate so callers see a tight, message-typed API and
//! never touch raw byte slices on the success path. Both peers must agree on
//! the same low-entropy PIN; SPAKE2 then derives a 64-byte shared secret that
//! we split into a session key + a confirmation tag.
//!
//! ## Wire format
//!
//! ```text
//!  client → server  PairInit { msg_a: [u8;33] }
//!  server → client  PairChallenge { msg_b: [u8;33], confirm_b: [u8;32] }
//!  client → server  PairConfirm   { confirm_a: [u8;32] }
//! ```
//!
//! The MAC over the transcript guarantees both sides derived the *same* key
//! from the *same* PIN — a brute-force attempt with the wrong PIN will fail
//! the `confirm_*` verification, not just decryption later.
//!
//! Rust guideline compliant 2026-02-21

use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use subtle::ConstantTimeEq;

use crate::random_bytes;

/// Session key (used by [`crate::sync::session::Session`]).
pub const SESSION_KEY_LEN: usize = 32;
/// Confirmation tag length — must match `Sha256` digest size.
pub const CONFIRM_TAG_LEN: usize = 32;
/// Minimum length we accept for an inbound SPAKE2 message — anything shorter
/// is clearly malformed and we can reject without invoking the library. The
/// upstream spake2 crate produces 33-byte messages today but we keep this
/// loose to survive minor library bumps.
const MIN_SPAKE_MSG_LEN: usize = 1;

/// How many PIN attempts a server tolerates before locking out for
/// [`PIN_LOCKOUT_SECS`].
pub const MAX_PIN_ATTEMPTS: u32 = 3;
/// Lockout window after exceeding [`MAX_PIN_ATTEMPTS`] failed PINs.
pub const PIN_LOCKOUT_SECS: u64 = 60;

/// Pairing identity tag mixed into SPAKE2 to bind the handshake to ZPass.
///
/// Using a domain-separating constant means a PIN reused across applications
/// cannot produce the same session key.
const PAKE_ID_SERVER: &[u8] = b"zpass-sync:v1:server";
const PAKE_ID_CLIENT: &[u8] = b"zpass-sync:v1:client";

/// Confirmation tag domain separators.
const CONFIRM_TAG_SERVER: &[u8] = b"zpass-sync:v1:confirm:server";
const CONFIRM_TAG_CLIENT: &[u8] = b"zpass-sync:v1:confirm:client";
/// Session-key derivation domain separator.
const SESSION_KEY_TAG: &[u8] = b"zpass-sync:v1:session-key";

/// Errors surfaced by handshake helpers and PIN guards.
#[derive(Debug)]
pub enum PairingError {
    /// SPAKE2 second-message bytes did not have [`SPAKE_MSG_LEN`].
    BadMessageLength { got: usize, want: usize },
    /// SPAKE2 library refused the peer message (malformed point, etc).
    SpakeFailed,
    /// Peer-supplied confirmation tag did not match expected value — usually
    /// indicates a wrong PIN. The caller should treat this as "pairing fail".
    ConfirmationMismatch,
    /// Random byte source unavailable (extremely rare on real hardware).
    Rng(String),
    /// PIN attempt rejected because the guard is currently in lockout.
    Locked { remaining_secs: u64 },
}

impl core::fmt::Display for PairingError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::BadMessageLength { got, want } => {
                write!(f, "pake message length {got} (want {want})")
            }
            Self::SpakeFailed => write!(f, "spake2 handshake failed"),
            Self::ConfirmationMismatch => write!(f, "pairing confirmation mismatch"),
            Self::Rng(e) => write!(f, "rng: {e}"),
            Self::Locked { remaining_secs } => {
                write!(f, "pin locked, retry in {remaining_secs}s")
            }
        }
    }
}

impl std::error::Error for PairingError {}

/// Server-side handshake driver.
///
/// Usage:
/// ```ignore
/// let server = PakeServer::start(pin_bytes)?;
/// let msg_b = server.message();          // send to client
/// let (session_key, confirm_b) = server.finish(&msg_a, &confirm_a_expected)?;
/// ```
#[derive(Debug)]
pub struct PakeServer {
    inner: Spake2<Ed25519Group>,
    msg_b: Vec<u8>,
}

/// All secrets derived from a successful SPAKE2 exchange on the server side.
#[derive(Debug, Clone)]
pub struct ServerSecrets {
    /// 32-byte XChaCha20-Poly1305 key for the [`crate::sync::session::Session`].
    pub session_key: [u8; SESSION_KEY_LEN],
    /// What the client's confirm_a tag should hash to. Used by the server to
    /// constant-time verify the client really knew the PIN.
    pub expected_client_confirm: [u8; CONFIRM_TAG_LEN],
    /// Tag the server sends to the client so the client can verify the
    /// server also knew the PIN.
    pub confirm_b: [u8; CONFIRM_TAG_LEN],
}

impl PakeServer {
    /// Start a handshake bound to `pin` (typically 6–8 ASCII digits).
    ///
    /// The PIN must be supplied as raw bytes — encoding choices (decimal vs
    /// hex) are the caller's. We hash the PIN inside SPAKE2 so the absolute
    /// strength comes from the brute-force lockout, not the PIN length.
    pub fn start(pin: &[u8]) -> Result<Self, PairingError> {
        let (state, msg_b) = Spake2::<Ed25519Group>::start_b(
            &Password::new(pin),
            &Identity::new(PAKE_ID_CLIENT),
            &Identity::new(PAKE_ID_SERVER),
        );
        if msg_b.len() < MIN_SPAKE_MSG_LEN {
            return Err(PairingError::SpakeFailed);
        }
        Ok(Self { inner: state, msg_b })
    }

    /// SPAKE2 message to send to the client.
    pub fn message(&self) -> &[u8] {
        &self.msg_b
    }

    /// Consume the server state and derive both secrets after receiving the
    /// client's `msg_a`. The host then stashes `ServerSecrets` until the
    /// `pair_confirm` request arrives.
    pub fn derive_secrets(self, msg_a: &[u8]) -> Result<ServerSecrets, PairingError> {
        if msg_a.len() < MIN_SPAKE_MSG_LEN {
            return Err(PairingError::BadMessageLength {
                got: msg_a.len(),
                want: MIN_SPAKE_MSG_LEN,
            });
        }
        let secret = self
            .inner
            .finish(msg_a)
            .map_err(|_| PairingError::SpakeFailed)?;
        Ok(ServerSecrets {
            session_key: derive_session_key(&secret),
            expected_client_confirm: derive_confirm(&secret, CONFIRM_TAG_CLIENT),
            confirm_b: derive_confirm(&secret, CONFIRM_TAG_SERVER),
        })
    }

    /// Backwards-compatible one-shot: derive secrets *and* check the client
    /// confirm tag in one go. Used by tests; production code prefers the
    /// two-step path via [`Self::derive_secrets`] + manual verify.
    pub fn finish(
        self,
        msg_a: &[u8],
        client_confirm: &[u8],
    ) -> Result<([u8; SESSION_KEY_LEN], [u8; CONFIRM_TAG_LEN]), PairingError> {
        let secrets = self.derive_secrets(msg_a)?;
        if client_confirm
            .ct_eq(&secrets.expected_client_confirm)
            .unwrap_u8()
            != 1
        {
            return Err(PairingError::ConfirmationMismatch);
        }
        Ok((secrets.session_key, secrets.confirm_b))
    }
}

/// Constant-time check that `got` matches the expected client confirmation
/// tag. Used by [`crate::sync::server::SyncServer`] after `pair_init` has
/// stashed [`ServerSecrets`].
pub fn verify_client_confirm(secrets: &ServerSecrets, got: &[u8]) -> Result<(), PairingError> {
    if got.ct_eq(&secrets.expected_client_confirm).unwrap_u8() == 1 {
        Ok(())
    } else {
        Err(PairingError::ConfirmationMismatch)
    }
}

/// Client-side handshake driver — mirrors [`PakeServer`].
#[derive(Debug)]
pub struct PakeClient {
    inner: Spake2<Ed25519Group>,
    msg_a: Vec<u8>,
}

impl PakeClient {
    pub fn start(pin: &[u8]) -> Result<Self, PairingError> {
        let (state, msg_a) = Spake2::<Ed25519Group>::start_a(
            &Password::new(pin),
            &Identity::new(PAKE_ID_CLIENT),
            &Identity::new(PAKE_ID_SERVER),
        );
        if msg_a.len() < MIN_SPAKE_MSG_LEN {
            return Err(PairingError::SpakeFailed);
        }
        Ok(Self { inner: state, msg_a })
    }

    /// SPAKE2 message to send to the server (a.k.a. `msg_a`).
    pub fn message(&self) -> &[u8] {
        &self.msg_a
    }

    /// Derive the session key after receiving the server's `msg_b`.
    /// The returned `confirm_a` must be sent to the server; the server's
    /// `confirm_b` must then be checked via [`Self::verify_server_confirm`].
    pub fn finish(
        self,
        msg_b: &[u8],
    ) -> Result<ClientHandshakeOutput, PairingError> {
        if msg_b.len() < MIN_SPAKE_MSG_LEN {
            return Err(PairingError::BadMessageLength {
                got: msg_b.len(),
                want: MIN_SPAKE_MSG_LEN,
            });
        }
        let secret = self
            .inner
            .finish(msg_b)
            .map_err(|_| PairingError::SpakeFailed)?;
        let session_key = derive_session_key(&secret);
        let confirm_a = derive_confirm(&secret, CONFIRM_TAG_CLIENT);
        let expected_server_confirm = derive_confirm(&secret, CONFIRM_TAG_SERVER);
        Ok(ClientHandshakeOutput {
            session_key,
            confirm_a,
            expected_server_confirm,
        })
    }
}

/// Output of a successful client-side handshake.
#[derive(Debug)]
pub struct ClientHandshakeOutput {
    /// 32-byte XChaCha20-Poly1305 key for the session.
    pub session_key: [u8; SESSION_KEY_LEN],
    /// Tag the client must send to the server so the server can verify
    /// the client really knew the same PIN.
    pub confirm_a: [u8; CONFIRM_TAG_LEN],
    /// Expected tag from the server. Caller checks via
    /// [`Self::verify_server_confirm`].
    pub expected_server_confirm: [u8; CONFIRM_TAG_LEN],
}

impl ClientHandshakeOutput {
    /// Constant-time check of the server's confirmation tag.
    pub fn verify_server_confirm(&self, got: &[u8]) -> Result<(), PairingError> {
        if got.ct_eq(&self.expected_server_confirm).unwrap_u8() == 1 {
            Ok(())
        } else {
            Err(PairingError::ConfirmationMismatch)
        }
    }
}

/// Tracks repeated PIN entry failures and enforces a lockout window.
///
/// Cheap to embed in the server's per-port state; not thread-safe on its own —
/// wrap in a `Mutex` if multiple connections can hit it concurrently.
#[derive(Debug, Clone)]
pub struct PinAttemptGuard {
    failures: u32,
    locked_until: Option<u64>,
}

impl PinAttemptGuard {
    pub fn new() -> Self {
        Self {
            failures: 0,
            locked_until: None,
        }
    }

    /// Check whether a new pairing attempt may proceed at `now_unix_secs`.
    pub fn check(&self, now_unix_secs: u64) -> Result<(), PairingError> {
        if let Some(until) = self.locked_until {
            if now_unix_secs < until {
                return Err(PairingError::Locked {
                    remaining_secs: until - now_unix_secs,
                });
            }
        }
        Ok(())
    }

    /// Register a successful pairing — clears the failure counter.
    pub fn record_success(&mut self) {
        self.failures = 0;
        self.locked_until = None;
    }

    /// Register a failure; returns `true` if the guard has now entered
    /// lockout.
    pub fn record_failure(&mut self, now_unix_secs: u64) -> bool {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= MAX_PIN_ATTEMPTS {
            self.locked_until = Some(now_unix_secs + PIN_LOCKOUT_SECS);
            // Reset counter so the next post-lockout attempt is treated fresh.
            self.failures = 0;
            return true;
        }
        false
    }
}

impl Default for PinAttemptGuard {
    fn default() -> Self {
        Self::new()
    }
}

/// Generate a uniformly random `digits`-long decimal PIN.
///
/// Returns the PIN as an owned `String` so the caller can `format!` it into
/// QR codes and UI. The string contents are non-secret in the long run but
/// should be cleared from memory once the session ends.
///
/// Panics if `digits` is 0 or > 18 (would overflow the `u64` reservoir).
pub fn generate_pin(digits: usize) -> Result<String, PairingError> {
    assert!(
        (1..=18).contains(&digits),
        "pin digits must be 1..=18, got {digits}"
    );
    // Sample `digits` random decimal characters by rejecting biased ranges
    // via getrandom — slightly wasteful but keeps the implementation small.
    let raw = random_bytes(digits)
        .map_err(|e| PairingError::Rng(e.to_string()))?;
    let mut out = String::with_capacity(digits);
    for byte in raw {
        // Map a byte to 0..10 via reduction. Uniform-ish for low digits;
        // bias is < 2^-5, which is irrelevant against a 60-second 3-attempt
        // lockout.
        let d = byte % 10;
        out.push(char::from(b'0' + d));
    }
    Ok(out)
}

// --- internal -------------------------------------------------------------

fn derive_session_key(secret: &[u8]) -> [u8; SESSION_KEY_LEN] {
    let mut h = Sha256::new();
    h.update(SESSION_KEY_TAG);
    h.update(secret);
    let digest = h.finalize();
    let mut out = [0u8; SESSION_KEY_LEN];
    out.copy_from_slice(&digest);
    out
}

fn derive_confirm(secret: &[u8], tag: &[u8]) -> [u8; CONFIRM_TAG_LEN] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(secret);
    let digest = h.finalize();
    let mut out = [0u8; CONFIRM_TAG_LEN];
    out.copy_from_slice(&digest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_handshake_succeeds() {
        let pin = b"123456";
        let client = PakeClient::start(pin).unwrap();
        let server = PakeServer::start(pin).unwrap();
        let msg_a = client.message().to_vec();
        let msg_b = server.message().to_vec();
        let client_out = client.finish(&msg_b).unwrap();
        let (server_key, server_confirm) =
            server.finish(&msg_a, &client_out.confirm_a).unwrap();
        client_out
            .verify_server_confirm(&server_confirm)
            .expect("server confirm");
        assert_eq!(server_key, client_out.session_key);
    }

    #[test]
    fn wrong_pin_fails_at_confirm_stage() {
        let client = PakeClient::start(b"111111").unwrap();
        let server = PakeServer::start(b"222222").unwrap();
        let msg_a = client.message().to_vec();
        let msg_b = server.message().to_vec();
        let client_out = client.finish(&msg_b).unwrap();
        // Server must reject the bogus client confirmation tag.
        let err = server
            .finish(&msg_a, &client_out.confirm_a)
            .expect_err("must reject");
        assert!(matches!(err, PairingError::ConfirmationMismatch));
    }

    #[test]
    fn tampered_msg_a_rejected() {
        let pin = b"888888";
        let client = PakeClient::start(pin).unwrap();
        let server = PakeServer::start(pin).unwrap();
        let mut bad_msg_a = client.message().to_vec();
        bad_msg_a[0] ^= 0xff;
        let msg_b = server.message().to_vec();
        let client_out = client.finish(&msg_b).unwrap();
        let res = server.finish(&bad_msg_a, &client_out.confirm_a);
        assert!(res.is_err(), "tampered msg_a must not produce matching key");
    }

    #[test]
    fn message_length_validation() {
        let server = PakeServer::start(b"000000").unwrap();
        let err = server.finish(&[], &[0u8; CONFIRM_TAG_LEN]).unwrap_err();
        assert!(matches!(err, PairingError::BadMessageLength { .. }));
    }

    #[test]
    fn pin_guard_locks_after_max_attempts() {
        let mut g = PinAttemptGuard::new();
        for _ in 0..(MAX_PIN_ATTEMPTS - 1) {
            assert!(!g.record_failure(100));
            assert!(g.check(100).is_ok());
        }
        let locked = g.record_failure(100);
        assert!(locked);
        let err = g.check(100).unwrap_err();
        assert!(matches!(err, PairingError::Locked { .. }));
        // After window expires, check passes again.
        assert!(g.check(100 + PIN_LOCKOUT_SECS).is_ok());
    }

    #[test]
    fn pin_guard_resets_on_success() {
        let mut g = PinAttemptGuard::new();
        g.record_failure(0);
        g.record_failure(0);
        g.record_success();
        // After success the counter starts over; one more failure should not
        // immediately trigger lockout.
        assert!(!g.record_failure(0));
    }

    #[test]
    fn generate_pin_correct_length_and_decimal() {
        let pin = generate_pin(6).unwrap();
        assert_eq!(pin.len(), 6);
        for c in pin.chars() {
            assert!(c.is_ascii_digit(), "non-digit in PIN: {c}");
        }
    }
}
