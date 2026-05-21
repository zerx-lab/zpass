# 16 — 开放问题（实施过程中再决定）

> 本表只保留**真正未决**的细节。能在 spec 阶段拍板的都已落到对应文档，不要把它们倒灌回来。
>
> 每条开放问题都写明：选项 / 当前倾向 / 决定时机 / 决定后回填到哪。

---

## OQ-1：SQLite crate 选型

**选项**：

| crate          | 优势                                                          | 劣势                                                                    |
| -------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `rusqlite`     | Rust 社区主流；async 友好（通过 `tokio-rusqlite`）；blob API 完整 | 默认链接系统 SQLite；用 `features = ["bundled"]` 内嵌 C SQLite 后体积 +1 MB |
| `libsql`       | Turso 维护，活跃；纯 Rust 子集；面向 sync                       | 子集尚未对齐 SQLite 全部 PRAGMA；社区 maturity 待观察                   |
| `sqlx`         | 编译期 query 检查（强类型）                                    | 默认 async（要拉 tokio）；本项目 vault 操作低频，编译期检查收益低        |
| `sqlite3` (`sqlite` crate) | 极简                                                           | 维护程度不高                                                            |

**当前倾向**：`rusqlite` + `bundled` feature。

**理由**：

- 与 Go `modernc.org/sqlite`（同样 bundled 纯库）哲学一致。
- 用户安装 ZPass 不需要外部 SQLite。
- 体积 +1 MB 对桌面 binary 可接受。

**决定时机**：Phase A 入场即决定（构造 `zpass-vault-store` 时）。

**决定后回填**：`02-crates.md` § zpass-vault-store / `14-build-and-validation.md` workspace deps。

---

## OQ-2：SSH agent 控制通道 IO 是否引入 tokio

**选项**：

| 方案                                       | 优势                                                              | 劣势                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **同步 std::net + std::thread + crossbeam** | 与全工作区「无 tokio」原则一致；GPUI 不冲突；调试简单              | 多连接（理论上 agent 只有一条）的并发模型代码量稍大                     |
| 仅在 `zpass-agent` binary 内起 tokio runtime | accept loop + N 连接更优雅；不污染其它 crate                       | 引入一个独立 runtime，需要保证不泄漏到 `zpass-ssh-agent-proto` 公共 API |

**当前倾向**：同步 std::net。

**理由**：

- agent 协议是请求-响应短交互，并发度低（一个 ssh 客户端一个连接）。
- 与 Go 实现的同步风格对齐，移植成本低。
- 避免任何 crate 间接拉到 tokio。

**决定时机**：Phase D 入场。

**决定后回填**：`08-ssh-agent.md`、`02-crates.md` § zpass-agent。

---

## OQ-3：`Zeroize` 在 async 边界的局限

GPUI 的 task 在跨 await 点可能把 future 移动到不同线程，期间局部变量栈拷贝会留下密钥副本。

**风险评估**：

- 我们的 vault-service 是同步的，**不**穿过 async await 点持有密钥（详见 `04-crypto-contract.md` § 8）。
- GPUI 胶水层在 `cx.background_spawn` 里调 vault：密钥进入 task 函数体，函数返回时 `Zeroizing` 抹零；future 本身**不**保存密钥跨 await。
- SSH 签名流程：GUI 拿到私钥 → 立即用 → drop。整个过程没有 await。

**当前判定**：不需要额外措施。`Zeroizing<[u8; 32]>` + 不让密钥穿 await 点是足够的。

**决定时机**：Phase D 退场时基于实际代码做一次 audit。

**决定后回填**：若 audit 发现穿 await 的情况，对应函数改成 `fn`（非 async）或显式 in-mem mask。回填 `04-crypto-contract.md` § 8。

---

## OQ-4：QR 解码 crate 选型

Go 用 `gozxing`（ZXing 移植），对带 logo 的二维码识别率高于 `jsQR`。Rust 端候选：

| crate     | 说明                                                       |
| --------- | ---------------------------------------------------------- |
| `rqrr`    | 纯 Rust 实现；轻量；对常规 QR 足够                          |
| `quircs`  | quirc 的 Rust 移植；C-quirc 已经被 ZXing 团队认可可媲美    |
| `rxing`   | ZXing 的部分 Rust 移植；最贴近 Go gozxing 行为              |

**当前倾向**：`rxing`（与 Go 行为最一致）。

**决定时机**：Phase C 入场（实现 QR service 时）。

**决定后回填**：`13-migration-checklist.md` qrservice.go 行 + `02-crates.md` desktop crate 依赖。

---

## OQ-5：浏览器扩展的 manifest 是否需要 Rust 端生成

Go 版的扩展 manifest 模板可能依赖运行时计算的 native-host 路径。Rust 版如何做？

| 选项                                              | 评估                                              |
| ------------------------------------------------- | ------------------------------------------------- |
| 手动文档（用户复制 / 编辑 .json）                  | 与 Go 版本一致，最简                              |
| `zpass-desktop` 启动时写入 OS 扩展目录            | Linux/macOS 路径稳定；Windows 注册表需要管理员权限 |

**当前倾向**：手动文档（v1）。v2 再做自动化。

**决定时机**：Phase E。

**决定后回填**：`docs/browser-extension-setup.md` + `09-browser-bridge.md`。

---

## OQ-6：日志框架

- `slog` —— Go 选择；Rust 没有同名等价物
- `tracing` —— Rust 主流，结构化，性能好
- `log` + `env_logger` —— 最简

**当前倾向**：`tracing`（订阅器在 `zpass-desktop`，每个 crate 用 `tracing::info!` 等宏）。

**决定时机**：Phase B（搭桌面 service 时）。

**决定后回填**：`14-build-and-validation.md` deps。

---

## OQ-7（已决）：`zpass-passkey` 的 p256 feature 选择

`spec/02 § 6` 原本要求 `p256 { default-features = false, features = ["ecdsa", "alloc"] }`
并允许 `zpass-passkey` 保持 `no_std + alloc`。Phase C 实施时发现：

- `EncodePrivateKey::to_pkcs8_der` 与 `EncodePublicKey::to_public_key_der` 在 p256 0.13.2
  的 trait impl 上**只在 `pem` feature 下暴露**（间接拉 `pkcs8` + `std`）。
- spec/07 § 3 公开 API 中 `private_key_pkcs8: Vec<u8>`、`public_key_spki: Vec<u8>` 是必须的
  持久化格式。

权衡选项：

| 方案 | 评价 |
|---|---|
| 自手写最小 PKCS#8 / SPKI DER 编码 | 80+ 行 ASN.1 序列化代码；维护成本大；与 `der`/`pkcs8`/`spki` crate 重复造轮子 |
| 把 SigningKey 转 SecretKey 再用 `sec1` PEM-only feature | 同样需要 pem |
| **接受 `pem + pkcs8 + std`，放弃 `zpass-passkey` 的 no_std**（**已选**） | 简单可靠；代价是该 crate 必须依赖 std；移动端 v2+ 若需要 no_std，再手写 DER 编码 |

**决定**（Phase C 实施时）：`p256` 启用 `ecdsa + alloc + pem + pkcs8 + std`，`zpass-passkey`
不再保留 `#![no_std]`（虽然源码顶仍可挂 attribute，只要不引 std API；但 `std` feature 是
传递依赖、不会让我们意外用上）。spec/02 § 6 同步更新。

> 后续 OQ：v2 评估是否值得自实现一个 ~100 行的最小 PKCS#8/SPKI 编解码以恢复 no_std。

---

## OQ-8：截图回归对比工具

Phase G 要做 「与 Go 版本三屏截图对比」。手段：

- 写一份对比脚本，跑 `playwright` 抓 Go 版本的 Wails webview / GPUI 版本的 framebuffer。
- 或者人工对比（v1 接受）。

**当前倾向**：人工对比 + 写 Markdown 比对文档。

**决定时机**：Phase G。

---

## 8. 不在本表的「应该已经决定」清单（防止倒灌）

下面这些**已经在前面的 spec 里决定**，不要再当作 open question：

| 已定项                                  | 在哪决定                                      |
| --------------------------------------- | --------------------------------------------- |
| Vault 是否兼容 Go 老格式                | `00-overview.md` § 5 → 不兼容，走明文导出导入 |
| HIBP / 健康屏是否保留                   | `00-overview.md` § 3 → 剥离                    |
| macOS Keychain / Linux libsecret 在 v1  | `10-trusted-device.md` § 2 → 不实现           |
| 字体枚举                                 | `00-overview.md` § 3 → 不实现                  |
| Crate 拆分粒度                          | `02-crates.md` → 14 个 crate                  |
| 审计日志落 vault DB 还是独立            | `03-vault-format.md` § 5 → vault DB           |
| GPUI 版本管理                           | `11-gpui-ui-architecture.md` § 2 → commit SHA pin |
| i18n 方案                               | `11-gpui-ui-architecture.md` § 4 → 嵌入式字符串表 |
| 弱 KDF 测试方式                         | `04-crypto-contract.md` § 7 → `#[cfg(test)] pub fn`，**非 cargo feature** |
| `cargo check` vs `cargo test` 关系      | `14-build-and-validation.md` § 3              |
| 阶段顺序                                | `15-phased-roadmap.md`                        |
| `VaultEventSink` trait 设计              | `05a-vault-event-model.md`                    |
| `unlock_with_dek` 入口                  | `05-vault-service-api.md` § 4.3 / `10-trusted-device.md` § 5 |

---

## 与谁衔接

- 上一篇：[`15-phased-roadmap.md`](./15-phased-roadmap.md)
- 全 spec 完
