//go:build !windows

package services

// 非 Windows 平台的 trusted device stub
// ---------------------------------------------------------------------------
// 当前仅 Windows 实现了「信任设备」自动解锁能力（DPAPI 方案）。macOS
// TODO: 与 Linux 的实现规划如下，但尚未落地：
//   - macOS：Keychain Services + kSecAttrAccessibleAfterFirstUnlock
//     （登录后即可访问，不弹 Touch ID；与 DPAPI 等价）
//   - Linux：libsecret / Secret Service（org.freedesktop.Secret.Item）
//     （取决于发行版自带的 keyring daemon，跨发行版兼容性略差）
//
// 本文件提供编译期占位，让非 Windows 构建不报「trustedDeviceProtector
// 未初始化 / Protector 接口缺实现」之类的链接错误。运行时表现：
//   - Available() 始终返回 false → SettingsPage 把开关置灰，副标题
//     提示「此平台暂不支持」
//   - Protect / Unprotect 始终返回 ErrTrustedDeviceUnsupported →
//     vaultservice 在用户绕过 UI 直接调 EnableTrustedDevice 时也能
//     给出明确错误，不会假装成功
//
// ---------------------------------------------------------------------------
// 为什么不直接让 trustedDeviceProtector 留 nil
//
// 让全局变量保持 nil 后再在调用处加 nil 检查，会让 vaultservice 各方法
// 散落 `if trustedDeviceProtector == nil { return ErrUnsupported }` 模板
// 代码。改成 stub 实现后，调用方只需要检查 Available()，错误路径统一从
// Protect/Unprotect 抛出，心智模型与有真实实现的平台一致。
//
// 同时 stub 显式存在也让单元测试在非 Windows 上能 fake 注入：
//
//	// 测试代码可以直接覆盖
//	trustedDeviceProtector = &fakeProtector{...}
//
// 而不需要分平台 stub。
//
// ---------------------------------------------------------------------------
// 等真正实现 macOS / Linux 时
//
// 把对应平台从本文件的 build tag 排除即可。例如新增 macOS 实现时：
//   1. 新建 trusteddevice_darwin.go，build tag `//go:build darwin`，
//      init() 里赋值 trustedDeviceProtector = &keychainProtector{}
//   2. 把本文件 build tag 改成 `//go:build !windows && !darwin`
//
// Linux 同理。这种约定让"已实现的平台"和"占位的平台"边界清晰，
// 编译期靠 build tag 互斥保证不会同时注入两个实现。

import (
	"fmt"
)

// unsupportedProtector 是 TrustedDeviceProtector 在非 Windows 平台的 stub
//
// 所有方法都返回「不可用」语义。调用方必须先检查 Available() 才调
// Protect/Unprotect —— 但即使没检查直接调，也会拿到统一错误而非 panic。
type unsupportedProtector struct{}

// init 注入 stub 为进程单例
//
// 与 trusteddevice_windows.go 的 init 互斥（build tag 保证），同一构建
// 里 trustedDeviceProtector 只被赋值一次。
func init() {
	trustedDeviceProtector = &unsupportedProtector{}
}

// Available 始终返回 false —— 通知调用方此平台没有实现
//
// 前端拿到 false 后应当：
//   - 把 Settings 的「在此设备上自动解锁」开关置灰 + 不可点击
//   - 副标题展示 i18n key `settings_trusted_device_unsupported`
//     （内容例如「此平台暂不支持，仅限 Windows」）
func (p *unsupportedProtector) Available() bool {
	return false
}

// Method 返回空串 —— stub 平台不会真正写入 vault_trusted_device.method
//
// 即便调用方误调 Protect 拿到错误后又调 Method，返回空串也是无害的 ——
// vaultservice 在写表前会检查 method 非空。
func (p *unsupportedProtector) Method() string {
	return ""
}

// Protect 始终返回 ErrTrustedDeviceUnsupported
//
// 用 fmt.Errorf 包一层是为了 errors.Is 能匹配上层调用约定 —— vaultservice
// 用 errors.Is(err, ErrTrustedDeviceUnsupported) 分流到「翻译成对前端
// 的 unsupported 错误」分支，与 Windows 实现的真实失败错误统一处理。
func (p *unsupportedProtector) Protect(plaintext []byte) ([]byte, error) {
	_ = plaintext // 显式忽略，避免静态分析误报「未使用参数」
	return nil, fmt.Errorf("trusted device protect: %w", ErrTrustedDeviceUnsupported)
}

// Unprotect 始终返回 ErrTrustedDeviceUnsupported
//
// 与 Protect 同样语义。理论上调用 Unprotect 之前必经 ReadTrustedDevice
// 拿到非空行 —— 而非空行只有同平台的 Protect 才能写入 —— 所以正常路径
// 下不会有「Windows 写的 blob 拿到 Linux 来 Unprotect」的跨平台场景。
// 真碰到这种异常（用户手工拷 vault.db 跨平台），返回 unsupported 让上层
// 清行回退主密码模式即可，不需要特殊处理。
func (p *unsupportedProtector) Unprotect(blob []byte) ([]byte, error) {
	_ = blob
	return nil, fmt.Errorf("trusted device unprotect: %w", ErrTrustedDeviceUnsupported)
}
