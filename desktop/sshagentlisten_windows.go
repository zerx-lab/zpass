//go:build windows

// 控制通道 listener —— Windows named pipe 实现
//
// ---------------------------------------------------------------------------
// 与 cmd/zpass-agent/listener_windows.go 的 named pipe 实现类似但路径不同：
//   - agent pipe：\\.\pipe\zpass-ssh-agent-<sid>（对外，给 ssh 用）
//   - control pipe：\\.\pipe\zpass-control-<sid>（对内，agent 进程连）
//
// 权限通过 winio.PipeConfig.SecurityDescriptor 限制当前用户。

package main

import (
	"fmt"
	"net"

	"github.com/Microsoft/go-winio"
)

// SSH agent controlPipeSecurityDescriptor 留空走默认 ACL
//
// 控制通道是 GUI 、 zpass-agent 之间的 IPC，两者都是当前用户进程，
// 默认 ACL（owner + admins + SYSTEM）足够。设为空字符串后 winio
// 会调 RtlDefaultNpAcl 生成。
//
// 历史上这里写过 "D:P(A;;GA;;;OW)"—— 详见 cmd/zpass-agent/listener_windows.go
// 中 agentPipeSecurityDescriptor 常量上的详细反应。
const controlPipeSecurityDescriptor = ""

// listenControlSocket 在 Windows named pipe 上启动 listener
//
// pipePath 通常形如 \\.\pipe\zpass-control-<sid>。
// 与 unix 版本签名一致，让 sshagentcontrol.go 调用方无需感知平台。
func listenControlSocket(pipePath string) (net.Listener, error) {
	cfg := &winio.PipeConfig{
		SecurityDescriptor: controlPipeSecurityDescriptor,
	}
	ln, err := winio.ListenPipe(pipePath, cfg)
	if err != nil {
		return nil, fmt.Errorf("listen pipe %s: %w", pipePath, err)
	}
	return ln, nil
}
