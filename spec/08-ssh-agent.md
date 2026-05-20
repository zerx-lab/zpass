# 08 — SSH Agent（双进程）

## 1. 拓扑

```
┌──────────────┐         ┌──────────────────┐         ┌─────────────────────┐
│  ssh / git   │ ──UDS──► │   zpass-agent    │ ──UDS─►│   zpass-desktop      │
│ (SSH client) │         │  (守护进程)        │ ◄─────  │ (GUI 进程，持有 DEK) │
└──────────────┘         └──────────────────┘         └─────────────────────┘
       ▲                          ▲                              │
       │                          │ 控制通道                      │
       │                          │ (HMAC token 鉴权)             │
       │                          └──────────────────────────────┘
       │                                                        │
       │ SSH agent protocol                                     │
       │ (RFC 4256 / OpenSSH agent proto)                       │
       └────────────────────────────────────────────────────────┘
```

- `zpass-agent` 监听 `SSH_AUTH_SOCK`（Unix: `$XDG_RUNTIME_DIR/zpass/agent.sock`；Windows: named pipe `\\.\pipe\zpass-agent`）。
- `zpass-agent` 通过**控制通道**与 GUI 通信（Unix: `$XDG_RUNTIME_DIR/zpass/control.sock`；Windows: 另一个 named pipe）。
- **GUI 是控制通道的 server，agent 是 client**（与 Go 一致；理由见下文）。

---

## 2. 进程角色

| 进程               | 是否持 DEK | 是否持公钥 | 是否持私钥 |
| ------------------ | ---------- | ---------- | ---------- |
| `zpass-desktop`    | ✅         | ✅          | 仅签名瞬间（请求-响应 boundary）|
| `zpass-agent`      | ❌         | ✅（GUI 推过来）| ❌         |

`zpass-agent` 收到 `SSH_SIGN_REQUEST` 时：

1. 自己**不**能解密任何东西。
2. 通过控制通道把 `(key_fingerprint, data_to_sign)` 转给 GUI。
3. GUI 调 `VaultService::decrypt_ssh_private_key(item_id)` 拿到 `Zeroizing<Vec<u8>>`。
4. GUI 用拿到的私钥签名（用 `ssh-key` crate 或类似），把签名回写给 agent。
5. agent 把签名按 SSH agent 协议格式回给 ssh client。

> 私钥**只在 GUI 进程的栈上短暂存在**，签完即抹零。Agent 永远不见私钥字节。

---

## 3. 控制通道：GUI 是 server，agent 是 client

### 3.1 为什么这样选

| 方案                                | 优势                                                                                | 劣势                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **GUI listen, agent connect（采用）** | GUI 可以在用户重启时**保留**后台 agent，让 ssh 客户端连接不中断；agent 用退避重连     | agent 启动后要重试若干次才能见到 GUI                                       |
| agent listen, GUI connect           | 简单                                                                                | GUI 退出 = listener 没了；ssh 客户端的「persistent agent」体验丢失           |

> 与 Go 完全一致（详见 `desktop/sshagentservice.go:176-209` 关于「跨 GUI 重启自动重接管」的设计注释）。

### 3.2 鉴权

`~/.config/zpass/agent.cap` 存放 32 字节随机 token（capability token）。

```rust
pub struct CapabilityToken(pub [u8; 32]);

impl CapabilityToken {
    pub fn load_or_create() -> Result<Self, ProtoError>;  // 不存在则生成 + 写入（0600）
    pub fn hmac(&self, nonce: &[u8]) -> [u8; 32];         // HMAC-SHA256(token, nonce)
}
```

握手：

1. agent connect 控制通道。
2. GUI 发 `Hello { nonce: [u8; 32] }`。
3. agent 回 `HelloReply { nonce, hmac = HMAC(token, nonce) }`。
4. GUI 验证 HMAC（恒定时间比较 `subtle::ConstantTimeEq`），失败则 close 连接。
5. GUI 立即推 `OpState { unlocked }` 与 `PushKeys`。

### 3.3 消息类型（`zpass-ssh-agent-proto`）

```rust
pub enum AgentMessage {
    Hello { nonce: [u8; 32] },
    HelloReply { nonce: [u8; 32], hmac: [u8; 32] },
    OpState { unlocked: bool },
    PushKeys { keys: Vec<PublicKeyEntry> },
    SignRequest { request_id: u64, key_blob: Vec<u8>, data: Vec<u8>, flags: u32 },
    SignReply { request_id: u64, signature: Result<Vec<u8>, String> },
    AuditEntry { entry: AuditEntry },
    Bye,
}

pub struct PublicKeyEntry {
    pub item_id: String,        // GUI 用它定位 vault item
    pub blob: Vec<u8>,          // SSH agent protocol 的 key blob
    pub comment: String,
}
```

序列化用 `ciborium`（与 vault-format 风格一致）。帧格式：`[4 bytes BE length][CBOR bytes]`。

---

## 4. SSH agent protocol 实现

`zpass-agent` 实现 OpenSSH agent protocol 子集（与 Go 一致）：

| Op                                     | 行为                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| `SSH_AGENTC_REQUEST_IDENTITIES`        | 返回当前缓存的 `PushKeys` 列表                              |
| `SSH_AGENTC_SIGN_REQUEST`              | 转发 `SignRequest` 给 GUI，等 `SignReply`                  |
| `SSH_AGENTC_ADD_IDENTITY`              | 拒绝（vault-only）                                          |
| `SSH_AGENTC_REMOVE_IDENTITY`           | 拒绝                                                        |
| `SSH_AGENTC_REMOVE_ALL_IDENTITIES`     | 拒绝                                                        |
| 其它                                   | `SSH_AGENT_FAILURE`                                          |

---

## 5. 签名审批

### 5.1 MVP（v1）

与 Go MVP 一致（`desktop/sshagentservice.go:50-58`）：

- vault **解锁**状态下 → 自动批准。
- vault **锁定**状态下 → 直接 `SignReply { signature: Err("vault locked") }`，agent 回 `SSH_AGENT_FAILURE` 给 ssh client。

### 5.2 异步边界在哪里

```
zpass-agent           zpass-desktop（GUI 进程内）
─────────────         ──────────────────────────
| spawn 读循环 |       | ssh-agent host 服务（线程）|
|             |       |                          |
| 收到 SIGN_REQ │      | 收到 SignRequest          |
|  ↓            |      |   ↓                       |
| 通过 chan 转发 ↓     | 通过 cx.spawn(...) 调到 GPUI |
|               |      |  └─ vault.decrypt_ssh_private_key(id) (同步)
|               |      |  └─ sign with ssh-key crate (同步)
|               |      | 把签名通过 chan 发回控制通道线程
|  ↑            ↓      | ↓
| 写 SIGN_REPLY |       | SignReply 发回 agent      |
└──────────────┘      └──────────────────────────┘
```

> **vault-service 始终同步**。异步只在桌面层的「控制通道线程 ↔ GPUI 主线程」之间。详见 `01-architecture.md` § 异步策略。

### 5.3 v2 增量（不在 v1 范围）

- 弹审批对话框；
- trust cache（用户「记住此 host 24h 自动批准」）；
- 失败 / 拒绝 / 超时的细分审计。

---

## 6. 审计日志

每次签名（包括失败 / 锁定 / key-not-found）`zpass-agent` 通过 `AgentMessage::AuditEntry` 推给 GUI；GUI 调 `VaultService::append_audit(entry)`。

`AuditEntry` 结构：

```rust
pub struct AuditEntry {
    pub created_at: i64,                // unix ms，由 GUI 侧的 nowMs 填充
    pub fingerprint: String,            // 公钥 fingerprint
    pub key_comment: String,            // 公钥 comment（可选）
    pub client_pid: Option<u32>,        // agent 取到的对端进程 PID（Linux SO_PEERCRED）
    pub client_exe: Option<String>,     // 同上对应 /proc/<pid>/exe（best-effort）
    pub decision: AuditDecision,
}

pub enum AuditDecision {
    Approved,
    DeclinedByUser,    // v2 才会出现
    TrustedCache,      // v2
    VaultLocked,
    KeyNotFound,
    Timeout,           // v2
    Error(String),
}
```

> **严禁**记录 `data` 原文（commit 摘要 / 认证 challenge 等可能含敏感信息）。仅记 fingerprint + metadata + decision。

落 vault DB 的 schema 见 `03-vault-format.md` § 3.4。AAD 拼装见 `03-vault-format.md` § 4。

---

## 7. 系统服务安装（v1 内 + 但是 GUI 触发）

| 平台    | 实现                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------ |
| Linux   | 写 `~/.config/systemd/user/zpass-agent.service` + `.socket`，调 `systemctl --user enable --now`        |
| Windows | 注册 Scheduled Task at user logon                                                                       |
| macOS   | 仅写 plist 模板 + UI 提示用户手动 `launchctl load`（v2 自动）                                          |

> 与 Go `desktop/serviceinstall_*.go` 一一对应。落到 `zpass-desktop/src/services/service_install/`（不另立 crate；逻辑量小、桌面唯一）。

---

## 8. 测试

| 测试                                   | 位置                                       |
| -------------------------------------- | ------------------------------------------ |
| `proto_round_trip`                     | `crates/zpass-ssh-agent-proto/tests/`     |
| `hmac_token_constant_time`             | `crates/zpass-ssh-agent-proto/tests/`     |
| `sign_request_routes_to_vault`         | `desktop_rs/zpass-desktop/tests/` 集成测试 |
| `sign_when_locked_fails_clean`         | 集成测试                                   |
| `key_not_found_audit_decision_correct` | 集成测试                                   |
| `agent_survives_gui_restart`           | 集成测试（启 mock GUI → 关 → 再启 → agent 自动重接） |

---

## 9. 与谁衔接

- 上一篇：[`07-passkey.md`](./07-passkey.md)
- 下一篇：[`09-browser-bridge.md`](./09-browser-bridge.md)
- 相关：[`05-vault-service-api.md`](./05-vault-service-api.md) `decrypt_ssh_private_key` / `append_audit`
