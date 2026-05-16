//go:build windows

// 控制通道连接 —— Windows named pipe 实现
//
// ---------------------------------------------------------------------------
// 实现选用 github.com/Microsoft/go-winio
//
// Windows named pipe 不能用 net.Dial("unix", ...) —— Windows 1809 起虽然
// 加了 unix socket 支持，但 Go 标准库在 Windows 上的 unix socket 仍要求
// abstract namespace，与我们用的命名 pipe 是完全不同的概念。
//
// go-winio 是 Microsoft 官方维护的 winapi 封装，已经在 go.sum 中（被
// Wails 3 间接依赖），引入不会增加依赖体积。
//
// API：
//   - winio.DialPipeContext(ctx, path) 阻塞直到 pipe 可用或 ctx 取消
//   - 返回的 net.Conn 实现了完整 Read/Write/Close/SetDeadline 接口
//
// pipe 还没人 listen 时 DialPipe 会失败而非 hang —— Windows pipe 不像
// unix socket 那样允许「文件存在但无 accepter」。这是好事，agent 重试
// 时不会卡在 connect 上。

package main

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

// dialControlPlatform 在 Windows 上连接到 named pipe
//
// 由 dialControl 调用（control.go），通过 build tag 分平台。
// 非 Windows 实现见 dial_unix.go。
func dialControlPlatform(ctx context.Context, pipePath string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, pipePath)
}
