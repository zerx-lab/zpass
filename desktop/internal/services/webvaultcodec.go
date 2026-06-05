package services

import (
	"encoding/json"
	"strings"
)

// Cross-client item interop with the cloud reference clients (web_vault /
// skeleton-cli). The cloud item format is web_vault's flat "ItemRecord"
// (cloud/web_vault/src/lib/items.ts), NOT the desktop's ItemPayload, and the
// AEAD aad + wire item_id is the hyphenated lowercase UUID the server stores
// (web_vault seals with aad = utf8(uuidv4())). The desktop transcodes at the
// sync boundary: pull = open(aad=cloud id) -> ItemRecord JSON -> ItemPayload;
// push = ItemPayload -> ItemRecord JSON -> seal(aad=cloud id). Local
// vault_items keep the desktop hyphenless-hex id; the two id forms map 1:1.

// vaultManifestLocalID is web_vault's special vault-name manifest item
// (VAULT_MANIFEST_ID '00000000-0000-0000-0000-0000000000ff') in local
// (hyphenless) form. It is NOT a real item and is skipped on pull.
const vaultManifestLocalID = "000000000000000000000000000000ff"

// webVaultEnvelopeKeys are ItemRecord keys that are not type-specific fields;
// they map to dedicated ItemPayload columns rather than into Fields.
var webVaultEnvelopeKeys = map[string]bool{
	"v": true, "type": true, "title": true, "createdAt": true, "updatedAt": true,
}

// localItemID maps a server/cloud item id (hyphenated UUID) to the desktop local
// id (hyphenless lowercase hex) used as vault_items.id and the merge key.
func localItemID(cloudID string) string {
	return strings.ToLower(strings.ReplaceAll(cloudID, "-", ""))
}

// cloudItemID maps a desktop local id (hyphenless 32-hex) to the wire/aad form
// (hyphenated lowercase UUID) shared with web_vault and the server. A local id
// that is not a 32-hex string is passed through unchanged.
func cloudItemID(localID string) string {
	s := strings.ToLower(strings.ReplaceAll(localID, "-", ""))
	if len(s) != 32 || !isHex32(s) {
		return localID
	}
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}

func isHex32(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// recordTypeToDesktop maps a web_vault ItemRecord type to a desktop ItemType.
// Known divergence: web_vault "sshKey" == desktop "ssh". Types the desktop does
// not model (apiCredential, cryptoWallet, ...) pass through so no data is lost;
// the UI renders them generically.
func recordTypeToDesktop(t string) ItemType {
	if t == "sshKey" {
		return ItemTypeSSH
	}
	return ItemType(t)
}

// desktopTypeToRecord is the inverse of recordTypeToDesktop.
func desktopTypeToRecord(t ItemType) string {
	if t == ItemTypeSSH {
		return "sshKey"
	}
	return string(t)
}

// webVaultRecordToPayload parses a web_vault ItemRecord JSON into a desktop
// ItemPayload (title -> Name, flat fields -> Fields, type mapped).
func webVaultRecordToPayload(raw []byte) (*ItemPayload, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	p := &ItemPayload{Fields: map[string]any{}}
	if t, ok := m["type"].(string); ok {
		p.Type = recordTypeToDesktop(t)
	}
	if title, ok := m["title"].(string); ok {
		p.Name = title
	}
	if ca, ok := m["createdAt"].(float64); ok {
		p.CreatedAt = int64(ca)
	}
	if ua, ok := m["updatedAt"].(float64); ok {
		p.UpdatedAt = int64(ua)
	}
	for k, v := range m {
		if webVaultEnvelopeKeys[k] {
			continue
		}
		p.Fields[k] = v
	}
	return p, nil
}

// payloadToWebVaultRecord renders a desktop ItemPayload as web_vault ItemRecord
// JSON (Name -> title, Fields spread flat, type mapped, empties dropped like
// web_vault's serialize()).
func payloadToWebVaultRecord(p *ItemPayload) ([]byte, error) {
	rec := map[string]any{
		"v":     2,
		"type":  desktopTypeToRecord(p.Type),
		"title": p.Name,
	}
	if p.CreatedAt > 0 {
		rec["createdAt"] = p.CreatedAt
	}
	if p.UpdatedAt > 0 {
		rec["updatedAt"] = p.UpdatedAt
	}
	for k, v := range p.Fields {
		if webVaultEnvelopeKeys[k] {
			continue
		}
		if isEmptyFieldValue(v) {
			continue
		}
		rec[k] = v
	}
	return json.Marshal(rec)
}

// isEmptyFieldValue mirrors web_vault serialize()'s skip rule (undefined / null
// / "" / false / empty array).
func isEmptyFieldValue(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case bool:
		return !x
	case []any:
		return len(x) == 0
	default:
		return false
	}
}
