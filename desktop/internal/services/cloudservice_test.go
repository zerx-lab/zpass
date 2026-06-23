package services

import (
	"errors"
	"testing"

	"github.com/zerx-lab/zpass/internal/cloudcrypto"
)

// These tests exercise the auth orchestration guard rails without a live server.

func TestCloudRegisterRejectsWeakPassword(t *testing.T) {
	s := NewCloudService(nil)
	if err := s.Configure("http://127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Register("user@example.com", "short"); !errors.Is(err, ErrWeakMasterPassword) {
		t.Fatalf("weak password: got %v, want ErrWeakMasterPassword", err)
	}
}

func TestCloudOperationsRequireConfiguration(t *testing.T) {
	s := NewCloudService(nil) // no env, no Configure → unconfigured
	if st := s.Status(); st.Configured {
		t.Fatalf("fresh service should be unconfigured: %+v", st)
	}
	if _, err := s.Register("user@example.com", "a strong enough password"); !errors.Is(err, ErrCloudNotConfigured) {
		t.Fatalf("Register unconfigured: got %v, want ErrCloudNotConfigured", err)
	}
	if _, err := s.SignIn("user@example.com", "a strong enough password", "Z1-ABCDEF-GHJKL-MNPQR-STVWX-YZ234-56789A"); err == nil {
		t.Fatalf("SignIn unconfigured should error")
	}
}

func TestCloudSignInValidatesSecretKey(t *testing.T) {
	s := NewCloudService(nil)
	if err := s.Configure("http://127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}
	// Malformed secret key must be rejected before any network call.
	if _, err := s.SignIn("user@example.com", "a strong enough password", "not-a-secret-key"); !errors.Is(err, cloudcrypto.ErrSecretKeyFormat) {
		t.Fatalf("bad secret key: got %v, want ErrSecretKeyFormat", err)
	}
}

func TestCloudConfigureNormalizesAndIsIdempotent(t *testing.T) {
	s := NewCloudService(nil)
	if err := s.Configure("http://example.test:8080/"); err != nil {
		t.Fatal(err)
	}
	st := s.Status()
	if st.BaseURL != "http://example.test:8080" {
		t.Fatalf("trailing slash not normalized: %q", st.BaseURL)
	}
	if !st.Configured {
		t.Fatalf("should be configured after Configure")
	}
	// Same origin (with/without slash) is a no-op, not an error.
	if err := s.Configure("http://example.test:8080"); err != nil {
		t.Fatalf("idempotent configure: %v", err)
	}
}

func TestCloudStatusReportsStoreBackend(t *testing.T) {
	s := NewCloudService(nil)
	st := s.Status()
	if st.StoreBackend == "" {
		t.Fatalf("status must report a store backend name")
	}
	if st.SignedIn {
		t.Fatalf("fresh service should not be signed in")
	}
}

// TestCloudLockSessionWipesInMemoryKeys pins the lock-time contract: locking the
// local vault must wipe the cloud session's in-memory key material (account
// private key + per-vault keys) and flip SignedIn to false, while a no-session
// call is a safe no-op.
func TestCloudLockSessionWipesInMemoryKeys(t *testing.T) {
	s := NewCloudService(nil)
	if err := s.Configure("http://127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}

	// No active session: LockSession must be a no-op (no panic, nil error).
	if err := s.LockSession(); err != nil {
		t.Fatalf("LockSession with no session: got %v, want nil", err)
	}
	if s.Status().SignedIn {
		t.Fatalf("no-session LockSession must not mark signed in")
	}

	// Plant a session with sensitive key material, as establishSession would.
	s.mu.Lock()
	sess := &cloudSession{
		email:     "user@example.com",
		accountID: "acct-1",
		token:     "jwt",
		vaultKeys: map[string][]byte{"v1": {1, 2, 3, 4}},
	}
	sess.priv[0] = 0x42
	s.session = sess
	s.mu.Unlock()
	if !s.Status().SignedIn {
		t.Fatalf("planted session should report SignedIn")
	}

	if err := s.LockSession(); err != nil {
		t.Fatalf("LockSession: %v", err)
	}

	s.mu.RLock()
	sessionGone := s.session == nil
	s.mu.RUnlock()
	if !sessionGone {
		t.Fatalf("LockSession must drop the session reference")
	}
	if s.Status().SignedIn {
		t.Fatalf("after LockSession the service must report signed-out")
	}
}
