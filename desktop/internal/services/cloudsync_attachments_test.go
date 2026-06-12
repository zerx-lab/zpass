package services

// 附件云同步 wire aad 跨端兼容测试。验证桌面端上行/下行使用的 web_vault 约定
// ("<cloudItemID>:name" / "<cloudItemID>:file")自洽往返，且下行能回退解密旧的
// 空-aad 密文(迁移兼容)。

import (
	"bytes"
	"testing"

	"github.com/zerx-lab/zpass/internal/cloudcrypto"
)

// TestWireAttachmentAAD_Convention 锁定与 web_vault 一致的 aad 字节。
func TestWireAttachmentAAD_Convention(t *testing.T) {
	cloudID := "11112222-3333-4444-5555-666677778888"
	if got, want := string(wireAttachmentNameAAD(cloudID)), cloudID+":name"; got != want {
		t.Errorf("name aad = %q, want %q", got, want)
	}
	if got, want := string(wireAttachmentBlobAAD(cloudID)), cloudID+":file"; got != want {
		t.Errorf("blob aad = %q, want %q", got, want)
	}
}

// TestWireAttachment_NewConventionRoundTrip 覆盖新约定上行/下行往返,并确认
// name/file 两个 aad 不可互换(防张冠李戴)。
func TestWireAttachment_NewConventionRoundTrip(t *testing.T) {
	key := make([]byte, cloudcrypto.KeySize)
	for i := range key {
		key[i] = byte(i)
	}
	cloudID := "deadbeef-0000-1111-2222-333344445555"
	name := []byte("secret.txt")
	blob := []byte("hello attachment world\x00\x01\x02")

	nameCt, err := cloudcrypto.SealAEAD(key, name, wireAttachmentNameAAD(cloudID))
	if err != nil {
		t.Fatalf("seal name: %v", err)
	}
	blobCt, err := cloudcrypto.SealAEAD(key, blob, wireAttachmentBlobAAD(cloudID))
	if err != nil {
		t.Fatalf("seal blob: %v", err)
	}

	gotName, err := openWireAttachment(key, nameCt, wireAttachmentNameAAD(cloudID))
	if err != nil || !bytes.Equal(gotName, name) {
		t.Fatalf("open name: got %q err %v", gotName, err)
	}
	gotBlob, err := openWireAttachment(key, blobCt, wireAttachmentBlobAAD(cloudID))
	if err != nil || !bytes.Equal(gotBlob, blob) {
		t.Fatalf("open blob: got %q err %v", gotBlob, err)
	}

	// name 密文用 file aad 不应解出(且不应误中空-aad 回退)。
	if _, err := openWireAttachment(key, nameCt, wireAttachmentBlobAAD(cloudID)); err == nil {
		t.Errorf("name ciphertext decrypted under blob aad — aad binding broken")
	}
}

// TestAttachmentsAbsentRemotely 覆盖反向清理的判定:云端 list 缺失的已同步附件
// 被选中删除,仍在云端的保留。未同步(cloud_id 为空)与软删行不在 have 集合里,
// 由 AttachmentCloudIDs 的过滤保证(见 TestAttachment_RemoteDeletePurgesLocal)。
func TestAttachmentsAbsentRemotely(t *testing.T) {
	have := map[string]string{
		"cloud-a": "local-a",
		"cloud-b": "local-b",
	}
	remote := map[string]struct{}{"cloud-a": {}}
	gone := attachmentsAbsentRemotely(have, remote)
	if len(gone) != 1 || gone[0] != "local-b" {
		t.Errorf("gone = %v, want [local-b]", gone)
	}
	// 云端清空:所有已同步附件都应清理。
	if gone := attachmentsAbsentRemotely(have, map[string]struct{}{}); len(gone) != 2 {
		t.Errorf("empty remote: gone = %v, want both locals", gone)
	}
	if gone := attachmentsAbsentRemotely(nil, nil); len(gone) != 0 {
		t.Errorf("empty have: gone = %v, want none", gone)
	}
}

// TestAttachment_RemoteDeletePurgesLocal 在真实 DB 上覆盖云端删除收敛链路:
// AttachmentCloudIDs 只含「活动且已同步」行(未 push 与软删行不参与反向清理),
// 据空的云端集合清理后,已同步附件被硬删,未同步附件保留。
func TestAttachment_RemoteDeletePurgesLocal(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	item, err := svc.CreateItem(loginItemFixture("RemoteDelete"))
	if err != nil {
		t.Fatalf("create item: %v", err)
	}
	synced, err := svc.AddAttachment(item.ID, "synced.txt", attB64([]byte("synced")))
	if err != nil {
		t.Fatalf("add synced attachment: %v", err)
	}
	unsynced, err := svc.AddAttachment(item.ID, "unsynced.txt", attB64([]byte("unsynced")))
	if err != nil {
		t.Fatalf("add unsynced attachment: %v", err)
	}
	if err := svc.db.SetAttachmentCloud(synced.ID, "cloud-synced", 1000); err != nil {
		t.Fatalf("set cloud id: %v", err)
	}

	have, err := svc.db.AttachmentCloudIDs(item.ID)
	if err != nil {
		t.Fatalf("attachment cloud ids: %v", err)
	}
	if len(have) != 1 || have["cloud-synced"] != synced.ID {
		t.Fatalf("have = %v, want only cloud-synced→%s", have, synced.ID)
	}

	// 云端已删光:反向清理应只删已同步行。
	for _, localID := range attachmentsAbsentRemotely(have, map[string]struct{}{}) {
		if err := svc.db.DeleteAttachmentRow(localID); err != nil {
			t.Fatalf("purge: %v", err)
		}
	}
	list, err := svc.ListAttachments(item.ID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].ID != unsynced.ID {
		t.Errorf("after purge list = %+v, want only unsynced %s", list, unsynced.ID)
	}
}

// TestWireAttachment_EmptyAADFallback 覆盖迁移回退:旧空-aad 密文下行仍可解密。
func TestWireAttachment_EmptyAADFallback(t *testing.T) {
	key := make([]byte, cloudcrypto.KeySize)
	cloudID := "deadbeef-0000-1111-2222-333344445555"
	plain := []byte("legacy empty-aad blob")

	// 模拟旧桌面端:空 aad 封装。
	legacyCt, err := cloudcrypto.SealAEAD(key, plain, nil)
	if err != nil {
		t.Fatalf("seal legacy: %v", err)
	}

	// 下行先按新约定(会失败),再回退空 aad(成功)。
	got, err := openWireAttachment(key, legacyCt, wireAttachmentBlobAAD(cloudID))
	if err != nil {
		t.Fatalf("legacy fallback open: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Errorf("legacy fallback content = %q, want %q", got, plain)
	}
}
