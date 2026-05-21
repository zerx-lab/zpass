//! Linux user systemd 安装实现。
//!
//! - unit 文件路径：`~/.config/systemd/user/zpass-agent.service`
//! - 启用流程：写文件 → `systemctl --user daemon-reload` → `systemctl --user enable --now zpass-agent`
//! - 状态：`systemctl --user status zpass-agent` 返回值简化为 `InstalledOk` / `InstalledNoSystemd`

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use super::{InstallError, InstallStatus};

const UNIT_FILENAME: &str = "zpass-agent.service";

fn unit_path() -> Result<PathBuf, InstallError> {
    let home = std::env::var_os("HOME").ok_or_else(|| {
        InstallError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "$HOME not set",
        ))
    })?;
    let dir = PathBuf::from(home)
        .join(".config")
        .join("systemd")
        .join("user");
    Ok(dir.join(UNIT_FILENAME))
}

fn render_unit(exe_path: &str) -> String {
    format!(
        "[Unit]\n\
         Description=ZPass SSH agent\n\
         After=default.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exe}\n\
         Restart=on-failure\n\
         RestartSec=2\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exe = exe_path
    )
}

/// 写入 unit 文件 + 触发 systemctl --user enable --now。
///
/// `exe_path`：zpass-agent 的二进制路径（调用方拿，通常是 `which zpass-agent` 或同
/// 目录下的 `./zpass-agent`）。
pub fn install(exe_path: &str) -> Result<InstallStatus, InstallError> {
    let path = unit_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, render_unit(exe_path))?;

    // daemon-reload + enable --now；失败不报致命错（用户可能无 systemd）。
    let dr = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    let en = Command::new("systemctl")
        .args(["--user", "enable", "--now", UNIT_FILENAME])
        .status();
    match (dr, en) {
        (Ok(d), Ok(e)) if d.success() && e.success() => Ok(InstallStatus::InstalledOk),
        _ => Ok(InstallStatus::InstalledNoSystemd),
    }
}

pub fn status() -> Result<InstallStatus, InstallError> {
    let path = unit_path()?;
    if !path.exists() {
        return Ok(InstallStatus::NotInstalled);
    }
    let out = Command::new("systemctl")
        .args(["--user", "is-enabled", UNIT_FILENAME])
        .output();
    match out {
        Ok(o) if o.status.success() => Ok(InstallStatus::InstalledOk),
        Ok(_) => Ok(InstallStatus::InstalledNoSystemd),
        Err(_) => Ok(InstallStatus::InstalledNoSystemd),
    }
}

pub fn uninstall() -> Result<(), InstallError> {
    let path = unit_path()?;
    if path.exists() {
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", UNIT_FILENAME])
            .status();
        fs::remove_file(&path)?;
        let _ = Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .status();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_unit_contains_exec_start() {
        let s = render_unit("/usr/local/bin/zpass-agent");
        assert!(s.contains("ExecStart=/usr/local/bin/zpass-agent"));
        assert!(s.contains("[Install]"));
        assert!(s.contains("WantedBy=default.target"));
        assert!(s.contains("Restart=on-failure"));
    }

    #[test]
    fn unit_path_under_xdg() {
        // 让测试在没设 HOME 的 CI 上也能跑：set 一下再测路径形态。
        unsafe {
            std::env::set_var("HOME", "/tmp/zpass-test-home");
        }
        let p = unit_path().unwrap();
        assert!(p.ends_with("systemd/user/zpass-agent.service"));
    }
}
