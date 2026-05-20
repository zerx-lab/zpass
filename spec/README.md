# ZPass `desktop_rs` 重构规范

本目录是把现有 `desktop/`（Go + Wails 3）重写为 `desktop_rs/`（Rust + GPUI）的**规范文档集**。所有重写工作必须依据这些文档执行，每个阶段的产出可对照本目录里相应文件的「验收标准」自查。

文档语言约定：**中文为主，标识符 / API 名 / cargo 命令保持英文**。

---

## 阅读顺序

```
00 → 01 → 02 → 03 → 04 → 05 → 05a → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 15 → 16
```

第一次阅读建议从 `00` 顺读到 `02` 形成全局观，再按需深入个别文档。每一篇结尾都有「与谁衔接」一节，指明下一步该读什么。

---

## 文档清单

| #     | 文件                             | 一句话内容                                                                                                |
| ----- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 00    | `00-overview.md`                 | 目标 / 非目标 / 显式剥离的功能清单 / 离线优先公理 / 各阶段成功标准                                        |
| 01    | `01-architecture.md`             | 三进程模型（`zpass-desktop` + `zpass-agent` + `zpass-native-host`）+ workspace 布局 + crate 依赖拓扑     |
| 02    | `02-crates.md`                   | 全部 crate 的权威清单：每个 crate 的职责、移动端可复用与否、直接依赖、禁止循环依赖                       |
| 03    | `03-vault-format.md`             | 全新 SQLite schema（四张表）+ 加密 blob 二进制布局 + AAD 上下文常量；**审计日志落 vault DB**             |
| 04    | `04-crypto-contract.md`          | Argon2id + XChaCha20-Poly1305（RustCrypto）+ zeroize 规则 + `no_std + alloc` 硬约束 + 弱 KDF 测试用法    |
| 05    | `05-vault-service-api.md`        | 高层 API 一一对照：`Initialize / Unlock / Lock / CRUD / ChangeMasterPassword / unlock_with_dek / nowMs` |
| 05a   | `05a-vault-event-model.md`       | `VaultEventSink` trait（解锁/锁定/CRUD 事件）+ 注入机制 + SSH agent 与浏览器桥的订阅方式                  |
| 06    | `06-otp.md`                      | `zpass-otp`：TOTP / HOTP / Steam 纯计算；HOTP 计数器持久化由 VaultService 负责                            |
| 07    | `07-passkey.md`                  | WebAuthn ES256：CBOR / COSE / sign-count 持久化 / self-attestation                                       |
| 08    | `08-ssh-agent.md`                | 双进程：`zpass-agent` 守护进程 + GUI 控制通道 + 签名审批异步在桌面层 / vault 层仅暴露同步 `decrypt_ssh_key` |
| 09    | `09-browser-bridge.md`           | GUI 内 HTTP 桥 + `zpass-native-host` 独立 crate（**零 GPUI 依赖**） + 域名黑名单                          |
| 10    | `10-trusted-device.md`           | v1 = Windows DPAPI；macOS / Linux **保持 stub**，与 Go 现状一致                                          |
| 11    | `11-gpui-ui-architecture.md`     | GPUI 接入：theme tokens 自动生成 / 嵌入式 i18n 字符串表 / 屏幕清单（不含 health）/ Phase B 仅 3 屏       |
| 12    | `12-testing-strategy.md`         | Zed 测试范式 + 9 个 Go 回归用例显式移植 + `#[gpui::test]` + `TestAppContext` + AEAD 防搬移              |
| 13    | `13-migration-checklist.md`     | Go 文件到 Rust crate 的逐文件映射 + wallet→note 迁移在 importer 中显式处理                                |
| 14    | `14-build-and-validation.md`     | workspace 在仓库根；GPUI 锁定 commit SHA；`cargo check / fmt / test / build` 各自适用场景                |
| 15    | `15-phased-roadmap.md`           | Phase A→G 实施路线图：每阶段入场 / 退场标准                                                              |
| 16    | `16-open-questions.md`           | 真正未决的实现细节：SQLite crate 选型 / SSH agent IPC 同步异步 / zeroize 在 async 中的边界               |

---

## 文档维护原则

1. **任何 Phase 退场前发现的偏离都要回填到对应文档**，而不是只改代码不改文档。
2. **规格冲突时以编号更小的文档为准**。例如 `02-crates.md` 与 `15-phased-roadmap.md` 关于阶段范围若冲突，以 `02` 的 crate 依赖关系为底线，Phase 计划必须服从它。
3. **新增 spec 文档必须更新本 README**。

---

## 与 `AGENTS.md` 的关系

仓库根 `AGENTS.md` 与本 `spec/` 是**互补**关系：

- `AGENTS.md` 描述 ZPass 整个仓库（Design / website / desktop / desktop_rs）的高层约定与禁忌。
- `spec/` 仅描述 **desktop_rs 这一次重写**的细节。两者发生冲突时，spec 优先级更高（更新更近、更具体）。

`desktop/AGENTS.md`（如存在）继续描述 Go 版本桌面端，与本目录无关。
