// SSH agent 服务 —— 守护进程子进程管理
//
// ---------------------------------------------------------------------------
// 目标
//
// 让 GUI 在「启用 SSH agent 服务」时自动拉起 zpass-agent 守护进程子进程，
// 用户关 GUI 时也能 graceful shutdown 这个子进程。
//
// 这是 MVP-2 阶段的简化方案：把 zpass-agent 作为 GUI 的子进程 fork 出去。
// 优点：
//   - 用户体验「即开即用」，不必手动跑 zpass-agent binary
//   - GUI 退出时通过 cmd.Process.Kill / SIGTERM 干净退出 agent
//   - 跨平台一致（os/exec 在 Linux/macOS/Windows 都工作）
//
// 缺点：
//   - 关 GUI 即关 agent → 退化为「单进程效果」，user 关 GUI 后 ssh
//     失败。但这只是「自启 agent」一种模式；v3 阶段加 systemd
//     activation / launchd 后，用户可以选择「让 OS 管理 agent」让
//     agent 独立于 GUI 存活。
//
// 因此本文件提供两种用法：
//   1. **child mode**：GUI 启动时 fork zpass-agent 子进程（MVP-2 默认）
//   2. **detached mode**：仅检测 agent 是否在跑（不主动拉起），让 user
//      通过 systemd / launchd 启动（v3+ 默认，本阶段不实现接口）
//
// ---------------------------------------------------------------------------
// agent binary 定位策略
//
// 寻找 zpass-agent 可执行文件的优先级：
//
//   1. 环境变量 ZPASS_AGENT_BIN：如果用户设了，绝对信任
//   2. GUI binary 同目录下的 zpass-agent / zpass-agent.exe
//   3. $PATH 中查找
//
// 没找到 → 返回 ErrAgentBinaryMissing，GUI 显示「请检查 agent 安装」。
//
// ---------------------------------------------------------------------------
// 重启策略
//
// agent 子进程意外退出（非 GUI 触发的）→ 自动重启，10 秒指数退避。
// GUI 主动 Stop → 标记 stopRequested=true，watchProcess 不再重启。

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

// ErrAgentBinaryMissing 找不到 zpass-agent 可执行文件
//
// 通常发生在：
//   - 开发环境：忘了 `go build ./cmd/zpass-agent/` 把 binary 编出来
//   - 生产环境：安装包破损 / 杀软误删 agent binary
//
// 这条错误应当让 UI 显示明确的引导（「请重新安装 ZPass」）。
var ErrAgentBinaryMissing = errors.New("zpass-agent binary not found")

// ---------------------------------------------------------------------------
// 重启退避
// ---------------------------------------------------------------------------

// agentRestartBackoffSeconds agent 子进程意外退出时的重启退避
//
// 与 cmd/zpass-agent/control.go 的 reconnectBackoffSeconds 不同 ——
// 那个是 IPC 重连，这个是进程重启。进程重启代价更高（fork + 启动开销），
// 退避得更保守。
var agentRestartBackoffSeconds = []int{1, 2, 5, 10, 30}

// ---------------------------------------------------------------------------
// agentSupervisor —— 管理 zpass-agent 子进程的生命周期
// ---------------------------------------------------------------------------

// agentSupervisor 是 SshAgentService 的辅助组件
//
// 职责：
//   - 拉起 zpass-agent 子进程
//   - 监控进程退出，自动重启
//   - 提供 Stop() 接口让外部触发干净退出
//
// 不在本组件做：
//   - 控制通道连接（agent 进程内部自己处理；GUI 端通过 controlListener
//     等 agent connect 进来）
//   - agent binary 升级 / 验证签名（v4+ 的事）
type agentSupervisor struct {
	binaryPath string
	logger     *slog.Logger

	mu             sync.Mutex
	cmd            *exec.Cmd
	stopRequested  bool
	cancel         context.CancelFunc
	running        bool
	lastStartedAt  time.Time
	lastExitReason string
}

// newAgentSupervisor 构造 supervisor
//
// binaryPath 由调用方解析（locateAgentBinary）。允许传入空字符串：那时
// Start 会立即返回错误 —— supervisor 本身不主动定位 binary，让定位
// 错误尽早暴露给 UI。
func newAgentSupervisor(binaryPath string, logger *slog.Logger) *agentSupervisor {
	return &agentSupervisor{
		binaryPath: binaryPath,
		logger:     logger.With("subsystem", "agentSupervisor"),
	}
}

// Start 启动 agent 子进程 + 监控 goroutine
//
// 幂等：已经在跑时返回 nil。重复调用安全。
//
// 失败：
//   - binaryPath 为空 → ErrAgentBinaryMissing
//   - exec.Cmd.Start 失败 → 包装后返回（权限 / 路径 / 系统调用错误）
//
// 启动后 agent 进程独立运行；GUI 与 agent 通过控制通道（unix socket /
// named pipe）通信，不依赖 stdin/stdout。
func (s *agentSupervisor) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.binaryPath == "" {
		return ErrAgentBinaryMissing
	}
	if s.running {
		return nil // 幂等
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.stopRequested = false

	// 在 goroutine 里跑 startOnce + 重启循环
	go s.supervise(ctx)
	s.running = true

	return nil
}

// Stop 停止重启监控 + 杀掉 agent 子进程
//
// 仅在「用户明确禁用 SSH agent 服务」路径调用（SshAgentService.Disable）：
// 那是「用户明确不再需要 agent」的信号，所以连 agent 子进程一同清理。
//
// **不是 GUI 退出时走的路径** —— GUI 退出调 Detach，让 agent 保留。
//
// 流程：
//  1. 标记 stopRequested = true（防止 supervise 再启新进程）
//  2. cancel ctx 让 supervise 退出
//  3. 给子进程发 SIGTERM（Unix）/ Kill（Windows，无 SIGTERM）
//  4. 等 cmd.Wait 完成（带 3 秒超时；超过则强 Kill）
//
// 幂等。
func (s *agentSupervisor) Stop() {
	s.stopInternal(true)
}

// Detach 停止重启监控但「不」杀掉 agent 子进程
//
// 使用场景：GUI 进程要退出但服务依然要留着 —— agent 以后会被下一次
// GUI 启动后的 controlClient 重连机制接管。这是实现「Bitwarden-like」后台
// 常驻体验的关键。
//
// 流程：
//  1. 标记 stopRequested = true（防止 supervise 再启新进程）
//  2. cancel ctx 让 supervise 退出
//  3. **不**给子进程发死亡信号，**不**等 Wait。子进程独立存活。
//  4. 释放 supervisor 内部状态。
//
// 调用后 supervisor 不再跟踪 agent。下次 GUI 启动重新走「检测存活、
// 如果有则重用；没有则重启」的逻辑。
//
// 幂等。
func (s *agentSupervisor) Detach() {
	s.stopInternal(false)
}

// stopInternal Stop / Detach 的实现
//
// killChild=true：发 Kill / SIGTERM 并等进程结束。
// killChild=false：仅停重启监控，子进程独立存活。
func (s *agentSupervisor) stopInternal(killChild bool) {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	s.stopRequested = true
	cancel := s.cancel
	cmd := s.cmd
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}

	if killChild && cmd != nil && cmd.Process != nil {
		// 优先 SIGTERM 让 agent 走优雅退出（清理 socket 文件）
		// signal 失败也无所谓 —— 进程可能已经退出
		s.signalGracefulShutdown(cmd)

		// 3 秒兑底强 Kill（「兑底」是「兑现护底」，避免 agent 卡住不退）
		done := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(done)
		}()
		select {
		case <-done:
			// 正常退出
		case <-time.After(3 * time.Second):
			s.logger.Warn("agent did not exit in 3s, force killing")
			_ = cmd.Process.Kill()
			<-done
		}
	}
	// killChild=false 时：不动 cmd 进程，也不 Wait（Wait 会阻塞到子进程
	// 退出）。cmd.Process 保留上下文但我们不再关心；os.exec 在父退出后
	// zombie 状态由 init/Windows 接管。

	s.mu.Lock()
	s.running = false
	s.cmd = nil
	s.mu.Unlock()

	if killChild {
		s.logger.Info("agent supervisor stopped (child killed)")
	} else {
		s.logger.Info("agent supervisor detached (child kept running)")
	}
}

// IsRunning 报告当前 supervisor 是否处于「我们认为 agent 在跑」状态
//
// 注意：这只是 GUI 端的视图。agent 子进程实际可能已经崩了等待重启。
// 调用方需要的是「逻辑状态」而非「实时进程存活」时用本方法即可。
func (s *agentSupervisor) IsRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// supervise 是后台监控 goroutine 主体
//
// 死循环：startOnce → 等进程退出 → 退避 → 再 startOnce，直到 stopRequested
// 或 ctx cancel。
func (s *agentSupervisor) supervise(ctx context.Context) {
	backoffIdx := 0
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		err := s.startOnce(ctx)
		if err != nil {
			s.logger.Warn("agent process ended", "err", err, "backoffIdx", backoffIdx)
		}

		s.mu.Lock()
		if s.stopRequested {
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()

		// 等待退避后重启
		wait := time.Duration(agentRestartBackoffSeconds[backoffIdx]) * time.Second
		if backoffIdx < len(agentRestartBackoffSeconds)-1 {
			backoffIdx++
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// startOnce 启动并等待一个 agent 子进程实例
//
// 返回时表示该实例已退出（无论正常还是异常）。返回值是进程退出的错误
// （nil 表示干净退出）。
//
// 把 stdout/stderr 通过 io.Copy 重定向到 GUI 的 stderr —— agent 的 log
// 出现在和 GUI 同一个 console 里，便于诊断。
func (s *agentSupervisor) startOnce(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, s.binaryPath)

	// 默认就是 ZPASS_AGENT 子进程，可能受 GUI 进程的环境影响 —— Wails 应用
	// 通常没有特别的环境需求，直接继承环境变量即可
	cmd.Env = os.Environ()

	// 重定向输出到 GUI stderr —— 当前 zpass-agent slog 默认就输出到 stderr，
	// 这条管道让 user 在 console 看到 agent log。生产环境用户看不到 GUI
	// stderr，但开发时极有用。
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %w", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}

	// 配置平台特定的进程属性（如 Windows 上隐藏 console window）
	configurePlatformProcAttr(cmd)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start agent: %w", err)
	}

	s.mu.Lock()
	s.cmd = cmd
	s.lastStartedAt = time.Now()
	s.mu.Unlock()

	pid := cmd.Process.Pid
	s.logger.Info("agent process started", "pid", pid, "binary", s.binaryPath)

	// 异步 copy 输出
	go drainOutput(stderrPipe, "agent stderr", s.logger)
	go drainOutput(stdoutPipe, "agent stdout", s.logger)

	// 等进程退出
	err = cmd.Wait()

	s.mu.Lock()
	s.cmd = nil
	if err != nil {
		s.lastExitReason = err.Error()
	} else {
		s.lastExitReason = "clean exit"
	}
	s.mu.Unlock()

	s.logger.Info("agent process exited", "pid", pid, "err", err)
	return err
}

// drainOutput 把子进程的 stdout/stderr 转发到 GUI logger
//
// 直接用 io.Copy(os.Stderr, ...) 也行，但 stream 出来的内容会和 GUI 自己的
// slog 输出格式混在一起。这里逐行 log 包一层 prefix 让两者区分。
//
// 实现简化：直接 io.Copy 到 os.Stderr。逐行解析的代价不值得。
func drainOutput(r io.ReadCloser, label string, logger *slog.Logger) {
	defer r.Close()
	if _, err := io.Copy(os.Stderr, r); err != nil {
		// EOF / closed pipe 都是正常路径，不报错
		logger.Debug("drainOutput ended", "label", label, "err", err)
	}
}

// ---------------------------------------------------------------------------
// agent binary 定位
// ---------------------------------------------------------------------------

// locateAgentBinary 寻找 zpass-agent 可执行文件
//
// 优先级见文件头注释。返回绝对路径或 ErrAgentBinaryMissing。
//
// **不在本函数内执行 binary** —— 仅检查文件存在 + 可读。execve 时如果
// 文件已被删 / 权限错，会在 cmd.Start 阶段被发现。
func locateAgentBinary() (string, error) {
	binName := "zpass-agent"
	if runtime.GOOS == "windows" {
		binName = "zpass-agent.exe"
	}

	// 1. 环境变量
	if env := os.Getenv("ZPASS_AGENT_BIN"); env != "" {
		if fileExists(env) {
			return env, nil
		}
		// 用户明确设了但找不到 —— 报错让 user 修正
		return "", fmt.Errorf("%w: ZPASS_AGENT_BIN=%s not found", ErrAgentBinaryMissing, env)
	}

	// 2. GUI binary 同目录
	guiBin, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(guiBin)
		candidate := filepath.Join(dir, binName)
		if fileExists(candidate) {
			return candidate, nil
		}
	}

	// 3. $PATH
	if found, err := exec.LookPath(binName); err == nil {
		return found, nil
	}

	return "", fmt.Errorf("%w: searched %s, $PATH", ErrAgentBinaryMissing, binName)
}

// fileExists 检查路径是否指向一个存在的常规文件
func fileExists(path string) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	return st.Mode().IsRegular()
}
