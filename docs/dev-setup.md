# 开发环境前置

Phase A 退场所需的工具链、target 与可选加速措施。

## 1. Rust 工具链

```bash
# Rust 1.95+ (workspace.rust-version 锁定)
rustup default stable
rustup component add rustfmt clippy
```

## 2. 跨平台 target（no_std 验证用）

`spec/04 § 2` 要求 `zpass-crypto` / `zpass-vault-format` 在 `thumbv7em-none-eabihf` 上 `cargo check` 通过：

```bash
rustup target add thumbv7em-none-eabihf

cargo check -p zpass-crypto      --target thumbv7em-none-eabihf --no-default-features
cargo check -p zpass-vault-format --target thumbv7em-none-eabihf --no-default-features
```

> Phase C 接入 `zpass-otp` / `zpass-passkey` 时同样要过这条线。

## 3. 加速措施（可选）

`spec/14 § 4` 推荐，本地体验显著更好，不强制。

### sccache（编译缓存）

```bash
cargo install sccache
echo 'export RUSTC_WRAPPER=sccache' >> ~/.profile
```

### mold（Linux 链接器）

```bash
# Arch / Manjaro
sudo pacman -S mold
# Ubuntu 22.04+
sudo apt install mold

# 仓库根 .cargo/config.toml（若尚未存在则按需创建）：
# [target.x86_64-unknown-linux-gnu]
# linker = "clang"
# rustflags = ["-C", "link-arg=-fuse-ld=mold"]
```

### cargo-watch（自动重检）

```bash
cargo install cargo-watch
cargo watch -x 'check -p zpass-vault-service'
```

## 4. 常用 cargo 命令清单（按频率）

```bash
# 写代码循环（最高频；不触发 GPUI 编译）
cargo check -p zpass-vault-service
cargo check --workspace
cargo fmt --all

# 跑测试（中频）
cargo test -p zpass-vault-service
cargo test -p zpass-crypto -p zpass-vault-format -p zpass-vault-store -p zpass-vault-service -p zpass-config -p zpass-platform

# Phase A 退场全套（低频，每个 Phase 边界跑一次）
cargo fmt --all -- --check
cargo clippy -p zpass-crypto -p zpass-vault-format -p zpass-vault-store -p zpass-vault-service -p zpass-config -p zpass-platform --all-targets -- -D warnings
cargo check -p zpass-crypto -p zpass-vault-format --target thumbv7em-none-eabihf --no-default-features
```

## 5. Phase A 与 spec 的两处已知偏离

在跑 Phase A 退场命令前请知悉：

1. **GPUI 依赖未 pin commit SHA**
   `spec/14 § 1` 要求 `gpui = { ... rev = "<PHASE-A-PIN>" }`，本仓库根 `Cargo.toml` 当前用户决定写为
   ```toml
   gpui = { git = "https://github.com/zed-industries/zed" }
   ```
   不带 `rev` 字段。这意味着 `Cargo.lock` 在第一次 Phase B 解析后才会锁定一个具体 commit，后续手动 `cargo update -p gpui` 才会漂移。Phase A 期间没有任何 crate 实际依赖 `gpui`，所以 lockfile 不会出现该 entry。**Phase B 入场前需补 `rev`**。

2. **`zpass-crypto` 的 `os-rng` feature**
   `spec/04 § 2` 把 `getrandom` 写为非可选依赖。但 `getrandom 0.2.x` 在 `thumbv7em-none-eabihf` 上没有默认 backend，`cargo check --no-default-features` 会因此失败。我们采取的妥协：
   - `zpass-crypto` 把 `getrandom` 声明为 `optional`，新增 feature `os-rng`（默认开）。
   - `random_bytes` / `random_key` / `seal_aead` 仅在 `os-rng` 启用时存在。
   - 新增 `seal_aead_with_nonce(key, nonce, plaintext, aad)`，在 no_std 嵌入式场景下由调用方提供 nonce。
   - `zpass-vault-format` 镜像同名 feature，链式传递。

   桌面 / 移动端 default feature 行为与 spec 一致；嵌入式 target 仅丢失 RNG 入口，等价于「该 target 不实际部署」的事实（spec/00 § 3 D6 已明确移动 / 嵌入式 v1 仅过 `cargo check`，不要求运行）。

## 6. Phase B 入场清单（提前列出）

- [ ] 把 `Cargo.toml` 中 `gpui` 行补上 `rev = "<具体 SHA>"`（**仍未做**，见 § 7）。
- [x] 跑 `cargo build -p zpass-desktop`（首次约 5 分钟，拉取 GPUI 及其传递依赖）。
- [ ] 装 `sccache` + `mold`（强烈推荐）。

## 7. Phase B 退场实际偏离

### 7.1 GPUI / gpui-component 仍未 pin commit SHA

`spec/11 § 2` 要求 `gpui = { git = "...", rev = "<40 字符 SHA>" }`。Phase B 退场时
workspace `Cargo.toml` 中 `gpui`、`gpui_platform`、`gpui-component`、`gpui-component-assets`
**仍未 pin**。原因：`Cargo.lock` 已经把 gpui 解析到 `068d64edd637be2e7e2a44b99ef4965550885b67`，
日常 `cargo build` / `cargo test` 命中 lockfile，工作流不受影响。

风险：跨机器同步 lockfile 后 `cargo update -p gpui` 会让两个仓库走偏。Phase C 起把
pin 加上去（独立提交）。

### 7.2 引入 gpui-component（计划之外的依赖）

`spec/15 § 3` Phase B 范围表没有列 gpui-component，但用户在 Phase B 期间评估后
决定全量采用：

- `Input` / `Button` / `Notification` / `Root` / `WindowExt` 大幅减少自绘工作量。
- 与 spec/00 § D6（设计 tokens 单一真相源）不冲突 —— gpui-component 的 ThemeColor
  与 ZPass 自有 `theme/tokens.rs` 并存，前者驱动 gpui-component 组件，后者驱动
  自绘部分。两套主题通过 `app::set_theme()` 同步切换（dark/light）。

后续 spec 更新计划：把 gpui-component 写入 `spec/15 § 3` 的 Phase B 范围表（已
在本仓库本次提交中完成）。

### 7.3 Onboarding / Unlock 的密码强度计算是 pull-based

gpui-component `InputState::set_value` 不触发 `InputEvent::Change`（见
`crates/ui/src/input/state.rs:717` `emit_events = false`），因此「订阅密码变化更新
strength label」的 push 模型在测试中无法工作。改为：

- `OnboardingView::strength_key(&self, cx: &App) -> &'static str` 每次 `render` 调用，
  从当前 `password_state.value()` 实时计算。
- 用户真实键盘输入仍会触发 `InputEvent::Change`（让 `error_key` 清空 + 重渲染），
  从而经 `strength_key()` 反映到 UI。

测试中通过 `set_value` 注入密码即可；不需要模拟键盘。
