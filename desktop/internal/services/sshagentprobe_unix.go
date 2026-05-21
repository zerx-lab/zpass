//go:build !windows

// SSH agent 「是否已存活」探测 —— 非 Windows 平台 stub
//
// 在 Linux/macOS 上，sshagentprobe.go 的 dialAgentSocket 走 net.Dial
// ("unix", ...)，runtime.GOOS != "windows" 分支永远不会进入这里。
// 但 Go 编译器对所有引用做静态可见性检查，所以非 Windows 平台必须能
// 看到 dialAgentSocketWindows 的符号定义；用 stub 满足这层要求。
//
// 该函数永远不会被实际调用：dialAgentSocket 的 runtime.GOOS 守卫保证。

package services

import (
	"context"
	"errors"
	"net"
)

// dialAgentSocketWindows non-Windows stub —— 永远不会被实际调用
//
// 存在仅为让非 Windows 平台的编译器找到符号定义。Linux/macOS 上
// dialAgentSocket 的 runtime.GOOS != "windows" 分支会先选择 unix socket
// 路径，根本不会执行到这里。如果被调到，说明 dialAgentSocket 的分支
// 逻辑被破坏，立即返一个明确错误而非 panic 让调用栈有意义。
func dialAgentSocketWindows(_ context.Context, _ string) (net.Conn, error) {
	return nil, errors.New("dialAgentSocketWindows called on non-windows build")
}
