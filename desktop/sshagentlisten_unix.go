//go:build !windows

// 控制通道 listener —— Linux / macOS unix socket 实现
//
// ---------------------------------------------------------------------------
// 与 SSH agent listener（cmd/zpass-agent/listener_unix.go）的差异
//
//   - 路径不同（control.sock vs agent.sock，见 sshagentproto.ControlSocketPath）
//   - 协议不同：控制通道是我们的自定义 length-prefixed JSON，agent 通道是
//     SSH agent protocol
//   - 同样需要 0600 权限 + 残留 socket 检测

package main

import (
	"fmt"
	"net"
	"os"
	"time"
)

// listenControlSocket 在 socketPath 上启动 unix socket listener
//
// 返回的 net.Listener 由调用方在 Stop 时关闭。
//
// 残留 socket 处理逻辑与 cmd/zpass-agent/listener_unix.go 的 handleStaleSocket
// 等价，但实现独立 —— 两个 binary 不能共享代码（不同 package）。
func listenControlSocket(socketPath string) (net.Listener, error) {
	if err := handleStaleControlSocket(socketPath); err != nil {
		return nil, err
	}

	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen unix %s: %w", socketPath, err)
	}

	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = ln.Close()
		_ = os.Remove(socketPath)
		return nil, fmt.Errorf("chmod %s: %w", socketPath, err)
	}
	return ln, nil
}

// handleStaleControlSocket 处理残留 socket
//
// 与 cmd/zpass-agent/listener_unix.go 的 handleStaleSocket 一致：
//   - 文件不存在 → ok
//   - 文件存在且能 connect → 另一个 GUI 在跑，返回错误
//   - 文件存在但 connect 失败 → 删除后 ok
func handleStaleControlSocket(socketPath string) error {
	if _, err := os.Stat(socketPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", socketPath, err)
	}

	conn, err := net.DialTimeout("unix", socketPath, 500*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return fmt.Errorf(
			"control socket %s appears in use by another ZPass instance",
			socketPath,
		)
	}

	if err := os.Remove(socketPath); err != nil {
		return fmt.Errorf("remove stale control socket %s: %w", socketPath, err)
	}
	return nil
}
