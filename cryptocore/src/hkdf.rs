//! HKDF-SHA256（RFC 5869，Extract-then-Expand）
//!
//! 底层哈希复用 crate 已有的 sha2 0.10，避免引入第二份 SHA-256 实现。
//! 四端对齐目标：Go `golang.org/x/crypto/hkdf` / JS `@noble/hashes/hkdf`。

// Rust guideline compliant 2026-02-21

use crate::{Error, Result};
use hkdf::Hkdf;
use sha2::Sha256;

/// HKDF-SHA256：从 ikm 派生 out_len 字节密钥材料。
///
/// 语义遵循 RFC 5869 §2：`PRK = HKDF-Extract(salt, ikm)`，
/// `OKM = HKDF-Expand(PRK, info, out_len)`。salt 可为空（RFC 5869 §3.1：
/// 空 salt 时退化为全零块），info 用于域分离。
///
/// # Errors
///
/// 当 `out_len` 超过 255*HashLen（SHA-256 为 8160 字节）时，HKDF-Expand 无法
/// 满足，返回 [`Error::InvalidRandomCount`]（复用现有错误变体表达"长度非法"）。
/// out_len == 0 同样视为非法输入。
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], out_len: usize) -> Result<Vec<u8>> {
    // 255 * 32 = 8160 是 HKDF-Expand 对 SHA-256 的硬上界（RFC 5869 §2.3）。
    const MAX_OKM: usize = 255 * 32;
    if out_len == 0 || out_len > MAX_OKM {
        return Err(Error::InvalidRandomCount);
    }
    // 空 salt 走 None：hkdf crate 在 None 时用全零盐，与 RFC 5869 §2.2 一致，
    // 也与 Go/JS 端"salt 缺省=零块"语义对齐。
    let salt_opt = if salt.is_empty() { None } else { Some(salt) };
    let hk = Hkdf::<Sha256>::new(salt_opt, ikm);
    let mut okm = vec![0u8; out_len];
    // expand 仅在 out_len 越界时失败，上面已先行拦截，这里仍返错不 panic。
    hk.expand(info, &mut okm)
        .map_err(|_| Error::InvalidRandomCount)?;
    Ok(okm)
}
