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
	"runtime"
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

// TestGUIBinaryCandidatesPackagedLayout pins the Electron packaged-layout
// resolution that regressed after the Wails->Electron migration. Every Go
// helper ships under <root>/resources/bin/<platform>-<arch>/, three levels
// below the app root where the GUI executable (executableName "zpass") lives.
// The pre-fix code probed the helper's OWN directory for the old Wails name
// "ZPassDesktop", so locate failed on all three platforms and the extension's
// "启动 Desktop" button always returned errCodeDesktopUnavailable.
func TestGUIBinaryCandidatesPackagedLayout(t *testing.T) {
	// helperDir mimics <root>/resources/bin/<platform>-<arch>/ (macOS:
	// <App>.app/Contents/Resources/bin/<arch>/). The leading segment differs
	// per case only cosmetically; the 3-up math is what matters.
	cases := []struct {
		goos string
		// helperDir relative segments under a synthetic root.
		helper []string
		// wantPrimary is the first (packaged) candidate we must produce.
		wantPrimary []string
	}{
		{
			goos:        "linux",
			helper:      []string{"root", "resources", "bin", "linux-x64"},
			wantPrimary: []string{"root", "zpass"},
		},
		{
			goos:        "windows",
			helper:      []string{"root", "resources", "bin", "win32-x64"},
			wantPrimary: []string{"root", "zpass.exe"},
		},
		{
			goos:        "darwin",
			helper:      []string{"ZPass.app", "Contents", "Resources", "bin", "darwin-arm64"},
			wantPrimary: []string{"ZPass.app", "Contents", "MacOS", "zpass"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.goos, func(t *testing.T) {
			dir := filepathpkg.Join(tc.helper...)
			got := guiBinaryCandidatesForOS(tc.goos, dir)
			if len(got) == 0 {
				t.Fatalf("no candidates for goos=%s", tc.goos)
			}
			want := filepathpkg.Join(tc.wantPrimary...)
			if got[0] != want {
				t.Fatalf("goos=%s primary candidate = %q, want %q (all: %v)", tc.goos, got[0], want, got)
			}
			// Regression guard: the helper's own directory must never be a
			// candidate (that was the old broken behavior).
			for _, c := range got {
				if filepathpkg.Dir(c) == dir {
					t.Fatalf("goos=%s candidate %q sits in the helper dir %q (Wails-era bug)", tc.goos, c, dir)
				}
			}
		})
	}
}

// TestLocateGUIBinaryFindsPackagedExecutable is the end-to-end resolution:
// build the real packaged tree on disk for the host platform, drop the GUI
// executable at the app root, and assert a candidate from the helper dir
// resolves it via fileExistsNH (exactly locateGUIBinaryForNativeHost's loop,
// minus the un-fakeable os.Executable lookup).
func TestLocateGUIBinaryFindsPackagedExecutable(t *testing.T) {
	tmp := t.TempDir()
	platDir := runtime.GOOS + "-" + runtime.GOARCH
	helperDir := filepathpkg.Join(tmp, "resources", "bin", platDir)
	if err := os.MkdirAll(helperDir, 0o755); err != nil {
		t.Fatalf("mkdir helper: %v", err)
	}

	// Place the GUI executable where the Electron packaged layout puts it.
	var guiPath string
	switch runtime.GOOS {
	case "windows":
		guiPath = filepathpkg.Join(tmp, "zpass.exe")
	case "darwin":
		macOS := filepathpkg.Join(tmp, "Contents", "MacOS")
		if err := os.MkdirAll(macOS, 0o755); err != nil {
			t.Fatalf("mkdir MacOS: %v", err)
		}
		// On darwin the helper sits at <App>.app/Contents/Resources/bin/<arch>,
		// so rebuild helperDir under Contents to keep the 3-up math honest.
		helperDir = filepathpkg.Join(tmp, "Contents", "Resources", "bin", platDir)
		if err := os.MkdirAll(helperDir, 0o755); err != nil {
			t.Fatalf("mkdir darwin helper: %v", err)
		}
		guiPath = filepathpkg.Join(macOS, "zpass")
	default:
		guiPath = filepathpkg.Join(tmp, "zpass")
	}
	if err := os.WriteFile(guiPath, []byte("#!/bin/true\n"), 0o755); err != nil {
		t.Fatalf("write gui binary: %v", err)
	}

	var found string
	for _, c := range guiBinaryCandidatesForOS(runtime.GOOS, helperDir) {
		if fileExistsNH(c) {
			found = c
			break
		}
	}
	if found == "" {
		t.Fatalf("no candidate resolved the packaged GUI at %q (helper=%q, candidates=%v)",
			guiPath, helperDir, guiBinaryCandidatesForOS(runtime.GOOS, helperDir))
	}
}
