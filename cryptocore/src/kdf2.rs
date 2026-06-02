//! 2SKD（two-secret key derivation）编排层（档案 §2.1 / §2.6-4）
//!
//! 纯编排，无新密码学原语：
//!   pw_nfkd = NFKD(trim(pw))                                  // 仅 trim 首尾空白
//!   slow    = Argon2id(pw_nfkd, salt_xxx)                     // 复用 argon2id_raw，32B
//!   mix     = hkdf_sha256(ikm=secret_key_raw, salt=account_id, info=域分离常量, 32)
//!   out     = slow XOR mix                                    // 逐字节异或，32B
//!
//! 签名裁决（T1.b）：不含 email 参数。域分离由【双重独立】保证：
//! （a）per-account 独立盐（salt_enc ≠ salt_auth）喂给 Argon2id；
//! （b）HKDF 的 info 按用途独立（derive_auk 用 INFO_AUK_V1，
//! derive_srp_x 用 INFO_SRPX_V1）。纵深防御：即使调用方误传相同盐，
//! info 不同也保证 auk ≠ srpx。derive_auk 用 salt_enc，derive_srp_x
//! 用 salt_auth（auk_perp_srpx 向量锁定）。
//!
//! T1.d（XOR 字节序）：两个 [u8;32] 按下标 0..32 逐字节异或，无端序/移位，
//! out[i] = slow[i] ^ mix[i]。该约定由 derive_auk_known_vector 等向量锁定。

// Rust guideline compliant 2026-02-21

use crate::envelope::{INFO_AUK_V1, INFO_SRPX_V1};
use crate::hkdf::hkdf_sha256;
use crate::{KEY_SIZE, Result, argon2id_raw};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroize;

/// Argon2id 参数（m=memory KiB, t=iterations, p=parallelism）。
///
/// 复用现有 argon2id_raw 路径与 8 MiB 下限；不改 derive_kek。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Params {
    /// memory，单位 KiB（下限 8*1024 = 8 MiB）。
    pub mem_kib: u32,
    /// 迭代次数（下限 1）。
    pub iterations: u32,
    /// 并行度（下限 1，上限 255）。
    pub parallelism: u32,
}

impl Argon2Params {
    /// 显式构造。仅作便利构造器，校验留给 [`argon2id_raw`]。
    #[must_use]
    pub fn new(mem_kib: u32, iterations: u32, parallelism: u32) -> Self {
        Self {
            mem_kib,
            iterations,
            parallelism,
        }
    }
}

/// 主密码规范化：仅 trim 首尾空白，再做 Unicode NFKD（兼容分解）。
///
/// 四端必须一致：Rust unicode-normalization / Go x/text/unicode/norm /
/// JS String.prototype.normalize("NFKD")。内部空白保留（档案 §2.1 Step 3-4）。
fn normalize_password(pw: &str) -> String {
    pw.trim().nfkd().collect()
}

/// 32B XOR：out[i] = a[i] ^ b[i]（T1.d 锁定的字节序）。
fn xor32(a: &[u8; KEY_SIZE], b: &[u8; KEY_SIZE]) -> [u8; KEY_SIZE] {
    let mut out = [0u8; KEY_SIZE];
    for i in 0..KEY_SIZE {
        out[i] = a[i] ^ b[i];
    }
    out
}

/// 2SKD 公共流程：Argon2id(pw_nfkd, salt) XOR hkdf_sha256(SK, account_id, info)。
///
/// `domain_info` 是 HKDF 的域分离标签，由调用方按用途传入独立常量
/// （derive_auk 传 INFO_AUK_V1，derive_srp_x 传 INFO_SRPX_V1）。它真正
/// 参与字节派生（作为 hkdf_sha256 的 info），构成域分离的第二道独立屏障：
/// 即使调用方误传相同盐，info 不同也保证两路输出不同。HKDF 的 ikm / salt
/// 维持原样（secret_key_raw / account_id），仅 info 按用途区分。
fn derive_2skd(
    pw_nfkd: &str,
    slow_salt: &[u8],
    secret_key_raw: &[u8],
    account_id: &[u8],
    params: Argon2Params,
    domain_info: &[u8],
) -> Result<[u8; KEY_SIZE]> {
    let normalized = normalize_password(pw_nfkd);

    // slow = Argon2id(pw_nfkd, slow_salt) -> 32B。复用现有严格下限校验。
    let mut slow_vec = argon2id_raw(
        normalized.as_bytes(),
        slow_salt,
        params.mem_kib,
        params.iterations,
        params.parallelism,
        KEY_SIZE as u32,
    )?;
    let mut slow = [0u8; KEY_SIZE];
    slow.copy_from_slice(&slow_vec);
    slow_vec.zeroize();

    // mix = hkdf_sha256(ikm=SK_raw, salt=account_id, info=domain_info) -> 32B。
    // info 按用途独立（INFO_AUK_V1 / INFO_SRPX_V1），构成域分离第二屏障。
    let mut mix_vec = hkdf_sha256(secret_key_raw, account_id, domain_info, KEY_SIZE)?;
    let mut mix = [0u8; KEY_SIZE];
    mix.copy_from_slice(&mix_vec);
    mix_vec.zeroize();

    let out = xor32(&slow, &mix);
    slow.zeroize();
    mix.zeroize();
    Ok(out)
}

/// 派生 Account Unlock Key（AUK）。
///
/// 用 `salt_enc` 跑 Argon2id，与 [`derive_srp_x`] 的 `salt_auth` 独立，保证
/// AUK ⊥ SRP-x。
///
/// # Errors
///
/// Argon2id 参数非法或 HKDF 长度非法时返回对应 [`Error`]。
pub fn derive_auk(
    pw_nfkd: &str,
    salt_enc: &[u8],
    secret_key_raw: &[u8],
    account_id: &[u8],
    params: Argon2Params,
) -> Result<[u8; KEY_SIZE]> {
    derive_2skd(
        pw_nfkd,
        salt_enc,
        secret_key_raw,
        account_id,
        params,
        INFO_AUK_V1,
    )
}

/// 派生 SRP-x（输出 32B；字节->bignum 解释属 Ms-T1.c，本函数不做）。
///
/// 用 `salt_auth`（≠ salt_enc）跑 Argon2id。
///
/// # Errors
///
/// 同 [`derive_auk`]。
pub fn derive_srp_x(
    pw_nfkd: &str,
    salt_auth: &[u8],
    secret_key_raw: &[u8],
    account_id: &[u8],
    params: Argon2Params,
) -> Result<[u8; KEY_SIZE]> {
    derive_2skd(
        pw_nfkd,
        salt_auth,
        secret_key_raw,
        account_id,
        params,
        INFO_SRPX_V1,
    )
}
