//go:build windows

// Windows 平台 SID 解析 —— 用于 named pipe 名后缀
//
// ---------------------------------------------------------------------------
// 为什么用 os/user 而非 syscall 直调
//
// os/user.Current() 在 Windows 上内部走 LookupAccountSidW，Go 标准库已经
// 处理了 SID 字符串化（"S-1-5-21-..."）以及内存释放等细节。直接调用比
// 自己用 golang.org/x/sys/windows 的 GetTokenInformation + ConvertSidToStringSid
// 简洁得多，性能差异可忽略（每次 named pipe 路径解析只调一次）。
//
// 唯一的代价是 os/user 在 Windows 上有 cgo 依赖（默认是 cgo build）——
// 但 Wails 3 项目已经依赖 cgo（webview2 / SQLite 等），增加一次符号无负担。
//
// ---------------------------------------------------------------------------
// SID 字符串形如：
//
//	S-1-5-21-1234567890-987654321-1122334455-1001
//
// 其中前缀 "S-1-5-21" 是 Windows 用户域 SID 标识，后面是机器唯一 ID +
// 该机器上用户的 RID。这串字符串包含 ASCII 数字、连字符、字符 S 与 1，
// 对 named pipe 名是安全的（pipe 名允许字符集包含所有非 \ 字符）。

package sshagentproto

import (
	"fmt"
	"os/user"
)

// windowsCurrentSID 返回当前进程用户的 SID 字符串
//
// 失败原因：
//   - 进程在沙箱里没法读 token（极少见，正常 Wails 应用不会）
//   - LSA 服务异常（系统级故障）
//
// 调用方应当把失败当作软错误，回落到 fallback pipe 名（详见
// windowsAgentPipePath 的 fallback 分支）。
func windowsCurrentSID() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("sshagentproto: get current user: %w", err)
	}
	if u.Uid == "" {
		return "", fmt.Errorf("sshagentproto: current user has empty SID")
	}
	return u.Uid, nil
}
