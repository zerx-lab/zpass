// nativehost 拉起 Desktop GUI —— Windows 实现
//
// DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP 让 GUI 独立于 nativehost
// 生命周期，Chrome 关闭 native host 时 GUI 不会被联动结束。

package main

import (
	"os/exec"

	"golang.org/x/sys/windows"
)

const (
	nhDetachedProcess          = 0x00000008
	nhCreateNewProcessGroup    = 0x00000200
	nhCreateUnicodeEnvironment = 0x00000400
)

func spawnGUIForNativeHost(binary string) error {
	cmd := exec.Command(binary)
	cmd.SysProcAttr = &windows.SysProcAttr{
		HideWindow:    false,
		CreationFlags: nhDetachedProcess | nhCreateNewProcessGroup | nhCreateUnicodeEnvironment,
	}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
