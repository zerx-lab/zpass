//go:build !windows

// 控制通道连接 —— Linux / macOS unix socket 实现
//
// ---------------------------------------------------------------------------
// 实现取舍
//
// 用 `net.Dialer.DialContext` 而非裸 `net.Dial`：
//   - DialContext 支持 ctx 取消（unix socket 连接如果对端 socket 文件
//     存在但没人 accept，会 hang，需要 ctx 限时）
//   - net.Dialer 可以设 timeout / KeepAlive 等参数（即便 unix socket
//     上多数无效，保留以备扩展）
//
// 不直接调 syscall.Connect：标准库 net.Dialer 处理了所有平台细节
// （FD 设非阻塞、信号、retry on EINTR 等），手写不值得。

package main

import (
	"context"
	"net"
)

// dialControlPlatform 在 Linux / macOS 上连接到 unix socket
//
// 由 dialControl 调用（control.go），通过 build tag 分平台。
// Windows 实现见 dial_windows.go。
func dialControlPlatform(ctx context.Context, socketPath string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", socketPath)
}
