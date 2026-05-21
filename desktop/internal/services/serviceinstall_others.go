//go:build !linux && !windows

// 非 Linux / Windows 平台的系统服务安装 stub
//
// ---------------------------------------------------------------------------
// 当前支持 Linux (systemd user unit) 和 Windows (Scheduled Task)。
// macOS 计划用 launchd LaunchAgent，但「不实现」由用户当前要求决定。
//
// 此 stub 让 Darwin 等平台编译通过 + 运行时 Supported=false 让 UI 自然
// 隐藏「安装」按钮。

package services

// unsupportedInstaller 在 macOS / 其它平台占位
//
// 所有方法返回「不支持」语义。Supported=false 让 SshAgentService 的
// Install/Uninstall 方法返回 ErrSystemServiceUnsupported。
type unsupportedInstaller struct{}

// init 注入 stub
func init() {
	systemServiceInstallerImpl = &unsupportedInstaller{}
}

// Supported 始终 false
func (i *unsupportedInstaller) Supported() bool {
	return false
}

// PlatformLabel 给 UI 展示「不支持」
func (i *unsupportedInstaller) PlatformLabel() string {
	return "not supported on this platform"
}

// Install 返回不支持错误
func (i *unsupportedInstaller) Install(_ string) error {
	return ErrSystemServiceUnsupported
}

// Uninstall 返回不支持错误
func (i *unsupportedInstaller) Uninstall() error {
	return ErrSystemServiceUnsupported
}

// Status 返回 Supported=false 的状态
func (i *unsupportedInstaller) Status() (SystemServiceStatus, error) {
	return SystemServiceStatus{
		Supported:     false,
		PlatformLabel: i.PlatformLabel(),
	}, nil
}
