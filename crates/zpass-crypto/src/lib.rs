//! `zpass-crypto` —— 加密原语层。
//!
//! - **算法**：Argon2id (KDF) + XChaCha20-Poly1305 (AEAD)。
//! - **约束**：`#![no_std]` + `extern crate alloc`，禁止 `std::*`、禁止 IO、禁止 async。
//! - **错误模糊化**：任何 AEAD / KDF 失败统一返回 `CryptoError::AuthFailed`（详见 spec/04 § 5）。
//!
//! 见 `spec/04-crypto-contract.md` 的完整契约说明。

#![no_std]

extern crate alloc;

use alloc::vec::Vec;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::{Zeroize, Zeroizing};

pub const KEY_SIZE: usize = 32;
pub const NONCE_SIZE: usize = 24;
pub const SALT_SIZE: usize = 32;
pub const AEAD_TAG_SIZE: usize = 16;

/// AEAD 输出最小长度 = nonce + tag（密文可以为空字符串）。
pub const AEAD_MIN_SEALED_LEN: usize = NONCE_SIZE + AEAD_TAG_SIZE;

/// Argon2id 派生参数。**所有字段公开**：测试可自由构造低参数（详见 spec/04 § 7）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2idParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u8,
    pub key_len: u32,
}

impl Argon2idParams {
    /// 桌面默认参数：64 MiB / 3 iter / 4 lane / 32-byte key。
    pub fn default_desktop() -> Self {
        Self {
            memory_kib: 64 * 1024,
            iterations: 3,
            parallelism: 4,
            key_len: 32,
        }
    }

    /// 拒绝弱参数（与 Go 版本对齐）。
    pub fn validate(&self) -> Result<(), CryptoError> {
        if self.memory_kib < 8 * 1024 {
            return Err(CryptoError::InvalidLength {
                what: "argon2.memory_kib",
                expected: 8 * 1024,
                got: self.memory_kib as usize,
            });
        }
        if self.iterations < 1 {
            return Err(CryptoError::InvalidLength {
                what: "argon2.iterations",
                expected: 1,
                got: 0,
            });
        }
        if self.parallelism < 1 {
            return Err(CryptoError::InvalidLength {
                what: "argon2.parallelism",
                expected: 1,
                got: 0,
            });
        }
        if self.key_len != 32 {
            return Err(CryptoError::InvalidLength {
                what: "argon2.key_len",
                expected: 32,
                got: self.key_len as usize,
            });
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    Internal,
    InvalidLength {
        what: &'static str,
        expected: usize,
        got: usize,
    },
    /// 所有 AEAD / KDF / 参数失败统一映射到此（错误模糊化）。
    AuthFailed,
}

impl core::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CryptoError::Internal => write!(f, "internal crypto error"),
            CryptoError::InvalidLength {
                what,
                expected,
                got,
            } => {
                write!(f, "{what}: expected {expected} bytes, got {got}")
            }
            CryptoError::AuthFailed => write!(f, "authentication failed"),
        }
    }
}

// 注：`zpass-crypto` 是 no_std crate，不暴露 `std::error::Error`。
// 上层（vault-service）通过 thiserror 自行实现 std::error::Error。

// ===================== Argon2id =====================

/// 用 password + salt 派生 KEK。
///
/// 失败（含参数非法）一律返回 `AuthFailed`，与上层「主密码错误」错误一致（spec/04 § 5）。
pub fn derive_kek(
    password: &[u8],
    salt: &[u8],
    params: &Argon2idParams,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    params.validate().map_err(|_| CryptoError::AuthFailed)?;
    if salt.len() != SALT_SIZE {
        return Err(CryptoError::InvalidLength {
            what: "salt",
            expected: SALT_SIZE,
            got: salt.len(),
        });
    }
    let p = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism as u32,
        Some(params.key_len as usize),
    )
    .map_err(|_| CryptoError::AuthFailed)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password, salt, out.as_mut_slice())
        .map_err(|_| CryptoError::AuthFailed)?;
    Ok(out)
}

// ===================== Random =====================

/// 从 OS CSPRNG 拿 n 字节。失败返回 `Internal`（绝不回退 PRNG，见 spec/04 § 9）。
///
/// 仅在 feature `os-rng` 启用时存在。嵌入式 / no_std 场景关掉该 feature 后
/// 由调用方提供等价能力（见 `seal_aead_with_nonce`）。
#[cfg(feature = "os-rng")]
pub fn random_bytes(n: usize) -> Result<Vec<u8>, CryptoError> {
    let mut buf = alloc::vec![0u8; n];
    getrandom::getrandom(&mut buf).map_err(|_| CryptoError::Internal)?;
    Ok(buf)
}

/// 32 字节随机数组（避免 heap 分配）。
#[cfg(feature = "os-rng")]
pub fn random_key() -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut buf = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(buf.as_mut_slice()).map_err(|_| CryptoError::Internal)?;
    Ok(buf)
}

// ===================== AEAD =====================

/// 用调用方提供的 nonce 加密。**桌面 / 移动端**通常用 [`seal_aead`]。
///
/// 该函数在 `no_std + alloc` 下始终可用，不依赖 `os-rng` feature。
pub fn seal_aead_with_nonce(
    key: &[u8; 32],
    nonce: &[u8; NONCE_SIZE],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let n = XNonce::from_slice(nonce);
    let ct = cipher
        .encrypt(
            n,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::AuthFailed)?;
    let mut out = Vec::with_capacity(NONCE_SIZE + ct.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// `seal_aead`：输出布局 `[nonce(24) | ciphertext | tag(16)]`。nonce 来自 OS CSPRNG。
#[cfg(feature = "os-rng")]
pub fn seal_aead(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut nonce = [0u8; NONCE_SIZE];
    getrandom::getrandom(&mut nonce).map_err(|_| CryptoError::Internal)?;
    seal_aead_with_nonce(key, &nonce, plaintext, aad)
}

/// `open_aead`：拆 nonce + 校验 + 解。
///
/// 所有失败（截断 / aad 不匹配 / 密文被改 / key 错）统一映射 `AuthFailed`。
pub fn open_aead(
    key: &[u8; 32],
    sealed: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if sealed.len() < AEAD_MIN_SEALED_LEN {
        return Err(CryptoError::AuthFailed);
    }
    let (nonce, ct) = sealed.split_at(NONCE_SIZE);
    let cipher = XChaCha20Poly1305::new(key.into());
    let n = XNonce::from_slice(nonce);
    let pt = cipher
        .decrypt(n, Payload { msg: ct, aad })
        .map_err(|_| CryptoError::AuthFailed)?;
    Ok(Zeroizing::new(pt))
}

// ===================== 内部测试辅助（仅 cfg(test) 暴露）=====================

/// 测试专用：低强度 Argon2id 参数。**绝不**在生产路径调用。
/// 参考 spec/04 § 7。
#[cfg(test)]
pub fn test_params_unsafe_do_not_use_in_production() -> Argon2idParams {
    Argon2idParams {
        memory_kib: 8 * 1024,
        iterations: 1,
        parallelism: 1,
        key_len: 32,
    }
}

/// 显式抹零 helper，用于 `Vec<u8>` / `[u8; N]`。
pub fn zeroize_buf<T: Zeroize>(buf: &mut T) {
    buf.zeroize();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        // 任意非零字节即可。
        [1u8; 32]
    }

    #[test]
    fn argon2id_params_default_validates() {
        Argon2idParams::default_desktop().validate().unwrap();
    }

    #[test]
    fn argon2id_params_validate_rejects_weak() {
        let mut p = Argon2idParams::default_desktop();
        p.memory_kib = 4 * 1024;
        assert!(p.validate().is_err());

        let mut p = Argon2idParams::default_desktop();
        p.iterations = 0;
        assert!(p.validate().is_err());

        let mut p = Argon2idParams::default_desktop();
        p.parallelism = 0;
        assert!(p.validate().is_err());

        let mut p = Argon2idParams::default_desktop();
        p.key_len = 16;
        assert!(p.validate().is_err());
    }

    #[test]
    fn argon2id_known_vector_smoke() {
        // 不是 RFC 9106 全向量，但验证 deterministic：同 input 同 output。
        let pw = b"correct horse battery staple";
        let salt = [7u8; SALT_SIZE];
        let p = test_params_unsafe_do_not_use_in_production();
        let a = derive_kek(pw, &salt, &p).unwrap();
        let b = derive_kek(pw, &salt, &p).unwrap();
        assert_eq!(a.as_slice(), b.as_slice());
        // 改变 password 应得到不同 key
        let c = derive_kek(b"another", &salt, &p).unwrap();
        assert_ne!(a.as_slice(), c.as_slice());
    }

    #[test]
    fn derive_kek_rejects_short_salt() {
        let p = test_params_unsafe_do_not_use_in_production();
        let salt = [0u8; SALT_SIZE - 1];
        let err = derive_kek(b"pw", &salt, &p).unwrap_err();
        assert!(matches!(err, CryptoError::InvalidLength { .. }));
    }

    #[test]
    fn aead_round_trip() {
        let key = test_key();
        let pt = b"hello aead";
        let aad = b"some-aad";
        let sealed = seal_aead(&key, pt, aad).unwrap();
        // 长度 = nonce + pt + tag
        assert_eq!(sealed.len(), NONCE_SIZE + pt.len() + AEAD_TAG_SIZE);
        let opened = open_aead(&key, &sealed, aad).unwrap();
        assert_eq!(opened.as_slice(), pt);
    }

    #[test]
    fn aead_aad_mismatch_fails() {
        let key = test_key();
        let sealed = seal_aead(&key, b"x", b"aad_a").unwrap();
        assert_eq!(
            open_aead(&key, &sealed, b"aad_b").unwrap_err(),
            CryptoError::AuthFailed
        );
    }

    #[test]
    fn aead_tampered_ciphertext_fails() {
        let key = test_key();
        let mut sealed = seal_aead(&key, b"payload", b"aad").unwrap();
        // 翻转最后一字节（tag 或 ct 之一）
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert_eq!(
            open_aead(&key, &sealed, b"aad").unwrap_err(),
            CryptoError::AuthFailed
        );
    }

    #[test]
    fn aead_truncated_fails() {
        let key = test_key();
        // 短到没有 nonce
        let sealed = alloc::vec![0u8; NONCE_SIZE - 1];
        assert_eq!(
            open_aead(&key, &sealed, b"").unwrap_err(),
            CryptoError::AuthFailed
        );
        // 短到没有 tag
        let sealed = alloc::vec![0u8; AEAD_MIN_SEALED_LEN - 1];
        assert_eq!(
            open_aead(&key, &sealed, b"").unwrap_err(),
            CryptoError::AuthFailed
        );
    }

    #[test]
    fn aead_wrong_key_fails() {
        let key1 = [1u8; 32];
        let key2 = [2u8; 32];
        let sealed = seal_aead(&key1, b"data", b"").unwrap();
        assert_eq!(
            open_aead(&key2, &sealed, b"").unwrap_err(),
            CryptoError::AuthFailed
        );
    }

    #[test]
    fn random_bytes_distinct() {
        let mut seen = alloc::collections::BTreeSet::new();
        for _ in 0..32 {
            let v = random_bytes(16).unwrap();
            assert!(seen.insert(v));
        }
    }

    #[test]
    fn random_key_returns_32_bytes() {
        let k = random_key().unwrap();
        assert_eq!(k.len(), 32);
    }

    #[test]
    fn aead_empty_plaintext() {
        let key = test_key();
        let sealed = seal_aead(&key, b"", b"aad").unwrap();
        assert_eq!(sealed.len(), NONCE_SIZE + AEAD_TAG_SIZE);
        let opened = open_aead(&key, &sealed, b"aad").unwrap();
        assert!(opened.is_empty());
    }
}
