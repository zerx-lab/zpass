//! 原子 JSON 配置读写：写 tmp + fsync + rename。
//!
//! - 文件路径：`<config_root>/<namespace>.json`
//! - namespace 必须只含 ASCII 字母 / 数字 / `-` / `_`，长度 1..=64。
//! - `write` 会保证 SIGKILL / 掉电场景下不会出现「半文件」：旧文件仍可用。
//!
//! 内部不解析 JSON 内容（仅做语法校验确保不写入垃圾），由调用方负责 schema。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("namespace 非法（仅允许 [A-Za-z0-9_-]{{1,64}}）：{0:?}")]
    InvalidNamespace(String),
    #[error("内容不是合法 JSON：{0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("平台错误：{0}")]
    Platform(#[from] zpass_platform::PlatformError),
    #[error("IO 错误（path={path:?}）：{source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

fn io_err(path: PathBuf, source: std::io::Error) -> ConfigError {
    ConfigError::Io { path, source }
}

/// 默认 ZPass 配置目录（不自动创建）。
pub fn config_dir() -> Result<PathBuf, ConfigError> {
    Ok(zpass_platform::config_root()?)
}

/// 校验 namespace。
fn validate_namespace(ns: &str) -> Result<(), ConfigError> {
    if ns.is_empty() || ns.len() > 64 {
        return Err(ConfigError::InvalidNamespace(ns.to_string()));
    }
    if !ns
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ConfigError::InvalidNamespace(ns.to_string()));
    }
    Ok(())
}

fn ns_path(root: &Path, ns: &str) -> PathBuf {
    root.join(format!("{ns}.json"))
}

/// 读 `<config_dir>/<namespace>.json`，返回 `None` 表示文件不存在。
pub fn read(namespace: &str) -> Result<Option<String>, ConfigError> {
    validate_namespace(namespace)?;
    let root = config_dir()?;
    read_in(&root, namespace)
}

/// 写文件（带原子保护）。`value` 必须是合法 JSON。
pub fn write(namespace: &str, value: &str) -> Result<(), ConfigError> {
    validate_namespace(namespace)?;
    let root = config_dir()?;
    write_in(&root, namespace, value)
}

/// 删除文件（不存在则视为成功）。
pub fn remove(namespace: &str) -> Result<(), ConfigError> {
    validate_namespace(namespace)?;
    let root = config_dir()?;
    remove_in(&root, namespace)
}

// ===== 测试可注入的版本：接受自定义 root =====

pub fn read_in(root: &Path, namespace: &str) -> Result<Option<String>, ConfigError> {
    validate_namespace(namespace)?;
    let path = ns_path(root, namespace);
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err(path, e)),
    }
}

pub fn write_in(root: &Path, namespace: &str, value: &str) -> Result<(), ConfigError> {
    validate_namespace(namespace)?;
    // 提前校验 JSON。
    let _: serde_json::Value = serde_json::from_str(value)?;

    fs::create_dir_all(root).map_err(|e| io_err(root.to_path_buf(), e))?;

    let final_path = ns_path(root, namespace);
    let tmp_path = root.join(format!(".{namespace}.json.tmp"));

    // 1. 写 tmp。
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| io_err(tmp_path.clone(), e))?;
        f.write_all(value.as_bytes())
            .map_err(|e| io_err(tmp_path.clone(), e))?;
        // 2. fsync。
        f.sync_all().map_err(|e| io_err(tmp_path.clone(), e))?;
    }

    // 3. rename（POSIX 原子；Windows MoveFileEx 默认替换语义见下方注释）。
    #[cfg(not(target_os = "windows"))]
    fs::rename(&tmp_path, &final_path).map_err(|e| io_err(final_path.clone(), e))?;

    #[cfg(target_os = "windows")]
    {
        // Windows 上 fs::rename 会在目标已存在时失败。先 remove 旧文件。
        // 严格来说存在 SIGKILL 窗口；为简化我们接受这点（与 Go 版本行为一致）。
        let _ = fs::remove_file(&final_path);
        fs::rename(&tmp_path, &final_path).map_err(|e| io_err(final_path.clone(), e))?;
    }

    Ok(())
}

pub fn remove_in(root: &Path, namespace: &str) -> Result<(), ConfigError> {
    validate_namespace(namespace)?;
    let path = ns_path(root, namespace);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(path, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_rules() {
        for bad in ["", "../etc", "a/b", "with space", "a.b", "💀"] {
            assert!(
                matches!(
                    validate_namespace(bad),
                    Err(ConfigError::InvalidNamespace(_))
                ),
                "{bad:?} 应被拒绝"
            );
        }
        for good in ["a", "ssh-agent", "trusted_device", "Foo123"] {
            validate_namespace(good).expect(good);
        }
    }

    #[test]
    fn write_read_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        write_in(tmp.path(), "ssh-agent", r#"{"enabled":true}"#).unwrap();
        let got = read_in(tmp.path(), "ssh-agent").unwrap().unwrap();
        assert_eq!(got, r#"{"enabled":true}"#);
    }

    #[test]
    fn write_rejects_invalid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let err = write_in(tmp.path(), "bad", "not json").unwrap_err();
        assert!(matches!(err, ConfigError::InvalidJson(_)));
    }

    #[test]
    fn read_missing_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let got = read_in(tmp.path(), "nope").unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn write_replaces_existing() {
        let tmp = tempfile::tempdir().unwrap();
        write_in(tmp.path(), "ns", r#"{"v":1}"#).unwrap();
        write_in(tmp.path(), "ns", r#"{"v":2}"#).unwrap();
        let got = read_in(tmp.path(), "ns").unwrap().unwrap();
        assert_eq!(got, r#"{"v":2}"#);
    }

    #[test]
    fn remove_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        remove_in(tmp.path(), "absent").unwrap();
        write_in(tmp.path(), "absent", r#"{}"#).unwrap();
        remove_in(tmp.path(), "absent").unwrap();
        assert!(read_in(tmp.path(), "absent").unwrap().is_none());
    }

    #[test]
    fn write_creates_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("nested").join("deep");
        write_in(&nested, "ns", r#"{}"#).unwrap();
        assert!(nested.join("ns.json").exists());
    }
}
