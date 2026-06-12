package services

import (
	"reflect"
	"sort"
	"testing"
)

// keysOf returns the sorted keys of a string-set for stable comparison.
func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// row builds a VaultItemRow; deletedAt <= 0 means a live item.
func row(id string, updatedAt, deletedAt int64) VaultItemRow {
	r := VaultItemRow{ID: id, UpdatedAt: updatedAt}
	if deletedAt > 0 {
		d := deletedAt
		r.DeletedAt = &d
	}
	return r
}

func state(id string, seq, syncedAt int64, hash string, deleted bool) CloudItemState {
	return CloudItemState{ItemID: id, Seq: seq, SyncedHash: hash, SyncedAt: syncedAt, Deleted: deleted}
}

// TestLocalChangeShortlist_NoDecryptBranches covers every shortlist decision
// that does NOT require decrypting (so it runs without a live vault): brand-new
// local items, orphan/local tombstones, and the timestamp gate that skips
// unchanged rows. The hash-confirm branch (updatedAt advanced) needs a real
// vault and is exercised by the live round-trip tests.
func TestLocalChangeShortlist_NoDecryptBranches(t *testing.T) {
	s := &CloudService{} // no vault: only the non-decrypting branches are reached

	cases := []struct {
		name      string
		rows      []VaultItemRow
		states    map[string]CloudItemState
		wantCands []string
	}{
		{
			name:      "brand new local live item is a candidate",
			rows:      []VaultItemRow{row("a", 10, 0)},
			states:    map[string]CloudItemState{},
			wantCands: []string{"a"},
		},
		{
			name:      "orphan local tombstone (never synced) is skipped",
			rows:      []VaultItemRow{row("a", 5, 30)},
			states:    map[string]CloudItemState{},
			wantCands: nil,
		},
		{
			name:      "local delete not yet pushed is a candidate",
			rows:      []VaultItemRow{row("a", 5, 30)},
			states:    map[string]CloudItemState{"a": state("a", 4, 5, "h", false)},
			wantCands: []string{"a"},
		},
		{
			name:      "local delete already converged is skipped",
			rows:      []VaultItemRow{row("a", 5, 30)},
			states:    map[string]CloudItemState{"a": state("a", 4, 30, "", true)},
			wantCands: nil,
		},
		{
			name:      "live row older than synced state is unchanged",
			rows:      []VaultItemRow{row("a", 10, 0)},
			states:    map[string]CloudItemState{"a": state("a", 4, 20, "h", false)},
			wantCands: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cands, _ := s.localChangeShortlist(tc.rows, tc.states, nil)
			got := keysOf(cands)
			if len(got) == 0 {
				got = nil
			}
			if !reflect.DeepEqual(got, tc.wantCands) {
				t.Fatalf("candidates = %v, want %v", got, tc.wantCands)
			}
		})
	}
}

// TestConsumeNudge verifies the trigger-collapse rules: FULL subsumes
// everything, all-bindings subsumes per-vault, per-vault keeps the max seq, and
// draining resets the accumulators.
func TestConsumeNudge(t *testing.T) {
	t.Run("full subsumes all and vaults", func(t *testing.T) {
		s := &CloudService{}
		s.nudgeFull = true
		s.nudgeAll = true
		s.nudgeVaults = map[string]int64{"v": 9}
		full, scope := s.consumeNudge()
		if !full || scope != nil {
			t.Fatalf("got full=%v scope=%v, want full=true scope=nil", full, scope)
		}
		assertNudgeReset(t, s)
	})

	t.Run("all subsumes vaults", func(t *testing.T) {
		s := &CloudService{}
		s.nudgeAll = true
		s.nudgeVaults = map[string]int64{"v": 9}
		full, scope := s.consumeNudge()
		if full || scope != nil {
			t.Fatalf("got full=%v scope=%v, want full=false scope=nil (all bindings)", full, scope)
		}
	})

	t.Run("per-vault scope passes through", func(t *testing.T) {
		s := &CloudService{}
		s.nudgeVaults = map[string]int64{"v1": 3, "v2": 7}
		full, scope := s.consumeNudge()
		if full {
			t.Fatal("got full=true, want false")
		}
		if !reflect.DeepEqual(scope, map[string]int64{"v1": 3, "v2": 7}) {
			t.Fatalf("scope = %v, want {v1:3,v2:7}", scope)
		}
	})

	t.Run("nudgeVaultSync keeps the max seq", func(t *testing.T) {
		s := &CloudService{}
		// Suppress the timer firing a real sync by pre-setting it; scheduleNudge
		// only re-arms a timer, and consumeNudge is what we assert.
		s.nudgeVaultSync("v", 5)
		s.nudgeVaultSync("v", 2) // lower — must not lower the recorded hint
		s.nudgeVaultSync("v", 8) // higher — wins
		s.nudgeMu.Lock()
		got := s.nudgeVaults["v"]
		s.nudgeMu.Unlock()
		if got != 8 {
			t.Fatalf("max seq = %d, want 8", got)
		}
		// Stop the armed debounce timer so it does not fire a background sync.
		s.nudgeMu.Lock()
		if s.nudgeTimer != nil {
			s.nudgeTimer.Stop()
		}
		s.nudgeMu.Unlock()
	})
}

func assertNudgeReset(t *testing.T, s *CloudService) {
	t.Helper()
	if s.nudgeFull || s.nudgeAll || s.nudgeVaults != nil {
		t.Fatalf("accumulators not reset: full=%v all=%v vaults=%v", s.nudgeFull, s.nudgeAll, s.nudgeVaults)
	}
}

// TestCloudItemStateRoundTrip exercises the per-item sync-state DB layer:
// upsert, read-back, single + bulk delete, and the DeleteCloudVault cascade.
func TestCloudItemStateRoundTrip(t *testing.T) {
	db := openTestVault(t)
	const space = "space-1"

	if err := db.PutCloudItemState(space, state("a", 5, 100, "ha", false)); err != nil {
		t.Fatalf("put a: %v", err)
	}
	if err := db.PutCloudItemState(space, state("b", 7, 200, "", true)); err != nil {
		t.Fatalf("put b: %v", err)
	}
	got, err := db.GetCloudItemStates(space)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if a := got["a"]; a.Seq != 5 || a.SyncedAt != 100 || a.SyncedHash != "ha" || a.Deleted {
		t.Fatalf("a round-trip mismatch: %+v", a)
	}
	if b := got["b"]; b.Seq != 7 || !b.Deleted || b.SyncedHash != "" {
		t.Fatalf("b round-trip mismatch: %+v", b)
	}

	// Upsert overwrites in place.
	if err := db.PutCloudItemState(space, state("a", 9, 300, "ha2", false)); err != nil {
		t.Fatalf("upsert a: %v", err)
	}
	got, _ = db.GetCloudItemStates(space)
	if got["a"].Seq != 9 || got["a"].SyncedHash != "ha2" {
		t.Fatalf("upsert did not overwrite: %+v", got["a"])
	}

	// Single delete.
	if err := db.DeleteCloudItemState(space, "a"); err != nil {
		t.Fatalf("delete a: %v", err)
	}
	got, _ = db.GetCloudItemStates(space)
	if _, ok := got["a"]; ok {
		t.Fatal("a not deleted")
	}
	if _, ok := got["b"]; !ok {
		t.Fatal("b should remain")
	}

	// DeleteCloudVault must cascade-delete the space's item state.
	if err := db.PutCloudVault(space, "vault-1", "acct-1", 1); err != nil {
		t.Fatalf("put binding: %v", err)
	}
	if err := db.DeleteCloudVault(space); err != nil {
		t.Fatalf("delete vault: %v", err)
	}
	got, _ = db.GetCloudItemStates(space)
	if len(got) != 0 {
		t.Fatalf("DeleteCloudVault did not cascade item state: %d rows remain", len(got))
	}
}
