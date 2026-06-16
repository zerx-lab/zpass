package cloud

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
)

// sseHandler wraps an event-writing body into a handler that sets the SSE
// content type and validates the handshake (path, auth, accept header).
func sseHandler(t *testing.T, body func(w http.ResponseWriter, r *http.Request, flush func())) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/events" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("Authorization = %q, want Bearer tok", got)
		}
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept = %q, want text/event-stream", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("response writer is not a Flusher")
		}
		fl.Flush()
		body(w, r, fl.Flush)
	}
}

func TestWatchEventsParsesChangeAndResync(t *testing.T) {
	c, _ := newTestServer(t, sseHandler(t, func(w http.ResponseWriter, r *http.Request, flush func()) {
		fmt.Fprint(w, ": ka\n\n")
		flush()
		fmt.Fprint(w, "event: change\ndata: {\"vault_id\":\"v-1\",\"seq\":42}\n\n")
		flush()
		fmt.Fprint(w, "event: resync\ndata: {}\n\n")
		flush()
		// Returning closes the stream — the server's normal lifetime cap.
	}))
	c.SetToken("tok")

	var connects int
	var events []SyncEvent
	err := c.WatchEvents(context.Background(),
		func() { connects++ },
		func(ev SyncEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("WatchEvents = %v, want nil", err)
	}
	if connects != 1 {
		t.Errorf("onConnect fired %d times, want 1", connects)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2: %+v", len(events), events)
	}
	if want := (SyncEvent{VaultID: "v-1", Seq: 42}); events[0] != want {
		t.Errorf("events[0] = %+v, want %+v", events[0], want)
	}
	if want := (SyncEvent{Resync: true}); events[1] != want {
		t.Errorf("events[1] = %+v, want %+v", events[1], want)
	}
}

// TestWatchEventsParsesRevoked verifies the server's session-revocation push
// (event: revoked) is surfaced as a SyncEvent{Revoked:true} so the client can
// sign out instead of looping on dead syncs.
func TestWatchEventsParsesRevoked(t *testing.T) {
	c, _ := newTestServer(t, sseHandler(t, func(w http.ResponseWriter, r *http.Request, flush func()) {
		fmt.Fprint(w, "event: revoked\ndata: {}\n\n")
		flush()
	}))
	c.SetToken("tok")

	var events []SyncEvent
	if err := c.WatchEvents(context.Background(), nil, func(ev SyncEvent) {
		events = append(events, ev)
	}); err != nil {
		t.Fatalf("WatchEvents = %v, want nil", err)
	}
	if len(events) != 1 || !events[0].Revoked {
		t.Fatalf("events = %+v, want one Revoked", events)
	}
}

// TestWatchEventsParsesVaultDeleted verifies the server's vault-deletion push
// (event: vault_deleted) is surfaced as SyncEvent{VaultID, VaultDeleted:true} so
// the client can auto-remove the bound local space (cross-device delete).
func TestWatchEventsParsesVaultDeleted(t *testing.T) {
	c, _ := newTestServer(t, sseHandler(t, func(w http.ResponseWriter, r *http.Request, flush func()) {
		fmt.Fprint(w, "event: vault_deleted\ndata: {\"vault_id\":\"v-9\"}\n\n")
		flush()
	}))
	c.SetToken("tok")

	var events []SyncEvent
	if err := c.WatchEvents(context.Background(), nil, func(ev SyncEvent) {
		events = append(events, ev)
	}); err != nil {
		t.Fatalf("WatchEvents = %v, want nil", err)
	}
	if want := (SyncEvent{VaultID: "v-9", VaultDeleted: true}); len(events) != 1 || events[0] != want {
		t.Fatalf("events = %+v, want one %+v", events, want)
	}
}

func TestWatchEventsUnauthorized(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"session revoked"}`)
	})
	c.SetToken("tok")

	err := c.WatchEvents(context.Background(), nil, func(SyncEvent) {
		t.Error("onEvent fired on a 401 handshake")
	})
	if err == nil {
		t.Fatal("expected error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error is %T, want *APIError", err)
	}
	if !IsUnauthorized(err) {
		t.Fatalf("IsUnauthorized = false for %v", err)
	}
}

func TestWatchEventsNoToken(t *testing.T) {
	c, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("request reached the server without a token")
	})

	err := c.WatchEvents(context.Background(), nil, func(SyncEvent) {})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error is %T (%v), want *APIError", err, err)
	}
	if apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("Status = %d, want 401", apiErr.Status)
	}
}

func TestWatchEventsContextCancel(t *testing.T) {
	c, _ := newTestServer(t, sseHandler(t, func(w http.ResponseWriter, r *http.Request, flush func()) {
		fmt.Fprint(w, ": ka\n\n")
		flush()
		// Hold the stream open until the client gives up; the request context
		// is canceled when the client tears down the connection.
		<-r.Context().Done()
	}))
	c.SetToken("tok")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := c.WatchEvents(ctx,
		func() {
			// Cancel asynchronously: WatchEvents is blocked in the read loop,
			// not in onConnect, so this can't deadlock — but keep it off the
			// callback path anyway to mirror real callers.
			go cancel()
		},
		func(SyncEvent) {})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("WatchEvents = %v, want context.Canceled", err)
	}
}

func TestWatchEventsMalformedDataIgnored(t *testing.T) {
	c, _ := newTestServer(t, sseHandler(t, func(w http.ResponseWriter, r *http.Request, flush func()) {
		fmt.Fprint(w, "event: change\ndata: not-json\n\n")
		flush()
		fmt.Fprint(w, "event: change\ndata: {\"vault_id\":\"v-2\",\"seq\":7}\n\n")
		flush()
	}))
	c.SetToken("tok")

	var events []SyncEvent
	err := c.WatchEvents(context.Background(), nil,
		func(ev SyncEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("WatchEvents = %v, want nil", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1 (malformed dropped): %+v", len(events), events)
	}
	if want := (SyncEvent{VaultID: "v-2", Seq: 7}); events[0] != want {
		t.Errorf("events[0] = %+v, want %+v", events[0], want)
	}
}
