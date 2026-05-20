# 10 — Trusted Device 自动解锁

## 1. 范围

让用户在「本台机器、本 OS 账户」下重启 ZPass 不必再次输入主密码。实现方式：把已经派生出的 DEK 用 OS 提供的「设备绑定密钥」再加密一层，落 `vault_trusted_device` 表。下次启动调 OS API 还原 DEK。

---

## 2. v1 平台支持

| 平台    | v1 实现              | 备注                                                  |
| ------- | -------------------- | ----------------------------------------------------- |
| Windows | ✅ DPAPI             | `windows-sys::Win32_Security_Cryptography` API        |
| macOS   | ❌ stub（`Unsupported`） | 与 Go 现状一致；v2 用 Keychain Services 实现          |
| Linux   | ❌ stub（`Unsupported`） | 与 Go 现状一致；v2 用 libsecret 实现                  |

> **不**在 v1 实现 macOS Keychain / Linux libsecret —— 这是 Go 版本的 stub 现状，不在 spec scope 内提升。

---

## 3. Trait

```rust
// crates/zpass-trusted-device/src/lib.rs

pub trait TrustedDeviceProtector: Send + Sync {
    fn available(&self) -> bool;
    fn method(&self) -> &'static str;
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, TrustedDeviceError>;
    fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, TrustedDeviceError>;
}

pub const METHOD_DPAPI: &str = "dpapi";
pub const METHOD_KEYCHAIN: &str = "keychain";       // 仅常量
pub const METHOD_LIBSECRET: &str = "libsecret";     // 仅常量

pub enum TrustedDeviceError {
    Unsupported,                 // 当前平台 / 当前进程不可用
    Unprotect(&'static str),     // OS 解封失败（凭据已变化、跨机器复制等）
    Io(std::io::Error),
}

pub fn default_protector() -> Box<dyn TrustedDeviceProtector>;
```

`default_protector()` 的平台 cfg：

```rust
#[cfg(target_os = "windows")]
pub fn default_protector() -> Box<dyn TrustedDeviceProtector> {
    Box::new(dpapi::DpapiProtector::new())
}

#[cfg(not(target_os = "windows"))]
pub fn default_protector() -> Box<dyn TrustedDeviceProtector> {
    Box::new(unsupported::UnsupportedProtector::new())
}
```

---

## 4. Windows DPAPI 实现

`CryptProtectData` / `CryptUnprotectData` with `pOptionalEntropy = b"zpass:trusted-device:v1"`。

```rust
// crates/zpass-trusted-device/src/dpapi.rs（草图）
use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};

const ENTROPY: &[u8] = b"zpass:trusted-device:v1";

pub struct DpapiProtector;

impl TrustedDeviceProtector for DpapiProtector {
    fn available(&self) -> bool { true }
    fn method(&self) -> &'static str { METHOD_DPAPI }
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, TrustedDeviceError> {
        // 构造 DATA_BLOB { cbData, pbData } 三个：input / entropy / output
        // 调 CryptProtectData(..., CRYPTPROTECT_UI_FORBIDDEN, ...)
        // 复制 output 到 Vec<u8>，再 LocalFree(output.pbData)
    }
    fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, TrustedDeviceError> {
        // 对称
    }
}
```

> 必须 `CRYPTPROTECT_UI_FORBIDDEN`：DPAPI 默认可能弹一个「确认密码」对话框，我们的语义是「无声自动解锁」，弹窗即视为失败。

---

## 5. 桌面层串联（关键：vault-service 不依赖 trusted-device）

```rust
// desktop_rs/zpass-desktop/src/services/trusted_device.rs（草图）

pub fn try_auto_unlock(
    vault: &VaultService<SqliteVaultStore>,
    store: &SqliteVaultStore,
    protector: &dyn TrustedDeviceProtector,
) -> bool {
    if !protector.available() { return false; }
    let Ok(Some(row)) = store.read_trusted_device() else { return false; };
    if row.method != protector.method() {
        // 数据是另一个保护方案写的（用户跨平台搬了 vault.db）—— 清掉
        let _ = store.delete_trusted_device();
        return false;
    }
    let plaintext = match protector.unprotect(&row.blob) {
        Ok(p) => p,
        Err(_) => {
            // OS 凭据变了 / 数据被搬了 —— 静默清掉 + 回退主密码
            let _ = store.delete_trusted_device();
            return false;
        }
    };
    let dek: [u8; 32] = match plaintext.as_slice().try_into() {
        Ok(arr) => arr,
        Err(_) => { let _ = store.delete_trusted_device(); return false; },
    };
    vault.unlock_with_dek(Zeroizing::new(dek)).is_ok()
}

pub fn enable(
    vault: &VaultService<SqliteVaultStore>,
    store: &SqliteVaultStore,
    protector: &dyn TrustedDeviceProtector,
    master_password: &str,
) -> Result<(), TrustedDeviceError> {
    // 1. 用主密码 re-verify（防劫持会话恶意启用）
    let dek = vault.export_dek_with_master_password(master_password)
        .map_err(|_| TrustedDeviceError::Unprotect("invalid master password"))?;
    // 2. 包装
    let blob = protector.protect(&*dek)?;
    // 3. 落盘
    store.write_trusted_device(&TrustedDeviceRow {
        method: protector.method().into(),
        blob,
        created_at: now_ms(),
    })?;
    Ok(())
}

pub fn disable(store: &SqliteVaultStore) -> Result<(), TrustedDeviceError> {
    store.delete_trusted_device()?;
    Ok(())
}
```

> 桌面层是**串联者**：vault-service 与 trusted-device 互不感知，通过 `unlock_with_dek` + `export_dek_with_master_password` 两个口径完成数据流。

---

## 6. 失败语义

| 场景                              | 行为                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| `vault_trusted_device` 行不存在   | `try_auto_unlock` 返回 false，桌面层进 unlock 屏让用户输主密码    |
| `protector.unprotect` 失败        | 静默 `delete_trusted_device()` + 回退到主密码                      |
| `protector.unprotect` 返回字节数 != 32 | 同上                                                              |
| `vault.unlock_with_dek` 内部 verifier 校验失败 | 同上（防 vault 替换 + trusted blob 不替换的攻击）                |

---

## 7. ChangeMasterPassword 对 trusted device 的影响

**无影响**。trusted-device 包装的是 DEK，不是 KEK；`ChangeMasterPassword` 仅重派生 KEK + 重新包装 DEK，DEK 字节不变。

> 与 Go 文档（`desktop/vaultdb.go:158`）一致。

---

## 8. 测试

| 测试                                              | 位置                                       |
| ------------------------------------------------- | ------------------------------------------ |
| `dpapi_protect_unprotect_round_trip`              | `crates/zpass-trusted-device/tests/`（仅 `cfg(target_os = "windows")`） |
| `dpapi_wrong_entropy_fails`                       | 同上                                        |
| `unsupported_returns_unsupported_on_protect`      | `crates/zpass-trusted-device/tests/`        |
| `try_auto_unlock_with_no_row_returns_false`       | `desktop_rs/zpass-desktop/tests/`           |
| `try_auto_unlock_clears_row_on_unprotect_failure` | 同上                                        |
| `try_auto_unlock_with_corrupted_dek_clears_row`   | 同上                                        |
| `change_master_password_preserves_trusted_device` | 同上                                        |

---

## 9. 安全模型小结（v1 Windows DPAPI 视角）

| 威胁                                               | 是否被防住                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| 攻击者拷走 vault.db 到另一台机器                   | ✅（DPAPI 绑机器 + SID）                                                       |
| 攻击者偷走整机但不知 Windows 登录密码              | ✅（进不去用户态拿不到 DPAPI master key）                                      |
| 同 Windows 用户下其它进程读 vault.db               | ✅（缺 entropy 常量解不开）                                                    |
| 攻击者已登入到当前 Windows 用户                    | ❌（与 Go 一致，与 Bitwarden 也同；进程内能 attach 调试就能直接读 DEK）         |
| SYSTEM / root                                      | ❌（OS 信任边界已破）                                                          |

与 Bitwarden 「永不超时」明文落盘 DEK 的方案相比，v1 ZPass 多一层 DPAPI 加密；离线场景严格更优。

---

## 10. 与谁衔接

- 上一篇：[`09-browser-bridge.md`](./09-browser-bridge.md)
- 下一篇：[`11-gpui-ui-architecture.md`](./11-gpui-ui-architecture.md)
