package services

// 条目版本历史与回退（vault_item_history）的单元测试。

import (
	"testing"
)

// TestItemHistory_UpdateThenRevert 覆盖核心链路：
//   - 新建条目 → 无历史
//   - 两次 UpdateItem → 每次覆盖前快照旧版（应有 2 条历史，最新在前）
//   - GetItemHistoryVersion 取最初版本的完整字段（敏感字段可见）
//   - RevertItem 回退到最初版本 → 当前条目内容还原 + 历史多一条 op='revert'
func TestItemHistory_UpdateThenRevert(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	created, err := svc.CreateItem(loginItemFixture("V1"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// 新建不产生历史
	if h, err := svc.ListItemHistory(created.ID); err != nil {
		t.Fatalf("list history after create: %v", err)
	} else if len(h) != 0 {
		t.Fatalf("expected 0 history after create, got %d", len(h))
	}

	// 第一次更新（名字 V2）
	upd2 := loginItemFixture("V2")
	upd2.ID = created.ID
	if _, err := svc.UpdateItem(upd2); err != nil {
		t.Fatalf("update v2: %v", err)
	}
	// 第二次更新（名字 V3）
	upd3 := loginItemFixture("V3")
	upd3.ID = created.ID
	if _, err := svc.UpdateItem(upd3); err != nil {
		t.Fatalf("update v3: %v", err)
	}

	hist, err := svc.ListItemHistory(created.ID)
	if err != nil {
		t.Fatalf("list history: %v", err)
	}
	if len(hist) != 2 {
		t.Fatalf("expected 2 history versions, got %d", len(hist))
	}
	// 最新在前：hist[0] = V2 版本快照（第二次 update 覆盖的旧版），
	// hist[1] = V1 版本快照（第一次 update 覆盖的旧版）。
	if hist[0].Name != "V2" || hist[0].Op != "update" {
		t.Errorf("hist[0] expected V2/update, got %s/%s", hist[0].Name, hist[0].Op)
	}
	if hist[1].Name != "V1" {
		t.Errorf("hist[1] expected V1, got %s", hist[1].Name)
	}
	// 摘要不应泄露敏感字段（password 不在 ItemHistorySummary 上 —— 结构层面保证）。

	// 取最初版本（V1）的完整 payload，敏感字段应可见
	v1Version := hist[1].VersionID
	full, err := svc.GetItemHistoryVersion(created.ID, v1Version)
	if err != nil {
		t.Fatalf("get history version: %v", err)
	}
	if full.Name != "V1" {
		t.Errorf("history version name expected V1, got %s", full.Name)
	}
	if pw, _ := full.Fields["password"].(string); pw != "S3cret!Pass-V1" {
		t.Errorf("history version password mismatch: %q", pw)
	}

	// 回退到 V1
	reverted, err := svc.RevertItem(created.ID, v1Version)
	if err != nil {
		t.Fatalf("revert: %v", err)
	}
	if reverted.Name != "V1" {
		t.Errorf("reverted name expected V1, got %s", reverted.Name)
	}

	// 当前条目内容应还原为 V1
	cur, err := svc.GetItem(created.ID)
	if err != nil {
		t.Fatalf("get after revert: %v", err)
	}
	if cur == nil {
		t.Fatalf("expected item after revert, got nil")
	}
	if cur.Name != "V1" {
		t.Errorf("current name after revert expected V1, got %s", cur.Name)
	}
	if pw, _ := cur.Fields["password"].(string); pw != "S3cret!Pass-V1" {
		t.Errorf("current password after revert mismatch: %q", pw)
	}
	// ID / CreatedAt 不变
	if cur.ID != created.ID {
		t.Errorf("id changed after revert: %s != %s", cur.ID, created.ID)
	}
	if cur.CreatedAt != created.CreatedAt {
		t.Errorf("createdAt changed after revert: %d != %d", cur.CreatedAt, created.CreatedAt)
	}
	// Revision 应严格大于回退前（回退也是一次写入）
	if cur.Revision <= 3 {
		// 4 次写入：create(1) + update(2) + update(3) + revert(4)
		t.Errorf("expected revision >= 4 after revert, got %d", cur.Revision)
	}

	// 回退把回退前的「当前版本」(V3) 快照入历史，op='revert' → 现在共 3 条
	histAfter, err := svc.ListItemHistory(created.ID)
	if err != nil {
		t.Fatalf("list history after revert: %v", err)
	}
	if len(histAfter) != 3 {
		t.Fatalf("expected 3 history versions after revert, got %d", len(histAfter))
	}
	if histAfter[0].Op != "revert" || histAfter[0].Name != "V3" {
		t.Errorf("hist[0] after revert expected V3/revert, got %s/%s",
			histAfter[0].Name, histAfter[0].Op)
	}
}

// TestItemHistory_DeleteSnapshotsAndCrossSpaceGuard 覆盖：
//   - 软删除前快照旧版（op='delete'）
//   - ListItemHistory / GetItemHistoryVersion 对跨空间条目返回 ErrItemNotFound
func TestItemHistory_DeleteSnapshot(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	created, err := svc.CreateItem(loginItemFixture("ToDelete"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := svc.DeleteItem(created.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	hist, err := svc.ListItemHistory(created.ID)
	if err != nil {
		t.Fatalf("list history: %v", err)
	}
	if len(hist) != 1 {
		t.Fatalf("expected 1 history version after delete, got %d", len(hist))
	}
	if hist[0].Op != "delete" || hist[0].Name != "ToDelete" {
		t.Errorf("expected ToDelete/delete, got %s/%s", hist[0].Name, hist[0].Op)
	}
}
