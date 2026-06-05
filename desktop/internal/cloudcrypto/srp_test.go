package cloudcrypto

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"testing"
)

// srpXHex is cryptocore's fixed SRP-x anchor (SRP_X_HEX). It pins v/K/M1/M2.
const srpXHex = "15f605aa05dfd55b199de8403fce5a7db6ded022bb37c373e490801e3a5d8ae5"

// Anchors cryptocore srp_register_verifier_vector + srp_group_params_locked.
func TestSRPRegisterVerifierVector(t *testing.T) {
	x := mustHex(t, srpXHex)
	salt := bytes.Repeat([]byte{0x22}, SaltSize)
	reg, err := SrpRegister(x, salt)
	if err != nil {
		t.Fatal(err)
	}
	wantV := "013aff033e37dde2c743b8924c440ec2e595768a9db0ff5fd96b8f797e0eeb43" +
		"1d68e9aafaf4808975391f16f6249815bd5036143ffcb1c1f58a8aaf3237bcf9" +
		"318d09800467bc86ede6e47df9929723d126cf097c4c852806db7791ffef3537" +
		"65c1dadf6e67e0d03b0498956ae79473c436b70434ee4b4607c5f82fbe7df1e9" +
		"d24c3bf9a93b1b6867d32a02bbfb9546322ab94653e32580ac965e7b35740c3b" +
		"0a2dd5e7435f947c362a5934f065ad8d7e092b1828b778147255bda5b9a7d0dc" +
		"dbe50be82c88f4d87b971c08240096e2845b972a69a192904302176a841efafd" +
		"25ec62c6c77e765284bae10d4ff054d5298e1efb9e89f8b684031c3b00888273"
	if hex.EncodeToString(reg.Verifier) != wantV {
		t.Fatalf("SRP verifier diverged\n got=%s\nwant=%s", hex.EncodeToString(reg.Verifier), wantV)
	}
	if len(reg.Verifier) != 256 {
		t.Fatalf("verifier should be PAD'd to 256 bytes, got %d", len(reg.Verifier))
	}
	// Group fingerprint (locks N/g via v).
	fp := sha256.Sum256(reg.Verifier)
	if hex.EncodeToString(fp[:]) != "9699a2f3474fe36316948999221a2a383b014a735e431910412cfa0aa1294b39" {
		t.Fatalf("SRP group/x layout diverged (v fingerprint = %x)", fp)
	}
}

// derivePubsForTest reconstructs A / B from fixed ephemerals, mirroring
// cryptocore derive_a_pub_for_test / derive_b_pub_for_test.
func derivePubsForTest(aSecret, bSecret, verifier []byte) (aPub, bPub []byte) {
	n := groupN()
	g := groupG()
	a := new(big.Int).SetBytes(aSecret)
	aPub = pad(new(big.Int).Exp(g, a, n))

	v := new(big.Int).SetBytes(verifier)
	k := computeK(g)
	b := new(big.Int).SetBytes(bSecret)
	// B = (k*v + g^b) mod N
	kv := new(big.Int).Mod(new(big.Int).Mul(k, v), n)
	gb := new(big.Int).Exp(g, b, n)
	bPub = pad(new(big.Int).Mod(new(big.Int).Add(kv, gb), n))
	return aPub, bPub
}

// Anchors cryptocore srp_handshake_fixed_ephemeral_vector: K / M1 / M2 exact
// bytes with a = 0x33*32, b = 0x44*32. This is the gold cross-end SRP anchor.
func TestSRPFixedEphemeralVector(t *testing.T) {
	x := mustHex(t, srpXHex)
	salt := bytes.Repeat([]byte{0x22}, SaltSize)
	identity := []byte("alice@example.com")
	reg, err := SrpRegister(x, salt)
	if err != nil {
		t.Fatal(err)
	}

	aSecret := bytes.Repeat([]byte{0x33}, 32)
	bSecret := bytes.Repeat([]byte{0x44}, 32)
	aPub, bPub := derivePubsForTest(aSecret, bSecret, reg.Verifier)

	proof, err := SrpClientFinish(aSecret, aPub, bPub, x, salt, identity)
	if err != nil {
		t.Fatal(err)
	}

	if hex.EncodeToString(proof.SessionKey[:]) != "bd0474804e7cd08e89e4d3b78b5690994245baa49ed21592799a30c3a4ac27ec" {
		t.Fatalf("K diverged: %x", proof.SessionKey)
	}
	if hex.EncodeToString(proof.M1[:]) != "258c13078a2abe1ed88ae16dca4aa97dd6865836dd6212931853838189c5cf1f" {
		t.Fatalf("M1 diverged: %x", proof.M1)
	}
	// M2 = H(PAD(A) | M1 | K); the client verifies the server's M2 against this.
	wantM2 := mustHex(t, "c02a1c775c3c869df96dde8cae360fc59824cbe573b385ff3ad9779c9c6d183d")
	if !proof.VerifyServerM2(aPub, wantM2) {
		t.Fatal("client rejected the locked server M2")
	}
}

// A wrong x (wrong password) yields a different M1 than the verifier expects.
func TestSRPWrongPasswordDiffersM1(t *testing.T) {
	x := mustHex(t, srpXHex)
	salt := bytes.Repeat([]byte{0x22}, SaltSize)
	identity := []byte("alice@example.com")
	reg, _ := SrpRegister(x, salt)
	aSecret := bytes.Repeat([]byte{0x33}, 32)
	bSecret := bytes.Repeat([]byte{0x44}, 32)
	aPub, bPub := derivePubsForTest(aSecret, bSecret, reg.Verifier)

	good, _ := SrpClientFinish(aSecret, aPub, bPub, x, salt, identity)
	wrongX := bytes.Repeat([]byte{0xEE}, 32)
	bad, _ := SrpClientFinish(aSecret, aPub, bPub, wrongX, salt, identity)
	if good.M1 == bad.M1 {
		t.Fatal("wrong password produced the same M1")
	}
}

func TestSRPRejectsBadXLen(t *testing.T) {
	if _, err := SrpRegister(make([]byte, 31), make([]byte, SaltSize)); err != ErrSRPXLen {
		t.Fatalf("got %v, want ErrSRPXLen", err)
	}
}
