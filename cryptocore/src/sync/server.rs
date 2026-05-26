//! Server-side sync protocol state machine.
//!
//! Owns the SPAKE2 handshake, the post-handshake [`Session`], and an attempt
//! guard against PIN brute-force. The transport (HTTP / TCP) is the host's
//! responsibility — call sites feed bytes in and get bytes out.
//!
//! Lifecycle:
//!
//! ```text
//!   Idle  ──pair_init──▶  Pairing  ──pair_confirm──▶  Active
//!     ▲                      │
//!     └─────retry/fail───────┘     fail × N → Locked
//! ```
//!
//! Rust guideline compliant 2026-02-21

use std::sync::Mutex;

use crate::sync::pake::{
    PairingError, PakeServer, PinAttemptGuard, ServerSecrets, generate_pin,
    verify_client_confirm,
};
use crate::sync::proto::{
    PairConfirmRequest, PairConfirmResponse, PairInitRequest, PairInitResponse, ProtoError,
    decode, encode,
};
use crate::sync::session::{Direction, Session, SessionError};

/// Errors surfaced by [`SyncServer`].
#[derive(Debug)]
pub enum SyncError {
    Pairing(PairingError),
    Session(SessionError),
    Proto(ProtoError),
    /// A request arrived in a stage that doesn't accept it (e.g. open_request
    /// before pair_confirm completed).
    WrongStage,
    /// Two simultaneous pair_init attempts arrived; only one in-flight
    /// handshake is allowed.
    HandshakeInProgress,
    /// `session_id` in the request did not match what was issued at pair_init.
    SessionIdMismatch,
}

impl core::fmt::Display for SyncError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Pairing(e) => write!(f, "pairing: {e}"),
            Self::Session(e) => write!(f, "session: {e}"),
            Self::Proto(e) => write!(f, "proto: {e}"),
            Self::WrongStage => write!(f, "sync stage out of order"),
            Self::HandshakeInProgress => write!(f, "another handshake is in progress"),
            Self::SessionIdMismatch => write!(f, "session id mismatch"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<PairingError> for SyncError {
    fn from(e: PairingError) -> Self {
        Self::Pairing(e)
    }
}
impl From<SessionError> for SyncError {
    fn from(e: SessionError) -> Self {
        Self::Session(e)
    }
}
impl From<ProtoError> for SyncError {
    fn from(e: ProtoError) -> Self {
        Self::Proto(e)
    }
}

/// Top-level handle the host (Go sidecar / RN JNI) holds for the lifetime of
/// one "server is listening" window.
#[derive(Debug)]
pub struct SyncServer {
    pin: String,
    inner: Mutex<Inner>,
}

#[derive(Debug)]
enum Inner {
    Idle {
        guard: PinAttemptGuard,
    },
    Pairing {
        session_id: String,
        secrets: Box<ServerSecrets>,
        guard: PinAttemptGuard,
    },
    Active {
        session_id: String,
        session: Session,
    },
    Locked {
        guard: PinAttemptGuard,
    },
}

impl SyncServer {
    pub fn new() -> Result<Self, SyncError> {
        let pin = generate_pin(6)?;
        Ok(Self::with_pin(pin))
    }

    pub fn with_pin(pin: String) -> Self {
        Self {
            pin,
            inner: Mutex::new(Inner::Idle {
                guard: PinAttemptGuard::new(),
            }),
        }
    }

    pub fn pin(&self) -> &str {
        &self.pin
    }

    /// Handle `pair_init`. Returns CBOR-encoded [`PairInitResponse`].
    ///
    /// Server flow: parse req → run SPAKE2 → derive secrets → stash → respond
    /// with msg_b + session_id.
    pub fn handle_pair_init(
        &self,
        body: &[u8],
        now_unix_secs: u64,
    ) -> Result<Vec<u8>, SyncError> {
        let req: PairInitRequest = decode(body)?;

        let mut inner = self.inner.lock().expect("sync server mutex poisoned");

        // Normalize state: expired lockouts roll back to Idle; double pair_init
        // is refused.
        loop {
            match &*inner {
                Inner::Locked { guard } => {
                    if guard.check(now_unix_secs).is_ok() {
                        let g = guard.clone();
                        *inner = Inner::Idle { guard: g };
                        continue;
                    }
                    return Err(SyncError::Pairing(
                        guard
                            .check(now_unix_secs)
                            .err()
                            .expect("locked guard must reject"),
                    ));
                }
                Inner::Pairing { .. } => return Err(SyncError::HandshakeInProgress),
                Inner::Active { .. } => return Err(SyncError::WrongStage),
                Inner::Idle { .. } => break,
            }
        }

        let guard = match &*inner {
            Inner::Idle { guard } => guard.clone(),
            _ => unreachable!(),
        };
        guard.check(now_unix_secs)?;

        let server = PakeServer::start(self.pin.as_bytes())?;
        let msg_b = server.message().to_vec();
        let secrets = server.derive_secrets(&req.msg_a)?;
        let session_id = generate_session_id()?;
        let resp = PairInitResponse {
            session_id: session_id.clone(),
            msg_b,
        };
        let encoded = encode(&resp)?;

        *inner = Inner::Pairing {
            session_id,
            secrets: Box::new(secrets),
            guard,
        };
        Ok(encoded)
    }

    /// Handle `pair_confirm`. Returns CBOR-encoded [`PairConfirmResponse`].
    pub fn handle_pair_confirm(
        &self,
        body: &[u8],
        now_unix_secs: u64,
    ) -> Result<Vec<u8>, SyncError> {
        let req: PairConfirmRequest = decode(body)?;
        let mut inner = self.inner.lock().expect("sync server mutex poisoned");

        let (expected_sid, secrets, mut guard) = match std::mem::replace(
            &mut *inner,
            Inner::Idle {
                guard: PinAttemptGuard::new(),
            },
        ) {
            Inner::Pairing { session_id, secrets, guard } => (session_id, *secrets, guard),
            other => {
                *inner = other;
                return Err(SyncError::WrongStage);
            }
        };
        if req.session_id != expected_sid {
            *inner = Inner::Pairing {
                session_id: expected_sid,
                secrets: Box::new(secrets),
                guard,
            };
            return Err(SyncError::SessionIdMismatch);
        }
        match verify_client_confirm(&secrets, &req.confirm_a) {
            Ok(()) => {
                guard.record_success();
                let session = Session::new(secrets.session_key, Direction::Server);
                let resp = PairConfirmResponse {
                    confirm_b: secrets.confirm_b.to_vec(),
                };
                let encoded = encode(&resp)?;
                *inner = Inner::Active {
                    session_id: expected_sid,
                    session,
                };
                Ok(encoded)
            }
            Err(e) => {
                let locked = guard.record_failure(now_unix_secs);
                if locked {
                    *inner = Inner::Locked { guard };
                } else {
                    *inner = Inner::Idle { guard };
                }
                Err(SyncError::Pairing(e))
            }
        }
    }

    /// Decrypt an incoming request body. `aad` should be a stable label per
    /// endpoint, e.g. `b"manifest"` / `b"fetch"` / `b"push"`, so cross-endpoint
    /// frame replay is impossible.
    pub fn open_request(&self, encrypted: &[u8], aad: &[u8]) -> Result<Vec<u8>, SyncError> {
        let inner = self.inner.lock().expect("sync server mutex poisoned");
        match &*inner {
            Inner::Active { session, .. } => Ok(session.open(encrypted, aad)?),
            _ => Err(SyncError::WrongStage),
        }
    }

    /// Encrypt an outgoing response body.
    pub fn seal_response(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, SyncError> {
        let inner = self.inner.lock().expect("sync server mutex poisoned");
        match &*inner {
            Inner::Active { session, .. } => Ok(session.seal(plaintext, aad)?),
            _ => Err(SyncError::WrongStage),
        }
    }

    pub fn session_id(&self) -> Option<String> {
        let inner = self.inner.lock().expect("sync server mutex poisoned");
        match &*inner {
            Inner::Active { session_id, .. } => Some(session_id.clone()),
            Inner::Pairing { session_id, .. } => Some(session_id.clone()),
            _ => None,
        }
    }

    pub fn is_active(&self) -> bool {
        let inner = self.inner.lock().expect("sync server mutex poisoned");
        matches!(&*inner, Inner::Active { .. })
    }
}

fn generate_session_id() -> Result<String, SyncError> {
    let raw = crate::random_bytes(8)
        .map_err(|e| SyncError::Pairing(PairingError::Rng(e.to_string())))?;
    Ok(hex::encode(raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::pake::PakeClient;

    fn run_full_handshake(server: &SyncServer, pin: &str) -> Session {
        let client = PakeClient::start(pin.as_bytes()).unwrap();
        let msg_a = client.message().to_vec();

        let init_body = encode(&PairInitRequest { msg_a: msg_a.clone() }).unwrap();
        let init_resp_bytes = server.handle_pair_init(&init_body, 0).unwrap();
        let init_resp: PairInitResponse = decode(&init_resp_bytes).unwrap();

        let client_out = client.finish(&init_resp.msg_b).unwrap();
        let confirm_body = encode(&PairConfirmRequest {
            session_id: init_resp.session_id.clone(),
            confirm_a: client_out.confirm_a.to_vec(),
        })
        .unwrap();
        let confirm_resp_bytes = server.handle_pair_confirm(&confirm_body, 0).unwrap();
        let confirm_resp: PairConfirmResponse = decode(&confirm_resp_bytes).unwrap();
        client_out
            .verify_server_confirm(&confirm_resp.confirm_b)
            .expect("server confirm tag must match");
        Session::new(client_out.session_key, Direction::Client)
    }

    #[test]
    fn happy_path_round_trip() {
        let server = SyncServer::with_pin("123456".into());
        let client = run_full_handshake(&server, "123456");
        assert!(server.is_active());

        let enc = client.seal(b"hello", b"manifest").unwrap();
        let plain = server.open_request(&enc, b"manifest").unwrap();
        assert_eq!(plain, b"hello");

        let resp = server.seal_response(b"world", b"manifest").unwrap();
        let resp_plain = client.open(&resp, b"manifest").unwrap();
        assert_eq!(resp_plain, b"world");
    }

    #[test]
    fn wrong_pin_does_not_activate() {
        let server = SyncServer::with_pin("123456".into());
        let client = PakeClient::start(b"999999").unwrap();
        let init_body = encode(&PairInitRequest {
            msg_a: client.message().to_vec(),
        })
        .unwrap();
        let init_resp_bytes = server.handle_pair_init(&init_body, 0).unwrap();
        let init_resp: PairInitResponse = decode(&init_resp_bytes).unwrap();
        let client_out = client.finish(&init_resp.msg_b).unwrap();
        let confirm_body = encode(&PairConfirmRequest {
            session_id: init_resp.session_id.clone(),
            confirm_a: client_out.confirm_a.to_vec(),
        })
        .unwrap();
        let res = server.handle_pair_confirm(&confirm_body, 0);
        assert!(matches!(res, Err(SyncError::Pairing(_))));
        assert!(!server.is_active());
    }

    #[test]
    fn open_request_before_handshake_fails() {
        let server = SyncServer::with_pin("000000".into());
        let err = server.open_request(b"x", b"manifest").unwrap_err();
        assert!(matches!(err, SyncError::WrongStage));
    }

    #[test]
    fn three_wrong_pin_attempts_trigger_lockout() {
        let server = SyncServer::with_pin("000000".into());
        for _ in 0..3 {
            let client = PakeClient::start(b"999999").unwrap();
            let init_body = encode(&PairInitRequest {
                msg_a: client.message().to_vec(),
            })
            .unwrap();
            let init_resp_bytes = server.handle_pair_init(&init_body, 0).unwrap();
            let init_resp: PairInitResponse = decode(&init_resp_bytes).unwrap();
            let client_out = client.finish(&init_resp.msg_b).unwrap();
            let confirm_body = encode(&PairConfirmRequest {
                session_id: init_resp.session_id.clone(),
                confirm_a: client_out.confirm_a.to_vec(),
            })
            .unwrap();
            let _ = server.handle_pair_confirm(&confirm_body, 0);
        }
        // Fourth attempt should be locked.
        let client = PakeClient::start(b"123456").unwrap();
        let init_body = encode(&PairInitRequest {
            msg_a: client.message().to_vec(),
        })
        .unwrap();
        let res = server.handle_pair_init(&init_body, 0);
        assert!(matches!(res, Err(SyncError::Pairing(PairingError::Locked { .. }))));
    }
}
