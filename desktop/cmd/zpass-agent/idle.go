// zpass-agent 守护进程 —— 空闲超时退出
//
// ---------------------------------------------------------------------------
// 目标
//
// 在 systemd socket activation 模式下，让 agent 进程在「N 分钟无 SSH 连接
// 也无 GUI 连接」时自动退出。systemd 看到 main process 退出后会回到
// 「等连接」状态，下一次 ssh 连接才再次拉起 agent。
//
// 这是「按需 0 内存」体验的关键拼图：
//
//   t=0min: ssh -T git@github.com    → systemd 拉起 agent
//   t=0min: 签名完成，ssh 退出
//   t=5min: agent 无活动达到 idleTimeout → agent 主动退出
//   t=5min~?: 进程不存在 → ps 看不到 → 0 MB 内存占用
//   t=12min: ssh -T git@github.com   → systemd 又拉起 agent
//
// ---------------------------------------------------------------------------
// 「活动」的定义
//
// 以下三类事件视为「活动」会重置 idle timer：
//   1. accept 新的 SSH agent 连接（ssh / git 拉起来用）
//   2. 控制通道 dispatch 一次 SignRequest（GUI 主动触发签名）
//   3. controlClient 与 GUI 重建连接（GUI 重启 / 第一次握手成功）
//
// 不算活动：
//   - 心跳 Ping/Pong
//   - PushKeys（vault 内部变更广播，无外部使用）
//   - 解锁状态变化（GUI 推 State）
//
// ---------------------------------------------------------------------------
// 仅在 socket activation 模式下生效
//
// 非 activation 模式（用户自己跑 zpass-agent 或 GUI 子进程）下，idle 退出
// 没意义 —— 退了就没人重启，反而让用户 ssh 失败。所以本特性默认 disabled，
// main 在确认 systemd 接管时显式 Enable。
//
// 实现：tracker 内含 enabled flag，未 Enable 时所有 tick / Reset 都是 noop。

package main

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// idleTimeoutDefault 默认空闲超时时长
//
// 5 分钟：足够覆盖「git pull → git push」之间的间隔（一般几秒），同时短到
// 让用户在 IDE 自动 ssh 后能很快回到 0 内存状态。
const idleTimeoutDefault = 5 * time.Minute

// idleTimeoutCheckInterval 内部 tick 频率
//
// 每 30 秒检查一次 last-activity 时间。比 timeout 短 10 倍是常规做法，
// 既不会因为漂移延迟过久退出，也不会浪费 CPU。
const idleTimeoutCheckInterval = 30 * time.Second

// idleTracker 跟踪进程是否处于空闲状态
//
// 单例由 main 创建并注入到需要标记活动的位置：
//   - listener accept 路径：每次新连接调 Touch
//   - controlClient 握手成功：调 Touch
//   - state.RequestSign：每次签名转发调 Touch
//
// 实现是「最后活动时间戳 + 定时器对比」—— 比「定时器 Reset」简单，避免
// 高频活动场景下不断 Reset 定时器的性能开销。
type idleTracker struct {
	mu         sync.Mutex
	enabled    bool
	timeout    time.Duration
	lastActive time.Time
	cancel     context.CancelFunc
	onExit     func()
	logger     *slog.Logger
}

// newIdleTracker 构造 tracker（默认 disabled）
//
// onExit 由 main 注入，触发整个进程优雅退出（cancel root ctx）。
// 不直接 os.Exit —— 让 main 走正常 cleanup 流程，避免 unix socket 残留等。
func newIdleTracker(onExit func(), logger *slog.Logger) *idleTracker {
	return &idleTracker{
		timeout: idleTimeoutDefault,
		onExit:  onExit,
		logger:  logger.With("subsystem", "idleTracker"),
	}
}

// Enable 开启 idle 跟踪 + 启动后台 tick goroutine
//
// 由 main 在确认 systemd 接管 socket 时调用。重复 Enable 安全（幂等）。
//
// 设计取舍：把启动 tick 放在 Enable 而不是 newIdleTracker —— 让单测可以
// 构造 tracker 但不启动后台 goroutine。
func (t *idleTracker) Enable(timeout time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.enabled {
		// 已启用，仅更新 timeout（也支持运行时调参）
		t.timeout = timeout
		return
	}
	t.enabled = true
	if timeout > 0 {
		t.timeout = timeout
	}
	t.lastActive = time.Now()

	ctx, cancel := context.WithCancel(context.Background())
	t.cancel = cancel
	go t.tickLoop(ctx)
	t.logger.Info("idle tracker enabled", "timeout", t.timeout.String())
}

// Stop 关闭 tracker（停 tick goroutine）
//
// main 在 shutdown 时调，让 tick 不再触发 onExit 二次退出。幂等。
func (t *idleTracker) Stop() {
	t.mu.Lock()
	cancel := t.cancel
	t.enabled = false
	t.cancel = nil
	t.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Touch 标记一次活动
//
// 由所有「活动点」调用：
//   - accept 新连接
//   - dispatch SignRequest
//   - GUI 握手成功
//
// 未 Enable 时是 noop —— 调用方可以无条件调，不必查状态。
//
// 性能：单次调用 = 抢一把 mutex + 写 time.Time。高频 ssh 连接也不会成为
// 瓶颈（每秒几千次也只占微秒级 CPU）。
func (t *idleTracker) Touch() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.enabled {
		return
	}
	t.lastActive = time.Now()
}

// tickLoop 后台检查 last-activity，超时则触发 onExit
//
// 每 idleTimeoutCheckInterval 醒来一次比对 lastActive；超过 timeout 则
// 调 onExit 并退出循环。
func (t *idleTracker) tickLoop(ctx context.Context) {
	ticker := time.NewTicker(idleTimeoutCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			t.mu.Lock()
			if !t.enabled {
				t.mu.Unlock()
				return
			}
			elapsed := time.Since(t.lastActive)
			timeout := t.timeout
			t.mu.Unlock()

			if elapsed >= timeout {
				t.logger.Info("idle timeout reached, exiting agent",
					"elapsed", elapsed.String(),
					"timeout", timeout.String())
				if t.onExit != nil {
					t.onExit()
				}
				return
			}
		}
	}
}
