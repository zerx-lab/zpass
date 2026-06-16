package services

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/zerx-lab/zpass/internal/cloud"
	"github.com/zerx-lab/zpass/internal/cloudcrypto"
)

// TestCloudSyncLiveTwoDevices is the P3 verification gate: two independent local
// vaults (separate DBs + DEKs), one cloud account, syncing through a RUNNING
// server. Skipped unless ZPASS_CLOUD_LIVE=1. It proves push/pull convergence,
// update propagation, and tombstone (delete) propagation — including that a
// remote delete is detected via the CAS-conflict path (the snapshot filters
// tombstones, so the re-push of a "local-only" item is what reveals the delete).
func TestCloudSyncLiveTwoDevices(t *testing.T) {
	if os.Getenv("ZPASS_CLOUD_LIVE") != "1" {
		t.Skip("set ZPASS_CLOUD_LIVE=1 (and run the cloud server) to exercise live sync")
	}
	baseURL := os.Getenv("ZPASS_CLOUD_BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	if !serverReachable(baseURL) {
		t.Fatalf("cloud server not reachable at %s", baseURL)
	}

	const masterPW = "two device sync password"
	email := uniqueEmail(t)

	// --- Device 1: account + local vault -----------------------------------
	svc1 := openUnlockedVault(t, "space-1")
	cloud1 := NewCloudService(svc1)
	if err := cloud1.Configure(baseURL); err != nil {
		t.Fatal(err)
	}
	reg, err := cloud1.Register(email, masterPW)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	t.Cleanup(func() { _ = cloud1.SignOut() })

	// Two items in device-1's space.
	id1 := mustCreateItem(t, svc1, "login", "github")
	id2 := mustCreateItem(t, svc1, "note", "recovery codes")

	vaultID, err := cloud1.CreateCloudVault("space-1", "Space 1", "", "")
	if err != nil {
		t.Fatalf("create cloud vault: %v", err)
	}
	sum, err := cloud1.SyncNow()
	if err != nil {
		t.Fatalf("device-1 sync: %v", err)
	}
	if sum.Pushed != 2 {
		t.Fatalf("device-1 expected to push 2, got %+v", sum)
	}

	// --- Device 2: same account, bind same vault, pull ---------------------
	svc2 := openUnlockedVault(t, "space-2")
	cloud2 := NewCloudService(svc2)
	if err := cloud2.Configure(baseURL); err != nil {
		t.Fatal(err)
	}
	if _, err := cloud2.SignIn(email, masterPW, reg.SecretKey); err != nil {
		t.Fatalf("device-2 sign in: %v", err)
	}
	t.Cleanup(func() { _ = cloud2.SignOut() })
	if err := svc2.db.PutCloudVault("space-2", vaultID, "", time.Now().UnixMilli()); err != nil {
		t.Fatalf("bind device-2 space: %v", err)
	}

	sum2, err := cloud2.SyncNow()
	if err != nil {
		t.Fatalf("device-2 sync: %v", err)
	}
	if sum2.Pulled != 2 {
		t.Fatalf("device-2 expected to pull 2, got %+v", sum2)
	}
	assertItemNames(t, svc2, "github", "recovery codes")

	// --- Update propagation: device-1 edits, device-2 pulls ----------------
	editItem(t, svc1, id1, "github-renamed")
	if _, err := cloud1.SyncNow(); err != nil {
		t.Fatalf("device-1 re-sync: %v", err)
	}
	if _, err := cloud2.SyncNow(); err != nil {
		t.Fatalf("device-2 re-sync: %v", err)
	}
	assertItemNames(t, svc2, "github-renamed", "recovery codes")

	// --- Delete propagation: device-1 deletes id2, device-2 pulls tombstone -
	if err := svc1.DeleteItem(id2); err != nil {
		t.Fatalf("delete id2: %v", err)
	}
	if _, err := cloud1.SyncNow(); err != nil {
		t.Fatalf("device-1 delete-sync: %v", err)
	}
	if _, err := cloud2.SyncNow(); err != nil {
		t.Fatalf("device-2 delete-sync: %v", err)
	}
	assertItemNames(t, svc2, "github-renamed")

	t.Logf("two-device sync OK: vault=%s", vaultID)
}

// TestCloudSyncLiveConflictResurrect verifies the HIGH-severity fixes: a local
// edit newer than a remote delete is recorded as a conflict (NOT livelocked and
// NOT silently lost), and resolving it "local" force-pushes (resurrects) the
// item so it propagates back to the deleting device.
func TestCloudSyncLiveConflictResurrect(t *testing.T) {
	if os.Getenv("ZPASS_CLOUD_LIVE") != "1" {
		t.Skip("set ZPASS_CLOUD_LIVE=1 (and run the cloud server) to exercise live sync")
	}
	baseURL := os.Getenv("ZPASS_CLOUD_BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	if !serverReachable(baseURL) {
		t.Fatalf("cloud server not reachable at %s", baseURL)
	}

	const masterPW = "conflict resurrect password"
	email := uniqueEmail(t)

	svc1 := openUnlockedVault(t, "space-1")
	cloud1 := NewCloudService(svc1)
	_ = cloud1.Configure(baseURL)
	reg, err := cloud1.Register(email, masterPW)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	t.Cleanup(func() { _ = cloud1.SignOut() })

	id := mustCreateItem(t, svc1, "login", "shared-item")
	vaultID, err := cloud1.CreateCloudVault("space-1", "Space 1", "", "")
	if err != nil {
		t.Fatalf("create vault: %v", err)
	}
	if _, err := cloud1.SyncNow(); err != nil {
		t.Fatalf("device-1 initial sync: %v", err)
	}

	svc2 := openUnlockedVault(t, "space-2")
	cloud2 := NewCloudService(svc2)
	_ = cloud2.Configure(baseURL)
	if _, err := cloud2.SignIn(email, masterPW, reg.SecretKey); err != nil {
		t.Fatalf("device-2 sign in: %v", err)
	}
	t.Cleanup(func() { _ = cloud2.SignOut() })
	_ = svc2.db.PutCloudVault("space-2", vaultID, "", time.Now().UnixMilli())
	if _, err := cloud2.SyncNow(); err != nil {
		t.Fatalf("device-2 pull: %v", err)
	}
	assertItemNames(t, svc2, "shared-item")

	// device-1 deletes; device-2 edits NEWER than the delete, then syncs.
	if err := svc1.DeleteItem(id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := cloud1.SyncNow(); err != nil {
		t.Fatalf("device-1 delete sync: %v", err)
	}
	time.Sleep(3 * time.Millisecond)
	editItem(t, svc2, id, "edited-after-delete")

	// This sync must RECORD a conflict (delete_vs_edit), not livelock or lose data.
	sum, err := cloud2.SyncNow()
	if err != nil {
		t.Fatalf("device-2 conflict sync: %v", err)
	}
	conflicts := cloud2.ListConflicts()
	if len(conflicts) != 1 || conflicts[0].ID != id || conflicts[0].Kind != "delete_vs_edit" {
		t.Fatalf("device-2: expected 1 delete_vs_edit conflict, got %d (%+v), summary %+v", len(conflicts), conflicts, sum)
	}
	// The local edit is still present (not silently lost, not livelocked).
	assertItemNames(t, svc2, "edited-after-delete")

	// Resolve "local" → force-push resurrect onto the server.
	if err := cloud2.ResolveConflict(id, "local"); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	applied, err := cloud2.ApplyMerge()
	if err != nil || applied != 1 {
		t.Fatalf("apply merge = (%d, %v), want (1, nil)", applied, err)
	}
	if len(cloud2.ListConflicts()) != 0 {
		t.Fatalf("device-2 conflict not cleared after apply")
	}

	// device-1 (the deleter) syncs. Because it holds a tombstone and the server
	// now has a newer live edit, this is symmetrically a delete-vs-edit conflict
	// (destructive ambiguity is never auto-resolved). Resolving "remote" accepts
	// the resurrected edit.
	if _, err := cloud1.SyncNow(); err != nil {
		t.Fatalf("device-1 resurrect sync: %v", err)
	}
	c1conf := cloud1.ListConflicts()
	if len(c1conf) != 1 || c1conf[0].Kind != "delete_vs_edit" {
		t.Fatalf("device-1: expected 1 delete_vs_edit conflict, got %d (%+v)", len(c1conf), c1conf)
	}
	if err := cloud1.ResolveConflict(id, "remote"); err != nil {
		t.Fatalf("device-1 resolve: %v", err)
	}
	if applied, err := cloud1.ApplyMerge(); err != nil || applied != 1 {
		t.Fatalf("device-1 apply merge = (%d, %v), want (1, nil)", applied, err)
	}
	assertItemNames(t, svc1, "edited-after-delete")
	t.Logf("conflict+resurrect OK")
}

// TestCloudSyncLiveWebVaultInterop simulates a web_vault / skeleton-cli client
// pushing an item through /changes (the cloud-canonical format: a flat
// {v,type,title,...} ItemRecord sealed with aad = the hyphenated UUID string)
// and asserts the desktop pulls + transcodes it into a usable local item
// (title -> name, flat fields -> fields). This is the cross-client item-format
// alignment behind the user-reported "undecryptable items".
func TestCloudSyncLiveWebVaultInterop(t *testing.T) {
	if os.Getenv("ZPASS_CLOUD_LIVE") != "1" {
		t.Skip("set ZPASS_CLOUD_LIVE=1 (and run the cloud server) to exercise live sync")
	}
	baseURL := os.Getenv("ZPASS_CLOUD_BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	if !serverReachable(baseURL) {
		t.Fatalf("cloud server not reachable at %s", baseURL)
	}

	email := uniqueEmail(t)
	const masterPW = "web vault interop password"

	// Owner device creates the cloud vault (so we can borrow its vault key to
	// seal an item exactly like a web_vault client would).
	owner := openUnlockedVault(t, "space-1")
	cowner := NewCloudService(owner)
	_ = cowner.Configure(baseURL)
	reg, err := cowner.Register(email, masterPW)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	t.Cleanup(func() { _ = cowner.SignOut() })
	vaultID, err := cowner.CreateCloudVault("space-1", "Space 1", "", "")
	if err != nil {
		t.Fatalf("create vault: %v", err)
	}

	cowner.mu.RLock()
	vaultKey := append([]byte(nil), cowner.session.vaultKeys[vaultID]...)
	token := cowner.session.token
	cowner.mu.RUnlock()

	// Simulate web_vault: a hyphenated uuid item_id, a flat ItemRecord, sealed
	// with aad = the uuid STRING bytes (NOT hyphenless).
	wvID := canonicalUUID(mustRandom(t, 16)) // hyphenated
	record := []byte(`{"v":2,"type":"login","title":"wv-item","username":"alice","password":"s3cr3t","url":"https://example.com"}`)
	ct, err := cloudcrypto.SealAEAD(vaultKey, record, []byte(wvID))
	if err != nil {
		t.Fatalf("seal web_vault record: %v", err)
	}
	wc := cloud.NewClient(baseURL, nil)
	wc.SetToken(token)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := wc.PostChange(ctx, vaultID, cloud.ChangeRequest{
		ItemID:           wvID,
		BaseSeq:          0,
		UpdatedAt:        time.Now().UnixMilli(),
		Revision:         1,
		Ciphertext:       cloudB64.EncodeToString(ct),
		ClientMutationID: canonicalUUID(mustRandom(t, 16)),
	})
	if err != nil || resp.IsConflict() {
		t.Fatalf("web_vault push: err=%v conflict=%v", err, resp.IsConflict())
	}

	// Desktop device signs in, binds the same vault, and syncs it down.
	dev := openUnlockedVault(t, "space-2")
	cdev := NewCloudService(dev)
	_ = cdev.Configure(baseURL)
	if _, err := cdev.SignIn(email, masterPW, reg.SecretKey); err != nil {
		t.Fatalf("device sign in: %v", err)
	}
	t.Cleanup(func() { _ = cdev.SignOut() })
	if err := dev.db.PutCloudVault("space-2", vaultID, "", time.Now().UnixMilli()); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if _, err := cdev.SyncNow(); err != nil {
		t.Fatalf("device sync: %v", err)
	}

	// The web_vault item must appear locally, decrypted, with title -> name and
	// the flat fields available.
	assertItemNames(t, dev, "wv-item")
	localID := localItemID(wvID)
	payload, err := dev.getItemAnySpace(localID)
	if err != nil || payload == nil {
		t.Fatalf("get web_vault item %s: %v", localID, err)
	}
	if payload.Name != "wv-item" || payload.Type != ItemTypeLogin {
		t.Fatalf("transcode wrong: name=%q type=%q", payload.Name, payload.Type)
	}
	if payload.Fields["username"] != "alice" || payload.Fields["password"] != "s3cr3t" {
		t.Fatalf("fields not transcoded: %+v", payload.Fields)
	}
	t.Logf("web_vault interop OK: item %s (%s) decoded with fields", wvID, localID)
}

// --- helpers ---------------------------------------------------------------

// openUnlockedVault opens an isolated vault in a fresh temp HOME, initializes +
// unlocks it, and activates spaceID. Each call uses a different temp dir, so two
// calls in one test yield two independent local vaults.
func openUnlockedVault(t *testing.T, spaceID string) *VaultService {
	t.Helper()
	dir := t.TempDir()
	saveHome, hadHome := os.LookupEnv("HOME")
	saveProfile, hadProfile := os.LookupEnv("USERPROFILE")
	_ = os.Setenv("HOME", dir)
	_ = os.Setenv("USERPROFILE", dir)

	db, err := OpenVaultDB()
	if err != nil {
		t.Fatalf("open vault db: %v", err)
	}
	// Restore HOME immediately — the db handle has already resolved its path,
	// so the next openUnlockedVault gets its own dir.
	if hadHome {
		_ = os.Setenv("HOME", saveHome)
	} else {
		_ = os.Unsetenv("HOME")
	}
	if hadProfile {
		_ = os.Setenv("USERPROFILE", saveProfile)
	} else {
		_ = os.Unsetenv("USERPROFILE")
	}
	t.Cleanup(func() { _ = db.Close() })

	svc := NewVaultService(db)
	if err := svc.Initialize("local vault password"); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if err := svc.SetActiveSpace(spaceID); err != nil {
		t.Fatalf("set active space: %v", err)
	}
	return svc
}

func mustCreateItem(t *testing.T, svc *VaultService, typ, name string) string {
	t.Helper()
	sum, err := svc.CreateItem(ItemPayload{
		Type:   ItemType(typ),
		Name:   name,
		Fields: map[string]any{"note": name + " field"},
	})
	if err != nil {
		t.Fatalf("create item %q: %v", name, err)
	}
	return sum.ID
}

func editItem(t *testing.T, svc *VaultService, id, newName string) {
	t.Helper()
	cur, err := svc.GetItem(id)
	if err != nil || cur == nil {
		t.Fatalf("get item %s: %v", id, err)
	}
	// Ensure a strictly newer updatedAt than the synced version.
	time.Sleep(2 * time.Millisecond)
	cur.Name = newName
	if _, err := svc.UpdateItem(*cur); err != nil {
		t.Fatalf("update item %s: %v", id, err)
	}
}

func assertItemNames(t *testing.T, svc *VaultService, want ...string) {
	t.Helper()
	items, err := svc.ListItems()
	if err != nil {
		t.Fatalf("list items: %v", err)
	}
	got := map[string]bool{}
	for _, it := range items {
		got[it.Name] = true
	}
	if len(items) != len(want) {
		names := make([]string, 0, len(items))
		for _, it := range items {
			names = append(names, it.Name)
		}
		t.Fatalf("item count = %d %v, want %d %v", len(items), names, len(want), want)
	}
	for _, w := range want {
		if !got[w] {
			t.Fatalf("missing expected item %q; have %v", w, got)
		}
	}
}
