package services

import "time"

const vaultChangedEvent = "vault:changed"

type vaultChangedPayload struct {
	Kind      string   `json:"kind"`
	ItemID    string   `json:"itemId,omitempty"`
	ItemType  ItemType `json:"itemType,omitempty"`
	UpdatedAt int64    `json:"updatedAt"`
}

func (s *VaultService) SetEventEmitter(emit func(event string, payload any)) {
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	s.emit = emit
}

func (s *VaultService) notifyVaultChanged(kind string, itemType ItemType, itemID string) {
	s.eventMu.RLock()
	emit := s.emit
	s.eventMu.RUnlock()
	if emit == nil {
		return
	}
	payload := vaultChangedPayload{
		Kind:      kind,
		ItemID:    itemID,
		ItemType:  itemType,
		UpdatedAt: time.Now().UnixMilli(),
	}
	go emit(vaultChangedEvent, payload)
}

// cloudSyncChangeKind marks a vault:changed emitted by the cloud sync engine
// itself (applying pulled remote items), as opposed to a user edit. The push
// half of auto-sync must NOT re-trigger on these: a pulled change re-pushed
// would emit another vault:changed, re-nudge sync, and livelock (pull → notify
// → nudge → pull …). Only genuine user edits should nudge a push.
const cloudSyncChangeKind = "cloud-sync"

// IsCloudSyncChange reports whether a vault:changed payload originated from the
// cloud sync engine applying remote changes (vs. a user edit). Callers wiring
// vault:changed → NudgeSync use it to break the self-feeding sync loop.
func IsCloudSyncChange(payload any) bool {
	p, ok := payload.(vaultChangedPayload)
	return ok && p.Kind == cloudSyncChangeKind
}
