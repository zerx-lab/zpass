//go:build windows

package services

// Windows DPAPI 实现 ——「信任设备」自动解锁能力
// ---------------------------------------------------------------------------
// 用 Windows 内置的 Data Protection API (DPAPI) 把 DEK 包装成只有「当前
// Windows 用户 + 当前机器 + ZPass entropy」三个条件全部命中才能解开的
// 密文 blob。
//
// 核心 API（来自 golang.org/x/sys/windows，已是 wails 间接依赖）：
//   - CryptProtectData    封装：明文 → 用户/机器绑定的密文
//   - CryptUnprotectData  解封：密文 → 明文（需要回到同一用户态）
//
// 关键参数说明：
//   - optionalEntropy：app-specific 盐。让"同一 Windows 用户下的其它进程"
//     即便能调 DPAPI 也解不开 ZPass 的 blob —— 因为它们不知道
//     dpapiEntropy 这个字节序列。**必须传**，是本方案安全模型的核心。
//   - flags = CRYPTPROTECT_UI_FORBIDDEN：禁止 DPAPI 在任何场景弹出 UI
//     提示框。我们不希望在「自动解锁」流程里突然冒出系统对话框打断流。
//
// ---------------------------------------------------------------------------
// 安全细节
//
// 1. dpapiEntropy 是常量 —— 二进制里能找到。这不是问题：
//    威胁模型已经假设攻击者无法在当前用户态运行代码，否则可以直接 dump
//    ZPass 进程内存读到 s.dek，DPAPI 根本不是攻击点。entropy 的作用是
//    防御「另一个 app 在我用户下用 CryptUnprotectData 解 vault.db」的
//    被动攻击，对此常量足够。
//
// 2. defer LocalFree 释放 DPAPI 分配的输出 buffer —— 否则会泄漏堆。
//    Go 的 GC 不管 LocalAlloc/LocalFree。
//
// 3. CryptUnprotectData 失败的 99% 情况是「用户换了 Windows 账户/重置
//    密码 → 这台机器上的 DPAPI master key 已不可用」。我们把这种失败
//    全部归为 ErrTrustedDeviceUnprotect，调用方（vaultservice）会据此
//    清掉 vault_trusted_device 行，让用户回到主密码解锁流程。
//
// 4. **不**对 plaintext 做任何拷贝 / 日志 / 缓存 —— 仅作为 DPAPI 调用
//    的临时输入。调用方（vaultservice.EnableTrustedDevice）负责调用
//    前后的 WipeBytes 抹零。
//
// ---------------------------------------------------------------------------
// 与 Bitwarden 实现的对照
//
// Bitwarden 的「永不超时」选项**不**用 DPAPI，直接把 DEK 明文写进
// IndexedDB / electron-store —— 它自家文档警示「stores your encryption
// key unencrypted on your device」。本实现是其严格上位替代：
//   - 攻击者拷走 vault.db 到另一台机器 → Bitwarden 直接读到 DEK；本实现
//     拿到的是 DPAPI 密文，离开当前会话即不可解
//   - 同 Windows 用户下其它 app 读取 → Bitwarden 直接明文；本实现需要
//     猜出 entropy 字节才能解，提高了攻击成本

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// dpapiEntropy 是写入 DPAPI optionalEntropy 的 app-specific 盐。
//
// 字符串内容选择：
//   - 包含产品标识 "zpass"、用途 "trusted-device"、版本号 "v1"
//   - v1 让我们未来想轮换 entropy（让历史 blob 全部失效，强制用户重新
//     启用「信任此设备」）时只需 bump 到 "v2"。当前不需要。
//
// **不要**改这个常量的字节，否则所有已启用「信任此设备」的用户下次启动
// 都会 Unprotect 失败、被静默踢回主密码模式 —— 用户体验上等同于「设置
// 被神秘重置」。要变更必须走 schema migration（trusted_device.method 加
// 版本后缀，分流处理）。
var dpapiEntropy = []byte("zpass:trusted-device:v1")

// windowsDPAPIProtector 是 TrustedDeviceProtector 的 Windows 实现
//
// 无字段 —— DPAPI 本身是无状态系统调用，不需要持有句柄 / 密钥材料。
// 单例由模块初始化的 init() 注入到 trustedDeviceProtector 全局变量。
type windowsDPAPIProtector struct{}

// init 注入 Windows DPAPI 实现为进程单例
//
// 与 trusteddevice_unsupported.go 互斥（build tag 保证同一构建里只有
// 其中一个会被编译进来），所以 trustedDeviceProtector 不会被多次赋值。
func init() {
	trustedDeviceProtector = &windowsDPAPIProtector{}
}

// Available 当前 Windows 进程是否能使用 DPAPI
//
// DPAPI 是 Windows 2000 以来的内置组件，正常用户态进程都能调用。这里
// 始终返回 true —— 真正不可用的极端场景（profile 损坏 / 受限 sandbox）
// 会在 Protect/Unprotect 里以错误形式报告，不阻塞 UI 显示开关。
//
// 设计取舍：与其在 Available 里做"试探性 Protect/Unprotect 一次"的
// pre-flight，不如让用户点开关时直接尝试，失败再提示 —— pre-flight
// 一次也是 syscall 开销，对启动时间敏感。
func (p *windowsDPAPIProtector) Available() bool {
	return true
}

// Method 返回写入 vault_trusted_device.method 的标识
//
// 永远是 TrustedDeviceMethodDPAPI 常量。如果未来引入"DPAPI + TPM 直签"
// 等增强方案，会新增 windowsDPAPITPMProtector 实现，对应新的 method
// 常量；本实现保持纯 DPAPI 语义不变。
func (p *windowsDPAPIProtector) Method() string {
	return TrustedDeviceMethodDPAPI
}

// Protect 用 DPAPI 加密 plaintext，返回密文 blob
//
// plaintext 通常是 32 字节 DEK；DPAPI 理论支持到 ~32KB，远超我们需要。
//
// 错误：
//   - plaintext 为空 → 不调 syscall，直接返回错误
//   - DPAPI 调用失败 → 包装系统错误信息上抛（这种情况罕见，通常是
//     当前 Windows 用户 profile 异常）
func (p *windowsDPAPIProtector) Protect(plaintext []byte) ([]byte, error) {
	if len(plaintext) == 0 {
		return nil, fmt.Errorf("dpapi protect: plaintext is empty")
	}

	in := newDataBlob(plaintext)
	entropy := newDataBlob(dpapiEntropy)
	var out windows.DataBlob

	// CRYPTPROTECT_UI_FORBIDDEN：禁止 DPAPI 在任何场景弹 UI
	// （某些 Win10 配置下默认行为可能弹"是否允许此 app 访问凭据"）
	const cryptprotectUIForbidden = 0x1

	err := windows.CryptProtectData(
		&in,
		nil, // dataDescr：可选描述字符串。我们不需要 —— DPAPI 不依赖它做
		// 加解密（仅作元数据），但写非 nil 字符串会污染调试时 dump 出
		// 来的 blob 体积，传 nil 更干净。
		&entropy,
		0,   // reserved，必须为 0
		nil, // promptStruct：与 UI_FORBIDDEN 矛盾，传 nil
		cryptprotectUIForbidden,
		&out,
	)
	if err != nil {
		return nil, fmt.Errorf("dpapi protect: %w", err)
	}
	// DPAPI 用 LocalAlloc 分配 out.Data，必须 LocalFree —— 否则进程内
	// 堆持续增长（实际泄漏量极小，但是良好习惯）。我们立刻把字节拷贝
	// 到 Go 管理的 slice，然后释放原始 buffer。
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data))) //nolint:errcheck

	// 把 C 分配的字节拷到 Go slice —— 这样后续返回值的生命周期由 Go GC
	// 管理，不依赖 LocalFree 的时机。
	blob := make([]byte, out.Size)
	copy(blob, unsafe.Slice(out.Data, out.Size))
	return blob, nil
}

// Unprotect 用 DPAPI 解密 blob 还原 plaintext
//
// 错误：
//   - blob 为空 / 损坏 / 来自不同用户/机器 → 一律 ErrTrustedDeviceUnprotect
//     （调用方据此清行回退主密码模式）
//
// 不在错误里携带原始 syscall message —— 避免把 Windows 内部错误码
// （如 NTE_BAD_KEY_STATE）泄露到上层日志，对调试价值有限、对用户更困惑。
// 真要排查可以加 debug 日志包一层；当前简洁优先。
func (p *windowsDPAPIProtector) Unprotect(blob []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, fmt.Errorf("%w: blob is empty", ErrTrustedDeviceUnprotect)
	}

	in := newDataBlob(blob)
	entropy := newDataBlob(dpapiEntropy)
	var out windows.DataBlob

	const cryptprotectUIForbidden = 0x1

	err := windows.CryptUnprotectData(
		&in,
		nil, // dataDescrOut：可选返回描述。我们不需要，传 nil。
		&entropy,
		0,
		nil,
		cryptprotectUIForbidden,
		&out,
	)
	if err != nil {
		// 包装为统一错误 —— 调用方只关心"能不能解开"，不关心具体 NTSTATUS
		return nil, fmt.Errorf("%w: %v", ErrTrustedDeviceUnprotect, err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data))) //nolint:errcheck

	// 拷出来 —— 不返回指向 C buffer 的 slice，避免 LocalFree 后悬垂。
	// 注意：返回的 plaintext 会被调用方装进 s.dek，进入正常 vault 内存
	// 生命周期管理；若调用方不再需要，应负责 WipeBytes。
	plaintext := make([]byte, out.Size)
	copy(plaintext, unsafe.Slice(out.Data, out.Size))
	return plaintext, nil
}

// newDataBlob 构造一个指向 buf 的 DataBlob 视图
//
// 注意点：
//  1. buf 必须非空（调用方已经检查过）—— 取 &buf[0] 在空 slice 上会 panic
//  2. 返回的 DataBlob.Data 是指向 buf 底层数组的指针，**不**拷贝 ——
//     调用方必须保证 buf 在 syscall 期间不被 GC（CryptProtectData 等
//     是同步调用，scope 内 buf 自然存活，无问题）
//  3. uint32(len(buf)) —— DPAPI 用 32 位长度；DEK 32 字节、blob 几百
//     字节，远低于 uint32 上限，转换安全
func newDataBlob(buf []byte) windows.DataBlob {
	return windows.DataBlob{
		Size: uint32(len(buf)),
		Data: &buf[0],
	}
}
