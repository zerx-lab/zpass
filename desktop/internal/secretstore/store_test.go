package secretstore

import "testing"

// TestStoreRoundTrip exercises the live OS backend when one is available. It is
// skipped (not failed) on headless machines with no keyring daemon so CI stays
// green; the Linux dev box with gnome-keyring/KWallet runs it for real.
func TestStoreRoundTrip(t *testing.T) {
	s := New("zpass-cloud-test")
	if !s.Available() {
		t.Skipf("no OS credential backend available (%s); skipping", s.Name())
	}
	t.Logf("backend: %s", s.Name())

	const key = "unit-test-token"
	const val = "header.payload.signature-" + "0123456789abcdef"

	// Clean slate, then ensure absent reads report ok=false with no error.
	if err := s.Delete(key); err != nil {
		t.Fatalf("pre-delete: %v", err)
	}
	if got, ok, err := s.Get(key); err != nil || ok || got != "" {
		t.Fatalf("Get(absent) = (%q, %v, %v), want (\"\", false, nil)", got, ok, err)
	}

	if err := s.Set(key, val); err != nil {
		t.Fatalf("Set: %v", err)
	}
	t.Cleanup(func() { _ = s.Delete(key) })

	got, ok, err := s.Get(key)
	if err != nil || !ok || got != val {
		t.Fatalf("Get = (%q, %v, %v), want (%q, true, nil)", got, ok, err, val)
	}

	// Overwrite (Set replaces in place) must read back the new value.
	const val2 = "rotated.token.value"
	if err := s.Set(key, val2); err != nil {
		t.Fatalf("Set(rotate): %v", err)
	}
	if got, ok, err := s.Get(key); err != nil || !ok || got != val2 {
		t.Fatalf("Get(after rotate) = (%q, %v, %v), want (%q, true, nil)", got, ok, err, val2)
	}

	if err := s.Delete(key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok, _ := s.Get(key); ok {
		t.Fatalf("Get after Delete still reports present")
	}
}
