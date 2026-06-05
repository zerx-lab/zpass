// Package cloudcrypto is the Go port of the account-oriented zero-knowledge
// primitives locked in the top-level Rust `cryptocore` crate. It exists so the
// desktop client (pure Go, no cgo link to cryptocore) can take part in the
// cloud auth + sync chain with byte-for-byte agreement.
//
// Every primitive here is anchored to a cryptocore KAT vector (see *_test.go):
// argon2id, HKDF-SHA256, the 2SKD derive_auk/derive_srp_x, the X25519
// sealed-box, and SRP-6a (RFC 5054, 2048-bit group, g=2, SHA-256). Changing any
// constant or byte layout here without re-deriving the matching cryptocore
// vector will silently break interop and is forbidden.
//
// Layering: this is a leaf package. It depends only on the standard library,
// golang.org/x/crypto and golang.org/x/text. It MUST NOT import internal/services
// (the cloud sync service imports cloudcrypto, never the reverse). The vault DEK
// never flows through here; this package only derives the account key chain
// (AUK -> X25519 keyset -> vault key) and proves the SRP login.
package cloudcrypto
