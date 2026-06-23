package services

import "testing"

// TestIsCloudSyncChange pins the loop-breaker: a vault:changed emitted by the
// sync engine (kind="cloud-sync") must be recognised so main.go's emit wrapper
// does NOT re-nudge a push on it. User edits and unknown payloads must NOT be
// classified as cloud-sync (they SHOULD nudge).
func TestIsCloudSyncChange(t *testing.T) {
	cases := []struct {
		name    string
		payload any
		want    bool
	}{
		{
			name:    "cloud-sync applied change is recognised",
			payload: vaultChangedPayload{Kind: cloudSyncChangeKind},
			want:    true,
		},
		{
			name:    "user create is not cloud-sync",
			payload: vaultChangedPayload{Kind: "create", ItemType: ItemTypeLogin, ItemID: "abc"},
			want:    false,
		},
		{
			name:    "user update is not cloud-sync",
			payload: vaultChangedPayload{Kind: "update"},
			want:    false,
		},
		{
			name:    "user delete is not cloud-sync",
			payload: vaultChangedPayload{Kind: "delete"},
			want:    false,
		},
		{
			name:    "non-payload type is not cloud-sync",
			payload: "vault:changed",
			want:    false,
		},
		{
			name:    "nil payload is not cloud-sync",
			payload: nil,
			want:    false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsCloudSyncChange(tc.payload); got != tc.want {
				t.Errorf("IsCloudSyncChange(%v) = %v, want %v", tc.payload, got, tc.want)
			}
		})
	}
}
