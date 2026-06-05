package services

import (
	"sort"
	"testing"
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
