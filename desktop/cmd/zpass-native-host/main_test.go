// Tests for the native-host -> GUI forwarding loop. The URL-matching helpers
// these tests used to share with this binary now live in
// internal/services/nativebridge_protocol.go; their tests moved with them
// (see internal/services/nativebridge_protocol_test.go). What stays here is
// the *integration* test: when the bridge is unreachable and the GUI binary
// is missing, dispatchMessage must return a structured error rather than
// touching the vault directly.
package main

import (
	filepathpkg "path/filepath"
	"testing"
	"time"
)

// filepath_join is a tiny alias so inline test calls stay readable.
func filepath_join(parts ...string) string { return filepathpkg.Join(parts...) }

// TestDispatchMessageGUIUnavailable verifies that with a bogus GUI binary
// and no running desktop, dispatchMessage returns errCodeDesktopUnavailable
// and never falls back to any vault-touching code path.
//
// HOME / USERPROFILE point at a temp dir so we do not read the real user's
// browser-bridge.json by accident.
func TestDispatchMessageGUIUnavailable(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)
	t.Setenv("ZPASS_GUI_BIN", filepath_join(tmp, "nope-doesnt-exist"))

	// Reset launcher cooldown so a previous test cannot blanket-skip us.
	guiLauncherMu.Lock()
	guiLauncherLastTry = time.Time{}
	guiLauncherBin = ""
	guiLauncherMu.Unlock()

	resp := dispatchMessage(nativeEnvelope{ID: "test-1", Type: "status"})
	if resp.OK {
		t.Fatalf("expected !OK when GUI unavailable; got %+v", resp)
	}
	if resp.ID != "test-1" {
		t.Fatalf("want response id echoed, got %q", resp.ID)
	}
	if resp.Error != errCodeDesktopUnavailable {
		t.Fatalf("want errCodeDesktopUnavailable, got %q", resp.Error)
	}
}
