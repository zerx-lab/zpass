// Package nativebridge holds the on-disk handshake config that the desktop
// GUI publishes for the browser native messaging host. Both processes import
// this package so the JSON shape stays in lockstep.
//
// The GUI writes the file with WriteConfig once it has bound its loopback
// listener; the native host reads it on every request to discover where to
// forward. The file lives under the user's ZPass config directory and is
// chmod 0600.
//
// Callers pass an explicit path so this package stays free of any dependency
// on the GUI's ConfigService or its config-dir resolver — that lets the
// native host link without pulling in the whole vault/sshagent surface.
package nativebridge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	// MaxMessageBytes is Chrome's hard limit for a single native message
	// (1 MiB). Exposed for the native host to reject anything larger before
	// allocating a buffer.
	MaxMessageBytes = 1 << 20

	// ConfigFile is the basename of the handshake file the GUI writes under
	// the user's ZPass config directory.
	ConfigFile = "browser-bridge.json"

	// configDirParent / configDirName form the standard `<home>/.config/zpass`
	// path. Declared here (not just in services/configservice.go) so the
	// native-host command can resolve the bridge file without importing
	// services and dragging in the vault/sshagent surface.
	configDirParent = ".config"
	configDirName   = "zpass"
)

// Config is the JSON shape the GUI publishes for the browser bridge.
//
// Port is stored as a string because Chrome's native messaging host
// historically had quirks parsing JSON numbers across some launcher
// versions; string round-trips are byte-for-byte deterministic.
type Config struct {
	Port  string `json:"port"`
	Token string `json:"token"`
}

// WriteConfig atomically replaces path with the serialized config.
// It chmods the result 0600 so only the user can read it.
//
// The directory containing path must already exist; callers know more about
// the right location than this package does.
func WriteConfig(path string, cfg Config) error {
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// ReadConfig loads the config from path. Returns an error if the file is
// missing, malformed, or has empty port/token (indistinguishable from "no
// GUI online" at the call site — the caller decides whether to spawn the
// GUI).
func ReadConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.Port == "" || cfg.Token == "" {
		return Config{}, fmt.Errorf("browser bridge config incomplete")
	}
	return cfg, nil
}

// ConfigPath returns the absolute path to the bridge handshake file under
// the user's ZPass config directory. The directory is not created here;
// callers that need to write should mkdir first.
//
// Layout: <user-home>/.config/zpass/browser-bridge.json (same on all OSes,
// matching the rest of the ZPass config convention).
func ConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home: %w", err)
	}
	return filepath.Join(home, configDirParent, configDirName, ConfigFile), nil
}

// ReadStandardConfig is a convenience for callers that just want the
// running GUI's handshake. Equivalent to ReadConfig(ConfigPath()).
func ReadStandardConfig() (Config, error) {
	path, err := ConfigPath()
	if err != nil {
		return Config{}, err
	}
	return ReadConfig(path)
}
