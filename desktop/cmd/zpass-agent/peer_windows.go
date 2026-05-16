//go:build windows

// Peer 解析 —— Windows 实现（GetNamedPipeClientProcessId）
//
// ---------------------------------------------------------------------------
// Windows named pipe 上拿对端 PID 的标准方式：
//   - GetNamedPipeClientProcessId(handle) → DWORD pid
//
// 然后用 OpenProcess + QueryFullProcessImageNameW 拿 binary 路径。
//
// winio 库已经把 named pipe conn 暴露了底层 handle —— 但接口不太直接，
// 用类型断言到 winio 的内部类型不可行。所以我们用更通用的：
//   1. conn 必须实现 winio 的接口暴露 handle，或者
//   2. 我们绕开 winio 自己拿 handle —— 不可能，listener 是 winio 创建的
//
// 实际上 winio 0.6.x 的 PipeConn 不导出 handle 字段。绕路方案：
// 用 conn.LocalAddr() 拿 pipe 名 → CreateNamedPipeClientW 模式重连？
// 不可行，会创建新 conn。
//
// 最可行：用 winio 不能直接拿 handle 时，**退化到只暴露 PID 信息**
// —— ssh client 端通过 GetCurrentProcessId 不会暴露，但我们能从内核
// 接口拿。这条 MVP 阶段直接放弃 peer 识别：返回零值 peerInfo，UX 上
// 让 GUI 弹窗显示「未知 Windows 进程」。
//
// **TODO**：v1 阶段升级，可考虑：
//   1. 升级 winio 到能直接拿 handle 的版本（>= 0.7? 需要确认）
//   2. 用 syscall.Open + named pipe 路径建立独立 query handle
//   3. fork winio 加 PipeConn.Handle() 方法（最稳但维护代价高）

package main

import (
	"net"
)

// resolvePeerFromConn 在 Windows 上当前返回零值
//
// 见文件头部注释 —— MVP 阶段不支持 Windows 上的对端进程识别。
// GUI 端会显示「未知进程请求签名」让用户决定是否批准。
//
// 即便不带进程信息，签名安全性也不受影响 —— 用户仍需手动批准每次签名，
// 攻击者无法静默触发签名。
func resolvePeerFromConn(conn net.Conn) (peerInfo, error) {
	_ = conn // suppress unused warning
	return peerInfo{}, nil
}
