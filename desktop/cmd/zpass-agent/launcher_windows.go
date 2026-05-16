//go:build windows

// GUI 按需拉起 —— Windows 实现
//
// ---------------------------------------------------------------------------
// 用 CREATE_NEW_PROCESS_GROUP + DETACHED_PROCESS flag 让 GUI 真正脱离
// agent 进程：
//   - DETACHED_PROCESS：不继承 agent 的 console（GUI 是 windows app，
//     不该有 console）
//   - CREATE_NEW_PROCESS_GROUP：让 GUI 处于独立 process group，agent
//     退出时不会通过 CTRL_BREAK_EVENT 等信号联动关闭 GUI

package main

import (
	"log/slog"
	"os/exec"

	"golang.org/x/sys/windows"
)

const (
	detachedProcess          = 0x00000008
	createNewProcessGroup    = 0x00000200
	createUnicodeEnvironment = 0x00000400
)

// spawnGUIPlatform Windows 实现：DETACHED_PROCESS + new process group
func spawnGUIPlatform(binary string, logger *slog.Logger) error {
	cmd := exec.Command(binary)
	cmd.SysProcAttr = &windows.SysProcAttr{
		HideWindow:    false, // GUI 应当显示
		CreationFlags: detachedProcess | createNewProcessGroup | createUnicodeEnvironment,
	}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return err
	}
	logger.Info("GUI process spawned (detached)", "pid", cmd.Process.Pid)

	// Release 让 Go runtime 不持有 process 句柄 —— Windows 上没有 init
	// 收尸概念，但 Release 后 OS 自然管理。
	_ = cmd.Process.Release()
	return nil
}
