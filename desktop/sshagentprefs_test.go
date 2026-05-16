package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSshAgentPrefsRoundTrip(t *testing.T) {
	home := withTempHome(t)

	enabled, exists, err := readSshAgentDesiredEnabled()
	if err != nil {
		t.Fatalf("read initial prefs: %v", err)
	}
	if exists {
		t.Fatalf("expected prefs to be absent initially")
	}
	if enabled {
		t.Fatalf("expected initial enabled=false")
	}

	if err := writeSshAgentDesiredEnabled(true); err != nil {
		t.Fatalf("write enabled prefs: %v", err)
	}

	enabled, exists, err = readSshAgentDesiredEnabled()
	if err != nil {
		t.Fatalf("read enabled prefs: %v", err)
	}
	if !exists || !enabled {
		t.Fatalf("expected enabled prefs, got exists=%v enabled=%v", exists, enabled)
	}

	if err := writeSshAgentDesiredEnabled(false); err != nil {
		t.Fatalf("write disabled prefs: %v", err)
	}

	enabled, exists, err = readSshAgentDesiredEnabled()
	if err != nil {
		t.Fatalf("read disabled prefs: %v", err)
	}
	if !exists || enabled {
		t.Fatalf("expected disabled prefs, got exists=%v enabled=%v", exists, enabled)
	}

	path := filepath.Join(home, configRootDirname, appConfigDirname, sshAgentPrefsNamespace+".json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected prefs file at %s: %v", path, err)
	}
}
