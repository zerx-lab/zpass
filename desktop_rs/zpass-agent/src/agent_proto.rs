//! OpenSSH agent protocol（spec/08 § 4 子集）。
//!
//! 帧格式：`[uint32 length][byte type][byte[length-1] payload]`。
//!
//! 我们只实现 ssh-client 会主动发的几个 op：
//! - `REQUEST_IDENTITIES` (11)：列公钥
//! - `SIGN_REQUEST` (13)：签名
//! - `ADD_IDENTITY` (17)、`REMOVE_IDENTITY` (18)、`REMOVE_ALL_IDENTITIES` (19)：拒绝
//!
//! 我们发回的 op：
//! - `FAILURE` (5)、`SUCCESS` (6)、`IDENTITIES_ANSWER` (12)、`SIGN_RESPONSE` (14)
//!
//! 这里**不**实现 ssh-encoding 全套；只够 read/write 我们用到的字段。
//! 维护成本低（< 200 LOC），避免引入第三方 ssh crate 的传递依赖。

use std::io::{self, Read, Write};

pub const SSH_AGENT_FAILURE: u8 = 5;
pub const SSH_AGENT_SUCCESS: u8 = 6;
pub const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
pub const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
pub const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
pub const SSH_AGENT_SIGN_RESPONSE: u8 = 14;
pub const SSH_AGENTC_ADD_IDENTITY: u8 = 17;
pub const SSH_AGENTC_REMOVE_IDENTITY: u8 = 18;
pub const SSH_AGENTC_REMOVE_ALL_IDENTITIES: u8 = 19;

/// 上限：单个 ssh-agent 请求 256 KiB（key blob + data 总和；正常 << 此值）。
pub const MAX_REQUEST_SIZE: u32 = 256 * 1024;

/// 解析一个完整的 agent message 帧。
///
/// 返回 `(op_type, payload_bytes)`。
pub fn read_message<R: Read>(r: &mut R) -> io::Result<(u8, Vec<u8>)> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf);
    if len == 0 || len > MAX_REQUEST_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid agent message length: {len}"),
        ));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)?;
    let op = body[0];
    let payload = body[1..].to_vec();
    Ok((op, payload))
}

/// 写一个 agent message 帧（length 自动算）。
pub fn write_message<W: Write>(w: &mut W, op: u8, payload: &[u8]) -> io::Result<()> {
    let len = 1 + payload.len();
    if len > MAX_REQUEST_SIZE as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "agent message too large to write",
        ));
    }
    w.write_all(&(len as u32).to_be_bytes())?;
    w.write_all(&[op])?;
    w.write_all(payload)?;
    w.flush()
}

// ===================== payload helpers =====================

/// 读取一个 SSH string (`uint32 len + bytes`)。
pub fn read_string(buf: &[u8], cursor: &mut usize) -> io::Result<Vec<u8>> {
    if *cursor + 4 > buf.len() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "short string header",
        ));
    }
    let len = u32::from_be_bytes([
        buf[*cursor],
        buf[*cursor + 1],
        buf[*cursor + 2],
        buf[*cursor + 3],
    ]) as usize;
    *cursor += 4;
    if *cursor + len > buf.len() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "short string body",
        ));
    }
    let s = buf[*cursor..*cursor + len].to_vec();
    *cursor += len;
    Ok(s)
}

/// 读取一个 u32。
pub fn read_u32(buf: &[u8], cursor: &mut usize) -> io::Result<u32> {
    if *cursor + 4 > buf.len() {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short u32"));
    }
    let v = u32::from_be_bytes([
        buf[*cursor],
        buf[*cursor + 1],
        buf[*cursor + 2],
        buf[*cursor + 3],
    ]);
    *cursor += 4;
    Ok(v)
}

/// 写入一个 SSH string。
pub fn write_string(buf: &mut Vec<u8>, s: &[u8]) {
    buf.extend_from_slice(&(s.len() as u32).to_be_bytes());
    buf.extend_from_slice(s);
}

/// 写入一个 u32。
pub fn write_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_be_bytes());
}

// ===================== Parsed SIGN_REQUEST =====================

pub struct SignRequest {
    pub key_blob: Vec<u8>,
    pub data: Vec<u8>,
    pub flags: u32,
}

pub fn parse_sign_request(payload: &[u8]) -> io::Result<SignRequest> {
    let mut cursor = 0;
    let key_blob = read_string(payload, &mut cursor)?;
    let data = read_string(payload, &mut cursor)?;
    let flags = read_u32(payload, &mut cursor)?;
    Ok(SignRequest {
        key_blob,
        data,
        flags,
    })
}

// ===================== Build IDENTITIES_ANSWER =====================

pub struct Identity<'a> {
    pub blob: &'a [u8],
    pub comment: &'a str,
}

pub fn build_identities_answer(ids: &[Identity<'_>]) -> Vec<u8> {
    let mut buf = Vec::new();
    write_u32(&mut buf, ids.len() as u32);
    for id in ids {
        write_string(&mut buf, id.blob);
        write_string(&mut buf, id.comment.as_bytes());
    }
    buf
}

// ===================== Build SIGN_RESPONSE =====================

pub fn build_sign_response(signature: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    write_string(&mut buf, signature);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_message() {
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, SSH_AGENTC_REQUEST_IDENTITIES, &[]).unwrap();
        // 长度 = 1（op only），bytes = [0,0,0,1, 11]
        assert_eq!(buf, vec![0, 0, 0, 1, SSH_AGENTC_REQUEST_IDENTITIES]);

        let mut cursor = std::io::Cursor::new(buf);
        let (op, payload) = read_message(&mut cursor).unwrap();
        assert_eq!(op, SSH_AGENTC_REQUEST_IDENTITIES);
        assert!(payload.is_empty());
    }

    #[test]
    fn round_trip_sign_request() {
        // 构造一个 SIGN_REQUEST：key_blob = b"keyblob", data = b"to-sign", flags = 2
        let mut payload = Vec::new();
        write_string(&mut payload, b"keyblob");
        write_string(&mut payload, b"to-sign");
        write_u32(&mut payload, 2);

        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, SSH_AGENTC_SIGN_REQUEST, &payload).unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let (op, payload2) = read_message(&mut cursor).unwrap();
        assert_eq!(op, SSH_AGENTC_SIGN_REQUEST);
        let sr = parse_sign_request(&payload2).unwrap();
        assert_eq!(sr.key_blob, b"keyblob");
        assert_eq!(sr.data, b"to-sign");
        assert_eq!(sr.flags, 2);
    }

    #[test]
    fn build_identities_answer_two_keys() {
        let ids = [
            Identity {
                blob: b"key1blob",
                comment: "alice@host",
            },
            Identity {
                blob: b"key2blob",
                comment: "",
            },
        ];
        let payload = build_identities_answer(&ids);
        // 解析回来
        let mut cursor = 0;
        let count = read_u32(&payload, &mut cursor).unwrap();
        assert_eq!(count, 2);
        let b1 = read_string(&payload, &mut cursor).unwrap();
        let c1 = read_string(&payload, &mut cursor).unwrap();
        assert_eq!(b1, b"key1blob");
        assert_eq!(c1, b"alice@host");
        let b2 = read_string(&payload, &mut cursor).unwrap();
        let c2 = read_string(&payload, &mut cursor).unwrap();
        assert_eq!(b2, b"key2blob");
        assert!(c2.is_empty());
    }

    #[test]
    fn reject_zero_length() {
        let buf = vec![0u8, 0, 0, 0, 99]; // len=0
        let mut cursor = std::io::Cursor::new(buf);
        assert!(read_message(&mut cursor).is_err());
    }

    #[test]
    fn reject_oversize_length() {
        let huge_len = (MAX_REQUEST_SIZE + 1).to_be_bytes();
        let mut buf = huge_len.to_vec();
        buf.push(11);
        let mut cursor = std::io::Cursor::new(buf);
        assert!(read_message(&mut cursor).is_err());
    }

    #[test]
    fn build_sign_response_wraps_in_string() {
        let sig = b"\x00\x00\x00\x07ssh-rsa\x00\x00\x00\x04\xaa\xbb\xcc\xdd";
        let resp = build_sign_response(sig);
        // resp = [4 bytes len][sig bytes]
        assert_eq!(resp.len(), 4 + sig.len());
        let len = u32::from_be_bytes([resp[0], resp[1], resp[2], resp[3]]);
        assert_eq!(len as usize, sig.len());
        assert_eq!(&resp[4..], sig);
    }
}
