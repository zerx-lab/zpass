package cloudcrypto

import (
	"crypto/rand"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

// Errors — kept coarse on the AEAD path so an authentication failure never
// reveals "wrong key vs tampered vs wrong aad" (side channel), mirroring
// cryptocore's single Error::AeadAuthentication.
var (
	ErrKeyLength       = errors.New("cloudcrypto: aead key length must be 32")
	ErrSealedTooShort  = errors.New("cloudcrypto: aead ciphertext too short")
	ErrAEADAuth        = errors.New("cloudcrypto: aead authentication failed")
	ErrArgon2Params    = errors.New("cloudcrypto: argon2id parameters out of range")
	ErrRandom          = errors.New("cloudcrypto: os rng failed")
	ErrInvalidHKDFSize = errors.New("cloudcrypto: invalid hkdf output length")
)

// randomBytes draws n bytes from the OS CSPRNG, never falling back to weak
// randomness (cryptocore random_bytes contract).
func randomBytes(n int) ([]byte, error) {
	if n <= 0 {
		return nil, ErrRandom
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRandom, err)
	}
	return buf, nil
}

// SealAEAD encrypts plaintext with XChaCha20-Poly1305 and a fresh random nonce.
// Output layout: [24-byte nonce][ciphertext][16-byte tag] — byte-identical to
// cryptocore seal_aead and desktop services.SealAEAD.
func SealAEAD(key, plaintext, aad []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, ErrKeyLength
	}
	nonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, err
	}
	return sealAEADWithNonce(key, plaintext, aad, nonce)
}

// sealAEADWithNonce is SealAEAD with a caller-supplied nonce; the nonce is
// prepended to the output (same layout as SealAEAD). Used internally by the
// sealed-box and by deterministic KAT vectors.
func sealAEADWithNonce(key, plaintext, aad, nonce []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, ErrKeyLength
	}
	if len(nonce) != NonceSize {
		return nil, ErrSealedTooShort
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, ErrKeyLength
	}
	// Seal appends ct||tag after the prepended nonce in a single allocation.
	out := make([]byte, NonceSize, NonceSize+len(plaintext)+TagSize)
	copy(out, nonce)
	return aead.Seal(out, nonce, plaintext, aad), nil
}

// OpenAEAD decrypts the output of SealAEAD. Authentication failure (wrong key,
// tamper, or wrong aad) collapses to ErrAEADAuth.
func OpenAEAD(key, sealed, aad []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, ErrKeyLength
	}
	if len(sealed) < NonceSize+TagSize {
		return nil, ErrSealedTooShort
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, ErrKeyLength
	}
	nonce := sealed[:NonceSize]
	ct := sealed[NonceSize:]
	pt, err := aead.Open(nil, nonce, ct, aad)
	if err != nil {
		return nil, ErrAEADAuth
	}
	return pt, nil
}

// argon2idRaw is the general Argon2id derivation (arbitrary salt/keyLen, same
// 8 MiB / iter>=1 / par>=1 floors as cryptocore argon2id_raw). Version is 0x13
// to match Rust Version::V0x13. memKiB is memory in KiB.
func argon2idRaw(password, salt []byte, memKiB, iter, par, keyLen uint32) ([]byte, error) {
	if len(salt) == 0 {
		return nil, ErrArgon2Params
	}
	if memKiB < minMemoryKiB || iter < minIterations || par < minParallelism {
		return nil, ErrArgon2Params
	}
	if keyLen == 0 || par > 0xff {
		return nil, ErrArgon2Params
	}
	return argon2.IDKey(password, salt, iter, memKiB, uint8(par), keyLen), nil
}
