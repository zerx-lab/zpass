package services

import (
	"crypto/sha256"
	"testing"
)

func TestNativePasskeyCreateListAndSign(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("native-passkey-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	created, err := nativeCreatePasskey(svc, passkeyCreateRequest{
		pageContext:     pageContext{Origin: "https://login.example.com"},
		RPID:            "example.com",
		RPName:          "Example",
		UserID:          b64Test([]byte("native-passkey-user")),
		UserName:        "alice@example.com",
		UserDisplayName: "Alice",
	})
	if err != nil {
		t.Fatalf("nativeCreatePasskey: %v", err)
	}
	if created.CredentialID == "" || created.AttestationObject == "" {
		t.Fatalf("created passkey missing registration material: %+v", created)
	}

	list, err := nativeListPasskeys(svc, passkeyListRequest{
		pageContext: pageContext{Origin: "https://login.example.com"},
		RPID:        "example.com",
	})
	if err != nil {
		t.Fatalf("nativeListPasskeys: %v", err)
	}
	if !list.Unlocked || len(list.Items) != 1 || list.Items[0].CredentialID != created.CredentialID {
		t.Fatalf("unexpected passkey list result: %+v", list)
	}

	clientHash := sha256.Sum256([]byte("native-client-data-json"))
	assertion, err := nativeSignPasskey(svc, passkeySignRequest{
		pageContext:    pageContext{Origin: "https://login.example.com"},
		RPID:           "example.com",
		CredentialID:   created.CredentialID,
		ClientDataHash: b64Test(clientHash[:]),
	})
	if err != nil {
		t.Fatalf("nativeSignPasskey: %v", err)
	}
	verifyPasskeyAssertion(t, created, assertion, clientHash[:], 1)

	if _, err := nativeDeletePasskey(svc, passkeyDeleteRequest{
		pageContext: pageContext{Origin: "https://evil.example"},
		RPID:        "example.com",
		ItemID:      created.ItemID,
	}); err == nil {
		t.Fatalf("nativeDeletePasskey accepted an unrelated origin")
	}

	deleted, err := nativeDeletePasskey(svc, passkeyDeleteRequest{
		pageContext: pageContext{Origin: "https://login.example.com"},
		RPID:        "example.com",
		ItemID:      created.ItemID,
	})
	if err != nil {
		t.Fatalf("nativeDeletePasskey: %v", err)
	}
	if !deleted.Deleted || deleted.ItemID != created.ItemID {
		t.Fatalf("unexpected delete result: %+v", deleted)
	}

	afterDelete, err := nativeListPasskeys(svc, passkeyListRequest{
		pageContext: pageContext{Origin: "https://login.example.com"},
		RPID:        "example.com",
	})
	if err != nil {
		t.Fatalf("nativeListPasskeys after delete: %v", err)
	}
	if len(afterDelete.Items) != 0 {
		t.Fatalf("expected passkey delete to remove item, got %+v", afterDelete.Items)
	}
}

func TestSafePasskeyRPID(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		rpID    string
		want    string
		wantErr bool
	}{
		{name: "exact https host", origin: "https://example.com", rpID: "example.com", want: "example.com"},
		{name: "subdomain can use parent rp", origin: "https://app.example.com", rpID: "example.com", want: "example.com"},
		{name: "default to origin host", origin: "https://example.com", want: "example.com"},
		{name: "localhost over http", origin: "http://localhost:3000", rpID: "localhost", want: "localhost"},
		{name: "loopback over http", origin: "http://127.0.0.1:8080", rpID: "127.0.0.1", want: "127.0.0.1"},
		{name: "reject unrelated rp", origin: "https://example.com", rpID: "evil.example", wantErr: true},
		{name: "reject insecure remote origin", origin: "http://example.com", rpID: "example.com", wantErr: true},
		{name: "reject url rp id", origin: "https://example.com", rpID: "https://example.com", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := safePasskeyRPID(pageContext{Origin: tt.origin}, tt.rpID)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("safePasskeyRPID() expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("safePasskeyRPID() error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("safePasskeyRPID()=%q, want %q", got, tt.want)
			}
		})
	}
}

// TestNativeCaptureAndSaveLoginFlow 走一遍「捕获 → 评估 → 保存 → 再捕获」全链路：
//   - 首次捕获 → status="new"
//   - saveLogin 以创建分支落库
//   - 同账密再捕获 → status="none" (已存在)
//   - 改密码再捕获 → status="update"
//   - saveLogin 以更新分支走、只改 password 不动 username/name
func TestNativeCaptureAndSaveLoginFlow(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("native-save-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	ctx := pageContext{Origin: "https://www.example.com", URL: "https://www.example.com/login"}

	// 1) 首次捕获——期待 new
	decision, err := evaluateCaptureLogin(svc, captureLoginRequest{
		pageContext: ctx,
		Username:    "alice@example.com",
		Password:    "hunter2",
	})
	if err != nil {
		t.Fatalf("evaluateCaptureLogin first: %v", err)
	}
	if decision.Status != "new" {
		t.Fatalf("first capture: want status=new, got %+v", decision)
	}

	// 2) saveLogin 创建新条目
	result, err := saveLogin(svc, saveLoginRequest{
		pageContext: ctx,
		Username:    "alice@example.com",
		Password:    "hunter2",
		Name:        "example.com",
	})
	if err != nil {
		t.Fatalf("saveLogin create: %v", err)
	}
	if !result.Created || result.ItemID == "" {
		t.Fatalf("saveLogin create: unexpected result %+v", result)
	}

	// 3) 同账密再捕获——期待 none
	decision, err = evaluateCaptureLogin(svc, captureLoginRequest{
		pageContext: ctx,
		Username:    "alice@example.com",
		Password:    "hunter2",
	})
	if err != nil {
		t.Fatalf("evaluateCaptureLogin same: %v", err)
	}
	if decision.Status != "none" {
		t.Fatalf("same capture: want status=none, got %+v", decision)
	}

	// 4) 同用名改密码再捕获——期待 update + ItemID 匹配
	decision, err = evaluateCaptureLogin(svc, captureLoginRequest{
		pageContext: ctx,
		Username:    "alice@example.com",
		Password:    "new-pass-v2",
	})
	if err != nil {
		t.Fatalf("evaluateCaptureLogin update: %v", err)
	}
	if decision.Status != "update" || decision.ItemID != result.ItemID {
		t.Fatalf("update capture: want update with %s, got %+v", result.ItemID, decision)
	}

	// 5) saveLogin 以更新分支走
	updated, err := saveLogin(svc, saveLoginRequest{
		pageContext: ctx,
		ItemID:      result.ItemID,
		Username:    "alice@example.com",
		Password:    "new-pass-v2",
	})
	if err != nil {
		t.Fatalf("saveLogin update: %v", err)
	}
	if updated.Created || updated.ItemID != result.ItemID {
		t.Fatalf("saveLogin update: want created=false, same id, got %+v", updated)
	}

	// 6) 最后检验 vault 里 password 确实被换了 + username/name 不动
	item, err := svc.GetItem(result.ItemID)
	if err != nil || item == nil {
		t.Fatalf("GetItem after update: %v", err)
	}
	if got := nativeFieldString(item.Fields, "password"); got != "new-pass-v2" {
		t.Fatalf("password after update: want new-pass-v2, got %q", got)
	}
	if got := nativeFieldString(item.Fields, "username"); got != "alice@example.com" {
		t.Fatalf("username after update should not change: got %q", got)
	}
	if item.Name != "example.com" {
		t.Fatalf("name after update should not change: got %q", item.Name)
	}
}

// TestEvaluateCaptureLogin_LockedVault 锁定状态下返 status=locked、
// 不踩 vault 读接口。
func TestEvaluateCaptureLogin_LockedVault(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("native-locked-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}

	decision, err := evaluateCaptureLogin(svc, captureLoginRequest{
		pageContext: pageContext{Origin: "https://example.com"},
		Username:    "u",
		Password:    "p",
	})
	if err != nil {
		t.Fatalf("evaluateCaptureLogin locked: %v", err)
	}
	if decision.Status != "locked" {
		t.Fatalf("locked: want status=locked, got %+v", decision)
	}
}

// TestEvaluateCaptureLogin_IgnoredOrigin 点过 Never 的 origin、该次不弹。
func TestEvaluateCaptureLogin_IgnoredOrigin(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("native-ignored-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	ctx := pageContext{Origin: "https://no-save.example.com"}
	if _, err := ignoreSaveOrigin(ignoreSaveOriginRequest{pageContext: ctx}); err != nil {
		t.Fatalf("ignoreSaveOrigin: %v", err)
	}

	decision, err := evaluateCaptureLogin(svc, captureLoginRequest{
		pageContext: ctx,
		Username:    "u",
		Password:    "p",
	})
	if err != nil {
		t.Fatalf("evaluateCaptureLogin ignored: %v", err)
	}
	if decision.Status != "none" {
		t.Fatalf("ignored: want status=none, got %+v", decision)
	}

	if !IsBrowserSaveIgnored("https://no-save.example.com") {
		t.Fatal("IsBrowserSaveIgnored should return true after ignoreSaveOrigin")
	}
}

// TestSaveLogin_CrossOriginUpdateRejected 探测越权　在 https://a.com 传
// 另一站 https://b.com 的 itemId 去改密码不能走通。
func TestSaveLogin_CrossOriginUpdateRejected(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("native-cross-origin-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	// 在 b.com 先存一个
	resB, err := saveLogin(svc, saveLoginRequest{
		pageContext: pageContext{Origin: "https://b.com"},
		Username:    "u",
		Password:    "p",
	})
	if err != nil {
		t.Fatalf("prep create b: %v", err)
	}

	// 伪装成 a.com 请求 update b 的 itemId
	_, err = saveLogin(svc, saveLoginRequest{
		pageContext: pageContext{Origin: "https://a.com"},
		ItemID:      resB.ItemID,
		Username:    "u",
		Password:    "hijacked",
	})
	if err == nil {
		t.Fatal("saveLogin cross-origin update should be rejected")
	}
}
