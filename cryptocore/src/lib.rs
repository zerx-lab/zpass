//! ZPass 跨平台加密原语 —— Rust 实现
//!
//! 同一 vault 文件必须能在 desktop（Go cryptoutil）/ phone（Rust → JNI/NAPI）/
//! extension（@noble JS）之间互相解读，算法、参数、字节布局都需严格对齐。
//!
//! 桥层（Android JNI / HarmonyOS NAPI / iOS Swift）只搬运字节，
//! 不复写校验逻辑。

#![forbid(unsafe_op_in_unsafe_fn)]

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use rand_core::{OsRng, RngCore};

#[cfg(feature = "android")]
pub mod android;

#[cfg(feature = "harmony")]
pub mod harmony;

pub mod sync;

/// XChaCha20-Poly1305 密钥长度（与 Go chacha20poly1305.KeySize 对齐）
pub const KEY_SIZE: usize = 32;
/// XChaCha20-Poly1305 nonce 长度（extended nonce；与 Go chacha20poly1305.NonceSizeX 对齐）
pub const NONCE_SIZE: usize = 24;
/// Poly1305 tag 长度
pub const TAG_SIZE: usize = 16;
/// Argon2id 盐长度
pub const SALT_SIZE: usize = 32;

/// Argon2id 参数下界 —— 与 desktop Argon2idParams.Validate 对齐
const MIN_MEMORY_KIB: u32 = 8 * 1024;
const MIN_ITERATIONS: u32 = 1;
const MIN_PARALLELISM: u32 = 1;

/// 所有公开 API 的错误类型
///
/// AEAD 认证失败必须返回模糊错误，避免泄露 "密码错 / 数据损坏 / aad 不匹配"
/// 的差异（侧信道）—— 见 [`Error::AeadAuthentication`]。
#[derive(Debug)]
pub enum Error {
    EmptyPassword,
    SaltLength { got: usize },
    MemoryTooLow { got: u32, min: u32 },
    IterationsTooLow { got: u32 },
    ParallelismTooLow { got: u32 },
    ParallelismOverflow { got: u32 },
    WrongKeyLen { got: u32, want: u32 },
    KeyLength { got: usize },
    SealedTooShort { got: usize },
    AeadAuthentication,
    Argon2(argon2::Error),
    InvalidRandomCount,
    Rng(String),
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Error::EmptyPassword => write!(f, "master password cannot be empty"),
            Error::SaltLength { got } => {
                write!(f, "salt length must be {SALT_SIZE}, got {got}")
            }
            Error::MemoryTooLow { got, min } => {
                write!(f, "argon2id memory too low: {got} KiB (min {min})")
            }
            Error::IterationsTooLow { got } => {
                write!(f, "argon2id iterations too low: {got}")
            }
            Error::ParallelismTooLow { got } => {
                write!(f, "argon2id parallelism too low: {got}")
            }
            Error::ParallelismOverflow { got } => {
                write!(f, "argon2id parallelism overflow: {got}")
            }
            Error::WrongKeyLen { got, want } => {
                write!(f, "argon2id keyLen must be {want}, got {got}")
            }
            Error::KeyLength { got } => {
                write!(f, "aead key length must be {KEY_SIZE}, got {got}")
            }
            Error::SealedTooShort { got } => {
                write!(f, "aead ciphertext too short: {got} bytes")
            }
            Error::AeadAuthentication => write!(f, "aead authentication failed"),
            Error::Argon2(e) => write!(f, "argon2id: {e}"),
            Error::InvalidRandomCount => write!(f, "invalid random byte count"),
            Error::Rng(e) => write!(f, "os rng failed: {e}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = core::result::Result<T, Error>;

/// Argon2id KEK 派生
///
/// 校验顺序与 Go `DeriveKEK` 一致（影响用户看到的错误信息）：
/// empty pw → salt → mem → iter → par → keyLen → par overflow
pub fn derive_kek(
    password: &str,
    salt: &[u8],
    mem_kib: u32,
    iter: u32,
    par: u32,
    key_len: u32,
) -> Result<Vec<u8>> {
    if password.is_empty() {
        return Err(Error::EmptyPassword);
    }
    if salt.len() != SALT_SIZE {
        return Err(Error::SaltLength { got: salt.len() });
    }
    if mem_kib < MIN_MEMORY_KIB {
        return Err(Error::MemoryTooLow {
            got: mem_kib,
            min: MIN_MEMORY_KIB,
        });
    }
    if iter < MIN_ITERATIONS {
        return Err(Error::IterationsTooLow { got: iter });
    }
    if par < MIN_PARALLELISM {
        return Err(Error::ParallelismTooLow { got: par });
    }
    if key_len != KEY_SIZE as u32 {
        return Err(Error::WrongKeyLen {
            got: key_len,
            want: KEY_SIZE as u32,
        });
    }
    if par > 0xff {
        return Err(Error::ParallelismOverflow { got: par });
    }

    let params = Params::new(mem_kib, iter, par, Some(key_len as usize)).map_err(Error::Argon2)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = vec![0u8; key_len as usize];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(Error::Argon2)?;
    Ok(out)
}

/// XChaCha20-Poly1305 加密
///
/// 输出布局：`[24-byte nonce][ciphertext][16-byte tag]`，与 Go SealAEAD 一致。
/// nonce 内部由 [`random_bytes`] 生成。
pub fn seal_aead(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if key.len() != KEY_SIZE {
        return Err(Error::KeyLength { got: key.len() });
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce_bytes = random_bytes(NONCE_SIZE)?;
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::AeadAuthentication)?;

    let mut out = Vec::with_capacity(NONCE_SIZE + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 解密 [`seal_aead`] 的输出
///
/// 认证失败统一返回 [`Error::AeadAuthentication`]，不区分 "密码错 / 数据损坏 / aad 不匹配"
pub fn open_aead(key: &[u8], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if key.len() != KEY_SIZE {
        return Err(Error::KeyLength { got: key.len() });
    }
    if sealed.len() < NONCE_SIZE + TAG_SIZE {
        return Err(Error::SealedTooShort { got: sealed.len() });
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(&sealed[..NONCE_SIZE]);
    let ct = &sealed[NONCE_SIZE..];
    cipher
        .decrypt(nonce, Payload { msg: ct, aad })
        .map_err(|_| Error::AeadAuthentication)
}

/// 操作系统 CSPRNG；失败直接返错，绝不回退弱随机
pub fn random_bytes(n: usize) -> Result<Vec<u8>> {
    if n == 0 {
        return Err(Error::InvalidRandomCount);
    }
    let mut buf = vec![0u8; n];
    OsRng
        .try_fill_bytes(&mut buf)
        .map_err(|e| Error::Rng(e.to_string()))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_bytes_unique_and_correct_length() {
        let a = random_bytes(32).unwrap();
        let b = random_bytes(32).unwrap();
        assert_eq!(a.len(), 32);
        assert_eq!(b.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn random_bytes_rejects_zero() {
        assert!(matches!(random_bytes(0), Err(Error::InvalidRandomCount)));
    }

    #[test]
    fn derive_kek_deterministic() {
        let salt: Vec<u8> = (0u8..32).collect();
        let k1 = derive_kek("hunter22hunter22", &salt, 8 * 1024, 1, 1, 32).unwrap();
        let k2 = derive_kek("hunter22hunter22", &salt, 8 * 1024, 1, 1, 32).unwrap();
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 32);
    }

    /// 锁定 Argon2id 已知向量 —— 任何参数/实现回归都会触发断言失败。
    /// 向量与 desktop (Go) / extension (@noble) 端必须保持字节级一致。
    #[test]
    fn derive_kek_known_vector_is_stable() {
        let salt = vec![0xABu8; SALT_SIZE];
        let got = derive_kek("correct horse battery staple", &salt, 8 * 1024, 2, 2, 32).unwrap();
        let want = hex::decode("b95794ea37af333fbb49d97b0a9d52b42c77e413459c218083ac260daa41623a")
            .unwrap();
        assert_eq!(got, want, "argon2id 字节级与 Go 版分叉");
    }

    #[test]
    fn derive_kek_validation_order() {
        let salt = vec![0u8; SALT_SIZE];
        // (case_name, expected variant matcher)
        assert!(matches!(
            derive_kek("", &salt, 8 * 1024, 1, 1, 32),
            Err(Error::EmptyPassword)
        ));
        assert!(matches!(
            derive_kek("pw12345678", &salt[..16], 8 * 1024, 1, 1, 32),
            Err(Error::SaltLength { .. })
        ));
        assert!(matches!(
            derive_kek("pw12345678", &salt, 1024, 1, 1, 32),
            Err(Error::MemoryTooLow { .. })
        ));
        assert!(matches!(
            derive_kek("pw12345678", &salt, 8 * 1024, 0, 1, 32),
            Err(Error::IterationsTooLow { .. })
        ));
        assert!(matches!(
            derive_kek("pw12345678", &salt, 8 * 1024, 1, 0, 32),
            Err(Error::ParallelismTooLow { .. })
        ));
        assert!(matches!(
            derive_kek("pw12345678", &salt, 8 * 1024, 1, 1, 16),
            Err(Error::WrongKeyLen { .. })
        ));
        assert!(matches!(
            derive_kek("pw12345678", &salt, 8 * 1024, 1, 256, 32),
            Err(Error::ParallelismOverflow { .. })
        ));
    }

    #[test]
    fn seal_open_round_trip() {
        let key = random_bytes(KEY_SIZE).unwrap();
        let pt = br#"{"id":"abc","name":"github","password":"s3cr3t"}"#;
        let aad = b"abc";
        let sealed = seal_aead(&key, pt, aad).unwrap();
        assert_eq!(sealed.len(), NONCE_SIZE + pt.len() + TAG_SIZE);
        let out = open_aead(&key, &sealed, aad).unwrap();
        assert_eq!(out, pt);
    }

    #[test]
    fn open_rejects_wrong_aad() {
        let key = random_bytes(KEY_SIZE).unwrap();
        let sealed = seal_aead(&key, b"hello world", b"item-A").unwrap();
        assert!(matches!(
            open_aead(&key, &sealed, b"item-B"),
            Err(Error::AeadAuthentication)
        ));
    }

    #[test]
    fn open_rejects_tampered() {
        let key = random_bytes(KEY_SIZE).unwrap();
        let mut sealed = seal_aead(&key, b"payload", b"aad").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(matches!(
            open_aead(&key, &sealed, b"aad"),
            Err(Error::AeadAuthentication)
        ));
    }

    #[test]
    fn open_rejects_wrong_key() {
        let k1 = random_bytes(KEY_SIZE).unwrap();
        let k2 = random_bytes(KEY_SIZE).unwrap();
        let sealed = seal_aead(&k1, b"payload", b"aad").unwrap();
        assert!(matches!(
            open_aead(&k2, &sealed, b"aad"),
            Err(Error::AeadAuthentication)
        ));
    }

    #[test]
    fn key_size_validation() {
        let bad = vec![0u8; KEY_SIZE - 1];
        assert!(matches!(
            seal_aead(&bad, b"x", b""),
            Err(Error::KeyLength { .. })
        ));
        assert!(matches!(
            open_aead(&bad, &[0u8; NONCE_SIZE + TAG_SIZE], b""),
            Err(Error::KeyLength { .. })
        ));
    }

    #[test]
    fn sealed_too_short() {
        let key = random_bytes(KEY_SIZE).unwrap();
        assert!(matches!(
            open_aead(&key, b"too short", b""),
            Err(Error::SealedTooShort { .. })
        ));
    }

    /// 模拟 vault unlock 完整路径：DeriveKEK → unwrap DEK → open verifier
    #[test]
    fn verifier_flow() {
        const AAD_DEK: &[u8] = b"zpass:dek";
        const AAD_VERIFIER: &[u8] = b"zpass:verifier";
        const VERIFIER_PT: &[u8] = b"zpass-vault-verifier-v1";

        let salt = random_bytes(SALT_SIZE).unwrap();
        let dek = random_bytes(KEY_SIZE).unwrap();
        let kek = derive_kek("MyMasterPassword!", &salt, 8 * 1024, 1, 1, 32).unwrap();
        let wrapped_dek = seal_aead(&kek, &dek, AAD_DEK).unwrap();
        let verifier = seal_aead(&dek, VERIFIER_PT, AAD_VERIFIER).unwrap();

        let kek2 = derive_kek("MyMasterPassword!", &salt, 8 * 1024, 1, 1, 32).unwrap();
        let dek2 = open_aead(&kek2, &wrapped_dek, AAD_DEK).unwrap();
        assert_eq!(dek, dek2);
        let plain = open_aead(&dek2, &verifier, AAD_VERIFIER).unwrap();
        assert_eq!(plain, VERIFIER_PT);

        let wrong_kek = derive_kek("wrong", &salt, 8 * 1024, 1, 1, 32).unwrap();
        assert!(matches!(
            open_aead(&wrong_kek, &wrapped_dek, AAD_DEK),
            Err(Error::AeadAuthentication)
        ));
    }
}
