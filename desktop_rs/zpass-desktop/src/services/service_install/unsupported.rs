//! Windows / macOS stub（spec/08 § 7 v1：仅 Linux 实装；其它平台 v2）。
//!
//! Windows v2：Scheduled Task at user logon。
//! macOS v2：launchd plist + launchctl load 提示。

use super::{InstallError, InstallStatus};

pub fn install(_exe_path: &str) -> Result<InstallStatus, InstallError> {
    Ok(InstallStatus::Unsupported)
}

pub fn status() -> Result<InstallStatus, InstallError> {
    Ok(InstallStatus::Unsupported)
}

pub fn uninstall() -> Result<(), InstallError> {
    Err(InstallError::Unsupported)
}
