package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const sshAgentPrefsNamespace = "ssh-agent"

type sshAgentPrefs struct {
	Enabled bool `json:"enabled"`
}

// ReadSshAgentDesiredEnabled is the exported entry point for the command
// at the root of the module to query whether the user wants the SSH agent
// re-adopted on startup. See readSshAgentDesiredEnabled.
func ReadSshAgentDesiredEnabled() (enabled bool, exists bool, err error) {
	return readSshAgentDesiredEnabled()
}

// readSshAgentDesiredEnabled returns the user's persisted SSH agent preference.
//
// exists=false means this is an older profile or the user has never touched the
// SSH agent switch. Callers can then fall back to runtime adoption signals.
func readSshAgentDesiredEnabled() (enabled bool, exists bool, err error) {
	dir, err := resolveConfigDir()
	if err != nil {
		return false, false, err
	}

	path := resolveFilePath(dir, sshAgentPrefsNamespace)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, false, nil
		}
		return false, false, fmt.Errorf("read %s: %w", path, err)
	}

	var prefs sshAgentPrefs
	if err := json.Unmarshal(data, &prefs); err != nil {
		return false, true, fmt.Errorf("parse %s: %w", path, err)
	}
	return prefs.Enabled, true, nil
}

// writeSshAgentDesiredEnabled persists whether the user wants SSH agent service
// kept alive across GUI restarts, OS logon, and agent process exits.
func writeSshAgentDesiredEnabled(enabled bool) error {
	dir, err := ensureConfigDir()
	if err != nil {
		return err
	}

	payload, err := json.MarshalIndent(sshAgentPrefs{Enabled: enabled}, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal ssh agent prefs: %w", err)
	}
	content := string(payload) + "\n"

	finalPath := resolveFilePath(dir, sshAgentPrefsNamespace)
	tmpPath := filepath.Join(dir, sshAgentPrefsNamespace+".json.tmp")

	if err := writeAndSync(tmpPath, content); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename %s -> %s: %w", tmpPath, finalPath, err)
	}
	return nil
}
