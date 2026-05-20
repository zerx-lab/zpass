# 14 — 构建与验证

## 1. Workspace 布局

根 `Cargo.toml`（仓库根，不在 `desktop_rs/` 下）：

```toml
[workspace]
resolver = "2"
members = [
    "crates/zpass-crypto",
    "crates/zpass-vault-format",
    "crates/zpass-vault-store",
    "crates/zpass-vault-service",
    "crates/zpass-otp",
    "crates/zpass-passkey",
    "crates/zpass-trusted-device",
    "crates/zpass-ssh-agent-proto",
    "crates/zpass-browser-bridge",
    "crates/zpass-config",
    "crates/zpass-platform",
    "desktop_rs/zpass-desktop",
    "desktop_rs/zpass-agent",
    "desktop_rs/zpass-native-host",
]

[workspace.package]
edition = "2024"
rust-version = "1.95"
license = "GPL-3.0-or-later"

[workspace.dependencies]
gpui = { git = "https://github.com/zed-industries/zed", rev = "<PHASE-A-PIN>", default-features = false }
serde = { version = "1", default-features = false, features = ["derive", "alloc"] }
serde_json = { version = "1", default-features = false, features = ["alloc"] }
ciborium = { version = "0.2", default-features = false }
zeroize = { version = "1.7", features = ["derive"] }
parking_lot = "0.12"
thiserror = "1"
anyhow = "1"
uuid = { version = "1", features = ["v4"] }
rusqlite = { version = "0.31", features = ["bundled", "blob"] }
argon2 = { version = "0.5", default-features = false, features = ["alloc"] }
chacha20poly1305 = { version = "0.10", default-features = false, features = ["alloc"] }
getrandom = { version = "0.2", default-features = false }
hmac = { version = "0.12", default-features = false }
sha1 = { version = "0.10", default-features = false }
sha2 = { version = "0.10", default-features = false }
p256 = { version = "0.13", default-features = false, features = ["ecdsa", "alloc"] }
data-encoding = { version = "2", default-features = false, features = ["alloc"] }
subtle = "2"
tiny_http = "0.12"
ureq = { version = "2", default-features = false, features = ["tls"] }
publicsuffix = "2"
windows-sys = { version = "0.52", features = ["Win32_Security_Cryptography", "Win32_Foundation"] }

[profile.release]
lto = "thin"
codegen-units = 1
strip = "debuginfo"

[profile.release-native-host]
inherits = "release"
opt-level = "s"      # size-optimized；这个 binary 要小
panic = "abort"
```

> 现有的 `desktop_rs/Cargo.toml`（single-crate）将在 Phase A 入场时被替换为 `desktop_rs/zpass-desktop/Cargo.toml` 等子 crate。

`Cargo.lock` 提交到 git。

---

## 2. 各场景的 cargo 命令

> 用户的明确诉求：**优先 `cargo check + fmt`，避免全量编译**。本节落地这条原则。

### 2.1 写代码 / 改类型签名（最高频）

```bash
# 单 crate check（约 1–3 秒）
cargo check -p zpass-vault-service

# 全 workspace check（约 5–10 秒，含 GPUI 类型也只 check 不 codegen）
cargo check --workspace

# 格式
cargo fmt --all

# clippy（建议开 -D warnings 但 GPUI 自身有 lint 噪音，必要时 allow 局部）
cargo clippy -p zpass-vault-service --all-targets -- -D warnings
```

### 2.2 跑测试（中频）

`cargo check` 不能跑测试。测试时尽量按 crate：

```bash
# 单 crate test（最快路径，不触发 GPUI 编译）
cargo test -p zpass-crypto
cargo test -p zpass-vault-service

# GPUI 相关 UI 测试
cargo test -p zpass-desktop
```

`cargo test --workspace` 通常只在 Phase 退场时跑一次。

### 2.3 完整二进制 build（仅在 Phase 边界）

```bash
cargo build -p zpass-desktop                 # debug，~30–60 秒（首次 ~5 分钟）
cargo build --release -p zpass-desktop      # release，~3 分钟（首次 ~10 分钟）
cargo build --release -p zpass-native-host  # 体积优化 release
```

### 2.4 no_std 验证（Phase A 起每次 CI）

```bash
rustup target add thumbv7em-none-eabihf
cargo check -p zpass-crypto       --target thumbv7em-none-eabihf --no-default-features
cargo check -p zpass-vault-format --target thumbv7em-none-eabihf --no-default-features
cargo check -p zpass-otp          --target thumbv7em-none-eabihf --no-default-features
cargo check -p zpass-passkey      --target thumbv7em-none-eabihf --no-default-features
```

> 选 `thumbv7em-none-eabihf` 因为它的标准库只有 `core` + `alloc`，是「不依赖 std」的最严格测试 target。

---

## 3. 「`cargo check` ≠ `cargo test`」诚实声明

用户希望 dev loop 用 `cargo check + fmt`。这条原则**有效但不能误读**：

| 场景                          | 命令                                  | 说明                                                  |
| ----------------------------- | ------------------------------------- | ----------------------------------------------------- |
| 改了类型 / 函数签名 / 模块布局 | `cargo check -p <crate>`              | 最快，验证「能编」                                    |
| 改了实现细节                  | `cargo check -p <crate>` + `cargo test -p <crate>` | check 后必须跑 test 才算完成                          |
| 改了 GPUI UI 代码             | `cargo check -p zpass-desktop`        | 仍快；首次 ~30 秒（增量极快）                         |
| 跑端到端                      | `cargo build -p zpass-desktop && target/debug/zpass-desktop` | 阶段退场 / 大改动后做一次                             |

**绝不**把「`cargo check` 通过」当作「功能完成」的证据。`12-testing-strategy.md` § 2 列出的回归用例**必须**通过 `cargo test` 实际运行。

---

## 4. GPUI 加速编译

| 措施                                           | 效果                              |
| ---------------------------------------------- | --------------------------------- |
| `sccache`（不要 ccache：Rust 兼容性差）       | 重复构建 30–50% 加速              |
| `mold` linker（Linux）                         | 链接时间从 5–10 秒压到 < 1 秒      |
| `cargo-watch`                                  | `cargo watch -x 'check -p zpass-vault-service'` 自动 re-check |
| `[profile.dev] split-debuginfo = "unpacked"`   | macOS 增量更快                    |
| 关闭未用的 GPUI features                       | `default-features = false`        |

> Phase A 一开就配 `sccache`：

```bash
# Linux
cargo install sccache
echo 'export RUSTC_WRAPPER=sccache' >> ~/.profile
```

---

## 5. GPUI 升级流程

只允许独立 PR 升级 `workspace.dependencies.gpui.rev`：

1. 在仓库根：`cargo update -p gpui --precise <new-sha>`（如不行就手动改 `rev`）。
2. `cargo build --workspace --release`：全平台过编。
3. `cargo test --workspace`：所有测试过。
4. UI smoke：跑 `zpass-desktop` 截图对比关键三屏（onboarding / unlock / vault）。
5. 提交 lockfile 变更 + spec 文档记录新 SHA。

任何「顺手升 GPUI」混进功能 PR 直接 reject。

---

## 6. 二进制产物

| 二进制              | 目标体积        | 优化策略                                                       |
| ------------------- | --------------- | -------------------------------------------------------------- |
| `zpass-desktop`     | 不强约束（30–80 MB） | LTO thin，strip debuginfo                                      |
| `zpass-agent`       | < 15 MB         | LTO thin，strip debuginfo                                      |
| `zpass-native-host` | < 5 MB          | `profile.release-native-host` + `panic = "abort"` + `opt-level = "s"` |

打包目标（Phase G）：

| 平台   | 格式                         |
| ------ | ---------------------------- |
| Windows | `.msi`（WiX）或 `.exe`（cargo-wix） |
| macOS   | `.dmg` + Sparkle 升级（暂关）|
| Linux   | `AppImage` / `.deb` / `.rpm` |

---

## 7. 现有 `desktop_rs/` 处理

当前状态：
```
desktop_rs/
├── Cargo.toml          # 6 行的 single-crate 模板
└── src/main.rs         # "Hello, world!"
```

Phase A 入场第一步：

1. 删除现有 `desktop_rs/Cargo.toml` + `desktop_rs/src/`。
2. 在仓库根创建 `Cargo.toml` workspace（如上）。
3. 创建空的 `crates/zpass-crypto/Cargo.toml` + `src/lib.rs`（`#![no_std]`）。

---

## 8. 与谁衔接

- 上一篇：[`13-migration-checklist.md`](./13-migration-checklist.md)
- 下一篇：[`15-phased-roadmap.md`](./15-phased-roadmap.md)
- 相关：[`11-gpui-ui-architecture.md`](./11-gpui-ui-architecture.md) § GPUI 版本锁定
