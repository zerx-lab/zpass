// SSH agent 服务 —— 系统服务安装
//
// ---------------------------------------------------------------------------
// 目标
//
// 首次启用 SSH agent 服务时自动配置 OS 服务管理器接管 zpass-agent 进程：
//   - Linux:   写 systemd user unit + .socket，systemctl enable + start
//   - Windows: 注册登录时启动的 Scheduled Task
//   - macOS:   暂跳过（当前用户不要求）
//
// 这是「v3 服务化部署」从「静态模板文件」升级为「一键安装」的最后一公里。
// 用户启用 SSH agent 服务时不需要手动 cp + systemctl，全部由 GUI 完成。
//
// ---------------------------------------------------------------------------
// 安装即幂等
//
// 多次调用 InstallSystemService 应当幂等：
//   - 文件已存在且内容相同 → noop
//   - 文件存在但路径变了（agent binary 被移动）→ 重写文件
//   - 服务已启用 → noop
//   - 服务未启用 → enable
//
// 卸载（UninstallSystemService）也是幂等的逆操作。
//
// ---------------------------------------------------------------------------
// 接口抽象
//
// 跨平台抽象成一个 interface，让 SshAgentService 不必区分平台分支。
// 平台实现通过 build tag 注入到 systemServiceInstaller 包级变量：
//   - serviceinstall_linux.go    → systemd user
//   - serviceinstall_windows.go  → Scheduled Task
//   - serviceinstall_others.go   → not supported stub
//
// 与 trusteddevice 的 build tag 抽象模式完全一致。

package services

import (
	"errors"
	"fmt"
)

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

// ErrSystemServiceUnsupported 当前平台不支持自动系统服务安装
//
// 调用方应当把它翻译为 UI 上的「不支持」提示，让用户知道仍可以走「GUI
// 子进程接管 agent」的 fallback 模式（这是 MVP-2 实现的）。
var ErrSystemServiceUnsupported = errors.New("system service install not supported on this platform")

// SystemServiceStatus 反映系统服务的安装/运行状态
type SystemServiceStatus struct {
	// Supported 当前平台是否支持自动安装
	Supported bool `json:"supported"`

	// Installed 服务文件是否已经写入正确位置
	Installed bool `json:"installed"`

	// Enabled 服务是否被设置为开机/登录时自启
	//
	// 对 systemd：socket unit 已 enable
	// 对 Windows：Scheduled Task 已 enable
	Enabled bool `json:"enabled"`

	// Healthy 服务实际是否处于可用状态
	//
	// Enabled 仅说明「配置上声明了自启」，Healthy 还要求实际服务能拉起来：
	//   - systemd：socket unit active 且 service unit 没在反复重启失败
	//   - Windows Scheduled Task：任务存在且未被 disabled
	//
	// GUI 在 Enabled=true 但 Healthy=false 时应当回落到 supervisor 模式
	// 并把 LastError 显示给用户，避免「systemd 抢着 socket 但起不来」的
	// 死锁场景（fd 被占着 + service 反复 NAMESPACE 失败）。
	Healthy bool `json:"healthy"`

	// LastError 最近一次健康检查或安装失败的描述（人类可读，调试用）
	LastError string `json:"lastError,omitempty"`

	// PlatformLabel 给前端展示的平台描述
	//
	// 例："systemd user service (socket activation)" / "Scheduled Task at login"
	PlatformLabel string `json:"platformLabel"`
}

// systemServiceInstaller 跨平台系统服务安装抽象
//
// 实现：
//   - serviceinstall_linux.go   → systemdUserInstaller
//   - serviceinstall_windows.go → scheduledTaskInstaller
//   - serviceinstall_others.go  → unsupportedInstaller
type systemServiceInstaller interface {
	// Supported 当前平台是否能调用 OS 服务管理器
	//
	// false → InstallSystemService 应当返回 ErrSystemServiceUnsupported。
	// 不同于 Status().Supported（那个面向 UI），本字段是「实现层判断」。
	Supported() bool

	// PlatformLabel 给 UI 展示的平台描述
	PlatformLabel() string

	// Install 安装 + 启用系统服务
	//
	// agentBinary 是当前 zpass-agent 可执行文件的绝对路径。实现会把它写
	// 进 unit 文件 / 任务命令行。
	//
	// startNow 控制是否立即 start 服务。
	//   - true: 立即拉起（首次启用、systemd 接管路径上用）
	//   - false: 仅写文件 + enable，下次登入 / 重启后才生效（supervisor 路径上
	//     避免与子进程争抢 socket fd）
	//
	// 幂等：已安装 + 配置一致时是 noop。
	Install(agentBinary string, startNow bool) error

	// Uninstall 卸载系统服务
	//
	// 幂等：未安装时是 noop。
	Uninstall() error

	// Status 查询当前安装/启用状态
	Status() (SystemServiceStatus, error)
}

// systemServiceInstallerImpl 是进程级单例，由 build tag 文件初始化注入
//
// 各平台的 init() 函数会注册对应实现。非目标平台用 unsupportedInstaller
// 兜底，让调用方不必 nil check。
var systemServiceInstallerImpl systemServiceInstaller

// ---------------------------------------------------------------------------
// SshAgentService 暴露给前端的方法
// ---------------------------------------------------------------------------

// GetSystemServiceStatus 返回系统服务当前状态
//
// 前端设置页用此判断「自动启动」开关的当前位置。失败（OS API 错误等）
// 返回 Status{Supported: false} + error 让 UI 显示「无法查询」。
func (s *SshAgentService) GetSystemServiceStatus() (SystemServiceStatus, error) {
	if systemServiceInstallerImpl == nil {
		return SystemServiceStatus{Supported: false}, nil
	}
	return systemServiceInstallerImpl.Status()
}

// InstallSystemService 安装并启用系统服务
//
// 调用时机：
//   - 用户在 GUI 设置页点「安装为系统服务」按钮
//   - 首次启用 SSH agent 服务时（autoInstallSystemServiceOnEnable）
//
// 失败原因：
//   - 平台不支持（macOS） → ErrSystemServiceUnsupported
//   - 没权限写文件（systemd user dir / Task Scheduler） → OS 错误
//   - agent binary 定位失败 → ErrAgentBinaryMissing
func (s *SshAgentService) InstallSystemService() error {
	if systemServiceInstallerImpl == nil || !systemServiceInstallerImpl.Supported() {
		return ErrSystemServiceUnsupported
	}

	binPath, err := locateAgentBinary()
	if err != nil {
		return fmt.Errorf("locate agent binary: %w", err)
	}

	if err := s.installSystemServiceWithBinary(binPath); err != nil {
		return err
	}
	s.logger.Info("system service installed", "platform", systemServiceInstallerImpl.PlatformLabel(), "binary", binPath)
	return nil
}

// installSystemServiceWithBinary installs/enables the current platform service
// using a binary path the caller has already resolved.
func (s *SshAgentService) installSystemServiceWithBinary(binPath string) error {
	if systemServiceInstallerImpl == nil || !systemServiceInstallerImpl.Supported() {
		return ErrSystemServiceUnsupported
	}
	// 手动安装路径（用户从 UI 点「安装」或 Windows 启用时）期望立即生效。
	if err := systemServiceInstallerImpl.Install(binPath, true); err != nil {
		return fmt.Errorf("install system service: %w", err)
	}
	return nil
}

// UninstallSystemService 卸载系统服务
//
// 卸载后 zpass-agent 不会在登录时自启 —— 但已经在跑的进程不会被强制停止
// （让用户能完成 in-flight 签名）。下次启动 GUI 时如果未启用 SSH agent
// 服务，agent 进程会随 GUI 退出而退出。
func (s *SshAgentService) UninstallSystemService() error {
	if systemServiceInstallerImpl == nil || !systemServiceInstallerImpl.Supported() {
		return ErrSystemServiceUnsupported
	}
	if err := systemServiceInstallerImpl.Uninstall(); err != nil {
		return fmt.Errorf("uninstall system service: %w", err)
	}
	s.logger.Info("system service uninstalled")
	return nil
}

// ---------------------------------------------------------------------------
// 首次启用自动安装
// ---------------------------------------------------------------------------

// autoInstallSystemServiceOnEnable 在用户首次 Enable SSH agent 时自动配置系统服务
//
// 策略：
//   - 平台不支持 → 跳过（不报错）
//   - 已安装且启用且健康 → 跳过
//   - 已安装但不健康 → 跳过 install 但 log warn（需要用户手动介入）
//   - 未安装 → 尝试安装 → 装完启动后健康检查；不健康则回滚 uninstall 避免 socket fd 抢占
//
// 这是「让用户首次启用即获得最佳体验」的关键 UX 流程：用户启用 SSH
// agent 后立即获得 systemd socket activation（0 内存空闲）+ 登录自启。
//
// 失败容忍：
//   - 找不到 agent binary：MVP-2 的 supervisor fallback 仍然能拉起 agent
//   - systemctl 不可用（极简发行版）：用户仍可用 GUI 子进程模式
//   - 装后不健康 ：自动回滚，让 supervisor 接手避免 socket fd 抢占导致 ssh 挂住
//
// 调用方：SshAgentService.Enable 在 listener 启动成功后调一次。
func (s *SshAgentService) autoInstallSystemServiceOnEnable() {
	if systemServiceInstallerImpl == nil || !systemServiceInstallerImpl.Supported() {
		s.logger.Debug("auto-install: skipped (platform not supported)")
		return
	}

	status, err := systemServiceInstallerImpl.Status()
	if err != nil {
		s.logger.Warn("auto-install: status check failed", "err", err)
		return
	}
	if status.Installed && status.Enabled {
		if status.Healthy {
			s.logger.Debug("auto-install: skipped (already installed, enabled and healthy)")
			return
		}
		// 装了但不健康 —— 可能是旧版本留下的坐 unit，或升级后 binary
		// 路径变了。先卸载再走重装路径 —— 这样能覆盖旧 unit 文件。
		s.logger.Warn("auto-install: existing system service is unhealthy; reinstalling",
			"lastError", status.LastError)
		if err := systemServiceInstallerImpl.Uninstall(); err != nil {
			s.logger.Warn("auto-install: pre-reinstall uninstall failed", "err", err)
			return
		}
		// 落到下面重新走 Install + 健康检查。
	}

	binPath, err := locateAgentBinary()
	if err != nil {
		s.logger.Warn("auto-install: agent binary not located", "err", err)
		return
	}

	// 同步读一下当前 supervisor 状态：如果 supervisor 在跑（fallback 路径），
	// 不要 --now 启用 socket，避免与 supervisor 拉起的 zpass-agent 争抢 socket fd。
	// 仅写文件 + enable，下次登入 / GUI 重启后 systemd 接管。
	s.mu.Lock()
	supervisorRunning := s.supervisor != nil && s.supervisor.IsRunning()
	s.mu.Unlock()
	startNow := !supervisorRunning

	if err := systemServiceInstallerImpl.Install(binPath, startNow); err != nil {
		s.logger.Warn("auto-install: failed", "err", err)
		return
	}

	// 装完后重查一次健康状态 —— systemd 可能因为 unit 错误 / sandbox 拒绝让 service
	// 陷入「activating(auto-restart)」循环。这时如果不回滚，socket fd 会被 systemd
	// 抢占却永远启动不了 service，ssh 客户端 connect 后挂住。
	//
	// 仅在 startNow 路径上检查：startNow=false 时 socket unit 还未 active（等下次登入），
	// healthCheck 会误报 “socket unit not active” —— 这个场景下跳过健康检查。
	if startNow {
		postStatus, err := systemServiceInstallerImpl.Status()
		if err != nil {
			s.logger.Warn("auto-install: post-install status check failed", "err", err)
			return
		}
		if !postStatus.Healthy {
			s.logger.Warn("auto-install: service unhealthy after install; rolling back to avoid socket fd contention",
				"lastError", postStatus.LastError)
			if uErr := systemServiceInstallerImpl.Uninstall(); uErr != nil {
				s.logger.Warn("auto-install: rollback uninstall failed", "err", uErr)
			}
			return
		}
	}

	s.logger.Info("auto-installed system service on first enable",
		"platform", systemServiceInstallerImpl.PlatformLabel(),
		"startNow", startNow)
}

// systemServiceHealthyForActivation 返回是否可以依赖 systemd / Scheduled Task 拉起 agent
//
// true 表示：服务已装 + 启用 + 健康。Enable 遇到这个场景应当跳过 supervisor，
// 让系统服务管理器按需拉起 agent。
//
// 平台不支持 / Status 查询失败 → false（保守地交给 supervisor）。
func (s *SshAgentService) systemServiceHealthyForActivation() bool {
	if systemServiceInstallerImpl == nil || !systemServiceInstallerImpl.Supported() {
		return false
	}
	status, err := systemServiceInstallerImpl.Status()
	if err != nil {
		s.logger.Debug("system service health check errored; treating as not healthy", "err", err)
		return false
	}
	return status.Installed && status.Enabled && status.Healthy
}

// maybeUninstallUnhealthySystemService 检测到 systemd / Scheduled Task 已装但不健康时卸载
//
// 场景：systemd socket unit 状态 active 住了 socket fd，但 service unit 反复
// 启动失败（例：错误 sandbox 配置、binary 路径变了、依赖目录缺失）。这时
// 如果我们不回收 socket，ssh 客户端 connect 会拿到 systemd 那个 fd 却永远等不到
// service 启动，在用户看来是「ssh 挂住」。
//
// 决策：
//   - 未装 / 已装且健康 → no-op（这个 helper 只管「不健康」场景）
//   - 装了且不健康 → 主动 Uninstall，log warn。之后 supervisor 接手。
//
// 错误不向上抛 —— 这是「防御性清理」，uninstall 失败也不应当阔 Enable 。
func (s *SshAgentService) maybeUninstallUnhealthySystemService() {
	if systemServiceInstallerImpl == nil || !systemServiceInstallerImpl.Supported() {
		return
	}
	status, err := systemServiceInstallerImpl.Status()
	if err != nil {
		return
	}
	if !status.Installed {
		return
	}
	if status.Healthy {
		return
	}
	s.logger.Warn("system service installed but unhealthy; uninstalling to free socket fd for supervisor",
		"platform", systemServiceInstallerImpl.PlatformLabel(),
		"lastError", status.LastError)
	if err := systemServiceInstallerImpl.Uninstall(); err != nil {
		s.logger.Warn("unhealthy system service uninstall failed", "err", err)
	}
}
