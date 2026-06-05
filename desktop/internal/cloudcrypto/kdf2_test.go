package cloudcrypto

import (
	"bytes"
	"testing"
)

// Fixed 2SKD inputs — identical to cryptocore's SK_RAW / ACCOUNT_ID test
// fixtures. These are passed as raw ASCII bytes (the locked reading).
var (
	skRaw     = []byte("ABCDEFGHJKLMNPQRSTUVWXYZ23") // 26 chars
	accountID = []byte("acct-000001")
)

func testParams() Argon2Params { return Argon2Params{MemKiB: 8 * 1024, Iterations: 2, Parallelism: 1} }

// Anchors cryptocore derive_auk_known_vector.
func TestDeriveAUKKnownVector(t *testing.T) {
	saltEnc := bytes.Repeat([]byte{0x11}, SaltSize)
	got, err := DeriveAUK("  correct horse battery staple  ", saltEnc, skRaw, accountID, testParams())
	if err != nil {
		t.Fatalf("DeriveAUK: %v", err)
	}
	want := mustHex(t, "2c28dc7944fa1b1d4ec80dbc015593b1d36104d75e193ae59af4634c1f518a1d")
	if !bytes.Equal(got[:], want) {
		t.Fatalf("derive_auk diverged from cryptocore\n got=%x\nwant=%x", got[:], want)
	}
}

// Anchors cryptocore derive_srp_x_known_vector.
func TestDeriveSRPxKnownVector(t *testing.T) {
	saltAuth := bytes.Repeat([]byte{0x22}, SaltSize)
	got, err := DeriveSRPx("  correct horse battery staple  ", saltAuth, skRaw, accountID, testParams())
	if err != nil {
		t.Fatalf("DeriveSRPx: %v", err)
	}
	want := mustHex(t, "7ab0f4188c0bf29b3000010ba19ed5085f331986655263a22aefe2af75a19430")
	if !bytes.Equal(got[:], want) {
		t.Fatalf("derive_srp_x diverged from cryptocore\n got=%x\nwant=%x", got[:], want)
	}
}

// Anchors cryptocore auk_perp_srpx: same pw/SK/account_id, distinct salts =>
// AUK != SRP-x.
func TestAUKPerpSRPx(t *testing.T) {
	saltEnc := bytes.Repeat([]byte{0x11}, SaltSize)
	saltAuth := bytes.Repeat([]byte{0x22}, SaltSize)
	auk, err := DeriveAUK("pw same", saltEnc, skRaw, accountID, testParams())
	if err != nil {
		t.Fatal(err)
	}
	srpx, err := DeriveSRPx("pw same", saltAuth, skRaw, accountID, testParams())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(auk[:], srpx[:]) {
		t.Fatal("AUK and SRP-x not independent")
	}
}

// NFKD component anchor — the cryptocore vectors use ASCII passwords, where NFKD
// is a no-op. This pins Go's x/text NFKD to the canonical decomposition (which
// Rust unicode-normalization also produces), closing the cross-end NFKD risk by
// composition with the already-locked argon2/hkdf/xor.
//
// Strings are built from explicit code points (pure-ASCII source) so an editor's
// own NFC/NFKD pass over this file cannot silently flip the bytes:
// U+00E4 a-diaeresis, U+00F6 o-diaeresis, U+00E9 e-acute, U+0308 combining
// diaeresis, U+0301 combining acute.
func TestNormalizePasswordNFKD(t *testing.T) {
	// Precomposed (NFC) input with outer spaces.
	input := string([]rune{' ', ' ', 'p', 0x00E4, 's', 's', 'w', 0x00F6, 'r', 'd', ' ', 'c', 'a', 'f', 0x00E9, ' ', ' '})
	// Expected NFKD: precomposed -> base + combining mark; outer spaces trimmed.
	wantNFKD := string([]rune{'p', 'a', 0x0308, 's', 's', 'w', 'o', 0x0308, 'r', 'd', ' ', 'c', 'a', 'f', 'e', 0x0301})
	// Precomposed form (must differ from the decomposed output).
	composed := string([]rune{'p', 0x00E4, 's', 's', 'w', 0x00F6, 'r', 'd', ' ', 'c', 'a', 'f', 0x00E9})

	got := NormalizePassword(input)
	if got != wantNFKD {
		t.Fatalf("NFKD mismatch\n got=% x\nwant=% x", got, wantNFKD)
	}
	if got == composed {
		t.Fatal("NormalizePassword returned composed form; NFKD did not decompose")
	}
	// Inner whitespace preserved, outer trimmed.
	if NormalizePassword("  a b  ") != "a b" {
		t.Fatal("trim should remove outer but keep inner whitespace")
	}
}

// Reverse-check: a parsed Z1 secret key yields bytes usable as 2SKD inputs, and
// derivation is deterministic. (The byte-exact anchor is the KAT above; this
// proves the codec feeds the primitives the bytes they expect.)
func TestParsedSecretKeyFeedsDerive(t *testing.T) {
	sk := "Z1-ABCDEF-ABCDEFGHIJKLMNOPQRSTUVWXYZ-ABCDEFGHIJKLMNOPQRSTUVWXYZ-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	acct, canon, err := ParseSecretKey(sk)
	if err != nil {
		t.Fatal(err)
	}
	acctBytes, err := AccountIDCanonicalBytes(acct)
	if err != nil {
		t.Fatal(err)
	}
	saltEnc := bytes.Repeat([]byte{0x11}, SaltSize)
	a1, err := DeriveAUK("master-pw", saltEnc, canon, acctBytes, testParams())
	if err != nil {
		t.Fatal(err)
	}
	a2, err := DeriveAUK("master-pw", saltEnc, canon, acctBytes, testParams())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a1[:], a2[:]) {
		t.Fatal("derive not deterministic over parsed secret key")
	}
}
