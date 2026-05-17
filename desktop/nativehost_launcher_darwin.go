//go:build nativehost && darwin

// nativehost 拉起 Desktop GUI —— macOS 实现
//
// .app bundle 用 open -a 让 LaunchServices 接管；裸 binary 直接 exec。

package main

import (
	"os/exec"
	"strings"
)

func spawnGUIForNativeHost(binary string) error {
	var cmd *exec.Cmd
	if strings.HasSuffix(binary, ".app") {
		cmd = exec.Command("open", "-a", binary)
	} else {
		cmd = exec.Command(binary)
	}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	// open 命令自身很快退出 —— 异步 Wait 收尸，避免 zombie
	go func() { _ = cmd.Wait() }()
	return nil
}
