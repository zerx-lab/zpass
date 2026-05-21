//go:build windows

// SSH agent 子进程平台特定配置 —— Windows
//
// ---------------------------------------------------------------------------
// 设计目标
//
// 让 zpass-agent.exe 能够「脱离」GUI 进程独立存活：
//
//   1. **脱离 console**：HideWindow + CREATE_NO_WINDOW 让 GUI 启动 agent 时不弹
//      cmd 窗口。
//   2. **独立 process group**：CREATE_NEW_PROCESS_GROUP 让 agent 与 GUI 不同组，
//      Windows 上 Ctrl-C / Ctrl-Break / console close 事件不会随同转发。
//   3. **不绑定 Job Object**：不调用 AssignProcessToJobObject，避免 Windows Job
//      Object 的 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 让 GUI 退出时同杀 agent。
//      Wails 默认不为自己创建 Job，但某些调试器（如 VS 可视化调试器）会把
//      被调物放进 Job，子孙进程会被默认继承，BreakawayFromJob 可以逆转。
//   4. **DETACHED_PROCESS**：不给 agent 分配 console，也不让它继承 GUI 的 stdio
//      句柄 —— GUI 退出后其 stdio 被 Windows 回收，子进程如果手持同一句柄会被
//      同步连带。
//
// 这些标志叠加后，GUI 调 cmd.Wait 仍可以拿到 agent 退出代码用于 supervisor
// 重启边判断；但 GUI 进程本身退出时 agent 不被连带杀。
//
// ---------------------------------------------------------------------------
// 优雅退出
//
// Windows 没有 SIGTERM 这种「请优雅退出」信号机制。最干净的优雅退出方式：
//   1. 我们独立的 zpass-agent 在 windows 上监听 console ctrl event
//      （由 signal.Notify 的实现透明转发为 SIGINT）
//   2. 通过 GenerateConsoleCtrlEvent 给子进程发 CTRL_BREAK_EVENT
//
// 但这要求子进程是 console 子进程且在同 console group。我们脱离了 console
// + 另起 process group 后该机制不适用；且 Wails 应用主进程本身也没有 console。
//
// 简化方案：agent 进程不跑「清理 unix socket」之类的事（Windows 用 named pipe，
// 进程退出自动销毁），所以在“SshAgentService.Disable”路径上直接 TerminateProcess
// （cmd.Process.Kill 内部就是这个）无副作用。GUI 仅退出不禁用服务时 ——
// signalGracefulShutdown 不被调用，agent 保留。

package services

import (
	"os/exec"

	"golang.org/x/sys/windows"
)

// agentChildCreationFlags 拼出接入点上 Windows Job/Console 隔离的完整标志
//
// 含义：
//   - CREATE_NO_WINDOW (0x08000000)：agent 是 console application，本标志告诉
//     Windows 不为它创建 console 窗口 —— 避免在 GUI 启动时闪黑框。
//   - CREATE_NEW_PROCESS_GROUP (0x00000200)：让 agent 另起进程组。Windows 上
//     console ctrl event（Ctrl-C / Ctrl-Break / console-close）默认会广播给同
//     process group 内所有进程；另起组后同个信号不会随 GUI 连带被发送。
//   - DETACHED_PROCESS (0x00000008)：agent 不继承 GUI 的 console。与
//     CREATE_NO_WINDOW 、CREATE_NEW_CONSOLE 三选一；组合 DETACHED_PROCESS +
//     CREATE_NEW_PROCESS_GROUP 是 Windows API 推荐的「后台独立守护进程」正规
//     写法。但注意 DETACHED_PROCESS 会让子进程拿不到 stdio。
//
// 注意：
//   - 不用 CREATE_NEW_CONSOLE：那会给 agent 弹一个独立 cmd 窗口。
//   - 不用 DETACHED_PROCESS：该标志会让 agent 拿不到有效的 stdout/stderr
//     句柄，supervisor 的 drainOutput 会立即 EOF，看不到 agent 日志。CREATE_NO_WINDOW
//     已经保证无可见 console，足够了。CREATE_NEW_PROCESS_GROUP 足以避免信号
//     联动。
const (
	createNoWindow         = 0x08000000
	createNewProcessGroup  = 0x00000200
	agentChildCreationFlag = createNoWindow | createNewProcessGroup
)

// configurePlatformProcAttr 给 cmd 设置 Windows 平台特定的进程属性
//
// HideWindow + CreationFlags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP:
//   - HideWindow + CREATE_NO_WINDOW：双重保险确保 GUI 启动 agent 时不弹
//     console 窗。
//   - CREATE_NEW_PROCESS_GROUP：让 agent 另起进程组 —— Wails GUI 退出时，
//     Windows 发给原 process group 的 ctrl event 不会被 agent 收到，从而让
//     agent 可以独立于 GUI 生命周期存活。详见 agentChildCreationFlag 常量注释。
func configurePlatformProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &windows.SysProcAttr{
		HideWindow:    true,
		CreationFlags: agentChildCreationFlag,
	}
}

// signalGracefulShutdown Windows 上等价于强终止
//
// 见文件头说明 —— Windows 上「优雅退出 console 进程」需要 console group，
// 我们的场景下不可行；直接 Kill 即可（agent 用 named pipe，无残留）。
//
// 调用时机：仅在 SshAgentService.Disable（用户明确「禁用服务」）走到这里。
// GUI 进程退出走 Shutdown（仅停 listener）不会调 signalGracefulShutdown，
// 该函数名不紧要是「优雅」。
func (s *agentSupervisor) signalGracefulShutdown(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if err := cmd.Process.Kill(); err != nil {
		s.logger.Warn("kill agent failed", "err", err)
	}
}
