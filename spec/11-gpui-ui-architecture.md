# 11 — GPUI UI 架构

## 1. 总览

`zpass-desktop` 是唯一 import `gpui` 的 crate。本文规定：

- GPUI 版本锁定策略（git rev pin）
- 主题 tokens 的单一真相源 + 自动生成
- i18n 方案（嵌入式字符串表）
- 屏幕清单与导航
- frameless 标题栏的实现路径
- Phase B 的最小屏幕集

---

## 2. GPUI 版本锁定（关键 Phase A 步骤）

**GPUI 没有 stable release tag**，Zed 在 main 上做有破坏性变更。任何 `cargo update` 都可能让我们的 build 凭空挂掉。

策略：

```toml
# 根 Cargo.toml
[workspace.dependencies]
gpui = { git = "https://github.com/zed-industries/zed", rev = "<具体 commit SHA>", default-features = false }
```

要求：

1. `rev` 是具体的 40 字符 commit SHA，不是 branch / tag。
2. `Cargo.lock` **提交到 git**。
3. 升级流程文档化（详见 `14-build-and-validation.md` § GPUI 升级流程）。
4. 在 Phase A 初始化 workspace 时一次性确定 SHA；中途升级须独立 PR + 全量回归。

> Phase A entry 的第一步即是「定一个 GPUI rev 并跑通空 GUI」。

---

## 3. 主题 tokens 单一真相源 + 自动生成

### 3.1 问题

`AGENTS.md` 要求 `ZPassDesign/src/tokens.css` / `website/src/styles/tokens.css` / `desktop/frontend/src/styles/tokens.css` 三处 tokens 保持同步。Rust 版本如果再手抄一份就有四个副本。

### 3.2 决策

`ZPassDesign/src/tokens.css` 是**单一真相源**。提供一个脚本：

```
scripts/sync-tokens.py
```

读 `tokens.css` 解析 `:root` / `[data-theme="dark"]` 等 selector，输出：

- `website/src/styles/tokens.css`（直接 copy）
- `desktop/frontend/src/styles/tokens.css`（直接 copy）
- **`desktop_rs/zpass-desktop/src/theme/tokens.rs`**（解析 + 类型化）

例：

```rust
// 由 scripts/sync-tokens.py 自动生成；不要手改！
pub mod dark {
    use gpui::Hsla;
    pub const BG: Hsla = Hsla { h: 220.0/360.0, s: 0.04, l: 0.05, a: 1.0 };
    pub const FG: Hsla = Hsla { ... };
    pub const LINE: Hsla = Hsla { ... };
    pub const ACCENT: Hsla = Hsla { ... };
    // ...
}
pub mod light { /* ... */ }
```

CI 任务：在每次 PR 检查 `cargo run --bin sync-tokens -- --check` 或同等 python 脚本是否产生改动；有则 fail。

> 这样设计能让 GPUI 的 `cx.theme()` / `cx.color()` 严格对齐 `tokens.css`，主题切换 `<html data-theme="dark|light">` 在 GPUI 侧映射为 `cx.set_appearance(Appearance::Dark|Light)`。

### 3.3 字体

- 内置：`Geist Sans` + `Geist Mono`，作为 `assets/` 嵌入 binary（`include_bytes!`），通过 GPUI 的 `cx.text_system().add_fonts(...)` 注册。
- **不**实现 FontService 系统字体枚举（见 `00-overview.md` § D5）。

---

## 4. i18n：嵌入式字符串表

### 4.1 方案

- 不引入 `fluent` / `gettext`。两种语言、~200 keys，hand-rolled 表更直观。
- 翻译来源：`crates/zpass-desktop/locales/en.json` + `zh.json`，编译时 `include_str!` 嵌入。

```rust
// crates/zpass-desktop/src/i18n/mod.rs

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
struct LocaleData(HashMap<String, String>);

static EN: &str = include_str!("../../locales/en.json");
static ZH: &str = include_str!("../../locales/zh.json");

pub struct I18n {
    current: Locale,
    data: HashMap<Locale, LocaleData>,
}

pub enum Locale { En, Zh }

pub fn t(key: &str) -> &'static str {
    // 从当前 GPUI cx 拿 I18n 单例，返回 key 对应的字符串；
    // miss 时返回 key 本身（与前端 i18next fallback 一致）
}
```

### 4.2 同步规则

- 新增 key 必须 `en.json` + `zh.json` 同步增；CI lint 校验两文件 key 集合完全相同。
- 现有 `desktop/frontend/src/i18n/strings.ts` 在迁移时作为参考来源。

---

## 5. 屏幕清单（Phase 终态）

```
welcome           — 启动屏：选择「创建 vault」/「打开 vault」
onboarding        — 设主密码（含强度提示）
unlock            — 输主密码解锁
vault             — 条目列表 + 搜索 + 工具栏
   vault/login    — 新建 / 编辑 login 条目
   vault/note     — note 表单
   vault/card     — card 表单
   vault/identity — identity 表单
   vault/ssh      — ssh 表单
   vault/totp     — totp 表单
   vault/passkey  — passkey 详情（仅查看 + 删除）
totp              — TOTP 聚合视图（含 login.totp + totp 类型条目）
generator         — 密码生成器
sshagent          — SSH agent 设置 + 审计日志
settings          — 偏好（主题 / 语言 / 字体 / 锁定超时 / 信任设备开关）
import-export     — 导入 ZPass JSON / 导出
```

显式**不在**清单：

- ❌ `health` —— 配合 HIBP 剥离（见 `00-overview.md` § D2）

---

## 6. Phase B 最小屏集

```
welcome → onboarding → unlock → vault（仅 login 类型的新建 / 编辑 / 查看 / 删除）
```

Phase B **不**实现的 UI：

- 任何 settings / generator / sshagent / totp / passkey 屏
- 任何非 login 类型的表单
- 任何 import-export

> 设计动机：让 GPUI 的窗口骨架 / 路由 / 主题 / 拖拽 / 命令面板 / 自定义标题栏在 Phase B 全跑通，但保持 UX 表面积最小，避免后续阶段反复推翻导航结构。

后续阶段添加屏幕时遵循「特性自带 UI」原则（Zed 模式）：

| 阶段 | 新增屏                                     |
| ---- | ------------------------------------------ |
| C    | totp、generator、note / card / identity / ssh / totp 类型表单、passkey 详情、import-export |
| D    | sshagent（设置 + 审计） |
| F    | settings 的「信任此设备」开关 |

---

## 7. 自定义标题栏 / Frameless

GPUI 原生支持 frameless（`WindowOptions::titlebar = Some(TitlebarOptions::Hidden { ... })` 或类似）。

- **macOS**：保留红绿灯，左侧预留 80 px 插槽（参考 GPUI 的 `TitlebarOptions::HiddenInset`）。
- **Windows / Linux**：自绘最小化 / 最大化 / 关闭 三按钮（位于右上）。
- 拖拽区：通过 GPUI 的「drag region」API（与 Wails 的 `--wails-draggable: drag` 等价）。
- 启动背景色：与 dark `--bg` token 一致，避免首帧白闪（在 `WindowOptions::background_color` 设）。

KDE Plasma 双标题栏问题（Go 版的 `third_party/wails-v3/` 补丁）在 GPUI 下**不存在** —— GPUI 自己管 GTK 窗口属性。

---

## 8. 与 vault-service 的胶水层

```
crates/zpass-desktop/src/services/
├── vault.rs           # 持有 Arc<VaultService<SqliteVaultStore>>；包装 GPUI Task<T>
├── otp.rs             # 调 zpass-otp + vault.get_item 协同
├── passkey.rs         # 同上
├── ssh_agent_host.rs  # 启停 / 推 keys / 处理签名 / 审计
├── browser_bridge.rs  # 启停 HTTP server
├── trusted_device.rs  # try_auto_unlock + enable + disable
├── export.rs          # 明文 JSON 导出 + 系统 SaveFile dialog
├── qr.rs              # QR 解码（gozxing 的 Rust 等价：调 `rqrr` 或 `quircs`）
└── i18n.rs            # i18n 单例
```

每个文件主要做三件事（详见 `01-architecture.md` § GPUI 胶水层）：

1. 把同步业务调用包到 `cx.background_spawn(...)`。
2. 实现 `VaultEventSink` 将业务事件转 `cx.emit(...)`。
3. 测试时用 `cx.executor().advance_clock(d)` 控制时间。

---

## 9. 状态管理：用 GPUI 的 `Entity<T>` 而非 zustand

Go 版用 zustand `createWailsConfigStorage` 落盘到 `~/.config/zpass/`。Rust 版换成：

- **持久化偏好**：`zpass-config` crate 提供原子 JSON 读写（与 Go 等价）。
- **运行时状态**：GPUI `Entity<T>` + `Model<T>`，无第三方 store。

```rust
struct AppState {
    vault: Arc<VaultService<SqliteVaultStore>>,
    locale: Locale,
    theme_pref: ThemePref,    // System / Light / Dark
    locked_idle_timeout: Duration,
}
```

`AppState` 通过 `cx.set_global(state)` 注入，组件 `cx.global::<AppState>()` 取用。

---

## 9a. 密码生成器（Phase C 的 `generator` 屏）

`generator` 屏纯本地、无 vault 依赖，单独在此说明算法契约（避免另起一篇 spec）。

### 9a.1 输入

| 参数        | 范围          | 默认 |
| ----------- | ------------- | ---- |
| `length`    | 8..=128       | 20   |
| `uppercase` | bool          | true |
| `lowercase` | bool          | true |
| `digits`    | bool          | true |
| `symbols`   | bool          | true |
| `avoid_ambiguous` | bool（去 `0/O/1/l/I` 等） | false |

至少有一个字符类被勾选；否则 UI 禁用「生成」按钮。

### 9a.2 算法

```rust
fn generate(opts: &GenOpts) -> Zeroizing<String> {
    let mut pool: Vec<char> = Vec::new();
    if opts.lowercase { pool.extend("abcdefghijklmnopqrstuvwxyz".chars()); }
    if opts.uppercase { pool.extend("ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars()); }
    if opts.digits    { pool.extend("0123456789".chars()); }
    if opts.symbols   { pool.extend("!@#$%^&*()-_=+[]{};:,.<>?/".chars()); }
    if opts.avoid_ambiguous {
        pool.retain(|c| !matches!(c, '0' | 'O' | 'o' | '1' | 'l' | 'I'));
    }
    let mut bytes = vec![0u8; opts.length];
    getrandom::getrandom(&mut bytes).expect("CSPRNG");
    let mut out = String::with_capacity(opts.length);
    for b in bytes {
        out.push(pool[(b as usize) % pool.len()]);
    }
    Zeroizing::new(out)
}
```

> **`getrandom` 不是 `rand::thread_rng`**：与 vault crypto 路径一致用 OS CSPRNG。模 bias 在 `pool.len() <= 95` 时小于 1 bit 损失，可接受；如要严格无 bias，用 rejection sampling 重抽。

### 9a.3 熵估计（仅 UI 展示）

```
entropy_bits = length * log2(pool.len())
```

UI 展示「弱 / 中 / 强 / 极强」分档：< 40 / 40–60 / 60–80 / > 80 bits。

### 9a.4 落点

```
crates/zpass-desktop/src/services/generator.rs   # 算法 + 熵估计（< 100 行，单独成文件方便单测）
crates/zpass-desktop/src/screens/generator.rs    # 屏幕 + 复制按钮
```

### 9a.5 测试

| 测试                              | 断言                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `generator_respects_length`       | 输出长度恰好 = `length`                                      |
| `generator_uses_only_enabled_classes` | 仅 digits 时，输出只含 0–9                                   |
| `generator_avoid_ambiguous`       | 启用后输出不含 `0/O/o/1/l/I`                                 |
| `generator_no_class_returns_err`  | 全部字符类关闭时返回错误（UI 已禁用按钮，但 API 层防御性校验）|
| `entropy_bits_known`              | length=20, all classes on, no avoid → bits == 20 * log2(95) ≈ 131 |

---

## 10. 命令面板（Cmd+K）

GPUI 有惯例的 `Workspace::action`。命令面板内置：

- Vault Lock
- New Login / New Note / ...
- Switch Theme
- Switch Language
- ...

具体动作清单在 Phase C 末尾确定（与 generator / settings 一起）。

---

## 11. 测试

| 测试                                  | 位置                                       |
| ------------------------------------- | ------------------------------------------ |
| `tokens_sync_check`                   | CI（脚本对比）                              |
| `i18n_keys_align`                     | `crates/zpass-desktop/tests/`：解析 en + zh，断言 key 集合相等  |
| `welcome_screen_renders`              | `#[gpui::test]` + `TestAppContext`         |
| `unlock_wrong_password_shows_error`   | 同上                                        |
| `vault_screen_lists_created_items`    | 同上                                        |
| `lock_after_idle_timeout`             | `cx.executor().advance_clock(timeout)`     |
| `theme_switch_updates_tokens`         | 同上                                        |

UI 测试一律 headless（不要求 GPU）：

```
cargo test -p zpass-desktop
```

无 `--no-default-features` 也必须可跑（GPUI 的 `TestAppContext` 不依赖 GPU）。

---

## 12. 与谁衔接

- 上一篇：[`10-trusted-device.md`](./10-trusted-device.md)
- 下一篇：[`12-testing-strategy.md`](./12-testing-strategy.md)
- 相关：[`14-build-and-validation.md`](./14-build-and-validation.md) —— GPUI 升级流程
