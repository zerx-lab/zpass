//go:build nativehost && linux

// nativehost 拉起 Desktop GUI —— Linux 实现
//
// 与 cmd/zpass-agent/launcher_linux.go 同策略：Setsid 让 GUI 脱离 nativehost
// 进程组，nativehost 退出（Chrome 关闭）时 GUI 仍存活。

package main

import (
	"os/exec"
	"syscall"
)

func spawnGUIForNativeHost(binary string) error {
	cmd := exec.Command(binary)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
