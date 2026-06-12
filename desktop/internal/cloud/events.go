// SSE realtime sync notification client for GET /v1/events.
//
// Wire contract (verified against the Rust/axum server): JWT bearer auth, a
// "text/event-stream" response, a ": ka" keepalive comment every 20s, and two
// event kinds — "event: change" with data {"vault_id":"<uuid>","seq":<n>}, and
// "event: resync" with data {} (sent when the server's broadcast channel
// lagged and the client must run a full sync). The server caps each stream at
// 15 minutes and closes it normally; callers reconnect on a nil return.
//
// Weak-network handling: TCP alone won't notice a half-open connection (flaky
// Wi-Fi, suspend-resume), so a watchdog cancels the request context whenever
// no bytes arrive for eventsStaleTimeout — comfortably longer than the
// keepalive interval, so a healthy stream never trips it.
//
// This file deliberately does NOT use c.http for the stream: that client
// carries a 30s global Timeout (DefaultTimeout) which would sever the
// long-lived connection mid-stream. Instead it borrows c.http's Transport
// (preserving any custom TLS config) inside a timeout-free http.Client.

package cloud

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// SyncEvent is one realtime notification from GET /v1/events.
type SyncEvent struct {
	VaultID string // hyphenated server vault UUID ("" for resync/revoked)
	Seq     int64  // the vault's new high-water seq (0 for resync/revoked)
	Resync  bool   // true when the server requests a full resync (broadcast lag)
	Revoked bool   // true when the server signals this session was revoked
}

const (
	// eventsStaleTimeout kills a half-open stream: the server sends a keepalive
	// comment every 20s, so 75s with no bytes means the connection is dead
	// (typical on flaky Wi-Fi / suspend-resume) even though TCP hasn't noticed.
	eventsStaleTimeout = 75 * time.Second
)

// WatchEvents opens the server's SSE stream and blocks, invoking onEvent for
// every change/resync notification, until the stream ends or ctx is canceled.
//
//   - onConnect (optional) fires once after the 200 response arrives — callers
//     use it to reset reconnect backoff and run a catch-up sync.
//   - A nil return means the server closed the stream normally (its 15-minute
//     lifetime cap); the caller should simply reconnect.
//   - A non-2xx handshake returns *APIError (IsUnauthorized works for 401).
//   - ctx cancellation returns ctx.Err().
func (c *Client) WatchEvents(ctx context.Context, onConnect func(), onEvent func(SyncEvent)) error {
	tok := c.token.Load()
	if tok == "" {
		return &APIError{Status: http.StatusUnauthorized, Message: "no session token"}
	}

	// The watchdog kills the connection by canceling this derived context;
	// http.Client has no per-read deadline knob, so cancellation is the only
	// portable way to abort a stalled body read.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/v1/events", nil)
	if err != nil {
		return fmt.Errorf("cloud: build request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Cache-Control", "no-cache")

	// Reuse c.http's Transport so a custom TLS setup keeps working, but drop
	// the client-level Timeout: it would cut the long-lived stream short.
	tr := c.http.Transport
	if tr == nil {
		tr = http.DefaultTransport
	}
	stream := &http.Client{Transport: tr} // no Timeout: the stream is long-lived

	resp, err := stream.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("cloud: events: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		return &APIError{Status: resp.StatusCode, Message: parseErrorBody(raw)}
	}

	if onConnect != nil {
		onConnect()
	}

	watchdog := time.AfterFunc(eventsStaleTimeout, cancel)
	defer watchdog.Stop()

	sc := bufio.NewScanner(resp.Body)
	// Default Scanner cap is 64 KiB per line; give it headroom in case a
	// future server event carries a large payload.
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)

	var eventName, data string
	for sc.Scan() {
		watchdog.Reset(eventsStaleTimeout)
		line := sc.Text()
		switch {
		case line == "":
			// Blank line = event boundary: dispatch whatever accumulated.
			if eventName != "" || data != "" {
				dispatchEvent(eventName, data, onEvent)
				eventName, data = "", ""
			}
		case strings.HasPrefix(line, ":"):
			// Keepalive comment (": ka") — its only job is to feed the watchdog.
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			// The SSE spec allows multi-line data joined with "\n"; this
			// server always sends single-line JSON, so last-write-wins is a
			// safe simplification here.
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		default:
			// Unknown field (e.g. "id:", "retry:") — ignore for forward compat.
		}
	}

	if ctx.Err() != nil {
		// Either the watchdog fired or the caller canceled — we can't tell
		// them apart, but both resolve the same way: the caller reconnects.
		return ctx.Err()
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("cloud: events stream: %w", err)
	}
	// EOF without error: the server closed the stream normally (15-minute cap).
	return nil
}

// dispatchEvent maps one parsed SSE event onto a SyncEvent callback. Malformed
// change payloads are dropped rather than failing the stream: one bad event
// shouldn't cost us the connection, and the periodic catch-up sync covers any
// missed notification.
func dispatchEvent(eventName, data string, onEvent func(SyncEvent)) {
	switch eventName {
	case "change":
		var payload struct {
			VaultID string `json:"vault_id"`
			Seq     int64  `json:"seq"`
		}
		if json.Unmarshal([]byte(data), &payload) != nil {
			return
		}
		onEvent(SyncEvent{VaultID: payload.VaultID, Seq: payload.Seq})
	case "resync":
		onEvent(SyncEvent{Resync: true})
	case "revoked":
		// The server signalled this session was revoked (admin sign-out-all, etc).
		onEvent(SyncEvent{Revoked: true})
	default:
		// Unknown event kind — ignore for forward compat.
	}
}
