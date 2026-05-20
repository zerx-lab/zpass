# 09 — 浏览器扩展桥

## 1. 两个组件

1. **`zpass-browser-bridge`** —— 在 GUI 进程内运行的 loopback HTTP server，token 鉴权。
2. **`zpass-native-host`** —— stdio 二进制（Chrome / Edge / Firefox 的 native messaging host）。把浏览器请求转给 GUI 内的 HTTP server。

两个组件分置不同 crate / 不同 binary 是**硬约束**：

- `zpass-native-host` **绝不**链接 GPUI / vault / crypto；它是无状态转发器。
- 启动延迟目标 `< 100 ms`（Chrome native messaging 协议每次会话冷启动 host）。
- 体积目标 `< 5 MB`（`lto = "thin"` + `strip = "debuginfo"` + `panic = "abort"`）。

---

## 2. 工作流

```
浏览器扩展 ─stdin─► zpass-native-host ─HTTP POST /native (Authorization: Bearer <token>)─► GUI HTTP server
浏览器扩展 ◄─stdout─ zpass-native-host ◄─HTTP body (JSON)─ GUI HTTP server
```

`browser-bridge.json` 文件（`~/.config/zpass/browser-bridge.json`）由 GUI 进程在启动时写入：

```json
{
  "port": "59431",
  "token": "<64 hex chars>"
}
```

`zpass-native-host` 启动时读这份文件，构造 `Authorization: Bearer <token>` 头。

> 与 Go 完全一致（`desktop/nativebrowserbridge.go` + `desktop/nativehost_main.go`）。

---

## 3. GUI HTTP server

### 3.1 选型

`tiny_http`（同步、零异步、零 tokio），与 Go 的 `net/http` 同步处理风格对齐。

### 3.2 监听

```rust
let listener = TcpListener::bind("127.0.0.1:0")?;  // 系统分端口
let port = listener.local_addr()?.port();
```

**必须** `127.0.0.1`，不允许 `0.0.0.0`。在 unit test 中也通过 trait 注入 mock listener。

### 3.3 鉴权

```rust
fn authorized(token: &str, header: &str) -> bool {
    const PREFIX: &str = "Bearer ";
    if header.len() != PREFIX.len() + token.len() || !header.starts_with(PREFIX) {
        return false;
    }
    subtle::ConstantTimeEq::ct_eq(&header.as_bytes()[PREFIX.len()..], token.as_bytes()).into()
}
```

恒定时间比较（`subtle` crate）防 timing attack。

### 3.4 单 endpoint

`POST /native`，请求体 = `NativeEnvelope { id, type, payload }`，响应体 = `NativeResponse { id, ok, result?, error? }`。

`Content-Type: application/json`，请求体上限 = 1 MiB。

---

## 4. 消息协议

```rust
pub struct NativeEnvelope {
    pub id: String,
    pub r#type: String,           // "ping" / "queryLogins" / "revealLogin" / "generateLoginTotp" / "createLogin" / "launchDesktop" 等
    pub payload: serde_json::Value,
}

pub struct NativeResponse {
    pub id: String,
    pub ok: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}
```

具体 `type`（v1 范围内）与 Go 的 `desktop/nativebridge_protocol.go` 对照：

| type                   | payload                                                          | result                                                                                  |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ping`                 | （空）                                                            | `{ "ok": true, "unlocked": bool }`                                                       |
| `queryLogins`          | `{ origin, url }`                                                 | `{ unlocked, origin, items: [{ id, name, username, displayUrl, updatedAt, hasTotp, hasPassword, itemType }] }` |
| `revealLogin`          | `{ origin, url, itemId }`                                         | `{ id, name, username, password, totp?: { code, remaining, period } }`                  |
| `generateLoginTotp`    | `{ origin, url, itemId }`                                         | `{ code, remaining, period }`                                                            |
| `createLogin`          | `{ origin, url, name, username, password }`                       | `{ itemId }`                                                                             |
| `launchDesktop`        | （空）                                                            | `{ ok: true }`                                                                            |
| `passkeyCreate`        | `{ rpId, rpName, userId?, userName?, userDisplayName?, name? }`   | `{ itemId, credentialId, publicKeyCose, attestationObject, authenticatorData }`         |
| `passkeyAssertList`    | `{ origin, url, rpId }`                                           | `{ credentials: [ ... ] }`                                                               |
| `passkeyAssertSign`    | `{ rpId, credentialId, clientDataHash }`                          | `{ authenticatorData, signature, userHandle, signCount }`                               |

---

## 5. 域名匹配 + 黑名单

复用 Bitwarden 的 base-domain 匹配规则（与 Go `desktop/nativebridge_protocol.go:16-24` 一致）：

```rust
pub fn matches(saved: &str, current: &str) -> bool {
    // 1. 完全一致 → true
    // 2. 两边都用 publicsuffix 取得 registrable domain，相等 → true
    // 3. 检查黑名单：domain_match_blacklist[base].contains(current) → false
    // 4. 否则 false
}

static DOMAIN_MATCH_BLACKLIST: phf::Map<&'static str, &[&'static str]> = phf_map! {
    "google.com" => &["script.google.com"],
};
```

`publicsuffix` crate 用于解析 ESLD（如 `co.uk`）。

---

## 6. `zpass-native-host` 二进制

### 6.1 主循环

```rust
fn main() -> ! {
    loop {
        let msg = read_native_message(stdin())?;
        if matches!(msg.r#type.as_str(), "ping") {
            // 仅探测，不 spawn，不重试
            let res = forward_once(&msg);
            write_native_message(stdout(), &res)?;
            continue;
        }
        let res = forward_with_retry(&msg)?;
        write_native_message(stdout(), &res)?;
    }
}
```

### 6.2 GUI 不在线的处理

与 Go 一致（`desktop/nativehost_main.go:46-60`）：

```rust
fn forward_with_retry(msg: &NativeEnvelope) -> Result<NativeResponse, _> {
    if let Ok(res) = try_forward(msg) { return Ok(res); }
    // 配置缺失 / 端口不通：尝试启动 GUI
    spawn_gui_with_cooldown()?;
    // 轮询 bridge 上线
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(res) = try_forward(msg) { return Ok(res); }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(NativeResponse {
        id: msg.id.clone(),
        ok: false,
        result: None,
        error: Some("ZPass Desktop is starting up. Please try again in a moment.".into()),
    })
}
```

### 6.3 native messaging 帧格式

```
[ 4 bytes LE length ][ length bytes UTF-8 JSON ]
```

Chrome 强制 LE，无视主机端字节序。

### 6.4 spawn cooldown

`~/.config/zpass/native-host-spawn.lock` 记录最后一次 spawn 时间。两次 spawn 间隔 < 3 秒视为冷却中，不重试。

**TOCTOU 防护**：浏览器多 tab 同时启动 native-host 会让多个进程并发读这个文件，单纯 read-then-write 会让多个实例都判定「没冷却」从而都 spawn 一次 GUI。

实现必须：

- POSIX：`flock(fd, LOCK_EX)` 持锁后再读 + 写。
- Windows：`LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, ...)` 等价行为。
- 持锁期间完成「读时间戳 → 判定 → 决定 spawn 与否 → 更新时间戳」一气呵成。

> 与 Go 的 `desktop/nativehost_launcher.go` 行为对齐。

---

## 7. `VaultFacade` trait（让 bridge 可独立测试）

```rust
// crates/zpass-browser-bridge/src/lib.rs
pub trait VaultFacade: Send + Sync {
    fn status(&self) -> VaultStatusForBridge;
    fn query_logins(&self, origin: &str, url: &str) -> Vec<LoginSummary>;
    fn reveal_login(&self, origin: &str, url: &str, item_id: &str) -> Result<LoginSecret, BridgeError>;
    fn generate_login_totp(&self, origin: &str, url: &str, item_id: &str) -> Result<OtpCode, BridgeError>;
    fn create_login(&self, ...) -> Result<String, BridgeError>;
    fn passkey_create(&self, ...) -> Result<PasskeyRegistrationResult, BridgeError>;
    fn passkey_assert_list(&self, origin: &str, url: &str, rp_id: &str) -> Vec<PasskeyDescriptor>;
    fn passkey_assert_sign(&self, ...) -> Result<PasskeyAssertion, BridgeError>;
}
```

桌面层在 `zpass-desktop` 内实现 `VaultFacadeImpl`：

```rust
struct VaultFacadeImpl {
    vault: Arc<VaultService<SqliteVaultStore>>,
    // ...
}
impl VaultFacade for VaultFacadeImpl { /* 调 vault + OTP + passkey 各 crate */ }
```

> 设计动机：让 `zpass-browser-bridge` 的测试可以 mock VaultFacade，不需要拉起整个 vault DB + GPUI。

---

## 8. 测试

| 测试                                  | 位置                                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| `protocol_round_trip_all_types`       | `crates/zpass-browser-bridge/tests/`                                  |
| `auth_constant_time`                  | `crates/zpass-browser-bridge/tests/`                                  |
| `domain_match_blacklist_google_script`| `crates/zpass-browser-bridge/tests/`                                  |
| `domain_match_publicsuffix_co_uk`     | `crates/zpass-browser-bridge/tests/`                                  |
| `native_host_native_framing`          | `desktop_rs/zpass-native-host/tests/`                                 |
| `native_host_offline_returns_error`   | `desktop_rs/zpass-native-host/tests/`                                 |
| `bridge_rejects_non_loopback`         | `crates/zpass-browser-bridge/tests/`（监听必然 `127.0.0.1`）          |
| `bridge_rejects_missing_token`        | `crates/zpass-browser-bridge/tests/`                                  |
| `bridge_rejects_wrong_token_const_time`| 同上                                                                  |

---

## 9. 与谁衔接

- 上一篇：[`08-ssh-agent.md`](./08-ssh-agent.md)
- 下一篇：[`10-trusted-device.md`](./10-trusted-device.md)
