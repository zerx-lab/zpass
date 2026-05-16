// approvalManager / trustCache / auditLog 的烟雾测试
//
// ---------------------------------------------------------------------------
// 覆盖目标
//
// 1. trustCache：add/isTrusted/过期/clear
// 2. approvalManager：trust 命中跳过弹窗、approve/decline/超时
// 3. auditLog：append/snapshot 顺序/clear

package main

import (
	"context"
	"testing"
	"time"
)

func TestTrustCache_AddAndCheck(t *testing.T) {
	c := newTrustCache()

	// 未添加 → 不信任
	if c.isTrusted("hash1", "item1") {
		t.Fatal("empty cache should not trust anything")
	}

	// 添加 → 信任
	c.addTrust("hash1", "item1", 1*time.Hour)
	if !c.isTrusted("hash1", "item1") {
		t.Fatal("after addTrust, should be trusted")
	}

	// 不同 itemID → 不信任
	if c.isTrusted("hash1", "item2") {
		t.Fatal("different itemID should not be trusted")
	}

	// 不同 exeHash → 不信任
	if c.isTrusted("hash2", "item1") {
		t.Fatal("different exeHash should not be trusted")
	}

	// 空字符串永远不信任
	if c.isTrusted("", "item1") {
		t.Fatal("empty exeHash should never be trusted")
	}
	if c.isTrusted("hash1", "") {
		t.Fatal("empty itemID should never be trusted")
	}

	c.clear()
	if c.isTrusted("hash1", "item1") {
		t.Fatal("after clear, should not be trusted")
	}
}

func TestTrustCache_Expiry(t *testing.T) {
	c := newTrustCache()
	// 1 毫秒后过期 —— 让测试不必等真实的 hour
	c.addTrust("hash1", "item1", 5*time.Millisecond)

	// 立即检查应当命中
	if !c.isTrusted("hash1", "item1") {
		t.Fatal("should be trusted immediately after add")
	}

	// 等过期
	time.Sleep(10 * time.Millisecond)
	if c.isTrusted("hash1", "item1") {
		t.Fatal("should be expired after sleep")
	}
}

func TestTrustCache_DurationCap(t *testing.T) {
	c := newTrustCache()
	// 超过上限 8 小时 —— 应当被截断（具体上限不重要，只要不 panic）
	c.addTrust("hash1", "item1", 999*time.Hour)
	if !c.isTrusted("hash1", "item1") {
		t.Fatal("after capped addTrust, should still be trusted")
	}
}

func TestApprovalManager_ApproveAndDecline(t *testing.T) {
	m := newApprovalManager(nil)

	// 测试 approve
	req := &approvalRequest{
		Fingerprint: "SHA256:abc",
		ItemID:      "item1",
		ItemName:    "test",
	}

	resultCh := make(chan struct {
		approved bool
		err      error
	}, 1)
	go func() {
		approved, err := m.requestApproval(context.Background(), req)
		resultCh <- struct {
			approved bool
			err      error
		}{approved, err}
	}()

	// 等待 approval 进入 pending
	deadline := time.After(2 * time.Second)
	for {
		list := m.list()
		if len(list) == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("approval did not appear in pending list")
		case <-time.After(5 * time.Millisecond):
		}
	}

	// approve
	id := m.list()[0].ID
	if err := m.approve(id, 0); err != nil {
		t.Fatalf("approve: %v", err)
	}

	res := <-resultCh
	if res.err != nil {
		t.Fatalf("requestApproval: %v", res.err)
	}
	if !res.approved {
		t.Fatal("expected approved=true")
	}
}

func TestApprovalManager_TrustCacheShortcut(t *testing.T) {
	m := newApprovalManager(nil)
	m.trust.addTrust("hash1", "item1", 1*time.Hour)

	req := &approvalRequest{
		Fingerprint:   "SHA256:abc",
		ItemID:        "item1",
		ItemName:      "test",
		ClientExeHash: "hash1",
	}

	// trust cache 命中 → 立即返回，无需等
	start := time.Now()
	approved, err := m.requestApproval(context.Background(), req)
	if err != nil {
		t.Fatalf("requestApproval: %v", err)
	}
	if !approved {
		t.Fatal("trust cache should auto-approve")
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Errorf("trust cache shortcut should be instant, took %v", elapsed)
	}
}

func TestApprovalManager_Timeout(t *testing.T) {
	m := newApprovalManager(nil)
	m.deadline = 50 * time.Millisecond // 缩短超时让测试快

	req := &approvalRequest{
		Fingerprint: "SHA256:abc",
		ItemID:      "item1",
	}

	start := time.Now()
	approved, err := m.requestApproval(context.Background(), req)
	if err != nil {
		t.Fatalf("requestApproval: %v", err)
	}
	if approved {
		t.Fatal("timeout should result in not-approved")
	}
	elapsed := time.Since(start)
	if elapsed < 40*time.Millisecond {
		t.Errorf("expected at least 40ms wait, got %v", elapsed)
	}
}

func TestApprovalManager_EmitsEvent(t *testing.T) {
	var emitted []string
	m := newApprovalManager(func(event string, _ any) {
		emitted = append(emitted, event)
	})

	req := &approvalRequest{
		Fingerprint: "SHA256:abc",
		ItemID:      "item1",
	}

	go func() {
		_, _ = m.requestApproval(context.Background(), req)
	}()

	// 等待 emit
	deadline := time.After(2 * time.Second)
	for {
		if len(emitted) > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("did not emit approval event")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if emitted[0] != "ssh-agent:approval-request" {
		t.Errorf("unexpected event: %q", emitted[0])
	}

	// 给 approval decline 一下让 goroutine 退出
	if list := m.list(); len(list) > 0 {
		_ = m.decline(list[0].ID)
	}
}

func TestAuditLog_AppendAndSnapshot(t *testing.T) {
	log := newAuditLog()

	if got := log.snapshot(); len(got) != 0 {
		t.Errorf("empty log should snapshot empty, got %d", len(got))
	}

	log.append(AuditEntry{ItemName: "a", Outcome: "approved", Approved: true})
	log.append(AuditEntry{ItemName: "b", Outcome: "declined", Approved: false})
	log.append(AuditEntry{ItemName: "c", Outcome: "approved", Approved: true})

	snap := log.snapshot()
	if len(snap) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(snap))
	}
	// 最新的在前
	if snap[0].ItemName != "c" {
		t.Errorf("expected newest first: c, got %s", snap[0].ItemName)
	}
	if snap[2].ItemName != "a" {
		t.Errorf("expected oldest last: a, got %s", snap[2].ItemName)
	}

	log.clear()
	if got := log.snapshot(); len(got) != 0 {
		t.Errorf("after clear, should be empty, got %d", len(got))
	}
}

func TestAuditLog_RingBufferOverflow(t *testing.T) {
	log := newAuditLog()

	// 写满 + 多写几条
	for i := 0; i < auditEntryBufferSize+10; i++ {
		log.append(AuditEntry{ItemName: "test", Outcome: "approved"})
	}

	snap := log.snapshot()
	if len(snap) != auditEntryBufferSize {
		t.Errorf("expected %d entries (cap), got %d", auditEntryBufferSize, len(snap))
	}
}
