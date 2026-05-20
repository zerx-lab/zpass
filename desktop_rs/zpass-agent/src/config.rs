//! agent 启动时需要的路径与持久化文件。
//!
//! - capability token：`<config_root>/agent.cap`（32 字节，0600）
//! - agent socket：`<runtime_dir>/agent.sock`（OpenSSH agent 协议）
//! - control socket：`<runtime_dir>/control.sock`（GUI listen，agent connect）

use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, anyhow};
use zpass_ssh_agent_proto::CapabilityToken;

#[allow(dead_code)] // config_root / runtime_dir 仅用于 mkdir，main 不直接读
pub struct AgentPaths {
    pub config_root: PathBuf,
    pub runtime_dir: PathBuf,
    pub agent_sock: PathBuf,
    pub control_sock: PathBuf,
    pub token_path: PathBuf,
}

pub fn resolve_paths() -> Result<AgentPaths> {
    let config_root = zpass_platform::config_root().context("resolve config_root")?;
    let runtime_dir = zpass_platform::runtime_dir().context("resolve runtime_dir")?;
    fs::create_dir_all(&config_root).context("mkdir config_root")?;
    fs::create_dir_all(&runtime_dir).context("mkdir runtime_dir")?;
    let agent_sock = runtime_dir.join("agent.sock");
    let control_sock = runtime_dir.join("control.sock");
    let token_path = config_root.join("agent.cap");
    Ok(AgentPaths {
        config_root,
        runtime_dir,
        agent_sock,
        control_sock,
        token_path,
    })
}

/// 加载 token；不存在则生成 32 字节随机并写入（chmod 0600 on POSIX）。
pub fn load_or_create_token(path: &Path) -> Result<CapabilityToken> {
    if path.exists() {
        let mut buf = Vec::new();
        fs::File::open(path)
            .with_context(|| format!("open {}", path.display()))?
            .read_to_end(&mut buf)
            .context("read token")?;
        let token =
            CapabilityToken::from_bytes(&buf).map_err(|e| anyhow!("invalid token file: {e}"))?;
        return Ok(token);
    }
    let token = CapabilityToken::random().map_err(|e| anyhow!("CSPRNG: {e}"))?;
    write_token_atomically(path, &token.0)?;
    Ok(token)
}

fn write_token_atomically(path: &Path, bytes: &[u8; 32]) -> Result<()> {
    let tmp = path.with_extension("cap.tmp");
    {
        let mut f = fs::File::create(&tmp).context("create tmp token")?;
        f.write_all(bytes).context("write token bytes")?;
        f.flush().context("flush token")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&tmp, perm).context("chmod 0600")?;
    }
    fs::rename(&tmp, path).context("rename token into place")?;
    Ok(())
}

/// 如果旧 agent socket 还在（前一个进程崩了 / 没清理），先删。
pub fn remove_stale_socket(path: &Path) -> Result<()> {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    Ok(())
}
