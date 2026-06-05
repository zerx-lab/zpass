//go:build !linux && !darwin && !windows

package secretstore

// Fallback for platforms with no supported OS credential backend. Callers see
// Available()==false and keep the session token in memory only.
func newStore(string) Store { return unavailableStore{reason: "unsupported platform"} }
