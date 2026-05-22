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

package services

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

// Status 查询 .service 和 .socket 文件存在 + .socket 是否 enable + service 是否健康
func (i *systemdUserInstaller) Status() (SystemServiceStatus, error) {
	dir, err := systemdUserDir()
	if err != nil {
		return SystemServiceStatus{Supported: true, PlatformLabel: i.PlatformLabel()}, err
	}
	servicePath := filepath.Join(dir, "zpass-agent.service")
	socketPath := filepath.Join(dir, "zpass-agent.socket")

	installed := fileExistsService(servicePath) && fileExistsService(socketPath)
	enabled := false
	healthy := false
	var lastErr string
	if installed {
		// systemctl --user is-enabled zpass-agent.socket
		// 返回 "enabled" 才视为启用；"static" / "disabled" / "linked" 都不算
		cmd := exec.Command("systemctl", "--user", "is-enabled", "zpass-agent.socket")
		out, _ := cmd.Output()
		enabled = strings.TrimSpace(string(out)) == "enabled"

		// 健康检查：enable 不等于「能拉起」。这里查两样东西：
		//   1. socket unit 必须 active（开机/登入后 systemd 会自动启动 socket）
		//   2. service unit 不能处于 failed / activating(auto-restart) 状态
		//      —— 后者意味着进程反复 NAMESPACE / binary missing 等错误
		if enabled {
			healthy, lastErr = i.checkServiceHealth()
		}
	}

	return SystemServiceStatus{
		Supported:     true,
		Installed:     installed,
		Enabled:       enabled,
		Healthy:       healthy,
		LastError:     lastErr,
		PlatformLabel: i.PlatformLabel(),
	}, nil
}

// checkServiceHealth 查 socket unit 是否 active + service 是否在反复失败
//
// 返回 (healthy, lastError)：
//   - healthy=true: socket active 且 service 没在失败循环
//   - healthy=false: lastError 携带从 systemctl is-failed / show 读出的描述
//
// 调用 systemctl is-active / is-failed 而非解析 status 输出 —— 后者未是
// 稳定接口，且装了 i18n 后会闹中文。
func (i *systemdUserInstaller) checkServiceHealth() (bool, string) {
	// 1. socket unit 必须 active
	sockActive := strings.TrimSpace(runSystemctlOutput("is-active", "zpass-agent.socket"))
	if sockActive != "active" {
		return false, fmt.Sprintf("socket unit not active (state=%s)", sockActive)
	}

	// 2. service unit 不能 is-failed
	//    is-failed 返回状态 "failed" 或 "activating" (auto-restart 循环中) 都是问题。
	//    正常状态是 "inactive" (等待 socket activation) 或 "active" (刚被拉起中)。
	svcState := strings.TrimSpace(runSystemctlOutput("is-active", "zpass-agent.service"))
	switch svcState {
	case "failed", "activating":
		// 拉一下最近的错误信息，提供给 UI
		result := strings.TrimSpace(runSystemctlOutput("show", "-p", "Result", "zpass-agent.service"))
		return false, fmt.Sprintf("service unit in bad state (%s; %s)", svcState, result)
	}

	return true, ""
}

// runSystemctlOutput 同 runSystemctl 但返回 stdout（失败时返回空串）
//
// is-active / is-failed 这些命令「失败」本身就是信息一部分，不能当错误处理。
func runSystemctlOutput(args ...string) string {
	all := append([]string{"--user"}, args...)
	cmd := exec.Command("systemctl", all...)
	out, _ := cmd.Output()
	return string(out)
}

// Install 写文件 + daemon-reload + enable（可选 --now）
func (i *systemdUserInstaller) Install(agentBinary string, startNow bool) error {
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
	if startNow {
		_ = runSystemctl("enable", "--now", "zpass-agent.socket")
	} else {
		// 仅 enable：default.target 依赖生效后（下次登入）才启动 socket。
		// 避免与 GUI supervisor 子进程争抢 socket fd。
		_ = runSystemctl("enable", "zpass-agent.socket")
	}

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
# 仅当 socket 被 ssh 客户端连接触发时才启动，不要在 GUI 启动后立即拉起：
# 「GUI 在跑」意味着 GUI 的 controlListener 在 control.sock 上 listen，
# agent 通过 socket activation 起来后会通过 control 通道连回 GUI。
Requires=zpass-agent.socket

[Service]
Type=simple
ExecStart=%s --idle-timeout=5m
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=10
# 不要 Restart=on-failure：失败时进入退避循环会反复尝试，掩盖根因
# （例如配置错误、binary 缺失）。失败一次让 systemd-journal 直接暴露问题，
# 下次 socket 连接会再触发一次启动，自然的重试节奏。
Restart=no

# 资源限制 —— agent 是只读协议适配器，绝不该用很多内存
MemoryMax=64M
TasksMax=32

# 安全 sandbox
#
# 这里的 ReadWritePaths 列出 agent 实际可能写的目录：
#   - %%t/zpass            → XDG_RUNTIME_DIR/zpass (socket 文件)
#   - %%h/.config/zpass    → capability token (agent.cap)
#
# 每条都用 "-" 前缀容忍缺失 —— 开发模式下某些目录可能还没创建，systemd
# 默认会因为 "No such file or directory" 拒绝启动 (status=226/NAMESPACE)。
# 加 "-" 后 systemd 把缺失视为 warning 而非 fatal。
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=-%%t/zpass -%%h/.config/zpass
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
