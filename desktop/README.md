# ZPassDesktop —— ZPass 桌面客户端（Wails 3）

ZPass 桌面客户端的官方实现，基于 [Wails 3](https://v3.wails.io/) 把 Go 后端与 React 前端打包为单一原生二进制。

本子项目从原 `desktop/`（Tauri 2 + Rust）整体迁移而来，前端 UI/交互完整保留，存储与系统能力改由 Go 实现。

---

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 应用框架 | Wails 3 (alpha) | Go 主进程 + 系统 WebView 渲染前端 |
| 后端 | Go 1.25 | Services 暴露给前端的方法、文件 IO、加密（规划中） |
| 前端框架 | React 19 + TypeScript 5.8 | 路由用 react-router v7 |
| 构建 | Vite 7 + Tailwind CSS v4 | `@tailwindcss/vite` 直接消费 `@theme` 指令 |
| 组件库 | Radix UI + cmdk + lucide-react | 优先成熟现成组件，避免造轮子 |
| 状态 | Zustand 5 + persist | 持久化走 Go 侧 ConfigService，**严禁 localStorage** |
| 国际化 | i18next + react-i18next | en（默认）/ zh，`<html lang>` 同步 |
| 动画 | Framer Motion 12 | 仅用于关键过渡，不滥用 |
| 字体 | Geist Sans / Geist Mono | 通过 `@fontsource` 自托管，无 CDN |

---

## 目录结构

```
ZPassDesktop/
├── main.go                  # Wails 应用入口：注册 Services、打开 vault DB、创建主窗口
├── configservice.go         # 配置文件读写服务（~/.config/zpass/*.json）
├── cryptoutil.go            # 加密原语：Argon2id KDF + XChaCha20-Poly1305 AEAD
├── vaultdb.go               # Vault SQLite 存储层（~/.config/zpass/vault.db）
├── vaultservice.go          # Vault 高层服务：初始化/解锁/锁定/CRUD/改主密码
├── vaultservice_test.go     # 端到端单元测试（含拖库泄露 / AEAD 防搬移回归）
├── go.mod / go.sum          # Go 依赖
├── Taskfile.yml             # 通过 wails3 task 调度的任务集合
├── build/                   # 各平台打包配置（windows/darwin/linux/...）
│   └── config.yml           # 应用元信息（productName / version / identifier）
└── frontend/                # 前端工程（独立 npm 项目）
    ├── index.html           # 含防 FOUC 启动脚本（同步主题/缩放/语言）
    ├── package.json         # 前端依赖
    ├── tsconfig.json        # `@/*` → `src/*` 路径别名
    ├── vite.config.ts       # Vite 7 + React + Tailwind + Wails 插件
    └── src/
        ├── main.tsx         # React 挂载点 + i18n / 平台初始化
        ├── App.tsx          # 全局副作用容器 + 路由根
        ├── app/             # 路由 / 守卫 / 主题同步 / 全局快捷键
        ├── components/      # 标题栏 / 侧边栏 / 命令面板 / Select / 等
        ├── features/        # 按业务页面分目录（welcome / signin / vault / ...）
        ├── stores/          # zustand 切片（prefs / lock / spaces / account / vault）
        ├── lib/             # 平台检测、配置存储适配器、vault-api、cn 工具
        ├── i18n/            # en / zh 字典 + setLang
        ├── styles/          # tokens.css + globals.css
        └── data/            # 占位/示例数据
```

---

## 与原 `desktop/`（Tauri）的等价映射

| Tauri | Wails 3 |
|---|---|
| `src-tauri/src/lib.rs` (`#[tauri::command]`) | `main.go` 中 `application.NewService(...)` 注册的方法 |
| `src-tauri/src/config.rs` `config_*` 命令 | `configservice.go` 的 `ConfigService.{Dir,Read,Write,Remove}` |
| `tauri.conf.json` 窗口选项 | `main.go` 中 `application.WebviewWindowOptions` |
| `decorations: false` | `Frameless: true` |
| `data-tauri-drag-region` | CSS 自定义属性 `--wails-draggable: drag` |
| `getCurrentWindow().minimize()` | `Window.Minimise()` (`@wailsio/runtime`) |
| `@tauri-apps/plugin-os` `osType()` | `System.IsMac/IsWindows/IsLinux()` |
| `@tauri-apps/api/core` `invoke("config_read", { namespace })` | `Call.ByName("main.ConfigService.Read", namespace)` |
| —（原 Tauri 阶段未实现） | `VaultService.{Initialize,Unlock,Lock,ListItems,GetItem,CreateItem,UpdateItem,DeleteItem,ChangeMasterPassword}` |

存储路径 `~/.config/zpass/<namespace>.json` 与原 Tauri 实现完全一致 —— 用户的偏好/空间列表/账户登录态在跨方案迁移时**无需重新配置**。

---

## 关键约定

### 配置存储（产品硬性约束）

所有用户配置（偏好、空间、账户元信息）**必须**通过 `frontend/src/lib/config-storage.ts` 走 `ConfigService` 落到 `~/.config/zpass/`，**严禁**使用 localStorage / sessionStorage / IndexedDB。

- 工厂：`createWailsConfigStorage<T>()`（旧名 `createTauriConfigStorage` 仍作为 alias 保留）
- 落盘格式：`~/.config/zpass/<namespace>.json`，其中 `<namespace>` 即 zustand persist 的 `name`
- 写入策略：tmp 文件 + fsync + rename 的原子写
- 命名规则：`[A-Za-z0-9_.-]{1,64}`，约定 `zpass.<slice>` 形式（如 `zpass.prefs`、`zpass.spaces`）

### Vault 加密存储（零知识架构）

密码 / 用户名 / URL / 备注等**敏感数据**必须通过 `frontend/src/lib/vault-api.ts` 走 `VaultService` 落到 `~/.config/zpass/vault.db`，**严禁**走 ConfigService（那是明文 JSON）。

零知识双层密钥架构：

```
主密码（仅在用户输入时短暂存在内存，从不落盘）
    │
    ▼ Argon2id(memory=64 MiB, iter=3, parallelism=4, salt=32B)
KEK (Key Encryption Key, 32B)
    │
    ▼ XChaCha20-Poly1305 解封 wrapped_dek
DEK (Data Encryption Key, 32B, 随机生成于初始化时)
    │
    ▼ XChaCha20-Poly1305 加密每条 item（aad = item.id 防搬移）
vault_items.payload (BLOB)
```

关键安全属性：

- **拖库零信息**：`vault_items` 表只有 `id / payload(密文) / created_at / updated_at`，无任何明文元数据（type / name / URL / tag 全部加密在 payload 里）。攻击者拿到整库除了"用户有几条记录、每条多大"以外啥也得不到，已被 `TestDB_NoPlaintextLeakage` 用例锁死。
- **抗离线爆破**：从不存"主密码哈希"，攻击者每次猜测必须做完整 Argon2id 派生（~250–400 ms / 64 MiB 内存），消费级 GPU 24 GB 显存最多 ~370 并行，比 PBKDF2 攻击预算提高 10000+ 倍。
- **AEAD 防搬移**：每条 item 的 SealAEAD `aad = item.id`，攻击者即便有 DB 写权限也不能把 item A 的密文搬到 item B 行下骗解密器（aad mismatch → tag 失败）。
- **改主密码廉价**：双层密钥 → 改密只需重新包装 DEK，不重写所有 item；KDF 参数顺便升级到当时的 `DefaultArgon2id()`。
- **锁定即抹零**：`Lock()` 显式 `WipeBytes(DEK)`，缩小密钥材料在内存中的驻留窗口。
- **secure_delete**：SQLite `secure_delete` pragma 已开，删除条目时被回收的页填零，密文不会留在文件未使用空间被取证恢复。

技术细节：

- KDF：Argon2id（OWASP 2023 推荐，参数随 vault 一起持久化，未来可无痛升级）
- AEAD：XChaCha20-Poly1305（24B nonce 支持安全的随机生成；纯 Go 无 CGO）
- DB：`modernc.org/sqlite`（纯 Go SQLite 移植版，跨平台编译零摩擦），WAL 模式，文件权限 0o600
- 时间戳：服务进程内单调水位线（`nowMs()`），抗系统时钟回拨

详见 `cryptoutil.go` / `vaultdb.go` / `vaultservice.go` 头部注释。回归测试在 `vaultservice_test.go`（26 条用例覆盖初始化 / 解锁 / 锁定 / CRUD / 改密 / 持久化 / AEAD 防搬移 / 拖库分析 / JSON 形状契约）。

### 设计系统

- CSS 变量定义在 `frontend/src/styles/tokens.css`，与 `ZPassDesign/src/tokens.css` / `website/src/styles/tokens.css` 保持同步。
- 主题切换通过 `<html data-theme="dark|light">` 驱动，**不要**用内联样式覆盖 token。
- 字体：Geist（正文）、Geist Mono（密码 / TOTP / 键盘快捷键），不引入其他字体。
- 圆角：仅用 `5 / 7 / 10 / 14 px`，描边优先于填充，分隔靠 `--line`。

### 平台标识

- `<html data-platform="macos|windows|linux">` 在启动时由 `lib/platform.ts` 通过 Wails 3 的 `_wails.environment.OS` 同步写入。
- macOS 下 `<Titlebar />` 不渲染自定义窗口按钮，左侧预留 `--titlebar-traffic-lights-inset` 给原生红绿灯。
- Windows / Linux 共用一套对齐 Windows 11 Fluent 规范的自定义窗口控件。

### 拖拽区域

Wails 3 不识别 `data-tauri-drag-region`。改用 CSS 自定义属性：

```css
/* 拖拽区 */
.titlebar { --wails-draggable: drag; }
/* 在拖拽区内"开洞"（如按钮） */
.titlebar button { --wails-draggable: no-drag; }
```

属性会 inherit，因此通常在外层标题栏一次声明，子按钮显式 `no-drag` 即可。

### 组件选型偏好

优先调研并使用现成的成熟组件库（Radix UI / cmdk / Headless UI 等），**不要**手写 Select / 命令面板 / popover 等交互复杂的控件。详见 `frontend/src/components/{Select,CmdK,WorkspaceSwitcher}.tsx`。

---

## 开发与构建

### 前置依赖

| 工具 | 最低版本 | 安装 |
|---|---|---|
| Go | 1.25 | https://go.dev/dl/ |
| Node.js | 20 | https://nodejs.org/ |
| Wails CLI | v3 alpha | `go install github.com/wailsapp/wails/v3/cmd/wails3@latest` |
| Task | 3.x | https://taskfile.dev/installation/ |

Windows 额外需要 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 自带）。

### 开发模式（前后端热重载）

```sh
cd ZPassDesktop
wails3 dev
```

或通过 Taskfile：

```sh
task dev
```

前端 dev server 默认监听 `http://localhost:9245`（与 `Taskfile.yml` 的 `VITE_PORT` 同步），Wails 会把 webview 指到这个地址。修改 Go 文件会触发后端重启，修改 React/TS 文件走 Vite HMR。

### 仅前端开发（不启动 Go）

```sh
cd ZPassDesktop/frontend
npm install
npm run dev
```

此时 `lib/config-storage.ts` 检测不到 Wails 运行时，会回落到内存 Map，**刷新即丢失**——这是刻意的"诚实表现"，便于发现"忘了在 Wails 里跑"。

### 生产构建

```sh
cd ZPassDesktop
wails3 build
# 或
task build
```

产物：

- Windows: `bin/ZPass.exe`
- macOS: `bin/ZPass.app`
- Linux: `bin/ZPass`

打包安装器：

```sh
task package
```

---

## 易踩坑

- **不要往 localStorage 写任何配置**。所有 zustand store 必须使用 `createWailsConfigStorage()`，否则违反产品约束。
- `frontend/dist/` 必须先存在 Go 才能 `embed`。`wails3 build` 会自动按顺序处理；如果你只想跑 `go build`，先 `cd frontend && npm run build`。
- `Call.ByName("main.ConfigService.Method", ...)` 的方法名是按 Go 反射解析的，**首字母必须大写**。重命名 Go 方法时记得同步 `frontend/src/lib/config-storage.ts` 顶部的 `SVC_*` 常量。
- 拖拽用 `--wails-draggable: drag`（CSS 自定义属性，inherit），**不是** `data-tauri-drag-region`。子按钮要显式 `no-drag` 开洞。
- Wails 3 仍处于 alpha，API 偶有破坏性变更。升级 `github.com/wailsapp/wails/v3` 与 `@wailsio/runtime` 时务必一同升级并跑通 `wails3 dev`。
- `<html data-platform>` 在首帧由 `lib/platform.ts` 同步写入；如果你新增了平台分支组件，请通过 `getPlatform()` / `isMacOS()` 同步读取，不要 await 异步 API。

---

## 路线图

- [x] 配置文件存储（ConfigService）
- [x] Vault 加密层（Argon2id + XChaCha20-Poly1305 + SQLite，零知识双层密钥）
- [x] 主密码创建 / 解锁 / 修改 + 登录条目 CRUD（端到端跑通）
- [ ] 详情字段全量索引（解锁后预解密以支持按 username / url 全文搜索）
- [ ] 自动锁定（idle timeout）
- [ ] 剪贴板自动清空（30s 后清密码）
- [ ] 密码生成器接入 / 强度评估
- [ ] 卡片 / 笔记 / 身份 / SSH / 钱包 等其它条目类型的表单
- [ ] 浏览器扩展通信（auto-fill 桥）
- [ ] 系统托盘 + 全局快捷键
- [ ] 自动更新（GitHub Releases）

---

## 相关项目

- [`ZPassDesign/`](../ZPassDesign/) — 设计原型层（React + Babel Standalone，零构建）
- [`website/`](../website/) — 官方营销网站（Astro 5）
- 顶级 [`AGENTS.md`](../AGENTS.md) — 整个仓库的 AI Agent 指南