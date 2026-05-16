//go:build darwin

// GUI 按需拉起 —— macOS 实现
//
// ---------------------------------------------------------------------------
// 用 `open -a ZPass.app`（或路径直传）让 LaunchServices 接管启动。优点：
//   - 自动激活 dock 图标
//   - 用户可见，符合 macOS 应用启动直觉
//   - 由 launchd 接管 GUI 生命周期，agent 退出不影响
//
// 不直接 exec.Cmd(binary)：那会把 GUI 作为 agent 子进程，部分 macOS
// API（dock 互动 / focus）会受影响。open 命令是 macOS 推荐做法。

package main

import (
	"log/slog"
	"os/exec"
	"strings"
)

// spawnGUIPlatform macOS 实现：用 open 命令启动 .app bundle 或裸 binary
func spawnGUIPlatform(binary string, logger *slog.Logger) error {
	var cmd *exec.Cmd
	if strings.HasSuffix(binary, ".app") {
		// .app bundle：用 open 让 LaunchServices 处理
		cmd = exec.Command("open", "-a", binary)
	} else {
		// 裸 binary：直接 exec —— 用户应当用 .app，但裸 binary 容错
		cmd = exec.Command(binary)
	}

	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return err
	}
	logger.Info("GUI process spawned via open", "binary", binary, "pid", cmd.Process.Pid)

	// open 命令自身很快退出（LaunchServices 异步处理）—— Wait 让它收尸
	go func() { _ = cmd.Wait() }()
	return nil
}
