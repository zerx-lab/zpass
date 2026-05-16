//go:build !nativehost

package main

// ZPass 桌面客户端 —— Wails 3 应用入口
// ---------------------------------------------------------------------------
// 职责：
//   1. 通过 Go 1.16+ 的 //go:embed 把 frontend/dist 整棵嵌入到二进制
//   2. 创建 Wails 3 应用，注册 Services（前端可调用的 Go 方法）
//   3. 创建主窗口（frameless + 1280x820，与原 Tauri 配置等价）
//   4. 启动事件循环
//
// 拆分原则：
//   - 具体服务实现落在对应 *.go 文件（当前：configservice.go）
//   - 本文件只做"装配"：embed + Services 列表 + Window 选项
//   - 保持入口薄、业务厚，便于后续引入 vault/crypto/autofill 等模块时
//     只需要在这里加一个 NewService 条目
//
// 与原 Tauri 实现的对应关系：
//   - tauri.conf.json `app.windows[0]` → application.WebviewWindowOptions
//   - tauri.conf.json `decorations: false` → Frameless: true
//   - tauri.conf.json `backgroundColor: "#0c0c0d"` → BackgroundColour: NewRGB(12,12,13)
//   - tauri.conf.json `titleBarStyle: "Overlay"` (macOS) → MacTitleBar: HiddenInset
//   - 配置文件读写命令 (config_dir/read/write/remove) → ConfigService 4 方法
//
// 前端通过 `Call.ByName("main.ConfigService.<Method>", ...)` 路由到本服务，
// 见 frontend/src/lib/config-storage.ts 头部注释。

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// vaultDB 是进程级的 vault 数据库句柄
//
// 在 main 启动时一次性打开（OpenVaultDB 内部会 mkdir + 建表 + WAL pragma），
// 并通过闭包传给 VaultService。进程退出时由 OnShutdown 钩子兜底关闭，
// 让 SQLite 把 WAL 合并回主文件，避免 vault.db-wal / vault.db-shm 残留。
//
// 不放在 main() 局部变量里的理由：让 OnShutdown 闭包能访问到引用，否则
// 闭包必须在 application.New 之前定义、再在之后绑 db，绕一圈代码不直观。
var vaultDB *VaultDB

// 把 frontend/dist 整棵嵌入二进制。
//
// 必须在 frontend 完成 `npm run build` 之后再编译 Go，否则 dist 不存在
// 会导致 embed 失败并阻止构建。Wails Taskfile 中的 build 流程会按
// `frontend build → go build` 顺序执行，开发模式下用 vite dev server
// 直连，不走 embed 路径。
//
// 使用 `all:` 前缀确保隐藏文件（如 _astro/ 等下划线开头的产物）也被
// 包含 —— 默认 embed 会跳过 `.` 与 `_` 开头的文件。
//
//go:embed all:frontend/dist
var assets embed.FS

// main 是应用的入口。
//
// 不在这里做的事：
//   - 任何业务逻辑（落在 services / packages 内）
//   - 前端 IPC handler 注册（Wails 3 通过 Services 自动反射方法名）
//   - 平台特定的特殊处理（在 application.Options 的 Mac/Windows/Linux
//     选项里声明，避免散落在代码各处）
func main() {
	// 创建 Wails 3 应用。
	//
	// 字段说明：
	//   Name        — 出现在窗口标题、任务栏、应用菜单中
	//   Description — macOS 应用菜单、Windows 任务管理器中显示
	//   Services    — 前端可通过 Call.ByName 调用的 Go 方法集合。
	//                 方法首字母大写才会被反射注册（与 Go 导出可见性一致）
	//   Assets      — 嵌入式静态资源；AssetFileServerFS 会按 frontend/dist
	//                 为根处理 fetch，让 SPA 路由 (#/、history mode) 能正常 fallback
	//   Mac         — macOS 平台特定选项；ApplicationShouldTerminateAfterLastWindowClosed
	//                 = true 让最后一个窗口关闭时整个 app 退出（符合 Windows/Linux 直觉，
	//                 避免 macOS 默认"关窗不退出"导致用户以为 app 已关掉但进程仍在）
	// ----- 打开 vault 数据库 -----
	//
	// 必须在 application.New 之前完成 —— Services 列表里要立即注入
	// VaultService(vaultDB)。OpenVaultDB 失败直接 fatal：vault 是核心
	// 能力，不能开就没法启动；用户看到的会是「无法启动」提示而不是「启动
	// 后所有 vault 操作都报错」，更诚实。
	//
	// 失败可能原因：
	//   - 用户配置目录不可写（极罕见，权限问题）
	//   - vault.db 已损坏到无法 open（需要从备份恢复）
	//   - schema 版本是新版应用写的、当前老版本拒绝降级（需升级应用）
	db, err := OpenVaultDB()
	if err != nil {
		log.Fatalf("open vault db: %v", err)
	}
	vaultDB = db

	// ----- 构造各 service 实例 -----
	//
	// SshAgentService 依赖 VaultService，所以必须在 VaultService 创建后构造。
	// 并且 VaultService 需要能反向通知 SshAgentService（解锁 / 锁定 / SSH
	// item 变更），所以走互相注入：先 New 出两个 service 实例，再用 setter
	// 把 SshAgentService 反向装进 VaultService。
	vaultService := NewVaultService(vaultDB)
	sshAgentService := NewSshAgentService(vaultService)
	vaultService.setSshAgentNotifier(sshAgentService)
	browserBridge := NewBrowserBridgeServer(vaultService)
	if err := browserBridge.Start(); err != nil {
		log.Printf("browser bridge disabled: %v", err)
	}

	app := application.New(application.Options{
		Name:        "ZPass",
		Description: "ZPass — zero-knowledge password manager for desktop",
		Services: []application.Service{
			// 配置文件读写 —— ~/.config/zpass/<ns>.json
			// 详见 configservice.go 头部注释
			application.NewService(NewConfigService()),
			// Vault 加密存储 —— Argon2id KDF + XChaCha20-Poly1305 AEAD
			// + SQLite (~/.config/zpass/vault.db)。详见 vaultservice.go
			// 头部注释。
			application.NewService(vaultService),
			// 字体服务 —— 返回系统已安装字体列表（含内置 Geist / Geist Mono）。
			// 跨平台：Windows 读注册表 / macOS 扫目录 / Linux 调 fc-list。
			// 详见 fonts.go / fonts_windows.go / fonts_darwin.go / fonts_linux.go。
			application.NewService(NewFontService()),
			// QR 二维码解码 —— gozxing (ZXing Go 移植) 跨平台统一实现。
			// 对带中心 logo / 轻度倾斜的 QR 识别率显著优于前端 jsQR。
			// 详见 qrservice.go 头部注释。
			application.NewService(NewQRService()),
			// SSH agent 服务 —— 控制通道服务端，与外部的 zpass-agent 守护进程
			// 通信。详见 sshagentservice.go 头部注释。
			application.NewService(sshAgentService),
			// 导出服务 —— 把整个 vault 以明文 JSON 导出到用户选定的本地文件。
			// 包含所有账户 / SSH 密钥 / passkey / TOTP 秘钥；调用前应由前端
			// 调用 VaultService.VerifyMasterPassword 做二次确认。详见
			// exportservice.go 头部注释。
			application.NewService(NewExportService(vaultService)),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		// 进程退出时关闭 SQLite —— 让 WAL 合并回主文件，避免遗留
		// vault.db-wal / vault.db-shm 副本。Wails 3 在所有窗口关闭后
		// 会触发 OnShutdown 钩子。顺手调 SshAgentService.Shutdown：
		//   - 停控制通道 listener（进程退出也会自动销毁 listener）
		//   - **不**杀 zpass-agent 子进程 —— 让它后台存活，下次 GUI
		//     启动时检测到并「重用」，避免反复拉起/退出。
		// 详见 SshAgentService.Shutdown 注释与 Bitwarden 同类体验设计背景。
		OnShutdown: func() {
			if browserBridge != nil {
				_ = browserBridge.Shutdown()
			}
			if sshAgentService != nil {
				_ = sshAgentService.Shutdown()
			}
			if vaultDB != nil {
				_ = vaultDB.Close()
			}
		},
	})

	// 注入 Wails event emitter 让 SshAgentService 能主动推 event 给前端。
	//
	// 为什么不在构造函数里注入：Wails 3 的 application.Options.Services
	// 在 application.New 返回前使用，但 app.Event.Emit 只在 app 创建后可
	// 调。所以顺序是：service 先创建但未注入 emit → app 创建 → 注入 emit。
	sshAgentService.SetEventEmitter(func(event string, payload any) {
		app.Event.Emit(event, payload)
	})
	vaultService.SetEventEmitter(func(event string, payload any) {
		app.Event.Emit(event, payload)
	})

	// ----- 自动重接管「跨 GUI 重启」的后台 agent -----
	//
	// 上一次 GUI 退出时走 Shutdown() → supervisor.Detach()：listener 停了
	// 但 zpass-agent 守护进程被故意保留，等下次 GUI 启动重用（对齐 Bitwarden
	// 的体验目标，详见 sshagentservice.Shutdown 与 SSH agent 跨重启架构注释）。
	//
	// 但「重用」必须 GUI 这边主动起 control listener 才能完成：旧 agent 的
	// controlClient 一直在重连退避（1->2->5->10s），需要本进程的 control
	// listener 出现才能握手回来。如果用户没去设置页手动点「启用」，前端就
	// 会一直显示「服务未启用」（Status.Enabled 来源是 s.listener != nil），
	// 让人误以为后台 agent 也挂了。
	//
	// 探测「应该自动启用」的信号：
	//   1. 用户偏好 ssh-agent.json 里 enabled=true：用户曾在 ZPass 里启用，
	//      且没有手动关闭过，所以本次启动也应恢复 listener/agent。
	//   2. 老版本没有偏好文件但 agent socket / pipe 可连接：兼容旧行为，
	//      重新接管上次 GUI 退出时留下的后台 agent。
	//
	// 命中即自动调一次 Enable()：内部会跑 isAgentAlreadyRunning() 跳过
	// supervisor.Start()（避免与旧 agent 抢同名 pipe / socket），仅起 control
	// listener；旧 agent 的 controlClient 重连机制几秒内就会接上。
	//
	// 失败不致命：起 listener 失败常见原因是控制 socket 被占（极罕见），
	// log warn 后让用户看到设置页里仍可手动点「启用」重试。
	desiredEnabled, prefExists, prefErr := readSshAgentDesiredEnabled()
	if prefErr != nil {
		log.Printf("read ssh agent preference failed: %v", prefErr)
	}
	shouldEnableSshAgent := desiredEnabled || (!prefExists && isAgentAlreadyRunning())
	if shouldEnableSshAgent {
		if err := sshAgentService.Enable(); err != nil {
			log.Printf("auto re-adopt ssh agent failed: %v", err)
		}
	}

	// 创建主窗口。
	//
	// 关键选项与原 Tauri 配置的对应：
	//   Title              "ZPass"             —— 与 Name 同步，frameless 下不渲染但任务栏会用
	//   Width / Height     1280 × 820          —— 默认窗口尺寸
	//   MinWidth/MinHeight 960 × 620           —— 最小可调尺寸（小于这个布局会拥挤）
	//   Frameless          true                —— 关闭系统标题栏 + 边框，由前端 <Titlebar /> 接管
	//   BackgroundColour   #0c0c0d (RGB 12,12,13) —— 与 dark 主题 --bg 一致，避免首帧白闪
	//   URL                "/"                 —— 加载 SPA 入口，由 React Router 接管路由
	//   Centered           true                —— 启动时居中
	//
	// macOS 选项：
	//   InvisibleTitleBarHeight 36 —— 与前端 <Titlebar /> 高度一致，
	//                                  让窗口阴影/红绿灯位置与自定义标题栏对齐
	//   TitleBar = MacTitleBarHiddenInset —— 隐藏系统标题栏文字但保留红绿灯，
	//                                         前端的 isMacOS 分支会在左侧预留 80px 给红绿灯
	//   Backdrop = MacBackdropNormal —— 不启用毛玻璃，保持纯色背景与 dark 主题协调
	//
	// 注意：Frameless 在 Windows/Linux 下会移除整个边框（含阴影），
	// 阴影由 OS 在 frameless 窗口上仍会渲染（Windows 11 的 DWM 自动处理）。
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "ZPass",
		Width:            1280,
		Height:           820,
		MinWidth:         960,
		MinHeight:        620,
		Frameless:        true,
		InitialPosition:  application.WindowCentered,
		BackgroundColour: application.NewRGB(12, 12, 13),
		URL:              "/",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 36,
			Backdrop:                application.MacBackdropNormal,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
	})

	// 启动事件循环。该调用阻塞直到所有窗口关闭（macOS 上由
	// ApplicationShouldTerminateAfterLastWindowClosed 控制是否退出进程）。
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
