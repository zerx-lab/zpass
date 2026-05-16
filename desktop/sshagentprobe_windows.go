//go:build windows

// SSH agent 「是否已存活」探测 —— Windows named pipe 实现
//
// 与 cmd/zpass-agent/dial_windows.go 中控制通道拨号逻辑一致，使用
// winio.DialPipeContext：pipe 不存在 / 无 listener 时立即返错误，
// 不会挂起 —— 对「探测」场景是理想行为。

package main

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

// dialAgentSocketWindows Windows 上连接 named pipe 探测 agent
//
// 由 isAgentAlreadyRunning 在 runtime.GOOS == "windows" 时调用。进程
// 需要谈话用户与 agent 进程需要为同一个用户：默认 ACL 让
// owner+admins+SYSTEM 能访问 pipe，同用户 GUI 进程携同进程 token
// 中的 user SID 都会被 DACL 匹配。
func dialAgentSocketWindows(ctx context.Context, pipePath string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, pipePath)
}
