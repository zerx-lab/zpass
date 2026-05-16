//go:build linux || darwin

// SSH agent listener —— Linux / macOS unix socket 实现
//
// ---------------------------------------------------------------------------
// 本文件职责
//
// 在 sshagentproto.AgentSocketPath() 上监听 unix socket，为每个进来的
// 连接调用 agent.ServeAgent 处理 SSH agent 协议。
//
// 几个关键约束：
//
//  1. **权限 0600**：unix socket 在文件系统上有权限位，必须限当前用户
//     可读写 —— 否则同机其它用户能列出 / 请求签名所有 key。
//     标准库 net.Listen 不直接支持 mode 参数（用 umask 影响），所以在
//     listener 启动后立即 os.Chmod 强制设权限。
//
//  2. **残留 socket 检测**：进程意外退出（kill -9 / OOM）会留下 socket
//     文件，下次启动 net.Listen 会失败 EADDRINUSE。处理策略：
//       - 文件存在 + 能 connect 上 → 视为另一个实例正在跑，本进程退出
//       - 文件存在但 connect 失败 → 视为残留，删除后继续 listen
//     不能无脑删 —— 那样多实例启动时彼此覆盖会乱套。
//
//  3. **per-connection peer 解析**：每个 conn accept 后绑定一个
//     peerResolver，用 SO_PEERCRED (Linux) / LOCAL_PEERPID (macOS) 拿
//     对端 PID，再 /proc/<pid>/exe 或 proc_pidpath 拿可执行文件路径。
//
//  4. **并发：每连接一个 goroutine**：SSH agent protocol 是请求-响应
//     模式，单连接内顺序处理。多连接互不影响，标准 net.Listener.Accept
//     循环 + go ServeAgent 即可。

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"time"

	"golang.org/x/crypto/ssh/agent"
)

// startAgentListener 启动 SSH agent listener
//
// 接受参数：
//   - ctx：用于优雅停机（ctx cancel → listener.Close → accept 退出）
//   - socketPath：监听路径（来自 sshagentproto.AgentSocketPath）
//   - state：注入 zpassAgent 的共享状态
//   - logger：日志器
//
// 启动优先级：
//  1. 如果 systemd 传下 fd（LISTEN_PID/FDS）→ 适配以采用
//  2. 否则重检残留 socket + 自己 net.Listen
//
// socket activation 路径下不需要 socketPath / EnsureAgentDir / chmod
// —— systemd 已经把 socket 绑定好了 0600 权限。socketPath 仅作为 log
// 展示。
//
// 返回 (cleanup, error)：
//   - cleanup：调用方在退出时调用，关 listener + 删 socket 文件（仅非 activation 路径）
//   - error：listen 失败 / 残留 socket 冲突
func startAgentListener(
	ctx context.Context,
	socketPath string,
	state *AgentState,
	logger *slog.Logger,
) (cleanup func(), activated bool, err error) {
	// ----- 优先：systemd socket activation -----
	if ln, ok, actErr := tryAdoptSystemdSocket(); actErr != nil {
		return nil, false, fmt.Errorf("adopt systemd socket: %w", actErr)
	} else if ok {
		logger.Info("SSH agent listener adopted from systemd",
			"addr", ln.Addr().String())

		go acceptLoop(ctx, ln, state, logger)

		cleanup = func() {
			_ = ln.Close()
			// 不手动 remove socket 文件 —— systemd 负责 socket 生命周期
			// （RemoveOnStop=yes 送这个清理）
			logger.Info("SSH agent listener stopped (systemd-managed socket retained)")
		}
		return cleanup, true, nil
	}

	// ----- fallback：自己 net.Listen -----

	// 残留检测 —— 见上方注释
	if err := handleStaleSocket(socketPath, logger); err != nil {
		return nil, false, err
	}

	// 启动 listener
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, false, fmt.Errorf("listen %s: %w", socketPath, err)
	}

	// 设权限 0600 —— 必须在 listen 之后立即，避免 race window
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = ln.Close()
		_ = os.Remove(socketPath)
		return nil, false, fmt.Errorf("chmod %s: %w", socketPath, err)
	}

	logger.Info("SSH agent listener started", "path", socketPath)

	// accept 循环 —— 独立 goroutine，main 通过 cleanup 关闭 listener 让它退出
	go acceptLoop(ctx, ln, state, logger)

	cleanup = func() {
		_ = ln.Close()
		// 关 listener 后 socket 文件不会被自动删除（unix socket 是文件系统对象），
		// 手动清理避免下次启动残留检测多绕一圈
		_ = os.Remove(socketPath)
		logger.Info("SSH agent listener stopped")
	}
	return cleanup, false, nil
}

// handleStaleSocket 处理 socket 文件已存在的情况
//
// 三种情况：
//  1. 文件不存在 → return nil（正常路径）
//  2. 文件存在 + 能 connect 上 → 另一个 zpass-agent 实例在跑，返回错误
//  3. 文件存在但 connect 失败 → 视为残留，删除后返回 nil
//
// 不返回 ErrAlreadyRunning 类型 sentinel —— 调用方只需要看 err != nil 就
// 退出，没必要分类。
func handleStaleSocket(socketPath string, logger *slog.Logger) error {
	if _, err := os.Stat(socketPath); err != nil {
		if os.IsNotExist(err) {
			return nil // 正常路径
		}
		return fmt.Errorf("stat %s: %w", socketPath, err)
	}

	// 文件存在 —— 尝试 connect 探测是否有人在 listen
	conn, err := net.DialTimeout("unix", socketPath, 500*time.Millisecond)
	if err == nil {
		// connect 成功 —— 有人在 listen
		_ = conn.Close()
		return fmt.Errorf(
			"another zpass-agent instance appears to be listening on %s; refusing to start",
			socketPath,
		)
	}

	// connect 失败 —— 视为残留
	logger.Warn("stale socket found, removing", "path", socketPath, "dialErr", err)
	if err := os.Remove(socketPath); err != nil {
		return fmt.Errorf("remove stale socket %s: %w", socketPath, err)
	}
	return nil
}

// acceptLoop 持续 accept 新连接，每个 conn 起一个 goroutine 跑 agent 协议
//
// ctx cancel 时 listener.Close 让 Accept 返回 error，循环退出。
// 单连接内的协议错误（客户端发非法字节）由 agent.ServeAgent 内部处理，
// 不会让 listener 退出。
func acceptLoop(ctx context.Context, ln net.Listener, state *AgentState, logger *slog.Logger) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			// ctx 取消后 ln.Close → Accept 返回 net.ErrClosed
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				return
			}
			logger.Warn("accept failed", "err", err)
			// 短暂退避避免 hot loop（理论上 unix socket accept 不会持续失败）
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go serveConn(conn, state, logger)
	}
}

// serveConn 处理单个 SSH 客户端连接
//
// 流程：
//  1. 建立 per-connection peerResolver（从 conn 提取 PID 等）
//  2. 构造 zpassAgent 实例（注入 resolver）
//  3. 调 agent.ServeAgent 阻塞处理协议
//
// 每连接独立的 zpassAgent：peerResolver 必须绑定到具体 conn 才能拿到
// 正确的对端 PID。这点 newZPassAgent 已经设计支持（resolver 是字段而非
// 全局）。
func serveConn(conn net.Conn, state *AgentState, logger *slog.Logger) {
	defer conn.Close()

	// 拿新连接是「进程还在被使用」的明确信号 —— 重置 idle 定时器
	state.touchActivity()

	// 用 connLogger 给本连接 log 加上 remote addr / fd 标识，方便诊断
	connLogger := logger.With(
		"localAddr", conn.LocalAddr().String(),
		"remoteAddr", conn.RemoteAddr().String(),
	)

	// 解析 peer 信息一次性 —— 之后整个连接寿命内复用同一 peerInfo
	// （PID 在连接期间不会变；exe 路径也不会变除非进程换 binary，罕见）
	peer, err := resolvePeerFromConn(conn)
	if err != nil {
		connLogger.Warn("resolve peer failed", "err", err)
		peer = peerInfo{} // 退化为零值，agent.Sign 仍会工作
	}
	connLogger.Info("ssh client connected",
		"clientPid", peer.PID, "clientExe", peer.Exe)

	resolver := func() (peerInfo, error) { return peer, nil }
	myAgent := newZPassAgent(state, connLogger, resolver)

	// ServeAgent 阻塞直到连接关闭。错误（如客户端断开）不需要 log warn ——
	// 是协议正常路径。
	if err := agent.ServeAgent(myAgent, conn); err != nil {
		// io.EOF / connection reset 等是常规结束，不报错
		connLogger.Debug("ssh client disconnected", "err", err)
	}
}
