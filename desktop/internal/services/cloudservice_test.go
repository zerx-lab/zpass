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
