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
	snap, err := c2.Snapshot(ctx, vaultID, 0, 100)
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
