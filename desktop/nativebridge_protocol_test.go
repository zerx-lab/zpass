package main

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
