//go:build linux

// GUI 按需拉起 —— Linux 实现
//
// ---------------------------------------------------------------------------
// 用 exec.Cmd 直接启动 GUI binary。关键是 detach：agent 进程退出时不能
// 把 GUI 带走。
//
// detach 实现：
//   - SysProcAttr.Setsid = true  让子进程成为新 session 的 leader，
//     脱离 agent 的进程组
//   - 不接 cmd.Wait()  让 cmd struct 立即被 GC（子进程交给 init 收尸）
//
// 不用 nohup / disown：那是 shell 概念，与 exec.Cmd 无关。Setsid 是
// kernel 级别的脱离。

package main

import (
	"log/slog"
	"os/exec"
	"syscall"
)

// spawnGUIPlatform Linux 实现：fork + setsid 让 GUI 真正脱离 agent
//
// 注意 cmd.Wait 不调 —— 我们故意「忘掉」子进程，让它运行到自己退出，
// init (PID 1) 会负责收尸。这避免 agent 退出时 GUI 跟着挂。
func spawnGUIPlatform(binary string, logger *slog.Logger) error {
	cmd := exec.Command(binary)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
	// 不继承 stdio —— 让 GUI 自己处理日志（设置成 nil = /dev/null）
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return err
	}
	logger.Info("GUI process spawned (detached)", "pid", cmd.Process.Pid)

	// 不 cmd.Wait —— 故意 detach。Release 让 Go runtime 不持有 process 引用
	_ = cmd.Process.Release()
	return nil
}
