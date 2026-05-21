// Native messaging envelope types — JSON wire shape only.
//
// The desktop GUI defines structurally identical types in
// internal/services/nativebridge_protocol.go; both sides serialize against
// the same JSON keys so the Go declarations do not need to be a single
// source. Keeping a copy here lets the native-host command link without
// pulling in the GUI's vault/sshagent dependency graph.
package main

import "encoding/json"

type nativeEnvelope struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type nativeResponse struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
