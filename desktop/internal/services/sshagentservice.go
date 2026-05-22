// SSH agent 服务 —— ZPass 桌面客户端 GUI 侧
// ---------------------------------------------------------------------------
// 把 vault 中存储的 SSH 密钥暴露给系统层面的 SSH 客户端（ssh / git /
// rsync 等），让用户无需把私钥复制到 ~/.ssh/ 即可使用。
//
// ---------------------------------------------------------------------------
// 架构：双进程
//
//	┌─ ssh / git ─────────────────► /run/user/UID/zpass/agent.sock
//	                                     │
//	                                     ▼
//	                              ┌──────────────────┐
//	                              │   zpass-agent    │ 守护进程
//	                              │  （cmd/zpass-agent）│
//	                              │   ~ 10 MB RSS    │
//	                              └────────┬─────────┘
//	                                       │ 控制通道（本文件 listen）
//	                                       ▼
//	                              ┌──────────────────┐
//	                              │   ZPass GUI       │ Wails 进程
//	                              │  （本服务所在）    │
//	                              │   持有 DEK        │
//	                              └──────────────────┘
//
// 本服务（在 GUI 进程内）的职责：
//   1. 启动 capability token：生成 / 写入 ~/.config/zpass/agent.cap
//   2. 启动 **控制通道 listener**：等待 zpass-agent 连进来握手（GUI 监听
//      + agent connect 的拓扑选择，见 control.go 注释）
//   3. 处理握手：HMAC 验证 agent 持有同一 token
//   4. 在 vault 解锁后：把所有 type=ssh 条目转换为 PublicKeyEntry 推给 agent
//   5. 在 vault 锁定时：发 OpState 通知 agent
//   6. 处理 SignRequest：弹确认窗（MVP 阶段先 stub 为自动批准）→ 解密私钥
//      → 签名 → 回 SignReply
//
// ---------------------------------------------------------------------------
// 注入到 Wails Service 列表
//
// main.go 在 application.NewService(...) 中注册本服务：
//
//	application.NewService(NewSshAgentService(vaultService))
//
// 前端通过 `Call.ByName("main.SshAgentService.X", ...)` 调用。
// 前端可调用的方法（首字母大写）：
//   - Status() → SshAgentStatus
//   - Enable() → error  ：启动控制通道 listener
//   - Disable() → error ：停止 listener + 关 agent
//   - GetSocketPath() → string ：给设置页展示 SSH_AUTH_SOCK 路径
//
// ---------------------------------------------------------------------------
// MVP 阶段简化
//
// 1. **签名确认**：本版本默认「vault 解锁状态下自动批准」。下一版加用户
//    确认窗（独立 Wails 窗口 + EventBus 通信）。
// 2. **审计日志**：仅 slog 输出，不写 vault.db。
// 3. **vault 变更订阅**：当前 GUI 调 Create/Update/Delete SSH item 后需要
//    主动调 PushVaultKeys()；后续可以加 vault 变更事件订阅自动推送。
// 4. **GUI 拉起 agent**：MVP 不实现 systemd activation；用户需要手动启动
//    zpass-agent（或后续打包到自启动）。

package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/zerx-lab/zpass/internal/sshagentproto"
)

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

// SshAgentStatus 反映 SSH agent 服务的整体状态，给前端设置页展示
//
// 字段 JSON tag 小写驼峰，与项目其它前端契约一致。
type SshAgentStatus struct {
	// Enabled 控制通道 listener 是否在运行
	//
	// 用户在设置页打开开关 → true；关闭 / 服务异常退出 → false。
	Enabled bool `json:"enabled"`

	// AgentConnected zpass-agent 守护进程是否已握手连上
	//
	// Enabled=true 但 AgentConnected=false 表示「listener 在跑但 agent
	// 还没起来」—— 前端可以提示用户去启动 zpass-agent。
	AgentConnected bool `json:"agentConnected"`

	// AgentSupervised GUI 是否在代理管理 agent 进程（作为子进程拉起）
	//
	// false = 用户需要或 systemd / launchd 管理 agent
	AgentSupervised bool `json:"agentSupervised"`

	// AgentManagedBySystem agent 是否由系统服务管理器接管
	//
	// true 表示：Linux 上 systemd user unit 装了、启用了、健康中；Windows 上
	// Scheduled Task 装了、启用中。这时 GUI 不拉 supervisor，为 true 同时
	// AgentSupervised 为 false。前端可以据此展示「后台常驻，GUI 退也不影响 ssh」。
	AgentManagedBySystem bool `json:"agentManagedBySystem"`

	// SocketPath SSH 客户端要 connect 的 agent socket 路径
	//
	// 用户需要把它设到 SSH_AUTH_SOCK 环境变量。前端提供「一键复制」按钮。
	SocketPath string `json:"socketPath"`

	// ControlPath 控制通道 socket 路径（仅 debug / 排错时展示）
	ControlPath string `json:"controlPath"`

	// KeyCount 当前推送给 agent 的公钥数量
	KeyCount int `json:"keyCount"`

	// AgentBinaryPath GUI 拉起 agent 使用的 binary 路径（调试展示）
	// 空串 = 未定位 / 未启用 supervisor
	AgentBinaryPath string `json:"agentBinaryPath"`
}

// ---------------------------------------------------------------------------
// SshAgentService —— 注册到 Wails 的服务对象
// ---------------------------------------------------------------------------

// SshAgentService 暴露给前端 + 内部协调控制通道生命周期
//
// 依赖：
//   - vault：用于读取 ssh 类型条目（公钥 + 私钥）；通过现有 VaultService
//     反向引用而非全局变量，方便测试注入 mock。
//   - logger：结构化日志。Wails 项目其它 service 没用 slog，但这里 SSH
//     agent 的协议日志量较大，结构化日志价值更高 —— 不强求与其它服务
//     的 fmt.Printf 风格统一。
//
// 字段保护：sync.Mutex（不是 RWMutex —— 状态读写次数对等，读锁开销不值得）
type SshAgentService struct {
	vault  *VaultService
	logger *slog.Logger

	mu sync.Mutex

	// listener 控制通道服务端 listener
	//
	// 用 *controlListener 自定义类型而非 net.Listener：自定义类型包装
	// 了 token / connection handler / agent 状态，更内聚。
	listener *controlListener

	// activeConn 当前与 agent 握手成功的连接（用于推送 PushKeys 等）
	//
	// MVP 阶段允许单连接 —— 多个 agent 实例连过来会导致后到的覆盖前面，
	// 这是合理行为（用户应该只跑一个 agent）。
	activeConn *controlServerConn

	// supervisor 管理 zpass-agent 子进程生命周期
	//
	// MVP-2 阶段：Enable() 时如果能定位到 binary 则创建 supervisor
	// 并 Start；Disable() 时 Stop。nil 表示设置中关了 supervisor 或
	// 定位不到 binary —— 那时用户需手动运行 zpass-agent。
	supervisor *agentSupervisor

	// approvals 用户确认窗 manager
	//
	// 实例生命周期与 SshAgentService 同在 —— 不随 Enable/Disable 重建，
	// 避免用户锁定 vault 后又解锁 trust cache 被丢失（虽然 vault lock 已
	// 会 clearTrust）。
	approvals *approvalManager

	// auditLog 内存 ring buffer，记录最近签名记录供前端查询
	auditLog *auditLog

	// agentBinaryPath 当前使用的 zpass-agent 路径（供 Status() 展示调试）
	agentBinaryPath string

	// emit 用于向前端发送 Wails event（approval-request / approval-cancelled
	// / status-changed 等）。由 SetEventEmitter 注入；为 nil 时不 emit。
	//
	// 不直接持有 Wails Application 指针：让 SshAgentService 能在没有 Wails
	// 环境的单测 / 命令行调用中运行，仅 main.go 注入真实 emitter。
	emit func(event string, payload any)
}

// NewSshAgentService 构造服务
//
// 由 main.go 在所有依赖都创建好之后调用：
//
//	application.NewService(NewSshAgentService(vaultService))
//
// 不在构造时启动 listener —— 那要求用户必须先在 GUI 设置里启用；首次启动
// 体验是「服务已注册但默认禁用」，避免无声占用 socket 路径。
func NewSshAgentService(vault *VaultService) *SshAgentService {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})).With("service", "SshAgentService")

	s := &SshAgentService{
		vault:    vault,
		logger:   logger,
		auditLog: newAuditLog(),
	}
	// approvalManager 需要 emit 回调才能通知前端；emit 起初由闭包看
	// s.emit（SetEventEmitter 后会是非 nil）。这让动态换 emitter 生效。
	s.approvals = newApprovalManager(func(event string, payload any) {
		s.mu.Lock()
		emit := s.emit
		s.mu.Unlock()
		if emit != nil {
			emit(event, payload)
		}
	})
	return s
}

// SetEventEmitter 注入 Wails event 发送函数
//
// 由 main.go 在 Wails Application 创建后、启动前调用一次。传 nil 可
// 以解除 emitter（仅单测场景）。
//
// 本方法同时信号 approvalManager 里的闭包 —— 闭包里看的是 s.emit，不需
// 重建 approval manager。
func (s *SshAgentService) SetEventEmitter(emit func(event string, payload any)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emit = emit
}

// emitEvent 内部辅助：拿锁 → 查 emit → 释锁 → 安全调用
func (s *SshAgentService) emitEvent(event string, payload any) {
	s.mu.Lock()
	emit := s.emit
	s.mu.Unlock()
	if emit != nil {
		emit(event, payload)
	}
}

// ---------------------------------------------------------------------------
// Wails 前端方法
// ---------------------------------------------------------------------------

// Status 返回 SSH agent 服务的运行快照
//
// 失败可能（极少见）：路径解析出错。返回 SshAgentStatus 零值 + error。
// 前端按 error message 兜底显示「无法读取状态」即可。
func (s *SshAgentService) Status() (SshAgentStatus, error) {
	socketPath, err := sshagentproto.AgentSocketPath()
	if err != nil {
		return SshAgentStatus{}, fmt.Errorf("resolve agent socket: %w", err)
	}
	controlPath, err := sshagentproto.ControlSocketPath()
	if err != nil {
		return SshAgentStatus{}, fmt.Errorf("resolve control socket: %w", err)
	}

	// systemctl 查询会 fork 进程，不能拿主锁时等——在上锁前算完。
	managedBySystem := s.systemServiceHealthyForActivation()

	s.mu.Lock()
	defer s.mu.Unlock()

	st := SshAgentStatus{
		Enabled:              s.listener != nil,
		AgentConnected:       s.activeConn != nil,
		AgentSupervised:      s.supervisor != nil && s.supervisor.IsRunning(),
		AgentManagedBySystem: managedBySystem,
		SocketPath:           socketPath,
		ControlPath:          controlPath,
		AgentBinaryPath:      s.agentBinaryPath,
	}
	if s.activeConn != nil {
		st.KeyCount = s.activeConn.lastPushedKeyCount()
	}
	return st, nil
}

// Enable 启动控制通道 listener
//
// 流程：
//  1. 确保 ~/.config/zpass/ 目录存在
//  2. 确保 capability token 文件存在（不存在则生成）
//  3. 解析 ControlSocketPath 并启动 listener
//
// 幂等：已经启用时返回 nil，不再重复启动。
//
// 失败原因：
//   - capability 目录 mkdir 失败（权限问题）
//   - 控制 socket 已被其它进程占用
func (s *SshAgentService) Enable() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.listener != nil {
		// 已经启用 —— 幂等返回成功
		if err := writeSshAgentDesiredEnabled(true); err != nil {
			return fmt.Errorf("persist SSH agent preference: %w", err)
		}
		// 幂等路径上也要检一下系统服务状态：可能上次 GUI 启动后 systemd unit
		// 被外部改坏了（手动编辑、升级后 binary 路径变了等）。goroutine 里跳到
		// autoInstallSystemServiceOnEnable，它会接着检查 "装了但不健康" 并 log。
		go s.autoInstallSystemServiceOnEnable()
		return nil
	}

	// ----- capability token 准备 -----
	if err := sshagentproto.EnsureCapabilityDir(); err != nil {
		return fmt.Errorf("ensure capability dir: %w", err)
	}
	tokenPath, err := sshagentproto.CapabilityTokenPath()
	if err != nil {
		return fmt.Errorf("resolve token path: %w", err)
	}

	// 仅当不存在时生成 —— 让 agent 已经记下的 token 仍然有效。
	// 如果用户主动想轮换 token，提供另一个方法 ResetToken。
	if _, err := sshagentproto.ReadToken(tokenPath); err != nil {
		if !errors.Is(err, sshagentproto.ErrTokenFileMissing) &&
			!errors.Is(err, sshagentproto.ErrTokenFileInvalid) {
			return fmt.Errorf("read existing token: %w", err)
		}
		// 生成新 token
		newToken, err := sshagentproto.GenerateToken()
		if err != nil {
			return fmt.Errorf("generate token: %w", err)
		}
		if err := sshagentproto.WriteToken(tokenPath, newToken); err != nil {
			return fmt.Errorf("write token: %w", err)
		}
		s.logger.Info("capability token generated", "path", tokenPath)
	}

	// ----- 启动 listener -----
	if err := sshagentproto.EnsureAgentDir(); err != nil {
		return fmt.Errorf("ensure agent dir: %w", err)
	}

	controlPath, err := sshagentproto.ControlSocketPath()
	if err != nil {
		return fmt.Errorf("resolve control path: %w", err)
	}

	ln, err := newControlListener(controlPath, tokenPath, s)
	if err != nil {
		return fmt.Errorf("start control listener: %w", err)
	}
	s.listener = ln
	s.logger.Info("SSH agent service enabled",
		"controlPath", controlPath, "tokenPath", tokenPath)

	if err := writeSshAgentDesiredEnabled(true); err != nil {
		ln.Stop()
		s.listener = nil
		return fmt.Errorf("persist SSH agent preference: %w", err)
	}

	// ----- 启动 agent 子进程（根据 systemd 接管状态决定是否由我们拉起）-----
	//
	// 三条互斥路径：
	//
	//   A. systemd 服务已被接管且健康
	//      → 跳过 supervisor，让 systemd 按需拉起 agent。
	//      避免「systemd socket + supervisor 同时 listen 同一路径」的 fd 抢占。
	//
	//   B. 旧 agent 进程还活在（跨 GUI 重启路径）
	//      → 跳过 supervisor，让旧 agent 的 controlClient 重连机制接管。
	//
	//   C. systemd 不接管 / 不健康，且没旧 agent
	//      → supervisor 拉起 zpass-agent 子进程。
	//
	// 「不健康」场景重点防范：systemd socket unit 抢了 socket fd 但 service
	// unit 起不来（错误配置 / binary 缺失 / sandbox 拒绝）。这时如果照原
	// 逻辑「只要系统服务装了就 supervisor 跳过」，ssh 客户端会 connect 到
	// systemd 那个 fd 但永远启动不了 service，挂住。为避免这个死锁，本处
	// 检测不健康时主动 uninstall systemd 单元让位给 supervisor。
	binPath, locErr := locateAgentBinary()
	if locErr != nil {
		s.logger.Warn("agent binary not located; supervisor not started",
			"err", locErr)
	} else {
		s.agentBinaryPath = binPath
		if runtime.GOOS == "windows" {
			// Windows 上必须让 Scheduled Task 从当前会话就接管进程，
			// 这样 agent 被外部杀掉后 Task Scheduler 才能按 RestartOnFailure
			// 规则重新拉起。失败不阻断 Enable，后面仍有 GUI supervisor fallback。
			if err := s.installSystemServiceWithBinary(binPath); err != nil {
				s.logger.Warn("install/start Windows scheduled task failed", "err", err)
			}
		}

		switch {
		case isAgentAlreadyRunning():
			// 路径 B：旧 agent 进程在跑 —— 不拉新进程，避免 named pipe / socket
			// 冲突。旧 agent 会通过 controlClient 重连机制主动连到本进程刚启动的
			// control listener（反重连退避 1->2->5->10s）。
			s.logger.Info("existing agent detected; skipping supervisor start",
				"socket", controlPath)

		case s.systemServiceHealthyForActivation():
			// 路径 A：systemd 接管中且健康，仅走 socket activation。
			// supervisor 不拉 agent —— 避免两个 listener 争抢同一 socket fd。
			s.logger.Info("system service is healthy; deferring to systemd socket activation",
				"socket", controlPath)

		default:
			// 路径 C：systemd 不健康或未装 —— supervisor 拉起。
			// 如果 systemd 装了但不健康（fd 抢占场景），先 uninstall 让位。
			s.maybeUninstallUnhealthySystemService()

			s.supervisor = newAgentSupervisor(binPath, s.logger)
			if err := s.supervisor.Start(); err != nil {
				s.logger.Warn("start agent supervisor failed", "err", err)
				s.supervisor = nil
			} else {
				s.logger.Info("agent supervisor started", "binary", binPath)
			}
		}
	}

	// 启动后如果 vault 已经解锁，立即触发一次推送 —— 但此时 agent 可能
	// 还没连上，推送会被 controlListener 暂存等握手完成后发出。
	if s.vault != nil && s.vault.IsUnlocked() {
		// 用 goroutine 不阻塞 Enable 调用（推送涉及 vault 全量解密，可能慢）
		go s.pushVaultKeysInBackground()
	}

	// ----- 首次启用自动安装系统服务 -----
	//
	// Linux → systemd user unit + socket activation
	// Windows → Scheduled Task at login
	// macOS / 其他 → 跳过
	//
	// 在 goroutine 中调：安装过程会写文件 + 调 systemctl/schtasks，不该阻塞
	// Enable() 返回让前端提示「启用成功」。安装失败也不影响服务本身可用性
	// （fallback 到 GUI 子进程接管模式）。
	if runtime.GOOS != "windows" {
		go s.autoInstallSystemServiceOnEnable()
	}

	return nil
}

// Disable 停止控制通道 listener + 断开 agent + 杀掉守护进程
//
// 调用时机：用户在设置页点「禁用 SSH agent 服务」。这是「用户明确不再需
// 要 agent 服务」的信号，以后要重新启用必须再点「启用」。
//
// **不是 GUI 退出时调用的** —— GUI 退出调 Shutdown（见下面），保留 agent
// 子进程会后台存活让下次 GUI 启动重用。
//
// 幂等。
func (s *SshAgentService) Disable() error {
	s.mu.Lock()
	listener := s.listener
	supervisor := s.supervisor
	s.listener = nil
	s.activeConn = nil
	s.supervisor = nil
	s.agentBinaryPath = ""
	s.mu.Unlock()

	if listener != nil {
		listener.Stop()
	}
	if supervisor != nil {
		// Stop 会杀掉 agent 子进程 —— 这里是「用户明确禁用服务」路径，
		// 需要彻底清理，不要留下后台进程。
		supervisor.Stop()
	}
	// 清空信任 cache + 审计日志：「禁用服务」应该是「一切从零开始」快照
	s.approvals.clearTrust()
	s.auditLog.clear()

	s.logger.Info("SSH agent service disabled")

	var errs []error
	if err := writeSshAgentDesiredEnabled(false); err != nil {
		errs = append(errs, fmt.Errorf("persist SSH agent preference: %w", err))
	}
	if err := s.UninstallSystemService(); err != nil && !errors.Is(err, ErrSystemServiceUnsupported) {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// Shutdown 仅停控制通道 listener，保留 agent 子进程后台存活
//
// 调用时机：GUI 进程退出（OnShutdown 钩子）。以下与 Disable 的差别是关键：
//
//   - **不杀 agent 子进程**：调 supervisor.Detach()，让 agent 独立存活
//     等待下次 GUI 启动重用。
//   - **不卸载系统服务**：GUI 仅退出不意味着「不再需要 SSH agent」。
//   - **不清空信任 / 审计**：GUI 退出后 agent 会需要这些状态，下次启动时
//     推送回去也可以，但不主动 clear 避免「重启后详估重来」体验。
//
// listener 仍需要关闭：
//   - GUI 进程要退了，listener 在本进程里，进程退出则 listener 自动销毁
//   - agent 的 controlClient 会检测到连接断开，走重连退避，等下次 GUI 启动
//
// 幂等。
func (s *SshAgentService) Shutdown() error {
	s.mu.Lock()
	listener := s.listener
	supervisor := s.supervisor
	s.listener = nil
	s.activeConn = nil
	s.supervisor = nil
	s.mu.Unlock()

	if listener != nil {
		listener.Stop()
	}
	if supervisor != nil {
		// Detach —— 仅停重启监控，不杀 agent 子进程。详见 sshagentsupervisor.go
		// 中 Detach 方法注释。
		supervisor.Detach()
	}

	s.logger.Info("SSH agent service shut down (agent kept running)")
	return nil
}

// GetSocketPath 返回 SSH 客户端应该 connect 的 socket 路径
//
// 给前端「复制 SSH_AUTH_SOCK 一键贴 shell rc」用。即便服务未启用也能
// 查询 —— 路径是确定的，启用后才有 listener。
func (s *SshAgentService) GetSocketPath() (string, error) {
	return sshagentproto.AgentSocketPath()
}

// ---------------------------------------------------------------------------
// Vault 集成 —— 由 VaultService 在 SSH item 变更时调用
// ---------------------------------------------------------------------------

// PushVaultKeys 把当前 vault 中所有 type=ssh 条目推给已连接的 agent
//
// 调用时机：
//   - vault 解锁后第一次（由 vaultservice.Unlock 末尾调用）
//   - 用户创建 / 修改 / 删除 ssh 类型条目后（由 vaultservice 末尾调用）
//   - SshAgentService.Enable 时 vault 已解锁的情况
//
// vault 锁定时本方法直接返回 nil —— 没有 DEK 没法读条目，agent 那边会
// 通过 OpState 收到 unlocked=false 知道状态。
//
// agent 未连上时 → push 调用静默成功（PublicKeyEntry 列表会被 listener
// 暂存，握手成功后立即下发）。
func (s *SshAgentService) PushVaultKeys() error {
	s.mu.Lock()
	listener := s.listener
	s.mu.Unlock()

	if listener == nil {
		// 服务未启用 —— 不算错误，只是没事可做
		return nil
	}

	entries, err := s.collectSshEntries()
	if err != nil {
		return err
	}

	listener.UpdateKeys(entries)
	s.logger.Info("vault keys pushed", "count", len(entries))
	return nil
}

// NotifyVaultUnlocked 由 vaultservice 在 Unlock 成功后调用
//
// 触发：
//  1. 推送 OpState{Unlocked: true} 给 agent
//  2. 全量推送 SSH 公钥（PushVaultKeys）
//  3. flush 内存中「上次锁定期间」产生的 audit entry 到 vault.db
func (s *SshAgentService) NotifyVaultUnlocked() {
	s.mu.Lock()
	listener := s.listener
	s.mu.Unlock()

	if listener == nil {
		// 服务未启用 —— 仍然 flush audit（用户可能临时关了 SSH agent
		// 但老记录仍该保留）
		go s.flushPendingAuditToDB()
		return
	}
	listener.UpdateState(true)
	// 推送 key 走独立路径 —— UpdateKeys 也会被持久化到 listener 内部
	// state，避免 agent 重连时丢
	go func() {
		if err := s.PushVaultKeys(); err != nil {
			s.logger.Warn("PushVaultKeys after unlock failed", "err", err)
		}
		s.flushPendingAuditToDB()
	}()
}

// NotifyVaultLocked 由 vaultservice 在 Lock 时调用
//
// 推送 OpState{Unlocked: false}，同时清空 key 列表（agent 锁定状态下
// 仍允许列出公钥的设计需要再讨论；MVP 阶段一致选「锁定即不列出」更直观）。
func (s *SshAgentService) NotifyVaultLocked() {
	s.mu.Lock()
	listener := s.listener
	s.mu.Unlock()

	if listener == nil {
		return
	}
	listener.UpdateState(false)
	listener.UpdateKeys(nil) // 清空公钥
	s.logger.Info("vault locked, agent state cleared")
}

// ---------------------------------------------------------------------------
// 内部：vault → PublicKeyEntry 转换
// ---------------------------------------------------------------------------

// collectSshEntries 从 vault 读取所有 type=ssh 条目并转为 PublicKeyEntry
//
// 跳过条件：
//   - vault 锁定（返回空列表 + nil error，不算错误）
//   - 条目 fields 缺 public_key / private_key（log 跳过，不算错误）
//
// 注意：本方法读全量 vault item，对大 vault 可能慢（每条都解密）。MVP
// 阶段够用；优化方向是在 vault 内维护「ssh item 子集」的二级索引。
func (s *SshAgentService) collectSshEntries() ([]sshagentproto.PublicKeyEntry, error) {
	summaries, err := s.vault.ListItems()
	if err != nil {
		if errors.Is(err, ErrVaultLocked) {
			return nil, nil // 不算错误
		}
		return nil, fmt.Errorf("list vault items: %w", err)
	}

	out := make([]sshagentproto.PublicKeyEntry, 0)
	for _, sum := range summaries {
		if sum.Type != ItemTypeSSH {
			continue
		}
		payload, err := s.vault.GetItem(sum.ID)
		if err != nil {
			s.logger.Warn("collectSshEntries: get item failed",
				"id", sum.ID, "err", err)
			continue
		}
		if payload == nil {
			continue
		}

		entry, ok := sshItemToEntry(payload, s.logger)
		if !ok {
			continue
		}
		out = append(out, entry)
	}
	return out, nil
}

// sshItemToEntry 把 vault 中的 SSH item 转为 PublicKeyEntry
//
// 字段映射（前端 SSH 表单字段 → entry）：
//
//	fields["public_key"]    → entry.PublicKey  (base64 整行)
//	fields["private_key"]   → 不放 entry（私钥永远不离开 GUI 进程）
//	fields["username"] | fields["host"] → 拼到 Comment
//	payload.ID              → entry.ItemID
//	fingerprint 现场算（从 public_key 解出 ssh.PublicKey）
//
// 返回 ok = false：
//   - 没有 public_key 字段 / 字段值为空
//   - public_key 解析失败（格式错）
//
// 失败情况都 log warn 然后跳过，不算致命 —— vault 里可能有「只有私钥
// 没有公钥」的旧条目，对这种条目无法暴露给 agent，但不影响其它条目。
func sshItemToEntry(p *ItemPayload, logger *slog.Logger) (sshagentproto.PublicKeyEntry, bool) {
	if p == nil {
		return sshagentproto.PublicKeyEntry{}, false
	}

	// 取公钥字段 —— 兼容两种存储格式：
	//   1. fields["public_key"]：完整 authorized_keys 一行
	//   2. fields["private_key"]：仅私钥时从私钥推导公钥（fallback）
	pubLine, _ := p.Fields["public_key"].(string)
	pubLine = strings.TrimSpace(pubLine)

	if pubLine == "" {
		// fallback：从 private_key 推导公钥
		privPEM, _ := p.Fields["private_key"].(string)
		privPEM = strings.TrimSpace(privPEM)
		if privPEM == "" {
			logger.Warn("ssh item missing both public_key and private_key, skipping",
				"id", p.ID, "name", p.Name)
			return sshagentproto.PublicKeyEntry{}, false
		}
		// 解析私钥（可能带 passphrase）
		passphrase, _ := p.Fields["passphrase"].(string)
		signer, err := parsePrivateKeySigner([]byte(privPEM), passphrase)
		if err != nil {
			logger.Warn("ssh item private_key parse failed, skipping",
				"id", p.ID, "name", p.Name, "err", err)
			return sshagentproto.PublicKeyEntry{}, false
		}
		// 用 PublicKey() 的 OpenSSH 格式输出
		pub := signer.PublicKey()
		comment := composeComment(p)
		pubLine = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))) + " " + comment
	}

	// 解析 public key 一行
	pubKey, comment, _, _, err := ssh.ParseAuthorizedKey([]byte(pubLine))
	if err != nil {
		logger.Warn("ssh item public_key parse failed, skipping",
			"id", p.ID, "name", p.Name, "err", err)
		return sshagentproto.PublicKeyEntry{}, false
	}

	// 如果 comment 为空（用户可能没填），用 item name 兜底让 GUI 端能看到
	if comment == "" {
		comment = composeComment(p)
	}

	fingerprint := ssh.FingerprintSHA256(pubKey)

	// PublicKey 字段我们存 entry.PublicKey 时用 base64(整行原始字节)
	// 让 agent 那边可以直接 base64 decode + ParseAuthorizedKey 复原
	encoded := b64StdEncodingForGUI.EncodeToString([]byte(pubLine))

	return sshagentproto.PublicKeyEntry{
		Fingerprint:    fingerprint,
		PublicKey:      encoded,
		Comment:        comment,
		ItemID:         p.ID,
		RequireConfirm: true, // MVP 阶段默认每个 key 都要确认（v3 阶段开放配置）
	}, true
}

// composeComment 由 item metadata 组合出展示用的 comment
//
// 优先级：username@host → username → item name → "zpass"
//
// SSH 公钥的 comment 主要用于 List 显示和审计日志，没有协议语义；
// 给用户看到熟悉的标识就行。
func composeComment(p *ItemPayload) string {
	username, _ := p.Fields["username"].(string)
	host, _ := p.Fields["host"].(string)
	username = strings.TrimSpace(username)
	host = strings.TrimSpace(host)

	switch {
	case username != "" && host != "":
		return username + "@" + host
	case username != "":
		return username
	case strings.TrimSpace(p.Name) != "":
		return strings.TrimSpace(p.Name)
	default:
		return "zpass"
	}
}

// parsePrivateKeySigner 解析 OpenSSH 格式私钥为 ssh.Signer
//
// passphrase 为空时调 ssh.ParsePrivateKey，否则调
// ssh.ParsePrivateKeyWithPassphrase。
func parsePrivateKeySigner(pem []byte, passphrase string) (ssh.Signer, error) {
	if passphrase == "" {
		return ssh.ParsePrivateKey(pem)
	}
	return ssh.ParsePrivateKeyWithPassphrase(pem, []byte(passphrase))
}

// ---------------------------------------------------------------------------
// 签名请求处理 —— 由 controlListener 在收到 SignRequest 时调用
// ---------------------------------------------------------------------------

// HandleSignRequest 处理来自 agent 的签名请求（向后兼容入口）
//
// 该方法保留原始签名（不带 clientExeHash）。实际调用请优先使用
// HandleSignRequestExt 以让 trust cache 能用正确的 key。仅为了带入口 +
// 单测 mock 后向兼容保留。
func (s *SshAgentService) HandleSignRequest(
	ctx context.Context,
	fingerprint string,
	data []byte,
	flags uint32,
	clientPID int32,
	clientExe string,
) (signature []byte, format string, err error) {
	return s.handleSignRequestImpl(ctx, fingerprint, data, flags, clientPID, clientExe, "")
}

// HandleSignRequestExt 是 HandleSignRequest 的扩展版，额外接受 clientExeHash
//
// 由 sshagentconn.handleSignRequest 传入 envelope.ClientExeHash，让 trust cache
// 能用「(exeHash, itemID)」作为准确的 key。
func (s *SshAgentService) HandleSignRequestExt(
	ctx context.Context,
	fingerprint string,
	data []byte,
	flags uint32,
	clientPID int32,
	clientExe string,
	clientExeHash string,
) (signature []byte, format string, err error) {
	return s.handleSignRequestImpl(ctx, fingerprint, data, flags, clientPID, clientExe, clientExeHash)
}

// handleSignRequestImpl 完整的签名处理逻辑
//
// 流程：
//  1. 校验 vault 解锁
//  2. fingerprint → (itemID, itemName)
//  3. 请求用户确认（trust cache 命中跳过 / miss 则弹窗）
//  4. 批准 → 取私钥 → 签名
//  5. 所有路径都写一条审计日志
//
// 安全注意：
//   - 私钥 PEM 字节在解密后短暂存在内存，返回后由 GC 处理
//   - data 原文 / 私钥内容 / 签名结果都不进审计日志
//   - audit 在所有路径都调（起始 / 失败 / 成功），避免“部分路径丢记录”
func (s *SshAgentService) handleSignRequestImpl(
	ctx context.Context,
	fingerprint string,
	data []byte,
	flags uint32,
	clientPID int32,
	clientExe string,
	clientExeHash string,
) (signature []byte, format string, err error) {
	recordAudit := func(itemID, itemName, outcome string, approved bool) {
		s.recordAuditEntry(AuditEntry{
			ItemID:      itemID,
			ItemName:    itemName,
			Fingerprint: fingerprint,
			ClientExe:   clientExe,
			ClientPID:   clientPID,
			Outcome:     outcome,
			Approved:    approved,
		})
	}

	// 1. vault 解锁
	if !s.vault.IsUnlocked() {
		recordAudit("", "", "vault-locked", false)
		return nil, "", errors.New("vault is locked")
	}

	// 2. 查找 item
	itemID, itemName, err := s.findItemByFingerprintWithName(fingerprint)
	if err != nil {
		recordAudit("", "", "key-not-found", false)
		return nil, "", err
	}

	// 3. 用户确认
	approvalReq := &approvalRequest{
		Fingerprint:   fingerprint,
		ItemID:        itemID,
		ItemName:      itemName,
		ClientPID:     clientPID,
		ClientExe:     clientExe,
		ClientExeHash: clientExeHash,
	}
	approved, err := s.approvals.requestApproval(ctx, approvalReq)
	if err != nil {
		recordAudit(itemID, itemName, "error: "+err.Error(), false)
		return nil, "", err
	}
	if !approved {
		recordAudit(itemID, itemName, "declined", false)
		return nil, "", errors.New("user declined sign request")
	}

	// 4. 取私钥 + 签名
	payload, err := s.vault.GetItem(itemID)
	if err != nil {
		recordAudit(itemID, itemName, "error: get item", false)
		return nil, "", fmt.Errorf("get item: %w", err)
	}
	if payload == nil {
		recordAudit(itemID, itemName, "key-not-found", false)
		return nil, "", errors.New("key not found in vault")
	}

	privPEM, _ := payload.Fields["private_key"].(string)
	if strings.TrimSpace(privPEM) == "" {
		recordAudit(itemID, itemName, "error: no private_key", false)
		return nil, "", errors.New("vault item has no private_key field")
	}
	passphrase, _ := payload.Fields["passphrase"].(string)

	signer, err := parsePrivateKeySigner([]byte(privPEM), passphrase)
	if err != nil {
		recordAudit(itemID, itemName, "error: parse key", false)
		return nil, "", fmt.Errorf("parse private key: %w", err)
	}

	sig, sigFormat, err := signWithFlags(signer, data, flags)
	if err != nil {
		recordAudit(itemID, itemName, "error: sign", false)
		return nil, "", fmt.Errorf("sign: %w", err)
	}

	recordAudit(itemID, itemName, "approved", true)
	s.logger.Info("sign request handled",
		"fingerprint", fingerprint,
		"itemID", itemID,
		"format", sigFormat,
		"clientPid", clientPID,
		"clientExe", clientExe,
	)
	return sig, sigFormat, nil
}

// findItemByFingerprintWithName 以 fingerprint 查 vault 拿 (itemID, itemName)
//
// itemName 给审计日志 + 确认窗展示用。实现同 findItemByFingerprint。
func (s *SshAgentService) findItemByFingerprintWithName(fingerprint string) (string, string, error) {
	summaries, err := s.vault.ListItems()
	if err != nil {
		return "", "", fmt.Errorf("list vault: %w", err)
	}

	for _, sum := range summaries {
		if sum.Type != ItemTypeSSH {
			continue
		}
		payload, err := s.vault.GetItem(sum.ID)
		if err != nil || payload == nil {
			continue
		}
		entry, ok := sshItemToEntry(payload, s.logger)
		if !ok {
			continue
		}
		if entry.Fingerprint == fingerprint {
			return payload.ID, payload.Name, nil
		}
	}
	return "", "", errors.New("no vault item with matching fingerprint")
}

// findItemByFingerprint 保留作为向后兼容接口（其它调用位点）
func (s *SshAgentService) findItemByFingerprint(fingerprint string) (string, error) {
	itemID, _, err := s.findItemByFingerprintWithName(fingerprint)
	return itemID, err
}

// signWithFlags 根据 flags 选择算法签名
//
// flags 与 golang.org/x/crypto/ssh/agent.SignatureFlags 对应：
//   - 0                       → 默认（ed25519/ECDSA 按算法；RSA → SHA-1）
//   - 2 (SignatureFlagRsaSha256) → 强制 rsa-sha2-256
//   - 4 (SignatureFlagRsaSha512) → 强制 rsa-sha2-512
//
// 实现：如果 signer 实现 AlgorithmSigner 则用 SignWithAlgorithm，否则
// 退回 ssh.Signer.Sign（不能选算法）。
func signWithFlags(signer ssh.Signer, data []byte, flags uint32) ([]byte, string, error) {
	const (
		flagRSASHA256 = 2
		flagRSASHA512 = 4
	)

	if as, ok := signer.(ssh.AlgorithmSigner); ok && flags != 0 {
		var algo string
		switch flags {
		case flagRSASHA256:
			algo = ssh.SigAlgoRSASHA2256
		case flagRSASHA512:
			algo = ssh.SigAlgoRSASHA2512
		default:
			algo = "" // 不识别的 flag → 走默认
		}
		if algo != "" {
			sig, err := as.SignWithAlgorithm(nil, data, algo)
			if err != nil {
				return nil, "", err
			}
			return sig.Blob, sig.Format, nil
		}
	}

	sig, err := signer.Sign(nil, data)
	if err != nil {
		return nil, "", err
	}
	return sig.Blob, sig.Format, nil
}

// pushVaultKeysInBackground 异步包装 PushVaultKeys，错误只 log
func (s *SshAgentService) pushVaultKeysInBackground() {
	if err := s.PushVaultKeys(); err != nil {
		s.logger.Warn("background vault keys push failed", "err", err)
	}
}

// ---------------------------------------------------------------------------
// 审计日志持久化
// ---------------------------------------------------------------------------

// recordAuditEntry 同时写入内存 ring buffer + （如 vault 解锁）加密插入 DB
//
// 调用者：handleSignRequestImpl 的 recordAudit closure。并并路径：
//  1. 全量走 ring buffer（仅内存，重启后丢失）
//  2. 额外在 vault 解锁时同步写 vault_audit 表（跨重启保留）
//
// vault 锁定时跳过 DB 写入 —— 内存 buffer 仍有记录，下次解锁时由
// flushPendingAuditToDB 推送补补上不需要。原因是：内存 buffer 在锁定期间
// 个别记录可能被赶出（到达 256 条后覆盖后早期记录）但远足跹大多数场景。
//
// DB 写入失败 → log 但不错，年不误导同步付 —— ring buffer 是「仅内存」的
// 奇考源，最多丢一次越励。
func (s *SshAgentService) recordAuditEntry(entry AuditEntry) {
	s.auditLog.append(entry)

	// vault 解锁时同步入库
	if s.vault == nil || !s.vault.IsUnlocked() {
		return
	}
	payload, err := jsonMarshalAuditEntry(entry)
	if err != nil {
		s.logger.Warn("marshal audit entry failed", "err", err)
		return
	}
	if _, err := s.vault.InsertAuditEntry(payload); err != nil {
		s.logger.Warn("persist audit entry failed", "err", err)
	}
}

// flushPendingAuditToDB 在 vault 解锁后把内存中「上次锁定期间」产生的 audit
// entry 批量入库
//
// 策略：
//   - vault 解锁后先 ListAuditEntries(latest 64) 看 DB 里最新几条的 timestamp
//   - 内存 buffer 跳过那些时间戳 « 这个阈值」的条目（以为已经入库），补上
//     「时间戳 > 阈值」的部分
//
// 这套逻辑不需要「跨重启补上」—— 重启后内存 ring buffer 是空的，本函数
// 会看到「内存所有条目都« 阈值」，什么也不变化，是正确的。跨事件锁定
// 期间（不重启进程）产生的条目才当被补   上。
func (s *SshAgentService) flushPendingAuditToDB() {
	if s.vault == nil || !s.vault.IsUnlocked() {
		return
	}

	// 看 DB 里最新一条的 createdAt 作为阈值
	latest, err := s.vault.ListAuditEntries(1)
	if err != nil {
		s.logger.Warn("flush: list audit failed", "err", err)
		return
	}
	var threshold int64
	if len(latest) > 0 {
		threshold = latest[0].CreatedAt
	}

	// 这必须选拿「时间戳 > 阈值」的部分 + 按时间顺序入库
	snap := s.auditLog.snapshot()
	// snapshot 是「最新在前」，反转过来才是「古老在前」，保证入库 id 顺序
	// 与时间顺序一致
	pending := make([]AuditEntry, 0, len(snap))
	for i := len(snap) - 1; i >= 0; i-- {
		if snap[i].TimestampMs > threshold {
			pending = append(pending, snap[i])
		}
	}

	if len(pending) == 0 {
		return
	}

	inserted := 0
	for _, e := range pending {
		payload, err := jsonMarshalAuditEntry(e)
		if err != nil {
			s.logger.Warn("flush: marshal failed", "err", err)
			continue
		}
		if _, err := s.vault.InsertAuditEntry(payload); err != nil {
			s.logger.Warn("flush: insert failed", "err", err)
			continue
		}
		inserted++
	}

	if inserted > 0 {
		s.logger.Info("flushed pending audit entries", "count", inserted)
		// 顺手 prune 超出保留阈值的老记录
		if err := s.vault.PruneAuditEntries(auditLogPersistKeep); err != nil {
			s.logger.Warn("prune audit failed", "err", err)
		}
	}
}

// jsonMarshalAuditEntry 包装 encoding/json.Marshal
func jsonMarshalAuditEntry(e AuditEntry) ([]byte, error) {
	return json.Marshal(e)
}

// ---------------------------------------------------------------------------
// 前端可调用 —— 确认窗 / 信任 cache / 审计日志
// ---------------------------------------------------------------------------

// ApproveSignRequest 用户点「批准」时前端调本方法
//
// approvalID 由「ssh-agent:approval-request」事件携带。trustDurationSeconds
// = 0 表「仅本次」；> 0 表「信任 N 秒」。
//
// 不存在的 approvalID / 已超时的 approvalID 返回 error 让前端提示「该请
// 求已过期」。
func (s *SshAgentService) ApproveSignRequest(approvalID string, options ApprovalDecisionOptions) error {
	duration := time.Duration(options.TrustDurationSeconds) * time.Second
	return s.approvals.approve(approvalID, duration)
}

// DeclineSignRequest 用户点「拒绝」时前端调本方法
//
// 语义与 ApproveSignRequest 一致；ID 失效返错。拒绝不能携带信任选项——
// 拒绝 → 仅拒绝本次，不会反向添加「信任」。
func (s *SshAgentService) DeclineSignRequest(approvalID string) error {
	return s.approvals.decline(approvalID)
}

// ListPendingApprovals 返回当前所有在等的 approval 请求
//
// 前端确认窗启动后可以调本方法充填「启动前错过的 event」——避免起动
// 顺序问题导致丢 approval。
func (s *SshAgentService) ListPendingApprovals() []ApprovalRequest {
	return s.approvals.list()
}

// ClearTrustCache 清空所有信任 cache
//
// 前端设置页「清空信任记录」按钮调。使用场景：用户误点了「信任 8 小
// 时」后后悔；或发现某个怎么也报身份验证到期的进程主动剖查。
func (s *SshAgentService) ClearTrustCache() error {
	s.approvals.clearTrust()
	s.logger.Info("trust cache cleared by user")
	return nil
}

// GetAuditLog 返回当前审计日志快照（最新的在前）
//
// 合并两个来源：
//   - 内存 ring buffer（本会话产生的记录，可能含尚未入库的锁定期间记录）
//   - DB 中历史记录（跨重启保留，需 vault 解锁才能读）
//
// 去重：以 (TimestampMs + Fingerprint) 作为 key，同一条只呈现一次。内存
// 优先（这样刚刚产生但还未入库的记录仅以「状态最新」身份呈现）。
//
// vault 锁定时仅返 ring buffer。调用者不需要处理 ErrVaultLocked。
func (s *SshAgentService) GetAuditLog() []AuditEntry {
	inMem := s.auditLog.snapshot()

	if s.vault == nil || !s.vault.IsUnlocked() {
		return inMem
	}

	dbRows, err := s.vault.ListAuditEntries(auditLogPersistKeep)
	if err != nil {
		s.logger.Warn("GetAuditLog: list DB audit failed", "err", err)
		return inMem
	}

	// 建去重 index
	seen := make(map[string]struct{}, len(inMem))
	dedupKey := func(e AuditEntry) string {
		return fmt.Sprintf("%d|%s", e.TimestampMs, e.Fingerprint)
	}

	out := make([]AuditEntry, 0, len(inMem)+len(dbRows))
	for _, e := range inMem {
		seen[dedupKey(e)] = struct{}{}
		out = append(out, e)
	}

	for _, r := range dbRows {
		var e AuditEntry
		if err := json.Unmarshal(r.Plaintext, &e); err != nil {
			s.logger.Warn("GetAuditLog: unmarshal DB entry failed", "id", r.ID, "err", err)
			continue
		}
		if _, dup := seen[dedupKey(e)]; dup {
			continue
		}
		out = append(out, e)
	}

	// 按 TimestampMs DESC 全部重排 —— 合并后顶部仍应是「最新的」
	sortAuditByTimeDesc(out)
	return out
}

// ClearAuditLog 清空审计日志（内存 + DB）
func (s *SshAgentService) ClearAuditLog() error {
	s.auditLog.clear()
	if s.vault != nil {
		if err := s.vault.DeleteAllAuditEntries(); err != nil {
			s.logger.Warn("clear DB audit failed", "err", err)
			return err
		}
	}
	s.logger.Info("audit log cleared by user")
	return nil
}

// sortAuditByTimeDesc 原地按 TimestampMs 降序排 entries
//
// 不引入 sort 包仅为一处调用：手写插入排序够用（entries 总量 < 1500）。
func sortAuditByTimeDesc(entries []AuditEntry) {
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && entries[j-1].TimestampMs < entries[j].TimestampMs; j-- {
			entries[j-1], entries[j] = entries[j], entries[j-1]
		}
	}
}

// LocateAgentBinary 返回当前能定位到的 zpass-agent binary 路径
//
// 供前端设置页「调试信息」面板展示。定位失败时返回错误让 UI 提示「请
// 检查安装」。本方法不会实际启动 agent，只定位。
func (s *SshAgentService) LocateAgentBinary() (string, error) {
	return locateAgentBinary()
}
