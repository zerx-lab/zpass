//go:build windows

// SSH agent listener —— Windows named pipe 实现
//
// ---------------------------------------------------------------------------
// 本文件职责
//
// 在 sshagentproto.AgentSocketPath()（返回 \\.\pipe\zpass-ssh-agent-<sid>）
// 上监听 named pipe，为每个连接调用 agent.ServeAgent。
//
// 与 unix socket 的差异：
//
//   - 不需要 chmod —— winio.PipeConfig 留空 SecurityDescriptor，winio 会调
//     RtlDefaultNpAcl 给出 Windows 标准 named pipe DACL：owner + admins +
//     LOCAL SYSTEM 完整访问，匿名 / 网络访问被拒。
//   - 不需要残留检测 —— Windows pipe 没有「文件残留」概念，进程退出后 pipe
//     自动销毁。
//   - 不需要 cleanup 删文件 —— 同上。
//
// 关于 SDDL（曾经的坑）：
//
//   - 历史上这里写过 "D:P(A;;GA;;;OW)"，注释解释为「仅当前用户」。这是错的：
//     SDDL 里 OW 是 Owner Rights SID (S-1-3-4)，需要进程 token 显式带
//     SeOwnerRightsPrivilege 才会出现在 token 的 group SID 列表中。普通用户
//     进程不带这条特权，结果该 DACL 表面允许 owner、实际拒绝所有访问者 ——
//     OpenSSH ssh-add 即使以同一用户身份打开 pipe 也得到 ACCESS_DENIED，
//     失败信息被翻译为「No such file or directory」。
//   - Bitwarden Desktop 的 SSH agent 实现（apps/desktop/desktop_native/core/
//     src/ssh_agent/named_pipe_listener_stream.rs）也是直接用 tokio
//     ServerOptions::new().create(...) 不设 SDDL —— 我们对齐这种做法。
//   - 如果未来要做 OpenSSH 默认 pipe 名（\\.\pipe\openssh-ssh-agent）兼容，
//     依旧用默认 ACL 即可；OpenSSH 服务器禁用后自家进程也是 owner，访问正常。

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/crypto/ssh/agent"
)

// agentPipeSecurityDescriptor 留空让 winio 走 Windows 默认 named pipe ACL
//
// 设为空字符串 → winio.ListenPipe 调 RtlDefaultNpAcl 生成默认 DACL：
// 当前用户 + Administrators + LOCAL SYSTEM 拥有完整访问权，匿名访问拒绝。
// 这与 Bitwarden Desktop / OpenSSH for Windows 自带 ssh-agent 服务的
// 做法一致，能让标准 SSH 客户端（Windows 自带 OpenSSH、Git for Windows
// 的 MSYS OpenSSH、PuTTY/Pageant proxy 等）顺利打开 pipe。
const agentPipeSecurityDescriptor = ""

// startAgentListener 启动 SSH agent named pipe listener
//
// 接口与 Linux/macOS 版本相同（同名同签名，由 build tag 分开实现），
// 让 main.go 可以无视平台直接调用。
func startAgentListener(
	ctx context.Context,
	pipePath string,
	state *AgentState,
	logger *slog.Logger,
) (cleanup func(), activated bool, err error) {
	cfg := &winio.PipeConfig{
		// SecurityDescriptor 留空让 winio 走 RtlDefaultNpAcl（默认 ACL：owner +
		// admins + SYSTEM）。详见 agentPipeSecurityDescriptor 的常量注释。
		SecurityDescriptor: agentPipeSecurityDescriptor,
		// 不设 MessageMode —— 默认 byte stream 模式，与 unix socket 行为一致，
		// ssh/agent 包按字节流处理，无需 message 边界
	}

	ln, err := winio.ListenPipe(pipePath, cfg)
	if err != nil {
		// 同名 pipe 已存在 / 名字非法等都从这里返回
		return nil, false, fmt.Errorf("listen pipe %s: %w", pipePath, err)
	}

	logger.Info("SSH agent listener started", "path", pipePath)

	go acceptLoop(ctx, ln, state, logger)

	cleanup = func() {
		_ = ln.Close()
		logger.Info("SSH agent listener stopped")
	}
	// Windows 不支持 socket activation（当前），activated 永返 false
	return cleanup, false, nil
}

// acceptLoop 与 unix 版同结构 —— 但 net.ErrClosed 在 winio.ListenPipe
// 关闭后也会出现，处理逻辑可以共用
func acceptLoop(ctx context.Context, ln net.Listener, state *AgentState, logger *slog.Logger) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil ||
				errors.Is(err, winio.ErrPipeListenerClosed) {
				return
			}
			logger.Warn("accept failed", "err", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go serveConn(conn, state, logger)
	}
}

// serveConn 与 unix 版同结构
func serveConn(conn net.Conn, state *AgentState, logger *slog.Logger) {
	defer conn.Close()

	// 拿新连接是「进程还在被使用」的明确信号 —— 重置 idle 定时器
	state.touchActivity()

	connLogger := logger.With(
		"pipeAddr", conn.LocalAddr().String(),
	)

	peer, err := resolvePeerFromConn(conn)
	if err != nil {
		connLogger.Warn("resolve peer failed", "err", err)
		peer = peerInfo{}
	}
	connLogger.Info("ssh client connected",
		"clientPid", peer.PID, "clientExe", peer.Exe)

	resolver := func() (peerInfo, error) { return peer, nil }
	myAgent := newZPassAgent(state, connLogger, resolver)

	if err := agent.ServeAgent(myAgent, conn); err != nil {
		connLogger.Debug("ssh client disconnected", "err", err)
	}
}
