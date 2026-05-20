# third_party/ — 本地补丁的 Wails 3 副本

这个目录里**不应该**有任何手工提交的源码。它的存在只有一个用途：承载一份打过 KDE 标题栏补丁的 Wails 3 源码副本，让主模块通过 [`../go.work`](../go.work)（也是自动生成、gitignored）把 `github.com/wailsapp/wails/v3` 重定向过来。

实际的副本目录 `wails-v3/` 由 [`../scripts/setup-wails/`](../scripts/setup-wails/) 工具生成、已加入 `.gitignore`。

---

## 为什么要做这件事？

主窗口在 [`../main.go`](../main.go) 里以 `Frameless: true` 创建，希望由前端 `<Titlebar />` 完全接管窗口顶栏。

Wails 3 alpha 78 的 Linux 实现只调一次 `gtk_window_set_decorated(FALSE)`：

```/dev/null/wails-upstream-snippet.go#L1-4
// pkg/application/linux_cgo.go:1587（上游原始版本）
func (w *linuxWebviewWindow) setFrameless(frameless bool) {
    C.gtk_window_set_decorated(w.gtkWindow(), gtkBool(!frameless))
}
```

这个调用在大多数 Linux 桌面环境（GNOME / Mutter、Xfwm、Cinnamon、KWin-on-X11）都能让窗口管理器不画装饰。但在 **KDE Plasma Wayland** 下表现不同：KWin 默认会通过 `xdg-decoration` 协议给窗口贴一条 *server-side decoration (SSD)* 标题栏，除非客户端**显式**请求 `client_side` 模式。GTK 仅调 `set_decorated(FALSE)` 不会触发这个请求，于是用户同时看到：

1. 我们自己的 `<Titlebar />`
2. KWin 画的灰色 SSD 标题栏

GTK 的官方解法是**给窗口装一个自定义标题栏控件**（哪怕是空的）—— 这一步会翻转 GTK 内部的 `client_decorated` 标志，让 GTK 主动通过 `xdg-decoration` 请求 CSD，KWin 收到后就不再画 SSD。补丁本质上就这一行：

```/dev/null/zpass-patch-snippet.go#L1-3
empty := C.gtk_box_new(C.GTK_ORIENTATION_HORIZONTAL, 0)
C.gtk_window_set_titlebar(w.gtkWindow(), empty)
```

时序前提：`gtk_window_set_titlebar` 必须在 widget realize 之前调用。上游 `setFrameless` 是在 `run()` 的窗口配置阶段被调用、晚于 `windowShow()` 里的 `gtk_widget_realize()`，所以这个补丁打在 `setFrameless` 内部是安全的。

---

## 使用流程

### 首次配置（Linux 开发机）

```sh
cd desktop
task setup:wails
```

这一条命令会：

1. 调 `go mod download github.com/wailsapp/wails/v3@v3.0.0-alpha.78`，确保 Wails 源在 module cache 里；
2. 把 cache 副本拷到 `desktop/third_party/wails-v3/`，把全部权限改回可写；
3. 找到 `pkg/application/linux_cgo.go` 里原始的 `setFrameless` 函数体，整段替换成 KDE-friendly 版本；
4. 在 `desktop/go.work` 写入一条 `replace github.com/wailsapp/wails/v3 => ./third_party/wails-v3`；
5. 写一个 `.zpass-patched` 标记文件用于后续幂等检测。

之后任何 `task dev` / `task build` 都会先跑一次 `setup:wails`（标记存在就立刻返回，几毫秒级开销）。

### 升级 Wails 版本

1. 在 [`../go.mod`](../go.mod) 里改 `github.com/wailsapp/wails/v3` 的版本；
2. 在 [`../scripts/setup-wails/main.go`](../scripts/setup-wails/main.go) 顶部把 `wailsVersion` 常量改成同样的值；
3. `task setup:wails -force`（或者直接 `rm -rf third_party/wails-v3 && task setup:wails`）；
4. 跑 `task dev` 验证 KDE 上行为符合预期。

如果上游已经把 `setFrameless` 改写过、补丁里的 `want` 字符串不再匹配，setup 工具会**报错并退出**，不会悄悄把补丁打到错位置上。这时需要：

- 检查上游新版本是否已修复 KDE 问题（如果修了，删掉 `go.work`、删掉 `third_party/wails-v3/`、删掉本 README 提到的整条工具链即可）；
- 否则更新 `scripts/setup-wails/main.go` 里的 `want` / `replacement` 常量，让补丁能对上新版本的代码形状。

### macOS / Windows 开发者

**不需要做任何事**。他们的平台与 KDE 的 SSD 协商问题无关，`go.mod` 是干净的官方 Wails，正常 `task dev` / `task build` 即可。`task setup:wails` 在 Taskfile 里也仅作为 `build:native` / `dev` 的 Linux 前置任务（详见 [`../Taskfile.yml`](../Taskfile.yml)）。

### 清理

```sh
cd desktop
rm -rf third_party/wails-v3 go.work
```

下次 `task setup:wails` 会重新生成。

---

## 设计取舍

| 选项 | 取舍 |
|---|---|
| **用 `go.work` 而非 `go.mod` 的 `replace`** | `go.work` 不进 git，对仓库零侵入；跨平台开发者拿到代码不必跑 setup |
| **Go 程序而非 shell 脚本** | Windows 默认 shell 没 `patch(1)`；Go 跨平台、与项目其他工具同源 |
| **精确字符串替换而非 `.patch`/`diff`** | 函数级整段替换比按行 diff 更稳健；上游一旦改实现就 fail-fast |
| **setup 工具自己有 `go.mod`** | 避免 `go.work` 引入指向不存在路径的 replace 时把 setup 工具自己也带崩 |
| **拷贝 module cache 而非 `git clone`** | 复用 `go mod download` 的校验和验证；不依赖网络可达 github.com |

---

## 上游问题追踪

如果你想推动这个修复回归 Wails 上游、彻底删掉本目录：

- Wails 3 issues: https://github.com/wailsapp/wails/issues
- 相关上游 TODO：补丁前后保留的 `// TODO: Deal with transparency for the titlebar if possible when !frameless` 注释也是上游自己留的提示，他们清楚这块的实现还不到位。
