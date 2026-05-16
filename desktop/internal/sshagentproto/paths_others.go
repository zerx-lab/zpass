//go:build !windows

// 非 Windows 平台的 SID stub
//
// ---------------------------------------------------------------------------
// 为什么需要这个文件
//
// paths.go 的 windowsAgentPipePath / ControlSocketPath 都会调用
// windowsCurrentSID()，即便它们在 Linux/macOS 编译目标下永远不会被
// AgentSocketPath 的 switch 路径走到 —— Go 编译器仍然要求符号存在，
// 否则连接失败。
//
// 此 stub 让非 Windows 构建能编译通过。运行时永远不会被调用（switch
// case 已经分流到 linuxAgentSocketPath / darwinAgentSocketPath），返回
// error 是「死代码合规姿态」。

package sshagentproto

import "errors"

// windowsCurrentSID 在非 Windows 平台是一个永远返回错误的 stub
//
// 调用方设计上不会让此函数在非 Windows 系统上被实际执行，但 Go 静态
// 链接要求所有引用的符号都有定义。
func windowsCurrentSID() (string, error) {
	return "", errors.New("sshagentproto: SID lookup not available on non-windows platforms")
}
