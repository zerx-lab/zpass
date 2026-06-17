// nativehost 拉起 Desktop GUI —— macOS 实现
//
// .app bundle 用 open -a 让 LaunchServices 接管；裸 binary 直接 exec。

package main

import (
	"os/exec"
	"strings"
)

func spawnGUIForNativeHost(binary string) error {
	target := guiBundleTarget(binary)
	var cmd *exec.Cmd
	if strings.HasSuffix(target, ".app") {
		cmd = exec.Command("open", "-a", target)
	} else {
		cmd = exec.Command(target)
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

// guiBundleTarget 把 .app 内层 Mach-O 路径反推回 bundle 目录，交给
// open -a 让 LaunchServices 接管（正确激活 + 单实例语义）。已是 bundle
// 或裸 binary 的路径原样返回。
func guiBundleTarget(binary string) string {
	const inner = ".app/Contents/MacOS/"
	if i := strings.Index(binary, inner); i != -1 {
		return binary[:i+len(".app")]
	}
	return binary
}
