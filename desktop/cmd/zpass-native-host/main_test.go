// Tests for the native-host -> GUI forwarding loop. The URL-matching helpers
// these tests used to share with this binary now live in
// internal/services/nativebridge_protocol.go; their tests moved with them
// (see internal/services/nativebridge_protocol_test.go). What stays here is
// the *integration* test: when the bridge is unreachable and the GUI binary
// is missing, dispatchMessage must return a structured error rather than
// touching the vault directly.
package main

import (
	"encoding/json"
	"os"
	filepathpkg "path/filepath"
	"testing"
	"time"

	"github.com/zerx-lab/zpass/internal/nativebridge"
)

// filepath_join is a tiny alias so inline test calls stay readable.
func filepath_join(parts ...string) string { return filepathpkg.Join(parts...) }

// TestHandlePingRemovesStaleBridgeConfig covers the staleness backstop:
// when browser-bridge.json points at a port nobody listens on (GUI was
// SIGKILLed / crashed before Shutdown could remove the file), handlePing
// must delete the file so subsequent resource calls short-circuit on
// ReadStandardConfig instead of paying for ensureGUIRunning + waitForBridge.
func TestHandlePingRemovesStaleBridgeConfig(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("USERPROFILE", tmp)

	cfgPath, err := nativebridge.ConfigPath()
	if err != nil {
		t.Fatalf("ConfigPath: %v", err)
	}
	if err := os.MkdirAll(filepathpkg.Dir(cfgPath), 0o700); err != nil {
		t.Fatalf("mkdir cfg dir: %v", err)
	}
	// Port 1 is virtually guaranteed to be closed for a non-root process.
	// Token shape mirrors what BrowserBridgeServer.Start writes.
	data, _ := json.Marshal(nativebridge.Config{Port: "1", Token: "deadbeef"})
	if err := os.WriteFile(cfgPath, data, 0o600); err != nil {
		t.Fatalf("seed bridge config: %v", err)
	}

	resp := handlePing(nativeEnvelope{ID: "ping-1", Type: "ping"})
	if resp.OK {
		t.Fatalf("expected !OK when bridge port closed; got %+v", resp)
	}
	if resp.Error != errCodeDesktopOffline {
		t.Fatalf("want errCodeDesktopOffline, got %q", resp.Error)
	}
	if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
		t.Fatalf("stale bridge config should have been removed; stat err=%v", err)
	}
}

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
