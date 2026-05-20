# 00 — 总览：目标、非目标、剥离清单

## 1. 一句话目标

> 把 `desktop/`（Go + Wails 3，约 1.6 万行）的全部**本地**能力以 Rust 重写为 `desktop_rs/`（GPUI 原生渲染），过程中拆出可被 Android / iOS 复用的 crypto / vault crate，并用类 Zed 的测试范式锁死回归。

「本地」二字是核心：本次重写**不带任何云能力**。

---

## 2. 离线优先公理（不可违背）

> **第一版 ZPass desktop_rs 在编译期就不能产生任何主动向互联网发起请求的代码路径。**

具体含义：

- 仓库依赖（`Cargo.toml`）中**不允许**引入 `reqwest` / `hyper` 之类作为 vault / OTP / passkey / trusted-device 等核心 crate 的 **运行时** 依赖。仅 `dev-dependencies` 中可短暂出现用于本地 mock。
- `zpass-desktop` 二进制对外的 socket 监听允许（浏览器扩展桥 + SSH agent 控制通道），但必须仅监听 loopback / Unix socket，绑定到外网或 0.0.0.0 视为重大缺陷。
- 没有 telemetry，没有崩溃上报，没有更新检查。

---

## 3. 显式剥离清单（v1 不实现）

| 序号 | 功能                                                                              | 原 Go 文件                                                  | v1 剥离理由                                                                                            |
| ---- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| D1   | **HIBP 密码泄露检查**（Pwned Passwords API k-Anonymity）                          | `breachcheck.go`（448 行）+ `VaultService.breachCache` 字段 | 唯一的真·云依赖；用户明确要求剥离                                                                      |
| D2   | **「健康」/ Health 屏幕**                                                         | `frontend/src/features/health/*`                            | 该屏幕的唯一功能就是展示 D1 的结果，没有剥离 D1 就没有渲染源                                           |
| D3   | **macOS Keychain trusted-device 实现**                                            | `trusteddevice_unsupported.go` 在 macOS 上即此 stub         | Go 现状即未实现；与 Go 完全对齐                                                                        |
| D4   | **Linux libsecret trusted-device 实现**                                           | `trusteddevice_unsupported.go` 在 Linux 上即此 stub         | Go 现状即未实现；与 Go 完全对齐                                                                        |
| D5   | **系统字体枚举 `FontService`**                                                    | `fonts.go` + `fonts_{darwin,linux,windows}.go`              | GPUI 自带字体子系统，Settings 的字体选择改为「Geist / Geist Mono / 系统默认」固定三项                  |
| D6   | **Android / iOS 实际编译产物**                                                    | —                                                           | v1 仅保证 crate 边界正确（`zpass-crypto` / `-vault-format` / `-vault-service` 可在 no_std 目标过 check），不交付 mobile CI |
| D7   | **加密导出（age / gpg / 7z 包装）**                                               | —                                                           | Go 也只有明文 JSON 导出；保持一致，由用户自己叠加加密层                                                |
| D8   | **多 vault 支持**                                                                 | —                                                           | Go 单 vault，Rust v1 同样单 vault                                                                      |
| D9   | **任何形式的云同步**                                                              | —                                                           | 见公理 2                                                                                               |
| D10  | **Bitwarden / 1Password 导入器**                                                  | `frontend/src/lib/import-bitwarden.ts`                      | 前端纯逻辑，v1 暂不重做；将来可独立加 `zpass-import-bitwarden` crate                                  |
| D11  | **自动更新（GitHub Releases）**                                                   | —                                                           | Go 也未实现                                                                                            |
| D12  | **SSH agent 签名审批 UI**                                                         | `sshagent` 屏幕的审批对话框；Go MVP 是 auto-approve         | 与 Go MVP 行为一致：vault 解锁状态下自动批准，记审计；下版本再做                                       |

> ⚠️ 任何把 D1–D12 重新拉回 v1 的提议必须在 PR 描述里显式标注「重新引入 D#，理由：…」并经用户批准。

---

## 4. v1 必须保留的能力清单

按用户答复，下列**全部**为 v1 范围：

1. Vault 核心：主密码 / 解锁 / 锁定 / CRUD / 改主密码 / 备份格式（**全新 SQLite schema**，不读旧 Go vault）
2. TOTP / HOTP / Steam Guard
3. Passkey（WebAuthn ES256，仅 vault 内生成 / 列表 / 断言；浏览器集成是 D 段的桥）
4. SSH agent（双进程：`zpass-agent` 守护 + GUI 控制通道）
5. 浏览器扩展 native messaging 桥（`zpass-native-host` stdio 二进制 + GUI 内 HTTP 桥）
6. Trusted Device 自动解锁（**仅 Windows DPAPI**，macOS/Linux 保持 stub，见 D3 / D4）
7. 明文导出（用户主动 + 二次确认主密码）
8. QR 解码（TOTP 配置二维码扫描）
9. SSH agent 签名审计日志（落 vault DB，不再仅内存 ring buffer）

---

## 5. 数据迁移策略（与 v1 范围解耦）

- **不读 Go vault.db**：用户的决定（"全新格式"）。
- 老用户的迁移路径：
  1. 在 Go 版本里点「明文导出 → JSON」拿到一份文件。
  2. 在 Rust 版本里点「从 ZPass JSON 导入」吃进来。
- 导入器必须处理 Go 侧 `legacyWalletType = "wallet"` 的迁移逻辑（见 `13-migration-checklist.md` 与 `desktop/vaultservice.go:152-191` 的 `migrateLegacyTypeInPlace`）。Go 的 `exportservice.go` 在导出时**不**应用此迁移，所以责任完全在 Rust 导入器。

---

## 6. 各阶段成功标准（与 `15-phased-roadmap.md` 对齐）

| 阶段 | 完成条件                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| A    | `zpass-crypto` / `-vault-format` / `-vault-store` / `-vault-service` 四 crate 全部 `cargo test` 通过；9 个移植的 Go 用例全绿；`cargo check --target` 验证 crypto / vault-format 可在 no_std + alloc 下 build |
| B    | GPUI 桌面壳跑起来：欢迎屏 + onboarding（设主密码） + unlock + vault 列表 + 单条 login 的增改详情，端到端走 vault-service       |
| C    | TOTP / Passkey / QR / 导出 四特性的 UI 与 vault 集成完成                                                                       |
| D    | SSH agent 端到端：`ssh-add -L` 看到 vault 中 ssh 条目的公钥；`git push` 可走 vault 签名（auto-approve）                       |
| E    | Chrome 扩展通过 `zpass-native-host` 与 GUI 通信，能完成「列出 origin 凭据 / 揭示密码 / 生成当前 TOTP」三个操作                |
| F    | Windows 上启用「信任此设备」后重启 GUI 无需输入主密码即解锁；审计日志可在 settings 页查询最近 100 条                          |
| G    | 安装包（msi / dmg / AppImage）+ 跨平台 CI；与 Go 版本做 UI 截图回归对比                                                        |

---

## 7. 与 Zed 项目的设计参考

借鉴但不照抄：

- **多 crate 工作区**：是的（见 `02-crates.md`）。
- **GPUI `#[gpui::test]` 与 `TestAppContext`**：是的，所有 UI 测试走它（见 `12-testing-strategy.md`）。
- **deterministic executor（advance_clock）**：是的，时间相关测试用 `cx.executor().advance_clock(d)`。
- **Zed 自身的 60+ crate**：仅作灵感，不必复刻数量；本项目目标 ~14 个 crate（见 `02-crates.md`）。

---

## 与谁衔接

- 下一篇：[`01-architecture.md`](./01-architecture.md) —— 二进制与 crate 拓扑
- 平行参考：[`15-phased-roadmap.md`](./15-phased-roadmap.md) —— 阶段细化
