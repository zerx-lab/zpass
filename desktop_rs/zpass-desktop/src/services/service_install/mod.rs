//! 系统服务安装（spec/08 § 7）。
//!
//! 让 zpass-agent 在用户登录后自动启动：
//! - Linux：systemd user service（`~/.config/systemd/user/zpass-agent.service`）
//! - Windows：Scheduled Task at user logon（v2，留 stub）
//! - macOS：launchd plist 模板 + 提示用户手动 `launchctl load`（v2，留 stub）

#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod unsupported;

#[cfg(target_os = "linux")]
#[allow(unused_imports)]
pub use linux::{install, status, uninstall};
#[cfg(not(target_os = "linux"))]
#[allow(unused_imports)]
pub use unsupported::{install, status, uninstall};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallStatus {
    /// 未安装：unit 文件不存在。
    NotInstalled,
    /// unit 文件已写但 systemctl --user 调用失败 / 不可用。
    InstalledNoSystemd,
    /// 已安装且 systemd 知道（不区分 active 与 inactive；用户用 systemctl 查）。
    InstalledOk,
    /// 平台不支持（macOS / Windows v1 stub）。
    Unsupported,
}

#[derive(Debug)]
pub enum InstallError {
    Unsupported,
    Io(std::io::Error),
    Systemctl(String),
}

impl From<std::io::Error> for InstallError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => f.write_str("service install not supported on this OS"),
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Systemctl(s) => write!(f, "systemctl: {s}"),
        }
    }
}

impl std::error::Error for InstallError {}
