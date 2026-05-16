//go:build linux

// systemd socket activation 支持（仅 Linux）
//
// ---------------------------------------------------------------------------
// 目标
//
// 让 zpass-agent 进程能从 systemd 继承已经绑定好的 listener fd，而不是
// 自己 net.Listen。配合 zpass-agent.socket 即可获得「按需启动 + 空闲
// 0 MB 内存」的体验：
//
//   $ ssh -T git@github.com
//      ↓ 第一次 connect 触发 systemd 拉起 zpass-agent
//      ↓ systemd 把已经 accept 准备好的 fd=3 传给我们
//      ↓ zpass-agent 立即处理协议
//
//   (5 分钟无连接后 ↓)
//   $ systemctl --user stop zpass-agent.service
//      ↓ 进程退出
//   $ free -h
//      → zpass-agent 进程不存在，0 MB 占用
//
// ---------------------------------------------------------------------------
// systemd 接口
//
// 子进程通过两个环境变量识别 socket activation：
//   LISTEN_PID  = 期望接收 fd 的进程 PID（防 fd 泄漏到 fork 后代）
//   LISTEN_FDS  = 被传入的 fd 数量（fd 编号从 SD_LISTEN_FDS_START=3 开始）
//   LISTEN_FDNAMES = （可选）每个 fd 的名字，冒号分隔
//
// 我们只支持「单 fd」场景 —— 一个 SSH agent socket。如果将来要让一个
// agent 进程同时监听 control 通道 + agent 通道，需要扩到多 fd（用
// LISTEN_FDNAMES 区分）。
//
// ---------------------------------------------------------------------------
// 实现选用 net.FileListener 而非 sd_listen_fds
//
// 标准做法是用 C 库 `sd_listen_fds()`，但 Go 不必 —— 直接用 os.NewFile
// + net.FileListener 就能把裸 fd 转成 net.Listener。
//
// 优点：
//   - 纯 Go，无 cgo
//   - 处理逻辑与「自己 Listen」分支共用 net.Listener 接口
//
// 唯一注意：os.NewFile 不会 dup fd，原 fd 由我们独占（systemd 不会回收），
// listener Close 时会真正关 fd。

package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
)

// sdListenFdStart 是 systemd 传 fd 的起始编号
//
// 来自 systemd <sd-daemon.h> 的 SD_LISTEN_FDS_START 常量：
//
//	#define SD_LISTEN_FDS_START 3
//
// 因为 0/1/2 是 stdin/stdout/stderr。
const sdListenFdStart = 3

// tryAdoptSystemdSocket 尝试从 systemd 继承 listener fd
//
// 返回：
//   - (ln, true, nil)：成功继承 fd，调用方应当用此 listener 而不要自己
//     net.Listen
//   - (nil, false, nil)：没有 socket activation（环境变量不存在 / PID 不
//     匹配），调用方走正常 net.Listen 流程
//   - (nil, false, err)：变量存在但解析失败 / fd 数量不对，调用方退出
//
// PID 校验：LISTEN_PID 必须等于 os.Getpid()。这是 systemd 防止 fd 在
// fork 后被子孙进程误用的安全机制 —— 它只把 fd 给「直系子进程」。
//
// 失败处理策略：
//   - 解析变量失败 → 这是 systemd 的「明确告诉我们用 socket activation
//     但格式不对」，是严重错误，返回 err 让 main 决定是否退出
//   - 没设变量 → 返回 (nil, false, nil)，让 main 走 fallback 自己 Listen
//
// 副作用：调用后无论结果如何都会 unset LISTEN_PID/FDS/FDNAMES，避免任何
// 后续 fork 的子进程（理论上 zpass-agent 不 fork，但防御性 unset）拿到。
func tryAdoptSystemdSocket() (net.Listener, bool, error) {
	pidStr := os.Getenv("LISTEN_PID")
	fdsStr := os.Getenv("LISTEN_FDS")
	if pidStr == "" || fdsStr == "" {
		// 完全没设环境变量 —— 不是 socket activation 模式，正常路径
		return nil, false, nil
	}

	// unset 让后续不会再被误用 —— 即便我们这次失败也清掉
	_ = os.Unsetenv("LISTEN_PID")
	_ = os.Unsetenv("LISTEN_FDS")
	_ = os.Unsetenv("LISTEN_FDNAMES")

	pid, err := strconv.Atoi(pidStr)
	if err != nil {
		return nil, false, fmt.Errorf("parse LISTEN_PID=%q: %w", pidStr, err)
	}
	if pid != os.Getpid() {
		// PID 不匹配 —— 这个变量是给别的进程的（祖先 systemd 设了，
		// 我们经过 fork 链下来），不能用。这等同于「没有 socket activation」
		return nil, false, nil
	}

	nfds, err := strconv.Atoi(fdsStr)
	if err != nil {
		return nil, false, fmt.Errorf("parse LISTEN_FDS=%q: %w", fdsStr, err)
	}
	if nfds < 1 {
		return nil, false, fmt.Errorf("LISTEN_FDS=%d, expected >= 1", nfds)
	}
	if nfds > 1 {
		// 我们只用第一个 fd —— 让 main 看到 warn 但不 fatal
		// 多 fd 场景留给将来扩展（control + agent 同时 activation）
		// 这里只用第 0 个
	}

	// 把第一个 fd（编号 sdListenFdStart=3）转成 net.Listener
	// os.NewFile 不 dup —— 我们独占这个 fd 直到 listener Close
	file := os.NewFile(uintptr(sdListenFdStart), "systemd-socket-activation")
	if file == nil {
		return nil, false, fmt.Errorf("os.NewFile failed for fd %d", sdListenFdStart)
	}

	ln, err := net.FileListener(file)
	if err != nil {
		_ = file.Close()
		return nil, false, fmt.Errorf("net.FileListener: %w", err)
	}
	// net.FileListener 内部会 dup fd 到自己的内部句柄，所以原 file 可以关
	if err := file.Close(); err != nil {
		// 关 file 失败不致命 —— listener 已经持有 dup 的 fd
		// 仅作为 debug log（这里没 logger，调用方会感知 listener 正常）
		_ = err
	}

	return ln, true, nil
}
