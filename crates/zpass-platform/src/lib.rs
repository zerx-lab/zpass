//! 跨平台路径解析与 OS 检测。
//!
//! 规则（与 spec/02 § 11 对齐）：
//!
//! | 平台    | `config_root()`                                   | `runtime_dir()`                           |
//! | ------- | ------------------------------------------------- | ----------------------------------------- |
//! | Linux   | `$XDG_CONFIG_HOME/zpass` 或 `~/.config/zpass`     | `$XDG_RUNTIME_DIR/zpass` 或 `/tmp/zpass-<uid>` |
//! | macOS   | `~/Library/Application Support/zpass`             | `~/Library/Caches/zpass`                  |
//! | Windows | `%APPDATA%\zpass`                                 | `%LOCALAPPDATA%\zpass`                    |

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("无法定位用户目录：{0}")]
    NoHomeDir(&'static str),
    #[error("环境变量缺失：{0}")]
    MissingEnv(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    MacOS,
    Windows,
    Other,
}

pub fn current_platform() -> Platform {
    if cfg!(target_os = "linux") {
        Platform::Linux
    } else if cfg!(target_os = "macos") {
        Platform::MacOS
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Other
    }
}

/// 返回 ZPass 的配置根目录，**不**创建目录（调用方负责）。
pub fn config_root() -> Result<PathBuf, PlatformError> {
    let base = config_base()?;
    Ok(base.join("zpass"))
}

/// 返回 ZPass 的运行时目录（socket / 临时 token 等），**不**创建目录。
pub fn runtime_dir() -> Result<PathBuf, PlatformError> {
    let base = runtime_base()?;
    Ok(base.join("zpass"))
}

#[cfg(target_os = "linux")]
fn config_base() -> Result<PathBuf, PlatformError> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let p = PathBuf::from(xdg);
        if p.is_absolute() {
            return Ok(p);
        }
    }
    home_dir().map(|h| h.join(".config"))
}

#[cfg(target_os = "linux")]
fn runtime_base() -> Result<PathBuf, PlatformError> {
    if let Some(r) = std::env::var_os("XDG_RUNTIME_DIR") {
        let p = PathBuf::from(r);
        if p.is_absolute() {
            return Ok(p);
        }
    }
    // 退路：/tmp/zpass-<uid>（与 Go 版相同的策略）
    let uid = uid_string();
    Ok(PathBuf::from(format!("/tmp/zpass-{uid}")))
}

#[cfg(target_os = "macos")]
fn config_base() -> Result<PathBuf, PlatformError> {
    home_dir().map(|h| h.join("Library").join("Application Support"))
}

#[cfg(target_os = "macos")]
fn runtime_base() -> Result<PathBuf, PlatformError> {
    home_dir().map(|h| h.join("Library").join("Caches"))
}

#[cfg(target_os = "windows")]
fn config_base() -> Result<PathBuf, PlatformError> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or(PlatformError::MissingEnv("APPDATA"))
}

#[cfg(target_os = "windows")]
fn runtime_base() -> Result<PathBuf, PlatformError> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or(PlatformError::MissingEnv("LOCALAPPDATA"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn config_base() -> Result<PathBuf, PlatformError> {
    home_dir().map(|h| h.join(".config"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn runtime_base() -> Result<PathBuf, PlatformError> {
    home_dir().map(|h| h.join(".cache"))
}

#[cfg(not(target_os = "windows"))]
fn home_dir() -> Result<PathBuf, PlatformError> {
    if let Some(h) = std::env::var_os("HOME") {
        let p = PathBuf::from(h);
        if p.is_absolute() {
            return Ok(p);
        }
    }
    Err(PlatformError::NoHomeDir("HOME"))
}

#[cfg(target_os = "windows")]
fn home_dir() -> Result<PathBuf, PlatformError> {
    if let Some(h) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(h);
        if p.is_absolute() {
            return Ok(p);
        }
    }
    Err(PlatformError::NoHomeDir("USERPROFILE"))
}

#[cfg(target_os = "linux")]
fn uid_string() -> String {
    // 不引 `libc` 依赖：尝试解析 /proc/self/status 的 Uid 行；失败回退 "anon"。
    if let Ok(s) = std::fs::read_to_string("/proc/self/status") {
        for line in s.lines() {
            if let Some(rest) = line.strip_prefix("Uid:")
                && let Some(uid) = rest.split_whitespace().next()
            {
                return uid.to_string();
            }
        }
    }
    "anon".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_platform_returns_a_known_value() {
        // 仅断言函数能跑、返回有效枚举。具体哪个平台依宿主而定。
        let p = current_platform();
        assert!(matches!(
            p,
            Platform::Linux | Platform::MacOS | Platform::Windows | Platform::Other
        ));
    }

    #[test]
    fn config_root_ends_with_zpass() {
        // 不修改全局 env（Rust 2024 把 set_var/remove_var 标为 unsafe，
        // 测试间并发会触发未定义行为）。直接调用 + 校验已有环境下的结果即可。
        if let Ok(p) = config_root() {
            assert!(p.ends_with("zpass"), "config_root 必须以 zpass 结尾：{p:?}");
        }
        // 若环境缺 HOME / APPDATA 则跳过：这是 CI 上极少出现的情况。
    }
}
