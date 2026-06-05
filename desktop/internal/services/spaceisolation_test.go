package services

// 空间(Space)隔离 —— 端到端单元测试
// ---------------------------------------------------------------------------
// 覆盖方案 B（单库 + space_id 列 + 共享 DEK）的核心不变量：
//   1. v4→v5 迁移：space_id 列被幂等补齐，老行回填为 ''
//   2. CRUD 严格作用于 currentSpaceID：跨空间访问视作未找到
//   3. 未选空间时写操作被拒（ErrSpaceNotSelected）
//   4. ClaimOrphanItems 认领历史 orphan：列 + 密文双写、时间戳不变、幂等
//   5. 同步构件：getItemAnySpace 绕过空间过滤、IngestForeignPayload 传播空间
//   6. passkey 列表/读取按空间隔离

import (
	"encoding/json"
	"errors"
	"testing"
)

// ---------------------------------------------------------------------------
// 测试 helper
// ---------------------------------------------------------------------------

// unlockedServiceInSpace 返回一个已初始化解锁、且激活到 spaceID 的服务。
func unlockedServiceInSpace(t *testing.T, spaceID string) *VaultService {
	t.Helper()
	svc, _ := newTestService(t) // 已默认激活 testSpaceID
	if err := svc.Initialize("space-iso-master-pw"); err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := svc.SetActiveSpace(spaceID); err != nil {
		t.Fatalf("set space %q: %v", spaceID, err)
	}
	return svc
}

// bareUnlockedService 返回一个已解锁但**未选择任何空间**的服务（currentSpaceID="")。
// 专门用于验证「未选空间」的拒绝行为 —— 不能用 newTestService（它默认激活了空间）。
func bareUnlockedService(t *testing.T) *VaultService {
	t.Helper()
	withTempHome(t)
	db, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	svc := NewVaultService(db)
	if err := svc.Initialize("bare-master-pw"); err != nil {
		t.Fatalf("init: %v", err)
	}
	return svc
}

// rawPayloadSpaceID 解密某条目的原始密文并返回密文内嵌的 SpaceID（**不**经过
// decryptItem 的「用 DB 列覆盖」逻辑）—— 用于验证 ClaimOrphanItems 确实重写了
// 加密 payload，而不只是改了明文列。
func rawPayloadSpaceID(t *testing.T, svc *VaultService, id string) string {
	t.Helper()
	row, err := svc.db.GetItem(id)
	if err != nil || row == nil {
		t.Fatalf("get raw row %s: err=%v row=%v", id, err, row)
	}
	pt, err := OpenAEAD(svc.dek, row.Payload, []byte(id))
	if err != nil {
		t.Fatalf("open aead %s: %v", id, err)
	}
	var p ItemPayload
	if err := json.Unmarshal(pt, &p); err != nil {
		t.Fatalf("unmarshal %s: %v", id, err)
	}
	return p.SpaceID
}

func hasSpaceColumn(t *testing.T, db *VaultDB) bool {
	t.Helper()
	rows, err := db.handle.Query(`PRAGMA table_info(vault_items)`)
	if err != nil {
		t.Fatalf("pragma: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid         int
			name, ctype string
			notnull, pk int
			dflt        any
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan pragma: %v", err)
		}
		if name == "space_id" {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 1. 迁移
// ---------------------------------------------------------------------------

// TestSpaceMigration_V4ToV5AddsColumn 验证 v4 老表（无 space_id）经
// ensureVaultItemsV5Schema 后补齐列，且老行回填为 ”。
func TestSpaceMigration_V4ToV5AddsColumn(t *testing.T) {
	withTempHome(t)
	db, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	// 模拟 v4 老表：重建一张不含 space_id 的 vault_items 并插一行。
	_, err = db.handle.Exec(`
		DROP TABLE vault_items;
		CREATE TABLE vault_items (
			id         TEXT    PRIMARY KEY,
			payload    BLOB    NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			deleted_at INTEGER
		);
		INSERT INTO vault_items (id, payload, created_at, updated_at)
			VALUES ('old1', X'0011', 1, 1);
	`)
	if err != nil {
		t.Fatalf("setup v4 table: %v", err)
	}
	if hasSpaceColumn(t, db) {
		t.Fatal("precondition failed: space_id should be absent on simulated v4 table")
	}

	if err := db.ensureVaultItemsV5Schema(); err != nil {
		t.Fatalf("ensure v5: %v", err)
	}

	if !hasSpaceColumn(t, db) {
		t.Fatal("space_id column missing after ensureVaultItemsV5Schema")
	}
	var sp string
	if err := db.handle.QueryRow(`SELECT space_id FROM vault_items WHERE id='old1'`).Scan(&sp); err != nil {
		t.Fatalf("read space_id: %v", err)
	}
	if sp != "" {
		t.Errorf("expected old row space_id='', got %q", sp)
	}
}

// ---------------------------------------------------------------------------
// 2. CRUD 隔离
// ---------------------------------------------------------------------------

func TestCreateItem_NoActiveSpace_Rejected(t *testing.T) {
	svc := bareUnlockedService(t)
	if _, err := svc.CreateItem(loginItemFixture("X")); !errors.Is(err, ErrSpaceNotSelected) {
		t.Fatalf("expected ErrSpaceNotSelected, got %v", err)
	}
}

func TestListItems_ScopedToActiveSpace(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	if _, err := svc.CreateItem(loginItemFixture("a1")); err != nil {
		t.Fatalf("create a1: %v", err)
	}
	if _, err := svc.CreateItem(loginItemFixture("a2")); err != nil {
		t.Fatalf("create a2: %v", err)
	}
	if err := svc.SetActiveSpace("B"); err != nil {
		t.Fatalf("switch B: %v", err)
	}
	if _, err := svc.CreateItem(loginItemFixture("b1")); err != nil {
		t.Fatalf("create b1: %v", err)
	}

	if err := svc.SetActiveSpace("A"); err != nil {
		t.Fatalf("switch A: %v", err)
	}
	listA, err := svc.ListItems()
	if err != nil {
		t.Fatalf("list A: %v", err)
	}
	if len(listA) != 2 {
		t.Errorf("space A: expected 2 items, got %d", len(listA))
	}

	if err := svc.SetActiveSpace("B"); err != nil {
		t.Fatalf("switch B: %v", err)
	}
	listB, err := svc.ListItems()
	if err != nil {
		t.Fatalf("list B: %v", err)
	}
	if len(listB) != 1 {
		t.Errorf("space B: expected 1 item, got %d", len(listB))
	}
}

func TestGetUpdateDelete_CrossSpace_NotFound(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	created, err := svc.CreateItem(loginItemFixture("secret"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	id := created.ID

	// 切到空间 B —— A 的条目应当对一切操作不可见
	if err := svc.SetActiveSpace("B"); err != nil {
		t.Fatalf("switch B: %v", err)
	}

	got, err := svc.GetItem(id)
	if err != nil {
		t.Fatalf("get cross-space: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil (not found) for cross-space GetItem, got %+v", got)
	}

	upd := loginItemFixture("hacked")
	upd.ID = id
	if _, err := svc.UpdateItem(upd); !errors.Is(err, ErrItemNotFound) {
		t.Errorf("expected ErrItemNotFound for cross-space UpdateItem, got %v", err)
	}

	if err := svc.DeleteItem(id); !errors.Is(err, ErrItemNotFound) {
		t.Errorf("expected ErrItemNotFound for cross-space DeleteItem, got %v", err)
	}

	// 切回 A —— 条目仍在、内容未被跨空间操作篡改
	if err := svc.SetActiveSpace("A"); err != nil {
		t.Fatalf("switch A: %v", err)
	}
	back, err := svc.GetItem(id)
	if err != nil || back == nil {
		t.Fatalf("get in A: err=%v item=%v", err, back)
	}
	if back.Name != "secret" {
		t.Errorf("item mutated across spaces: name=%q", back.Name)
	}
}

func TestUpdateItem_PreservesSpace(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	created, err := svc.CreateItem(loginItemFixture("orig"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	upd := loginItemFixture("renamed")
	upd.ID = created.ID
	upd.SpaceID = "B" // 前端即便恶意传别的空间，也应被忽略
	if _, err := svc.UpdateItem(upd); err != nil {
		t.Fatalf("update: %v", err)
	}

	row, err := svc.db.GetItem(created.ID)
	if err != nil || row == nil {
		t.Fatalf("get row: err=%v row=%v", err, row)
	}
	if row.SpaceID != "A" {
		t.Errorf("expected space_id preserved as A, got %q", row.SpaceID)
	}
	if got := rawPayloadSpaceID(t, svc, created.ID); got != "A" {
		t.Errorf("expected ciphertext SpaceID=A after update, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// 3. ClaimOrphanItems
// ---------------------------------------------------------------------------

// makeOrphan 创建一条正常条目，再把它的 space_id 列改成 ”（模拟 v5 迁移遗留的
// orphan）。注意：此时密文内嵌的 SpaceID 仍是创建时的空间，故意制造「列与密文
// 不一致」让认领去修复。
func makeOrphan(t *testing.T, svc *VaultService, name string) string {
	t.Helper()
	created, err := svc.CreateItem(loginItemFixture(name))
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	if _, err := svc.db.handle.Exec(`UPDATE vault_items SET space_id='' WHERE id=?`, created.ID); err != nil {
		t.Fatalf("orphan %s: %v", name, err)
	}
	return created.ID
}

func TestClaimOrphanItems_RewritesColumnAndCiphertext(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	id := makeOrphan(t, svc, "legacy")

	// 记录认领前的时间戳
	before, _ := svc.db.GetItem(id)

	n, err := svc.ClaimOrphanItems("A")
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 claimed, got %d", n)
	}

	after, err := svc.db.GetItem(id)
	if err != nil || after == nil {
		t.Fatalf("get after claim: err=%v row=%v", err, after)
	}
	if after.SpaceID != "A" {
		t.Errorf("column space_id: expected A, got %q", after.SpaceID)
	}
	// 密文内嵌的 SpaceID 也必须被重写为 A（供同步跨设备传播）
	if got := rawPayloadSpaceID(t, svc, id); got != "A" {
		t.Errorf("ciphertext SpaceID: expected A, got %q", got)
	}
	// 时间戳不变 —— 认领不污染同步 LWW 顺序
	if before.UpdatedAt != after.UpdatedAt {
		t.Errorf("updated_at changed by claim: %d -> %d", before.UpdatedAt, after.UpdatedAt)
	}
}

func TestClaimOrphanItems_Idempotent(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	makeOrphan(t, svc, "o1")
	makeOrphan(t, svc, "o2")

	if n, err := svc.ClaimOrphanItems("A"); err != nil || n != 2 {
		t.Fatalf("first claim: n=%d err=%v (want 2)", n, err)
	}
	// 二次认领已无 orphan
	if n, err := svc.ClaimOrphanItems("A"); err != nil || n != 0 {
		t.Fatalf("second claim: n=%d err=%v (want 0)", n, err)
	}
}

func TestClaimOrphanItems_ThenVisibleInSpace(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	makeOrphan(t, svc, "ghost")

	// 认领前：orphan 不属于 A，列表看不到
	if list, _ := svc.ListItems(); len(list) != 0 {
		t.Fatalf("pre-claim: expected 0 visible, got %d", len(list))
	}
	if _, err := svc.ClaimOrphanItems("A"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if list, _ := svc.ListItems(); len(list) != 1 {
		t.Fatalf("post-claim: expected 1 visible in A, got %d", len(list))
	}
}

// ---------------------------------------------------------------------------
// 4. 同步构件
// ---------------------------------------------------------------------------

// TestGetItemAnySpace_BypassesFilter 验证同步用的 getItemAnySpace 能读到任意
// 空间的条目，而导出的 GetItem 受空间约束 —— 这是 sync 不漏传的关键。
func TestGetItemAnySpace_BypassesFilter(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	created, err := svc.CreateItem(loginItemFixture("x"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := svc.SetActiveSpace("B"); err != nil {
		t.Fatalf("switch B: %v", err)
	}

	// GetItem（带校验）在 B 下看不到 A 的条目
	if got, _ := svc.GetItem(created.ID); got != nil {
		t.Errorf("GetItem should be nil cross-space, got %+v", got)
	}
	// getItemAnySpace（同步用）仍能读到
	any, err := svc.getItemAnySpace(created.ID)
	if err != nil {
		t.Fatalf("getItemAnySpace: %v", err)
	}
	if any == nil || any.SpaceID != "A" {
		t.Errorf("getItemAnySpace expected item in space A, got %+v", any)
	}
}

// TestIngestForeignPayload_NewItemUsesPayloadSpace 验证同步落地一条本端没有的
// 外来条目时，归属对端 payload 的 SpaceID（而非本端当前激活空间）。
func TestIngestForeignPayload_NewItemUsesPayloadSpace(t *testing.T) {
	svc := unlockedServiceInSpace(t, "B") // 本端当前在 B
	payload := loginItemFixture("foreign")
	payload.ID = "foreign-id-1"
	payload.SpaceID = "A" // 对端称它属于空间 A

	applied, err := svc.IngestForeignPayload("foreign-id-1", &payload, 100, 200)
	if err != nil || !applied {
		t.Fatalf("ingest: applied=%v err=%v", applied, err)
	}
	row, err := svc.db.GetItem("foreign-id-1")
	if err != nil || row == nil {
		t.Fatalf("get row: err=%v row=%v", err, row)
	}
	if row.SpaceID != "A" {
		t.Errorf("new ingested item: expected space A (from payload), got %q", row.SpaceID)
	}
}

// TestIngestForeignPayload_EmptySpaceFallsBackToCurrent 对端不支持空间（SpaceID
// 为空）时，新条目 fallback 到当前激活空间。
func TestIngestForeignPayload_EmptySpaceFallsBackToCurrent(t *testing.T) {
	svc := unlockedServiceInSpace(t, "B")
	payload := loginItemFixture("legacy-foreign")
	payload.ID = "foreign-id-2"
	payload.SpaceID = "" // 旧版本对端

	if _, err := svc.IngestForeignPayload("foreign-id-2", &payload, 100, 200); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	row, _ := svc.db.GetItem("foreign-id-2")
	if row == nil || row.SpaceID != "B" {
		t.Errorf("expected fallback to current space B, got %+v", row)
	}
}

// TestIngestForeignPayload_ExistingItemKeepsSpace 同步更新一条本端已有条目时，
// 保持本端原空间归属（sync 不改变 item 的空间），即便对端 payload 声称别的空间。
func TestIngestForeignPayload_ExistingItemKeepsSpace(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	created, err := svc.CreateItem(loginItemFixture("shared"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// 构造一个「更新」：更晚的 updatedAt，但 payload 声称空间 C
	upd := loginItemFixture("shared-renamed")
	upd.ID = created.ID
	upd.SpaceID = "C"
	future := created.UpdatedAt + 10_000
	if _, err := svc.IngestForeignPayload(created.ID, &upd, created.CreatedAt, future); err != nil {
		t.Fatalf("ingest update: %v", err)
	}
	row, _ := svc.db.GetItem(created.ID)
	if row == nil || row.SpaceID != "A" {
		t.Errorf("existing item should keep space A, got %+v", row)
	}
}

// ---------------------------------------------------------------------------
// 5. passkey 隔离
// ---------------------------------------------------------------------------

func TestListPasskeys_ScopedToSpace(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	cred, err := svc.CreatePasskey(PasskeyRegistrationRequest{
		RPID:     "example.com",
		RPName:   "Example",
		UserName: "user@example.com",
		Name:     "Example Passkey",
	})
	if err != nil {
		t.Fatalf("create passkey: %v", err)
	}

	// 在 A 能枚举到
	if list, err := svc.ListPasskeys("example.com"); err != nil || len(list) != 1 {
		t.Fatalf("list in A: n=%d err=%v (want 1)", len(list), err)
	}

	// 切到 B：枚举为空、按 id 读取不到
	if err := svc.SetActiveSpace("B"); err != nil {
		t.Fatalf("switch B: %v", err)
	}
	if list, err := svc.ListPasskeys("example.com"); err != nil || len(list) != 0 {
		t.Errorf("list in B: n=%d err=%v (want 0)", len(list), err)
	}
	if _, err := svc.GetPasskey(cred.ItemID); !errors.Is(err, ErrPasskeyNotFound) {
		t.Errorf("GetPasskey cross-space: expected ErrPasskeyNotFound, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// 6. 清空空间（ClearSpace）
// ---------------------------------------------------------------------------

func mustCreate(t *testing.T, svc *VaultService, name string) string {
	t.Helper()
	c, err := svc.CreateItem(loginItemFixture(name))
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	return c.ID
}

// TestClearSpace_SoftDeletesSpaceItems 清空空间应软删除该空间全部条目（写 tombstone），
// 且不影响其它空间。
func TestClearSpace_SoftDeletesSpaceItems(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	a1 := mustCreate(t, svc, "a1")
	mustCreate(t, svc, "a2")
	if err := svc.SetActiveSpace("B"); err != nil {
		t.Fatalf("switch B: %v", err)
	}
	mustCreate(t, svc, "b1")
	if err := svc.SetActiveSpace("A"); err != nil {
		t.Fatalf("switch A: %v", err)
	}

	n, err := svc.ClearSpace("A")
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if n != 2 {
		t.Fatalf("expected 2 cleared, got %d", n)
	}

	// A 清空 —— 列表为空、条目对前端不可见
	if list, _ := svc.ListItems(); len(list) != 0 {
		t.Errorf("space A should be empty after clear, got %d", len(list))
	}
	if got, _ := svc.GetItem(a1); got != nil {
		t.Errorf("cleared item should be invisible, got %+v", got)
	}
	// 软删除：DB 行仍在，但 deleted_at 已置（tombstone，供同步传播删除）
	row, _ := svc.db.GetItem(a1)
	if row == nil || row.DeletedAt == nil {
		t.Errorf("cleared item should be a tombstone (row exists, deleted_at set), got %+v", row)
	}

	// B 不受影响
	if err := svc.SetActiveSpace("B"); err != nil {
		t.Fatalf("switch B: %v", err)
	}
	if list, _ := svc.ListItems(); len(list) != 1 {
		t.Errorf("space B should keep its 1 item, got %d", len(list))
	}
}

// TestClearSpace_NonCurrentSpace 清空非当前激活空间也应生效（设置页可对任意空间操作）。
func TestClearSpace_NonCurrentSpace(t *testing.T) {
	svc := unlockedServiceInSpace(t, "A")
	mustCreate(t, svc, "a1")
	mustCreate(t, svc, "a2")
	// 当前停在 B，清空 A
	if err := svc.SetActiveSpace("B"); err != nil {
		t.Fatalf("switch B: %v", err)
	}
	n, err := svc.ClearSpace("A")
	if err != nil || n != 2 {
		t.Fatalf("clear A while on B: n=%d err=%v (want 2)", n, err)
	}
	if err := svc.SetActiveSpace("A"); err != nil {
		t.Fatalf("switch A: %v", err)
	}
	if list, _ := svc.ListItems(); len(list) != 0 {
		t.Errorf("space A should be empty, got %d", len(list))
	}
}
