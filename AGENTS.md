# ZPass — AI Agent 指南

ZPass 是一款**零知识架构**的跨平台密码管理器。本仓库为 monorepo，按职责拆分多个子项目，每个子项目都有自己的 `README.md` 或 `AGENTS.md` 作为权威入口；本文件只覆盖**跨项目铁律**与**模块索引**。

## 子项目索引

| 路径 | 角色 | 技术栈 | 权威文档 |
|---|---|---|---|
| [`cryptocore/`](./cryptocore) | 跨平台加密原语库（Argon2id + XChaCha20-Poly1305） | Rust（rlib + cdylib + staticlib） | `cryptocore/src/lib.rs` 顶部模块文档 |
| [`desktop/`](./desktop) | 桌面客户端（Electron 渲染层 + Go Huma sidecar） | Electron Forge + React + Go | [`desktop/AGENTS.md`](./desktop/AGENTS.md) |
| [`extension/`](./extension) | 浏览器扩展（Chrome / Firefox 自动填充 + WebAuthn 桥接） | WXT + TypeScript | [`extension/README.md`](./extension/README.md) |
| [`phone/`](./phone) | 移动端 App（Android / iOS） | Expo React Native + Rust JNI 桥（`modules/zpass-crypto`） | [`phone/README.md`](./phone/README.md) |
| [`website/`](./website) | 官方营销网站 | Astro 5（静态） | [`website/README.md`](./website/README.md) |
| [`design/`](./design) | 高保真交互原型（浏览器直开，无构建） | HTML + JSX (Babel Standalone) | [`design/README.md`](./design/README.md) |

`assets/` 是跨项目共享的图标 / 商标素材。

## 跨项目铁律

### 加密一致性

同一 vault 文件必须能在 `desktop / phone / extension` 三端互相解读：

- **算法与字节布局的权威**：`cryptocore/src/lib.rs`（Rust）—— Argon2id KDF + XChaCha20-Poly1305 AEAD。
- **桥接策略**：
  - `desktop/internal/services/cryptoutil.go` —— Go 原生实现，与 cryptocore 字节对齐。
  - `phone/modules/zpass-crypto/` —— 通过 JNI 加载 `libcryptocore.so`；若 native 不可用，回退 `hash-wasm` / `@noble/*` 纯 JS。
  - `extension/` —— `@noble/hashes` + `@noble/ciphers` 纯 JS。
- **新增算法/参数**先改 cryptocore，再扩展到其余三端；任何端走分叉视为 P0 bug。
- 跨端字节级回归向量集中固化在 `cryptocore/src/lib.rs` 单元测试（`derive_kek_known_vector_is_stable` 等）。

### 设计系统

- **CSS 变量（Design Tokens）**：`design/src/tokens.css` 与 `website/src/styles/tokens.css` 保持同步；任何 token 改动需双向落库。
- 主题切换走 `<html data-theme="dark|light">`，**禁止**内联样式覆盖 token。
- 字体：仅 `Geist`（正文）+ `Geist Mono`（密码 / TOTP / 快捷键），**不引入其他字体**。
- 圆角仅用 `5 / 7 / 10 / 14 px`；描边优先于填充；分隔线用 `--line`。
- 渲染层禁止使用 emoji 与 Unicode 装饰符号，统一走图标系统（gpui-component / lucide-react / 内嵌 SVG）。

### 模块边界

- `desktop` 的业务逻辑只写在 Go；Electron 主进程只守护 sidecar、暴露窗口控件。详见 [`desktop/AGENTS.md`](./desktop/AGENTS.md) 的 wailscompat 章节。
- `phone/android/` 是 `expo prebuild` 产物（gitignored），任何修改会被下一次 prebuild 抹掉。需要注入 native 资源时通过 `phone/plugins/with-cryptocore.js` 等 config plugin。
- `website/public/demo/` 是 `design/` 的快照，不会自动同步，更新原型后需手动同步。

## 常用命令

各子项目命令以其内部 `Taskfile.yml` / `package.json` 为准。最常用入口：

```sh
# cryptocore Rust 单测
cd cryptocore && cargo test --lib

# phone：一键 .so + 模拟器 + run:android
cd phone && task dev

# desktop：开发模式
cd desktop && task dev          # 视 Taskfile 而定

# website：本地预览
cd website && npm run dev       # http://localhost:4321

# extension：开发模式
cd extension && bun run dev
```

## 易踩坑

- `phone/android/` 与 `phone/ios/` 是 prebuild 产物，永远不要手改，通过 `app.json` 的 `plugins` 数组与 `phone/plugins/*.js` 注入。
- `website/public/demo/` 是 `design/` 的静态快照，**不会**随原型自动更新。
- `astro.config.mjs` 的 `site` 字段影响 canonical URL 与 OG meta，本地无需改，**发布前务必确认**。
- i18n 字符串（`website/src/i18n/strings.ts`）新增 key 后 `en` 与 `zh` 两个对象都要补全，否则会 fallback 到 key 名。
- 修改任何加密参数前先看 `cryptocore/src/lib.rs` 的常量与已知向量；改了 KDF 参数等于让所有存量 vault 解不开。
