// SSH agent 服务 —— 用户确认窗 + 信任 cache
//
// ---------------------------------------------------------------------------
// 安全模型
//
// 每次签名请求都默认弹用户确认窗，让用户看到：
//   - 哪把 key（item name + fingerprint 末尾 8 字符）
//   - 哪个进程（exe 路径 + PID + exe SHA256）
//   - 选择：批准一次 / N 分钟内信任此 exe / 拒绝
//
// 信任 cache 的 key = (clientExeHash, vault item.id)：
//   - 用 exe SHA256 而非 PID（PID 复用风险大）
//   - 不同 key 各自独立信任（生产 key 应严格，开发 key 可宽松）
//   - vault lock / 用户主动 revoke / agent 重启 时全清
//
// 关键 UX 兜底：
//   - 确认窗 30 秒无操作 → 自动拒绝
//   - 用户拒绝后立即 disable 信任 cache（防止误点确认）
//   - GUI 进程退出 / 重启 → cache 清零（in-memory）
//
// ---------------------------------------------------------------------------
// 与前端的协作
//
// SshAgentService 收到 SignRequest（来自 sshagentconn.go 的 handleSignRequest）
// 后：
//
//  1. 检查 trust cache —— 命中则跳过弹窗直接签
//  2. miss → 创建 pendingApproval，分配 approvalID
//  3. 把 approval 元数据通过 Wails event 推给前端（"ssh-agent:approval-request"）
//  4. 阻塞等待前端调 ApproveSignRequest / DeclineSignRequest
//  5. 拿到决定 → 更新 trust cache（如果用户勾选了"信任 N 分钟"）→ 继续签 / 拒绝
//
// 前端弹独立窗口 / Modal 展示 approval，用户操作后通过 Wails 调
// SshAgentService.ApproveSignRequest(approvalID, options) 或
// SshAgentService.DeclineSignRequest(approvalID) 回传决定。
//
// 多 approval 并发：每个有独立 approvalID + channel，互不影响。

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// approvalDefaultDeadline 用户在确认窗内必须做出选择的最长时间
//
// 超时 = 自动拒绝（fail-safe 默认）。30 秒涵盖「读弹窗 + 思考 + 点」的
// 正常时间，太短会让用户来不及反应，太长会让 ssh / git 看起来卡死。
const approvalDefaultDeadline = 30 * time.Second

// approvalIDByteLength 每次 approval 的随机 ID 字节数
//
// 16 字节 = 128 bit = hex 32 字符，避免可预测让前端误把别人的 approval
// 当自己的确认（理论上前端拿到的 approvalID 是 GUI 本端生成的，不存在
// 跨进程伪造风险；但随机化让 log 看起来更干净）。
const approvalIDByteLength = 16

// trustCacheMaxAge 信任 cache 的最长 TTL 兜底
//
// 用户最长可以选择 8 小时；超过此值的请求会被强制截断。这是「无论用户
// 怎么操作，单次会话不会无限信任」的最终保险。
const trustCacheMaxAge = 8 * time.Hour

// ---------------------------------------------------------------------------
// 信任 cache
// ---------------------------------------------------------------------------

// trustEntry 单条 (clientExeHash, itemID) 信任记录
//
// 命名空间用 (clientExeHash, itemID) 而非 (clientExe, itemID)：路径
// 容易被劫持（symlink / PATH 注入），SHA256 之内容唯一标识 binary。
type trustEntry struct {
	expiresAt time.Time
}

// trustCacheKey 是 trust cache map 的复合 key
//
// 拼字符串而非用 struct key：map 用 struct 作 key 要求 struct 所有字段
// 都是 comparable，加且效率与字符串拼接接近，调试时打 log 也直接可读。
type trustCacheKey string

// makeTrustCacheKey 拼 cache key
//
// exeHash 与 itemID 各自带固定长度 separator 防混淆（理论上 SHA256 hex
// 是 64 字符，itemID 是 UUID 36 字符，不会和 separator 冲突）。
func makeTrustCacheKey(exeHash, itemID string) trustCacheKey {
	return trustCacheKey(exeHash + "|" + itemID)
}

// trustCache 是进程级的信任登记表
//
// 字段：
//   - mu：保护 entries map
//   - entries：(exeHash + itemID) → expiresAt
//
// 生命周期：随 SshAgentService 创建，vault lock / agent 服务停用时全清。
type trustCache struct {
	mu      sync.Mutex
	entries map[trustCacheKey]trustEntry
}

// newTrustCache 构造空 cache
func newTrustCache() *trustCache {
	return &trustCache{entries: map[trustCacheKey]trustEntry{}}
}

// isTrusted 检查给定 (exeHash, itemID) 是否在有效信任期内
//
// 命中且未过期 → true；命中但过期 → 顺手删除 + 返回 false；未命中 → false。
//
// exeHash 为空时一律返回 false —— 不能识别的进程不允许走信任 cache，
// 让用户每次都看到确认窗。
func (c *trustCache) isTrusted(exeHash, itemID string) bool {
	if exeHash == "" || itemID == "" {
		return false
	}
	key := makeTrustCacheKey(exeHash, itemID)

	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return false
	}
	if time.Now().After(entry.expiresAt) {
		delete(c.entries, key)
		return false
	}
	return true
}

// addTrust 给 (exeHash, itemID) 添加一条信任记录
//
// duration 上限 trustCacheMaxAge；过短（< 0）的 duration 被忽略。
// exeHash 为空时拒绝 —— 见 isTrusted 注释。
func (c *trustCache) addTrust(exeHash, itemID string, duration time.Duration) {
	if exeHash == "" || itemID == "" {
		return
	}
	if duration <= 0 {
		return
	}
	if duration > trustCacheMaxAge {
		duration = trustCacheMaxAge
	}
	key := makeTrustCacheKey(exeHash, itemID)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = trustEntry{expiresAt: time.Now().Add(duration)}
}

// clear 清空所有信任记录
//
// vault lock / agent 服务停用 / 用户主动 revoke 时调用。
func (c *trustCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = map[trustCacheKey]trustEntry{}
}

// ---------------------------------------------------------------------------
// pending approval
// ---------------------------------------------------------------------------

// approvalRequest 是一次等待用户决定的签名请求
//
// 字段大部分是给前端确认窗展示用的「元数据」，不含被签的 data 原文
// （那是敏感信息）。
type approvalRequest struct {
	// ID 本次 approval 的随机标识，前端确认时回传
	ID string

	// Fingerprint SSH 公钥指纹（SHA256:base64），前端展示用
	Fingerprint string

	// ItemID vault 中对应条目的 ID
	ItemID string

	// ItemName 条目名（如 "github-ed25519"），展示用
	ItemName string

	// ClientPID 对端 SSH 客户端进程 ID
	ClientPID int32

	// ClientExe 对端可执行文件路径（如 /usr/bin/ssh）
	ClientExe string

	// ClientExeHash exe 的 SHA256；信任 cache key 的一部分
	ClientExeHash string

	// CreatedAt 请求创建时间，前端用来展示「N 秒前请求」
	CreatedAt time.Time

	// decision channel：前端调 Approve/Decline 时 send 一个 decision，
	// 阻塞在等待的 goroutine 拿到后继续
	//
	// buffered = 1：前端可能比 GUI 等待 goroutine 更早 send（罕见
	// race），不能阻塞；buffered 让 send 永远不阻塞。
	decisionCh chan approvalDecision
}

// approvalDecision 用户在确认窗的最终选择
type approvalDecision struct {
	// Approved 用户是否批准
	Approved bool

	// TrustDuration 用户选择的「信任时长」，0 表示「仅本次」
	// 大于 trustCacheMaxAge 时会被截断。
	TrustDuration time.Duration
}

// ---------------------------------------------------------------------------
// 对前端暴露的 approval payload（Wails event + Approve 调用参数共用）
// ---------------------------------------------------------------------------

// ApprovalRequest 是发送给前端确认窗的 payload
//
// 字段是 approvalRequest 的子集 —— 去掉 internal channel，加上格式化
// 后的友好字段（如 fingerprint 末 8 字符的 short hash 给标题显示用）。
//
// JSON tag 用小写驼峰与 ZPass 项目其它 IPC 一致。
type ApprovalRequest struct {
	ID                 string `json:"id"`
	Fingerprint        string `json:"fingerprint"`
	FingerprintShort   string `json:"fingerprintShort"` // 末 8 字符，给紧凑展示用
	ItemID             string `json:"itemId"`
	ItemName           string `json:"itemName"`
	ClientPID          int32  `json:"clientPid"`
	ClientExe          string `json:"clientExe"`
	ClientExeShort     string `json:"clientExeShort"`     // basename，去掉目录前缀
	ClientExeHashShort string `json:"clientExeHashShort"` // hash 末 8 字符
	CreatedAtMs        int64  `json:"createdAtMs"`        // unix 毫秒，便于前端算「N 秒前」
}

// toApprovalRequest 把内部状态转成前端 payload
func (r *approvalRequest) toApprovalRequest() ApprovalRequest {
	short := r.Fingerprint
	if len(short) > 8 {
		short = short[len(short)-8:]
	}
	exeShort := r.ClientExe
	if idx := strings.LastIndexAny(exeShort, "/\\"); idx >= 0 {
		exeShort = exeShort[idx+1:]
	}
	hashShort := r.ClientExeHash
	if len(hashShort) > 8 {
		hashShort = hashShort[:8]
	}
	return ApprovalRequest{
		ID:                 r.ID,
		Fingerprint:        r.Fingerprint,
		FingerprintShort:   short,
		ItemID:             r.ItemID,
		ItemName:           r.ItemName,
		ClientPID:          r.ClientPID,
		ClientExe:          r.ClientExe,
		ClientExeShort:     exeShort,
		ClientExeHashShort: hashShort,
		CreatedAtMs:        r.CreatedAt.UnixMilli(),
	}
}

// ApprovalDecisionOptions 是前端调用 Approve 时携带的选项
type ApprovalDecisionOptions struct {
	// TrustDurationSeconds 信任时长（秒），0 = 仅本次
	//
	// 用 int 而非 time.Duration：Wails JSON 不擅长序列化 time.Duration
	// （会变成纳秒整数，前端难写）。秒级整数最直观。
	TrustDurationSeconds int `json:"trustDurationSeconds"`
}

// ---------------------------------------------------------------------------
// approvalManager —— 集中管理所有 in-flight approval
// ---------------------------------------------------------------------------

// approvalManager 是 SshAgentService 的辅助组件
//
// 单例存在于 SshAgentService 内部。管理：
//   - 当前在等的所有 approval（key=approvalID）
//   - 信任 cache
//   - 提供 ApproveSignRequest / DeclineSignRequest 接口给前端
type approvalManager struct {
	mu       sync.Mutex
	pending  map[string]*approvalRequest
	trust    *trustCache
	deadline time.Duration

	// emitFn 由 SshAgentService 注入：发送 Wails event 给前端
	//
	// 用回调注入而非直接持有 Wails Application 引用：让 approvalManager
	// 可单测（mock emitFn 验证调用次数）；同时让 SshAgentService 与
	// Wails 应用对象的耦合保持在一处。
	emitFn func(event string, payload any)
}

// newApprovalManager 构造空 manager
//
// emitFn 由调用方提供。可以传 nil（单测场景或 service 未启用 Wails 事件
// 时），此时新 approval 不会主动通知前端 —— 仅靠前端轮询 ListPendingApprovals。
func newApprovalManager(emitFn func(event string, payload any)) *approvalManager {
	return &approvalManager{
		pending:  map[string]*approvalRequest{},
		trust:    newTrustCache(),
		deadline: approvalDefaultDeadline,
		emitFn:   emitFn,
	}
}

// requestApproval 注册一个新 approval 并阻塞等待用户决定
//
// 流程：
//  1. 检查 trust cache —— 命中则跳过弹窗直接返回 approved=true
//  2. 生成随机 ID + 创建 channel + 加入 pending map
//  3. 调 emitFn 通知前端
//  4. select 等待 (channel 收到 decision | ctx 超时 | deadline 超时)
//  5. 清理 pending map（无论结果）
//  6. 如果用户选了「信任 N 分钟」→ 调 trust.addTrust
//
// 返回值：(approved, error)
//   - approved=true 表示用户批准（或 trust cache 命中）
//   - approved=false 表示拒绝 / 超时 / ctx 取消
//   - error 非 nil 仅在内部异常（如生成随机 ID 失败）
func (m *approvalManager) requestApproval(
	ctx context.Context,
	req *approvalRequest,
) (approved bool, err error) {
	// 1. trust cache 快路径
	if m.trust.isTrusted(req.ClientExeHash, req.ItemID) {
		return true, nil
	}

	// 2. 生成 ID + 准备 channel
	id, err := generateApprovalID()
	if err != nil {
		return false, fmt.Errorf("generate approval id: %w", err)
	}
	req.ID = id
	req.CreatedAt = time.Now()
	req.decisionCh = make(chan approvalDecision, 1)

	m.mu.Lock()
	m.pending[id] = req
	deadline := m.deadline
	emit := m.emitFn
	m.mu.Unlock()

	// 3. 推给前端
	if emit != nil {
		emit("ssh-agent:approval-request", req.toApprovalRequest())
	}

	// 4. 等待
	timer := time.NewTimer(deadline)
	defer timer.Stop()

	defer m.removePending(id)

	select {
	case decision := <-req.decisionCh:
		if decision.Approved && decision.TrustDuration > 0 {
			m.trust.addTrust(req.ClientExeHash, req.ItemID, decision.TrustDuration)
		}
		return decision.Approved, nil
	case <-timer.C:
		// 超时 = 自动拒绝。通知前端关闭该窗口
		if emit != nil {
			emit("ssh-agent:approval-cancelled", map[string]string{
				"id":     id,
				"reason": "timeout",
			})
		}
		return false, nil
	case <-ctx.Done():
		if emit != nil {
			emit("ssh-agent:approval-cancelled", map[string]string{
				"id":     id,
				"reason": "cancelled",
			})
		}
		return false, ctx.Err()
	}
}

// approve 前端确认窗中用户点了「批准」时调
//
// id 找不到 → 静默忽略（可能因为超时已经被 removePending 清掉）。
// 重复 approve 同一 id → 第二次 send 因 buffered=1 会落到 default
// 分支被丢弃，无害。
func (m *approvalManager) approve(id string, trustDuration time.Duration) error {
	m.mu.Lock()
	req, ok := m.pending[id]
	m.mu.Unlock()
	if !ok {
		return errors.New("approval not found or already resolved")
	}
	select {
	case req.decisionCh <- approvalDecision{Approved: true, TrustDuration: trustDuration}:
	default:
	}
	return nil
}

// decline 前端确认窗中用户点了「拒绝」时调
func (m *approvalManager) decline(id string) error {
	m.mu.Lock()
	req, ok := m.pending[id]
	m.mu.Unlock()
	if !ok {
		return errors.New("approval not found or already resolved")
	}
	select {
	case req.decisionCh <- approvalDecision{Approved: false}:
	default:
	}
	return nil
}

// list 列出当前所有 pending approval
//
// 给前端在窗口打开后查询「漏掉的事件」用 —— 如果前端窗口比 emit event
// 慢启动，可以通过 List 拉到当前所有未处理 approval。
func (m *approvalManager) list() []ApprovalRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]ApprovalRequest, 0, len(m.pending))
	for _, req := range m.pending {
		out = append(out, req.toApprovalRequest())
	}
	return out
}

// clearTrust 清空所有信任记录
//
// vault lock 时 / 用户在设置页点「清空信任 cache」时调用。
func (m *approvalManager) clearTrust() {
	m.trust.clear()
}

// removePending 从 pending map 移除指定 id（goroutine 安全）
//
// 重复调用安全（map delete 不存在 key 是 no-op）。
func (m *approvalManager) removePending(id string) {
	m.mu.Lock()
	delete(m.pending, id)
	m.mu.Unlock()
}

// generateApprovalID 生成随机 approvalID（16 字节 hex = 32 字符）
//
// 走 crypto/rand 而非 math/rand —— 虽然 approvalID 不是密钥，但用强随机
// 是「无成本的好习惯」，且让前端拿到的 ID 看起来更专业。
func generateApprovalID() (string, error) {
	buf := make([]byte, approvalIDByteLength)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
