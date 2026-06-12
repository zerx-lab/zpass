package services

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/zerx-lab/zpass/internal/cloud"
	"github.com/zerx-lab/zpass/internal/cloudcrypto"
)

// This file is the P3 cloud sync engine, layered on the P2 account session in
// cloudservice.go. Model (see cloud/plans/03 dossier):
//
//   - A local Space is bound to one server vault (cloud_vaults table). Items
//     stay DEK-encrypted at rest; the per-vault key only exists in memory and is
//     used to transcode at the sync boundary (decrypt-DEK -> encrypt-vaultKey on
//     push, decrypt-vaultKey -> IngestForeignPayload re-encrypts with DEK on
//     pull). No DEK-at-rest data is ever rewritten by sync — that keeps the
//     legacy-migration (P5) cleanly isolated.
//   - Each cycle pulls a full snapshot (the server's live set + per-item seq),
//     decides per item by last-writer-wins (updatedAt) for direction, applies
//     clean pull changes, and pushes local changes with optimistic CAS. A CAS
//     rejection whose content differs from the server is recorded as a conflict
//     for the user (never silently overwritten); identical content converges.
//   - The snapshot filters tombstones, so a remote DELETE is detected when our
//     CAS push of a "local-only" item returns status:"conflict" with
//     server.deleted=true.
//   - item_id round-trips through a Postgres UUID, so the pulled id comes back
//     hyphenated; canonicalItemID() folds it back to the desktop-local hyphenless
//     hex form that is ALSO the AEAD aad (a mismatch is a silent decrypt
//     failure, verified by the live round-trip test).
//   - content_hash sent to the zero-knowledge server is keyed by the vault key
//     (HMAC), so the server cannot use it as a plaintext equality/correlation
//     oracle across users or vaults.

// cloudConflict is a pending conflict awaiting user resolution. It keeps the
// decrypted remote payload (or a deleted marker) and the server seq so
// ApplyMerge can act without re-fetching.
type cloudConflict struct {
	conflict      SyncConflict
	vaultID       string
	spaceID       string
	serverSeq     int64
	remote        *ItemPayload // nil when the remote side is a tombstone
	remoteDeleted bool
}

// CloudSyncSummary is the JSON result of a sync run for the UI.
type CloudSyncSummary struct {
	Vaults    int  `json:"vaults"`
	Pulled    int  `json:"pulled"`
	Pushed    int  `json:"pushed"`
	Conflicts int  `json:"conflicts"`
	SignedIn  bool `json:"signedIn"`
}

const (
	snapshotPageLimit = 500 // server clamps to [1,500]
	syncTickInterval  = 90 * time.Second
	forcePushMaxRetry = 5 // ApplyMerge "local" CAS retries against the live seq
	// syncNudgeDelay debounces local-change-driven syncs so a burst of edits
	// pushes once shortly after the user stops, not once per keystroke.
	syncNudgeDelay = 2 * time.Second
	// realtimeSkipPollWindow: while the realtime channel is connected, the
	// periodic tick is just a safety net — skip it when a sync ran recently.
	realtimeSkipPollWindow = 10 * time.Minute
	// fullSyncInterval bounds how long the engine runs on incremental state
	// alone before forcing a full reconcile. Incremental sync is exact, but a
	// periodic full pass self-heals any drift (a clock skew, an aborted apply,
	// a tombstone GC race) without the user noticing.
	fullSyncInterval = 6 * time.Hour
)

// scheduleNudge (re)arms the debounce timer. Caller holds nudgeMu. The fired
// closure drains the accumulated scope under nudgeMu and runs exactly one sync.
func (s *CloudService) scheduleNudge() {
	if s.nudgeTimer != nil {
		s.nudgeTimer.Stop()
	}
	s.nudgeTimer = time.AfterFunc(syncNudgeDelay, func() {
		s.nudgeMu.Lock()
		full, scope := s.consumeNudge()
		s.nudgeMu.Unlock()
		if _, err := s.runSync(context.Background(), full, scope); err != nil {
			s.emitEvent("cloud:sync:error", map[string]any{
				"message": err.Error(), "updatedAt": nowMillis(),
			})
		}
	})
}

// consumeNudge collapses the three pending accumulators into a single sync
// decision and resets them. Priority: a pending FULL reconcile subsumes
// everything; an all-bindings incremental subsumes any per-vault scope; a
// nil scope means "every binding". Caller holds nudgeMu. It is a pure-ish
// helper (only touches the nudge fields) so the collapse rules are unit-testable.
func (s *CloudService) consumeNudge() (full bool, scope map[string]int64) {
	full = s.nudgeFull
	all := s.nudgeAll
	vaults := s.nudgeVaults
	s.nudgeFull = false
	s.nudgeAll = false
	s.nudgeVaults = nil
	switch {
	case full:
		return true, nil
	case all:
		return false, nil // nil scope = incremental over every binding
	default:
		return false, vaults // may be nil (nothing pending) → runSync no-ops the scope
	}
}

// NudgeSync schedules an incremental sync over ALL bindings a short, debounced
// delay after a local change (item create/update/delete). Rapid changes
// coalesce into one run. It is the push half of automatic sync; remote pulls
// come from the realtime channel (nudgeVaultSync) and the periodic tick.
func (s *CloudService) NudgeSync() {
	s.nudgeMu.Lock()
	defer s.nudgeMu.Unlock()
	s.nudgeAll = true
	s.scheduleNudge()
}

// nudgeVaultSync schedules a debounced incremental sync of a single vault,
// triggered by an SSE change ping. seq is the event's high-water hint (0 when
// unknown); repeated pings for the same vault keep the largest seq.
func (s *CloudService) nudgeVaultSync(vaultID string, seq int64) {
	if vaultID == "" {
		s.NudgeSync()
		return
	}
	s.nudgeMu.Lock()
	defer s.nudgeMu.Unlock()
	if s.nudgeVaults == nil {
		s.nudgeVaults = make(map[string]int64)
	}
	if seq > s.nudgeVaults[vaultID] {
		s.nudgeVaults[vaultID] = seq
	}
	s.scheduleNudge()
}

// nudgeFullSync schedules a debounced FULL reconcile (used on an SSE resync
// event, when the server's broadcast lagged and a delta pull could miss rows).
func (s *CloudService) nudgeFullSync() {
	s.nudgeMu.Lock()
	defer s.nudgeMu.Unlock()
	s.nudgeFull = true
	s.scheduleNudge()
}

// autoSyncOnSignIn gates the immediate post-sign-in sync; tests disable it so an
// async kick does not race their explicit SyncNow assertions.
var autoSyncOnSignIn = true

// kickSync runs a FULL sync immediately in the background (used right after
// sign-in so a freshly unlocked session reconciles without waiting for a tick).
func (s *CloudService) kickSync() {
	if !autoSyncOnSignIn {
		return
	}
	go func() {
		if _, err := s.runSync(context.Background(), true, nil); err != nil {
			s.emitEvent("cloud:sync:error", map[string]any{
				"message": err.Error(), "updatedAt": nowMillis(),
			})
		}
	}()
}

// ---------------------------------------------------------------------------
// Cloud vault creation / linking
// ---------------------------------------------------------------------------

// CreateCloudVault provisions a new server vault for a local space: it mints a
// fresh vault key, wraps it to the account public key (sealed-box), creates the
// vault server-side, and records the space->vault binding. Returns the
// server-assigned vault id. The whole check-then-act runs under syncMu so two
// concurrent calls cannot mint duplicate server vaults for one space.
func (s *CloudService) CreateCloudVault(spaceID string) (string, error) {
	spaceID = strings.TrimSpace(spaceID)
	if spaceID == "" {
		return "", errors.New("cloud: space id is required")
	}
	if s.vault == nil {
		return "", errors.New("cloud: vault service unavailable")
	}

	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	s.mu.RLock()
	sess := s.session
	client := s.client
	s.mu.RUnlock()
	if sess == nil {
		return "", ErrCloudNotSignedIn
	}
	pub := sess.pub

	accountID := sess.accountID
	if existing, err := s.vault.db.GetCloudVaultBySpace(spaceID); err == nil && existing != nil {
		return existing.VaultID, nil // already linked — idempotent
	}

	vaultKey := make([]byte, cloudcrypto.KeySize)
	if _, err := rand.Read(vaultKey); err != nil {
		return "", fmt.Errorf("cloud: vault key rng: %w", err)
	}
	wrapped, err := cloudcrypto.SealToPubkey(pub[:], vaultKey)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(context.Background(), cloud.DefaultTimeout)
	defer cancel()
	resp, err := client.CreateVault(ctx, cloud.CreateVaultRequest{
		WrappedVaultKey: cloudB64.EncodeToString(wrapped),
	})
	if err != nil {
		return "", err
	}

	if err := s.vault.db.PutCloudVault(spaceID, resp.VaultID, accountID, nowMillis()); err != nil {
		return "", err
	}
	s.mu.Lock()
	if s.session != nil {
		s.session.vaultKeys[resp.VaultID] = vaultKey
	}
	s.mu.Unlock()
	return resp.VaultID, nil
}

// LinkedSpace is one space->vault binding for the UI.
type LinkedSpace struct {
	SpaceID string `json:"spaceId"`
	VaultID string `json:"vaultId"`
}

// LinkedSpaces returns the spaces currently bound to a cloud vault.
func (s *CloudService) LinkedSpaces() ([]LinkedSpace, error) {
	if s.vault == nil {
		return nil, nil
	}
	rows, err := s.vault.db.ListCloudVaults()
	if err != nil {
		return nil, err
	}
	out := make([]LinkedSpace, 0, len(rows))
	for _, r := range rows {
		out = append(out, LinkedSpace{SpaceID: r.SpaceID, VaultID: r.VaultID})
	}
	return out, nil
}

// UnlinkSpace removes a space's cloud binding (local data is untouched; sync
// just stops for that space).
func (s *CloudService) UnlinkSpace(spaceID string) error {
	if s.vault == nil {
		return errors.New("cloud: vault service unavailable")
	}
	return s.vault.db.DeleteCloudVault(spaceID)
}

// RemoteVault is one cloud vault the signed-in account belongs to, annotated with
// the local space currently bound to it. It carries only the zero-knowledge-safe
// metadata the server exposes — the vault NAME is never included because the
// server never sees it (it lives encrypted inside the vault).
type RemoteVault struct {
	VaultID      string `json:"vaultId"`
	CreatedAt    string `json:"createdAt"`
	ItemCount    int64  `json:"itemCount"`
	CurrentSeq   int64  `json:"currentSeq"`
	Role         string `json:"role"`
	BoundSpaceID string `json:"boundSpaceId"` // local space bound to this vault; "" = unbound
}

// ListRemoteVaults returns every cloud vault the signed-in account is a member
// of, each annotated with the local space bound to it (BoundSpaceID="" when
// unbound). It is the data source for the "choose which cloud spaces to sync"
// UI — the user picks an unbound vault and binds it to a local space.
func (s *CloudService) ListRemoteVaults() ([]RemoteVault, error) {
	s.mu.RLock()
	client := s.client
	signedIn := s.session != nil
	accountID := ""
	if s.session != nil {
		accountID = s.session.accountID
	}
	s.mu.RUnlock()
	if !signedIn {
		return nil, ErrCloudNotSignedIn
	}
	if client == nil {
		return nil, ErrCloudNotConfigured
	}

	ctx, cancel := context.WithTimeout(context.Background(), cloud.DefaultTimeout)
	defer cancel()
	summaries, err := client.ListVaults(ctx)
	if err != nil {
		return nil, err
	}

	// Reverse map vault_id -> local space_id for this account's bindings.
	bound := make(map[string]string)
	if s.vault != nil {
		if rows, lerr := s.vault.db.ListCloudVaultsForAccount(accountID); lerr == nil {
			for _, r := range rows {
				bound[r.VaultID] = r.SpaceID
			}
		}
	}

	out := make([]RemoteVault, 0, len(summaries))
	for _, v := range summaries {
		out = append(out, RemoteVault{
			VaultID:      v.VaultID,
			CreatedAt:    v.CreatedAt,
			ItemCount:    v.ItemCount,
			CurrentSeq:   v.CurrentSeq,
			Role:         v.Role,
			BoundSpaceID: bound[v.VaultID],
		})
	}
	return out, nil
}

// BindCloudVault binds an EXISTING cloud vault to a local space — the inverse of
// CreateCloudVault (which mints a fresh vault for a space). It proves membership
// by unwrapping the vault key (member/self), records the binding, and kicks an
// immediate sync so the vault's items pull into the space. The 1:1 model is
// enforced: a space already bound, or a vault already bound to another space, is
// rejected (the caller must unlink first). Binding the same pair again is a
// no-op. Runs under syncMu so it cannot overlap a sync run.
func (s *CloudService) BindCloudVault(spaceID, vaultID string) error {
	spaceID = strings.TrimSpace(spaceID)
	vaultID = strings.TrimSpace(vaultID)
	if spaceID == "" || vaultID == "" {
		return errors.New("cloud: space id and vault id are required")
	}
	if s.vault == nil {
		return errors.New("cloud: vault service unavailable")
	}

	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	s.mu.RLock()
	client := s.client
	sess := s.session
	accountID := ""
	if sess != nil {
		accountID = sess.accountID
	}
	s.mu.RUnlock()
	if sess == nil {
		return ErrCloudNotSignedIn
	}
	if client == nil {
		return ErrCloudNotConfigured
	}

	// Enforce the 1:1 binding model.
	if existing, err := s.vault.db.GetCloudVaultBySpace(spaceID); err == nil && existing != nil {
		if existing.VaultID == vaultID {
			return nil // already bound to this vault — idempotent
		}
		return errors.New("cloud: this space is already linked to a different vault; unlink it first")
	}
	if rows, err := s.vault.db.ListCloudVaults(); err == nil {
		for _, r := range rows {
			if r.VaultID == vaultID && r.SpaceID != spaceID {
				return errors.New("cloud: this vault is already linked to another space")
			}
		}
	}

	// Prove membership and cache the vault key (404 -> not a member).
	ctx, cancel := context.WithTimeout(context.Background(), cloud.DefaultTimeout)
	defer cancel()
	if _, err := s.vaultKey(ctx, client, vaultID); err != nil {
		if errors.Is(err, ErrCloudNotMember) {
			return errors.New("cloud: not a member of this vault")
		}
		return fmt.Errorf("cloud: verify vault membership: %w", err)
	}

	if err := s.vault.db.PutCloudVault(spaceID, vaultID, accountID, nowMillis()); err != nil {
		return err
	}
	s.kickSync()
	return nil
}

// ---------------------------------------------------------------------------
// Sync entry points
// ---------------------------------------------------------------------------

// SyncNow runs one FULL reconcile over every bound space and returns a summary.
// It is a no-op (not an error) when signed out or the vault is locked.
func (s *CloudService) SyncNow() (CloudSyncSummary, error) {
	return s.runSync(context.Background(), true, nil)
}

// runSync reconciles bound spaces with the cloud. full=true forces a full
// snapshot reconcile per binding (rebuilds incremental state); full=false runs
// the cheap incremental path (delta pull keyed by the stored cursor). scope,
// when non-nil, restricts the run to the listed vault ids (the value is an
// optional seq hint); a nil scope means every binding.
func (s *CloudService) runSync(parent context.Context, full bool, scope map[string]int64) (CloudSyncSummary, error) {
	if s.vault == nil {
		return CloudSyncSummary{}, errors.New("cloud: vault service unavailable")
	}
	s.mu.RLock()
	signedIn := s.session != nil
	accountID := ""
	if s.session != nil {
		accountID = s.session.accountID
	}
	s.mu.RUnlock()
	if !signedIn {
		return CloudSyncSummary{SignedIn: false}, nil
	}
	if !s.vault.IsUnlocked() {
		return CloudSyncSummary{SignedIn: true}, nil
	}

	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	// Only the current account's bindings — a binding from a different account
	// would 404 on member/self and is not ours to sync.
	bindings, err := s.vault.db.ListCloudVaultsForAccount(accountID)
	if err != nil {
		return CloudSyncSummary{SignedIn: true}, err
	}
	// Restrict to the requested scope (SSE vault pings). A scoped run with no
	// matching binding is a clean no-op.
	if scope != nil {
		filtered := bindings[:0:0]
		for _, b := range bindings {
			if _, ok := scope[b.VaultID]; ok {
				filtered = append(filtered, b)
			}
		}
		bindings = filtered
	}
	summary := CloudSyncSummary{SignedIn: true, Vaults: len(bindings)}
	s.notifySync("pushing", 0, len(bindings), "")

	var lastErr error
	for i, b := range bindings {
		ctx, cancel := context.WithTimeout(parent, 3*cloud.DefaultTimeout)
		var pulled, pushed int
		if full {
			pulled, pushed, err = s.syncVaultFull(ctx, b.SpaceID, b.VaultID)
		} else {
			hint := int64(0)
			if scope != nil {
				hint = scope[b.VaultID]
			}
			pulled, pushed, err = s.syncVaultIncremental(ctx, b.SpaceID, b.VaultID, hint)
		}
		cancel()
		summary.Pulled += pulled
		summary.Pushed += pushed
		switch {
		case err == nil:
			// Adopt a legacy ('' account) binding now that membership is proven.
			if b.AccountID == "" && accountID != "" {
				_ = s.vault.db.SetCloudVaultAccount(b.SpaceID, accountID)
			}
			s.notifySync("pushing", i+1, len(bindings), "")
		case errors.Is(err, ErrCloudNotMember):
			// Stale binding for an unrelated vault — skip it, keep going. Drop
			// the binding so it stops being retried every cycle.
			_ = s.vault.db.DeleteCloudVault(b.SpaceID)
			s.emitEvent("cloud:sync:warning", map[string]any{
				"spaceId": b.SpaceID, "message": "not a member of bound vault; unlinked",
			})
		case errors.Is(err, ErrVaultLocked):
			// Vault locked mid-sync: not an error — the next cycle re-checks.
			return summary, nil
		case cloud.IsUnauthorized(err):
			// The session JWT expired OR was revoked (admin "sign out all
			// devices"). Tear the session down so the UI stops showing a signed-in
			// state it can no longer back with syncs, and prompt a re-sign-in.
			// Stop this run — every remaining vault would 401 too.
			s.notifySync("error", i+1, len(bindings), "session expired")
			go s.handleSessionRevoked()
			return summary, err
		default:
			// Keep syncing the other vaults; report the last failure.
			lastErr = err
			s.notifySync("error", i+1, len(bindings), err.Error())
		}
	}

	// Notify the local vault layer when sync wrote items so the UI reloads
	// the items list. IngestForeignPayload does not call notifyVaultChanged
	// itself (to avoid per-item spam), so we emit one batch notification here.
	if s.vault != nil && (summary.Pulled > 0 || summary.Pushed > 0) {
		s.vault.notifyVaultChanged("cloud-sync", "", "")
	}

	summary.Conflicts = s.conflictCount()
	if lastErr != nil {
		return summary, lastErr
	}
	s.lastSyncMs.Store(nowMillis())
	if full {
		s.lastFullSyncMs.Store(nowMillis())
	}
	s.notifySync("done", len(bindings), len(bindings), "")
	s.emitEvent("cloud:sync:done", map[string]any{
		"pulled": summary.Pulled, "pushed": summary.Pushed,
		"conflicts": summary.Conflicts, "updatedAt": nowMillis(),
	})
	return summary, nil
}

// syncVaultFull reconciles one bound space with its cloud vault via a complete
// snapshot pull, and rebuilds the per-item incremental state as a side effect.
// Caller holds syncMu. The client is captured once so a concurrent Configure()
// cannot split this vault's calls across two clients. This is the self-healing
// path (sign-in, SyncNow, 410, resync, the 6h tick); the hot path is
// syncVaultIncremental.
func (s *CloudService) syncVaultFull(ctx context.Context, spaceID, vaultID string) (pulled, pushed int, err error) {
	s.mu.RLock()
	client := s.client
	s.mu.RUnlock()
	if client == nil {
		return 0, 0, ErrCloudNotConfigured
	}

	vaultKey, err := s.vaultKey(ctx, client, vaultID)
	if err != nil {
		return 0, 0, fmt.Errorf("cloud: vault key: %w", err)
	}
	defer zeroBytes(vaultKey)

	// 1. Pull a full snapshot: the server's live set, with per-item seq + ct.
	//    Tombstones stay filtered here (the historical full view); deletes still
	//    propagate via the CAS-reveal path in pushItem/bridgePushConflict.
	remoteItems, currentSeq, err := s.fetchSnapshot(ctx, client, vaultID, false)
	if err != nil {
		return 0, 0, err
	}
	remoteByID := make(map[string]cloud.SnapshotItem, len(remoteItems))
	remote := make([]SyncManifestEntry, 0, len(remoteItems))
	for _, it := range remoteItems {
		id := localItemID(it.ItemID)
		if id == vaultManifestLocalID {
			continue // web_vault's vault-name manifest, not a real item
		}
		remoteByID[id] = it
		remote = append(remote, SyncManifestEntry{
			ID:        id,
			UpdatedAt: it.UpdatedAt,
			// Recompute from the ciphertext (already in hand) rather than trusting
			// the server-stored hash — see remoteContentHash. This is what makes a
			// vault converge across clients with incompatible hash conventions.
			ContentHash: s.remoteContentHash(id, it.Ciphertext, it.ContentHash, vaultKey),
			Revision:    it.Revision,
		})
	}

	// 2. Local manifest for this space (content hashes keyed by the vault key),
	// then the cloud LWW decision.
	local, err := s.localManifest(spaceID, vaultKey)
	if err != nil {
		return 0, 0, err
	}
	localByID := make(map[string]SyncManifestEntry, len(local))
	for _, e := range local {
		localByID[e.ID] = e
	}
	pulls, pushes, conflicts := cloudDecide(local, remote)

	// Items already pending user resolution must not be auto-applied; and a
	// pending conflict that has converged (no longer divergent this cycle) is
	// pruned so resolved-elsewhere items disappear from the resolver.
	pending := s.pendingConflictIDs(vaultID)
	divergent := conflictIDSet(conflicts)
	s.pruneConvergedConflicts(vaultID, divergent)

	// appliedClean tracks ids that converged this cycle (pull-applied or already
	// equal) so their state can be (re)written; conflicts and failures are left
	// out so their state is not falsely marked converged.
	conflictIDs := conflictIDSet(conflicts)
	pullFailed := false

	// 3. Apply clean remote-wins changes (pull), recording state on success.
	for _, id := range pulls {
		if pending[id] {
			continue
		}
		it, ok := remoteByID[id]
		if !ok {
			continue
		}
		applied, applyErr := s.applyRemoteItem(spaceID, id, it, vaultKey)
		if applyErr != nil {
			pullFailed = true
			s.emitEvent("cloud:sync:warning", map[string]any{"id": id, "message": applyErr.Error()})
			continue
		}
		if applied {
			pulled++
		}
		s.recordItemState(spaceID, id, it.Seq, remoteByID[id], vaultKey, false)
	}

	// 4. Push clean local-wins changes via optimistic CAS. A CAS rejection with
	// differing content is recorded as a conflict (never silently overwritten).
	for _, id := range pushes {
		if pending[id] {
			continue
		}
		baseSeq := int64(0)
		if it, ok := remoteByID[id]; ok {
			baseSeq = it.Seq
		}
		ok, assignedSeq, pErr := s.pushItem(ctx, client, spaceID, vaultID, id, baseSeq, vaultKey)
		if pErr != nil {
			return pulled, pushed, pErr
		}
		if ok {
			pushed++
			s.recordLocalState(spaceID, id, assignedSeq, localByID[id])
		}
	}

	// 5. Record genuine merge conflicts (same-ms divergent edits, delete-vs-edit)
	// for user resolution.
	for _, c := range conflicts {
		s.recordMergeConflict(spaceID, vaultID, c, remoteByID, vaultKey)
	}

	// 6. State for items that were already converged (neither pulled, pushed, nor
	// in conflict): record the server seq + the locally-recomputed hash so the
	// incremental path can skip them without decrypting next time.
	for id, it := range remoteByID {
		if pending[id] || conflictIDs[id] {
			continue
		}
		if _, isLocal := localByID[id]; !isLocal {
			continue // pull-only items handled above
		}
		if !containsID(pulls, id) && !containsID(pushes, id) {
			s.recordItemState(spaceID, id, it.Seq, it, vaultKey, false)
		}
	}

	// 7. Advance the cursor to the snapshot high-water mark so the next
	// incremental run only pulls newer rows. We use the snapshot's current_seq,
	// NOT any seq we just pushed: a concurrent writer may hold an intermediate
	// seq, and skipping it would miss that change. Our own pushes re-appear in
	// the next delta as hash-equal no-ops. Skip the advance if any pull failed
	// (re-pull next cycle, idempotent).
	if !pullFailed {
		if err := s.vault.db.SetCloudVaultCursor(spaceID, currentSeq); err != nil {
			s.emitEvent("cloud:sync:warning", map[string]any{"spaceId": spaceID, "message": "set cursor: " + err.Error()})
		}
	}
	return pulled, pushed, nil
}

// syncVaultIncremental pulls only the rows whose seq advanced past the stored
// cursor (the delta feed, tombstones included) and reconciles them against the
// local item set, using a content-hash shortlist so only genuinely changed
// local items get decrypted. Caller holds syncMu. hintSeq is the SSE event's
// high-water hint (0 when unknown). A cursor of 0 (never reconciled) or a 410
// (cursor below the server's retained floor) falls back to a full reconcile.
func (s *CloudService) syncVaultIncremental(ctx context.Context, spaceID, vaultID string, hintSeq int64) (pulled, pushed int, err error) {
	s.mu.RLock()
	client := s.client
	s.mu.RUnlock()
	if client == nil {
		return 0, 0, ErrCloudNotConfigured
	}

	binding, err := s.vault.db.GetCloudVaultBySpace(spaceID)
	if err != nil {
		return 0, 0, err
	}
	if binding == nil || binding.Cursor == 0 {
		// Never reconciled (bootstrap): a full pass establishes the cursor + state.
		return s.syncVaultFull(ctx, spaceID, vaultID)
	}
	cursor := binding.Cursor

	vaultKey, err := s.vaultKey(ctx, client, vaultID)
	if err != nil {
		return 0, 0, fmt.Errorf("cloud: vault key: %w", err)
	}
	defer zeroBytes(vaultKey)

	// 1. Pull the delta (rows with seq > cursor), tombstones included so remote
	//    deletes propagate. A 410 means the cursor fell below the GC floor —
	//    discard local sync state and full-resync.
	deltaItems, currentSeq, err := s.fetchSnapshotFrom(ctx, client, vaultID, cursor, true)
	if cloud.IsStatus(err, http.StatusGone) {
		_ = s.vault.db.SetCloudVaultCursor(spaceID, 0)
		_ = s.vault.db.DeleteCloudItemStates(spaceID)
		return s.syncVaultFull(ctx, spaceID, vaultID)
	}
	if err != nil {
		return 0, 0, err
	}
	deltaByID := make(map[string]cloud.SnapshotItem, len(deltaItems))
	for _, it := range deltaItems {
		id := localItemID(it.ItemID)
		if id == vaultManifestLocalID {
			continue
		}
		deltaByID[id] = it
	}

	// 2. Load per-item state + local rows, then compute the local-change
	//    shortlist (only candidates get decrypted/hashed — the O(delta) win).
	states, err := s.vault.db.GetCloudItemStates(spaceID)
	if err != nil {
		return 0, 0, err
	}
	rows, err := s.vault.db.SpaceItemRowsForSync(spaceID)
	if err != nil {
		return 0, 0, err
	}
	candidates, refresh := s.localChangeShortlist(rows, states, vaultKey)
	// Items confirmed unchanged (hash still matches): just bump synced_at so the
	// next cycle's timestamp gate skips them without rehashing.
	for id, at := range refresh {
		if st, ok := states[id]; ok {
			st.SyncedAt = at
			_ = s.vault.db.PutCloudItemState(spaceID, st)
		}
	}

	pending := s.pendingConflictIDs(vaultID)
	pullFailed := false

	// 3. Remote tombstones in the delta.
	for id, it := range deltaByID {
		if !it.Deleted || pending[id] {
			continue
		}
		row, _ := s.vault.db.GetItem(id)
		switch {
		case row == nil || row.DeletedAt != nil:
			// Not present locally, or already deleted — converge state (double-delete).
			s.recordTombstoneState(spaceID, id, it.Seq, it.UpdatedAt)
		case !candidates[id]:
			// Locally live, no pending local change → remote delete wins (LWW).
			if applyErr := s.applyRemoteDelete(id); applyErr != nil {
				pullFailed = true
				s.emitEvent("cloud:sync:warning", map[string]any{"id": id, "message": applyErr.Error()})
				continue
			}
			pulled++
			s.recordTombstoneState(spaceID, id, it.Seq, it.UpdatedAt)
		default:
			// Locally edited AND remotely deleted: LWW by timestamp.
			if row.UpdatedAt > it.UpdatedAt {
				s.storeConflict(spaceID, vaultID, id, syncMergeConflict{
					ID: id, Kind: "delete_vs_edit",
					Local:           SyncManifestEntry{ID: id, UpdatedAt: row.UpdatedAt},
					Remote:          SyncManifestEntry{ID: id, DeletedAt: it.UpdatedAt, UpdatedAt: it.UpdatedAt},
					SuggestedRemote: false,
				}, &cloud.ServerItem{Seq: it.Seq, Deleted: true, UpdatedAt: it.UpdatedAt}, vaultKey)
			} else if applyErr := s.applyRemoteDelete(id); applyErr != nil {
				pullFailed = true
				s.emitEvent("cloud:sync:warning", map[string]any{"id": id, "message": applyErr.Error()})
			} else {
				pulled++
				s.recordTombstoneState(spaceID, id, it.Seq, it.UpdatedAt)
			}
		}
		delete(candidates, id) // handled
	}

	// 4. Live delta ∪ local candidates → cloudDecide over just this working set.
	workIDs := make(map[string]bool)
	for id, it := range deltaByID {
		if !it.Deleted {
			workIDs[id] = true
		}
	}
	for id := range candidates {
		workIDs[id] = true
	}
	localWork := make([]SyncManifestEntry, 0, len(workIDs))
	remoteWork := make([]SyncManifestEntry, 0, len(workIDs))
	localByID := make(map[string]SyncManifestEntry, len(workIDs))
	for id := range workIDs {
		if e, ok := s.localEntryFor(id, vaultKey); ok {
			localWork = append(localWork, e)
			localByID[id] = e
		}
		if it, ok := deltaByID[id]; ok && !it.Deleted {
			remoteWork = append(remoteWork, SyncManifestEntry{
				ID:          id,
				UpdatedAt:   it.UpdatedAt,
				ContentHash: s.remoteContentHash(id, it.Ciphertext, it.ContentHash, vaultKey),
				Revision:    it.Revision,
			})
		}
	}
	pulls, pushes, conflicts := cloudDecide(localWork, remoteWork)
	s.pruneConvergedConflictsScoped(vaultID, workIDs, conflictIDSet(conflicts))
	conflictIDs := conflictIDSet(conflicts)

	for _, id := range pulls {
		if pending[id] {
			continue
		}
		it, ok := deltaByID[id]
		if !ok {
			continue
		}
		applied, applyErr := s.applyRemoteItem(spaceID, id, it, vaultKey)
		if applyErr != nil {
			pullFailed = true
			s.emitEvent("cloud:sync:warning", map[string]any{"id": id, "message": applyErr.Error()})
			continue
		}
		if applied {
			pulled++
		}
		s.recordItemState(spaceID, id, it.Seq, it, vaultKey, false)
	}
	for _, id := range pushes {
		if pending[id] {
			continue
		}
		baseSeq := int64(0)
		if it, ok := deltaByID[id]; ok {
			baseSeq = it.Seq
		} else if st, ok := states[id]; ok {
			baseSeq = st.Seq
		}
		ok, assignedSeq, pErr := s.pushItem(ctx, client, spaceID, vaultID, id, baseSeq, vaultKey)
		if pErr != nil {
			return pulled, pushed, pErr
		}
		if ok {
			pushed++
			s.recordLocalState(spaceID, id, assignedSeq, localByID[id])
		}
	}
	for _, c := range conflicts {
		s.recordMergeConflict(spaceID, vaultID, c, deltaByID, vaultKey)
	}
	// Converged live-delta items (in delta, neither pulled/pushed/conflict):
	// record state so a future delta containing them is a no-op.
	for id, it := range deltaByID {
		if it.Deleted || pending[id] || conflictIDs[id] {
			continue
		}
		if !containsID(pulls, id) && !containsID(pushes, id) {
			s.recordItemState(spaceID, id, it.Seq, it, vaultKey, false)
		}
	}

	// 5. Advance the cursor (same rule as the full path: snapshot high-water,
	// never a pushed seq). Skip on a pull failure so it re-pulls next cycle.
	if !pullFailed && currentSeq > cursor {
		if err := s.vault.db.SetCloudVaultCursor(spaceID, currentSeq); err != nil {
			s.emitEvent("cloud:sync:warning", map[string]any{"spaceId": spaceID, "message": "set cursor: " + err.Error()})
		}
	}
	_ = hintSeq // reserved: a future optimization can short-circuit when hintSeq <= cursor and no local candidates exist
	return pulled, pushed, nil
}

// localChangeShortlist classifies local rows against the recorded sync state,
// returning the set of ids that need pushing (changed/new/locally-deleted) and
// a map of ids whose hash was confirmed unchanged (only their synced_at should
// be refreshed). Only rows whose updatedAt advanced past synced_at are
// decrypted+hashed; everything else is skipped without touching the vault key.
// Pure over its inputs except for the decrypt/hash it performs via s.
func (s *CloudService) localChangeShortlist(rows []VaultItemRow, states map[string]CloudItemState, vaultKey []byte) (candidates map[string]bool, refresh map[string]int64) {
	candidates = make(map[string]bool)
	refresh = make(map[string]int64)
	for i := range rows {
		row := &rows[i]
		st, hasState := states[row.ID]
		if row.DeletedAt != nil {
			// Local tombstone.
			if !hasState {
				continue // orphan local delete (never synced) — nothing to push
			}
			if !st.Deleted {
				candidates[row.ID] = true // delete not yet pushed
			}
			continue
		}
		// Live row.
		if !hasState {
			candidates[row.ID] = true // brand-new local item
			continue
		}
		if row.UpdatedAt < st.SyncedAt {
			continue // older than last converged state — unchanged
		}
		// Timestamp advanced (or equal): confirm by hash before deciding.
		if payload, err := s.vault.getItemAnySpace(row.ID); err == nil && payload != nil {
			h := cloudContentHash(vaultKey, payload)
			if h == st.SyncedHash && !st.Deleted {
				refresh[row.ID] = row.UpdatedAt // unchanged content, stale timestamp
			} else {
				candidates[row.ID] = true
			}
		} else {
			candidates[row.ID] = true // can't confirm — treat as changed (safe)
		}
	}
	return candidates, refresh
}

// localEntryFor builds a manifest entry for one local id (live or tombstone),
// reporting ok=false if the item does not exist locally.
func (s *CloudService) localEntryFor(id string, vaultKey []byte) (SyncManifestEntry, bool) {
	row, err := s.vault.db.GetItem(id)
	if err != nil || row == nil {
		return SyncManifestEntry{}, false
	}
	entry := SyncManifestEntry{ID: id, UpdatedAt: row.UpdatedAt}
	if row.DeletedAt != nil {
		entry.DeletedAt = *row.DeletedAt
		return entry, true
	}
	if payload, err := s.vault.getItemAnySpace(id); err == nil && payload != nil {
		entry.ContentHash = cloudContentHash(vaultKey, payload)
		entry.Revision = payload.Revision
	}
	return entry, true
}

// recordItemState writes the converged sync state for a live remote item,
// recomputing the local-canonical hash from its ciphertext. deletedOverride
// forces the tombstone flag (callers for live items pass false).
func (s *CloudService) recordItemState(spaceID, id string, seq int64, it cloud.SnapshotItem, vaultKey []byte, deletedOverride bool) {
	hash := s.remoteContentHash(id, it.Ciphertext, it.ContentHash, vaultKey)
	_ = s.vault.db.PutCloudItemState(spaceID, CloudItemState{
		ItemID: id, Seq: seq, SyncedHash: hash, SyncedAt: it.UpdatedAt, Deleted: deletedOverride,
	})
}

// recordLocalState writes state after a successful push of a local item, using
// the server-assigned seq and the local manifest entry's hash/timestamp.
func (s *CloudService) recordLocalState(spaceID, id string, assignedSeq int64, local SyncManifestEntry) {
	_ = s.vault.db.PutCloudItemState(spaceID, CloudItemState{
		ItemID: id, Seq: assignedSeq, SyncedHash: local.ContentHash,
		SyncedAt: local.UpdatedAt, Deleted: local.DeletedAt > 0,
	})
}

// recordTombstoneState writes state marking an item as converged-deleted.
func (s *CloudService) recordTombstoneState(spaceID, id string, seq, updatedAt int64) {
	_ = s.vault.db.PutCloudItemState(spaceID, CloudItemState{
		ItemID: id, Seq: seq, SyncedHash: "", SyncedAt: updatedAt, Deleted: true,
	})
}

// containsID reports whether s contains id (small slices; linear is fine).
func containsID(s []string, id string) bool {
	for _, v := range s {
		if v == id {
			return true
		}
	}
	return false
}

// pruneConvergedConflictsScoped drops pending conflicts for a vault that are in
// the current working set but no longer divergent. Unlike the full-path prune,
// it leaves conflicts OUTSIDE the working set untouched (an incremental cycle
// only saw a slice of the vault, so it cannot judge ids it did not examine).
func (s *CloudService) pruneConvergedConflictsScoped(vaultID string, scope map[string]bool, stillDivergent map[string]bool) {
	s.conflictsMu.Lock()
	defer s.conflictsMu.Unlock()
	for id, c := range s.conflicts {
		if c.vaultID == vaultID && scope[id] && !stillDivergent[id] {
			delete(s.conflicts, id)
		}
	}
}

// cloudDecide is the cloud sync decision over a local manifest and the remote
// live snapshot (tombstones already filtered out server-side). It uses
// last-writer-wins by updatedAt for the direction; only genuinely ambiguous
// cases are surfaced as conflicts up front (same updatedAt with different
// content, and a local delete older than a remote edit). A CAS push later
// catches a concurrent modification the snapshot could not show.
//
// A local-only live item is pushed with base_seq 0; if the server actually holds
// a tombstone for it, the CAS conflict reveals the remote delete (the snapshot
// hid it). That is how deletions propagate without an incremental changes feed.
func cloudDecide(local, remote []SyncManifestEntry) (pulls, pushes []string, conflicts []syncMergeConflict) {
	localByID := make(map[string]SyncManifestEntry, len(local))
	for _, e := range local {
		localByID[e.ID] = e
	}
	remoteByID := make(map[string]SyncManifestEntry, len(remote))
	for _, e := range remote {
		remoteByID[e.ID] = e
	}

	for _, r := range remote {
		l, ok := localByID[r.ID]
		if !ok {
			pulls = append(pulls, r.ID) // brand new remote item
			continue
		}
		if l.DeletedAt > 0 {
			// Local deleted, remote still live.
			if l.DeletedAt >= r.UpdatedAt {
				pushes = append(pushes, l.ID) // our delete is newer → push tombstone
			} else {
				conflicts = append(conflicts, syncMergeConflict{
					ID: l.ID, Kind: "delete_vs_edit", Local: l, Remote: r,
					SuggestedRemote: true, // remote edited after our delete
				})
			}
			continue
		}
		sameHash := l.ContentHash != "" && l.ContentHash == r.ContentHash
		bothHashed := l.ContentHash != "" && r.ContentHash != ""
		switch {
		case sameHash && l.UpdatedAt == r.UpdatedAt:
			// identical — nothing to do
		case l.UpdatedAt > r.UpdatedAt:
			pushes = append(pushes, l.ID) // local newer (content or just ts) → push
		case l.UpdatedAt < r.UpdatedAt:
			pulls = append(pulls, l.ID) // remote newer → pull
		case bothHashed:
			// equal updatedAt, both hashes known and differing → a true
			// simultaneous edit. r.ContentHash here is the locally-recomputed
			// canonical hash (see remoteContentHash), not the raw server-stored
			// value, so a format mismatch can no longer masquerade as divergence.
			// (When either side has no content_hash — e.g. a web_vault item, which
			// stores null — equal updatedAt is treated as converged rather than a
			// spurious conflict.)
			conflicts = append(conflicts, syncMergeConflict{
				ID: l.ID, Kind: "concurrent_edit", Local: l, Remote: r,
				SuggestedRemote: r.Revision > l.Revision,
			})
		}
	}

	// Local items the live snapshot does not have: new locally, or deleted
	// remotely (CAS push reveals which). Local-only tombstones are skipped.
	for _, l := range local {
		if _, ok := remoteByID[l.ID]; ok {
			continue
		}
		if l.DeletedAt > 0 {
			continue // nothing live on the server to delete that we can see
		}
		pushes = append(pushes, l.ID)
	}
	return pulls, pushes, conflicts
}

// fetchSnapshot pages a snapshot from cursor 0 (full reconcile). See
// fetchSnapshotFrom for the paging contract. Returns the items, the snapshot's
// high-water current_seq (for the cursor), and any error.
func (s *CloudService) fetchSnapshot(ctx context.Context, client *cloud.Client, vaultID string, includeDeleted bool) ([]cloud.SnapshotItem, int64, error) {
	return s.fetchSnapshotFrom(ctx, client, vaultID, 0, includeDeleted)
}

// fetchSnapshotFrom pages a snapshot starting after startCursor. It does NOT
// trust has_more (which the server computes after tombstone filtering and can
// false-negative); it pages until the cursor stops advancing or reaches
// current_seq. It must NOT break on an empty page: a window that is all
// tombstones yields zero items but its next_cursor still advances past live
// items that follow. Returns the accumulated items and the last page's
// current_seq (the high-water mark to store as the new cursor).
func (s *CloudService) fetchSnapshotFrom(ctx context.Context, client *cloud.Client, vaultID string, startCursor int64, includeDeleted bool) ([]cloud.SnapshotItem, int64, error) {
	var items []cloud.SnapshotItem
	cursor := startCursor
	currentSeq := startCursor
	for {
		page, err := client.Snapshot(ctx, vaultID, cursor, snapshotPageLimit, includeDeleted)
		if err != nil {
			return nil, 0, fmt.Errorf("cloud: snapshot: %w", err)
		}
		items = append(items, page.Items...)
		currentSeq = page.CurrentSeq
		// Terminate solely on cursor progress: next_cursor not advancing (the
		// server has no more rows past cursor) or reaching the high-water seq.
		if page.NextCursor <= cursor || page.NextCursor >= page.CurrentSeq {
			break
		}
		cursor = page.NextCursor
	}
	return items, currentSeq, nil
}

// applyRemoteItem decrypts a snapshot item with the vault key and ingests the
// plaintext under the local DEK, pinning it to the bound space. Returns
// (applied, err): applied is false when the item was skipped by LWW (local is
// already at least as new), true when it was actually written to the DB.
func (s *CloudService) applyRemoteItem(spaceID, id string, it cloud.SnapshotItem, vaultKey []byte) (bool, error) {
	payload, err := s.decryptRemote(id, it, vaultKey)
	if err != nil || payload == nil {
		return false, err
	}
	payload.SpaceID = spaceID
	applied, err := s.vault.IngestForeignPayload(id, payload, payload.CreatedAt, it.UpdatedAt)
	return applied, err
}

// decryptRemote turns a snapshot item's ciphertext into a desktop ItemPayload.
// The aad is the hyphenated cloud id (web_vault's uuid form, the server's stored
// item_id), and the plaintext is a web_vault ItemRecord transcoded into the
// desktop payload. The plaintext buffer is wiped before returning.
func (s *CloudService) decryptRemote(localID string, it cloud.SnapshotItem, vaultKey []byte) (*ItemPayload, error) {
	ctBytes, err := cloudB64.DecodeString(it.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("cloud: decode item ciphertext: %w", err)
	}
	plaintext, err := cloudcrypto.OpenAEAD(vaultKey, ctBytes, []byte(cloudItemID(localID)))
	if err != nil {
		return nil, fmt.Errorf("cloud: decrypt item %s: %w", localID, err)
	}
	defer zeroBytes(plaintext)
	payload, err := webVaultRecordToPayload(plaintext)
	if err != nil {
		return nil, fmt.Errorf("cloud: parse item %s: %w", localID, err)
	}
	return payload, nil
}

// remoteContentHash returns the desktop-canonical content hash for a remote item
// by decrypting its ciphertext and rehashing with the local vault key, rather
// than trusting the server-stored hash. The stored hash is unreliable across the
// fleet: web_vault writes null, skeleton-cli hashes the raw plaintext, and a
// pre-fix desktop wrote an older (with-empties) canonical form — so comparing a
// freshly recomputed local hash against a stored remote hash would surface
// phantom conflicts for identical content. Recomputing both sides with
// cloudContentHash makes the comparison format-agnostic and self-healing.
//
// The empty-stored case is preserved deliberately: cloudDecide treats an empty
// remote hash + equal updatedAt as converged (the web_vault null path). Returning
// "" there keeps that behavior instead of minting a hash web_vault never had.
// On any decrypt/parse failure it falls back to the server-stored hash.
func (s *CloudService) remoteContentHash(localID, ciphertext, stored string, vaultKey []byte) string {
	if stored == "" || ciphertext == "" {
		return stored
	}
	payload, err := s.decryptRemote(localID, cloud.SnapshotItem{ItemID: localID, Ciphertext: ciphertext}, vaultKey)
	if err != nil || payload == nil {
		return stored
	}
	return cloudContentHash(vaultKey, payload)
}

// pushItem encrypts a local item (or tombstone) with the vault key and pushes it
// with optimistic CAS. A returned conflict is bridged by LWW: differing content
// becomes a recorded conflict, identical content converges silently. Returns
// (pushed, assignedSeq, err): pushed is true only on a clean CAS accept, in
// which case assignedSeq is the server-allocated seq (for the sync state).
func (s *CloudService) pushItem(ctx context.Context, client *cloud.Client, spaceID, vaultID, id string, baseSeq int64, vaultKey []byte) (bool, int64, error) {
	req, localEntry, err := s.buildChangeRequest(id, baseSeq, vaultKey)
	if err != nil || req == nil {
		return false, 0, err
	}
	resp, err := client.PostChange(ctx, vaultID, *req)
	if err != nil {
		return false, 0, err
	}
	if !resp.IsConflict() {
		return true, resp.AssignedSeq, nil
	}
	return false, 0, s.bridgePushConflict(spaceID, vaultID, id, localEntry, resp.Server, vaultKey)
}

// buildChangeRequest assembles a ChangeRequest for the local state of id (live
// item or tombstone), returning the local manifest entry for conflict bridging.
// The content_hash is keyed by the vault key (HMAC) so the server cannot
// correlate identical plaintext across vaults.
func (s *CloudService) buildChangeRequest(id string, baseSeq int64, vaultKey []byte) (*cloud.ChangeRequest, SyncManifestEntry, error) {
	row, err := s.vault.db.GetItem(id)
	if err != nil || row == nil {
		return nil, SyncManifestEntry{}, err
	}
	mutID, err := newUUID()
	if err != nil {
		return nil, SyncManifestEntry{}, err
	}
	// entry.ID is the local (hyphenless) id — the merge key. The wire item_id and
	// the AEAD aad use the hyphenated cloud form shared with web_vault.
	entry := SyncManifestEntry{ID: id, UpdatedAt: row.UpdatedAt}
	wireID := cloudItemID(id)

	if row.DeletedAt != nil {
		entry.DeletedAt = *row.DeletedAt
		return &cloud.ChangeRequest{
			ItemID:           wireID,
			BaseSeq:          baseSeq,
			Deleted:          true,
			UpdatedAt:        *row.DeletedAt,
			Revision:         row.UpdatedAt,
			ClientMutationID: mutID,
		}, entry, nil
	}

	payload, err := s.vault.getItemAnySpace(id)
	if err != nil || payload == nil {
		return nil, entry, err
	}
	// Seal the cloud-canonical web_vault ItemRecord, not the desktop payload.
	plaintext, err := payloadToWebVaultRecord(payload)
	if err != nil {
		return nil, entry, err
	}
	ct, err := cloudcrypto.SealAEAD(vaultKey, plaintext, []byte(wireID))
	zeroBytes(plaintext)
	if err != nil {
		return nil, entry, err
	}
	hash := cloudContentHash(vaultKey, payload)
	entry.ContentHash = hash
	entry.Revision = payload.Revision
	return &cloud.ChangeRequest{
		ItemID:           wireID,
		BaseSeq:          baseSeq,
		Deleted:          false,
		Ciphertext:       cloudB64.EncodeToString(ct),
		ContentHash:      hash,
		UpdatedAt:        row.UpdatedAt,
		Revision:         payload.Revision,
		ClientMutationID: mutID,
	}, entry, nil
}

// bridgePushConflict reconciles a CAS rejection. The CAS already proved the
// server moved under us. We never silently lose differing content: identical
// content converges; otherwise the item is recorded as a conflict for the user
// to resolve (which keeps the auto-sync loop from livelocking on an item that
// can only win via an explicit force-push in ApplyMerge).
func (s *CloudService) bridgePushConflict(spaceID, vaultID, id string, local SyncManifestEntry, server *cloud.ServerItem, vaultKey []byte) error {
	if server == nil {
		// No server history but base_seq mismatched — re-evaluate next cycle.
		return nil
	}

	if server.Deleted {
		if local.DeletedAt > 0 {
			s.recordTombstoneState(spaceID, id, server.Seq, server.UpdatedAt)
			return nil // both deleted — converged
		}
		serverTime := server.UpdatedAt
		localTime := local.UpdatedAt
		if localTime <= serverTime {
			if err := s.applyRemoteDelete(id); err != nil {
				return err
			}
			s.recordTombstoneState(spaceID, id, server.Seq, server.UpdatedAt)
			return nil // remote delete wins (LWW)
		}
		// Local edit is newer than the remote delete: a destructive ambiguity.
		// Record it; ApplyMerge "local" can force-resurrect, "remote" deletes.
		s.storeConflict(spaceID, vaultID, id, syncMergeConflict{
			ID: id, Kind: "delete_vs_edit", Local: local,
			Remote:          SyncManifestEntry{ID: id, DeletedAt: serverTime, UpdatedAt: serverTime},
			SuggestedRemote: false,
		}, server, vaultKey)
		return nil
	}

	// Server side is live. Recompute the server hash from its ciphertext (same
	// reason as the snapshot path: the stored hash may be a foreign/older format
	// that no longer matches the local canonical form for identical content).
	serverHash := s.remoteContentHash(id, server.Ciphertext, server.ContentHash, vaultKey)
	if local.ContentHash != "" && local.ContentHash == serverHash {
		// Same content, only seq differs — converged. Record the server seq so
		// the next incremental cycle treats it as a no-op.
		_ = s.vault.db.PutCloudItemState(spaceID, CloudItemState{
			ItemID: id, Seq: server.Seq, SyncedHash: serverHash,
			SyncedAt: server.UpdatedAt, Deleted: false,
		})
		return nil
	}
	switch {
	case local.UpdatedAt < server.UpdatedAt:
		// Remote strictly newer with different content → remote wins (LWW).
		if err := s.applyServerLive(spaceID, id, server, vaultKey); err != nil {
			return err
		}
		_ = s.vault.db.PutCloudItemState(spaceID, CloudItemState{
			ItemID: id, Seq: server.Seq, SyncedHash: serverHash,
			SyncedAt: server.UpdatedAt, Deleted: false,
		})
		return nil
	default:
		// Local newer or same instant, content differs → genuine concurrent
		// edit. Record it (ApplyMerge "local" force-pushes to win).
		s.storeConflict(spaceID, vaultID, id, syncMergeConflict{
			ID: id, Kind: "concurrent_edit", Local: local,
			Remote: SyncManifestEntry{
				ID: id, UpdatedAt: server.UpdatedAt,
				ContentHash: serverHash, Revision: server.Revision,
			},
			SuggestedRemote: server.Revision > local.Revision,
		}, server, vaultKey)
		return nil
	}
}

// applyServerLive ingests a server-authoritative live version from a conflict.
func (s *CloudService) applyServerLive(spaceID, id string, server *cloud.ServerItem, vaultKey []byte) error {
	if server.Ciphertext == "" {
		return nil
	}
	payload, err := s.decryptRemote(id, cloud.SnapshotItem{ItemID: id, Ciphertext: server.Ciphertext, UpdatedAt: server.UpdatedAt}, vaultKey)
	if err != nil || payload == nil {
		return err
	}
	payload.SpaceID = spaceID
	_, err = s.vault.IngestForeignPayload(id, payload, payload.CreatedAt, server.UpdatedAt)
	return err
}

// applyRemoteDelete tombstones a locally live item that was deleted remotely.
func (s *CloudService) applyRemoteDelete(id string) error {
	err := s.vault.deleteItemAnySpace(id)
	if errors.Is(err, ErrItemNotFound) {
		return nil
	}
	return err
}

// ---------------------------------------------------------------------------
// conflict store + manual resolution
// ---------------------------------------------------------------------------

// pendingConflictIDs returns the ids with a pending conflict for a vault.
func (s *CloudService) pendingConflictIDs(vaultID string) map[string]bool {
	s.conflictsMu.Lock()
	defer s.conflictsMu.Unlock()
	out := make(map[string]bool)
	for id, c := range s.conflicts {
		if c.vaultID == vaultID {
			out[id] = true
		}
	}
	return out
}

func conflictIDSet(cs []syncMergeConflict) map[string]bool {
	out := make(map[string]bool, len(cs))
	for _, c := range cs {
		out[c.ID] = true
	}
	return out
}

// pruneConvergedConflicts drops pending conflicts for a vault that are no longer
// classified as divergent this cycle (e.g. the user resolved them on another
// device and the item converged).
func (s *CloudService) pruneConvergedConflicts(vaultID string, stillDivergent map[string]bool) {
	s.conflictsMu.Lock()
	defer s.conflictsMu.Unlock()
	for id, c := range s.conflicts {
		if c.vaultID == vaultID && !stillDivergent[id] {
			delete(s.conflicts, id)
		}
	}
}

// recordMergeConflict captures a merge-detected conflict (both sides diverged),
// decrypting the remote snapshot payload for the UI.
func (s *CloudService) recordMergeConflict(spaceID, vaultID string, c syncMergeConflict, remoteByID map[string]cloud.SnapshotItem, vaultKey []byte) {
	var remote *ItemPayload
	remoteDeleted := c.Remote.DeletedAt > 0
	if it, ok := remoteByID[c.ID]; ok && !remoteDeleted {
		remote, _ = s.decryptRemote(c.ID, it, vaultKey)
	}
	local, _ := s.vault.getItemAnySpace(c.ID)
	seq := int64(0)
	if it, ok := remoteByID[c.ID]; ok {
		seq = it.Seq
	}
	s.putConflict(&cloudConflict{
		conflict: SyncConflict{
			ID:              c.ID,
			Kind:            c.Kind,
			Local:           local,
			Remote:          remote,
			LocalManifest:   c.Local,
			RemoteManifest:  c.Remote,
			SuggestedRemote: c.SuggestedRemote,
		},
		vaultID:       vaultID,
		spaceID:       spaceID,
		serverSeq:     seq,
		remote:        remote,
		remoteDeleted: remoteDeleted,
	})
}

// storeConflict captures a CAS-bridged conflict using the server version.
func (s *CloudService) storeConflict(spaceID, vaultID, id string, c syncMergeConflict, server *cloud.ServerItem, vaultKey []byte) {
	var remote *ItemPayload
	if !server.Deleted {
		remote, _ = s.decryptRemote(id, cloud.SnapshotItem{ItemID: id, Ciphertext: server.Ciphertext, UpdatedAt: server.UpdatedAt}, vaultKey)
	}
	local, _ := s.vault.getItemAnySpace(id)
	s.putConflict(&cloudConflict{
		conflict: SyncConflict{
			ID:              id,
			Kind:            c.Kind,
			Local:           local,
			Remote:          remote,
			LocalManifest:   c.Local,
			RemoteManifest:  c.Remote,
			SuggestedRemote: c.SuggestedRemote,
		},
		vaultID:       vaultID,
		spaceID:       spaceID,
		serverSeq:     server.Seq,
		remote:        remote,
		remoteDeleted: server.Deleted,
	})
}

// putConflict inserts/updates a pending conflict, PRESERVING a resolution the
// user already chose for the same id (so a background sync between
// ResolveConflict and ApplyMerge cannot clobber the user's decision).
func (s *CloudService) putConflict(c *cloudConflict) {
	s.conflictsMu.Lock()
	if s.conflicts == nil {
		s.conflicts = make(map[string]*cloudConflict)
	}
	if old, ok := s.conflicts[c.conflict.ID]; ok && old.conflict.Resolution != "" {
		c.conflict.Resolution = old.conflict.Resolution
	}
	s.conflicts[c.conflict.ID] = c
	s.conflictsMu.Unlock()
	s.emitEvent("cloud:sync:conflict", map[string]any{
		"id": c.conflict.ID, "kind": c.conflict.Kind, "updatedAt": nowMillis(),
	})
}

func (s *CloudService) conflictCount() int {
	s.conflictsMu.Lock()
	defer s.conflictsMu.Unlock()
	return len(s.conflicts)
}

// ListConflicts returns the pending conflicts for the resolver UI.
func (s *CloudService) ListConflicts() []SyncConflict {
	s.conflictsMu.Lock()
	defer s.conflictsMu.Unlock()
	out := make([]SyncConflict, 0, len(s.conflicts))
	for _, c := range s.conflicts {
		out = append(out, c.conflict)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ResolveConflict records the user's choice for one conflict.
func (s *CloudService) ResolveConflict(id, resolution string) error {
	switch resolution {
	case "local", "remote", "duplicate", "skip":
	default:
		return fmt.Errorf("cloud: invalid resolution %q", resolution)
	}
	s.conflictsMu.Lock()
	defer s.conflictsMu.Unlock()
	c, ok := s.conflicts[id]
	if !ok {
		return fmt.Errorf("cloud: no pending conflict %s", id)
	}
	c.conflict.Resolution = resolution
	return nil
}

// ApplyMerge applies every resolved conflict, then clears the applied ones.
// Unresolved conflicts block the apply (mirrors the LAN SyncService contract).
// It runs under syncMu so it never overlaps a background sync.
func (s *CloudService) ApplyMerge() (int, error) {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	s.conflictsMu.Lock()
	for _, c := range s.conflicts {
		if c.conflict.Resolution == "" {
			s.conflictsMu.Unlock()
			return 0, errors.New("cloud: unresolved conflicts remain")
		}
	}
	pending := make([]*cloudConflict, 0, len(s.conflicts))
	for _, c := range s.conflicts {
		pending = append(pending, c)
	}
	s.conflictsMu.Unlock()

	s.mu.RLock()
	client := s.client
	s.mu.RUnlock()

	ctx, cancel := context.WithTimeout(context.Background(), 3*cloud.DefaultTimeout)
	defer cancel()

	applied := 0
	for _, c := range pending {
		if err := s.applyResolution(ctx, client, c); err != nil {
			continue // leave it pending on failure
		}
		applied++
		s.conflictsMu.Lock()
		delete(s.conflicts, c.conflict.ID)
		s.conflictsMu.Unlock()
	}
	return applied, nil
}

func (s *CloudService) applyResolution(ctx context.Context, client *cloud.Client, c *cloudConflict) error {
	switch c.conflict.Resolution {
	case "skip":
		return nil
	case "remote":
		if c.remoteDeleted {
			if err := s.applyRemoteDelete(c.conflict.ID); err != nil {
				return err
			}
			s.recordTombstoneState(c.spaceID, c.conflict.ID, c.serverSeq, c.conflict.RemoteManifest.UpdatedAt)
			return nil
		}
		if c.remote == nil {
			return errors.New("cloud: remote payload unavailable")
		}
		payload := *c.remote
		payload.SpaceID = c.spaceID
		// Forced: a concurrent_edit conflict is equal-timestamp by definition, so a
		// plain LWW ingest would no-op and the conflict would recur every sync.
		if _, err := s.vault.IngestForeignPayloadForced(c.conflict.ID, &payload, payload.CreatedAt, c.conflict.RemoteManifest.UpdatedAt); err != nil {
			return err
		}
		_ = s.vault.db.PutCloudItemState(c.spaceID, CloudItemState{
			ItemID: c.conflict.ID, Seq: c.serverSeq,
			SyncedHash: c.conflict.RemoteManifest.ContentHash,
			SyncedAt:   c.conflict.RemoteManifest.UpdatedAt, Deleted: false,
		})
		return nil
	case "local":
		if client == nil {
			return ErrCloudNotConfigured
		}
		vaultKey, err := s.vaultKey(ctx, client, c.vaultID)
		if err != nil {
			return err
		}
		defer zeroBytes(vaultKey)
		return s.forcePushLocal(ctx, client, c.spaceID, c.vaultID, c.conflict.ID, c.serverSeq, vaultKey)
	case "duplicate":
		if c.remote == nil {
			return errors.New("cloud: remote payload unavailable")
		}
		dup := *c.remote
		dup.ID = ""
		dup.DeletedAt = nil
		_, err := s.vault.createItemInSpace(dup, c.spaceID)
		return err
	}
	return nil
}

// forcePushLocal pushes the local version of id, retrying against the server's
// reported current seq on each CAS rejection until it wins (or gives up). This
// is how a user's explicit "keep local" decision overrides a server that moved
// under us — it never falls back to applying the remote version. On a win it
// records the converged sync state under spaceID.
func (s *CloudService) forcePushLocal(ctx context.Context, client *cloud.Client, spaceID, vaultID, id string, startSeq int64, vaultKey []byte) error {
	baseSeq := startSeq
	for attempt := 0; attempt < forcePushMaxRetry; attempt++ {
		req, localEntry, err := s.buildChangeRequest(id, baseSeq, vaultKey)
		if err != nil {
			return err
		}
		if req == nil {
			return nil // item vanished locally — nothing to force
		}
		resp, err := client.PostChange(ctx, vaultID, *req)
		if err != nil {
			return err
		}
		if !resp.IsConflict() {
			s.recordLocalState(spaceID, id, resp.AssignedSeq, localEntry)
			return nil // local version won
		}
		if resp.Server == nil {
			return errors.New("cloud: force push conflict without server version")
		}
		baseSeq = resp.Server.Seq // retry against the now-known current seq
	}
	return errors.New("cloud: force push did not converge")
}

// ---------------------------------------------------------------------------
// vault key + helpers
// ---------------------------------------------------------------------------

// vaultKey returns the cached per-vault key, unwrapping it from the account
// keyset (member/self -> OpenWithPrivkey) on first use. The returned slice is a
// freshly allocated copy the caller may wipe; the cached original is wiped only
// on clearSessionLocked.
func (s *CloudService) vaultKey(ctx context.Context, client *cloud.Client, vaultID string) ([]byte, error) {
	s.mu.RLock()
	if s.session == nil {
		s.mu.RUnlock()
		return nil, ErrCloudNotSignedIn
	}
	if vk, ok := s.session.vaultKeys[vaultID]; ok {
		cp := append([]byte(nil), vk...)
		s.mu.RUnlock()
		return cp, nil
	}
	priv := s.session.priv
	s.mu.RUnlock()
	if client == nil {
		return nil, ErrCloudNotConfigured
	}

	wrapped, err := client.GetVaultMemberSelf(ctx, vaultID)
	if err != nil {
		if cloud.IsStatus(err, 404) {
			// The current account is not a member of this vault — typically a
			// stale binding from another account. Surface a sentinel so the sync
			// loop skips it instead of failing the whole run.
			return nil, ErrCloudNotMember
		}
		return nil, fmt.Errorf("cloud: member/self: %w", err)
	}
	wrappedBytes, err := cloudB64.DecodeString(wrapped)
	if err != nil {
		return nil, fmt.Errorf("cloud: decode wrapped_vault_key: %w", err)
	}
	vk, err := cloudcrypto.OpenWithPrivkey(priv[:], wrappedBytes)
	if err != nil {
		return nil, fmt.Errorf("cloud: unwrap vault key: %w", err)
	}
	s.mu.Lock()
	if s.session != nil {
		// Store an independent copy in the cache; the returned copy below is
		// separate so a caller's deferred wipe never zeroes the cache.
		s.session.vaultKeys[vaultID] = append([]byte(nil), vk...)
	}
	s.mu.Unlock()
	return vk, nil
}

// localManifest builds the sync manifest for a space (live items decrypted to
// compute their vault-keyed content hash; tombstones carry only id + deletedAt).
func (s *CloudService) localManifest(spaceID string, vaultKey []byte) ([]SyncManifestEntry, error) {
	rows, err := s.vault.db.SpaceItemRowsForSync(spaceID)
	if err != nil {
		return nil, err
	}
	out := make([]SyncManifestEntry, 0, len(rows))
	for i := range rows {
		row := &rows[i]
		entry := SyncManifestEntry{ID: row.ID, UpdatedAt: row.UpdatedAt}
		if row.DeletedAt != nil {
			entry.DeletedAt = *row.DeletedAt
		} else if payload, err := s.vault.getItemAnySpace(row.ID); err == nil && payload != nil {
			entry.ContentHash = cloudContentHash(vaultKey, payload)
			entry.Revision = payload.Revision
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// cloudContentHash is the per-vault content fingerprint sent to the server:
// HMAC-SHA256(vault_key, canonical_content)[:16] hex. Keying by the vault key
// means the zero-knowledge server sees an opaque token it cannot compute or
// correlate across users/vaults, while members of one vault (who share the key)
// still compute an identical hash for identical content (needed for dedup/merge).
//
// The canonical fields are reduced exactly as payloadToWebVaultRecord seals them
// (envelope keys + empty values dropped). This MUST match the sealed record: the
// ciphertext carries only the reduced field set, so a remote item decrypted and
// rehashed has to land on the same digest as the local payload it came from. If
// this hashed the full payload (empties included) while the ciphertext dropped
// them, identical content would read as divergent (equal updatedAt, mismatched
// hash) and loop forever as a phantom concurrent-edit conflict.
func cloudContentHash(vaultKey []byte, p *ItemPayload) string {
	if p == nil {
		return ""
	}
	fields := make(map[string]any, len(p.Fields))
	for k, v := range p.Fields {
		if webVaultEnvelopeKeys[k] || isEmptyFieldValue(v) {
			continue
		}
		fields[k] = v
	}
	stable := map[string]any{
		"type":   string(p.Type),
		"name":   p.Name,
		"fields": fields,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(stable); err != nil {
		return ""
	}
	data := buf.Bytes()
	if n := len(data); n > 0 && data[n-1] == '\n' {
		data = data[:n-1]
	}
	mac := hmac.New(sha256.New, vaultKey)
	mac.Write(data)
	sum := mac.Sum(nil)
	return hex.EncodeToString(sum[:16])
}

// notifySync emits a cloud:sync:progress event.
func (s *CloudService) notifySync(stage string, processed, total int, errMsg string) {
	s.emitEvent("cloud:sync:progress", map[string]any{
		"stage": stage, "processed": processed, "total": total,
		"error": errMsg, "updatedAt": nowMillis(),
	})
}

// ---------------------------------------------------------------------------
// background loop
// ---------------------------------------------------------------------------

// StartBackgroundSync launches the periodic sync loop. Each tick syncs when
// signed in and the vault is unlocked; otherwise it is a cheap no-op. Idempotent.
func (s *CloudService) StartBackgroundSync() {
	s.mu.Lock()
	if s.loopCancel != nil {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.loopCancel = cancel
	s.mu.Unlock()

	go func() {
		ticker := time.NewTicker(syncTickInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// While realtime is connected the tick is only a safety net; skip
				// it when a sync completed recently so we do not hammer the server.
				if s.realtimeConnected.Load() {
					last := s.lastSyncMs.Load()
					if last > 0 && time.Since(time.UnixMilli(last)) < realtimeSkipPollWindow {
						continue
					}
				}
				// Normal ticks run the cheap incremental path; once fullSyncInterval
				// has elapsed (or no full has ever run) upgrade to a full reconcile
				// so any incremental drift self-heals.
				full := false
				lastFull := s.lastFullSyncMs.Load()
				if lastFull == 0 || time.Since(time.UnixMilli(lastFull)) >= fullSyncInterval {
					full = true
				}
				if _, err := s.runSync(ctx, full, nil); err != nil {
					s.emitEvent("cloud:sync:error", map[string]any{
						"message": err.Error(), "updatedAt": nowMillis(),
					})
				}
			}
		}
	}()
}

func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func nowMillis() int64 { return time.Now().UnixMilli() }
