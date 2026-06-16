package services

import (
	"context"
	"math/rand/v2"
	"time"

	"github.com/zerx-lab/zpass/internal/cloud"
)

// This file is the realtime half of cloud sync: an SSE watcher that turns
// server-side "vault X changed" pings into immediate sync runs. Design:
//
//   - SSE is only a trigger for WHEN to sync; the sync itself is still
//     runSync's full snapshot pull. A missed event therefore never loses
//     data — the change just lands a beat later (the 90s poll is the floor).
//   - 1Password-style zero knowledge: the server pushes only "vault X is at
//     seq N" pings with no content; the client pulls the snapshot itself.
//   - Weak networks: exponential backoff with jitter on reconnect; a
//     connection that survived >= realtimeHealthyAfter resets the backoff
//     (the failure was not a fast crash loop). A successful (re)connect
//     immediately nudges a sync to cover the offline window.
//   - 401 stops reconnecting and emits cloud:auth:expired (same semantics as
//     runSync's 401 path) — retrying a dead JWT would just 401 forever.

const (
	realtimeBackoffMin = time.Second
	realtimeBackoffMax = 2 * time.Minute
	// realtimeHealthyAfter: a connection that survived this long resets the
	// reconnect backoff (the failure was not a fast loop).
	realtimeHealthyAfter = 30 * time.Second
)

// startRealtime launches the SSE watcher goroutine for the current session.
// Idempotent; no-op when already running, not signed in, or unconfigured.
func (s *CloudService) startRealtime() {
	s.mu.Lock()
	if s.realtimeCancel != nil || s.client == nil || s.session == nil {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.realtimeCancel = cancel
	client := s.client
	s.mu.Unlock()
	go s.realtimeLoop(ctx, client)
}

// stopRealtime stops the watcher (no-op when not running).
func (s *CloudService) stopRealtime() {
	s.mu.Lock()
	cancel := s.realtimeCancel
	s.realtimeCancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		s.setRealtimeState("offline")
	}
}

// realtimeLoop holds the SSE stream open and reconnects with jittered
// exponential backoff. WatchEvents returning nil is the server's normal
// 15-minute stream rotation, so we reconnect on nil too — only ctx
// cancellation and 401 terminate the loop.
func (s *CloudService) realtimeLoop(ctx context.Context, client *cloud.Client) {
	backoff := realtimeBackoffMin
	for {
		if ctx.Err() != nil {
			return
		}
		s.setRealtimeState("connecting")
		start := time.Now()
		err := client.WatchEvents(ctx,
			func() {
				s.realtimeConnected.Store(true)
				s.setRealtimeState("connected")
				// Catch up on anything pushed while we were disconnected.
				s.NudgeSync()
			},
			func(ev cloud.SyncEvent) {
				switch {
				case ev.Revoked:
					// The server pushed a revocation (admin signed this session out).
					// Tear down and prompt re-sign-in; async because it stops THIS
					// watcher.
					go s.handleSessionRevoked()
				case ev.VaultDeleted:
					// A vault was deleted (owner action, possibly another device).
					// Tell the renderer to reconcile spaces now so the bound local
					// space is auto-removed without waiting for the next reconcile.
					s.emitEvent("cloud:vault:deleted", map[string]any{"vaultId": ev.VaultID})
				case ev.Resync:
					// Broadcast lag: the delta could have a hole — force a full reconcile.
					s.nudgeFullSync()
				default:
					// A change ping carries vault_id + seq; route it to a targeted
					// O(delta) incremental pull.
					s.nudgeVaultSync(ev.VaultID, ev.Seq)
				}
			},
		)
		s.realtimeConnected.Store(false)
		if ctx.Err() != nil {
			s.setRealtimeState("offline")
			return
		}
		if cloud.IsUnauthorized(err) {
			// Session JWT dead (expired or revoked). Reconnecting would 401
			// forever, so tear the session down and prompt a re-sign-in rather
			// than silently spinning. handleSessionRevoked is async because it
			// calls stopRealtime (which cancels THIS goroutine's ctx) — we exit
			// immediately after and let it run on its own goroutine.
			s.setRealtimeState("offline")
			go s.handleSessionRevoked()
			return
		}
		if time.Since(start) >= realtimeHealthyAfter {
			backoff = realtimeBackoffMin
		}
		s.setRealtimeState("reconnecting")
		// Jittered sleep so a fleet of clients does not reconnect in lockstep.
		select {
		case <-ctx.Done():
			s.setRealtimeState("offline")
			return
		case <-time.After(backoff + jitter(backoff/2)):
		}
		backoff *= 2
		if backoff > realtimeBackoffMax {
			backoff = realtimeBackoffMax
		}
	}
}

// jitter returns a uniformly random duration in [0, d). Non-cryptographic
// randomness is fine — this only de-synchronizes reconnect storms.
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return rand.N(d)
}

// setRealtimeState records the connection state and emits a cloud:realtime:state
// event when it actually changes (deduped — reconnect loops would spam the UI).
func (s *CloudService) setRealtimeState(state string) {
	s.realtimeMu.Lock()
	changed := s.realtimeState != state
	s.realtimeState = state
	s.realtimeMu.Unlock()
	if changed {
		s.emitEvent("cloud:realtime:state", map[string]any{"state": state, "updatedAt": nowMillis()})
	}
}

// realtimeStateNow reports the last recorded connection state ("offline" before
// the watcher ever ran).
func (s *CloudService) realtimeStateNow() string {
	s.realtimeMu.Lock()
	defer s.realtimeMu.Unlock()
	if s.realtimeState == "" {
		return "offline"
	}
	return s.realtimeState
}

// PokeRealtime wakes the realtime channel after a system-resume / network-online
// signal from the frontend: the SSE stream is likely half-open (the watchdog
// would take up to ~75s to notice), so cancel it and reconnect immediately,
// then nudge a catch-up sync to cover the window we were disconnected. Idempotent
// and cheap; a no-op when signed out.
func (s *CloudService) PokeRealtime() {
	s.mu.RLock()
	signedIn := s.session != nil
	s.mu.RUnlock()
	if !signedIn {
		return
	}
	// stop+start cancels the in-flight WatchEvents (killing a half-open stream)
	// and restarts the loop with fresh backoff.
	s.stopRealtime()
	s.startRealtime()
	s.NudgeSync()
}
