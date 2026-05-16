package main

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
