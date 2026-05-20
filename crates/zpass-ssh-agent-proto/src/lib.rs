//! `zpass-ssh-agent-proto` — zpass-desktop ↔ zpass-agent 控制通道协议（spec/08）。
//!
//! - **不**实现 OpenSSH agent protocol 本身（那是 zpass-agent 内部用 `ssh-encoding`
//!   或手写解的事）。
//! - 仅定义：CapabilityToken（HMAC 鉴权）、AgentMessage（CBOR 类型）、
//!   `[4 bytes BE length][CBOR bytes]` 帧编解码。
//!
//! 设计原则与 `zpass-otp` 一致：
//! - 同步、阻塞、`no_std + alloc`（不依赖 `std::io`；`read_frame` / `write_frame`
//!   只要求 trait `Read` / `Write` 等价物）。
//! - 不依赖 vault / GPUI / 异步运行时。

#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop};

// ===================== Capability Token =====================

/// 32 字节 capability token，存放在 `~/.config/zpass/agent.cap`（0600）。
///
/// 用于 GUI ↔ agent 控制通道的相互鉴权（HMAC-SHA256(token, nonce)）。
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct CapabilityToken(pub [u8; 32]);

impl fmt::Debug for CapabilityToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // 永远不在 Debug 输出中泄露 token 内容。
        f.write_str("CapabilityToken(<redacted>)")
    }
}

impl CapabilityToken {
    /// 生成 32 字节随机 token（OS CSPRNG）。
    #[cfg(feature = "os-rng")]
    pub fn random() -> Result<Self, ProtoError> {
        let mut buf = [0u8; 32];
        getrandom::getrandom(&mut buf).map_err(|_| ProtoError::Rng)?;
        Ok(Self(buf))
    }

    /// 从 32 字节切片构造。
    pub fn from_bytes(b: &[u8]) -> Result<Self, ProtoError> {
        if b.len() != 32 {
            return Err(ProtoError::InvalidLength);
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(b);
        Ok(Self(out))
    }

    /// `HMAC-SHA256(token, nonce) -> 32 bytes`。
    pub fn hmac(&self, nonce: &[u8]) -> [u8; 32] {
        let mut mac =
            <Hmac<Sha256> as Mac>::new_from_slice(&self.0).expect("HMAC accepts any key length");
        mac.update(nonce);
        let result = mac.finalize().into_bytes();
        let mut out = [0u8; 32];
        out.copy_from_slice(&result);
        out
    }

    /// 恒定时间比较验证 HMAC。
    pub fn verify_hmac(&self, nonce: &[u8], expected: &[u8; 32]) -> bool {
        let actual = self.hmac(nonce);
        actual.ct_eq(expected).into()
    }
}

// ===================== Messages =====================

/// 控制通道消息（CBOR 序列化）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentMessage {
    /// GUI → agent: 随机 nonce，等待 agent 用 token HMAC 回签。
    Hello { nonce: [u8; 32] },
    /// agent → GUI: 回签。
    HelloReply { nonce: [u8; 32], hmac: [u8; 32] },
    /// GUI → agent: 通报当前解锁状态（unlocked=false 时 agent 应拒签）。
    OpState { unlocked: bool },
    /// GUI → agent: 推送当前 vault 中所有 SSH key 的公钥 + item_id。
    PushKeys { keys: Vec<PublicKeyEntry> },
    /// agent → GUI: 收到 SSH client 的 SIGN_REQUEST，请求 GUI 用 item 的私钥签名。
    SignRequest {
        request_id: u64,
        /// 公钥 blob（OpenSSH agent protocol 的 key blob 格式）。
        key_blob: Vec<u8>,
        /// 要签的数据。
        data: Vec<u8>,
        /// OpenSSH agent flags（SSH_AGENT_RSA_SHA2_256 / 512 等）。
        flags: u32,
    },
    /// GUI → agent: 签名结果（Err = 拒签/锁定/失败，字符串原因不含敏感数据）。
    SignReply {
        request_id: u64,
        signature: Result<Vec<u8>, String>,
    },
    /// agent → GUI: 一条审计条目（GUI 调 VaultService::append_audit 持久化）。
    AuditEntry { entry: AuditEntryWire },
    /// 任一侧主动关闭。
    Bye,
}

/// SSH 公钥条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicKeyEntry {
    /// vault item id（GUI 用它定位 vault item）。
    pub item_id: String,
    /// SSH agent protocol 的 key blob。
    pub blob: Vec<u8>,
    /// 公钥 comment（可选；可能为空）。
    pub comment: String,
}

/// 审计条目的线缆形态（与 vault-format 的 `AuditEntry` 等价但解耦
/// vault-format crate 依赖，避免 agent 进程拉进 vault 类型）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntryWire {
    pub created_at: i64,
    pub fingerprint: String,
    pub key_comment: String,
    pub client_pid: Option<u32>,
    pub client_exe: Option<String>,
    pub decision: AuditDecisionWire,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuditDecisionWire {
    Approved,
    DeclinedByUser,
    TrustedCache,
    VaultLocked,
    KeyNotFound,
    Timeout,
    Error(String),
}

// ===================== Frame codec =====================

/// 帧格式：`[4 bytes BE length][CBOR bytes]`。
///
/// 上限：单帧 16 MiB（safety cap；正常消息远小于此）。
pub const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

/// 编码一条消息为字节帧。
pub fn encode_frame(msg: &AgentMessage) -> Result<Vec<u8>, ProtoError> {
    let mut body = Vec::new();
    ciborium::ser::into_writer(msg, &mut body).map_err(|_| ProtoError::Encode)?;
    if body.len() as u64 > MAX_FRAME_LEN as u64 {
        return Err(ProtoError::FrameTooLarge);
    }
    let len = body.len() as u32;
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// 从字节切片解码（输入必须恰好是完整的一帧；调用方负责拆帧）。
pub fn decode_frame(bytes: &[u8]) -> Result<AgentMessage, ProtoError> {
    if bytes.len() < 4 {
        return Err(ProtoError::ShortHeader);
    }
    let len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    if len > MAX_FRAME_LEN {
        return Err(ProtoError::FrameTooLarge);
    }
    if bytes.len() != 4 + len as usize {
        return Err(ProtoError::FrameLengthMismatch);
    }
    let body = &bytes[4..];
    ciborium::de::from_reader(body).map_err(|_| ProtoError::Decode)
}

// ===================== Errors =====================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtoError {
    /// HMAC 验证失败 / token 不匹配。
    AuthFailed,
    /// 帧长度超过 `MAX_FRAME_LEN`。
    FrameTooLarge,
    /// 头部 4 字节不全。
    ShortHeader,
    /// 帧长与实际 body 长度不符。
    FrameLengthMismatch,
    /// CBOR 编码失败（理论上不会发生）。
    Encode,
    /// CBOR 解码失败。
    Decode,
    /// CapabilityToken 字节长度不是 32。
    InvalidLength,
    /// CSPRNG 失败（仅 `os-rng` feature 路径）。
    Rng,
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AuthFailed => f.write_str("HMAC authentication failed"),
            Self::FrameTooLarge => f.write_str("frame exceeds MAX_FRAME_LEN"),
            Self::ShortHeader => f.write_str("incomplete 4-byte length header"),
            Self::FrameLengthMismatch => f.write_str("frame length does not match body bytes"),
            Self::Encode => f.write_str("CBOR encode failed"),
            Self::Decode => f.write_str("CBOR decode failed"),
            Self::InvalidLength => f.write_str("invalid capability token length"),
            Self::Rng => f.write_str("CSPRNG failed"),
        }
    }
}

// ===================== Tests =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "os-rng")]
    fn fresh_token() -> CapabilityToken {
        CapabilityToken::random().unwrap()
    }

    /// spec/08 § 8 mandatory: `proto_round_trip`。
    #[test]
    fn proto_round_trip() {
        // Hello
        let msg = AgentMessage::Hello { nonce: [7u8; 32] };
        let bytes = encode_frame(&msg).unwrap();
        let decoded = decode_frame(&bytes).unwrap();
        match decoded {
            AgentMessage::Hello { nonce } => assert_eq!(nonce, [7u8; 32]),
            _ => panic!("wrong variant"),
        }

        // OpState
        let msg = AgentMessage::OpState { unlocked: true };
        let decoded = decode_frame(&encode_frame(&msg).unwrap()).unwrap();
        assert!(matches!(decoded, AgentMessage::OpState { unlocked: true }));

        // SignRequest
        let msg = AgentMessage::SignRequest {
            request_id: 42,
            key_blob: alloc::vec![0xAA; 51],
            data: alloc::vec![0xBB; 100],
            flags: 0x02,
        };
        let decoded = decode_frame(&encode_frame(&msg).unwrap()).unwrap();
        if let AgentMessage::SignRequest {
            request_id,
            key_blob,
            data,
            flags,
        } = decoded
        {
            assert_eq!(request_id, 42);
            assert_eq!(key_blob.len(), 51);
            assert_eq!(data.len(), 100);
            assert_eq!(flags, 0x02);
        } else {
            panic!();
        }

        // SignReply (Err)
        let msg = AgentMessage::SignReply {
            request_id: 7,
            signature: Err("vault locked".into()),
        };
        let decoded = decode_frame(&encode_frame(&msg).unwrap()).unwrap();
        if let AgentMessage::SignReply {
            request_id,
            signature,
        } = decoded
        {
            assert_eq!(request_id, 7);
            assert_eq!(signature.unwrap_err(), "vault locked");
        } else {
            panic!();
        }
    }

    /// spec/08 § 8 mandatory: `hmac_token_constant_time`。
    ///
    /// 通过验证 `verify_hmac` 用 subtle::ConstantTimeEq 而非 `==`。
    /// 直接断言行为正确：正确 HMAC 通过，错误 HMAC 拒绝。
    #[test]
    #[cfg(feature = "os-rng")]
    fn hmac_token_constant_time() {
        let t = fresh_token();
        let nonce = [3u8; 32];
        let good = t.hmac(&nonce);
        assert!(t.verify_hmac(&nonce, &good));

        // 篡改一个字节
        let mut bad = good;
        bad[0] ^= 0x01;
        assert!(!t.verify_hmac(&nonce, &bad));

        // 全零 HMAC 不应通过
        assert!(!t.verify_hmac(&nonce, &[0u8; 32]));
    }

    #[test]
    fn frame_too_large_rejected_on_decode() {
        // 构造一个 length header 表示 > MAX_FRAME_LEN 的帧
        let huge_len = (MAX_FRAME_LEN + 1).to_be_bytes();
        let mut buf = Vec::from(huge_len);
        buf.extend_from_slice(&[0u8; 8]); // 任意 body
        assert_eq!(decode_frame(&buf).unwrap_err(), ProtoError::FrameTooLarge);
    }

    #[test]
    fn short_header_rejected() {
        assert_eq!(
            decode_frame(&[1, 2, 3]).unwrap_err(),
            ProtoError::ShortHeader
        );
    }

    #[test]
    fn frame_length_mismatch_rejected() {
        // header 说 100 字节，但 body 实际 0 字节
        let mut buf = (100u32).to_be_bytes().to_vec();
        // 不补 body
        assert_eq!(
            decode_frame(&buf).unwrap_err(),
            ProtoError::FrameLengthMismatch
        );
        // 多了字节
        buf.extend_from_slice(&[0u8; 200]);
        assert_eq!(
            decode_frame(&buf).unwrap_err(),
            ProtoError::FrameLengthMismatch
        );
    }

    #[test]
    fn capability_token_redacts_in_debug() {
        let t = CapabilityToken::from_bytes(&[0xFFu8; 32]).unwrap();
        let s = alloc::format!("{:?}", t);
        assert!(s.contains("redacted"));
        assert!(!s.contains("ff"));
    }

    #[test]
    fn capability_token_from_bytes_length_check() {
        assert!(CapabilityToken::from_bytes(&[0u8; 31]).is_err());
        assert!(CapabilityToken::from_bytes(&[0u8; 33]).is_err());
        assert!(CapabilityToken::from_bytes(&[0u8; 32]).is_ok());
    }

    #[test]
    fn audit_entry_wire_round_trip() {
        let e = AuditEntryWire {
            created_at: 12345,
            fingerprint: "SHA256:abc".into(),
            key_comment: "alice@host".into(),
            client_pid: Some(1000),
            client_exe: Some("/usr/bin/ssh".into()),
            decision: AuditDecisionWire::Approved,
        };
        let msg = AgentMessage::AuditEntry { entry: e.clone() };
        let decoded = decode_frame(&encode_frame(&msg).unwrap()).unwrap();
        if let AgentMessage::AuditEntry { entry } = decoded {
            assert_eq!(entry.fingerprint, e.fingerprint);
            assert_eq!(entry.client_pid, e.client_pid);
            assert_eq!(entry.decision, e.decision);
        } else {
            panic!();
        }
    }

    #[test]
    fn audit_decision_locked_serializes() {
        let e = AuditEntryWire {
            created_at: 0,
            fingerprint: "x".into(),
            key_comment: "".into(),
            client_pid: None,
            client_exe: None,
            decision: AuditDecisionWire::VaultLocked,
        };
        let msg = AgentMessage::AuditEntry { entry: e };
        let bytes = encode_frame(&msg).unwrap();
        let decoded = decode_frame(&bytes).unwrap();
        if let AgentMessage::AuditEntry { entry } = decoded {
            assert_eq!(entry.decision, AuditDecisionWire::VaultLocked);
        } else {
            panic!();
        }
    }
}
