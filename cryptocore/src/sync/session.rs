//! Encrypted session built on the SPAKE2-derived key.
//!
//! Wraps every CBOR proto frame in XChaCha20-Poly1305 with a 24-byte nonce
//! whose layout is:
//!
//! ```text
//! [direction byte] [16 random bytes] [7-byte big-endian counter]
//! ```
//!
//! The direction byte (`0x01` server→client, `0x02` client→server) guarantees
//! the two sides never reuse a nonce even if both pick the same random prefix.
//! The 7-byte counter strictly increases per direction; the receiver rejects
//! any frame whose counter is `<=` the last accepted, blocking trivial replay.
//!
//! Rust guideline compliant 2026-02-21

use core::sync::atomic::{AtomicU64, Ordering};

use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};

use crate::{NONCE_SIZE, random_bytes};

/// Maximum allowed counter value before the session must be rotated.
///
/// We give ourselves 7 bytes (= 2^56) of counter space, which is effectively
/// inexhaustible (one frame per microsecond for ~2000 years). The hard cap
/// here exists so a buggy caller can't silently overflow and reuse nonces.
const MAX_COUNTER: u64 = (1u64 << 56) - 1;

/// Direction-byte prefix mixed into every nonce so the two sides never
/// collide even with identical random prefixes.
const DIR_PREFIX_SERVER: u8 = 0x01;
const DIR_PREFIX_CLIENT: u8 = 0x02;

/// Which peer the [`Session`] represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Server end of the channel — encrypts with [`DIR_PREFIX_SERVER`].
    Server,
    /// Client end — encrypts with [`DIR_PREFIX_CLIENT`].
    Client,
}

impl Direction {
    fn send_prefix(self) -> u8 {
        match self {
            Self::Server => DIR_PREFIX_SERVER,
            Self::Client => DIR_PREFIX_CLIENT,
        }
    }

    fn recv_prefix(self) -> u8 {
        match self {
            Self::Server => DIR_PREFIX_CLIENT,
            Self::Client => DIR_PREFIX_SERVER,
        }
    }
}

/// Errors from session encryption / decryption.
#[derive(Debug)]
pub enum SessionError {
    /// Random byte generator failure when minting a fresh nonce prefix.
    Rng(String),
    /// AEAD tag rejected the ciphertext — bad key / tampering / wrong AAD.
    Authentication,
    /// Frame too short to even hold a nonce + tag.
    Truncated { got: usize },
    /// Frame's direction byte did not match what the receiver expected —
    /// either a reflection attack or a routing bug.
    WrongDirection { got: u8, want: u8 },
    /// Counter went backwards or repeated — replay attempt.
    ReplayedCounter { got: u64, last_accepted: u64 },
    /// Outgoing counter would exceed [`MAX_COUNTER`].
    CounterExhausted,
}

impl core::fmt::Display for SessionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Rng(e) => write!(f, "session rng: {e}"),
            Self::Authentication => write!(f, "session aead authentication failed"),
            Self::Truncated { got } => write!(f, "session frame too short: {got} bytes"),
            Self::WrongDirection { got, want } => {
                write!(f, "session direction byte mismatch: got 0x{got:02x}, want 0x{want:02x}")
            }
            Self::ReplayedCounter { got, last_accepted } => {
                write!(f, "session counter replayed: got {got}, last {last_accepted}")
            }
            Self::CounterExhausted => write!(f, "session send counter exhausted"),
        }
    }
}

impl std::error::Error for SessionError {}

/// One end of an authenticated, replay-protected channel.
///
/// Multiple threads may share a [`Session`] safely — the cipher itself is
/// internally immutable and both counters are atomic. Debug intentionally
/// omits the cipher (which lacks `Debug`) so we get a hand-rolled impl.
pub struct Session {
    cipher: XChaCha20Poly1305,
    direction: Direction,
    send_counter: AtomicU64,
    recv_counter: AtomicU64,
}

impl core::fmt::Debug for Session {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Session")
            .field("direction", &self.direction)
            .field("send_counter", &self.send_counter.load(Ordering::Relaxed))
            .field("recv_counter", &self.recv_counter.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl Session {
    /// Build a session from the 32-byte key derived by [`crate::sync::pake`].
    pub fn new(key: [u8; 32], direction: Direction) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new((&key).into()),
            direction,
            send_counter: AtomicU64::new(0),
            recv_counter: AtomicU64::new(0),
        }
    }

    /// Encrypt `plaintext` with `aad` bound, returning a self-contained frame:
    /// `[24-byte nonce][ciphertext][16-byte tag]`.
    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, SessionError> {
        let counter = self
            .send_counter
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        if counter > MAX_COUNTER {
            return Err(SessionError::CounterExhausted);
        }
        let nonce = build_nonce(self.direction.send_prefix(), counter)?;
        let ct = self
            .cipher
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad })
            .map_err(|_| SessionError::Authentication)?;

        let mut out = Vec::with_capacity(NONCE_SIZE + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Decrypt a frame produced by the peer's [`Self::seal`].
    ///
    /// Enforces strict counter monotonicity per direction. The first received
    /// frame must have counter ≥ 1; subsequent frames must strictly exceed
    /// the previously accepted counter (so missing frames are tolerated but
    /// replays are not).
    pub fn open(&self, frame: &[u8], aad: &[u8]) -> Result<Vec<u8>, SessionError> {
        if frame.len() < NONCE_SIZE + 16 {
            return Err(SessionError::Truncated { got: frame.len() });
        }
        let (nonce, ct) = frame.split_at(NONCE_SIZE);
        let got_prefix = nonce[0];
        let want_prefix = self.direction.recv_prefix();
        if got_prefix != want_prefix {
            return Err(SessionError::WrongDirection {
                got: got_prefix,
                want: want_prefix,
            });
        }
        let got_counter = parse_counter(nonce);
        let last_accepted = self.recv_counter.load(Ordering::SeqCst);
        if got_counter <= last_accepted {
            return Err(SessionError::ReplayedCounter {
                got: got_counter,
                last_accepted,
            });
        }
        let plaintext = self
            .cipher
            .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
            .map_err(|_| SessionError::Authentication)?;
        // Only update last-accepted after the AEAD authentication passes so
        // an unauthenticated forged frame cannot bump our high-water mark.
        self.recv_counter
            .compare_exchange(
                last_accepted,
                got_counter,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            // If another thread raced past us with a higher counter, that's
            // fine — they're newer than us, just no-op.
            .ok();
        Ok(plaintext)
    }

    /// Current send counter — useful for diagnostics / progress display.
    pub fn send_counter(&self) -> u64 {
        self.send_counter.load(Ordering::SeqCst)
    }

    /// Last accepted receive counter — useful for tests.
    pub fn last_recv_counter(&self) -> u64 {
        self.recv_counter.load(Ordering::SeqCst)
    }
}

fn build_nonce(prefix: u8, counter: u64) -> Result<[u8; NONCE_SIZE], SessionError> {
    debug_assert_eq!(NONCE_SIZE, 24);
    if counter > MAX_COUNTER {
        return Err(SessionError::CounterExhausted);
    }
    let random = random_bytes(16).map_err(|e| SessionError::Rng(e.to_string()))?;
    let mut nonce = [0u8; NONCE_SIZE];
    nonce[0] = prefix;
    nonce[1..17].copy_from_slice(&random);
    // 7-byte big-endian counter in nonce[17..24]
    let bytes = counter.to_be_bytes();
    nonce[17..24].copy_from_slice(&bytes[1..8]);
    Ok(nonce)
}

fn parse_counter(nonce: &[u8]) -> u64 {
    debug_assert!(nonce.len() >= NONCE_SIZE);
    let mut buf = [0u8; 8];
    buf[1..8].copy_from_slice(&nonce[17..24]);
    u64::from_be_bytes(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pair() -> ([u8; 32], Session, Session) {
        let key_vec = random_bytes(32).unwrap();
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_vec);
        let s = Session::new(key, Direction::Server);
        let c = Session::new(key, Direction::Client);
        (key, s, c)
    }

    #[test]
    fn server_to_client_round_trip() {
        let (_, server, client) = make_pair();
        let frame = server.seal(b"hello", b"req-1").unwrap();
        let plain = client.open(&frame, b"req-1").unwrap();
        assert_eq!(plain, b"hello");
    }

    #[test]
    fn client_to_server_round_trip() {
        let (_, server, client) = make_pair();
        let frame = client.seal(b"ping", b"req-2").unwrap();
        let plain = server.open(&frame, b"req-2").unwrap();
        assert_eq!(plain, b"ping");
    }

    #[test]
    fn replay_rejected() {
        let (_, server, client) = make_pair();
        let frame = server.seal(b"data", b"aad").unwrap();
        let _ = client.open(&frame, b"aad").unwrap();
        let err = client.open(&frame, b"aad").unwrap_err();
        assert!(matches!(err, SessionError::ReplayedCounter { .. }));
    }

    #[test]
    fn out_of_order_old_frame_rejected() {
        let (_, server, client) = make_pair();
        let frame1 = server.seal(b"a", b"aad").unwrap();
        let frame2 = server.seal(b"b", b"aad").unwrap();
        // Accept newer first; older must then be rejected as replay.
        let _ = client.open(&frame2, b"aad").unwrap();
        let err = client.open(&frame1, b"aad").unwrap_err();
        assert!(matches!(err, SessionError::ReplayedCounter { .. }));
    }

    #[test]
    fn wrong_direction_rejected() {
        let (_, _, client) = make_pair();
        // Build a frame that pretends to come from the client itself —
        // client.open() must refuse it (would be a reflection attack).
        let frame = client.seal(b"self", b"aad").unwrap();
        let err = client.open(&frame, b"aad").unwrap_err();
        assert!(matches!(err, SessionError::WrongDirection { .. }));
    }

    #[test]
    fn wrong_aad_rejected() {
        let (_, server, client) = make_pair();
        let frame = server.seal(b"data", b"req-a").unwrap();
        let err = client.open(&frame, b"req-b").unwrap_err();
        assert!(matches!(err, SessionError::Authentication));
    }

    #[test]
    fn wrong_key_rejected() {
        let (_, server, _) = make_pair();
        let frame = server.seal(b"x", b"aad").unwrap();
        // Build a fresh client with a different key.
        let other_key_vec = random_bytes(32).unwrap();
        let mut other_key = [0u8; 32];
        other_key.copy_from_slice(&other_key_vec);
        let other_client = Session::new(other_key, Direction::Client);
        let err = other_client.open(&frame, b"aad").unwrap_err();
        assert!(matches!(err, SessionError::Authentication));
    }

    #[test]
    fn truncated_frame_rejected() {
        let (_, _, client) = make_pair();
        let err = client.open(&[0u8; 5], b"aad").unwrap_err();
        assert!(matches!(err, SessionError::Truncated { .. }));
    }

    #[test]
    fn counter_strictly_monotonic() {
        let (_, server, _) = make_pair();
        let _ = server.seal(b"a", b"x").unwrap();
        let _ = server.seal(b"b", b"x").unwrap();
        let _ = server.seal(b"c", b"x").unwrap();
        assert_eq!(server.send_counter(), 3);
    }
}
