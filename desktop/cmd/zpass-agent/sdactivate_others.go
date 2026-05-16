//go:build !linux

// 非 Linux 平台的 socket activation stub
//
// ---------------------------------------------------------------------------
// macOS 的 launchd 也有类似机制（launch_activate_socket），但 API 形态
// 不同。我们在 v3 阶段只先做 Linux 的 systemd 集成；macOS / Windows 的
// socket activation 留给 v4+。
//
// 此 stub 让非 Linux 编译能通过 main.go 的 import + 调用。运行时永远
// 返回「未启用 socket activation」让 main 走 fallback 自己 Listen。

package main

import "net"

// tryAdoptSystemdSocket stub：非 Linux 平台永远返回 (nil, false, nil)
//
// macOS launchd 集成需要的不同 API：
//
//	#include <launch.h>
//	int launch_activate_socket(const char *name, int **fds, size_t *cnt);
//
// 这需要 cgo + 处理 launchd plist 里的 <key>Sockets</key> 配置。本阶段
// 暂不实现。
func tryAdoptSystemdSocket() (net.Listener, bool, error) {
	return nil, false, nil
}
