// zpass-agent 守护进程 —— 内存状态与签名请求路由
//
// ---------------------------------------------------------------------------
// 本文件职责
//
// 维护两块内存数据：
//
//  1. **公钥索引**（publicKeys）：fingerprint → entry，由 GUI 通过 PushKeys
//     消息推送。SSH agent 的 List 操作直接读此 map，零延迟。
//
//  2. **签名请求注册表**（pending）：reqID → 等待 GUI 回复的 channel。
//     SSH agent 收到 Sign 调用时把请求放进来，转发给 GUI，调用方阻塞
//     在 channel 上等结果（带 ctx timeout）。GUI 发回 SignReply 时按
//     reqID 找到 channel，把 SignResult 投递进去唤醒调用方。
//
// 设计要点：
//   - 所有状态在内存，进程崩溃 / 重启即丢失，符合「daemon 是无状态适配器」
//     的角色定位。持久化（审计日志等）是 GUI 端的责任。
//   - 锁粒度：一把读写锁（mu）保护两块 map + guiUnlocked 状态。性能不
//     是瓶颈（SSH 签名 < 1 次/秒级别），心智简单优先。
//   - guiConn 不在本结构内 —— 由 controlClient 持有，state 只关心「逻辑
//     状态」（是否解锁、有哪些 key），不关心物理连接细节。
//
// ---------------------------------------------------------------------------
// 安全约束
//
//   - PublicKey entry 中**绝对不包含**任何私钥 / vault payload 字段
//     （由 sshagentproto.PublicKeyEntry 类型保证，但本文件再加一道注释
//     提醒：将来即便扩字段也只能扩公开信息）。
//   - guiUnlocked = false 时 Sign 一律返回错误，不转发给 GUI；目的是
//     避免 vault 锁定期间每次签名都骚扰 GUI 弹窗。
//   - pending map 的 reqID 单调递增，重启归零（同一连接寿命内 uint64
//     绝无碰撞担忧）。

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zerx-lab/zpass/zpass-desktop/internal/sshagentproto"
)

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

// ErrVaultLocked agent 看到 GUI 处于锁定态时返回。SSH agent 层会把它
// 翻译为 SSH_AGENT_FAILURE 给客户端。
var ErrVaultLocked = errors.New("zpass-agent: vault is locked")

// ErrGUIUnavailable GUI 连接断开或从未连上。
//
// MVP 阶段 agent 不主动拉起 GUI（留给后续 dbus / NSWorkspace / ShellExecute
// 实现），先返回错误让客户端看到「ZPass 未启动」。
var ErrGUIUnavailable = errors.New("zpass-agent: ZPass GUI is not running")

// ErrKeyNotFound 客户端请求的 fingerprint 不在公钥索引中。可能是 GUI
// 推送后又删除了该 key，但客户端缓存了旧 fingerprint。
var ErrKeyNotFound = errors.New("zpass-agent: requested key not in agent")

// ErrSignTimeout GUI 在 SignDeadline 内没有回复 sign_reply。
//
// 典型场景：用户离开机器 / GUI 卡死 / 用户故意不响应确认窗。
// 超时上限不能太短（用户读弹窗 + 点确认要时间）也不能太长（让 ssh /
// git 命令永久卡住）。默认 60 秒，配合「无操作 15 秒默认拒绝」的 GUI
// 端策略，正常路径下永远在 ≤ 30 秒内有结果。
var ErrSignTimeout = errors.New("zpass-agent: sign request timed out")

// ---------------------------------------------------------------------------
// SignResult —— GUI 回复 SignReply 后投递到 pending channel 的结果
// ---------------------------------------------------------------------------

// SignResult 描述一次签名请求的最终结果
//
// 用结构而非两个 channel（一个传成功一个传失败）：channel 多了会让
// select 复杂度爆炸，且「成功 vs 失败」是互斥的，单一 result 类型更直观。
//
// 字段约定：
//   - Err 非 nil 时 Signature / SignatureFormat 必须为空（调用方不要读）
//   - Err 为 nil 时 Signature 必须非空且 SignatureFormat 必须非空
//
// 校验由生产方（receiveSignReply）做，消费方（SSH agent Sign 方法）
// 可以直接信任。
type SignResult struct {
	Signature       []byte
	SignatureFormat string
	Err             error
}

// ---------------------------------------------------------------------------
// AgentState
// ---------------------------------------------------------------------------

// AgentState 是 zpass-agent 进程的所有内存状态
//
// 单例存在，由 main 创建并注入 SSH agent 实现 + 控制通道处理器。
// 不暴露 globals —— 即便 daemon 进程只有一份状态，靠依赖注入仍然让
// 单元测试能创建多份独立 state 跑并行测试。
type AgentState struct {
	// mu 保护下面所有可变字段
	//
	// 读多写少：List 是热路径（每次 ssh 启动都跑），PushKeys / State /
	// SignRequest 注册都是冷路径。RWMutex 合适。
	mu sync.RWMutex

	// publicKeys 公钥索引，主键 fingerprint
	//
	// 初始 nil（空 map）—— agent 启动后等 GUI 推送才有数据。SSH agent
	// 在 GUI 未推送时返回空列表（List 合法），符合「ssh-add -L 看到空」
	// 等价于「agent 起来但没载入 key」的语义。
	publicKeys map[string]sshagentproto.PublicKeyEntry

	// guiUnlocked GUI 当前是否处于解锁状态
	//
	// false 时 Sign 返回 ErrVaultLocked。GUI 在解锁 / 锁定时主动发
	// OpState 同步给 agent。
	//
	// 初始 false —— agent 启动到 GUI 连上之前一律视为锁定。
	guiUnlocked bool

	// guiConnected 是否有 GUI 端处于已认证 + 已握手状态
	//
	// guiUnlocked 隐含要求 guiConnected，但反之不然（GUI 连上但 vault
	// 还没解锁）。两个 flag 分开方便日志区分「ZPass 没开」vs「ZPass 开了
	// 但 vault 锁着」。
	guiConnected bool

	// pending 等待 SignReply 的请求注册表
	//
	// key = reqID（agent 生成的单调序号），value = 投递结果的 channel。
	// 一个 reqID 一个 channel，避免广播浪费 + 简化匹配逻辑。
	//
	// channel buffered = 1：sender (receiveSignReply) 不会阻塞即使
	// receiver (Sign) 已经超时退出未读 —— 容错路径。
	pending map[uint64]chan SignResult

	// nextReqID 下一个分配的 reqID
	//
	// uint64 单调递增，零值是「未初始化」哨兵（reqID 从 1 起）。
	// 用 atomic 而非锁保护让 ssh agent Sign 路径不必抢 mu —— 它只是
	// 「拿一个号码再加锁注册」的两步，号码生成本身无依赖。
	nextReqID atomic.Uint64

	// signDeadline 单次 sign 请求等待 GUI 回复的最长时间
	//
	// 默认 60 秒（见 NewAgentState 的初始化）。可调（通过环境变量
	// ZPASS_AGENT_SIGN_TIMEOUT），主要给测试 / 调试用。
	signDeadline time.Duration

	// dispatchSignRequest 转发 SignRequest 到控制通道的回调
	//
	// 由 controlClient 注入 —— state 不直接持有连接，回调让 state 仅
	// 关心「逻辑发送」无需感知具体物理通道。控制通道断开时回调返回
	// 错误 ErrGUIUnavailable。
	//
	// 函数指针而非接口：单一 callback 不值得一个 interface，函数指针
	// 注入更简洁。
	dispatchSignRequest func(env *sshagentproto.Envelope) error

	// idle 进程活动跟踪（仅 socket activation 模式下启用）
	//
	// nil = 未启用（默认状态）。仅当 main 检测到 systemd activation 后才
	// 调 SetIdleTracker 注入一个 Enable 过的 tracker。RequestSign 路径在调
	// dispatch 前 Touch，让 idle 计时重置。
	idle *idleTracker

	// launcher 负责 GUI 按需拉起
	//
	// nil = 未注入（默认状态，与 MVP-2 行为一致：GUI 不在 → sign 失败）。
	// main 调 SetGUILauncher 后启用。RequestSign 在 dispatch 前发现 GUI
	// 未连接 → 调 launcher.Ensure() 拉起 GUI，然后等握手。
	launcher *guiLauncher
}

// SetIdleTracker 注入 idle 跟踪器
//
// main 在检测到 socket activation 后调。传 nil 可以解除。
//
// 未注入时 touchActivity 是 noop —— 调用点不需要检查存在性。
func (s *AgentState) SetIdleTracker(tracker *idleTracker) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.idle = tracker
}

// SetGUILauncher 注入 GUI 拉起器
func (s *AgentState) SetGUILauncher(launcher *guiLauncher) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.launcher = launcher
}

// waitForGUI 轮询等待 guiConnected = true（或 ctx 超时）
//
// 不用 condition variable：GUI 握手后 SetDispatcher 会在 mu 内设字段，
// 但没有 broadcast。不为「GUI 拉起」这种 30 秒难事件引入 sync.Cond。
//
// 100ms 轮询间隔 —— 与 GUI 启动时间（1-3 秒）相比足够快，同时足够低不
// 占 CPU。
func (s *AgentState) waitForGUI(ctx context.Context) bool {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		s.mu.RLock()
		connected := s.guiConnected && s.dispatchSignRequest != nil
		s.mu.RUnlock()
		if connected {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
}

// touchActivity 隐藏 nil 检查的 idle.Touch 包装
//
// 调用点：
//   - RequestSign 中 dispatch 前后都 Touch
//   - listener accept 成功后 Touch
//   - controlClient 握手成功后 Touch
func (s *AgentState) touchActivity() {
	s.mu.RLock()
	tracker := s.idle
	s.mu.RUnlock()
	if tracker != nil {
		tracker.Touch()
	}
}

// NewAgentState 创建并返回一个初始化好的 AgentState
//
// 调用方需要在合适时机（控制通道建立后）通过 SetDispatcher 注入转发
// 回调；在那之前 Sign 调用会一律返回 ErrGUIUnavailable。
func NewAgentState() *AgentState {
	s := &AgentState{
		publicKeys:   map[string]sshagentproto.PublicKeyEntry{},
		pending:      map[uint64]chan SignResult{},
		signDeadline: 60 * time.Second,
	}
	// reqID 从 1 起 —— 0 在 envelope ValidateForOp 中视为「未填」非法值
	s.nextReqID.Store(0)
	return s
}

// SetDispatcher 注入 SignRequest 转发回调
//
// 由 controlClient 在握手成功后调用一次。再次连接（GUI 重启）时也会
// 重新调一次覆盖。nil 表示当前没有可用 GUI。
//
// 用单独 setter 而非构造函数参数：state 在 controlClient 创建之前就
// 必须存在（SSH agent listener 需要 state 来 List 公钥），SetDispatcher
// 让循环依赖反转 —— state 先存在，controlClient 后注入回调。
func (s *AgentState) SetDispatcher(dispatch func(env *sshagentproto.Envelope) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dispatchSignRequest = dispatch
	s.guiConnected = dispatch != nil
	if dispatch == nil {
		// GUI 断开 —— 同时把 guiUnlocked 置 false（保守：宁可让 Sign
		// 拒绝也不要冒险在 GUI 不在时弹窗）+ 清空所有 pending
		// （让在等的 Sign 立即拿到 ErrGUIUnavailable 而非超时 60 秒）。
		s.guiUnlocked = false
		s.failAllPendingLocked(ErrGUIUnavailable)
	}
}

// ---------------------------------------------------------------------------
// 公钥索引管理
// ---------------------------------------------------------------------------

// ReplaceKeys 用 entries 整体替换内存公钥索引
//
// 由 OpPushKeys 处理器调用。语义为「全量替换」而非「增量同步」—— GUI
// 每次都推全集，避免增量协议的去重 / 排序问题。
//
// entries 来自网络反序列化，可能为 nil 或空切片，都视为「清空索引」
// （用户删完了所有 ssh key 或第一次解锁 vault 还没条目）。
//
// 不返回 error：参数已经过 ValidateForOp 校验，本函数只做内存操作不会失败。
func (s *AgentState) ReplaceKeys(entries []sshagentproto.PublicKeyEntry) {
	next := make(map[string]sshagentproto.PublicKeyEntry, len(entries))
	for _, e := range entries {
		next[e.Fingerprint] = e
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.publicKeys = next
}

// ListKeys 返回当前公钥索引的快照（按字典序）
//
// 用于 SSH agent 的 List 操作。返回值是「拷贝」而非内部 map 引用 ——
// 避免调用方持有引用后底层 map 被并发改写。
//
// 按 fingerprint 排序：让 List 输出在多次调用之间保持稳定顺序，方便
// `ssh-add -L` 的 diff 调试。SSH 协议本身不要求顺序，纯 UX 收益。
func (s *AgentState) ListKeys() []sshagentproto.PublicKeyEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]sshagentproto.PublicKeyEntry, 0, len(s.publicKeys))
	for _, e := range s.publicKeys {
		out = append(out, e)
	}
	// 不引入 sort 包仅为美观 —— 这里其实可以省。但稳定排序对测试 / 调试
	// 实用，下面用最简单的插入排序避免引入 sort 包就够了 (n < 100)。
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1].Fingerprint > out[j].Fingerprint; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

// LookupKey 按 fingerprint 查找单条 entry
//
// found = false 时 entry 是零值。
//
// SSH agent 的 Sign 路径会先 Lookup 确认 fingerprint 仍在索引中 ——
// 之间可能有 PushKeys 把它移除，此时返回 ErrKeyNotFound 给客户端。
func (s *AgentState) LookupKey(fingerprint string) (entry sshagentproto.PublicKeyEntry, found bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entry, found = s.publicKeys[fingerprint]
	return
}

// ---------------------------------------------------------------------------
// GUI 解锁状态
// ---------------------------------------------------------------------------

// SetUnlocked 更新 GUI 解锁状态
//
// 由 OpState 处理器调用。变化为 false 时同时清空所有 pending（让等待
// 中的 Sign 立即拿到 ErrVaultLocked 而非超时）。
//
// 同时要求 guiConnected = true：GUI 推 State 前必然已握手通过 hello，
// 也即 dispatchSignRequest 已注入。这个不变量由 controlClient 维护。
func (s *AgentState) SetUnlocked(unlocked bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.guiUnlocked
	s.guiUnlocked = unlocked
	if prev && !unlocked {
		s.failAllPendingLocked(ErrVaultLocked)
	}
}

// IsUnlocked 查询当前 GUI 解锁状态
func (s *AgentState) IsUnlocked() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.guiUnlocked
}

// IsGUIConnected 查询 GUI 是否处于已握手状态
func (s *AgentState) IsGUIConnected() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.guiConnected
}

// ---------------------------------------------------------------------------
// 签名请求路由
// ---------------------------------------------------------------------------

// RequestSign 把签名请求转发给 GUI 并等待结果
//
// 流程：
//  1. 校验 GUI 已连上且 vault 已解锁 —— 否则立即返回错误
//  2. 校验 fingerprint 仍在索引中
//  3. 分配 reqID + 注册 pending channel
//  4. 通过 dispatchSignRequest 发出 SignRequest envelope
//  5. select 等待 (channel 收到 result | ctx 超时 | signDeadline 超时)
//  6. 清理 pending 注册（无论成功失败 / 包括超时分支）
//
// ctx 由调用方控制 —— SSH agent Sign 方法可能也带 ctx（虽然 ssh/agent
// 包当前的 Agent 接口不带 ctx，预留给未来）。signDeadline 是「兜底」
// 防止 GUI 卡死无响应让 ssh 永远阻塞。
//
// 返回的 SignResult.Err 已经是「面向上层友好」的错误类型，调用方可
// 直接返回给 ssh/agent 包；ssh/agent 会自动翻译为 SSH_AGENT_FAILURE。
func (s *AgentState) RequestSign(
	ctx context.Context,
	fingerprint string,
	data []byte,
	flags uint32,
	clientPID int32,
	clientExe string,
	clientExeHash string,
) (SignResult, error) {
	// 早期校验 —— 不持锁
	if fingerprint == "" {
		return SignResult{}, errors.New("zpass-agent: empty fingerprint")
	}
	if len(data) == 0 {
		return SignResult{}, errors.New("zpass-agent: empty data to sign")
	}

	// 获取状态快照 + 注册 pending —— 持写锁
	s.mu.Lock()

	if !s.guiConnected || s.dispatchSignRequest == nil {
		// GUI 未连接 —— 如果有 launcher 尝试拉起 + 等握手
		launcher := s.launcher
		s.mu.Unlock()

		if launcher == nil {
			return SignResult{}, ErrGUIUnavailable
		}
		if err := launcher.Ensure(); err != nil {
			return SignResult{}, fmt.Errorf("%w: %v", ErrGUIUnavailable, err)
		}

		// 等 GUI 握手 —— 最多 30 秒（与 signDeadline=60s 留出有意义的余地
		// 让握手后用户还能看确认窗 + 点按钮）
		waitCtx, waitCancel := context.WithTimeout(ctx, 30*time.Second)
		if !s.waitForGUI(waitCtx) {
			waitCancel()
			return SignResult{}, fmt.Errorf("%w: GUI did not connect within 30s", ErrGUIUnavailable)
		}
		waitCancel()

		// 重新进入写锁 —— 此时 GUI 应当已握手并 SetDispatcher
		s.mu.Lock()
		if !s.guiConnected || s.dispatchSignRequest == nil {
			s.mu.Unlock()
			return SignResult{}, ErrGUIUnavailable
		}
	}
	if !s.guiUnlocked {
		s.mu.Unlock()
		return SignResult{}, ErrVaultLocked
	}
	if _, ok := s.publicKeys[fingerprint]; !ok {
		s.mu.Unlock()
		return SignResult{}, ErrKeyNotFound
	}

	reqID := s.nextReqID.Add(1)
	resultCh := make(chan SignResult, 1)
	s.pending[reqID] = resultCh
	dispatch := s.dispatchSignRequest
	deadline := s.signDeadline
	tracker := s.idle
	s.mu.Unlock()

	// Touch idle tracker —— 「拿到一个要签名的请求」是最典型的「进程还有人
	// 用」信号。在这里 Touch 而不是 Sign 返回后：避免「dispatch 马上失败    + idle
	// timeout 刚好到」的双重不幸。
	if tracker != nil {
		tracker.Touch()
	}

	// 构造转发 envelope —— 不持锁
	env := &sshagentproto.Envelope{
		Op:            sshagentproto.OpSignRequest,
		ReqID:         reqID,
		Fingerprint:   fingerprint,
		Data:          base64Encode(data),
		Flags:         flags,
		ClientPID:     clientPID,
		ClientExe:     clientExe,
		ClientExeHash: clientExeHash,
	}

	// dispatch 失败 —— 立即清理注册并返回错误
	if err := dispatch(env); err != nil {
		s.removePending(reqID)
		// 包装一层让上层能区分「转发失败」vs「GUI 拒绝签名」
		return SignResult{}, fmt.Errorf("dispatch sign request: %w", err)
	}

	// 等待结果 —— 三路 select
	timer := time.NewTimer(deadline)
	defer timer.Stop()

	select {
	case result := <-resultCh:
		s.removePending(reqID) // 清理注册表
		return result, nil
	case <-timer.C:
		s.removePending(reqID)
		return SignResult{}, ErrSignTimeout
	case <-ctx.Done():
		s.removePending(reqID)
		return SignResult{}, ctx.Err()
	}
}

// DeliverSignReply 把 GUI 回复的 SignReply 投递到对应 pending channel
//
// 由控制通道处理器在收到 OpSignReply envelope 后调用。reqID 找不到
// pending（已超时被 removePending 清掉 / 不存在）时静默丢弃 —— 这是
// 正常的并发路径，不应当作错误。
//
// channel 容量 = 1，send 不阻塞即使 receiver 已离开（buffered 留作
// 容错）；这让本函数永远快速返回，不会卡控制通道处理 goroutine。
func (s *AgentState) DeliverSignReply(reqID uint64, result SignResult) {
	s.mu.RLock()
	ch, ok := s.pending[reqID]
	s.mu.RUnlock()
	if !ok {
		// 已超时或不存在：debug log 但不报错
		return
	}
	// 非阻塞 send —— select default 兜底防止 receiver 已退出导致 send 阻塞
	select {
	case ch <- result:
	default:
		// channel 缓冲已满（理论上不会，因为 cap=1 且每个 reqID 只投一次），
		// 静默丢弃
	}
}

// removePending 从注册表中清除 reqID（goroutine 安全）
//
// 调用时机：
//   - RequestSign 拿到 result / 超时 / ctx 取消三个分支
//   - failAllPendingLocked 批量清理
//
// 重复调用安全（map delete 不存在的 key 是 no-op）。
func (s *AgentState) removePending(reqID uint64) {
	s.mu.Lock()
	delete(s.pending, reqID)
	s.mu.Unlock()
}

// failAllPendingLocked 让所有 pending 请求立即收到 err 错误
//
// **调用方必须持有 s.mu 写锁**。
//
// 用途：vault 锁定 / GUI 断开时通知所有 in-flight 签名请求立即失败，
// 避免它们空等 60 秒超时。让 ssh 客户端尽快看到「authentication failed」
// 重新走密码 / 其它方法。
//
// 实现注意：不能在这里 close(ch) —— RequestSign 还在 select 它，close
// 会让它读到零值 SignResult{Err: nil}，被误认为「签名成功但内容为空」。
// 改为 send 一份 SignResult{Err: err}。
func (s *AgentState) failAllPendingLocked(err error) {
	for reqID, ch := range s.pending {
		select {
		case ch <- SignResult{Err: err}:
		default:
		}
		delete(s.pending, reqID)
	}
}

// ---------------------------------------------------------------------------
// base64 辅助 —— 内部使用，避免到处 import encoding/base64
// ---------------------------------------------------------------------------

// base64Encode 把字节切片编码为 base64 字符串（标准编码，带 padding）
//
// 包装函数只是为了行数对齐 / 减少 import 噪音，没别的诡计。
func base64Encode(b []byte) string {
	return b64StdEncoding.EncodeToString(b)
}
