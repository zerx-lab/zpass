// SSH agent 服务 —— 审计日志 ring buffer
//
// ---------------------------------------------------------------------------
// 目标
//
// 给前端的「审计日志」面板提供数据源：每次签名（无论成功失败）记录一条
// AuditEntry，前端可以查询最近 N 条。
//
// MVP-2 阶段只做**内存 ring buffer**（256 条），重启 GUI 即清空。完整
// 持久化（落盘到 vault.db 的 agent_audit 表）留给 v3 阶段，那时同时要做
// vault 锁定期间的 OS keychain 暂存与解锁后批量 flush。
//
// ---------------------------------------------------------------------------
// 设计要点
//
// 1. **绝不记录 data 原文** —— 被签名的 data 可能含 commit 摘要、认证
//    challenge 等敏感信息。审计日志只记 fingerprint + 客户端 metadata +
//    决定结果。
//
// 2. **结果的描述要 user-friendly**：
//      - "approved"        — 用户批准
//      - "trusted-cache"   — trust cache 命中（用户曾经批准过）
//      - "declined"        — 用户拒绝
//      - "timeout"         — 用户没响应
//      - "vault-locked"    — vault 在签名前被锁了
//      - "key-not-found"   — fingerprint 对应的 key 已从 vault 删了
//      - "error: ..."      — 其它内部错误
//
// 3. **ring buffer 而非 slice append**：避免内存无界增长；新条目挤掉
//    最旧的。在「连续 ssh 调试」场景下不会因日志撑爆内存。

package main

import (
	"sync"
	"time"
)

// auditLogPersistKeep 是 vault 中保留的审计记录上限
//
// 1000 条 ≈ 1–2 个月的使用量（按每天 30 次 ssh 算，由于信任 cache
// 命中后仍会记录）。超出后被 Prune 删除。够多数用户查历史，同时避免表
// 无限增长压减 vault.db 体积。
const auditLogPersistKeep = 1000

// auditEntryBufferSize 内存 ring buffer 容量
//
// 256 条 = 大约一周的 ssh 使用日志（按用户每天 30-50 次 ssh 算，但绝大
// 部分会命中 trust cache 不进 buffer；实际多数用户够看几天）。
// 越大占内存越多，太小用户翻历史时不够。256 是一个合理的 sweet spot。
const auditEntryBufferSize = 256

// ---------------------------------------------------------------------------
// AuditEntry —— 单条审计记录
// ---------------------------------------------------------------------------

// AuditEntry 是前端审计日志面板展示用的数据结构
//
// JSON tag 用小写驼峰，与项目其它 IPC 一致。
type AuditEntry struct {
	// TimestampMs unix 毫秒，前端用来排序 + 格式化为「N 秒前」
	TimestampMs int64 `json:"timestampMs"`

	// ItemID vault 条目 ID（可能为空，如 key not found 场景）
	ItemID string `json:"itemId"`

	// ItemName 条目名（如 "github-ed25519"），便于前端列表展示无需查 vault
	ItemName string `json:"itemName"`

	// Fingerprint 完整的 SSH fingerprint
	Fingerprint string `json:"fingerprint"`

	// ClientExe 对端可执行文件路径
	ClientExe string `json:"clientExe"`

	// ClientPID 对端进程 ID
	ClientPID int32 `json:"clientPid"`

	// Outcome 简短的结果代码（见文件头注释的清单）
	Outcome string `json:"outcome"`

	// Approved 签名是否成功（user 视角）
	Approved bool `json:"approved"`
}

// ---------------------------------------------------------------------------
// auditLog —— ring buffer 实现
// ---------------------------------------------------------------------------

// auditLog 是进程级的审计日志缓冲
//
// 用环形数组实现：head 指向下一个写入位置，count 跟踪当前条目数。
// 满了之后新写入会覆盖最旧的条目（典型 ring buffer）。
type auditLog struct {
	mu      sync.Mutex
	entries [auditEntryBufferSize]AuditEntry
	head    int // 下一个写入位置
	count   int // 当前条目数（最大 = auditEntryBufferSize）
}

// newAuditLog 构造空 log
func newAuditLog() *auditLog {
	return &auditLog{}
}

// append 追加一条记录
//
// 满了时覆盖最旧条目；调用方不需要关心容量管理。
//
// 不返回 error：log 写入永远成功（覆盖旧条目是合理路径）。
func (a *auditLog) append(entry AuditEntry) {
	if entry.TimestampMs == 0 {
		entry.TimestampMs = time.Now().UnixMilli()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.entries[a.head] = entry
	a.head = (a.head + 1) % auditEntryBufferSize
	if a.count < auditEntryBufferSize {
		a.count++
	}
}

// snapshot 返回当前所有条目（按时间倒序：最新的在前）
//
// 返回 slice 是「拷贝」，调用方修改不会影响内部数组。
//
// 实现注意：环形数组的逻辑顺序需要从 (head - count) 开始走 count 步。
// 反序给前端是因为「最新的最重要」UX 期望。
func (a *auditLog) snapshot() []AuditEntry {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.count == 0 {
		return nil
	}

	out := make([]AuditEntry, a.count)
	// 从最旧条目开始拷贝到一个临时 slice，然后倒序输出
	startIdx := (a.head - a.count + auditEntryBufferSize) % auditEntryBufferSize
	for i := 0; i < a.count; i++ {
		// 倒序写入：最旧的放最后，最新的放最前
		out[a.count-1-i] = a.entries[(startIdx+i)%auditEntryBufferSize]
	}
	return out
}

// clear 清空所有审计记录
//
// 用户在设置页点「清空审计日志」时调用。MVP-2 阶段也在 service Disable
// 时调用。
func (a *auditLog) clear() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.head = 0
	a.count = 0
	// 不必把 entries 清零 —— count=0 已经让 snapshot 返回空
}
