// zpass-agent —— ZPass SSH agent 守护进程
//
// ---------------------------------------------------------------------------
// 概览
//
// 这是 ZPass 双进程 SSH agent 架构中的「守护进程」一端。本进程：
//   - 监听 SSH agent protocol socket / named pipe，给 ssh / git 等客户端用
//   - 连接到 ZPass GUI 的控制通道，转发签名请求 + 接收公钥推送
//   - **不持有任何私钥**，私钥永远只在 GUI 进程内解密 + 签名
//
// 为什么独立 binary 而不是 GUI 进程的子线程：
//   1. **内存占用**：纯 Go 守护进程约 8-15 MB RSS，远低于带 webview 的
//      GUI（200+ MB）。后台常驻经济。
//   2. **GUI 关掉也能用**：用户关掉 ZPass 主窗口仍能 ssh / git，agent 会
//      在签名请求时按需通知 GUI 重新启动（MVP 阶段是「GUI 不在则签名失败」，
//      按需拉起是下一版本）。
//   3. **系统服务集成**：systemd / launchd 能自然管理本进程，配合 socket
//      activation 实现「无连接时进程不存在 = 0 内存」。
//   4. **安全边界**：agent 进程被攻破不能解密私钥（DEK 不在本进程内存中）。
//
// ---------------------------------------------------------------------------
// 启动流程
//
//  1. 解析 flag（--debug / --version / --systemd 等）
//  2. 解析 SSH agent socket 路径（来自 sshagentproto.AgentSocketPath）
//  3. 解析控制通道路径 + capability token 路径
//  4. 创建 AgentState（内存索引 + pending 注册表）
//  5. 启动 SSH agent listener（在 socket 上 accept）
//  6. 启动 controlClient（connect 到 GUI 控制通道；自动重连）
//  7. 等待 SIGINT / SIGTERM 优雅退出
//
// ---------------------------------------------------------------------------
// 优雅停机
//
// 收到信号 → ctx cancel → 三个组件并发清理：
//   - SSH agent listener: cleanup() 关 listener + 删 socket 文件
//   - controlClient: Stop() 关连接 + 让重连循环退出
//   - 进程退出
//
// 已经在 accept / read / sign 中的请求会被强制中断（cancel ctx + close
// 连接），客户端拿到 SSH_AGENT_FAILURE。这是 SSH agent 标准行为，客户端
// 通常会显示「authentication failed」并尝试下一个认证方法。
//
// ---------------------------------------------------------------------------
// 日志输出
//
// 默认输出到 stderr（systemd / launchd 会自动收集到 journal）。--debug
// 开启 DEBUG 级别，否则 INFO。不写日志文件 —— 让系统服务管理器统一管理
// 是更现代的做法（journalctl -u zpass-agent / log show --predicate ...）。

package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zerx-lab/zpass/internal/sshagentproto"
)

// version 在 ldflags 注入时被赋值，否则保留 "dev"
//
// 构建时通过：
//
//	go build -ldflags="-X main.version=v0.1.0" ./cmd/zpass-agent
//
// 使用场景：--version 命令；HELLO 消息中 GUI 端可以看到 agent 的版本以
// 决定 IPC 协议兼容路径。
var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "zpass-agent: %v\n", err)
		os.Exit(1)
	}
}

// run 是 main 的所有真实逻辑，独立函数化让 error 处理能用 return 而非
// 散落的 os.Exit / log.Fatal
//
// 错误处理风格：
//   - 启动阶段错误 → 返回 err，main 打到 stderr + exit 1
//   - 运行期错误 → log warn / error 但不退出（让重连等机制处理）
//   - 致命错误（OS API 不可用等）→ slog.Error + return err
func run() error {
	// ----- flag 解析 -----
	var (
		showVersion bool
		debug       bool
		idleTimeout time.Duration
	)
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.BoolVar(&debug, "debug", false, "enable debug logging")
	flag.DurationVar(&idleTimeout, "idle-timeout", idleTimeoutDefault,
		"in systemd activation mode, exit after this duration with no SSH / GUI activity (0 disables)")
	flag.Parse()

	if showVersion {
		fmt.Printf("zpass-agent %s\n", version)
		return nil
	}

	// ----- 日志初始化 -----
	logLevel := slog.LevelInfo
	if debug {
		logLevel = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: logLevel,
		// 不加 AddSource —— 减少日志噪音；调试时再开
	})).With("component", "zpass-agent", "version", version)

	logger.Info("starting")

	// ----- 路径解析 -----
	agentPath, err := sshagentproto.AgentSocketPath()
	if err != nil {
		return fmt.Errorf("resolve agent socket path: %w", err)
	}
	controlPath, err := sshagentproto.ControlSocketPath()
	if err != nil {
		return fmt.Errorf("resolve control socket path: %w", err)
	}
	tokenPath, err := sshagentproto.CapabilityTokenPath()
	if err != nil {
		return fmt.Errorf("resolve capability token path: %w", err)
	}

	// 确保 socket 所在目录存在（Linux/macOS unix socket 父目录必须先有；
	// Windows named pipe 这里是 no-op）
	if err := sshagentproto.EnsureAgentDir(); err != nil {
		return fmt.Errorf("ensure agent dir: %w", err)
	}

	logger.Info("paths resolved",
		"agentSocket", agentPath,
		"controlSocket", controlPath,
		"capabilityToken", tokenPath,
	)

	// ----- 信号处理 + ctx -----
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	// SIGINT (Ctrl-C) + SIGTERM (systemd / kill) 都触发优雅退出
	// 不监听 SIGHUP —— 当前没有「reload 配置」需求
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// ----- 创建 state -----
	state := NewAgentState()

	// ----- 创建 GUI 拉起器 -----
	//
	// launcher 在「GUI 未连接但收到 sign 请求」时会被调。仅当能定位到
	// GUI binary 才有意义 —— 定位失败也不错，只会在需要时返错。
	//
	// 作为 Linux/macOS 最重要的 UX 特性 —— 让用户「关 GUI 后仍能 ssh」。
	launcher := newGUILauncher(logger)
	state.SetGUILauncher(launcher)

	// ----- 启动 SSH agent listener -----
	cleanupListener, activated, err := startAgentListener(ctx, agentPath, state, logger.With("subsystem", "ssh-listener"))
	if err != nil {
		return fmt.Errorf("start agent listener: %w", err)
	}
	defer cleanupListener()

	// ----- 只有在 socket activation 模式下才启用 idle exit -----
	//
	// fallback 模式（自己 net.Listen / GUI 子进程）下，如果退了就没人拉起，
	// 反而让用户 ssh 失败。activated=true 表明 systemd 会在我们退了之后接手。
	if activated && idleTimeout > 0 {
		idle := newIdleTracker(cancel, logger)
		idle.Enable(idleTimeout)
		state.SetIdleTracker(idle)
		defer idle.Stop()
	}

	// ----- 启动控制通道客户端 -----
	client := newControlClient(controlPath, tokenPath, state, logger.With("subsystem", "control"))
	go client.Run(ctx)
	defer client.Stop()

	logger.Info("ready", "pid", os.Getpid())

	// ----- 等待信号 -----
	select {
	case sig := <-sigCh:
		logger.Info("signal received, shutting down", "signal", sig.String())
	case <-ctx.Done():
		// 一般不会走到这里 —— ctx 是我们自己创建的，没有外部 cancel
		logger.Info("context cancelled, shutting down")
	}

	cancel()
	logger.Info("stopped")
	return nil
}
