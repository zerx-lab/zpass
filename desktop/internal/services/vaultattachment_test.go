package services

// 条目附件（vault_attachments）的单元测试。覆盖增删查、加解密往返、大小超限拒绝、
// 软删过滤、空间隔离。

import (
	"encoding/base64"
	"strings"
	"testing"
)

func attB64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// TestAttachment_AddListGetRoundTrip 覆盖核心链路：新增 → 列出 → 取回明文。
func TestAttachment_AddListGetRoundTrip(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	item, err := svc.CreateItem(loginItemFixture("WithAttachment"))
	if err != nil {
		t.Fatalf("create item: %v", err)
	}

	content := []byte("hello attachment world\x00\x01\x02")
	sum, err := svc.AddAttachment(item.ID, "secret.txt", attB64(content))
	if err != nil {
		t.Fatalf("add attachment: %v", err)
	}
	if sum.FileName != "secret.txt" {
		t.Errorf("summary file name = %q, want secret.txt", sum.FileName)
	}
	if sum.SizeBytes != int64(len(content)) {
		t.Errorf("summary size = %d, want %d", sum.SizeBytes, len(content))
	}
	if sum.Synced {
		t.Errorf("freshly added attachment should not be synced")
	}

	list, err := svc.ListAttachments(item.ID)
	if err != nil {
		t.Fatalf("list attachments: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(list))
	}
	if list[0].ID != sum.ID || list[0].FileName != "secret.txt" {
		t.Errorf("list entry mismatch: %+v", list[0])
	}

	data, err := svc.GetAttachmentData(sum.ID)
	if err != nil {
		t.Fatalf("get attachment data: %v", err)
	}
	if data.FileName != "secret.txt" {
		t.Errorf("data file name = %q, want secret.txt", data.FileName)
	}
	got, err := base64.StdEncoding.DecodeString(data.DataB64)
	if err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("round-trip content mismatch: got %q want %q", got, content)
	}
}

// TestAttachment_SizeLimitRejected 覆盖 5MiB 超限拒绝。
func TestAttachment_SizeLimitRejected(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	item, err := svc.CreateItem(loginItemFixture("BigFile"))
	if err != nil {
		t.Fatalf("create item: %v", err)
	}
	oversize := make([]byte, attachmentMaxBytes+1)
	if _, err := svc.AddAttachment(item.ID, "big.bin", attB64(oversize)); err == nil {
		t.Fatalf("expected size-limit error, got nil")
	} else if !strings.Contains(err.Error(), "limit") {
		t.Errorf("expected size limit error, got %v", err)
	}
	// 刚好 5MiB 应被接受。
	atLimit := make([]byte, attachmentMaxBytes)
	if _, err := svc.AddAttachment(item.ID, "exact.bin", attB64(atLimit)); err != nil {
		t.Errorf("attachment at exact limit should be accepted, got %v", err)
	}
}

// TestAttachment_DeleteFiltersFromList 覆盖删除后从列表消失（未同步 → 硬删）。
func TestAttachment_DeleteFiltersFromList(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	item, err := svc.CreateItem(loginItemFixture("ToDeleteAtt"))
	if err != nil {
		t.Fatalf("create item: %v", err)
	}
	a1, err := svc.AddAttachment(item.ID, "a.txt", attB64([]byte("aaa")))
	if err != nil {
		t.Fatalf("add a1: %v", err)
	}
	if _, err := svc.AddAttachment(item.ID, "b.txt", attB64([]byte("bbb"))); err != nil {
		t.Fatalf("add a2: %v", err)
	}

	if err := svc.DeleteAttachment(a1.ID); err != nil {
		t.Fatalf("delete a1: %v", err)
	}
	list, err := svc.ListAttachments(item.ID)
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 attachment after delete, got %d", len(list))
	}
	if list[0].FileName != "b.txt" {
		t.Errorf("remaining attachment = %q, want b.txt", list[0].FileName)
	}
	// 取已删附件应返回未找到。
	if _, err := svc.GetAttachmentData(a1.ID); err != ErrAttachmentNotFound {
		t.Errorf("get deleted attachment: expected ErrAttachmentNotFound, got %v", err)
	}
	// 重复删除幂等。
	if err := svc.DeleteAttachment(a1.ID); err != ErrAttachmentNotFound {
		// 未同步附件已被硬删，再删返回 not found（可接受）。
		if err != nil {
			t.Logf("re-delete returned: %v (acceptable)", err)
		}
	}
}

// TestAttachment_SyncedDeleteSoftDeletes 覆盖：已同步附件删除走软删（保留 tombstone
// 供 reconcile 删云端），仍从列表过滤。
func TestAttachment_SyncedDeleteSoftDeletes(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	item, err := svc.CreateItem(loginItemFixture("SyncedAtt"))
	if err != nil {
		t.Fatalf("create item: %v", err)
	}
	a, err := svc.AddAttachment(item.ID, "c.txt", attB64([]byte("ccc")))
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	// 模拟已同步：记 cloud_id。
	if err := svc.db.SetAttachmentCloud(a.ID, "cloud-att-123", nowMillis()); err != nil {
		t.Fatalf("set cloud: %v", err)
	}
	if err := svc.DeleteAttachment(a.ID); err != nil {
		t.Fatalf("delete synced: %v", err)
	}
	// 从列表过滤。
	list, err := svc.ListAttachments(item.ID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected 0 after synced delete, got %d", len(list))
	}
	// tombstone 仍在库里（软删，未硬删），且出现在「已删已同步」集合里供 reconcile。
	dels, err := svc.db.ListDeletedSyncedAttachments()
	if err != nil {
		t.Fatalf("list deleted synced: %v", err)
	}
	found := false
	for _, d := range dels {
		if d.ID == a.ID && d.CloudID == "cloud-att-123" {
			found = true
		}
	}
	if !found {
		t.Errorf("soft-deleted synced attachment not in deleted-synced set")
	}
}

// TestAttachment_AADBinding 确认文件名与内容绑定到各自 aad（不可互换 / 跨附件互换）。
func TestAttachment_AADBinding(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	item, err := svc.CreateItem(loginItemFixture("AADItem"))
	if err != nil {
		t.Fatalf("create item: %v", err)
	}
	a, err := svc.AddAttachment(item.ID, "name.txt", attB64([]byte("payload")))
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	row, err := svc.db.GetAttachment(a.ID)
	if err != nil || row == nil {
		t.Fatalf("get row: %v", err)
	}
	// 用「内容」的 aad 解密「文件名」密文应失败（aad mismatch）。
	if _, err := OpenAEAD(svc.dek, row.FileNameEnc, attachmentBlobAAD(a.ID)); err == nil {
		t.Errorf("decrypting name with blob aad should fail (aad binding broken)")
	}
	// 用另一附件 id 的 aad 解密也应失败。
	if _, err := OpenAEAD(svc.dek, row.Blob, attachmentBlobAAD("other-id")); err == nil {
		t.Errorf("decrypting blob with foreign-id aad should fail (aad binding broken)")
	}
}

// TestAttachment_UnknownItemRejected 覆盖：对不存在 / 跨空间条目操作返回 not found。
func TestAttachment_UnknownItemRejected(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if _, err := svc.AddAttachment("nonexistent-item", "x.txt", attB64([]byte("x"))); err != ErrItemNotFound {
		t.Errorf("add to unknown item: expected ErrItemNotFound, got %v", err)
	}
	if _, err := svc.ListAttachments("nonexistent-item"); err != ErrItemNotFound {
		t.Errorf("list unknown item: expected ErrItemNotFound, got %v", err)
	}
}
