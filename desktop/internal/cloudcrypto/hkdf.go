package cloudcrypto

import (
	"crypto/hkdf"
	"crypto/sha256"
)

// maxHKDFOut is the RFC 5869 hard ceiling for HKDF-Expand with SHA-256
// (255 * HashLen). cryptocore enforces the same bound.
const maxHKDFOut = 255 * 32

// hkdfSHA256 is HKDF-SHA256 (RFC 5869 Extract-then-Expand), byte-for-byte with
// cryptocore::hkdf::hkdf_sha256 and golang.org/x/crypto / @noble. An empty salt
// degrades to a HashLen zero block (RFC 5869 §3.1), identical to the Rust crate
// passing None.
func hkdfSHA256(ikm, salt, info []byte, outLen int) ([]byte, error) {
	if outLen <= 0 || outLen > maxHKDFOut {
		return nil, ErrInvalidHKDFSize
	}
	okm, err := hkdf.Key(sha256.New, ikm, salt, string(info), outLen)
	if err != nil {
		return nil, ErrInvalidHKDFSize
	}
	return okm, nil
}
