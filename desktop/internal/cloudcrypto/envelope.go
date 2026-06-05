package cloudcrypto

// Sizes — mirror cryptocore/src/lib.rs (KEY_SIZE / NONCE_SIZE / TAG_SIZE /
// SALT_SIZE). XChaCha20-Poly1305 with a 24-byte extended nonce and 16-byte tag.
const (
	KeySize   = 32 // XChaCha20-Poly1305 key
	NonceSize = 24 // extended nonce
	TagSize   = 16 // Poly1305 tag
	SaltSize  = 32 // Argon2id salt
)

// Argon2id lower bounds — identical to cryptocore (MIN_MEMORY_KIB etc.) and to
// desktop's services.Argon2idParams.Validate. A vault that opens on one end must
// open on the other, so these floors are part of the wire contract.
const (
	minMemoryKiB   = 8 * 1024 // 8 MiB
	minIterations  = 1
	minParallelism = 1
)

// Envelope version / algorithm ids — cryptocore/src/envelope.rs. Locked by the
// envelope_constants_locked KAT on the Rust side; kept here for parity and so a
// future versioned envelope encoder agrees byte-for-byte.
const (
	FormatVersionV1      byte = 0x01
	AlgXChaCha20Poly1305 byte = 0x01
	AlgArgon2idWrap      byte = 0x02
	AlgX25519Seal        byte = 0x10
	AlgSRPVerifier       byte = 0x20
)

// Domain-separation constants — cryptocore/src/envelope.rs. These are the exact
// UTF-8 bytes fed as HKDF `info` / AEAD `aad`. Any drift here diverges the whole
// key chain.
var (
	// infoAUKV1 is the HKDF info for derive_auk.
	infoAUKV1 = []byte("zpass-auk-v1")
	// infoSRPxV1 is the HKDF info for derive_srp_x.
	infoSRPxV1 = []byte("zpass-srpx-v1")
	// infoVaultKeyV1 is both the HKDF info and the AEAD aad inside the X25519
	// sealed-box (vault key wrap). cryptocore INFO_VAULTKEY_V1.
	infoVaultKeyV1 = []byte("zpass-vaultkey-v1")
	// infoKeysetPrivV1 is the AEAD aad that binds the account X25519 private key
	// ciphertext (user_keysets.encrypted_private_key). cryptocore
	// INFO_KEYSET_PRIV_V1; the cloud server stores the blob as
	// seal_aead(AUK, priv32, aad="zpass-keyset-priv-v1"). Drift here is invisible
	// to the zero-knowledge server and only surfaces as an AEAD auth failure when
	// a second device tries to unwrap the private key.
	infoKeysetPrivV1 = []byte("zpass-keyset-priv-v1")
)
