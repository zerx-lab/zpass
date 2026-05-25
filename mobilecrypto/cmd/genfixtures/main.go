// genfixtures —— 生成 Go ↔ Rust 跨语言一致性测试向量
//
// 用法（从 mobilecrypto/ 目录执行）：
//
//	go run ./cmd/genfixtures
//
// 输出：../cryptocore/tests/fixtures/cross-validation.json
//
// 文件被 cryptocore/tests/cross_validation.rs 加载，验证：
//   - KEK 字节级与 Go argon2.IDKey 完全相等
//   - Rust open_aead 能解开 Go SealAEAD 的输出
//
// 重新生成会让 AEAD 段的 sealed 字节改变（nonce 随机），KEK 段稳定不变。
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/zerx-lab/zpass/mobilecrypto"
)

type kekCase struct {
	Name        string `json:"name"`
	Password    string `json:"password"`
	SaltB64     string `json:"salt_b64"`
	MemKiB      int    `json:"mem_kib"`
	Iter        int    `json:"iter"`
	Par         int    `json:"par"`
	KeyLen      int    `json:"key_len"`
	ExpectedB64 string `json:"expected_kek_b64"`
}

type aeadCase struct {
	Name         string `json:"name"`
	KeyB64       string `json:"key_b64"`
	PlaintextB64 string `json:"plaintext_b64"`
	AadB64       string `json:"aad_b64"`
	SealedB64    string `json:"sealed_b64"`
}

type fixtures struct {
	GeneratedBy string     `json:"_generated_by"`
	Notes       string     `json:"_notes"`
	Kek         []kekCase  `json:"kek_cases"`
	Aead        []aeadCase `json:"aead_cases"`
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// 固定盐 —— 由 byte index 推导，跨语言可重现
func repeatByte(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func incSalt() []byte {
	salt := make([]byte, mobilecrypto.SaltSize)
	for i := range salt {
		salt[i] = byte(i)
	}
	return salt
}

func mustDeriveKEK(name, pw string, salt []byte, mem, iter, par, keyLen int) kekCase {
	key, err := mobilecrypto.DeriveKEK(pw, salt, mem, iter, par, keyLen)
	if err != nil {
		panic(fmt.Sprintf("DeriveKEK %s: %v", name, err))
	}
	return kekCase{
		Name:        name,
		Password:    pw,
		SaltB64:     b64(salt),
		MemKiB:      mem,
		Iter:        iter,
		Par:         par,
		KeyLen:      keyLen,
		ExpectedB64: b64(key),
	}
}

func mustSeal(name string, key, pt, aad []byte) aeadCase {
	sealed, err := mobilecrypto.SealAEAD(key, pt, aad)
	if err != nil {
		panic(fmt.Sprintf("SealAEAD %s: %v", name, err))
	}
	return aeadCase{
		Name:         name,
		KeyB64:       b64(key),
		PlaintextB64: b64(pt),
		AadB64:       b64(aad),
		SealedB64:    b64(sealed),
	}
}

func mustRand(n int) []byte {
	b, err := mobilecrypto.RandomBytes(n)
	if err != nil {
		panic(err)
	}
	return b
}

func main() {
	kekCases := []kekCase{
		// 与 mobilecrypto/crypto_test.go::TestDeriveKEKKnownVector 同向量
		mustDeriveKEK(
			"known-vector-correct-horse",
			"correct horse battery staple",
			repeatByte(0xAB, mobilecrypto.SaltSize),
			8*1024, 2, 2, 32,
		),
		// 单 iter / 单 par 的最低参数（vault 默认 fast profile）
		mustDeriveKEK("min-params-ascii", "hunter22hunter22", incSalt(), 8*1024, 1, 1, 32),
		// UTF-8 密码 + 中等参数
		mustDeriveKEK("utf8-password", "正确的马电池订书钉!", incSalt(), 16*1024, 2, 1, 32),
		// 较高 memory / par
		mustDeriveKEK("high-mem-par", "MyMasterPassword!", repeatByte(0x42, mobilecrypto.SaltSize), 32*1024, 3, 4, 32),
		// 边界：parallelism = 255（紧贴 par overflow 上界）
		mustDeriveKEK("par-edge-255", "edgecase", repeatByte(0x01, mobilecrypto.SaltSize), 8*1024, 1, 255, 32),
	}

	// AEAD 用例：每条都用确定的 key/pt/aad，sealed 含 random nonce 所以每次生成会变
	// Rust 端通过 open(key, sealed, aad) == plaintext 验证
	aeadCases := []aeadCase{
		mustSeal("empty-aad", mustRand(mobilecrypto.KeySize), []byte(`{"id":"abc","password":"s3cr3t"}`), nil),
		mustSeal("empty-plaintext", mustRand(mobilecrypto.KeySize), nil, []byte("zpass:dek")),
		mustSeal("production-dek-aad", mustRand(mobilecrypto.KeySize), mustRand(32), []byte("zpass:dek")),
		mustSeal("production-verifier-aad", mustRand(mobilecrypto.KeySize), []byte("zpass-vault-verifier-v1"), []byte("zpass:verifier")),
		mustSeal("long-plaintext-4kb", mustRand(mobilecrypto.KeySize), mustRand(4096), []byte("item-xyz")),
		mustSeal("utf8-plaintext", mustRand(mobilecrypto.KeySize), []byte("含中文 + emoji 🔑 的明文"), []byte("aad-with-中文")),
	}

	f := fixtures{
		GeneratedBy: "mobilecrypto/cmd/genfixtures (Go " + runtime.Version() + ")",
		Notes: "Cross-language byte-parity fixtures. KEK cases are deterministic; AEAD `sealed_b64` changes on regeneration " +
			"because nonce is random — Rust verifies decryption equality, not byte equality.",
		Kek:  kekCases,
		Aead: aeadCases,
	}

	// 找仓库根 → cryptocore/tests/fixtures/
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	// 期望从 mobilecrypto/ 调用
	if filepath.Base(cwd) != "mobilecrypto" {
		fmt.Fprintln(os.Stderr, "warn: expected to run from mobilecrypto/, cwd =", cwd)
	}
	outDir := filepath.Join(cwd, "..", "cryptocore", "tests", "fixtures")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		panic(err)
	}
	outPath := filepath.Join(outDir, "cross-validation.json")

	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		panic(err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(outPath, data, 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("wrote %d KEK + %d AEAD cases → %s\n", len(kekCases), len(aeadCases), outPath)
}
