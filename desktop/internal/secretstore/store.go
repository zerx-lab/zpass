// Package secretstore is a no-cgo OS credential store for small sensitive
// strings — specifically the cloud session JWT. It deliberately avoids cgo
// (the desktop binary builds with the pure-Go modernc.org/sqlite driver and is
// shipped CGO_ENABLED=0), so each platform uses a cgo-free backend:
//
//   - Linux:   the D-Bus Secret Service (org.freedesktop.secrets) via godbus.
//   - macOS:   shelling out to /usr/bin/security (the Keychain CLI).
//   - Windows: the Credential Manager via the wincred syscalls.
//
// When no backend is usable (headless Linux without a keyring daemon, etc.)
// New returns a store whose Available() is false; callers must treat the token
// as session-only (held in memory, not persisted) rather than writing it to
// plaintext config — see CloudService.
//
// Verification note: only the Linux backend is exercised on the dev box. The
// macOS and Windows backends are written to the documented platform contracts
// but are unverified on this machine and need a regression run on real macOS /
// Windows hardware.
package secretstore

import "errors"

// ErrUnavailable is returned by every method of an unusable store.
var ErrUnavailable = errors.New("secretstore: no OS credential backend available")

// ErrNotFound is returned by Get when no secret exists for the key. Callers
// usually treat it as "not signed in".
var ErrNotFound = errors.New("secretstore: secret not found")

// ErrPromptDismissed is returned when the user cancels an OS keyring unlock /
// access prompt, so the caller can distinguish cancellation from a hard failure.
var ErrPromptDismissed = errors.New("secretstore: keyring prompt dismissed")

// Store is a tiny key→secret map backed by the OS credential vault. Keys are
// arbitrary stable identifiers within the store's service namespace (e.g.
// "session-token"). It is safe for concurrent use.
type Store interface {
	// Set stores (or replaces) the secret for key.
	Set(key, value string) error
	// Get returns the secret for key. The bool is false (with a nil error) when
	// the key is absent.
	Get(key string) (value string, ok bool, err error)
	// Delete removes the secret for key. Deleting an absent key is not an error.
	Delete(key string) error
	// Available reports whether the backend is usable on this machine right now.
	Available() bool
	// Name is a short backend identifier for diagnostics/logging.
	Name() string
}

// New returns the platform credential store for the given service namespace
// (e.g. "zpass-cloud"). It never returns nil; check Available() to decide
// whether to persist secrets or keep them session-only.
func New(service string) Store { return newStore(service) }

// unavailableStore is the fallback when no OS backend works. Every operation is
// a no-op error so callers degrade to in-memory-only handling.
type unavailableStore struct{ reason string }

func (s unavailableStore) Set(string, string) error         { return ErrUnavailable }
func (s unavailableStore) Get(string) (string, bool, error) { return "", false, ErrUnavailable }
func (s unavailableStore) Delete(string) error              { return nil }
func (s unavailableStore) Available() bool                  { return false }
func (s unavailableStore) Name() string {
	if s.reason != "" {
		return "unavailable(" + s.reason + ")"
	}
	return "unavailable"
}
