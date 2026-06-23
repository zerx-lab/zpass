package services

import (
	"sort"
	"testing"

	"github.com/zerx-lab/zpass/internal/cloudcrypto"
)

func ent(id string, updated int64, hash string, deleted int64) SyncManifestEntry {
	return SyncManifestEntry{ID: id, UpdatedAt: updated, ContentHash: hash, DeletedAt: deleted}
}

// TestCloudDecide exercises the LWW+CAS decision table that drives cloud sync.
func TestCloudDecide(t *testing.T) {
	type want struct {
		pulls, pushes, conflicts []string
	}
	cases := []struct {
		name           string
		local, remote  []SyncManifestEntry
		want           want
		conflictKindOf map[string]string
	}{
		{
			name:   "new remote item is pulled",
			local:  nil,
			remote: []SyncManifestEntry{ent("a", 10, "h1", 0)},
			want:   want{pulls: []string{"a"}},
		},
		{
			name:   "new local item is pushed",
			local:  []SyncManifestEntry{ent("a", 10, "h1", 0)},
			remote: nil,
			want:   want{pushes: []string{"a"}},
		},
		{
			name:   "local newer content is pushed",
			local:  []SyncManifestEntry{ent("a", 20, "h2", 0)},
			remote: []SyncManifestEntry{ent("a", 10, "h1", 0)},
			want:   want{pushes: []string{"a"}},
		},
		{
			name:   "remote newer content is pulled",
			local:  []SyncManifestEntry{ent("a", 10, "h1", 0)},
			remote: []SyncManifestEntry{ent("a", 20, "h2", 0)},
			want:   want{pulls: []string{"a"}},
		},
		{
			name:   "identical is a no-op",
			local:  []SyncManifestEntry{ent("a", 10, "h1", 0)},
			remote: []SyncManifestEntry{ent("a", 10, "h1", 0)},
			want:   want{},
		},
		{
			name:           "same updatedAt different content is a conflict",
			local:          []SyncManifestEntry{ent("a", 10, "h1", 0)},
			remote:         []SyncManifestEntry{ent("a", 10, "h2", 0)},
			want:           want{conflicts: []string{"a"}},
			conflictKindOf: map[string]string{"a": "concurrent_edit"},
		},
		{
			name:   "local delete newer than remote edit is pushed",
			local:  []SyncManifestEntry{ent("a", 5, "", 30)}, // tombstone at 30
			remote: []SyncManifestEntry{ent("a", 10, "h1", 0)},
			want:   want{pushes: []string{"a"}},
		},
		{
			name:           "remote edit after local delete is a conflict",
			local:          []SyncManifestEntry{ent("a", 5, "", 10)}, // tombstone at 10
			remote:         []SyncManifestEntry{ent("a", 30, "h1", 0)},
			want:           want{conflicts: []string{"a"}},
			conflictKindOf: map[string]string{"a": "delete_vs_edit"},
		},
		{
			// Equal timestamps: the delete is NOT strictly newer, so it must not
			// silently win. Surfaced as a conflict, matching the CAS path
			// (bridgePushConflict) so a concurrent remote edit is never dropped.
			name:           "local delete tied with remote edit is a conflict",
			local:          []SyncManifestEntry{ent("a", 10, "", 10)}, // tombstone at 10
			remote:         []SyncManifestEntry{ent("a", 10, "h1", 0)},
			want:           want{conflicts: []string{"a"}},
			conflictKindOf: map[string]string{"a": "delete_vs_edit"},
		},
		{
			name:   "local-only tombstone is skipped",
			local:  []SyncManifestEntry{ent("a", 5, "", 30)},
			remote: nil,
			want:   want{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pulls, pushes, conflicts := cloudDecide(tc.local, tc.remote)
			cIDs := make([]string, 0, len(conflicts))
			for _, c := range conflicts {
				cIDs = append(cIDs, c.ID)
				if kind, ok := tc.conflictKindOf[c.ID]; ok && c.Kind != kind {
					t.Errorf("conflict %s kind = %q, want %q", c.ID, c.Kind, kind)
				}
			}
			assertIDs(t, "pulls", pulls, tc.want.pulls)
			assertIDs(t, "pushes", pushes, tc.want.pushes)
			assertIDs(t, "conflicts", cIDs, tc.want.conflicts)
		})
	}
}

// TestCloudContentHash_SealRoundTripInvariant pins the Layer-2 fix: the content
// hash must survive the seal -> wire -> open round trip a remote peer performs.
// payloadToWebVaultRecord drops empty fields when sealing, so a hash that counted
// those empties could never be reproduced by decrypting the ciphertext — which is
// exactly what made identical content loop forever as a phantom concurrent_edit.
func TestCloudContentHash_SealRoundTripInvariant(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	p := &ItemPayload{
		Type: ItemTypeLogin,
		Name: "zero",
		Fields: map[string]any{
			"username": "zero",
			"password": "hunter2",
			"url":      "", // empty values the seal codec drops
			"notes":    "",
			"favorite": false,
		},
	}
	local := cloudContentHash(key, p)
	if local == "" {
		t.Fatal("hash is empty")
	}

	// Decrypt-side: what a peer (or this client after a pull) recomputes.
	rec, err := payloadToWebVaultRecord(p)
	if err != nil {
		t.Fatalf("seal-encode: %v", err)
	}
	decoded, err := webVaultRecordToPayload(rec)
	if err != nil {
		t.Fatalf("open-decode: %v", err)
	}
	if remote := cloudContentHash(key, decoded); remote != local {
		t.Fatalf("hash not round-trip invariant: local=%s remote=%s", local, remote)
	}

	// The empties must be irrelevant to the digest (the actual divergence cause).
	lean := &ItemPayload{Type: ItemTypeLogin, Name: "zero", Fields: map[string]any{
		"username": "zero", "password": "hunter2",
	}}
	if h := cloudContentHash(key, lean); h != local {
		t.Fatalf("empty fields changed the hash: with-empties=%s without=%s", local, h)
	}
}

// TestRemoteContentHash_IgnoresStaleServerHash pins the Layer-2 self-heal (Fix B)
// that actually clears the user's phantom conflicts: remoteContentHash must
// recompute from the ciphertext and ignore whatever the server stored (an older
// with-empties desktop hash, a skeleton-cli plaintext hash, …). Without this, a
// stale stored hash keeps reading as divergence for identical content forever.
func TestRemoteContentHash_IgnoresStaleServerHash(t *testing.T) {
	key := make([]byte, cloudcrypto.KeySize)
	for i := range key {
		key[i] = byte(i)
	}
	const localID = "0123456789abcdef0123456789abcdef"

	p := &ItemPayload{
		Type: ItemTypeLogin,
		Name: "zero",
		Fields: map[string]any{
			"username": "zero",
			"password": "hunter2",
			"url":      "", // empties dropped on seal — the divergence trap
			"notes":    "",
		},
	}
	pt, err := payloadToWebVaultRecord(p)
	if err != nil {
		t.Fatalf("seal-encode: %v", err)
	}
	ct, err := cloudcrypto.SealAEAD(key, pt, []byte(cloudItemID(localID)))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	ctB64 := cloudB64.EncodeToString(ct)

	// remoteContentHash needs no CloudService state — a zero value suffices.
	s := &CloudService{}

	// A deliberately-wrong stored hash must be ignored; the recomputed value wins.
	want := cloudContentHash(key, p)
	got := s.remoteContentHash(localID, ctB64, "deadbeefdeadbeef", key)
	if got != want {
		t.Fatalf("stale server hash not ignored: got=%s want=%s", got, want)
	}

	// The web_vault null path is preserved: empty stored hash stays empty (so
	// cloudDecide treats equal-updatedAt as converged, not a spurious conflict).
	if h := s.remoteContentHash(localID, ctB64, "", key); h != "" {
		t.Fatalf("empty stored hash should stay empty, got %s", h)
	}
}

func assertIDs(t *testing.T, label string, got, want []string) {
	t.Helper()
	gs := append([]string(nil), got...)
	ws := append([]string(nil), want...)
	sort.Strings(gs)
	sort.Strings(ws)
	if len(gs) != len(ws) {
		t.Fatalf("%s = %v, want %v", label, got, want)
	}
	for i := range gs {
		if gs[i] != ws[i] {
			t.Fatalf("%s = %v, want %v", label, got, want)
		}
	}
}
