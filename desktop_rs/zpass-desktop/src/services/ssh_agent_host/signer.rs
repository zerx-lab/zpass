//! SSH 签名（spec/08 § 5）：
//! 在 GUI 进程内用 vault.decrypt_ssh_private_key 拿到 OpenSSH PEM，
//! 再用 ssh-key crate 解析 + 签名，返回 SSH wire 格式的 signature blob。
//!
//! D3 占位：返回 `Err("ssh signing not yet implemented (D4)")`。
//! D4 接 ssh-key crate。

use anyhow::{Result, anyhow};

use zpass_vault_service::VaultService;
use zpass_vault_store::SqliteVaultStore;

/// 用 vault 中 `item_id` 对应的 SSH 私钥签名 `data`，返回 SSH agent wire 格式 signature blob。
pub fn sign_with_vault_key(
    _vault: &VaultService<SqliteVaultStore>,
    _item_id: &str,
    _data: &[u8],
    _flags: u32,
) -> Result<Vec<u8>> {
    // D4 实现：
    //   let pkcs8_or_pem = vault.decrypt_ssh_private_key(item_id)?;
    //   let key = ssh_key::PrivateKey::from_openssh(&pkcs8_or_pem)?;
    //   let sig: ssh_key::Signature = signature::Signer::try_sign(&key, data)?;
    //   // SSH agent wire: string sig_format + string sig_blob
    //   let mut out = Vec::new();
    //   ssh_encoding::Encode::encode(&sig, &mut out)?;
    //   Ok(out)
    Err(anyhow!("ssh signing not yet implemented (D4)"))
}
