package services

import (
	"testing"
	"time"
)

// collectEvents wires a buffered-channel emitter into the service. emitEvent
// dispatches via `go emit(...)`, so collection is inherently async — receivers
// must use the timeout helpers below rather than reading state directly.
func collectEvents(s *CloudService, buf int) <-chan string {
	ch := make(chan string, buf)
	s.SetEventEmitter(func(event string, payload any) {
		ch <- event
	})
	return ch
}

func recvEvent(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for event")
		return ""
	}
}

// TestRealtimeStateDedupes verifies setRealtimeState only emits when the state
// actually changes — a flapping reconnect loop must not spam the UI.
func TestRealtimeStateDedupes(t *testing.T) {
	s := NewCloudService(nil)
	ch := collectEvents(s, 8)

	s.setRealtimeState("connecting")
	s.setRealtimeState("connecting") // duplicate: must be swallowed
	s.setRealtimeState("connected")

	if ev := recvEvent(t, ch); ev != "cloud:realtime:state" {
		t.Fatalf("first event = %q, want cloud:realtime:state", ev)
	}
	if ev := recvEvent(t, ch); ev != "cloud:realtime:state" {
		t.Fatalf("second event = %q, want cloud:realtime:state", ev)
	}
	// No third event should arrive: the duplicate "connecting" was deduped.
	select {
	case ev := <-ch:
		t.Fatalf("unexpected third event %q (duplicate state was not deduped)", ev)
	case <-time.After(200 * time.Millisecond):
	}
	if got := s.realtimeStateNow(); got != "connected" {
		t.Fatalf("realtimeStateNow() = %q, want connected", got)
	}
}

// TestRealtimeStateNowDefaultsOffline: a fresh service has never connected.
func TestRealtimeStateNowDefaultsOffline(t *testing.T) {
	s := NewCloudService(nil)
	if got := s.realtimeStateNow(); got != "offline" {
		t.Fatalf("realtimeStateNow() = %q, want offline", got)
	}
}

// TestStartRealtimeRequiresSession: without a signed-in session startRealtime
// must not launch a watcher (there is no token to authenticate the stream).
func TestStartRealtimeRequiresSession(t *testing.T) {
	s := NewCloudService(nil)
	s.startRealtime()
	s.mu.Lock()
	cancel := s.realtimeCancel
	s.mu.Unlock()
	if cancel != nil {
		t.Fatal("startRealtime launched a watcher without a session")
	}
}

// TestStopRealtimeIdempotent: stopping a never-started (or already-stopped)
// watcher must be a safe no-op.
func TestStopRealtimeIdempotent(t *testing.T) {
	s := NewCloudService(nil)
	s.stopRealtime()
	s.stopRealtime()
}

// TestPokeRealtimeSignedOutNoop: PokeRealtime on a signed-out service must not
// panic and must not start a watcher (there is no session to authenticate).
func TestPokeRealtimeSignedOutNoop(t *testing.T) {
	s := NewCloudService(nil)
	s.PokeRealtime()
	s.mu.Lock()
	cancel := s.realtimeCancel
	s.mu.Unlock()
	if cancel != nil {
		t.Fatal("PokeRealtime started a watcher without a session")
	}
}

// TestHandleSessionRevokedNoSessionNoEvent: with no live session,
// handleSessionRevoked must be a silent no-op — it must NOT emit auth:changed or
// auth:revoked (concurrent 401s from several vault syncs would otherwise spam a
// signed-out UI). Idempotent across repeated calls.
func TestHandleSessionRevokedNoSessionNoEvent(t *testing.T) {
	s := NewCloudService(nil)
	ch := collectEvents(s, 8)
	s.handleSessionRevoked()
	s.handleSessionRevoked() // idempotent
	select {
	case ev := <-ch:
		t.Fatalf("unexpected event %q from revoke without a session", ev)
	case <-time.After(200 * time.Millisecond):
	}
	if s.Status().SignedIn {
		t.Fatal("Status().SignedIn = true after revoke")
	}
}
