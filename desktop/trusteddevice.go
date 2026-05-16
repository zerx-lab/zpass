package main

// 「信任设备」自动解锁能力的跨平台抽象
// ---------------------------------------------------------------------------
// 目标：让用户在「此设备」上启用后，重启 ZPass 无需输入主密码即可进入保险库。
//
// 实现思路：把已经派生出来的 DEK 用 OS 提供的「设备绑定密钥」再加密一层
// 落盘到 vault_trusted_device 表。下次启动时调用 OS 解密 API 还原 DEK。
//
// 各平台对应实现：
//   - Windows：DPAPI（CryptProtectData / CryptUnprotectData）+ entropy
//     实现见 trusteddevice_windows.go（//go:build windows）
//   - macOS：Keychain Services（kSecAttrAccessibleAfterFirstUnlock）
//     当前未实现，由 trusteddevice_unsupported.go 占位
//   - Linux：libsecret（org.freedesktop.Secret.Item）
//     当前未实现，由 trusteddevice_unsupported.go 占位
//
// ---------------------------------------------------------------------------
// 安全模型（针对 Windows DPAPI 实现，其它平台等价对照）：
//
//   ✓ 攻击者拷走 vault.db 到另一台机器 / 另一个 Windows 用户 → 无法解密
//     （DPAPI 的派生密钥绑定到 SID + 机器，离开会话即失效）
//   ✓ 攻击者偷走整台机器但不知 Windows 登录密码 → 无法解密
//     （进不去用户态就拿不到 DPAPI master key）
//   ✓ 同 Windows 用户下其它进程读 vault.db → 无法解密
//     （我们传 entropy "zpass:trusted-device:v1"，没这个常量解不开）
//
//   ✗ 攻击者已经登入到当前 Windows 用户会话 → 能解密
//     （但需要先拿到 entropy 常量；如果攻击者能调试 ZPass 进程也能直接
//      读 s.dek 内存，所以这条不是新引入的攻击面）
//   ✗ root / SYSTEM 权限攻击者 → 能解密
//     （此时 OS 信任边界已破，密码管理器无法防御）
//
// 与 Bitwarden「永不超时」对比：
//   Bitwarden 该选项**明文落盘 DEK**（自家文档警示「stores your encryption
//   key unencrypted on your device」）；本方案多一层 DPAPI 加密，离线攻击
//   场景严格更优。详见 mem://bitwarden-zpass-dpapi 调研记录。
//
// ---------------------------------------------------------------------------
// 设计约束
//
//   1. 接口必须能在「不可用」平台编译通过 —— 通过 build tag 切出
//      trusteddevice_unsupported.go 提供 fallback 实现，让 macOS/Linux
//      构建不报缺失符号。
//
//   2. 失败语义统一：Protect/Unprotect 失败时返回 error，调用方
//      （vaultservice）负责把「Unprotect 失败」识别为「OS 凭据已变化」
//      并清空 vault_trusted_device 行，静默回退到主密码模式 —— 不让
//      用户卡在错误页。
//
//   3. 不接触 DEK 之外的字节 —— 实现只做加密/解密，不感知 DEK 含义、
//      不日志原文、不缓存中间态。defer WipeBytes 由调用方负责。
//
//   4. 进程级单例 —— 各平台实现不持有跨调用状态（DPAPI 是无状态调用，
//      Keychain/libsecret 句柄按需创建），用单例对象简化注入。
//
// ---------------------------------------------------------------------------
// 调用约定（vaultservice 视角）：
//
//   启用流程（用户在 Settings 勾选）：
//     1. 用户输入主密码确认身份（防劫持会话恶意启用）
//     2. vaultservice.EnableTrustedDevice 验证主密码 → 调
//        trustedDeviceProtector.Protect(s.dek) 取得 blob
//     3. db.WriteTrustedDevice({ method, blob, createdAt })
//
//   启动自动解锁（LockSync 触发）：
//     1. db.ReadTrustedDevice() 读到 row（没行就是未启用，正常返回 false）
//     2. trustedDeviceProtector.Unprotect(row.Blob, row.Method) → DEK
//     3. 失败 → db.DeleteTrustedDevice() 清掉过期行 → 返回 false 让
//        前端走主密码流程；成功 → s.dek = DEK
//
//   关闭流程（用户在 Settings 取消勾选）：
//     1. db.DeleteTrustedDevice() —— 不需要主密码确认，关闭只是降低
//        安全等级，没有提权风险

import (
	"errors"
)

// TrustedDeviceMethodDPAPI 是 Windows DPAPI 实现写入 vault_trusted_device.method
// 的标识值。Unprotect 时据此分流到对应平台的解密实现，跨平台 / 跨方案识别
// 也靠这个字段（未来若引入 TPM 直签等新方案，新增常量即可）。
const (
	TrustedDeviceMethodDPAPI     = "dpapi"
	TrustedDeviceMethodKeychain  = "keychain"
	TrustedDeviceMethodLibsecret = "libsecret"
)

// ErrTrustedDeviceUnsupported 表示当前平台 / 当前构建未实现 trusted device
// 自动解锁能力。vaultservice 应把它翻译成对前端友好的提示，UI 层根据这个
// 错误把 Settings 开关置灰 + 显示「此平台暂不支持」副标题。
var ErrTrustedDeviceUnsupported = errors.New("trusted device unlock not supported on this platform")

// ErrTrustedDeviceUnprotect 表示用 OS API 解封 blob 时失败。最常见原因：
//   - 用户换了 Windows 账户登录 / 重置了 Windows 密码
//   - 数据被复制到了另一台机器（DPAPI 绑定到当前 SID + 机器，跨设备即失效）
//   - macOS Keychain 数据库迁移 / 用户重置了 login keychain
//   - Linux keyring 被清空或换了发行版
//
// vaultservice 收到此错误时应静默清空 vault_trusted_device 行，让用户走
// 普通主密码解锁路径 —— 不需要给用户解释 DPAPI/Keychain 是什么。
var ErrTrustedDeviceUnprotect = errors.New("trusted device blob cannot be unprotected (OS credentials changed?)")

// TrustedDeviceProtector 把任意秘密字节用 OS 设备绑定密钥包一层
//
// 实现必须满足：
//   - Protect 返回的 blob 只有同一台机器 / 同一个 OS 用户 / 同一个 entropy
//     才能 Unprotect 还原原始字节
//   - Available() 反映"当前进程能否真的调用 OS API"，不是"操作系统理论
//     上是否支持" —— 比如 Linux 上 secret-service daemon 没起来时返回 false
//   - 实现内部不持久化任何状态 —— 所有持久化责任在调用方（写到 SQLite）
type TrustedDeviceProtector interface {
	// Available 当前平台 + 当前进程能否使用 trusted device 自动解锁
	//
	// 返回 false 时调用方应当把 Settings 开关置灰，不应再调 Protect/Unprotect。
	// 永远不会 panic —— 内部探测失败也只是返回 false。
	Available() bool

	// Method 返回该实现写入 vault_trusted_device.method 的标识
	//
	// 取值是 TrustedDeviceMethod* 常量之一。Unprotect 时调用方据此分流，
	// 也是日志 / UI 上展示「此设备使用 X 保护」的数据来源。
	Method() string

	// Protect 用 OS 设备绑定密钥加密 plaintext，返回不透明 blob
	//
	// plaintext 不会被实现修改 / 持久化，调用方负责调用前后的 WipeBytes。
	// 失败原因（可能）：
	//   - OS API 不可用（已通过 Available 排除大多数情况）
	//   - 输入字节过大（DPAPI 上限 ~32KB；DEK 32 字节远低于阈值）
	//   - Windows 当前用户 profile 损坏（极罕见）
	Protect(plaintext []byte) ([]byte, error)

	// Unprotect 解密 blob 还原原始 plaintext
	//
	// 任何失败都包装为 ErrTrustedDeviceUnprotect（详见该错误的 doc 注释）。
	// 调用方据此判断「需要清掉行 + 回退主密码模式」，不需要区分具体原因。
	Unprotect(blob []byte) ([]byte, error)
}

// trustedDeviceProtector 是进程级单例，由各平台的 build tag 文件初始化：
//   - trusteddevice_windows.go    → DPAPI 实现
//   - trusteddevice_unsupported.go → 不可用 stub（其它平台）
//
// vaultservice 通过此变量访问能力，不直接依赖具体平台实现，便于：
//  1. 单元测试时注入 fake 实现
//  2. 未来加 TPM 直签等新方案时只在初始化处分流
//
// 不导出（小写）—— 仅 main 包内部使用；前端通过 VaultService 的方法间接访问。
var trustedDeviceProtector TrustedDeviceProtector
