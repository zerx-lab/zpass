package services

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"testing"
)

// 真实 Bitwarden 导出向量（Google 账户的 passkey），用作回归锚点。
// credentialId 是 Bitwarden 的 GUID 形式，其 16 原始字节的 base64url 即 WebAuthn rawId。
const (
	bwGoogleCredentialGUID = "f560a393-5193-4df8-8b88-c1cf6ef0dffc"
	bwGoogleCredentialB64  = "9WCjk1GTTfiLiMHPbvDf_A"
	bwGoogleKeyValue       = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgj-EiH4ULi4YkX_YH9tvSibR3qc9vbz6EEIB78bqDnEOhRANCAARAxOKQs2xvo_-uVzMSjHwSGv4fHYMN46cIVus27JIxACYVAdJmNUaV5SI09jm3eXVl7WugUbjW9vk7KCvkv4Zo"
	bwGoogleUserHandle     = "R09PR0xFX0FDQ09VTlQ6MTE1NTkzNzc5MzIxODI3Nzk0NzMy"
)

// bwGooglePasskeyFields 复刻 import-bitwarden.ts 中 mapPasskeys 对 Google 凭证产出
// 的字段袋（signCount 以 JSON number → float64 形式到达 Go）。
func bwGooglePasskeyFields() map[string]any {
	return map[string]any{
		"rpId":            "google.com",
		"rpName":          "Google",
		"userName":        "clown166997982@gmail.com",
		"userId":          bwGoogleUserHandle,
		"credentialId":    bwGoogleCredentialGUID,
		"privateKeyPkcs8": bwGoogleKeyValue,
		"signCount":       float64(0),
		"residentKey":     true,
	}
}

func TestCompleteImportedPasskeyBitwardenGoogleVector(t *testing.T) {
	fields := bwGooglePasskeyFields()
	if err := completeImportedPasskey(fields); err != nil {
		t.Fatalf("completeImportedPasskey: %v", err)
	}

	if got := fields["credentialId"]; got != bwGoogleCredentialB64 {
		t.Fatalf("credentialId = %v, want %s", got, bwGoogleCredentialB64)
	}
	if got := fields["rpId"]; got != "google.com" {
		t.Fatalf("rpId = %v, want google.com", got)
	}
	if cose, _ := fields["publicKeyCose"].(string); cose == "" {
		t.Fatal("publicKeyCose not derived")
	}
	if spki, _ := fields["publicKeySpki"].(string); spki == "" {
		t.Fatal("publicKeySpki not derived")
	}
	if fields["algorithm"] != passkeyAlgES256 {
		t.Fatalf("algorithm = %v, want %s", fields["algorithm"], passkeyAlgES256)
	}
	if fields["coseAlgorithm"] != passkeyCOSEAlgES256 {
		t.Fatalf("coseAlgorithm = %v, want %d", fields["coseAlgorithm"], passkeyCOSEAlgES256)
	}
	if fields["signCount"] != int64(0) {
		t.Fatalf("signCount = %v (%T), want int64(0)", fields["signCount"], fields["signCount"])
	}

	// userId 规范化后应能解回原始 user handle。
	uid, _ := fields["userId"].(string)
	raw, err := base64.RawURLEncoding.DecodeString(uid)
	if err != nil {
		t.Fatalf("userId is not base64url: %v", err)
	}
	if string(raw) != "GOOGLE_ACCOUNT:115593779321827794732" {
		t.Fatalf("userId handle = %q", string(raw))
	}

	assertDerivedKeypair(t, fields)
}

// assertDerivedKeypair 证明派生出的公钥与私钥成对：用私钥签名，用派生公钥验签。
// 这正是 RP（Google）登录时验证断言所依赖的关系。
func assertDerivedKeypair(t *testing.T, fields map[string]any) {
	t.Helper()
	privDER, err := base64.RawURLEncoding.DecodeString(fields["privateKeyPkcs8"].(string))
	if err != nil {
		t.Fatalf("decode privateKeyPkcs8: %v", err)
	}
	pk, err := x509.ParsePKCS8PrivateKey(privDER)
	if err != nil {
		t.Fatalf("parse private key: %v", err)
	}
	priv := pk.(*ecdsa.PrivateKey)

	pubDER, err := base64.RawURLEncoding.DecodeString(fields["publicKeySpki"].(string))
	if err != nil {
		t.Fatalf("decode publicKeySpki: %v", err)
	}
	pub, err := x509.ParsePKIXPublicKey(pubDER)
	if err != nil {
		t.Fatalf("parse public key: %v", err)
	}

	digest := sha256.Sum256([]byte("zpass-passkey-import-roundtrip"))
	sig, err := ecdsa.SignASN1(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if !ecdsa.VerifyASN1(pub.(*ecdsa.PublicKey), digest[:], sig) {
		t.Fatal("derived public key does not match imported private key")
	}
}

// TestImportedPasskeyCreateListSign 走完整服务链路：通用 CreateItem 落库（触发
// completeImportedPasskey 补全）→ ListPasskeys 命中 → SignPasskeyAssertion 出可验证的断言。
func TestImportedPasskeyCreateListSign(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("passkey-import-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	summary, err := svc.CreateItem(ItemPayload{
		Type:   ItemTypePasskey,
		Name:   "Google (clown166997982@gmail.com)",
		Fields: bwGooglePasskeyFields(),
	})
	if err != nil {
		t.Fatalf("create imported passkey: %v", err)
	}

	descs, err := svc.ListPasskeys("google.com")
	if err != nil {
		t.Fatalf("list passkeys: %v", err)
	}
	if len(descs) != 1 || descs[0].CredentialID != bwGoogleCredentialB64 {
		t.Fatalf("descriptors = %+v, want one with credentialId %s", descs, bwGoogleCredentialB64)
	}

	cred, err := svc.GetPasskey(summary.ID)
	if err != nil {
		t.Fatalf("get passkey: %v", err)
	}
	if cred.PublicKeySPKI == "" || cred.PublicKeyCOSE == "" {
		t.Fatalf("imported passkey missing public keys: %+v", cred)
	}

	clientHash := sha256.Sum256([]byte("imported-client-data"))
	assertion, err := svc.SignPasskeyAssertion(PasskeyAssertionRequest{
		RPID:           "google.com",
		CredentialID:   bwGoogleCredentialB64,
		ClientDataHash: b64Test(clientHash[:]),
	})
	if err != nil {
		t.Fatalf("sign imported passkey assertion: %v", err)
	}
	if assertion.SignCount != 1 {
		t.Fatalf("signCount = %d, want 1", assertion.SignCount)
	}
	verifyPasskeyAssertion(t, cred, assertion, clientHash[:], 1)
}

// TestCompleteImportedPasskeyAcceptsBase64CredentialAndStringCount 覆盖非 GUID 分支
// （credentialId 已是 base64url）与 Bitwarden 把 counter 存成字符串的情况。
func TestCompleteImportedPasskeyAcceptsBase64CredentialAndStringCount(t *testing.T) {
	fields := bwGooglePasskeyFields()
	fields["credentialId"] = bwGoogleCredentialB64 // 已是 base64url，非 GUID
	fields["signCount"] = "7"                       // Bitwarden 把 counter 存为字符串

	if err := completeImportedPasskey(fields); err != nil {
		t.Fatalf("completeImportedPasskey: %v", err)
	}
	if fields["credentialId"] != bwGoogleCredentialB64 {
		t.Fatalf("base64url credentialId changed: %v", fields["credentialId"])
	}
	if fields["signCount"] != int64(7) {
		t.Fatalf("signCount = %v (%T), want int64(7)", fields["signCount"], fields["signCount"])
	}
}

func TestCompleteImportedPasskeyRejectsMissingKey(t *testing.T) {
	err := completeImportedPasskey(map[string]any{
		"rpId":         "google.com",
		"credentialId": bwGoogleCredentialGUID,
	})
	if err == nil {
		t.Fatal("expected error for passkey item with no key material")
	}
}
