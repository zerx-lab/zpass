package cloudcrypto

import (
	"errors"

	"golang.org/x/crypto/curve25519"
)

// X25519KeySize is the curve25519 scalar / point encoding length.
const X25519KeySize = 32

// ErrLowOrderPoint is returned when an X25519 shared secret collapses to the
// all-zero value (low-order input point). cryptocore surfaces such cases through
// AEAD auth failure downstream; we fail earlier and explicitly.
var ErrLowOrderPoint = errors.New("cloudcrypto: x25519 low-order point")

// KeysetGenerate creates an account X25519 keyset, returning (pub32, priv32).
// priv32 is the raw CSPRNG seed; every downstream X25519 op clamps the scalar
// per RFC 7748, so this interoperates with cryptocore keyset_generate whether or
// not the bytes are pre-clamped (clamping is idempotent and never compared
// byte-wise across ends). priv32 is sensitive — wipe after use.
func KeysetGenerate() (pub [X25519KeySize]byte, priv [X25519KeySize]byte, err error) {
	seed, err := randomBytes(X25519KeySize)
	if err != nil {
		return pub, priv, err
	}
	copy(priv[:], seed)
	wipe(seed)
	pubBytes, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		return pub, priv, ErrLowOrderPoint
	}
	copy(pub[:], pubBytes)
	return pub, priv, nil
}

// SealToPubkey wraps plaintext to a recipient X25519 public key (sealed-box).
// Output = eph_pub(32) || seal_aead(sym, plaintext, aad=zpass-vaultkey-v1),
// i.e. eph_pub(32) || nonce(24) || ct || tag(16) — cryptocore seal_to_pubkey.
func SealToPubkey(recipientPub, plaintext []byte) ([]byte, error) {
	if len(recipientPub) != X25519KeySize {
		return nil, ErrKeyLength
	}
	ephSeed, err := randomBytes(X25519KeySize)
	if err != nil {
		return nil, err
	}
	ephPub, err := curve25519.X25519(ephSeed, curve25519.Basepoint)
	if err != nil {
		wipe(ephSeed)
		return nil, ErrLowOrderPoint
	}
	shared, err := curve25519.X25519(ephSeed, recipientPub)
	wipe(ephSeed)
	if err != nil {
		return nil, ErrLowOrderPoint
	}
	sym, err := deriveSym(shared, ephPub, recipientPub)
	wipe(shared)
	if err != nil {
		return nil, err
	}
	ct, err := SealAEAD(sym[:], plaintext, infoVaultKeyV1)
	wipeArr(&sym)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, X25519KeySize+len(ct))
	out = append(out, ephPub...)
	out = append(out, ct...)
	return out, nil
}

// OpenWithPrivkey unwraps the output of SealToPubkey using the recipient private
// key. Authentication failure collapses to ErrAEADAuth.
func OpenWithPrivkey(priv, sealed []byte) ([]byte, error) {
	if len(priv) != X25519KeySize {
		return nil, ErrKeyLength
	}
	if len(sealed) < X25519KeySize+NonceSize+TagSize {
		return nil, ErrSealedTooShort
	}
	ephPub := sealed[:X25519KeySize]
	ct := sealed[X25519KeySize:]

	shared, err := curve25519.X25519(priv, ephPub)
	if err != nil {
		return nil, ErrLowOrderPoint
	}
	recipientPub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		wipe(shared)
		return nil, ErrLowOrderPoint
	}
	sym, err := deriveSym(shared, ephPub, recipientPub)
	wipe(shared)
	if err != nil {
		return nil, err
	}
	pt, err := OpenAEAD(sym[:], ct, infoVaultKeyV1)
	wipeArr(&sym)
	return pt, err
}

// SealKeysetPrivateKey wraps the 32-byte account X25519 private key under the
// AUK for upload to user_keysets.encrypted_private_key. Output layout is
// nonce(24) || ct(32) || tag(16) = 72 bytes, matching the cloud server's
// seal_aead(AUK, priv32, aad="zpass-keyset-priv-v1") contract. The AAD is fixed
// inside this package so the orchestration layer can never typo it.
func SealKeysetPrivateKey(auk, priv []byte) ([]byte, error) {
	if len(priv) != X25519KeySize {
		return nil, ErrKeyLength
	}
	return SealAEAD(auk, priv, infoKeysetPrivV1)
}

// OpenKeysetPrivateKey unwraps the output of SealKeysetPrivateKey (or the cloud
// server's stored encrypted_private_key) using the AUK. Authentication failure
// — wrong AUK, tamper, or a divergent AAD on the sealing end — collapses to
// ErrAEADAuth.
func OpenKeysetPrivateKey(auk, sealed []byte) ([]byte, error) {
	return OpenAEAD(auk, sealed, infoKeysetPrivV1)
}

// deriveSym derives the 32-byte symmetric key from the ECDH shared secret:
// HKDF-SHA256(ikm=shared, salt=eph_pub||recipient_pub, info=zpass-vaultkey-v1).
// The salt binds the session key to the concrete public-key pair (cryptocore
// derive_sym).
func deriveSym(shared, ephPub, recipientPub []byte) ([KeySize]byte, error) {
	var sym [KeySize]byte
	salt := make([]byte, 0, 2*X25519KeySize)
	salt = append(salt, ephPub...)
	salt = append(salt, recipientPub...)
	okm, err := hkdfSHA256(shared, salt, infoVaultKeyV1, KeySize)
	if err != nil {
		return sym, err
	}
	copy(sym[:], okm)
	wipe(okm)
	return sym, nil
}
