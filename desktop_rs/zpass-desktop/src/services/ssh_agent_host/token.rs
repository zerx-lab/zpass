//! GUI 侧加载 capability token（与 agent 共享同一文件 `~/.config/zpass/agent.cap`）。
//!
//! 与 `zpass-agent::config::load_or_create_token` 实质同逻辑；这里复刻一份，
//! 避免桌面 crate 拉进 agent binary 的 module tree。

use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, anyhow};
use zpass_ssh_agent_proto::CapabilityToken;

pub fn token_path() -> Result<PathBuf> {
    let root = zpass_platform::config_root().context("resolve config_root")?;
    fs::create_dir_all(&root).context("mkdir config_root")?;
    Ok(root.join("agent.cap"))
}

pub fn control_sock_path() -> Result<PathBuf> {
    let dir = zpass_platform::runtime_dir().context("resolve runtime_dir")?;
    fs::create_dir_all(&dir).context("mkdir runtime_dir")?;
    Ok(dir.join("control.sock"))
}

pub fn load_or_create_token(path: &Path) -> Result<CapabilityToken> {
    if path.exists() {
        let mut buf = Vec::new();
        fs::File::open(path)
            .with_context(|| format!("open {}", path.display()))?
            .read_to_end(&mut buf)
            .context("read token")?;
        return CapabilityToken::from_bytes(&buf).map_err(|e| anyhow!("invalid token: {e}"));
    }
    let t = CapabilityToken::random().map_err(|e| anyhow!("CSPRNG: {e}"))?;
    let tmp = path.with_extension("cap.tmp");
    {
        let mut f = fs::File::create(&tmp).context("create tmp")?;
        f.write_all(&t.0).context("write token")?;
        f.flush().context("flush")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).context("rename token")?;
    Ok(t)
}
