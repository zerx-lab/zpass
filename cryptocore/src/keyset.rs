//! 账户非对称 keyset（X25519）+ sealed-box 包裹（档案 §2.2 / §2.6-2）
//!
//! 选型裁决（档案 冲突#2）：用 X25519 而非 RSA-2048。绿地无 legacy；公钥 32B，
//! 密文小、常数时间；四端实现成熟（x25519-dalek / @noble/curves / Go
//! curve25519 / libsodium）。
//!
//! sealed-box 信封布局（与 envelope::ALG_X25519_SEAL 对应）:
//!   [32B eph_pub] || seal_aead(sym_key, plaintext, aad=INFO_VAULTKEY_V1)
//!
//! 对称密钥派生：
//!   shared = X25519(eph_priv, recipient_pub)            // 32B ECDH 共享秘密
//!   sym    = hkdf_sha256(ikm=shared, salt=eph_pub||recipient_pub,
//!                        info="zpass-vaultkey-v1", 32)
//! 把 eph_pub||recipient_pub 作为 HKDF salt 是本实现的自定义决策（见下注），
//! 起到把派生密钥绑定到具体收发双方公钥的作用，被 roundtrip 向量覆盖。

// Rust guideline compliant 2026-02-21

use crate::envelope::INFO_VAULTKEY_V1;
use crate::hkdf::hkdf_sha256;
use crate::{Error, KEY_SIZE, NONCE_SIZE, Result, TAG_SIZE, open_aead, seal_aead};
use rand_core::{OsRng, RngCore};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

/// X25519 公钥 / 私钥长度（curve25519 标量与点编码均为 32 字节）。
pub const X25519_KEY_SIZE: usize = 32;

/// 生成账户 keyset：返回 (pub32, priv32)。
///
/// 私钥来自 OS CSPRNG，经 curve25519 clamping 后即 StaticSecret 的 32B 表示；
/// 公钥为对应的 Montgomery-u 点编码。priv32 是敏感字节，调用方用后须清零。
///
/// # Errors
///
/// 当底层 OS CSPRNG 取随机失败时返回 [`Error::Rng`]。
pub fn keyset_generate() -> Result<([u8; X25519_KEY_SIZE], [u8; X25519_KEY_SIZE])> {
    // 不直接用 StaticSecret::random（其内部 panic-on-rng-fail），改为显式填充
    // 32B 再交给 StaticSecret::from，保持"RNG 失败返错不 panic"的 crate 契约。
    let mut seed = [0u8; X25519_KEY_SIZE];
    OsRng
        .try_fill_bytes(&mut seed)
        .map_err(|e| Error::Rng(e.to_string()))?;
    let secret = StaticSecret::from(seed);
    seed.zeroize();
    let public = PublicKey::from(&secret);
    let priv_bytes = secret.to_bytes();
    // secret 持有 clamp 后的标量；to_bytes 已复制出来，原值由 Drop 清零。
    Ok((public.to_bytes(), priv_bytes))
}

/// 用收件人公钥封装明文（X25519 sealed-box）。
///
/// 生成一次性临时密钥对，ECDH 出共享秘密，经 HKDF-SHA256 派生 32B 对称密钥，
/// 再用 [`seal_aead`] 封装。输出 = `eph_pub(32) || seal_aead 密文`。
///
/// # Errors
///
/// - [`Error::KeyLength`]：`recipient_pub` 长度不是 32。
/// - [`Error::Rng`]：临时密钥对取随机失败。
pub fn seal_to_pubkey(recipient_pub: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if recipient_pub.len() != X25519_KEY_SIZE {
        return Err(Error::KeyLength {
            got: recipient_pub.len(),
        });
    }
    let mut recipient_arr = [0u8; X25519_KEY_SIZE];
    recipient_arr.copy_from_slice(recipient_pub);
    let recipient = PublicKey::from(recipient_arr);

    let mut eph_seed = [0u8; X25519_KEY_SIZE];
    OsRng
        .try_fill_bytes(&mut eph_seed)
        .map_err(|e| Error::Rng(e.to_string()))?;
    let eph_secret = StaticSecret::from(eph_seed);
    eph_seed.zeroize();
    let eph_pub = PublicKey::from(&eph_secret);

    let shared = eph_secret.diffie_hellman(&recipient);
    let mut sym = derive_sym(shared.as_bytes(), eph_pub.as_bytes(), &recipient_arr)?;

    let ct = seal_aead(&sym, plaintext, INFO_VAULTKEY_V1)?;
    sym.zeroize();

    let mut out = Vec::with_capacity(X25519_KEY_SIZE + ct.len());
    out.extend_from_slice(eph_pub.as_bytes());
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 用私钥解封 [`seal_to_pubkey`] 的输出。
///
/// # Errors
///
/// - [`Error::KeyLength`]：`priv_key` 长度不是 32。
/// - [`Error::SealedTooShort`]：信封不足以容纳 eph_pub + nonce + tag。
/// - [`Error::AeadAuthentication`]：AEAD 认证失败（密钥错 / 数据被篡改）。
pub fn open_with_privkey(priv_key: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if priv_key.len() != X25519_KEY_SIZE {
        return Err(Error::KeyLength {
            got: priv_key.len(),
        });
    }
    // 至少要有 eph_pub(32) + nonce(24) + tag(16)。
    if sealed.len() < X25519_KEY_SIZE + NONCE_SIZE + TAG_SIZE {
        return Err(Error::SealedTooShort { got: sealed.len() });
    }
    let mut eph_pub_arr = [0u8; X25519_KEY_SIZE];
    eph_pub_arr.copy_from_slice(&sealed[..X25519_KEY_SIZE]);
    let eph_pub = PublicKey::from(eph_pub_arr);
    let ct = &sealed[X25519_KEY_SIZE..];

    let mut priv_arr = [0u8; X25519_KEY_SIZE];
    priv_arr.copy_from_slice(priv_key);
    let secret = StaticSecret::from(priv_arr);
    priv_arr.zeroize();
    let recipient_pub = PublicKey::from(&secret);

    let shared = secret.diffie_hellman(&eph_pub);
    // 派生密钥用的 salt = eph_pub || recipient_pub，与封装侧顺序一致。
    let mut sym = derive_sym(shared.as_bytes(), eph_pub.as_bytes(), recipient_pub.as_bytes())?;

    let pt = open_aead(&sym, ct, INFO_VAULTKEY_V1);
    sym.zeroize();
    pt
}

/// 由 ECDH 共享秘密派生 32B 对称密钥。
///
/// salt = eph_pub || recipient_pub（把会话密钥绑定到具体公钥对）；
/// info = "zpass-vaultkey-v1"（域分离）。这是本 sealed-box 的自定义编排，
/// 由 KAT roundtrip 锁定。
fn derive_sym(
    shared: &[u8],
    eph_pub: &[u8],
    recipient_pub: &[u8],
) -> Result<[u8; KEY_SIZE]> {
    let mut salt = Vec::with_capacity(2 * X25519_KEY_SIZE);
    salt.extend_from_slice(eph_pub);
    salt.extend_from_slice(recipient_pub);
    let okm = hkdf_sha256(shared, &salt, INFO_VAULTKEY_V1, KEY_SIZE)?;
    let mut sym = [0u8; KEY_SIZE];
    sym.copy_from_slice(&okm);
    // okm 是派生密钥的临时副本，清零后再返回固定数组。
    let mut okm = okm;
    okm.zeroize();
    Ok(sym)
}
