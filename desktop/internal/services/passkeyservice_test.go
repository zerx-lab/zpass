package services

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPasskeyCreateListAndEncryptedStorage(t *testing.T) {
	home := withTempHome(t)
	db, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open vault db: %v", err)
	}
	svc := NewVaultService(db)
	if err := svc.Initialize("passkey-test-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	cred, err := svc.CreatePasskey(PasskeyRegistrationRequest{
		RPID:            "Passkey-Secret-RP.example",
		RPName:          "Secret Passkey RP",
		UserName:        "passkey-user-marker@example.com",
		UserDisplayName: "Passkey User Marker",
		Name:            "Passkey Item Marker",
	})
	if err != nil {
		t.Fatalf("create passkey: %v", err)
	}
	if cred.ItemID == "" || cred.CredentialID == "" {
		t.Fatalf("missing ids in credential: %+v", cred)
	}
	if cred.RPID != "passkey-secret-rp.example" {
		t.Fatalf("rp id was not normalized: %q", cred.RPID)
	}
	if cred.Algorithm != passkeyAlgES256 || cred.COSEAlgorithm != passkeyCOSEAlgES256 {
		t.Fatalf("unexpected passkey algorithm: %+v", cred)
	}
	if cred.AttestationObject == "" || cred.AuthenticatorData == "" {
		t.Fatalf("registration output missing attestation/authData: %+v", cred)
	}
	verifyPasskeyRegistrationAuthData(t, cred)

	summaries, err := svc.ListItems()
	if err != nil {
		t.Fatalf("list items: %v", err)
	}
	if len(summaries) != 1 || summaries[0].Type != ItemTypePasskey {
		t.Fatalf("expected one passkey summary, got %+v", summaries)
	}

	descs, err := svc.ListPasskeys("passkey-secret-rp.example")
	if err != nil {
		t.Fatalf("list passkeys: %v", err)
	}
	if len(descs) != 1 {
		t.Fatalf("expected one passkey descriptor, got %+v", descs)
	}
	if descs[0].CredentialID != cred.CredentialID || descs[0].ItemID != cred.ItemID {
		t.Fatalf("descriptor mismatch: got %+v want credential %s item %s", descs[0], cred.CredentialID, cred.ItemID)
	}

	got, err := svc.GetPasskey(cred.ItemID)
	if err != nil {
		t.Fatalf("get passkey: %v", err)
	}
	if got.PublicKeyCOSE == "" || got.PublicKeySPKI == "" {
		t.Fatalf("public key fields missing: %+v", got)
	}
	if got.AttestationObject != "" {
		t.Fatalf("stored public view should not keep one-time attestation object: %+v", got)
	}

	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}
	dir := filepath.Join(home, configRootDirname, appConfigDirname)
	corpus := readAllFilesForLeakScan(t, dir)
	for _, needle := range []string{
		"Passkey-Secret-RP.example",
		"passkey-secret-rp.example",
		"Secret Passkey RP",
		"passkey-user-marker@example.com",
		"Passkey User Marker",
		"Passkey Item Marker",
		cred.CredentialID,
	} {
		if bytes.Contains(corpus, []byte(needle)) {
			t.Fatalf("plaintext leakage: db files contain %q", needle)
		}
	}
}

func TestPasskeySignAssertionAndAdvanceCounter(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("passkey-sign-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	cred, err := svc.CreatePasskey(PasskeyRegistrationRequest{
		RPID:     "example.com",
		RPName:   "Example",
		UserName: "alice@example.com",
	})
	if err != nil {
		t.Fatalf("create passkey: %v", err)
	}

	clientHash := sha256.Sum256([]byte("client-data-json-marker"))
	assertion, err := svc.SignPasskeyAssertion(PasskeyAssertionRequest{
		RPID:           "example.com",
		CredentialID:   cred.CredentialID,
		ClientDataHash: b64Test(clientHash[:]),
	})
	if err != nil {
		t.Fatalf("sign passkey assertion: %v", err)
	}
	if assertion.SignCount != 1 {
		t.Fatalf("first signCount = %d, want 1", assertion.SignCount)
	}
	verifyPasskeyAssertion(t, cred, assertion, clientHash[:], 1)

	assertion2, err := svc.SignPasskeyAssertion(PasskeyAssertionRequest{
		RPID:           "example.com",
		CredentialID:   cred.CredentialID,
		ClientDataHash: b64Test(clientHash[:]),
	})
	if err != nil {
		t.Fatalf("sign passkey assertion second time: %v", err)
	}
	if assertion2.SignCount != 2 {
		t.Fatalf("second signCount = %d, want 2", assertion2.SignCount)
	}
	verifyPasskeyAssertion(t, cred, assertion2, clientHash[:], 2)

	stored, err := svc.GetPasskey(cred.ItemID)
	if err != nil {
		t.Fatalf("get passkey after sign: %v", err)
	}
	if stored.SignCount != 2 {
		t.Fatalf("stored signCount = %d, want 2", stored.SignCount)
	}

	if _, err := svc.SignPasskeyAssertion(PasskeyAssertionRequest{
		RPID:           "evil.example",
		CredentialID:   cred.CredentialID,
		ClientDataHash: b64Test(clientHash[:]),
	}); !errors.Is(err, ErrPasskeyNotFound) {
		t.Fatalf("wrong RP should hide credential, got %v", err)
	}
}

func TestPasskeyLockedAndInvalidInputs(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.Initialize("passkey-lock-master-password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	cred, err := svc.CreatePasskey(PasskeyRegistrationRequest{
		RPID:     "example.com",
		UserName: "alice@example.com",
	})
	if err != nil {
		t.Fatalf("create passkey: %v", err)
	}
	if _, err := svc.CreatePasskey(PasskeyRegistrationRequest{RPID: "https://example.com"}); err == nil {
		t.Fatal("expected invalid rpId error")
	}
	if _, err := svc.SignPasskeyAssertion(PasskeyAssertionRequest{
		RPID:           "example.com",
		CredentialID:   cred.CredentialID,
		ClientDataHash: b64Test([]byte("too short")),
	}); err == nil {
		t.Fatal("expected invalid clientDataHash length error")
	}

	if err := svc.Lock(); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if _, err := svc.ListPasskeys("example.com"); !errors.Is(err, ErrVaultLocked) {
		t.Fatalf("list while locked: expected ErrVaultLocked, got %v", err)
	}
	if _, err := svc.GetPasskey(cred.ItemID); !errors.Is(err, ErrVaultLocked) {
		t.Fatalf("get while locked: expected ErrVaultLocked, got %v", err)
	}
	clientHash := sha256.Sum256([]byte("client-data-json-marker"))
	if _, err := svc.SignPasskeyAssertion(PasskeyAssertionRequest{
		RPID:           "example.com",
		CredentialID:   cred.CredentialID,
		ClientDataHash: b64Test(clientHash[:]),
	}); !errors.Is(err, ErrVaultLocked) {
		t.Fatalf("sign while locked: expected ErrVaultLocked, got %v", err)
	}
}

func verifyPasskeyAssertion(t *testing.T, cred *PasskeyCredential, assertion *PasskeyAssertionResponse, clientHash []byte, wantCount uint32) {
	t.Helper()
	authData := decodeB64Test(t, assertion.AuthenticatorData)
	if len(authData) != 37 {
		t.Fatalf("assertion authData length = %d, want 37", len(authData))
	}
	rpHash := sha256.Sum256([]byte(cred.RPID))
	if !bytes.Equal(authData[:32], rpHash[:]) {
		t.Fatalf("rpId hash mismatch")
	}
	if gotFlags := authData[32]; gotFlags != passkeyFlagUserPresent|passkeyFlagUserVerified {
		t.Fatalf("flags = 0x%02x, want UP|UV", gotFlags)
	}
	if gotCount := binary.BigEndian.Uint32(authData[33:37]); gotCount != wantCount {
		t.Fatalf("authData signCount = %d, want %d", gotCount, wantCount)
	}

	pubDER := decodeB64Test(t, cred.PublicKeySPKI)
	parsed, err := x509.ParsePKIXPublicKey(pubDER)
	if err != nil {
		t.Fatalf("parse public key: %v", err)
	}
	pub, ok := parsed.(*ecdsa.PublicKey)
	if !ok {
		t.Fatalf("public key type = %T, want *ecdsa.PublicKey", parsed)
	}
	sigBase := append(append([]byte{}, authData...), clientHash...)
	digest := sha256.Sum256(sigBase)
	signature := decodeB64Test(t, assertion.Signature)
	if !ecdsa.VerifyASN1(pub, digest[:], signature) {
		t.Fatal("passkey assertion signature did not verify")
	}
}

func verifyPasskeyRegistrationAuthData(t *testing.T, cred *PasskeyCredential) {
	t.Helper()
	authData := decodeB64Test(t, cred.AuthenticatorData)
	if len(authData) <= 37+16+2 {
		t.Fatalf("registration authData too short: %d", len(authData))
	}
	rpHash := sha256.Sum256([]byte(cred.RPID))
	if !bytes.Equal(authData[:32], rpHash[:]) {
		t.Fatal("registration rpId hash mismatch")
	}
	wantFlags := passkeyFlagUserPresent | passkeyFlagUserVerified | passkeyFlagAttestedData
	if gotFlags := authData[32]; gotFlags != wantFlags {
		t.Fatalf("registration flags = 0x%02x, want 0x%02x", gotFlags, wantFlags)
	}
	if gotCount := binary.BigEndian.Uint32(authData[33:37]); gotCount != 0 {
		t.Fatalf("registration signCount = %d, want 0", gotCount)
	}
	for i, b := range authData[37:53] {
		if b != 0 {
			t.Fatalf("registration aaguid byte %d = %d, want zero", i, b)
		}
	}
	credID := decodeB64Test(t, cred.CredentialID)
	gotCredLen := int(binary.BigEndian.Uint16(authData[53:55]))
	if gotCredLen != len(credID) {
		t.Fatalf("credential id length = %d, want %d", gotCredLen, len(credID))
	}
	gotCredID := authData[55 : 55+gotCredLen]
	if !bytes.Equal(gotCredID, credID) {
		t.Fatal("registration credential id mismatch")
	}
	publicCOSE := decodeB64Test(t, cred.PublicKeyCOSE)
	if !bytes.Equal(authData[55+gotCredLen:], publicCOSE) {
		t.Fatal("registration COSE public key mismatch")
	}
	attObj := decodeB64Test(t, cred.AttestationObject)
	if len(attObj) == 0 || attObj[0] != 0xa3 {
		t.Fatalf("attestation object should be a 3-entry CBOR map, first byte 0x%02x", attObj[0])
	}
}

func readAllFilesForLeakScan(t *testing.T, dir string) []byte {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var corpus []byte
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		corpus = append(corpus, data...)
	}
	if len(corpus) == 0 {
		t.Fatal("no files found to scan")
	}
	return corpus
}

func b64Test(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeB64Test(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("decode base64url: %v", err)
	}
	return b
}
