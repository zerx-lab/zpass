# 15 — 分阶段实施路线图

## 1. 阶段一览

```
A ─► B ─► C ─► D ─► E ─► F ─► G
基础层  最小 UI  独立特性  SSH agent  浏览器桥  自动解锁  打包发布
```

每阶段都有：
- **入场标准**：上一阶段已退场
- **范围**：本阶段做的事 + **不**做的事
- **退场标准**：可机器验证的 cargo / 测试通过项

---

## 2. Phase A — 加密 + Vault 基础层

### 入场标准
- 仓库存在 `spec/` 全套（即本目录）
- `desktop_rs/` 现存的 single-crate 骨架已删除

### 范围

| 任务                                                                                   | 落点                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------- |
| 仓库根 workspace `Cargo.toml` + `Cargo.lock` 入 git                                    | `/`                                   |
| **决定**并写下 GPUI commit SHA pin（即使 Phase A 不用，B 要用，提前定）                 | `Cargo.toml` workspace.dependencies   |
| `zpass-platform` 路径 / OS 检测                                                         | `crates/zpass-platform/`              |
| `zpass-crypto`（Argon2id + XChaCha20-Poly1305 + 抹零）                                  | `crates/zpass-crypto/`                |
| `zpass-vault-format`（AAD 常量 + CBOR ItemPayloadV1）                                   | `crates/zpass-vault-format/`          |
| `zpass-vault-store`（`VaultStore` trait + `SqliteVaultStore`，schema v1）              | `crates/zpass-vault-store/`           |
| `zpass-vault-service`（含 `VaultEventSink` trait、`now_ms`、`unlock_with_dek`）         | `crates/zpass-vault-service/`         |
| 12 个回归测试用例（`12-testing-strategy.md` § 2）                                       | `crates/zpass-vault-service/tests/`   |
| `no-std` 验证 CI 任务                                                                   | CI                                    |
| `zpass-config`（原子 JSON 读写）                                                        | `crates/zpass-config/`                |
| `sccache` + `mold` 等本地加速配置文档                                                   | `docs/dev-setup.md`（或 README）       |

### **不**做

- 不引入 GPUI（除把 SHA 写进 `Cargo.toml`）
- 不实现 trusted-device / OTP / passkey / SSH agent / 浏览器桥
- 不写任何 UI

### 退场标准（任一失败即未退场）

```bash
cargo fmt --all -- --check
cargo clippy -p zpass-crypto -p zpass-vault-format -p zpass-vault-store -p zpass-vault-service -p zpass-config -p zpass-platform --all-targets -- -D warnings
cargo test -p zpass-crypto
cargo test -p zpass-vault-format
cargo test -p zpass-vault-store
cargo test -p zpass-vault-service       # 12 个回归用例全绿
cargo test -p zpass-config
cargo check -p zpass-crypto -p zpass-vault-format --target thumbv7em-none-eabihf --no-default-features
```

---

## 3. Phase B — GPUI 最小桌面壳

### 入场标准
- Phase A 退场标准全过

### 范围

| 任务                                                                                          | 落点                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 创建 `zpass-desktop` crate + `cargo build -p zpass-desktop` 跑通空窗口                       | `desktop_rs/zpass-desktop/`                   |
| 引入 `gpui-component` + `gpui-component-assets`（Input / Button / Notification / Root / WindowExt） | workspace `Cargo.toml` + `desktop_rs/zpass-desktop/Cargo.toml` |
| 主题 tokens 自动生成脚本                                                                       | `scripts/sync-tokens.py` + `tokens.rs`        |
| i18n 嵌入式字符串表（en + zh）                                                                 | `desktop_rs/zpass-desktop/locales/`           |
| 自定义 frameless 标题栏 + 拖拽区                                                               | `desktop_rs/zpass-desktop/src/widgets/titlebar.rs` |
| **welcome** 屏：欢迎 + 「Create vault / Open vault」分流                                       | `screens/welcome.rs`                          |
| **onboarding** 屏：设主密码（含强度校验）                                                       | `screens/onboarding.rs`                       |
| **unlock** 屏：输主密码 + 错误提示                                                              | `screens/unlock.rs`                           |
| **vault** 屏：item 列表 + 搜索框 + 新建 login（内联表单，3 字段）                                | `screens/vault.rs`                            |
| `VaultService` 通过 GPUI 胶水层（`services/vault.rs`）接入                                     | `desktop_rs/zpass-desktop/src/services/vault.rs` |
| 一个 `GpuiEventSink`（实现 `VaultEventSink`）让 UI 自动响应 vault 事件                        | `services/vault.rs`                           |
| `app::set_theme` / `toggle_theme` 同步 ZPass theme 与 gpui-component ThemeMode                | `app.rs`                                       |

### **不**做

- 不实现 TOTP / passkey / SSH agent / 浏览器桥 / trusted-device
- 不实现 settings / generator / sshagent 屏
- 不实现非 login 类型的表单
- 不做导入 / 导出

### 退场标准

```bash
cargo build -p zpass-desktop                       # 跑通
cargo test -p zpass-desktop                        # 含至少 6 个 #[gpui::test]：
                                                   # - welcome 渲染
                                                   # - onboarding 主密码强度提示
                                                   # - unlock 错密码红色 toast
                                                   # - vault 列表渲染
                                                   # - 创建 login 后列表立即出现该条
                                                   # - 主题切换更新 tokens
target/debug/zpass-desktop                         # 人工冒烟：能完整走 onboarding → 创建 1 条 login → 锁定 → 解锁
```

---

## 4. Phase C — TOTP / Passkey / Export / QR / 其它条目类型

### 入场标准
- Phase B 退场

### 范围

| 任务                                                                  | 落点                                              |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `zpass-otp`                                                           | `crates/zpass-otp/`                               |
| `VaultService::advance_hotp_counter`（用 `hotp_advance_mu` 锁顺序）   | `crates/zpass-vault-service/src/otp.rs`           |
| `zpass-passkey`                                                       | `crates/zpass-passkey/`                           |
| 桌面层 services：`otp.rs` / `passkey.rs` / `qr.rs` / `export.rs`      | `desktop_rs/zpass-desktop/src/services/`         |
| **totp** 聚合屏（含 login.totp + totp 类型条目）                       | `screens/totp.rs`                                 |
| 各类型表单（note / card / identity / ssh / totp / passkey 详情）       | `screens/vault/*`                                 |
| **generator** 屏（密码生成器，纯本地算法）                              | `screens/generator.rs`                            |
| **import-export** 屏（明文 JSON 导入 + 导出，含 wallet→note 迁移）     | `screens/import_export.rs`                        |

### 退场标准

```bash
cargo test -p zpass-otp -p zpass-passkey -p zpass-vault-service -p zpass-desktop
target/debug/zpass-desktop  # 人工：创建一条 TOTP；扫 QR 自动填密钥；导出再导入验证完整性
```

---

## 5. Phase D — SSH Agent（双进程）

### 入场标准
- Phase C 退场

### 范围

| 任务                                                | 落点                                                  |
| --------------------------------------------------- | ----------------------------------------------------- |
| `zpass-ssh-agent-proto`（HMAC + 帧 + 消息类型）     | `crates/zpass-ssh-agent-proto/`                       |
| `zpass-agent` binary                                 | `desktop_rs/zpass-agent/`                             |
| GUI 侧 ssh-agent host services                      | `desktop_rs/zpass-desktop/src/services/ssh_agent_host/` |
| 审计日志落 vault DB（先 ring buffer，再 flush）      | 同上 + `VaultService::append_audit`                  |
| **sshagent** 屏（开关 + 列表 + 审计日志）            | `screens/ssh_agent.rs`                                |
| 系统服务安装（systemd user / Scheduled Task / macOS stub） | `services/service_install/`                           |

### 退场标准

```bash
cargo test -p zpass-ssh-agent-proto -p zpass-desktop -p zpass-agent
# 人工：task agent:build；启动 zpass-agent；在 zpass-desktop 里启用 ssh agent；ssh-add -L 看到 vault 中 ssh 公钥；git push 成功
```

---

## 6. Phase E — 浏览器桥 + Native Host

### 入场标准
- Phase D 退场

### 范围

| 任务                                                                          | 落点                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| `zpass-browser-bridge`（HTTP server + 协议 + 域名匹配）                       | `crates/zpass-browser-bridge/`                |
| `zpass-native-host` binary（**零 GPUI**，profile.release-native-host）        | `desktop_rs/zpass-native-host/`                |
| GUI 侧 services 接 `VaultFacade` 实现                                          | `desktop_rs/zpass-desktop/src/services/browser_bridge.rs` |
| 浏览器扩展的 manifest 安装文档                                                  | `docs/browser-extension-setup.md`             |

### 退场标准

```bash
cargo test -p zpass-browser-bridge -p zpass-native-host
# 人工：装 Chrome 扩展（复用现有 extension/）；在站点 popup 看到 vault 凭据；点击自动填充
# 体积验证：ls -lh target/release-native-host/zpass-native-host  < 5 MB
```

---

## 7. Phase F — Trusted Device + 审计持久化 + 系统服务

### 入场标准
- Phase E 退场

### 范围

| 任务                                                                  | 落点                                              |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `zpass-trusted-device`（Windows DPAPI + macOS/Linux stub）            | `crates/zpass-trusted-device/`                    |
| 桌面层串联（`services/trusted_device.rs`）                             | `desktop_rs/zpass-desktop/src/services/`         |
| **settings** 屏增加「信任此设备」开关                                  | `screens/settings/`                               |
| SSH agent 审计日志真正 flush 到 vault DB（Phase D 的 TODO 收尾）       | `services/ssh_agent_host/audit.rs`                |
| `Idle lock timeout`                                                    | `services/idle_lock.rs`                           |

### 退场标准

```bash
cargo test -p zpass-trusted-device -p zpass-desktop      # Windows runner 跑 DPAPI 用例
# 人工 Windows：启用「信任此设备」→ 重启 GUI → 自动解锁；在 macOS / Linux：开关置灰
```

---

## 8. Phase G — 打包 + 抛光

### 入场标准
- Phase F 退场

### 范围

| 任务                                            | 落点                                          |
| ----------------------------------------------- | --------------------------------------------- |
| 安装包：`.msi` / `.dmg` / `AppImage`            | `packaging/`                                  |
| 自动签名（Apple / Windows）的占位（不引入云）   | 文档                                          |
| 性能 profiling + 关键热路径优化                  | 视基准而定                                    |
| 截图回归对比 Go 版本三屏（onboarding / unlock / vault） | `tests/screenshots/`                          |
| README 与发布说明                                | `desktop_rs/README.md`                        |

### 退场标准（v1 发布门槛）

```bash
cargo test --workspace
# 三平台都能 cargo build --release 出产物，且通过签名后能在 clean VM 上启动
```

---

## 9. 阶段间的硬约束

1. **不允许跳阶段**。例如不允许「Phase B 没退场就开始 Phase D 的 SSH agent」—— 早期 vault-service API 不稳定，下游 crate 会被迫重构。
2. **阶段退场后才升 GPUI**。GPUI 升级走独立 PR，不混进 Phase 推进 PR。
3. **每个 Phase 退场前更新 `spec/`**。退场过程中发现的设计偏差必须回填到对应 spec 文档；不允许「文档写一套、代码做另一套」。

---

## 10. 与谁衔接

- 上一篇：[`14-build-and-validation.md`](./14-build-and-validation.md)
- 下一篇：[`16-open-questions.md`](./16-open-questions.md)
