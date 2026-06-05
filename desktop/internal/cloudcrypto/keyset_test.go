package cloudcrypto

import (
	"bytes"
	"testing"

	"golang.org/x/crypto/curve25519"
)

// Anchors Go's X25519 to RFC 7748 §5.2, the same curve both ends use. With HKDF
// (RFC 5869) and AEAD already pinned, matching X25519 here makes the sealed-box
// construction cross-end correct by composition (Go-sealed is Rust-openable).
func TestX25519RFC7748Vector(t *testing.T) {
	scalar := mustHex(t, "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4")
	point := mustHex(t, "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")
	want := mustHex(t, "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552")
	got, err := curve25519.X25519(scalar, point)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("X25519 diverged from RFC 7748\n got=%x\nwant=%x", got, want)
	}
}

// Anchors cryptocore x25519_seal_open_roundtrip + layout assertion.
func TestSealedBoxRoundTrip(t *testing.T) {
	pub, priv, err := KeysetGenerate()
	if err != nil {
		t.Fatal(err)
	}
	pt := []byte("the vault key bytes (32) or any payload")
	sealed, err := SealToPubkey(pub[:], pt)
	if err != nil {
		t.Fatal(err)
	}
	// envelope = eph_pub(32) || nonce(24) || ct || tag(16)
	if len(sealed) != X25519KeySize+NonceSize+len(pt)+TagSize {
		t.Fatalf("sealed len = %d, want %d", len(sealed), X25519KeySize+NonceSize+len(pt)+TagSize)
	}
	out, err := OpenWithPrivkey(priv[:], sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, pt) {
		t.Fatalf("sealed-box roundtrip mismatch: %q != %q", out, pt)
	}
}

// TestKeysetPrivateKeyWrap anchors the encrypted_private_key contract: a 32-byte
// private key wraps to exactly 72 bytes (24 nonce + 32 ct + 16 tag), round-trips
// under the same AUK, and the AAD is byte-for-byte "zpass-keyset-priv-v1" — so a
// wrong AAD (or wrong AUK) is rejected with the coarse ErrAEADAuth.
func TestKeysetPrivateKeyWrap(t *testing.T) {
	if !bytes.Equal(infoKeysetPrivV1, []byte("zpass-keyset-priv-v1")) {
		t.Fatalf("keyset-priv aad drifted: %q", infoKeysetPrivV1)
	}
	auk := mustHex(t, "2c28dc0000000000000000000000000000000000000000000000000000000000")
	_, priv, err := KeysetGenerate()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := SealKeysetPrivateKey(auk, priv[:])
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed) != NonceSize+X25519KeySize+TagSize {
		t.Fatalf("encrypted_private_key len = %d, want 72", len(sealed))
	}
	out, err := OpenKeysetPrivateKey(auk, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, priv[:]) {
		t.Fatalf("keyset priv roundtrip mismatch")
	}
	// Decrypting the same blob with the generic AEAD under a different aad must
	// fail — proves the aad really is bound to the keyset-priv domain.
	if _, err := OpenAEAD(auk, sealed, infoVaultKeyV1); err != ErrAEADAuth {
		t.Fatalf("cross-aad open: got %v, want ErrAEADAuth", err)
	}
	// A non-32-byte private key is rejected before sealing.
	if _, err := SealKeysetPrivateKey(auk, make([]byte, 31)); err != ErrKeyLength {
		t.Fatalf("short priv: got %v, want ErrKeyLength", err)
	}
}

func TestSealedBoxRejects(t *testing.T) {
	pubA, _, _ := KeysetGenerate()
	_, privB, _ := KeysetGenerate()
	sealed, err := SealToPubkey(pubA[:], []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenWithPrivkey(privB[:], sealed); err != ErrAEADAuth {
		t.Fatalf("wrong key: got %v, want ErrAEADAuth", err)
	}
	if _, err := SealToPubkey(make([]byte, 31), []byte("x")); err != ErrKeyLength {
		t.Fatalf("bad recipient len: got %v, want ErrKeyLength", err)
	}
	if _, err := OpenWithPrivkey(make([]byte, 31), make([]byte, 80)); err != ErrKeyLength {
		t.Fatalf("bad priv len: got %v, want ErrKeyLength", err)
	}
	if _, err := OpenWithPrivkey(make([]byte, 32), []byte("short")); err != ErrSealedTooShort {
		t.Fatalf("short sealed: got %v, want ErrSealedTooShort", err)
	}
}
