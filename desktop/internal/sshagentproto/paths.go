// 跨平台路径解析 —— 协议契约层
//
// ---------------------------------------------------------------------------
// 为什么放在 sshagentproto 包里
//
// GUI 与 agent **必须**对所有共享路径达成共识 —— 一边写 socket，另一边
// 监听 socket，路径稍有不同就连不上。这些路径本质上是协议契约的一部分。
//
// 即便不同平台路径解析逻辑不同（XDG_RUNTIME_DIR / NSApplicationSupport /
// %LOCALAPPDATA%），最终解析出的「字符串」必须两端完全一致。把解析函数
// 集中在协议包里让两端用同一份实现，从根上避免漂移。
//
// ---------------------------------------------------------------------------
// 路径决策矩阵
//
//	平台    Agent socket                                  Capability token
//	─────────────────────────────────────────────────────────────────────────
//	Linux   $XDG_RUNTIME_DIR/zpass/agent.sock             ~/.config/zpass/agent.cap
//	        (fallback: ~/.zpass/agent.sock)
//	macOS   ~/Library/Application Support/ZPass/          ~/.config/zpass/agent.cap
//	        agent.sock
//	Windows \\.\pipe\zpass-ssh-agent-<sid>                %USERPROFILE%\.config\zpass\agent.cap
//
// 各路径选择理由：
//
// Linux agent socket：
//   - XDG_RUNTIME_DIR (通常 /run/user/<uid>) 是 systemd 创建的 tmpfs，
//     重启即清，权限自动 0700 限当前用户 —— 完美契合「短生命周期 IPC」
//     语义。
//   - 不在 ~/.config/ 下：socket 是运行时状态而非配置，按 XDG Base
//     Directory 规范应分开。
//   - fallback ~/.zpass/agent.sock：对未走 systemd 的极端环境（容器、
//     精简发行版）兜底。
//
// macOS agent socket：
//   - 没有 XDG_RUNTIME_DIR 等价物，~/Library/Application Support/ 是
//     Apple 推荐的「应用私有数据」目录，权限默认仅用户可访问。
//   - 不放 /var/run：那需要 root，与「per-user agent」违和。
//   - 不放 /tmp：macOS 上 /tmp 默认 1777，跨用户可见。
//
// Windows named pipe：
//   - \\.\pipe\ 是 named pipe 命名空间，Windows 原生支持。
//   - 带 -<sid> 后缀让多用户机器上不会冲突。
//   - SID 取自 GetCurrentProcessUser，与 ACL 校验对应：只有同 SID 的
//     进程能 connect。
//
// Capability token 跨平台统一在 ~/.config/zpass/ ：
//   - 与 configservice.go 的 ConfigService.Dir() 完全一致，token 视为
//     ZPass 配置体系的一部分。
//   - Windows 上 .config 不是隐藏目录，但行为正确，与本项目跨平台路径
//     一致性约定吻合（见 README.md「为什么用 ~/.config」段落）。
//
// ---------------------------------------------------------------------------
// 错误处理
//
// 所有解析函数返回 (string, error)。失败原因主要是 os.UserHomeDir() 出错
// （罕见，比如设了非法的 HOME），调用方应当当作致命错误 —— agent 无路径
// 就无法启动，让用户看到「找不到 home 目录」远比静默失败有用。

package sshagentproto

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

// configDir 解析 ~/.config/zpass/ 的绝对路径
//
// 与 configservice.go 的 resolveConfigDir 实现等价，但**不能直接调那个
// 函数** —— configservice 在 package main 里，本包在 internal/，向上
// 引用会形成循环依赖（main → sshagentservice → sshagentproto → main）。
//
// 解决方案：两份独立实现，靠 Go test 保证字符串结果一致（见
// sshagent_paths_test.go，待写）。
func configDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("sshagentproto: resolve home: %w", err)
	}
	return filepath.Join(home, ".config", "zpass"), nil
}

// ---------------------------------------------------------------------------
// 对外路径函数
// ---------------------------------------------------------------------------

// CapabilityTokenPath 返回 capability token 文件的绝对路径
//
// 跨平台统一在 ~/.config/zpass/agent.cap。GUI 启动时如不存在则生成，
// agent 启动时如不存在则等待。
//
// 调用方不应缓存返回值 —— 用户切换登录会话 (su / sudo) 时 home 可能变化，
// 每次按需解析。
func CapabilityTokenPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, CapabilityFilename), nil
}

// EnsureCapabilityDir 确保 capability token 所在目录存在
//
// 用户首次启动 ZPass 时 ~/.config/zpass/ 可能还不存在，调用方在写 token
// 之前应先调用本函数。权限 0o700 比 configservice.go 的 0o755 更严，
// 因为这个目录里马上要放鉴权 token，宁严勿宽。
//
// **不在 CapabilityTokenPath 内做**：让路径函数保持「纯查询无副作用」，
// 调用方在合适时机（GUI 首次启动时）显式调用一次。
func EnsureCapabilityDir() error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("sshagentproto: create %s: %w", dir, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Agent socket / pipe 路径
// ---------------------------------------------------------------------------

// AgentSocketPath 返回 SSH agent 监听 socket / named pipe 的路径
//
// 这是 ssh / git 等客户端 connect 的目标 —— 用户需要把它设到
// SSH_AUTH_SOCK 环境变量或 OpenSSH config 的 IdentityAgent。
//
// 返回值在不同平台是「不同概念」：
//   - Linux/macOS：unix socket 文件系统路径，net.Listen("unix", path) 接受
//   - Windows：named pipe，winio.ListenPipe(path) 接受
//
// 调用方通过 runtime.GOOS 判断并用对应 API。本函数只负责路径字符串。
//
// 返回值约定：
//   - 路径所在的父目录如不存在，调用方负责 mkdir（见 EnsureAgentDir）
//   - 已存在的同名 socket 文件由 listener 启动时检测：能 connect 则视为
//     另一个实例正在跑（拒绝启动），不能则视为残留（删除后重建）
func AgentSocketPath() (string, error) {
	switch runtime.GOOS {
	case "linux":
		return linuxAgentSocketPath()
	case "darwin":
		return darwinAgentSocketPath()
	case "windows":
		return windowsAgentPipePath()
	default:
		// freebsd / openbsd 等小众平台暂不支持。返回明确错误而非「按 Linux
		// 处理」—— 让用户看到「不支持」比看到神秘的 socket 错误友好。
		return "", fmt.Errorf("sshagentproto: SSH agent not supported on %s", runtime.GOOS)
	}
}

// linuxAgentSocketPath 解析 Linux 下的 socket 路径
//
// 优先级：
//  1. $XDG_RUNTIME_DIR/zpass/agent.sock
//  2. ~/.zpass/agent.sock（fallback）
//
// XDG_RUNTIME_DIR 由 systemd-logind 在用户登录时创建并设置环境变量，
// 标准路径形如 /run/user/1000。这块是 tmpfs，权限 0700 自动隔离用户，
// 重启即清 —— 是 IPC socket 的最佳选择。
//
// 没设 XDG_RUNTIME_DIR 的场景（Docker 容器、SSH 进入但无 systemd 用户
// session）退回 ~/.zpass/agent.sock，由 EnsureAgentDir 创建。
func linuxAgentSocketPath() (string, error) {
	if runtime := os.Getenv("XDG_RUNTIME_DIR"); runtime != "" {
		return filepath.Join(runtime, "zpass", "agent.sock"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("sshagentproto: resolve home: %w", err)
	}
	return filepath.Join(home, ".zpass", "agent.sock"), nil
}

// darwinAgentSocketPath 解析 macOS 下的 socket 路径
//
// 落在 ~/Library/Application Support/ZPass/agent.sock：
//   - Apple 推荐的「应用私有数据」目录，权限默认仅用户可访问
//   - 与 NSApplicationSupportDirectory 一致（Wails 3 也会写这里）
//   - 避免 /tmp（默认 1777 跨用户可见）和 /var/run（需 root）
//
// 不使用 ~/.config/zpass/agent.sock：Mac 用户更熟悉 Library 路径，且
// Apple SLA 明确说明 ~/Library/Application Support 不会被系统清理。
func darwinAgentSocketPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("sshagentproto: resolve home: %w", err)
	}
	return filepath.Join(home, "Library", "Application Support", "ZPass", "agent.sock"), nil
}

// windowsAgentPipePath 解析 Windows named pipe 名
//
// 形如 \\.\pipe\zpass-ssh-agent-S-1-5-21-... 带 SID 后缀，
// 避免多用户机器上 pipe 名冲突。
//
// SID 通过 windowsCurrentSID() 获取，具体实现在 paths_windows.go
// （build tag `//go:build windows`）；非 Windows 构建走 paths_others.go
// 的 stub —— 但 Linux/macOS 路径解析根本不会进入本函数（AgentSocketPath
// 的 switch case 已经分流），所以 stub 即使返回 error 也只是「永不触发」
// 的死代码，保留是为了让 windowsAgentPipePath 本身能在所有 GOOS 下
// 编译通过（被同一文件的 switch 引用）。
//
// 不带 SID 后缀的极端 fallback：如果取 SID 失败，用「zpass-ssh-agent-default」
// 让单用户机器仍能跑起来。多用户机器上这种 fallback 会有冲突警告。
func windowsAgentPipePath() (string, error) {
	// 路径常量化前缀，避免硬编码字符串散落
	const pipePrefix = `\\.\pipe\zpass-ssh-agent`

	sid, err := windowsCurrentSID()
	if err != nil {
		// 单用户机器下 fallback 仍可工作
		_ = err // 显式忽略：fallback 是设计中的容错路径
		return pipePrefix + "-default", nil
	}
	return pipePrefix + "-" + sid, nil
}

// EnsureAgentDir 确保 agent socket 所在的父目录存在
//
// 仅对 Linux / macOS 有意义 —— Windows named pipe 不需要文件系统目录。
// 权限 0o700：与 capability token 目录一致，仅当前用户可访问。
//
// Windows 调用此函数是 no-op，返回 nil。
func EnsureAgentDir() error {
	if runtime.GOOS == "windows" {
		return nil
	}
	socketPath, err := AgentSocketPath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(socketPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("sshagentproto: create %s: %w", dir, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Control socket / pipe 路径（GUI ↔ agent）
// ---------------------------------------------------------------------------

// ControlSocketPath 返回控制通道的 socket / named pipe 路径
//
// 与 AgentSocketPath 同目录但文件名不同 —— 物理上分开两条通道：
//   - agent.sock：暴露给 ssh / git 客户端
//   - control.sock：仅 ZPass GUI 与 zpass-agent 之间使用
//
// 分开的理由：
//  1. 监听代码不同（agent 用 ssh/agent.ServeAgent，control 用自定义协议）
//  2. 访问控制不同（虽然都是当前用户，但语义清晰：一个对外，一个对内）
//  3. 调试 dump 更容易区分（看 socket 名就知道流量类型）
//
// Windows named pipe 名相应为 \\.\pipe\zpass-control-<sid>。
func ControlSocketPath() (string, error) {
	switch runtime.GOOS {
	case "linux", "darwin":
		// 直接复用 AgentSocketPath 的目录解析，只换文件名
		agentPath, err := AgentSocketPath()
		if err != nil {
			return "", err
		}
		dir := filepath.Dir(agentPath)
		return filepath.Join(dir, "control.sock"), nil
	case "windows":
		const pipePrefix = `\\.\pipe\zpass-control`
		sid, err := windowsCurrentSID()
		if err != nil {
			_ = err
			return pipePrefix + "-default", nil
		}
		return pipePrefix + "-" + sid, nil
	default:
		return "", fmt.Errorf("sshagentproto: control channel not supported on %s", runtime.GOOS)
	}
}
