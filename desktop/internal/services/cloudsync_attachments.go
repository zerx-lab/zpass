package services

// Cloud attachment reconcile — the item-scoped attachment API runs alongside the
// item change-feed, not through it. After items converge for a binding,
// reconcileAttachments runs a best-effort three-way pass for that space:
//
//   push:   local attachments with no cloud_id (newly added) → upload, sealed
//           with the vault key, then record cloud_id + synced_at.
//   delete: local soft-deleted attachments that DID sync (cloud_id set) → delete
//           server-side, then hard-delete the local tombstone row.
//   pull:   for the touched items, list server attachments and download any whose
//           cloud_id we do not already hold locally, re-sealing under the DEK.
//           The server hard-deletes attachments, so its list IS the authoritative
//           live set: any local synced attachment (cloud_id set, not soft-deleted)
//           absent from that list was deleted remotely and is hard-deleted locally.
//
// Crypto boundary mirrors items: at rest the file name + blob are DEK-sealed
// (aad = attachmentName/BlobAAD(localID)); on the wire they are vault-key-sealed
// so the zero-knowledge server only ever sees ciphertext. The wire aad follows
// the established web_vault convention (web_vault/src/pages/Vaults.tsx): the file
// name is sealed with aad "<cloudItemID>:name" and the blob with
// "<cloudItemID>:file", where cloudItemID is the dashed-hex server item id and
// the suffix is appended as UTF-8 bytes. This keeps desktop and web mutually
// decryptable (see wireAttachmentNameAAD / wireAttachmentBlobAAD).
//
// Migration note: attachments uploaded by older desktop builds used an empty
// wire aad. On download we try the new convention first and fall back to empty
// aad so those pre-existing rows still decrypt; uploads only ever use the new
// convention.
//
// Everything here is best-effort: a failure logs a warning event and the next
// cycle retries. The one hard action is the QUOTA case — a 403
// plan_limit_exceeded upload can never succeed while it stays local, so the local
// row is rolled back (hard-deleted) and a warning surfaced, rather than retried
// forever (which would also wedge the rest of the push queue).

import (
	"context"
	"fmt"
	"sync"

	"github.com/zerx-lab/zpass/internal/cloud"
	"github.com/zerx-lab/zpass/internal/cloudcrypto"
)

// reconcileAttachments runs the push/delete/pull attachment passes for one bound
// space. Caller holds syncMu and passes the live vault key (not wiped here). It
// never returns an error: attachment sync is auxiliary to item sync and must not
// fail the surrounding run.
func (s *CloudService) reconcileAttachments(ctx context.Context, client *cloud.Client, spaceID, vaultID string, vaultKey []byte, pullItemIDs []string) {
	if client == nil || s.vault == nil {
		return
	}
	s.pushLocalAttachments(ctx, client, spaceID, vaultID, vaultKey)
	s.deleteRemoteAttachments(ctx, client, spaceID)
	s.pullRemoteAttachments(ctx, client, spaceID, vaultID, vaultKey, pullItemIDs)
}

// attachmentItemInSpace reports whether an attachment's owning item belongs to
// spaceID (attachments are global rows; reconcile is per-binding, so we must not
// push one space's attachment to another space's vault).
func (s *CloudService) attachmentItemInSpace(itemID, spaceID string) bool {
	row, err := s.vault.db.GetItem(itemID)
	return err == nil && row != nil && row.SpaceID == spaceID
}

// pushLocalAttachments uploads every unsynced local attachment whose item is in
// this space. Quota rejection rolls back the local row (see file header).
func (s *CloudService) pushLocalAttachments(ctx context.Context, client *cloud.Client, spaceID, vaultID string, vaultKey []byte) {
	rows, err := s.vault.db.ListUnsyncedAttachments()
	if err != nil {
		s.emitEvent("cloud:sync:warning", map[string]any{"spaceId": spaceID, "message": "list unsynced attachments: " + err.Error()})
		return
	}
	for i := range rows {
		r := &rows[i]
		if !s.attachmentItemInSpace(r.ItemID, spaceID) {
			continue
		}
		nameEnc, blobEnc, err := s.transcodeAttachmentToCloud(r, vaultKey)
		if err != nil {
			s.emitEvent("cloud:sync:warning", map[string]any{"id": r.ID, "message": "attachment transcode: " + err.Error()})
			continue
		}
		// Send the PLAINTEXT size (r.SizeBytes), not the ciphertext length — the
		// server records this as the user-facing file size; the AEAD overhead
		// (~40 B) would otherwise make a 97-byte file read as 137 B everywhere.
		cloudID, _, err := client.UploadAttachment(ctx, vaultID, cloudItemID(r.ItemID), nameEnc, blobEnc, r.SizeBytes)
		if err != nil {
			if pe, ok := cloud.AsPlanLimitError(err); ok {
				// Quota exceeded: this attachment can never sync while it stays
				// local. Roll it back and tell the user, instead of retrying forever
				// (which would also block the rest of the push queue).
				_ = s.vault.db.DeleteAttachmentRow(r.ID)
				s.emitEvent("cloud:sync:warning", map[string]any{
					"id": r.ID, "itemId": r.ItemID, "kind": "attachment_quota_exceeded",
					"dimension": pe.Dimension, "limit": pe.Limit, "current": pe.Current, "plan": pe.Plan,
					"message": "attachment storage quota exceeded; upload rolled back",
				})
				continue
			}
			if cloud.IsAttachmentTooLarge(err) {
				_ = s.vault.db.DeleteAttachmentRow(r.ID)
				s.emitEvent("cloud:sync:warning", map[string]any{
					"id": r.ID, "itemId": r.ItemID, "kind": "attachment_too_large",
					"message": "attachment exceeds server size limit; upload rolled back",
				})
				continue
			}
			// Transient/other: leave the row, retry next cycle.
			s.emitEvent("cloud:sync:warning", map[string]any{"id": r.ID, "message": "attachment upload: " + err.Error()})
			continue
		}
		if err := s.vault.db.SetAttachmentCloud(r.ID, cloudID, nowMillis()); err != nil {
			s.emitEvent("cloud:sync:warning", map[string]any{"id": r.ID, "message": "record attachment cloud id: " + err.Error()})
		}
	}
}

// deleteRemoteAttachments deletes server-side every local soft-deleted+synced
// attachment whose item is in this space, then hard-deletes the local tombstone.
func (s *CloudService) deleteRemoteAttachments(ctx context.Context, client *cloud.Client, spaceID string) {
	rows, err := s.vault.db.ListDeletedSyncedAttachments()
	if err != nil {
		s.emitEvent("cloud:sync:warning", map[string]any{"spaceId": spaceID, "message": "list deleted attachments: " + err.Error()})
		return
	}
	for i := range rows {
		r := &rows[i]
		if !s.attachmentItemInSpace(r.ItemID, spaceID) {
			continue
		}
		err := client.DeleteAttachment(ctx, r.CloudID)
		// A 404 means the server already lost it — treat as deleted (idempotent).
		if err != nil && !cloud.IsStatus(err, 404) {
			s.emitEvent("cloud:sync:warning", map[string]any{"id": r.ID, "message": "attachment delete: " + err.Error()})
			continue
		}
		if err := s.vault.db.DeleteAttachmentRow(r.ID); err != nil {
			s.emitEvent("cloud:sync:warning", map[string]any{"id": r.ID, "message": "purge attachment tombstone: " + err.Error()})
		}
	}
}

// pullRemoteAttachments downloads, for each touched item that exists locally, any
// server attachment whose cloud_id we do not already hold, then purges local
// synced attachments the server no longer lists (deleted remotely — the server
// hard-deletes, so a successful list is the authoritative live set).
func (s *CloudService) pullRemoteAttachments(ctx context.Context, client *cloud.Client, spaceID, vaultID string, vaultKey []byte, itemIDs []string) {
	// Filter to items that exist locally in this space first (cheap local reads),
	// so we never fire a network list for items we'd skip anyway.
	local := make([]string, 0, len(itemIDs))
	for _, id := range itemIDs {
		row, err := s.vault.db.GetItem(id)
		if err != nil || row == nil || row.DeletedAt != nil || row.SpaceID != spaceID {
			continue
		}
		local = append(local, id)
	}
	if len(local) == 0 {
		return
	}

	// The attachment API is item-scoped: a full reconcile would otherwise fire
	// one ListAttachments per item SERIALLY (hundreds of round-trips for a large
	// vault → the sync visibly stalls). Fan the network listing out across a
	// bounded worker pool; the per-item local DB writes (ingest / cleanup) still
	// run serially below, where the vault mutex already serialises them.
	type listResult struct {
		itemID string
		metas  []cloud.AttachmentMeta
		err    error
	}
	const listConcurrency = 12
	results := make([]listResult, len(local))
	sem := make(chan struct{}, listConcurrency)
	var wg sync.WaitGroup
	for i, id := range local {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, id string) {
			defer wg.Done()
			defer func() { <-sem }()
			metas, err := client.ListAttachments(ctx, vaultID, cloudItemID(id))
			results[i] = listResult{itemID: id, metas: metas, err: err}
		}(i, id)
	}
	wg.Wait()

	for _, res := range results {
		if res.err != nil {
			s.emitEvent("cloud:sync:warning", map[string]any{"itemId": res.itemID, "message": "list remote attachments: " + res.err.Error()})
			continue
		}
		id := res.itemID
		have, err := s.vault.db.AttachmentCloudIDs(id)
		if err != nil {
			s.emitEvent("cloud:sync:warning", map[string]any{"itemId": id, "message": "local attachment ids: " + err.Error()})
			continue
		}
		remote := make(map[string]struct{}, len(res.metas))
		for _, m := range res.metas {
			remote[m.ID] = struct{}{}
			if _, ok := have[m.ID]; ok {
				continue // already have it
			}
			s.pullOneAttachment(ctx, client, id, m, vaultKey)
		}
		// Reverse cleanup: only synced+active rows are candidates (have excludes
		// unsynced rows, which still await push, and soft-deleted tombstones,
		// which the delete pass owns).
		for _, localID := range attachmentsAbsentRemotely(have, remote) {
			if err := s.vault.db.DeleteAttachmentRow(localID); err != nil {
				s.emitEvent("cloud:sync:warning", map[string]any{"id": localID, "itemId": id, "message": "purge remotely deleted attachment: " + err.Error()})
			}
		}
	}
}

// attachmentsAbsentRemotely returns the local row ids of synced attachments
// (cloud_id → local id) whose cloud_id is not in the server's live set.
func attachmentsAbsentRemotely(have map[string]string, remote map[string]struct{}) []string {
	var gone []string
	for cloudID, localID := range have {
		if _, ok := remote[cloudID]; !ok {
			gone = append(gone, localID)
		}
	}
	return gone
}

// pullOneAttachment downloads one remote attachment, decrypts it with the vault
// key, re-seals under the local DEK, and inserts it bound to itemID.
func (s *CloudService) pullOneAttachment(ctx context.Context, client *cloud.Client, itemID string, m cloud.AttachmentMeta, vaultKey []byte) {
	nameCt, blobCt, err := client.DownloadAttachment(ctx, m.ID)
	if err != nil {
		s.emitEvent("cloud:sync:warning", map[string]any{"id": m.ID, "message": "attachment download: " + err.Error()})
		return
	}
	cloudID := cloudItemID(itemID)
	name, err := openWireAttachment(vaultKey, nameCt, wireAttachmentNameAAD(cloudID))
	if err != nil {
		s.emitEvent("cloud:sync:warning", map[string]any{"id": m.ID, "message": "attachment name decrypt: " + err.Error()})
		return
	}
	defer zeroBytes(name)
	blob, err := openWireAttachment(vaultKey, blobCt, wireAttachmentBlobAAD(cloudID))
	if err != nil {
		s.emitEvent("cloud:sync:warning", map[string]any{"id": m.ID, "message": "attachment blob decrypt: " + err.Error()})
		return
	}
	defer zeroBytes(blob)
	if err := s.vault.ingestRemoteAttachment(itemID, m.ID, name, blob, int64(len(blob))); err != nil {
		s.emitEvent("cloud:sync:warning", map[string]any{"id": m.ID, "message": "attachment ingest: " + err.Error()})
	}
}

// transcodeAttachmentToCloud decrypts a local attachment (DEK) and re-seals it
// with the vault key for upload, using the web_vault wire aad convention
// ("<cloudItemID>:name" / "<cloudItemID>:file"). Returns the wire-ready
// ciphertext.
func (s *CloudService) transcodeAttachmentToCloud(r *AttachmentRow, vaultKey []byte) (nameEnc, blobEnc []byte, err error) {
	name, blob, err := s.vault.openAttachment(r)
	if err != nil {
		return nil, nil, err
	}
	defer zeroBytes(name)
	defer zeroBytes(blob)
	cloudID := cloudItemID(r.ItemID)
	nameEnc, err = cloudcrypto.SealAEAD(vaultKey, name, wireAttachmentNameAAD(cloudID))
	if err != nil {
		return nil, nil, fmt.Errorf("seal attachment name: %w", err)
	}
	blobEnc, err = cloudcrypto.SealAEAD(vaultKey, blob, wireAttachmentBlobAAD(cloudID))
	if err != nil {
		return nil, nil, fmt.Errorf("seal attachment blob: %w", err)
	}
	return nameEnc, blobEnc, nil
}

// wireAttachmentNameAAD / wireAttachmentBlobAAD build the cross-client wire aad
// for attachment name / blob ciphertext. The convention is fixed by web_vault
// (web_vault/src/pages/Vaults.tsx): "<cloudItemID>:name" and
// "<cloudItemID>:file", appended as UTF-8 bytes, where cloudItemID is the
// dashed-hex server item id.
func wireAttachmentNameAAD(cloudItemID string) []byte { return []byte(cloudItemID + ":name") }
func wireAttachmentBlobAAD(cloudItemID string) []byte { return []byte(cloudItemID + ":file") }

// openWireAttachment decrypts wire attachment ciphertext, trying the current
// web_vault aad convention first and falling back to an empty aad for migration
// compatibility with rows uploaded by older desktop builds (which used no aad).
func openWireAttachment(vaultKey, ct, aad []byte) ([]byte, error) {
	pt, err := cloudcrypto.OpenAEAD(vaultKey, ct, aad)
	if err == nil {
		return pt, nil
	}
	// Migration fallback: pre-convention ciphertext sealed with empty aad.
	return cloudcrypto.OpenAEAD(vaultKey, ct, nil)
}
