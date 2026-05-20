//! SSH 签名（spec/08 § 5）：
//! 在 GUI 进程内用 vault.decrypt_ssh_private_key 拿到 OpenSSH PEM，
//! 用 ssh-key crate 签名，返回 SSH wire 格式的 signature blob。

use anyhow::{Context as _, Result, anyhow};
use signature::Signer;
use ssh_encoding::Encode;
use ssh_key::{PrivateKey, Signature};

use zpass_vault_service::VaultService;
use zpass_vault_store::SqliteVaultStore;

/// 用 vault 中 `item_id` 对应的 SSH 私钥签 `data`，返回 SSH agent wire 格式 signature blob。
///
/// wire 格式（spec § OpenSSH agent protocol §4.5）：
/// ```text
///   string  signature_format    # e.g. "ssh-ed25519"
///   string  signature_blob      # 算法相关
/// ```
///
/// 整个 string 序列即返回值。zpass-agent 会把它再用 string-prefix 包一层（已在
/// agent_proto::build_sign_response 处理）。
///
/// `_flags` 当前忽略；RFC 8332 的 `SHA2_256 / SHA2_512` 在我们的 v1 走 ssh-key 的默认
/// hash 算法（RSA: SHA-256；其它算法 flags 无意义）。
pub fn sign_with_vault_key(
    vault: &VaultService<SqliteVaultStore>,
    item_id: &str,
    data: &[u8],
    _flags: u32,
) -> Result<Vec<u8>> {
    let pem_bytes = vault
        .decrypt_ssh_private_key(item_id)
        .map_err(|e| anyhow!("decrypt ssh key: {e:?}"))?;
    // pem_bytes 是 OpenSSH PEM 字符串的 zeroizing<Vec<u8>>
    let pem_str = core::str::from_utf8(&pem_bytes).context("ssh private key not UTF-8")?;
    let key = PrivateKey::from_openssh(pem_str).map_err(|e| anyhow!("parse OpenSSH PEM: {e:?}"))?;

    // signature::Signer<Signature> 由 ssh-key 内部 impl 到 PrivateKey。
    let sig: Signature = key.try_sign(data).map_err(|e| anyhow!("ssh sign: {e:?}"))?;

    // 编码为 SSH wire：[string format][string blob]
    let mut out = Vec::new();
    sig.encode(&mut out)
        .map_err(|e| anyhow!("encode signature: {e:?}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use signature::Verifier;
    use ssh_key::rand_core::{CryptoRng, RngCore};
    use ssh_key::{Algorithm, LineEnding};

    /// 用 ssh-key 自己生成的 Ed25519 keypair：签一条 → wire encode → public key verify 通过。
    #[test]
    fn sign_round_trip_via_ssh_key_crate_ed25519() {
        let mut rng = OsRng;
        let key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let pem = key.to_openssh(LineEnding::LF).unwrap();
        let parsed = PrivateKey::from_openssh(pem.as_str()).unwrap();

        let data = b"to-sign";
        let sig: Signature = parsed.try_sign(data).unwrap();

        // wire encode（agent SIGN_RESPONSE 用的形态）
        let mut wire = Vec::new();
        sig.encode(&mut wire).unwrap();
        assert!(!wire.is_empty());

        // public key verify
        parsed.public_key().key_data().verify(data, &sig).unwrap();
    }

    /// flags 字段当前忽略（v2 扩展用）；签 API 形状测试。
    #[test]
    fn flags_accepted_but_ignored() {
        let mut rng = OsRng;
        let key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let _sig: Signature = key.try_sign(b"x").unwrap();
    }

    /// 用 getrandom 包出符合 rand_core 0.6 CryptoRngCore trait 的最小适配（ssh-key 要）。
    struct OsRng;

    impl RngCore for OsRng {
        fn next_u32(&mut self) -> u32 {
            let mut b = [0u8; 4];
            getrandom::getrandom(&mut b).unwrap();
            u32::from_le_bytes(b)
        }
        fn next_u64(&mut self) -> u64 {
            let mut b = [0u8; 8];
            getrandom::getrandom(&mut b).unwrap();
            u64::from_le_bytes(b)
        }
        fn fill_bytes(&mut self, dest: &mut [u8]) {
            getrandom::getrandom(dest).unwrap();
        }
        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), ssh_key::rand_core::Error> {
            getrandom::getrandom(dest)
                .map_err(|_| ssh_key::rand_core::Error::new(std::io::Error::other("getrandom")))
        }
    }
    impl CryptoRng for OsRng {}
}
