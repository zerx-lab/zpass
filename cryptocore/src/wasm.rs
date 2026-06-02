//! WASM 第五端薄绑定（D5）
//!
//! 仅在 feature="wasm" 时编入，不改现有原生 API、不污染 default 编译图。
//! 这里只是把 M1 原语包成 #[wasm_bindgen] wrapper：参数走 &[u8] / Vec<u8> /
//! &str，错误统一转成 JsError（携带 Display 文本）。getrandom/js 由 Cargo.toml
//! 的 wasm feature 在 crate 级启用，故 OsRng 在浏览器走 Web Crypto。

// Rust guideline compliant 2026-02-21

use crate::kdf2::Argon2Params;
use crate::{hkdf, kdf2, keyset, open_aead, random_bytes, seal_aead};
use wasm_bindgen::prelude::*;

/// HKDF-SHA256 薄绑定。
///
/// # Errors
///
/// out_len 非法时抛出 JsError。
#[wasm_bindgen]
pub fn wasm_hkdf_sha256(
    ikm: &[u8],
    salt: &[u8],
    info: &[u8],
    out_len: usize,
) -> Result<Vec<u8>, JsError> {
    hkdf::hkdf_sha256(ikm, salt, info, out_len).map_err(|e| JsError::new(&e.to_string()))
}

/// 生成 X25519 keyset，返回 64 字节：`pub32 || priv32`。
///
/// # Errors
///
/// OS CSPRNG 失败时抛出 JsError。
#[wasm_bindgen]
pub fn wasm_keyset_generate() -> Result<Vec<u8>, JsError> {
    let (pub32, priv32) = keyset::keyset_generate().map_err(|e| JsError::new(&e.to_string()))?;
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&pub32);
    out.extend_from_slice(&priv32);
    Ok(out)
}

/// X25519 sealed-box 封装。
///
/// # Errors
///
/// 公钥长度非法或取随机失败时抛出 JsError。
#[wasm_bindgen]
pub fn wasm_seal_to_pubkey(recipient_pub: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
    keyset::seal_to_pubkey(recipient_pub, plaintext).map_err(|e| JsError::new(&e.to_string()))
}

/// X25519 sealed-box 解封。
///
/// # Errors
///
/// 私钥长度非法、信封过短或认证失败时抛出 JsError。
#[wasm_bindgen]
pub fn wasm_open_with_privkey(priv_key: &[u8], sealed: &[u8]) -> Result<Vec<u8>, JsError> {
    keyset::open_with_privkey(priv_key, sealed).map_err(|e| JsError::new(&e.to_string()))
}

/// 派生 AUK（返回 32B）。
///
/// # Errors
///
/// Argon2id/HKDF 参数非法时抛出 JsError。
#[wasm_bindgen]
pub fn wasm_derive_auk(
    pw_nfkd: &str,
    salt_enc: &[u8],
    secret_key_raw: &[u8],
    account_id: &[u8],
    mem_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Vec<u8>, JsError> {
    let params = Argon2Params::new(mem_kib, iterations, parallelism);
    kdf2::derive_auk(pw_nfkd, salt_enc, secret_key_raw, account_id, params)
        .map(|k| k.to_vec())
        .map_err(|e| JsError::new(&e.to_string()))
}

/// 派生 SRP-x（返回 32B）。
///
/// # Errors
///
/// Argon2id/HKDF 参数非法时抛出 JsError。
#[wasm_bindgen]
pub fn wasm_derive_srp_x(
    pw_nfkd: &str,
    salt_auth: &[u8],
    secret_key_raw: &[u8],
    account_id: &[u8],
    mem_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Vec<u8>, JsError> {
    let params = Argon2Params::new(mem_kib, iterations, parallelism);
    kdf2::derive_srp_x(pw_nfkd, salt_auth, secret_key_raw, account_id, params)
        .map(|k| k.to_vec())
        .map_err(|e| JsError::new(&e.to_string()))
}

/// XChaCha20-Poly1305 加密薄绑定。
///
/// 输出布局 `nonce(24) || ciphertext || tag(16)`，nonce 由 Web Crypto 取随机。
/// 浏览器侧用于封装 item 明文与 keyset 私钥（aad 绑定 item_id / 域分离常量）。
///
/// # Errors
///
/// key 长度非法或取随机失败时抛出 JsError。
#[wasm_bindgen]
pub fn wasm_seal_aead(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
    seal_aead(key, plaintext, aad).map_err(|e| JsError::new(&e.to_string()))
}

/// XChaCha20-Poly1305 解密薄绑定（对应 [`wasm_seal_aead`]）。
///
/// 浏览器侧用于解密 item 密文与解封 keyset 私钥（aad 必须与封装时一致）。
///
/// # Errors
///
/// key 长度非法、信封过短或认证失败时抛出 JsError（认证失败为模糊错误，不区分原因）。
#[wasm_bindgen]
pub fn wasm_open_aead(key: &[u8], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
    open_aead(key, sealed, aad).map_err(|e| JsError::new(&e.to_string()))
}

/// 操作系统 CSPRNG 薄绑定（浏览器走 Web Crypto，getrandom/js）。
///
/// 浏览器侧用于生成 Z1 Secret Key、双盐与 vault key。
///
/// # Errors
///
/// `n == 0` 或底层随机源失败时抛出 JsError；绝不回退弱随机。
#[wasm_bindgen]
pub fn wasm_random_bytes(n: usize) -> Result<Vec<u8>, JsError> {
    random_bytes(n).map_err(|e| JsError::new(&e.to_string()))
}
