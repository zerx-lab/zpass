//go:build linux

// systemd user unit 安装 —— Linux 实现
//
// ---------------------------------------------------------------------------
// 实现要点
//
// 1. **使用 user systemd**（systemctl --user）而非 system-wide：
//    - 不需要 root 权限
//    - 与用户登录会话绑定，符合「per-user 密钥管理」语义
//    - XDG_RUNTIME_DIR 自动可用（socket 落到 /run/user/UID/zpass/）
//
// 2. **socket activation**：写 .socket + .service 两个文件，启用 .socket
//    后 systemd 仅在 ssh 客户端 connect 时才启动 .service，空闲 0 内存。
//
// 3. **路径**：~/.config/systemd/user/zpass-agent.{service,socket}
//
// 4. **systemctl 命令**：通过 exec.Cmd 调用。注意：systemctl --user 在
//    没有 D-Bus session 的环境（容器 / SSH-only 登录）下会失败 —— 这种
//    情况下安装文件成功但 enable / start 失败，仍视为部分成功并提示用户。

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// systemdUserInstaller 是 Linux 上的 systemServiceInstaller 实现
type systemdUserInstaller struct{}

// init 注入 Linux 实现
//
// 与其它平台的 init 互斥（build tag 保证），systemServiceInstallerImpl
// 只会被赋值一次。
func init() {
	systemServiceInstallerImpl = &systemdUserInstaller{}
}

// Supported Linux 平台一律支持 —— 即便 systemd 不在，写文件 + 提示用户
// 都比直接放弃好。运行时 systemctl 调用失败由 Install 内部处理。
func (i *systemdUserInstaller) Supported() bool {
	return true
}

// PlatformLabel 给前端展示
func (i *systemdUserInstaller) PlatformLabel() string {
	return "systemd user service (socket activation)"
}

// Status 查询 .service 和 .socket 文件存在 + .socket 是否 enable
func (i *systemdUserInstaller) Status() (SystemServiceStatus, error) {
	dir, err := systemdUserDir()
	if err != nil {
		return SystemServiceStatus{Supported: true, PlatformLabel: i.PlatformLabel()}, err
	}
	servicePath := filepath.Join(dir, "zpass-agent.service")
	socketPath := filepath.Join(dir, "zpass-agent.socket")

	installed := fileExistsService(servicePath) && fileExistsService(socketPath)
	enabled := false
	if installed {
		// systemctl --user is-enabled zpass-agent.socket
		// 返回 "enabled" 才视为启用；"static" / "disabled" / "linked" 都不算
		cmd := exec.Command("systemctl", "--user", "is-enabled", "zpass-agent.socket")
		out, _ := cmd.Output()
		enabled = strings.TrimSpace(string(out)) == "enabled"
	}

	return SystemServiceStatus{
		Supported:     true,
		Installed:     installed,
		Enabled:       enabled,
		PlatformLabel: i.PlatformLabel(),
	}, nil
}

// Install 写文件 + daemon-reload + enable --now
func (i *systemdUserInstaller) Install(agentBinary string) error {
	if agentBinary == "" {
		return errors.New("empty agent binary path")
	}

	dir, err := systemdUserDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}

	servicePath := filepath.Join(dir, "zpass-agent.service")
	socketPath := filepath.Join(dir, "zpass-agent.socket")

	if err := writeFileIfChanged(servicePath, renderServiceUnit(agentBinary), 0o644); err != nil {
		return fmt.Errorf("write service unit: %w", err)
	}
	if err := writeFileIfChanged(socketPath, renderSocketUnit(), 0o644); err != nil {
		return fmt.Errorf("write socket unit: %w", err)
	}

	// systemctl 调用 —— 失败时仅 log 不返错（文件已经写好，用户手动操作仍可用）
	//
	// 不退出整个安装：在容器 / 无 D-Bus 环境下 systemctl 会失败，但用户
	// 仍能通过 `systemctl --user daemon-reload && systemctl --user enable
	// --now zpass-agent.socket` 手动启用。文件写好就是一半的胜利。
	_ = runSystemctl("daemon-reload")
	_ = runSystemctl("enable", "--now", "zpass-agent.socket")

	return nil
}

// Uninstall stop + disable + 删文件
func (i *systemdUserInstaller) Uninstall() error {
	dir, err := systemdUserDir()
	if err != nil {
		return err
	}

	// 先 stop + disable 让 systemd 释放 socket fd —— 失败也继续删文件
	_ = runSystemctl("disable", "--now", "zpass-agent.socket")
	_ = runSystemctl("stop", "zpass-agent.service")

	for _, name := range []string{"zpass-agent.service", "zpass-agent.socket"} {
		path := filepath.Join(dir, name)
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", path, err)
		}
	}

	_ = runSystemctl("daemon-reload")
	return nil
}

// ---------------------------------------------------------------------------
// 辅助：路径 + 命令执行 + 文件写入
// ---------------------------------------------------------------------------

// systemdUserDir 返回 ~/.config/systemd/user/
//
// 标准 XDG 路径，所有发行版 systemd-logind 都默认扫描此目录。
func systemdUserDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home: %w", err)
	}
	return filepath.Join(home, ".config", "systemd", "user"), nil
}

// runSystemctl 调 `systemctl --user <args...>`
//
// 失败时记录 stderr 让上层 log，但不直接 fatal —— 整体「写文件成功」
// 优先级 > 「自动启用成功」。用户可以手动 systemctl 启用。
func runSystemctl(args ...string) error {
	all := append([]string{"--user"}, args...)
	cmd := exec.Command("systemctl", all...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s: %w (output: %s)", strings.Join(args, " "), err, string(out))
	}
	return nil
}

// fileExistsService 与 sshagentsupervisor 的 fileExists 同语义
//
// 重复实现避免跨 build tag 包内符号冲突。
func fileExistsService(path string) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	return st.Mode().IsRegular()
}

// writeFileIfChanged 仅在内容变化时写文件
//
// 让 Install 幂等：多次调用相同 binary 路径 → 第二次起 noop，避免无谓
// 触发 systemd reload。
func writeFileIfChanged(path, content string, mode os.FileMode) error {
	existing, err := os.ReadFile(path)
	if err == nil && string(existing) == content {
		return nil // 内容一致，跳过
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ---------------------------------------------------------------------------
// unit 文件模板
// ---------------------------------------------------------------------------

// renderServiceUnit 生成 zpass-agent.service 内容
//
// 与 build/sshagent/zpass-agent.service 静态模板等价，但 ExecStart 路径
// 动态填入实际安装路径。idle-timeout 让进程在 5 分钟无活动时退出，让
// socket activation 真正发挥「0 内存空闲」效果。
func renderServiceUnit(binaryPath string) string {
	return fmt.Sprintf(`# ZPass SSH Agent — auto-generated by ZPass GUI
# Do not edit directly; ZPass will overwrite this file when settings change.

[Unit]
Description=ZPass SSH agent (zero-knowledge SSH key broker)
Documentation=https://github.com/zerx-lab/zpass
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=%s --idle-timeout=5m
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=10
Restart=on-failure
RestartSec=2s

# 资源限制 —— agent 是只读协议适配器，绝不该用很多内存
MemoryMax=64M
TasksMax=32

# 安全 sandbox
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%%t/zpass %%h/.zpass %%h/.config/zpass
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native

[Install]
WantedBy=default.target
`, binaryPath)
}

// renderSocketUnit 生成 zpass-agent.socket 内容
//
// 与 build/sshagent/zpass-agent.socket 静态模板等价。无可变字段，所有
// 路径都是 %t 宏由 systemd 展开。
func renderSocketUnit() string {
	return `# ZPass SSH Agent socket — auto-generated by ZPass GUI
# Do not edit directly.

[Unit]
Description=ZPass SSH agent socket
Documentation=https://github.com/zerx-lab/zpass

[Socket]
ListenStream=%t/zpass/agent.sock
SocketMode=0600
DirectoryMode=0700
RemoveOnStop=yes
Accept=no

[Install]
WantedBy=sockets.target
`
}
