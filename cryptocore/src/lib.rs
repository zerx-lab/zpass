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

// M1 新增原语（非 SRP）：HKDF / X25519 sealed-box / 2SKD / 信封常量。
pub mod envelope;
pub mod hkdf;
pub mod kdf2;
pub mod keyset;

// Ms 里程碑：SRP-6a（RFC 5054 §2.5-2.6）认证原语。
pub mod srp;

// WASM 第五端薄绑定；用 cfg 隔离，不进 default / 移动端编译图。
#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(feature = "android")]
pub mod android;

#[cfg(feature = "harmony")]
pub mod harmony;

// 局域网同步服务端传输层；JNI（android）与 napi（harmony）两座桥共用。
#[cfg(feature = "lan-server")]
mod lan_transport;

// LAN 同步协议模块。依赖 spake2 / ciborium / std::net（lan_transport），
// 这些符号在 wasm32 上不可编译；Web Vault 第五端只走云端 changes API，
// 不需要 LAN 同步，故整模块在 wasm32 目标上排除（D5 / E7 wasm32 编译门）。
#[cfg(not(target_arch = "wasm32"))]
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

/* ----------------------------------------------------------------------------
 * Sync 专用原语
 *
 * phone/desktop LAN 同步协议（PSK 派生 + 自定义 nonce）需要：
 *   1. Argon2id 支持任意长度 salt（sync 用 64-byte salt = baseSalt||sid||cn||sn）
 *   2. XChaCha20-Poly1305 接受外部提供的 24-byte nonce（协议 nonce 含方向 + 计数器）
 *
 * 这些 API 与现有 `derive_kek` / `seal_aead` / `open_aead` 并存；vault 路径继续
 * 走严格校验版本，sync 路径走宽松版本。
 * -------------------------------------------------------------------------- */

/// Argon2id 通用派生（与 sync-protocol 的 deriveSyncSessionKey 对齐）
///
/// 与 [`derive_kek`] 的区别：
///   - salt 长度不限（≥ 1 字节即可）
///   - keyLen 不限制为 32
///   - 仍保留下界校验（mem ≥ 8 MiB / iter ≥ 1 / par ≥ 1）
///
/// 不替代 [`derive_kek`]：vault 主密钥派生仍走严格 32-byte salt 版本，
/// 保证已知向量不分叉。
pub fn argon2id_raw(
    password: &[u8],
    salt: &[u8],
    mem_kib: u32,
    iter: u32,
    par: u32,
    key_len: u32,
) -> Result<Vec<u8>> {
    if salt.is_empty() {
        return Err(Error::SaltLength { got: 0 });
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
    if key_len == 0 {
        return Err(Error::WrongKeyLen { got: 0, want: 32 });
    }
    if par > 0xff {
        return Err(Error::ParallelismOverflow { got: par });
    }
    let params = Params::new(mem_kib, iter, par, Some(key_len as usize)).map_err(Error::Argon2)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = vec![0u8; key_len as usize];
    argon2
        .hash_password_into(password, salt, &mut out)
        .map_err(Error::Argon2)?;
    Ok(out)
}

/// XChaCha20-Poly1305 加密 —— 调用方提供 nonce
///
/// 与 [`seal_aead`] 的区别：nonce 由调用方传入（不嵌入返回值），输出仅为 ct ‖ tag。
/// sync-protocol 用这个把 [dir][rand][counter] 编排好的 24-byte nonce 喂进来。
pub fn seal_aead_with_nonce(
    key: &[u8],
    plaintext: &[u8],
    aad: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>> {
    if key.len() != KEY_SIZE {
        return Err(Error::KeyLength { got: key.len() });
    }
    if nonce.len() != NONCE_SIZE {
        return Err(Error::SealedTooShort { got: nonce.len() });
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let xn = XNonce::from_slice(nonce);
    cipher
        .encrypt(
            xn,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::AeadAuthentication)
}

/// 解密 [`seal_aead_with_nonce`] 输出 —— 调用方提供 nonce
pub fn open_aead_with_nonce(
    key: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>> {
    if key.len() != KEY_SIZE {
        return Err(Error::KeyLength { got: key.len() });
    }
    if nonce.len() != NONCE_SIZE {
        return Err(Error::SealedTooShort { got: nonce.len() });
    }
    if ciphertext.len() < TAG_SIZE {
        return Err(Error::SealedTooShort {
            got: ciphertext.len(),
        });
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let xn = XNonce::from_slice(nonce);
    cipher
        .decrypt(
            xn,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
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

    /// LAN 同步原生路径锚点：`argon2id_raw` 必须与已跟 Go/@noble 对齐的
    /// `derive_kek` 在相同输入下字节级一致（两者共用 Argon2id/V0x13 配置）。
    /// 这间接保证 phone 原生 `nativeArgon2idRaw` 与 JS 兜底 / desktop 不分叉。
    #[test]
    fn argon2id_raw_matches_kek_for_same_input() {
        let salt = vec![0xABu8; SALT_SIZE];
        let kek = derive_kek("correct horse battery staple", &salt, 8 * 1024, 2, 2, 32).unwrap();
        let raw = argon2id_raw(
            "correct horse battery staple".as_bytes(),
            &salt,
            8 * 1024,
            2,
            2,
            32,
        )
        .unwrap();
        assert_eq!(raw, kek, "argon2id_raw 与 derive_kek 派生分叉");
    }

    /// `argon2id_raw` 接受 64 字节同步拼接 salt（derive_kek 会因 != 32 拒绝），
    /// 且对短于 1 字节的空 salt 报错。
    #[test]
    fn argon2id_raw_accepts_sync_salt() {
        let salt64: Vec<u8> = (0u8..64).collect();
        let k = argon2id_raw("123456".as_bytes(), &salt64, 8 * 1024, 2, 1, 32).unwrap();
        assert_eq!(k.len(), 32);
        assert!(matches!(
            argon2id_raw("123456".as_bytes(), &[], 8 * 1024, 2, 1, 32),
            Err(Error::SaltLength { got: 0 })
        ));
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

    // ------------------------------------------------------------------
    // M1 新增原语 KAT 向量（hkdf / keyset / 2skd / envelope）
    // ------------------------------------------------------------------

    use crate::envelope;
    use crate::hkdf::hkdf_sha256;
    use crate::kdf2::{Argon2Params, derive_auk, derive_srp_x};
    use crate::keyset::{keyset_generate, open_with_privkey, seal_to_pubkey};

    /// RFC 5869 附录 A.1（Test Case 1，SHA-256）逐字节匹配。
    #[test]
    fn hkdf_sha256_rfc5869_vector_a1() {
        let ikm = hex::decode("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b").unwrap();
        let salt = hex::decode("000102030405060708090a0b0c").unwrap();
        let info = hex::decode("f0f1f2f3f4f5f6f7f8f9").unwrap();
        let okm = hkdf_sha256(&ikm, &salt, &info, 42).unwrap();
        let want = hex::decode(
            "3cb25f25faacd57a90434f64d0362f2a\
             2d2d0a90cf1a5a4c5db02d56ecc4c5bf\
             34007208d5b887185865",
        )
        .unwrap();
        assert_eq!(okm, want, "HKDF-SHA256 与 RFC 5869 A.1 分叉");
    }

    #[test]
    fn hkdf_sha256_rejects_bad_len() {
        assert!(matches!(
            hkdf_sha256(b"ikm", b"salt", b"info", 0),
            Err(Error::InvalidRandomCount)
        ));
        // 255*32 = 8160 是上界，+1 必须返错。
        assert!(matches!(
            hkdf_sha256(b"ikm", b"salt", b"info", 255 * 32 + 1),
            Err(Error::InvalidRandomCount)
        ));
    }

    /// X25519 sealed-box：seal_to_pubkey -> open_with_privkey 还原明文。
    #[test]
    fn x25519_seal_open_roundtrip() {
        let (pub32, priv32) = keyset_generate().unwrap();
        let pt = b"the vault key bytes (32) or any payload";
        let sealed = seal_to_pubkey(&pub32, pt).unwrap();
        // 信封 = eph_pub(32) || nonce(24) || ct || tag(16)。
        assert_eq!(sealed.len(), 32 + NONCE_SIZE + pt.len() + TAG_SIZE);
        let out = open_with_privkey(&priv32, &sealed).unwrap();
        assert_eq!(out, pt);
    }

    #[test]
    fn x25519_open_rejects_wrong_key() {
        let (pub_a, _priv_a) = keyset_generate().unwrap();
        let (_pub_b, priv_b) = keyset_generate().unwrap();
        let sealed = seal_to_pubkey(&pub_a, b"secret").unwrap();
        assert!(matches!(
            open_with_privkey(&priv_b, &sealed),
            Err(Error::AeadAuthentication)
        ));
    }

    #[test]
    fn x25519_rejects_bad_lengths() {
        assert!(matches!(
            seal_to_pubkey(&[0u8; 31], b"x"),
            Err(Error::KeyLength { .. })
        ));
        assert!(matches!(
            open_with_privkey(&[0u8; 31], &[0u8; 80]),
            Err(Error::KeyLength { .. })
        ));
        assert!(matches!(
            open_with_privkey(&[0u8; 32], b"short"),
            Err(Error::SealedTooShort { .. })
        ));
    }

    /// 固定 2SKD 输入（不取随机），可逐字节锁向量。
    const SK_RAW: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23"; // 26 字符（zpass SK raw 长度）
    const ACCOUNT_ID: &[u8] = b"acct-000001";
    // 测试用低成本 Argon2id 参数（仍 >= 8 MiB 下限）。
    fn test_params() -> Argon2Params {
        Argon2Params::new(8 * 1024, 2, 1)
    }

    /// derive_auk 锁定向量：固定输入 -> 固定 32B 输出。
    #[test]
    fn derive_auk_known_vector() {
        let salt_enc = [0x11u8; SALT_SIZE];
        let got = derive_auk(
            "  correct horse battery staple  ",
            &salt_enc,
            SK_RAW,
            ACCOUNT_ID,
            test_params(),
        )
        .unwrap();
        // 重锁（info 域分离）：HKDF info 由写死的 INFO_SK_V1 改为 INFO_AUK_V1，
        // mix 字节随之变化，故此向量相对旧值已重新锁定。
        let want =
            hex::decode("2c28dc7944fa1b1d4ec80dbc015593b1d36104d75e193ae59af4634c1f518a1d")
                .unwrap();
        assert_eq!(got.to_vec(), want, "derive_auk 字节分叉");
    }

    /// derive_srp_x 锁定向量：只断言 32B 输出（字节->bignum 是 Ms-T1.c）。
    #[test]
    fn derive_srp_x_known_vector() {
        let salt_auth = [0x22u8; SALT_SIZE];
        let got = derive_srp_x(
            "  correct horse battery staple  ",
            &salt_auth,
            SK_RAW,
            ACCOUNT_ID,
            test_params(),
        )
        .unwrap();
        assert_eq!(got.len(), 32);
        // 重锁（info 域分离）：HKDF info 由写死的 INFO_SK_V1 改为 INFO_SRPX_V1，
        // mix 字节随之变化，故此向量相对旧值已重新锁定。
        let want =
            hex::decode("7ab0f4188c0bf29b3000010ba19ed5085f331986655263a22aefe2af75a19430")
                .unwrap();
        assert_eq!(got.to_vec(), want, "derive_srp_x 字节分叉");
    }

    /// 同 pw/SK/account_id，仅 salt_enc != salt_auth -> AUK != SRP-x（二者独立）。
    #[test]
    fn auk_perp_srpx() {
        let salt_enc = [0x11u8; SALT_SIZE];
        let salt_auth = [0x22u8; SALT_SIZE];
        let auk = derive_auk("pw same", &salt_enc, SK_RAW, ACCOUNT_ID, test_params()).unwrap();
        let srpx = derive_srp_x("pw same", &salt_auth, SK_RAW, ACCOUNT_ID, test_params()).unwrap();
        assert_ne!(auk, srpx, "AUK 与 SRP-x 未独立");
    }

    /// 信封 alg_id / format_version / 域分离常量锁定，防止被随意改动。
    #[test]
    fn envelope_constants_locked() {
        assert_eq!(envelope::FORMAT_VERSION_V1, 0x01);
        assert_eq!(envelope::ALG_XCHACHA20POLY1305, 0x01);
        assert_eq!(envelope::ALG_ARGON2ID_WRAP, 0x02);
        assert_eq!(envelope::ALG_X25519_SEAL, 0x10);
        assert_eq!(envelope::ALG_SRP_VERIFIER, 0x20);
        assert_eq!(envelope::INFO_SK_V1, b"zpass-sk-v1");
        assert_eq!(envelope::INFO_AUK_V1, b"zpass-auk-v1");
        assert_eq!(envelope::INFO_SRPX_V1, b"zpass-srpx-v1");
        assert_eq!(envelope::INFO_KEYSET_PRIV_V1, b"zpass-keyset-priv-v1");
        assert_eq!(envelope::INFO_VAULTKEY_V1, b"zpass-vaultkey-v1");
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

    // ------------------------------------------------------------------
    // Ms 里程碑：SRP-6a（RFC 5054 §2.5-2.6）KAT 向量
    //
    // 群（T1.a）: RFC 5054 附录 A 2048-bit safe prime, g=2。
    // x 布局（T1.c）: derive_srp_x 的 32B 输出按大端解释为 bignum, 不 mod N。
    // 哈希: SHA-256；K = H(S) = SHA256(PAD(S))。
    // ------------------------------------------------------------------

    use crate::srp;
    use sha2::{Digest, Sha256};

    /// derive_srp_x M1 向量复用：固定 x -> 固定 v / K / M1 / M2 的字节锚点。
    const SRP_X_HEX: &str = "15f605aa05dfd55b199de8403fce5a7db6ded022bb37c373e490801e3a5d8ae5";

    /// T1.a：锁定 SRP 群 N 的字节（SHA-256 + 长度 + 首尾字节）与 g。
    ///
    /// 任何换群/改字节都会触发断言失败。拍板群：RFC 5054 附录 A 2048-bit, g=2。
    #[test]
    fn srp_group_params_locked() {
        // srp_register 内部用 N_BYTES；这里通过 register 一个已知 x 间接锁 N，
        // 并直接断言群常量的字节指纹。
        assert_eq!(srp::N_BYTE_LEN, 256, "SRP 群字节长度应为 256（2048-bit）");

        // verifier v = g^x mod N，PAD 到 256 字节；其字节由 N/g/x 共同决定。
        let x = hex::decode(SRP_X_HEX).unwrap();
        let salt = [0x22u8; SALT_SIZE];
        let reg = srp::srp_register(&x, &salt).unwrap();
        // N 的 SHA-256 指纹通过 v 的 SHA-256 间接锁定（v 依赖 N/g/x 全字节）。
        let v_fp = Sha256::digest(&reg.verifier);
        assert_eq!(
            hex::encode(v_fp),
            "9699a2f3474fe36316948999221a2a383b014a735e431910412cfa0aa1294b39",
            "SRP 群参数或 x 布局分叉（v 指纹变化）"
        );
        assert_eq!(reg.verifier.len(), 256, "verifier 应 PAD 到 256 字节");
    }

    /// srp_register_verifier_vector：固定 x + 拍板群 -> 锁定的 v 字节逐字节匹配。
    #[test]
    fn srp_register_verifier_vector() {
        let x = hex::decode(SRP_X_HEX).unwrap();
        let salt = [0x22u8; SALT_SIZE];
        let reg = srp::srp_register(&x, &salt).unwrap();
        let want_v = "013aff033e37dde2c743b8924c440ec2e595768a9db0ff5fd96b8f797e0eeb43\
                      1d68e9aafaf4808975391f16f6249815bd5036143ffcb1c1f58a8aaf3237bcf9\
                      318d09800467bc86ede6e47df9929723d126cf097c4c852806db7791ffef3537\
                      65c1dadf6e67e0d03b0498956ae79473c436b70434ee4b4607c5f82fbe7df1e9\
                      d24c3bf9a93b1b6867d32a02bbfb9546322ab94653e32580ac965e7b35740c3b\
                      0a2dd5e7435f947c362a5934f065ad8d7e092b1828b778147255bda5b9a7d0dc\
                      dbe50be82c88f4d87b971c08240096e2845b972a69a192904302176a841efafd\
                      25ec62c6c77e765284bae10d4ff054d5298e1efb9e89f8b684031c3b00888273";
        assert_eq!(hex::encode(&reg.verifier), want_v, "SRP verifier 字节分叉");
        assert_eq!(reg.salt, salt.to_vec());
    }

    /// srp_full_handshake_roundtrip：纯 Rust 跑两方，断言 S/K/M1/M2 全相等，
    /// 服务端验 M1 通过、客户端验 M2 通过。用随机 ephemeral（协议正确性）。
    #[test]
    fn srp_full_handshake_roundtrip() {
        let x = hex::decode(SRP_X_HEX).unwrap();
        let salt = [0x22u8; SALT_SIZE];
        let identity = b"alice@example.com";
        let reg = srp::srp_register(&x, &salt).unwrap();

        let client = srp::srp_client_start().unwrap();
        let server = srp::srp_server_start(&reg.verifier).unwrap();

        let cproof = srp::srp_client_finish(
            client.secret_a(),
            &client.a_pub,
            &server.b_pub,
            &x,
            &salt,
            identity,
        )
        .unwrap();

        let sproof = srp::srp_server_finish(
            server.secret_b(),
            &client.a_pub,
            &server.b_pub,
            &reg.verifier,
            &cproof.m1,
            &salt,
            identity,
        )
        .unwrap();

        // K 两侧相等（S 相等的可观测证据）。
        assert_eq!(
            cproof.session_key, sproof.session_key,
            "客户端/服务端 K = H(S) 不相等"
        );
        // 服务端验 M1 通过。
        assert!(sproof.verified, "服务端拒绝了正确的 M1");
        // 客户端验 M2 通过。
        assert!(
            cproof.verify_server(&client.a_pub, &sproof.m2),
            "客户端拒绝了服务端 M2"
        );
    }

    /// 固定 ephemeral 的握手 KAT：锁定 K / M1 / M2 的精确字节（参考向量来自
    /// Python 实现，与本模块逐字节一致）。a = 0x33*32, b = 0x44*32。
    #[test]
    fn srp_handshake_fixed_ephemeral_vector() {
        let x = hex::decode(SRP_X_HEX).unwrap();
        let salt = [0x22u8; SALT_SIZE];
        let identity = b"alice@example.com";
        let reg = srp::srp_register(&x, &salt).unwrap();

        let a_secret = [0x33u8; 32];
        let b_secret = [0x44u8; 32];

        // 用固定 ephemeral 重算 A / B（与 srp_*_start 内部公式一致）。
        let a_pub = srp::derive_a_pub_for_test(&a_secret);
        let b_pub = srp::derive_b_pub_for_test(&b_secret, &reg.verifier);

        let cproof =
            srp::srp_client_finish(&a_secret, &a_pub, &b_pub, &x, &salt, identity).unwrap();
        let sproof = srp::srp_server_finish(
            &b_secret, &a_pub, &b_pub, &reg.verifier, &cproof.m1, &salt, identity,
        )
        .unwrap();

        assert_eq!(
            hex::encode(cproof.session_key),
            "bd0474804e7cd08e89e4d3b78b5690994245baa49ed21592799a30c3a4ac27ec",
            "K 字节分叉"
        );
        assert_eq!(
            hex::encode(cproof.m1),
            "258c13078a2abe1ed88ae16dca4aa97dd6865836dd6212931853838189c5cf1f",
            "M1 字节分叉"
        );
        assert_eq!(
            hex::encode(sproof.m2),
            "c02a1c775c3c869df96dde8cae360fc59824cbe573b385ff3ad9779c9c6d183d",
            "M2 字节分叉"
        );
        assert!(sproof.verified);
        assert!(cproof.verify_server(&a_pub, &sproof.m2));
    }

    /// 错误密码（错 x）-> 服务端拒 M1（与缺 Secret Key 失败方式不可区分）。
    #[test]
    fn srp_wrong_password_rejected() {
        let x = hex::decode(SRP_X_HEX).unwrap();
        let salt = [0x22u8; SALT_SIZE];
        let identity = b"alice@example.com";
        let reg = srp::srp_register(&x, &salt).unwrap();

        let client = srp::srp_client_start().unwrap();
        let server = srp::srp_server_start(&reg.verifier).unwrap();

        // 客户端用错误的 x（错误密码）算 M1。
        let wrong_x = [0xEEu8; 32];
        let cproof = srp::srp_client_finish(
            client.secret_a(),
            &client.a_pub,
            &server.b_pub,
            &wrong_x,
            &salt,
            identity,
        )
        .unwrap();

        let sproof = srp::srp_server_finish(
            server.secret_b(),
            &client.a_pub,
            &server.b_pub,
            &reg.verifier,
            &cproof.m1,
            &salt,
            identity,
        )
        .unwrap();

        assert!(!sproof.verified, "服务端应拒绝错误密码的 M1");
    }

    /// x 长度非法 -> srp_register 返回 KeyLength 错误（不 panic）。
    #[test]
    fn srp_register_rejects_bad_x_len() {
        assert!(matches!(
            srp::srp_register(&[0u8; 31], &[0u8; SALT_SIZE]),
            Err(Error::KeyLength { .. })
        ));
    }
}
