// SSH agent 「是否已存活」探测
//
// ---------------------------------------------------------------------------
// 为什么需要这个探测
//
// ZPass 需要能够「跨 GUI 重启」体验：GUI 关闭后 zpass-agent 守护进程
// 仍在后台存活，下次 GUI 启动时必须是「重用」而不是「重启」。否则会发生：
//
//   1. 新 supervisor 试图拉起新 zpass-agent.exe
//   2. 新 agent 试图 winio.ListenPipe(\\.\pipe\zpass-ssh-agent-...)
//   3. 同名 pipe instance 被旧 agent 占着 → Access is denied / pipe busy
//   4. 新 agent 崩溃 → supervisor 重启 → 反复损耗
//
// 检测「已存活」后，GUI 跳过 supervisor.Start()，让旧 agent 的 controlClient
// 重连机制（见 cmd/zpass-agent/control.go reconnectBackoffSeconds）自动重新
// 接上新 GUI 的 control listener。
//
// ---------------------------------------------------------------------------
// 检测原理
//
// **以 SSH agent socket / named pipe 的可连接性作为信号**，而不是进程名。
// 原因：
//   - 进程名检测在 Windows 上需要 EnumProcesses，在 Linux/macOS 上需要 /proc
//     或 ps，跨平台不一致且可能被防毒软件绊住。
//   - socket / pipe 可连接性是「服务实际是否能接收请求」的天然表达：能
//     connect 上说明有活的 listener 在；connect 失败说明没。
//   - 子进程生命周期为「隶属于 GUI」时，检测还能顺便发现「服务被外部杀
//     了」这种场景（不在乎是否有同名进程，只在乎能不能提供服务）。
//
// **不做「握手验证」**：仅连上 + 立即断。握手需要 capability token，是
// 另一个验证阶段的事。本函数仅需「能 connect = 有人在听」这个信号。
//
// ---------------------------------------------------------------------------
// 超时选项
//
// 超时设 500ms：足以让本机 IPC 完成，不够让用户感知到 GUI 启动变慢。
// dial 未超时返回错误→装作「agent 不在」处理。

package services

import (
	"context"
	"net"
	"runtime"
	"time"

	"github.com/zerx-lab/zpass/internal/sshagentproto"
)

// agentAliveProbeTimeout 探测「agent 是否在跑」的最大等待时间
//
// 500ms 保证：
//   - 本机 IPC 能在这个时间内完成 connect（实测几十 us）
//   - 同名项主用户跳转账户、重启过等造成 stale pipe 场景下，不会让
//     GUI 启动严重卡顿
//   - 远远小于用户可感知的「拖拉」阈值
const agentAliveProbeTimeout = 500 * time.Millisecond

// isAgentAlreadyRunning 检测是否已有 zpass-agent 进程在为本用户服务
//
// 返回：
//   - true：agent socket / pipe 可连，意味着有 agent 仍在提供服务。
//     调用方应跳过 supervisor.Start()，让旧 agent 的 controlClient 重连机制
//     接管。
//   - false：agent socket / pipe 不能连 → 没活 agent，需要 supervisor 拉起。
//
// 跳过场景：socketPath 解析失败（不支持的 OS）→ 保守地返 false 让调用方
// 走 supervisor 路径（反正 supervisor 自己会报 not supported）。
// IsAgentAlreadyRunning is the exported version for callers outside this
// package (e.g. the main command's startup re-adoption logic).
func IsAgentAlreadyRunning() bool { return isAgentAlreadyRunning() }

func isAgentAlreadyRunning() bool {
	socketPath, err := sshagentproto.AgentSocketPath()
	if err != nil {
		return false
	}

	ctx, cancel := context.WithTimeout(context.Background(), agentAliveProbeTimeout)
	defer cancel()

	conn, err := dialAgentSocket(ctx, socketPath)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// dialAgentSocket 跨平台 dial agent socket / pipe
//
// Linux/macOS 走 unix socket；Windows 走 named pipe。
// 使用 net.Dial 而非 net.DialTimeout 以便后续接 ctx。
func dialAgentSocket(ctx context.Context, socketPath string) (net.Conn, error) {
	if runtime.GOOS == "windows" {
		return dialAgentSocketWindows(ctx, socketPath)
	}
	d := net.Dialer{Timeout: agentAliveProbeTimeout}
	return d.DialContext(ctx, "unix", socketPath)
}
