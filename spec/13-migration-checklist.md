# 13 — 迁移清单：Go 文件 → Rust crate

本文是逐文件映射表，外加从 Go vault 导出的 JSON 在 Rust 端导入时的规则。任何 Phase 退场前都应该回到本文件确认对应 Go 文件的功能已被覆盖（或被显式剥离）。

---

## 1. `desktop/*.go` 文件映射

| Go 文件                                    | 行数 | Rust 落点                                                                  | 备注                                                             |
| ------------------------------------------ | ---- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `main.go`                                  | 253  | `zpass-desktop/src/main.rs` + `src/app.rs`                                  | Wails Service 注册替换为 GPUI App + 各 service 实例化            |
| `cryptoutil.go`                            | 357  | `zpass-crypto/`                                                            | 一一对应                                                          |
| `vaultdb.go`                               | 1001 | `zpass-vault-store/src/sqlite.rs` + `zpass-vault-format/src/lib.rs`        | 表结构等价、AAD 拼装规则细化（详见 `03-vault-format.md` § 3.4）  |
| `vaultservice.go`                          | 1821 | `zpass-vault-service/`                                                     | 剥离 `breachCache`；保留 `nowMs` / `hotpAdvanceMu` / 解锁去捷径 |
| `vaultservice_test.go`                     | 1056 | `zpass-vault-service/tests/regression.rs`                                  | 详见 `12-testing-strategy.md` § 2                                |
| `vaultevents.go`                           | 34   | `zpass-vault-service/src/events.rs` + `zpass-desktop/src/services/`        | `SetEventEmitter` → `VaultEventSink` 注入；详见 `05a`            |
| `configservice.go`                         | 339  | `zpass-config/`                                                            | 原子写一致                                                        |
| `breachcheck.go`                           | 448  | **剥离**（见 `00-overview.md` § D1）                                       | 不实现                                                            |
| `totpservice.go`                           | 677  | `zpass-otp/` + `zpass-vault-service/src/otp.rs`                            | 纯算 vs 状态分离                                                  |
| `totpservice_test.go`                      | 920  | `zpass-otp/tests/rfc_vectors.rs` + `zpass-vault-service/tests/hotp.rs`     | RFC 向量与持久化分离测试                                          |
| `passkeyservice.go`                        | 840  | `zpass-passkey/` + `zpass-desktop/src/services/passkey.rs`                 | 纯算 vs vault 持久化分离                                          |
| `passkeyservice_test.go`                   | 310  | `zpass-passkey/tests/` + `zpass-desktop/tests/passkey_flow.rs`             | 同上                                                              |
| `qrservice.go`                             | 152  | `zpass-desktop/src/services/qr.rs`                                         | gozxing → `rqrr` / `quircs`（详见 `16-open-questions.md`）        |
| `exportservice.go`                         | 280  | `zpass-desktop/src/services/export.rs`                                     | SaveFile dialog 走 GPUI 原生                                      |
| `fonts.go` + `fonts_*.go`                  | 277  | **剥离**（见 `00-overview.md` § D5）                                       | GPUI 自带字体                                                     |
| `trusteddevice.go`                         | 150  | `zpass-trusted-device/src/lib.rs`                                          | trait                                                             |
| `trusteddevice_windows.go`                 | 214  | `zpass-trusted-device/src/dpapi.rs`                                        | windows-sys                                                       |
| `trusteddevice_unsupported.go`             | 104  | `zpass-trusted-device/src/unsupported.rs`                                  | stub                                                              |
| `nativebrowserbridge.go`                   | 121  | `zpass-browser-bridge/src/server.rs` + `zpass-desktop/src/services/bridge.rs` | tiny_http server                                                  |
| `nativebridge_config.go`                   | 45   | `zpass-browser-bridge/src/config.rs`                                       | `browser-bridge.json` 写入                                        |
| `nativebridge_protocol.go`                 | 657  | `zpass-browser-bridge/src/proto.rs` + `domain.rs`                          | 类型与域名匹配                                                    |
| `nativebridge_protocol_test.go`            | 118  | `zpass-browser-bridge/tests/protocol.rs` + `domain.rs`                     |                                                                  |
| `nativehost_main.go`                       | 277  | `zpass-native-host/src/main.rs`                                             | stdio 转发；**零 GPUI / vault**                                   |
| `nativehost_launcher*.go`                  | ~85  | `zpass-native-host/src/launcher/`                                          | 与 Go cooldown / 跨平台分流一致                                   |
| `nativehost_test.go`                       | 90   | `zpass-native-host/tests/forwarding.rs`                                    |                                                                  |
| `sshagentservice.go`                       | 1191 | 大部分 → `zpass-desktop/src/services/ssh_agent_host.rs`                    | GUI 侧控制通道服务                                                |
| `sshagentapproval.go`                      | 469  | `zpass-desktop/src/services/ssh_agent_host/approval.rs`                    | MVP 自动批准；v2 弹窗                                             |
| `sshagentapproval_test.go`                 | 259  | 同上 tests                                                                  |                                                                  |
| `sshagentaudit.go`                         | 158  | `zpass-desktop/src/services/ssh_agent_host/audit.rs`                       | ring buffer + flush 到 vault                                      |
| `sshagentconn.go`                          | 273  | `zpass-desktop/src/services/ssh_agent_host/conn.rs`                        | 控制通道连接管理                                                  |
| `sshagentcontrol.go`                       | 288  | `zpass-desktop/src/services/ssh_agent_host/control.rs`                     | listener / token                                                  |
| `sshagentkeygen.go`                        | 248  | `zpass-desktop/src/services/ssh_agent_host/keygen.rs`                      | 生成 SSH key 写入 vault                                           |
| `sshagentkeygen_test.go`                   | 157  | 同上 tests                                                                  |                                                                  |
| `sshagentlisten_unix.go` / `_windows.go`   | ~117 | `zpass-desktop/src/services/ssh_agent_host/listen/`                        | UDS / named pipe                                                  |
| `sshagentprefs.go` / `_test.go`            | ~119 | `zpass-desktop/src/services/ssh_agent_host/prefs.rs`                       | `ssh-agent.json` 偏好                                             |
| `sshagentprobe.go` + `_unix.go` + `_windows.go` | ~150 | `zpass-desktop/src/services/ssh_agent_host/probe.rs`                       | 探测 socket 是否被占                                              |
| `sshagentsupervisor.go` + `_unix.go` + `_windows.go` | ~570 | `zpass-desktop/src/services/ssh_agent_host/supervisor/`                | 子进程管理                                                        |
| `sshagentutil.go`                          | 22   | `zpass-desktop/src/services/ssh_agent_host/util.rs`                        |                                                                  |
| `serviceinstall.go`                        | 230  | `zpass-desktop/src/services/service_install/mod.rs`                        | trait                                                             |
| `serviceinstall_linux.go`                  | 273  | `zpass-desktop/src/services/service_install/linux.rs`                      | systemd user                                                      |
| `serviceinstall_windows.go` + `_test.go`   | ~531 | `zpass-desktop/src/services/service_install/windows.rs`                    | Scheduled Task                                                    |
| `serviceinstall_others.go`                 | 51   | `zpass-desktop/src/services/service_install/unsupported.rs`                | macOS 占位                                                        |
| `internal/sshagentproto/proto.go`          | —    | `zpass-ssh-agent-proto/src/proto.rs`                                       |                                                                  |
| `internal/sshagentproto/auth.go`           | —    | `zpass-ssh-agent-proto/src/auth.rs`                                        |                                                                  |
| `internal/sshagentproto/paths*.go`         | —    | `zpass-ssh-agent-proto/src/paths/`                                         |                                                                  |
| `cmd/zpass-agent/`                         | —    | `desktop_rs/zpass-agent/`                                                  | 二进制本体                                                        |

---

## 2. 前端目录（`desktop/frontend/`）

整个 `desktop/frontend/` 被 GPUI 重写**全部替换**。无文件级映射，只保留**业务逻辑**对照：

| 前端目录                | 对应 Rust                                                |
| ----------------------- | -------------------------------------------------------- |
| `src/features/welcome`  | `zpass-desktop/src/screens/welcome.rs`                   |
| `src/features/signin`   | `zpass-desktop/src/screens/welcome.rs`（合并）            |
| `src/features/onboarding` | `zpass-desktop/src/screens/onboarding.rs`               |
| `src/features/unlock`   | `zpass-desktop/src/screens/unlock.rs`                    |
| `src/features/vault`    | `zpass-desktop/src/screens/vault/`                       |
| `src/features/totp`     | `zpass-desktop/src/screens/totp.rs`                      |
| `src/features/generator`| `zpass-desktop/src/screens/generator.rs`                 |
| `src/features/sshagent` | `zpass-desktop/src/screens/ssh_agent.rs`                 |
| `src/features/settings` | `zpass-desktop/src/screens/settings/`                    |
| `src/features/health`   | **剥离**                                                  |
| `src/stores/*`          | `zpass-desktop/src/app/state.rs`（GPUI `Entity`）         |
| `src/lib/config-storage.ts` | `zpass-config/`                                       |
| `src/lib/vault-api.ts`  | `zpass-desktop/src/services/vault.rs` 直调 vault-service |
| `src/lib/import-bitwarden.ts` | **v1 不做**（见 `00-overview.md` § D10）           |
| `src/i18n/strings.ts`   | `zpass-desktop/locales/en.json` + `zh.json`              |
| `src/styles/tokens.css` | 由 `scripts/sync-tokens.py` → `zpass-desktop/src/theme/tokens.rs` |

---

## 3. Go 明文导出 → Rust 导入：字段映射

Go `exportservice.go` 输出的 JSON 顶层：

```json
{
  "schemaVersion": "zpass-export-v1",
  "appVersion": "0.1.0",
  "exportedAt": "<ISO 8601>",
  "itemCount": N,
  "items": [
    { "id": "...", "type": "...", "name": "...", "fields": { ... }, "createdAt": ..., "updatedAt": ... }
  ]
}
```

Rust 导入器（`zpass-desktop/src/services/import.rs`）规则：

### 3.1 顶层

- `schemaVersion == "zpass-export-v1"` → 接受
- 其它 → 报错 `UnsupportedExportVersion`

### 3.2 类型映射

| Go `type`  | Rust `ItemType`     |
| ---------- | ------------------- |
| `login`    | `Login`             |
| `card`     | `Card`              |
| `note`     | `Note`              |
| `identity` | `Identity`          |
| `ssh`      | `Ssh`               |
| `passkey`  | `Passkey`           |
| `totp`     | `Totp`              |
| `wallet`   | **降级为 `Note`**（详见 § 3.3） |

### 3.3 `wallet` → `note` 迁移逻辑（关键）

来源：Go `desktop/vaultservice.go:152-191` 的 `migrateLegacyTypeInPlace`。

> ⚠️ **Go 的 `exportservice.go` 没有应用该迁移**。导出文件里的 wallet 条目就是原始 wallet 形态。所以**完整责任在 Rust 导入器**。

规则：

```rust
fn migrate_wallet(p: &mut ImportedItem) {
    if p.r#type != "wallet" { return; }
    p.r#type = "note".into();

    let existing_notes = p.fields.get("notes").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !existing_notes.is_empty() { return; }   // 与 Go 一致：notes 非空则不动

    let address = p.fields.get("address").and_then(|v| v.as_str()).unwrap_or("").trim();
    let seed = p.fields.get("seed").and_then(|v| v.as_str()).unwrap_or("").trim();
    let mut merged = String::new();
    if !address.is_empty() {
        merged.push_str("Address: ");
        merged.push_str(address);
        merged.push('\n');
    }
    if !seed.is_empty() {
        merged.push_str("Seed phrase: ");
        merged.push_str(seed);
    }
    if !merged.is_empty() {
        p.fields.insert("notes".into(), serde_json::Value::String(merged));
    }
}
```

> 测试：`test_import_wallet_merges_address_and_seed_into_notes` 必须通过；落点 `desktop_rs/zpass-desktop/tests/import.rs`。

### 3.4 字段过滤

- 不识别的 fields key 保留原样（forward-compat）。
- `created_at` / `updated_at` 如果是字符串 ISO 8601 → 转 unix ms；如果是数字 → 直接采纳。
- 缺 `id` → 用 `Uuid::new_v4()` 生成（不复用 Go id 保证密文不可链接）。

---

## 4. 不在迁移范围内的功能

| Go 功能                                  | Rust v1 处理 |
| ---------------------------------------- | ------------ |
| `breachcheck.go`                         | 剥离          |
| `fonts*.go`                              | 剥离          |
| 前端 import-bitwarden                    | 不实现        |
| `cmd/zpass-agent` 的 `--debug` 等开发命令 | 暂不复刻；v2  |

---

## 5. 与谁衔接

- 上一篇：[`12-testing-strategy.md`](./12-testing-strategy.md)
- 下一篇：[`14-build-and-validation.md`](./14-build-and-validation.md)
