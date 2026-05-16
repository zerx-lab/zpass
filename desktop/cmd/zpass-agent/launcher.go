// zpass-agent 守护进程 —— GUI 按需拉起
//
// ---------------------------------------------------------------------------
// 目标
//
// 当 ssh 客户端发起签名请求但 GUI 未连接时，agent 主动拉起 ZPass GUI 进程。
// 拉起后等待 GUI 握手成功，再转发签名请求让用户在弹窗里确认。
//
// 这是双进程架构的关键 UX 拼图 —— 它让用户体验上：
//   - 用户关 GUI 主窗口 → agent 仍然存活
//   - 用户跑 git push → agent 检测到 GUI 缺席 → 拉起 GUI → 用户确认 → 签名
//   - 整个过程对用户透明，git push 看起来只是「等了 2-3 秒」
//
// 这是 Bitwarden Desktop SSH agent 没做（关 GUI 必失败）但 1Password 做了
// 的差异化能力。
//
// ---------------------------------------------------------------------------
// 实现策略
//
// **GUI binary 定位**：与 zpass-agent 同目录的 `ZPassDesktop` 或 `ZPass.app`。
//
//	Linux:   ZPassDesktop （二进制）
//	macOS:   /Applications/ZPass.app  或 同目录 ZPass.app
//	Windows: ZPassDesktop.exe
//
// **启动方式**：
//   - Linux:   直接 exec.Cmd(binary).Start()，detached 模式（不让 agent 退出
//              时把 GUI 也带走）
//   - macOS:   open -a ZPass.app（让 launchd 接管生命周期）
//   - Windows: cmd.Start() + DETACHED_PROCESS
//
// **重入保护**：
//   - 同时多个签名请求只触发一次 GUI 启动
//   - 用 sync.Once 控制；若 GUI 启动失败可在 60 秒后允许重试
//
// ---------------------------------------------------------------------------
// 失败降级
//
// 找不到 GUI binary / 启动失败 → 签名失败给 ssh，与 GUI 完全没装情况一致。
// 不向 SSH 客户端泄露细节，仅 log 记录便于诊断。

package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// guiLaunchCooldown 两次 GUI 启动尝试的最小间隔
//
// 防御：GUI 启动失败（binary 损坏 / 用户拒绝授权）后高频签名请求会触发
// 无穷无尽的 spawn 尝试，浪费 CPU + 日志泛滥。冷却时间内的签名请求直接
// 失败，不再尝试拉起。
//
// 60 秒：足够覆盖正常 GUI 启动（包括 webview 加载）的最长时间；冷却结束
// 后下次签名请求自动重试。
const guiLaunchCooldown = 60 * time.Second

// ---------------------------------------------------------------------------
// guiLauncher
// ---------------------------------------------------------------------------

// guiLauncher 负责按需拉起 ZPass GUI 子进程
//
// 由 main 创建并注入到 controlClient —— controlClient 在「dispatch 时
// GUI 不在线」分支调用 Ensure。
type guiLauncher struct {
	logger *slog.Logger

	mu          sync.Mutex
	guiBinary   string    // 缓存定位到的 GUI binary 路径（空 = 未尝试过 / 找不到）
	lastAttempt time.Time // 最后一次 spawn 尝试的时间，用于冷却控制

	// inflight 防止同时多个签名请求都触发 spawn —— 第一个请求 spawn
	// 后续请求等待 GUI 上线即可
	inflight atomic.Bool
}

// newGUILauncher 构造 launcher
//
// 不在构造时定位 GUI binary —— 启动 agent 时 GUI 可能尚未安装到目标位置
// （首次安装 race），延迟到 Ensure 第一次调用时定位。
func newGUILauncher(logger *slog.Logger) *guiLauncher {
	return &guiLauncher{
		logger: logger.With("subsystem", "guiLauncher"),
	}
}

// Ensure 确保 GUI 进程已经启动（如果未运行则拉起）
//
// 返回 nil 表示「触发了 spawn / 不需要 spawn」—— 调用方应当继续等
// 控制通道握手成功（最长由 RequestSign 的 signDeadline 兜底）。
//
// 返回 error 表示「这次明确无法拉起」（找不到 binary / 处于冷却期 /
// spawn 失败）。调用方应当让签名请求立即失败而非空等。
//
// 幂等：多次并发调用只会触发一次 spawn —— inflight 标记位保证。
func (l *guiLauncher) Ensure() error {
	// 已经有 spawn 在进行中 → 让调用方等待
	if l.inflight.Load() {
		l.logger.Debug("Ensure: spawn already in flight")
		return nil
	}

	l.mu.Lock()
	now := time.Now()
	if !l.lastAttempt.IsZero() && now.Sub(l.lastAttempt) < guiLaunchCooldown {
		// 冷却期内 —— 拒绝再次尝试
		remaining := guiLaunchCooldown - now.Sub(l.lastAttempt)
		l.mu.Unlock()
		return fmt.Errorf("GUI launch cooldown active, retry in %s", remaining.Round(time.Second))
	}

	// 定位 binary
	bin := l.guiBinary
	if bin == "" {
		located, err := locateGUIBinary()
		if err != nil {
			l.mu.Unlock()
			return fmt.Errorf("locate GUI binary: %w", err)
		}
		bin = located
		l.guiBinary = bin
	}

	l.lastAttempt = now
	l.mu.Unlock()

	// 抢占 inflight 标志位 + 异步 spawn
	if !l.inflight.CompareAndSwap(false, true) {
		// 别的 goroutine 抢先了 —— 让它处理
		return nil
	}

	go func() {
		defer l.inflight.Store(false)
		if err := l.spawn(bin); err != nil {
			l.logger.Warn("GUI spawn failed", "binary", bin, "err", err)
		} else {
			l.logger.Info("GUI spawn initiated", "binary", bin)
		}
	}()
	return nil
}

// spawn 实际启动 GUI 进程
//
// 平台差异由 spawnGUIPlatform 分文件实现：
//   - Linux/macOS：detached exec.Cmd
//   - Windows：DETACHED_PROCESS flag
func (l *guiLauncher) spawn(binary string) error {
	if binary == "" {
		return errors.New("empty GUI binary path")
	}
	return spawnGUIPlatform(binary, l.logger)
}

// ---------------------------------------------------------------------------
// GUI binary 定位
// ---------------------------------------------------------------------------

// locateGUIBinary 寻找 ZPass GUI 可执行文件
//
// 优先级：
//  1. 环境变量 ZPASS_GUI_BIN
//  2. agent binary 同目录下查找
//
// 不查 $PATH —— GUI 通常不在 $PATH（安装到 /Applications 或 Program Files）。
func locateGUIBinary() (string, error) {
	// 1. 环境变量
	if env := os.Getenv("ZPASS_GUI_BIN"); env != "" {
		if fileExistsLauncher(env) {
			return env, nil
		}
		return "", fmt.Errorf("ZPASS_GUI_BIN=%s not found", env)
	}

	// 2. agent binary 同目录
	agentBin, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("os.Executable: %w", err)
	}
	dir := filepath.Dir(agentBin)

	candidates := guiBinaryCandidates(dir)
	for _, c := range candidates {
		if fileExistsLauncher(c) {
			return c, nil
		}
	}

	return "", fmt.Errorf("ZPass GUI binary not found in %s (tried %v)", dir, candidates)
}

// guiBinaryCandidates 返回各平台 GUI binary 候选路径
//
// 名字来源：desktop/build/config.yml 里 productName = "ZPass" /
// Wails 默认输出 ZPassDesktop。
func guiBinaryCandidates(dir string) []string {
	switch runtime.GOOS {
	case "linux":
		return []string{
			filepath.Join(dir, "ZPassDesktop"),
			filepath.Join(dir, "ZPass"),
			filepath.Join(dir, "zpass-desktop"),
		}
	case "darwin":
		// macOS：先找 .app bundle，再找裸 binary
		return []string{
			filepath.Join(dir, "..", "..", "..", "ZPass.app"),
			"/Applications/ZPass.app",
			filepath.Join(dir, "ZPassDesktop"),
		}
	case "windows":
		return []string{
			filepath.Join(dir, "ZPassDesktop.exe"),
			filepath.Join(dir, "ZPass.exe"),
		}
	}
	return nil
}

// fileExistsLauncher 与 sshagentsupervisor 的 fileExists 同语义
//
// 重复实现 —— 不跨 package 共享因为 supervisor 在 main 包，本文件在
// cmd/zpass-agent 包，不能 import。
func fileExistsLauncher(path string) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	// macOS .app 是目录；其它平台是文件
	return st.Mode().IsRegular() || st.IsDir()
}

// ---------------------------------------------------------------------------
// 平台特定 spawn 实现引用 —— 见 launcher_{unix,darwin,windows}.go
// ---------------------------------------------------------------------------

// spawnGUIPlatform 由平台特定文件实现。在本平台内启动 GUI 进程，立刻 detach
// 让 agent 进程退出时不影响 GUI。
//
// 实现要求：
//   - 不阻塞 —— 启动后立刻返回，不等 GUI 真正显示窗口
//   - detach —— GUI 应该独立于 agent 生存
//   - 失败可恢复 —— exec 错误返 error，让冷却 + 重试机制兜底
var _ = spawnGUIPlatform // 编译期确认平台实现存在
