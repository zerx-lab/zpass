//go:build !windows

// supervisor 平台特定的进程属性 —— Unix
//
// Linux/macOS 上 exec.Cmd 的默认行为对我们够用：子进程继承 GUI 进程
// 的 stdio / env / cwd，收到 GUI 退出信号时跟着退出（前提是 GUI 调
// cmd.Process.Kill 或 signal.SIGTERM）。
//
// 唯一加的：把子进程放进独立 process group，避免 GUI 接收 SIGINT 时
// 信号通过 PGID 自动传递给 agent —— 我们想让 GUI 控制 agent 生命周期，
// 不要内核帮我们做不可控的同步。
//
// 注意：Linux/macOS 上设置 Setpgid 后，发 signal 时需要用 -PGID（如
// syscall.Kill(-pid, SIGTERM)）才能传到整个 group。我们这里只发给
// agent 进程本身（cmd.Process.Signal），所以不需要这层语义。

package services

import (
	"os/exec"
	"syscall"
)

// configurePlatformProcAttr 给 cmd 设置 Unix 平台特定的进程属性
//
// 目前只设 Setpgid = true。其他选项（Pdeathsig 等）暂不开启 —— 等
// 实际遇到问题再加，避免「过早优化」。
func configurePlatformProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}
}

// signalGracefulShutdown 给 cmd 子进程发优雅退出信号
//
// Unix 上 SIGTERM 是规范的「请优雅退出」信号；agent 进程的 signal.Notify
// 捕获 SIGTERM 触发 ctx cancel 走清理流程。
func (s *agentSupervisor) signalGracefulShutdown(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		s.logger.Warn("send SIGTERM to agent failed", "err", err)
	}
}
