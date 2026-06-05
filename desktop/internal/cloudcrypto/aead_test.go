package cloudcrypto

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// mustHex decodes a hex string in tests.
func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

// Anchors cryptocore derive_kek_known_vector_is_stable: argon2id byte alignment.
func TestArgon2idKnownVector(t *testing.T) {
	salt := bytes.Repeat([]byte{0xAB}, SaltSize)
	got, err := argon2idRaw([]byte("correct horse battery staple"), salt, 8*1024, 2, 2, 32)
	if err != nil {
		t.Fatalf("argon2idRaw: %v", err)
	}
	want := mustHex(t, "b95794ea37af333fbb49d97b0a9d52b42c77e413459c218083ac260daa41623a")
	if !bytes.Equal(got, want) {
		t.Fatalf("argon2id diverged from cryptocore\n got=%x\nwant=%x", got, want)
	}
}

// Anchors cryptocore hkdf_sha256_rfc5869_vector_a1.
func TestHKDFSHA256RFC5869A1(t *testing.T) {
	ikm := mustHex(t, "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
	salt := mustHex(t, "000102030405060708090a0b0c")
	info := mustHex(t, "f0f1f2f3f4f5f6f7f8f9")
	got, err := hkdfSHA256(ikm, salt, info, 42)
	if err != nil {
		t.Fatalf("hkdfSHA256: %v", err)
	}
	want := mustHex(t, "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
	if !bytes.Equal(got, want) {
		t.Fatalf("HKDF-SHA256 diverged from RFC 5869 A.1\n got=%x\nwant=%x", got, want)
	}
}

func TestHKDFRejectsBadLen(t *testing.T) {
	if _, err := hkdfSHA256([]byte("ikm"), []byte("salt"), []byte("info"), 0); err == nil {
		t.Fatal("expected error for outLen=0")
	}
	if _, err := hkdfSHA256([]byte("ikm"), []byte("salt"), []byte("info"), 255*32+1); err == nil {
		t.Fatal("expected error for outLen>8160")
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	key, err := randomBytes(KeySize)
	if err != nil {
		t.Fatal(err)
	}
	pt := []byte(`{"id":"abc","name":"github","password":"s3cr3t"}`)
	aad := []byte("abc")
	sealed, err := SealAEAD(key, pt, aad)
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed) != NonceSize+len(pt)+TagSize {
		t.Fatalf("sealed len = %d, want %d", len(sealed), NonceSize+len(pt)+TagSize)
	}
	out, err := OpenAEAD(key, sealed, aad)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, pt) {
		t.Fatalf("roundtrip mismatch: %q != %q", out, pt)
	}
}

func TestOpenRejects(t *testing.T) {
	key, _ := randomBytes(KeySize)
	other, _ := randomBytes(KeySize)
	sealed, err := SealAEAD(key, []byte("payload"), []byte("item-A"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenAEAD(key, sealed, []byte("item-B")); err != ErrAEADAuth {
		t.Fatalf("wrong aad: got %v, want ErrAEADAuth", err)
	}
	if _, err := OpenAEAD(other, sealed, []byte("item-A")); err != ErrAEADAuth {
		t.Fatalf("wrong key: got %v, want ErrAEADAuth", err)
	}
	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 0x01
	if _, err := OpenAEAD(key, tampered, []byte("item-A")); err != ErrAEADAuth {
		t.Fatalf("tampered: got %v, want ErrAEADAuth", err)
	}
	if _, err := OpenAEAD(key, []byte("too short"), nil); err != ErrSealedTooShort {
		t.Fatalf("short: got %v, want ErrSealedTooShort", err)
	}
	if _, err := SealAEAD(make([]byte, KeySize-1), []byte("x"), nil); err != ErrKeyLength {
		t.Fatalf("bad key: got %v, want ErrKeyLength", err)
	}
}
