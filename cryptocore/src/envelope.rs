//! 统一信封版本标记与算法 id 常量（档案 §2.6）
//!
//! 信封布局基线（v1）:
//!   [0]   format_version (u8)   当前 0x01
//!   [1]   alg_id (u8)
//!   [2..] alg-specific 字节
//!
//! 本模块只锁定常量并由测试覆盖，确保四端（desktop / phone / extension /
//! wasm）后续对齐时不会有人擅自改动这些字节。M1 阶段封装函数本身先不实现
//! 完整 envelope 编解码（seal_aead 现状布局保持不变），仅落常量骨架。

// Rust guideline compliant 2026-02-21

/// 信封 format_version 基线。算法升级即 bump。
pub const FORMAT_VERSION_V1: u8 = 0x01;

/// alg_id: XChaCha20-Poly1305（现状 seal_aead 布局：[24B nonce][ct][16B tag]）。
pub const ALG_XCHACHA20POLY1305: u8 = 0x01;

/// alg_id: Argon2id 包裹（AUK 包裹私钥等场景的语义标记）。
pub const ALG_ARGON2ID_WRAP: u8 = 0x02;

/// alg_id: X25519 sealed-box（布局：[32B eph_pub][ct][16B tag]）。
pub const ALG_X25519_SEAL: u8 = 0x10;

/// alg_id: SRP-6a verifier（Ms 里程碑使用，M1 仅占位锁定）。
pub const ALG_SRP_VERIFIER: u8 = 0x20;

// ---- 域分离常量（用作各 HKDF 调用的 info；锁进向量防止被随意改动）----

/// Secret Key 处理的 HKDF info（2SKD: hkdf(ikm=SK, salt=account_id, info=此值)）。
pub const INFO_SK_V1: &[u8] = b"zpass-sk-v1";

/// AUK 派生场景的域分离标签。
pub const INFO_AUK_V1: &[u8] = b"zpass-auk-v1";

/// SRP-x 派生场景的域分离标签。
pub const INFO_SRPX_V1: &[u8] = b"zpass-srpx-v1";

/// keyset 私钥包裹（seal_aead 的 aad）。
pub const INFO_KEYSET_PRIV_V1: &[u8] = b"zpass-keyset-priv-v1";

/// vault key 包裹 / sealed-box 派生的域分离标签。
pub const INFO_VAULTKEY_V1: &[u8] = b"zpass-vaultkey-v1";
