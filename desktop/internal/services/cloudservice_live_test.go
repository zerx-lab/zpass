package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zerx-lab/zpass/internal/cloud"
	"github.com/zerx-lab/zpass/internal/cloudcrypto"
)

// TestCloudLiveRoundTrip is the P2 verification gate: it drives the full cloud
// account + crypto chain against a RUNNING server (default http://localhost:8080,
// override with ZPASS_CLOUD_BASE_URL). It is skipped unless ZPASS_CLOUD_LIVE=1
// so the normal `go test ./...` stays hermetic.
//
// What it proves end-to-end (none of which a unit KAT can catch):
//   - register → keyset upload (AUK-wrapped private key, aad="zpass-keyset-priv-v1")
//   - a SECOND CloudService signs in with the same credentials, runs SRP-6a,
//     verifies the server M2, and recovers the private key via the derived AUK
//     (proves srp_salt feeds both DeriveSRPx and the M1 transcript, identity =
//     lowercased email, and the keyset AAD all match the server byte-for-byte)
//   - vault create (sealed-box wrap of the vault key) and member/self unwrap
//   - a single /changes push and a /snapshot pull that decrypts the item —
//     specifically exercising the item_id-as-AEAD-aad canonicalization (the
//     server round-trips item_id through a Postgres UUID, so the pulled id comes
//     back hyphenated and MUST be canonicalized before use as the aad).
func TestCloudLiveRoundTrip(t *testing.T) {
	if os.Getenv("ZPASS_CLOUD_LIVE") != "1" {
		t.Skip("set ZPASS_CLOUD_LIVE=1 (and run the cloud server) to exercise the live round-trip")
	}
	baseURL := os.Getenv("ZPASS_CLOUD_BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	if !serverReachable(baseURL) {
		t.Fatalf("cloud server not reachable at %s", baseURL)
	}

	email := uniqueEmail(t)
	const masterPassword = "correct horse battery staple"

	// --- Device 1: register ------------------------------------------------
	dev1 := NewCloudService(nil)
	if err := dev1.Configure(baseURL); err != nil {
		t.Fatalf("configure: %v", err)
	}
	reg, err := dev1.Register(email, masterPassword)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if reg.SecretKey == "" || !reg.SignedIn {
		t.Fatalf("register result incomplete: %+v", reg)
	}
	if err := cloudcrypto.ValidateSecretKey(reg.SecretKey); err != nil {
		t.Fatalf("generated secret key invalid: %v", err)
	}
	t.Logf("registered %s account=%s", email, reg.AccountID)

	// --- Device 2: sign in with the same credentials -----------------------
	dev2 := NewCloudService(nil)
	if err := dev2.Configure(baseURL); err != nil {
		t.Fatalf("dev2 configure: %v", err)
	}
	acct, err := dev2.SignIn(email, masterPassword, reg.SecretKey)
	if err != nil {
		t.Fatalf("device-2 sign in (full SRP + keyset recovery): %v", err)
	}
	if !acct.SignedIn || acct.AccountID != reg.AccountID {
		t.Fatalf("device-2 account mismatch: %+v vs %s", acct, reg.AccountID)
	}

	// Wrong password must be rejected at SRP (M1) — proves the server actually
	// verifies the proof rather than accepting any login.
	dev3 := NewCloudService(nil)
	_ = dev3.Configure(baseURL)
	if _, err := dev3.SignIn(email, "wrong password entirely", reg.SecretKey); err == nil {
		t.Fatalf("sign in with wrong password unexpectedly succeeded")
	}

	// --- Vault create + item push (device 1), pull + decrypt (device 2) -----
	// Both devices are the same account, so device 2's member/self unwrap must
	// reproduce device 1's vault key byte-for-byte.
	dev1.mu.RLock()
	priv1, pub1 := dev1.session.priv, dev1.session.pub
	token1 := dev1.session.token
	dev1.mu.RUnlock()
	dev2.mu.RLock()
	priv2 := dev2.session.priv
	token2 := dev2.session.token
	dev2.mu.RUnlock()

	c1 := cloud.NewClient(baseURL, nil)
	c1.SetToken(token1)
	c2 := cloud.NewClient(baseURL, nil)
	c2.SetToken(token2)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	vaultKey := mustRandom(t, 32)
	wrapped, err := cloudcrypto.SealToPubkey(pub1[:], vaultKey)
	if err != nil {
		t.Fatalf("wrap vault key: %v", err)
	}
	createResp, err := c1.CreateVault(ctx, cloud.CreateVaultRequest{
		WrappedVaultKey: cloudB64.EncodeToString(wrapped),
	})
	if err != nil {
		t.Fatalf("create vault: %v", err)
	}
	vaultID := createResp.VaultID
	t.Logf("created vault %s", vaultID)

	// Device 2 fetches and unwraps the same vault key.
	wrappedSelf, err := c2.GetVaultMemberSelf(ctx, vaultID)
	if err != nil {
		t.Fatalf("device-2 member/self: %v", err)
	}
	wrappedSelfBytes, _ := cloudB64.DecodeString(wrappedSelf)
	vaultKey2, err := cloudcrypto.OpenWithPrivkey(priv2[:], wrappedSelfBytes)
	if err != nil {
		t.Fatalf("device-2 unwrap vault key: %v", err)
	}
	if string(vaultKey2) != string(vaultKey) {
		t.Fatalf("vault key mismatch across devices")
	}
	_ = priv1

	// Device 1 pushes one item. item_id is the desktop-canonical hyphenless hex
	// (matches VaultService.newItemID); aad is that exact string's bytes.
	itemID := canonicalItemIDHex(mustRandom(t, 16))
	plaintext := []byte(fmt.Sprintf(`{"type":"login","name":"live-%d","fields":{"u":"a","p":"b"}}`, time.Now().UnixNano()))
	ct, err := cloudcrypto.SealAEAD(vaultKey, plaintext, []byte(itemID))
	if err != nil {
		t.Fatalf("seal item: %v", err)
	}
	pushResp, err := c1.PostChange(ctx, vaultID, cloud.ChangeRequest{
		ItemID:           itemID,
		BaseSeq:          0,
		UpdatedAt:        time.Now().UnixMilli(),
		Revision:         1,
		Ciphertext:       cloudB64.EncodeToString(ct),
		ContentHash:      "deadbeefdeadbeef",
		ClientMutationID: canonicalUUID(mustRandom(t, 16)),
	})
	if err != nil {
		t.Fatalf("push change: %v", err)
	}
	if pushResp.IsConflict() {
		t.Fatalf("unexpected conflict on first push: %+v", pushResp)
	}
	t.Logf("pushed item %s -> seq %d", itemID, pushResp.AssignedSeq)

	// Device 2 pulls the snapshot and decrypts. The server returns item_id as a
	// Postgres UUID (hyphenated), so we MUST canonicalize before using it as the
	// aad — this is the silent-failure pin the dossier flagged.
	snap, err := c2.Snapshot(ctx, vaultID, 0, 100, false)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	var found *cloud.SnapshotItem
	for i := range snap.Items {
		if canonicalizeItemID(snap.Items[i].ItemID) == itemID {
			found = &snap.Items[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("pushed item not in snapshot (%d items); item_id forms: %v", len(snap.Items), itemIDForms(snap.Items))
	}
	pulledCT, _ := cloudB64.DecodeString(found.Ciphertext)
	got, err := cloudcrypto.OpenAEAD(vaultKey2, pulledCT, []byte(canonicalizeItemID(found.ItemID)))
	if err != nil {
		t.Fatalf("decrypt pulled item (aad canonicalization?): %v", err)
	}
	if string(got) != string(plaintext) {
		t.Fatalf("decrypted payload mismatch:\n got=%s\nwant=%s", got, plaintext)
	}
	t.Logf("device-2 decrypted pulled item OK (server returned id=%q, canonical=%q)", found.ItemID, canonicalizeItemID(found.ItemID))
}

// TestCloudRestoreSessionLive proves the "stay signed in across restart" loop:
// a sign-in persists the email + Secret Key to the OS keychain, and a FRESH
// CloudService (simulating a process/device restart, where the in-memory account
// private key is gone) rebuilds a full live session from ONLY the master
// password via RestoreSession. This is the fix for "every sync needs a re-login".
//
// It uses 127.0.0.1 (not localhost) so its keychain slots — keyed by a hash of
// the server origin — never collide with a developer's real localhost:8080
// credentials, and it SignOut()s at the end to delete the slots it created.
func TestCloudRestoreSessionLive(t *testing.T) {
	if os.Getenv("ZPASS_CLOUD_LIVE") != "1" {
		t.Skip("set ZPASS_CLOUD_LIVE=1 (and run the cloud server) to exercise restore-session")
	}
	// Deliberately 127.0.0.1 to isolate the keychain namespace from localhost.
	baseURL := "http://127.0.0.1:8080"
	if !serverReachable(baseURL) {
		t.Fatalf("cloud server not reachable at %s", baseURL)
	}

	email := uniqueEmail(t)
	const masterPassword = "correct horse battery staple"

	// --- Sign-in device: register (persists token + email + Secret Key) ------
	dev1 := NewCloudService(nil)
	if err := dev1.Configure(baseURL); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if !dev1.store.Available() {
		t.Skip("OS keychain unavailable; RestoreSession has nothing to persist to")
	}
	reg, err := dev1.Register(email, masterPassword)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	// Clean up the keychain slots this test created, regardless of outcome.
	defer func() { _ = dev1.SignOut() }()

	// The credentials must actually be in the keychain now.
	if v, ok, _ := dev1.store.Get(credStoreKey("email-", baseURL)); !ok || v != email {
		t.Fatalf("email not persisted to keychain: ok=%v v=%q", ok, v)
	}
	if v, ok, _ := dev1.store.Get(credStoreKey("sk-", baseURL)); !ok || v == "" {
		t.Fatalf("secret key not persisted to keychain: ok=%v", ok)
	}

	// --- Restart: a fresh service has NO in-memory session ------------------
	dev2 := NewCloudService(nil)
	if err := dev2.Configure(baseURL); err != nil {
		t.Fatalf("dev2 configure: %v", err)
	}
	if st := dev2.Status(); st.SignedIn {
		t.Fatalf("fresh service should not be signed in before RestoreSession: %+v", st)
	}

	// RestoreSession with ONLY the master password rebuilds the full session.
	acct, err := dev2.RestoreSession(masterPassword)
	if err != nil {
		t.Fatalf("restore session: %v", err)
	}
	if !acct.SignedIn || acct.AccountID != reg.AccountID {
		t.Fatalf("restore mismatch: %+v vs %s", acct, reg.AccountID)
	}
	dev2.mu.RLock()
	haveSession := dev2.session != nil
	dev2.mu.RUnlock()
	if !haveSession {
		t.Fatalf("RestoreSession returned SignedIn but left session nil")
	}
	if st := dev2.Status(); !st.SignedIn {
		t.Fatalf("Status should report signedIn after RestoreSession: %+v", st)
	}
	t.Logf("restore-session OK: rebuilt live session for %s from master password alone", email)

	// --- Wrong master password must NOT restore (creds present, mp wrong) ----
	dev3 := NewCloudService(nil)
	_ = dev3.Configure(baseURL)
	if _, err := dev3.RestoreSession("a totally different password"); err == nil {
		t.Fatalf("RestoreSession with wrong master password unexpectedly succeeded")
	}

	// --- After SignOut, RestoreSession is a silent no-op (creds deleted) ----
	if err := dev2.SignOut(); err != nil {
		t.Fatalf("sign out: %v", err)
	}
	dev4 := NewCloudService(nil)
	_ = dev4.Configure(baseURL)
	acct4, err := dev4.RestoreSession(masterPassword)
	if err != nil {
		t.Fatalf("restore after signout should be a no-op, got error: %v", err)
	}
	if acct4.SignedIn {
		t.Fatalf("restore after signout should not sign in: %+v", acct4)
	}
}

// TestCloudRestoreSessionDifferentPasswordLive is the regression for the exact
// failure observed in the field: the local vault unlock password differs from
// the cloud account password, so signing the cloud session back in with the
// TYPED unlock password returns 401. The fix DEK-wraps the cloud password at
// sign-in; RestoreSession decrypts it after local unlock and authenticates with
// the REAL cloud password — independent of the local one.
func TestCloudRestoreSessionDifferentPasswordLive(t *testing.T) {
	if os.Getenv("ZPASS_CLOUD_LIVE") != "1" {
		t.Skip("set ZPASS_CLOUD_LIVE=1 (and run the cloud server) to exercise restore-session")
	}
	baseURL := "http://127.0.0.1:8080"
	if !serverReachable(baseURL) {
		t.Fatalf("cloud server not reachable at %s", baseURL)
	}

	const localPassword = "local vault password" // openUnlockedVault uses this
	const cloudPassword = "a-completely-different-cloud-password-9!"
	if localPassword == cloudPassword {
		t.Fatal("test setup: passwords must differ")
	}

	vault := openUnlockedVault(t, "personal")

	dev1 := NewCloudService(vault)
	if err := dev1.Configure(baseURL); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if !dev1.store.Available() {
		t.Skip("OS keychain unavailable")
	}
	email := uniqueEmail(t)
	reg, err := dev1.Register(email, cloudPassword)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer func() { _ = dev1.SignOut() }()

	// The DEK-wrapped cloud password must have been persisted.
	if v, ok, _ := dev1.store.Get(credStoreKey("pw-", baseURL)); !ok || v == "" {
		t.Fatalf("DEK-wrapped cloud password not persisted: ok=%v", ok)
	}

	// Sanity: the local password is genuinely NOT a valid cloud credential.
	probe := NewCloudService(nil)
	_ = probe.Configure(baseURL)
	if _, err := probe.SignIn(email, localPassword, reg.SecretKey); err == nil {
		t.Fatalf("local password unexpectedly authenticated as the cloud password")
	}

	// --- Restart: fresh CloudService, same unlocked vault (DEK recovered) ----
	dev2 := NewCloudService(vault)
	if err := dev2.Configure(baseURL); err != nil {
		t.Fatalf("dev2 configure: %v", err)
	}
	if dev2.Status().SignedIn {
		t.Fatalf("fresh service should not be signed in before RestoreSession")
	}

	// RestoreSession is handed the LOCAL unlock password (what the user types),
	// which is NOT the cloud password — yet it must succeed via the DEK-wrapped
	// cloud password.
	acct, err := dev2.RestoreSession(localPassword)
	if err != nil {
		t.Fatalf("restore session with DEK-wrapped cloud password: %v", err)
	}
	if !acct.SignedIn || acct.AccountID != reg.AccountID {
		t.Fatalf("restore mismatch: %+v vs %s", acct, reg.AccountID)
	}
	t.Logf("restore-session OK across DIFFERENT local/cloud passwords for %s", email)
}

// TestCloudBindRemoteVaultLive exercises the "choose which cloud spaces to sync"
// feature: list the account's cloud vaults with their local binding status, then
// bind an existing vault to a (different) local space — the inverse of creating
// a fresh vault. Verifies the 1:1 binding guards too.
func TestCloudBindRemoteVaultLive(t *testing.T) {
	if os.Getenv("ZPASS_CLOUD_LIVE") != "1" {
		t.Skip("set ZPASS_CLOUD_LIVE=1 (and run the cloud server) to exercise remote-vault binding")
	}
	baseURL := "http://127.0.0.1:8080"
	if !serverReachable(baseURL) {
		t.Fatalf("cloud server not reachable at %s", baseURL)
	}

	vault := openUnlockedVault(t, "spaceA")
	dev := NewCloudService(vault)
	if err := dev.Configure(baseURL); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if !dev.store.Available() {
		t.Skip("OS keychain unavailable")
	}
	email := uniqueEmail(t)
	if _, err := dev.Register(email, "cloud-bind-password-123"); err != nil {
		t.Fatalf("register: %v", err)
	}
	defer func() { _ = dev.SignOut() }()

	// Provision a cloud vault bound to spaceA.
	vid, err := dev.CreateCloudVault("spaceA", "Space A", "", "")
	if err != nil {
		t.Fatalf("create cloud vault: %v", err)
	}

	findVault := func(vaults []RemoteVault) *RemoteVault {
		for i := range vaults {
			if vaults[i].VaultID == vid {
				return &vaults[i]
			}
		}
		return nil
	}

	// ListRemoteVaults: the vault appears, bound to spaceA.
	vaults, err := dev.ListRemoteVaults()
	if err != nil {
		t.Fatalf("list remote vaults: %v", err)
	}
	if rv := findVault(vaults); rv == nil {
		t.Fatalf("created vault %s not in remote list", vid)
	} else if rv.BoundSpaceID != "spaceA" {
		t.Fatalf("expected bound to spaceA, got %q", rv.BoundSpaceID)
	}

	// Unlink → now unbound.
	if err := dev.UnlinkSpace("spaceA"); err != nil {
		t.Fatalf("unlink: %v", err)
	}
	vaults, _ = dev.ListRemoteVaults()
	if rv := findVault(vaults); rv == nil || rv.BoundSpaceID != "" {
		t.Fatalf("expected unbound after unlink, got %+v", rv)
	}

	// Bind the EXISTING vault to a different local space.
	if err := dev.BindCloudVault("spaceB", vid); err != nil {
		t.Fatalf("bind existing vault: %v", err)
	}
	vaults, _ = dev.ListRemoteVaults()
	if rv := findVault(vaults); rv == nil || rv.BoundSpaceID != "spaceB" {
		t.Fatalf("expected bound to spaceB, got %+v", rv)
	}

	// Re-binding the same pair is a no-op; binding the vault to ANOTHER space errors.
	if err := dev.BindCloudVault("spaceB", vid); err != nil {
		t.Fatalf("idempotent re-bind should succeed: %v", err)
	}
	if err := dev.BindCloudVault("spaceC", vid); err == nil {
		t.Fatalf("binding an already-bound vault to another space should fail")
	}
	t.Logf("remote-vault bind OK: vault %s rebound across spaces", vid)
}

func serverReachable(baseURL string) bool {
	c := &http.Client{Timeout: 3 * time.Second}
	// /healthz returns 404 but a live TCP+HTTP stack proves reachability.
	resp, err := c.Get(strings.TrimRight(baseURL, "/") + "/healthz")
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return true
}

func uniqueEmail(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf("live-%d-%s@zpass.test", time.Now().UnixNano(), canonicalItemIDHex(mustRandom(t, 4)))
}

func mustRandom(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rng: %v", err)
	}
	return b
}

// canonicalItemIDHex renders raw bytes as lowercase hyphenless hex (the desktop
// local item-id form, also used as the cloud AEAD aad).
func canonicalItemIDHex(b []byte) string { return hex.EncodeToString(b) }

// canonicalizeItemID strips hyphens and lowercases — converting a server-side
// Postgres UUID rendering back to the desktop-canonical aad form.
func canonicalizeItemID(id string) string {
	return strings.ToLower(strings.ReplaceAll(id, "-", ""))
}

// canonicalUUID formats 16 bytes as a hyphenated UUID (client_mutation_id wire form).
func canonicalUUID(b []byte) string {
	if len(b) < 16 {
		return hex.EncodeToString(b)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func itemIDForms(items []cloud.SnapshotItem) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.ItemID)
	}
	return out
}
