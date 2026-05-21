# AGENTS.md — ZPass Desktop

## 架构铁律

单桌面应用，**Electron 渲染层 + Go (Huma) sidecar**，端到端类型 + 渐进式严格化。

```
Go struct → openapi.yaml → schema.ts → client.ts → renderer (typed path)
Go method → /wails/call (reflect dispatch) → @wailsio/runtime shim → renderer (compat path)
Go event → /wails/events (SSE) → Events.On() → renderer (push path)
```

- 业务逻辑**只**写在 Go。Electron 主进程仅守护 sidecar、暴露窗口控件 / save-dialog；渲染进程仅消费生成的 client 或经 compat shim 调 Go service。
- TS 的请求/响应类型对**新端点**只能来自 OpenAPI 导出（`electron/src/api/schema.ts` 自动生成、禁止手改）。
- 端点必须通过 Huma 的 operation 注册，或通过 `internal/wailscompat.Registry` 注册 service。裸 `net/http` handler 不会进 OpenAPI、对 TS 不可见。
- 打包只用 Electron Forge，不要并行引入 electron-builder。

## 兼容层 (wailscompat)

ZPass 从 Wails 3 项目移植而来。为不重写约 16 KLOC 已测试的渲染代码，保留 `Call.ByName("main.Service.Method", ...args)` 调用面：

- 后端：`internal/wailscompat` 提供 `Registry`（反射派发服务方法到 HTTP `POST /wails/call`）+ `Hub`（SSE 事件广播到 `GET /wails/events`）。每个 service 在 `main.go` 的 `buildServices()` 里 `Register("VaultService", vault)` 一行接入。
- 前端：Vite 把 `@wailsio/runtime` 别名到 `electron/src/renderer/src/compat/wails-runtime.ts`，该文件转译 `Call/Events/Window/System` 到 HTTP/SSE/Electron IPC。
- 旧的 `wails3 generate bindings` 产物以**手写 stub** 形式保留在 `electron/src/renderer/bindings/.../*.js`，每个 stub 通过 `make-service.js` 的 Proxy 把任意属性访问转成 `Call.ByName`。

**渐进迁移**：热路径（高频或对类型敏感的方法）应逐步迁到 Huma typed operation；其余保持走 wailscompat。规则：

- **新端点**：写在 `/internal/api/` 的 Huma operation，TS 用生成的 `getClient()`。
- **移植端点**：保持在 `/internal/services/`，前端继续走 `Call.ByName` / bindings stub。
- 同一 service 内**不要**混合两种暴露方式 — 全栈一致才能避免类型漂移。

## 验收标准（提交/收尾前必过）

`task verify` 是硬门槛，它聚合：

- `task typecheck` — TS 全量 `tsc --noEmit`，含生成的 `schema.ts`。
- `task test:go` — `go test ./...`。
- `task lint` — `lint:go`（golangci-lint：`govet`/`nilness`/`staticcheck`/`errcheck`/`ineffassign`/`unused`/`gofmt`）+ `lint:ts`（Biome）。

**Lint 作用域**：新代码（`internal/api`、`internal/server`、`internal/wailscompat`、`internal/nativebridge`、根 `main.go`）必须 lint-clean；移植代码（`internal/services`、`cmd/zpass-agent`、`cmd/zpass-native-host`、`internal/sshagentproto`）在 `.golangci.yml` 中按路径豁免，保持原项目风格。touch 已豁免文件时局部改对就好，不要顺手清理无关代码——见 surgical changes 原则。

`task build` 自身依赖 typecheck + go 构建，可独立用于验证可分发产物能编。

## 流式 API 边界

- **SSE**：通过 `wailscompat.Hub` 暴露的 `/wails/events` 是兼容层；事件名 + JSON payload 走 `event:` / `data:` 帧。新增事件用 `hub.EmitterFunc()(name, payload)`，前端 `Events.On(name, handler)` 订阅。**不**走 OpenAPI（事件 schema 是动态的）。
- **typed SSE**：如果某个事件值得 typed schema（频繁、payload 稳定），用 Huma 的 `text/event-stream` 响应注册成正式 operation，并把 payload 注册为命名 schema（`OneOf` 判别式联合）。
- **WebSocket** 不进 OpenAPI（OpenAPI 3.x 无 WS 帧定义）。能用 SSE 就别用 WS。

## 关键路径

- `/internal/api/` — 新增 typed 端点写这里。
- `/internal/server/` — loopback 绑定、auth 中间件（含 `?token=` query 兜底给 SSE）、wails-compat handler 挂载。
- `/internal/wailscompat/` — 反射 dispatch + SSE hub。
- `/internal/services/` — 从 Wails 项目移植的全部 service（Vault / Config / SshAgent / Font / QR / Export / Browser bridge）。`package services`。
- `/internal/nativebridge/` — 浏览器扩展 native messaging 的共享 config 类型，GUI 与 `cmd/zpass-native-host` 都用。
- `/internal/sshagentproto/` — SSH agent 守护进程与 GUI 共享的握手协议。
- `/cmd/zpass-agent/` — SSH agent 守护进程（独立 binary，承载 ssh-add / signing）。
- `/cmd/zpass-native-host/` — Chrome native messaging host（独立 binary，转发到 GUI）。
- `/electron/src/main/backend.ts` — 拉起 Go sidecar、解析 stdout 握手 JSON。
- `/electron/src/main/main.ts` — Electron 主进程：sidecar 生命周期 + 窗口 IPC + save-file dialog。
- `/electron/src/preload/preload.ts` — `window.desktop` 桥（handshake / platform / window / dialog）。
- `/electron/src/api/client.ts` — 类型化 openapi-fetch 封装，注入鉴权头。
- `/electron/src/renderer/src/` — 移植的 React 应用（features / components / stores / lib / app / i18n / styles）。
- `/electron/src/renderer/src/compat/` — wails-runtime 兼容 shim + 共享 `window-globals.d.ts`。
- `/electron/src/renderer/bindings/` — wails-style binding stubs（Proxy 转发到 `Call.ByName`）。
- `/openapi.yaml` — Go ↔ TS 的契约检查点，入库提交。
- `/bin/<os>-<arch>/` — Go sidecar + agent + native-host 产物。`<arch>` 使用 **Node 命名**（`x64`/`arm64`/`ia32`）。
- `/scripts/dev-watcher.mjs` — dev-only Go 文件 watcher（同原始 scaffold）。

## Dev 热重启

`task dev` 期间改 Go 文件会自动 hot restart：watcher 监听 `*.go`/`go.mod`/`go.sum`，防抖 300ms 后串跑 `openapi → codegen → build:go`，再写 `.dev-reload`（内容为 epoch ms）。Electron 主进程 `fs.watch` 父目录、按文件名过滤，看到变化就 respawn sidecar（新 port/token）并 `reloadIgnoringCache()` 所有窗口，渲染进程的 `getClient()` 缓存随之失效；wails-compat shim 内的 handshake promise 同样失效（rerun fetch）。

要点：
- IPC 走 trigger 文件而非 POSIX 信号——`process.kill(pid, "SIGUSR2")` 在 Windows 上是 no-op，文件机制三大平台一致。
- 主进程按 `mtimeMs` 去重，避免 atomic write 或 Windows rename+change 双事件触发两次 reload。
- chokidar v4+ 不支持 glob：必须传目录 + `ignored` 谓词（按扩展名过滤）。
- 不是 Flutter 的热重载——Go 不支持代码热替换；UI 状态会丢，但渲染进程的 TS HMR（含 `schema.ts` 变化）独立由 Forge 的 Vite 处理。

## 代码生成链路

改 Go API → `task openapi` → `task codegen` → TS 拿到新类型。`task dev` / `task build` 已串好这条链；单独跑中间步会有静默类型漂移。

所有编排走 `Taskfile.yml`，不要在文档/脚本里直接调 `pnpm` 或 `go`。命令清单用 `task --list` 查。

## 启动性能

冷启时间分布在 packaged 模式下实测约 350–550ms（双击 → window-loaded）。**Go sidecar 整个冷启 ~5ms**，**vault DB open + WAL 设置约 30–60ms**——sidecar 本身不是瓶颈，因此别再尝试用裸 socket 替代 `net/http`——会撕掉 OpenAPI 契约链路、收益接近 0。

主进程在 module top-level **同步** spawn sidecar 并 `ipcMain.handle("desktop:handshake", …)`，不要把这两步搬回 `app.whenReady()`：sidecar 与 Electron 自身 init 并行能省 ~100ms Go-ready 时间、~20ms 用户感知。`startBackend()` 只用 `app.isPackaged` / `app.getAppPath()`，两者在 ready 前可调用。

`BrowserWindow` 不要套 `show: false` + `ready-to-show`。文档常见做法在 **Wayland 上反而拖慢窗口出现 500–700ms**（compositor "showable" 信号晚到）。`index.html` 已经 inline CSS + 防 FOUC 脚本，默认 `show: true` 的 first-paint 就有目标主题/语言/缩放——没有白屏可隐藏。

`main.ts` 在 `app.setName` 之后、`app.whenReady()` 之前批量 `app.commandLine.appendSwitch` 设置 Chromium 开关：`disable-features=CalculateNativeWinOcclusion,Vulkan`（前者 Win-only 省 200–300ms，后者修 Wayland GPU process fatal crash 与 ~500ms swiftshader fallback 重试）、`disable-renderer-backgrounding`、`no-default-browser-check`，Linux 上额外 `ozone-platform-hint=auto`。新增开关一律放这一段，**不要**写进 `app.whenReady()` 回调——GPU/utility 子进程在那之前就已经 fork。

调试启动延迟用 `RELAY_BOOT_TRACE=1 task dev`（或 packaged 二进制同前缀）——main process 会向 stderr 打印 `[trace:main]` 时间戳。env 未设时是 no-op。

## 安全模型（不显然的约束）

- Go 只绑 `127.0.0.1`，OS 分配端口。
- 每次启动生成新十六进制 token，要求 `X-Desktop-Token` 头。SSE 端点额外接受 `?token=` query（EventSource 无法设自定义头）。token **只**经 preload 传给渲染进程——不要走 env / URL / 磁盘。
- Electron：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- Go server 在鉴权中间件**之前**用 CORS 中间件包裹 mux，反射 origin 并短路 `OPTIONS`。必要，因为渲染进程 origin（dev `http://localhost:5173`，打包后 `file://`）与 `http://127.0.0.1:<port>` 不同源；loopback-only 监听让这样做安全。
- Forge fuses 已加固打包应用（禁 `ELECTRON_RUN_AS_NODE`、开 ASAR 完整性等），见 `forge.config.ts`。
- Vault 加密（Argon2id KEK → XChaCha20-Poly1305 DEK → 每 item AEAD `aad=item.id`）继承自原 Wails 实现，详见 `internal/services/cryptoutil.go` / `vaultdb.go` / `vaultservice.go` 头部注释。零知识双层密钥架构不变。

## 配置存储（产品硬性约束）

所有用户配置（偏好、空间、账户元信息）**必须**通过 `frontend/src/lib/config-storage.ts` 走 `ConfigService` 落到 `~/.config/zpass/`，**严禁**使用 localStorage / sessionStorage / IndexedDB。

- 落盘格式：`~/.config/zpass/<namespace>.json`，其中 `<namespace>` 即 zustand persist 的 `name`
- 写入策略：tmp 文件 + fsync + rename 的原子写
- 命名规则：`[A-Za-z0-9_.-]{1,64}`，约定 `zpass.<slice>` 形式（如 `zpass.prefs`、`zpass.spaces`）

## 代码约定

- Go 遵循 `gofmt` 与标准布局。新代码受 `.golangci.yml` 约束；移植代码按路径豁免（见 verify 段）。
- 渲染进程用 TypeScript。Biome 配置在 `biome.json`，`schema.ts` 已排除；移植代码若触发 a11y 等规则，按需在 `biome.json` 把规则降级为 `warn` 而非删代码。
- 代码注释与标识符用英文（新代码）；面向用户的字符串可用中文。移植代码保留原中文注释。

## 依赖策略

不要手改版本号。用 `go get pkg@latest` / `pnpm add pkg` 让工具挑版本，提交生成的 `go.sum` / `pnpm-lock.yaml`。若 peer dependency 强制非最新主版本，用 `pnpm view pkg@<major> version` 找该主版本最高兼容版，以 `pnpm add pkg@^<major>` 锁定。

## 维护本文件

跨 agent 会话的持久化记忆。**何时更新**：

- 用户要求"记一下 / remember / 写进 AGENTS"。
- 新增/删除/重命名顶层目录、`task` 项、Go/TS 包边界。
- 改动依赖策略、安全模型、codegen 链路、wailscompat 兼容层契约。
- 引入/淘汰工具（linter、formatter、test runner、CI）。
- 发现非显然的坑。

**怎么更新**：原位编辑，不追加 changelog；规则冲突时**替换**旧条目而非并列；删过期内容与加新内容同次提交。

**不要写进来**：会话临时笔记、教程散文、`task --list` / `go doc` 一条命令可得的信息。
