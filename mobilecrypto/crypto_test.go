package mobilecrypto

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

// 与 phone/lib/crypto.ts 中的 AAD 常量保持一致 —— 若改动其中之一，必须同步另一边
const (
	aadDEK      = "zpass:dek"
	aadVerifier = "zpass:verifier"
	verifierPT  = "zpass-vault-verifier-v1"
)

func TestRandomBytesUnique(t *testing.T) {
	a, err := RandomBytes(32)
	if err != nil {
		t.Fatal(err)
	}
	b, err := RandomBytes(32)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, b) {
		t.Fatal("two random draws collided")
	}
	if len(a) != 32 || len(b) != 32 {
		t.Fatalf("wrong length: %d %d", len(a), len(b))
	}
}

func TestRandomBytesInvalid(t *testing.T) {
	if _, err := RandomBytes(0); err == nil {
		t.Fatal("expected error for n=0")
	}
	if _, err := RandomBytes(-1); err == nil {
		t.Fatal("expected error for n<0")
	}
}

func TestDeriveKEKDeterministic(t *testing.T) {
	// 相同输入必须产出相同 KEK —— 这是 unlock 能成功的前提
	salt := make([]byte, SaltSize)
	for i := range salt {
		salt[i] = byte(i)
	}
	k1, err := DeriveKEK("hunter22hunter22", salt, 8*1024, 1, 1, 32)
	if err != nil {
		t.Fatal(err)
	}
	k2, err := DeriveKEK("hunter22hunter22", salt, 8*1024, 1, 1, 32)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(k1, k2) {
		t.Fatal("Argon2id output not deterministic")
	}
	if len(k1) != 32 {
		t.Fatalf("expected 32-byte KEK, got %d", len(k1))
	}
}

// TestDeriveKEKKnownVector 锁定 Argon2id 输出，
// 任何隐式参数变化（algorithm = id, hash length, encoding）都会导致 mismatch
// → 防止意外升级 golang.org/x/crypto 破坏与 desktop / hash-wasm 的字节级兼容。
//
// 向量由 golang.org/x/crypto/argon2.IDKey 自身在 m=8192/t=2/p=2 下产出，
// 与 phone/lib/crypto.ts 中 hash-wasm 的 argon2id 结果应当一致。
func TestDeriveKEKKnownVector(t *testing.T) {
	salt := bytes.Repeat([]byte{0xAB}, SaltSize)
	got, err := DeriveKEK("correct horse battery staple", salt, 8*1024, 2, 2, 32)
	if err != nil {
		t.Fatal(err)
	}
	// 此向量在 go.mod 当前 golang.org/x/crypto 版本下是稳定的
	const wantHex = "b95794ea37af333fbb49d97b0a9d52b42c77e413459c218083ac260daa41623a"
	want, _ := hex.DecodeString(wantHex)
	if !bytes.Equal(got, want) {
		t.Fatalf("argon2id vector mismatch:\n got=%x\nwant=%s", got, wantHex)
	}
}

func TestDeriveKEKValidation(t *testing.T) {
	salt := make([]byte, SaltSize)
	cases := []struct {
		name             string
		pw               string
		salt             []byte
		mem, iter, par   int
		keyLen           int
		expectErrSubstr  string
	}{
		{"empty password", "", salt, 8 * 1024, 1, 1, 32, "empty"},
		{"short salt", "pw12345678", salt[:16], 8 * 1024, 1, 1, 32, "salt length"},
		{"low memory", "pw12345678", salt, 1024, 1, 1, 32, "memory too low"},
		{"low iter", "pw12345678", salt, 8 * 1024, 0, 1, 32, "iterations too low"},
		{"low par", "pw12345678", salt, 8 * 1024, 1, 0, 32, "parallelism too low"},
		{"wrong keylen", "pw12345678", salt, 8 * 1024, 1, 1, 16, "keyLen"},
		{"par overflow", "pw12345678", salt, 8 * 1024, 1, 256, 32, "parallelism overflow"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DeriveKEK(tc.pw, tc.salt, tc.mem, tc.iter, tc.par, tc.keyLen)
			if err == nil || !strings.Contains(err.Error(), tc.expectErrSubstr) {
				t.Fatalf("expected error containing %q, got %v", tc.expectErrSubstr, err)
			}
		})
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	key, err := RandomBytes(KeySize)
	if err != nil {
		t.Fatal(err)
	}
	pt := []byte(`{"id":"abc","name":"github","password":"s3cr3t"}`)
	aad := []byte("abc") // 模拟 item.id 作为 aad
	sealed, err := SealAEAD(key, pt, aad)
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed) != NonceSize+len(pt)+16 {
		t.Fatalf("sealed length wrong: got %d want %d", len(sealed), NonceSize+len(pt)+16)
	}
	out, err := OpenAEAD(key, sealed, aad)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, pt) {
		t.Fatalf("round trip mismatch: got %s want %s", out, pt)
	}
}

func TestOpenRejectsWrongAAD(t *testing.T) {
	key, _ := RandomBytes(KeySize)
	pt := []byte("hello world")
	sealed, _ := SealAEAD(key, pt, []byte("item-A"))
	if _, err := OpenAEAD(key, sealed, []byte("item-B")); err == nil {
		t.Fatal("expected aad mismatch to fail")
	}
}

func TestOpenRejectsTampered(t *testing.T) {
	key, _ := RandomBytes(KeySize)
	sealed, _ := SealAEAD(key, []byte("payload"), []byte("aad"))
	sealed[len(sealed)-1] ^= 0x01 // 翻转 tag 最后一字节
	if _, err := OpenAEAD(key, sealed, []byte("aad")); err == nil {
		t.Fatal("expected tampered ciphertext to fail")
	}
}

func TestOpenRejectsWrongKey(t *testing.T) {
	k1, _ := RandomBytes(KeySize)
	k2, _ := RandomBytes(KeySize)
	sealed, _ := SealAEAD(k1, []byte("payload"), []byte("aad"))
	if _, err := OpenAEAD(k2, sealed, []byte("aad")); err == nil {
		t.Fatal("expected wrong-key open to fail")
	}
}

func TestKeySizeValidation(t *testing.T) {
	bad := make([]byte, KeySize-1)
	if _, err := SealAEAD(bad, []byte("x"), nil); err == nil {
		t.Fatal("expected key length error")
	}
	if _, err := OpenAEAD(bad, make([]byte, NonceSize+16), nil); err == nil {
		t.Fatal("expected key length error")
	}
}

func TestSealedTooShort(t *testing.T) {
	key, _ := RandomBytes(KeySize)
	if _, err := OpenAEAD(key, []byte("too short"), nil); err == nil {
		t.Fatal("expected too-short error")
	}
}

// TestVerifierFlow 重放 vault unlock 的核心路径：
//   1. 派生 KEK
//   2. 用 KEK 解开 wrappedDEK
//   3. 用 DEK 解开 verifier，明文必须等于 VERIFIER_PLAINTEXT
// 任一环节失败都对应"主密码错误"。
func TestVerifierFlow(t *testing.T) {
	salt, _ := RandomBytes(SaltSize)
	dek, _ := RandomBytes(KeySize)
	kek, err := DeriveKEK("MyMasterPassword!", salt, 8*1024, 1, 1, 32)
	if err != nil {
		t.Fatal(err)
	}
	wrappedDEK, err := SealAEAD(kek, dek, []byte(aadDEK))
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := SealAEAD(dek, []byte(verifierPT), []byte(aadVerifier))
	if err != nil {
		t.Fatal(err)
	}

	// 模拟 unlock
	kek2, _ := DeriveKEK("MyMasterPassword!", salt, 8*1024, 1, 1, 32)
	dek2, err := OpenAEAD(kek2, wrappedDEK, []byte(aadDEK))
	if err != nil {
		t.Fatal("unwrap DEK failed:", err)
	}
	if !bytes.Equal(dek, dek2) {
		t.Fatal("unwrapped DEK mismatch")
	}
	plain, err := OpenAEAD(dek2, verifier, []byte(aadVerifier))
	if err != nil {
		t.Fatal("verifier open failed:", err)
	}
	if string(plain) != verifierPT {
		t.Fatalf("verifier mismatch: %s", plain)
	}

	// 错误密码：KEK 不同 → unwrap 失败
	wrongKEK, _ := DeriveKEK("wrong", salt, 8*1024, 1, 1, 32)
	if _, err := OpenAEAD(wrongKEK, wrappedDEK, []byte(aadDEK)); err == nil {
		t.Fatal("expected wrong-password unwrap to fail")
	}
}
