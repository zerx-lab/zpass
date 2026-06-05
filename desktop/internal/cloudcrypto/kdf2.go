package cloudcrypto

import (
	"strings"

	"golang.org/x/text/unicode/norm"
)

// Argon2Params is the slow-KDF cost for the 2SKD path. Output is always 32
// bytes (KeySize), so keyLen is implicit. Mirrors cryptocore kdf2::Argon2Params.
// Production is {65536, 3, 4} (64 MiB); the 8 MiB floor is the hard minimum.
type Argon2Params struct {
	MemKiB      uint32
	Iterations  uint32
	Parallelism uint32
}

// ProductionArgon2 is the account-derivation cost used in production (64 MiB,
// t=3, p=4), matching desktop's DefaultArgon2id and the cloud kdf_params.
func ProductionArgon2() Argon2Params {
	return Argon2Params{MemKiB: 65536, Iterations: 3, Parallelism: 4}
}

// NormalizePassword applies the cross-end master-password canonicalization:
// trim outer whitespace, then Unicode NFKD (compatibility decomposition). Inner
// whitespace is preserved. Must agree byte-for-byte with Rust
// `pw.trim().nfkd().collect()` and JS String.prototype.normalize("NFKD").
func NormalizePassword(pw string) string {
	return norm.NFKD.String(strings.TrimSpace(pw))
}

// xor32 returns out[i] = a[i] ^ b[i] (the T1.d byte order locked by the
// derive_auk/derive_srp_x vectors).
func xor32(a, b [KeySize]byte) [KeySize]byte {
	var out [KeySize]byte
	for i := 0; i < KeySize; i++ {
		out[i] = a[i] ^ b[i]
	}
	return out
}

// derive2skd is the shared 2SKD orchestration:
//
//	slow = Argon2id(NFKD(trim(pw)), slowSalt) -> 32B
//	mix  = HKDF-SHA256(ikm=secretKeyRaw, salt=accountID, info=domainInfo) -> 32B
//	out  = slow XOR mix
//
// domainInfo is the per-purpose HKDF label (infoAUKV1 / infoSRPxV1) — the second
// independent domain-separation barrier on top of the distinct slow salts.
func derive2skd(pwNFKD string, slowSalt, secretKeyRaw, accountID []byte, p Argon2Params, domainInfo []byte) ([KeySize]byte, error) {
	var out [KeySize]byte

	normalized := NormalizePassword(pwNFKD)
	slowVec, err := argon2idRaw([]byte(normalized), slowSalt, p.MemKiB, p.Iterations, p.Parallelism, KeySize)
	if err != nil {
		return out, err
	}
	mixVec, err := hkdfSHA256(secretKeyRaw, accountID, domainInfo, KeySize)
	if err != nil {
		return out, err
	}

	var slow, mix [KeySize]byte
	copy(slow[:], slowVec)
	copy(mix[:], mixVec)
	out = xor32(slow, mix)

	wipe(slowVec)
	wipe(mixVec)
	wipeArr(&slow)
	wipeArr(&mix)
	return out, nil
}

// DeriveAUK derives the Account Unlock Key. Uses saltEnc for the slow KDF
// (independent from derive_srp_x's saltAuth) and the INFO_AUK_V1 HKDF label.
// Anchored by cryptocore derive_auk_known_vector.
func DeriveAUK(pwNFKD string, saltEnc, secretKeyRaw, accountID []byte, p Argon2Params) ([KeySize]byte, error) {
	return derive2skd(pwNFKD, saltEnc, secretKeyRaw, accountID, p, infoAUKV1)
}

// DeriveSRPx derives the 32-byte SRP-x material (the bytes->bignum reading lives
// in srp.go). Uses saltAuth and the INFO_SRPX_V1 HKDF label. Anchored by
// cryptocore derive_srp_x_known_vector.
func DeriveSRPx(pwNFKD string, saltAuth, secretKeyRaw, accountID []byte, p Argon2Params) ([KeySize]byte, error) {
	return derive2skd(pwNFKD, saltAuth, secretKeyRaw, accountID, p, infoSRPxV1)
}

func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func wipeArr(b *[KeySize]byte) {
	for i := range b {
		b[i] = 0
	}
}
