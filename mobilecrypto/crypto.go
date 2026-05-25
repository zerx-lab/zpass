// Package mobilecrypto 是 ZPass 移动端（React Native / Expo）通过 gomobile bind
// 调用的加密原语。算法、参数、字节布局与 desktop/internal/services/cryptoutil.go
// 严格保持一致 —— 同一个 vault 文件在 desktop / phone 之间必须可互相解读。
//
// 为什么独立 go.mod：
//   - desktop 的 go.mod 拖入了 sqlite、huma、gozxing 等大体积依赖，全部走
//     gomobile bind 会让 AAR 膨胀到 50MB+ 且包含无关代码。
//   - mobilecrypto 只依赖 golang.org/x/crypto（argon2 + chacha20poly1305），
//     bind 后的 AAR 在 ~6MB 量级。
//
// gomobile bind 的类型约束（重要！）：
//   - 参数 / 返回值只支持：string / []byte / 基础数值类型 / error / 本包接口
//   - 不能用结构体作为参数 → Argon2id 三个参数拆成扁平 int
//   - 返回值最多两个：(T, error)
//   - JS / Java / Swift 端都通过这套扁平 API 调用
package mobilecrypto

import (
	"crypto/rand"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

// 与 desktop cryptoutil 的常量保持一致；前端也用同样数值（phone/lib/crypto.ts）
const (
	KeySize   = chacha20poly1305.KeySize   // 32
	NonceSize = chacha20poly1305.NonceSizeX // 24
	SaltSize  = 32
)

// 阈值与 desktop Argon2idParams.Validate 对齐：低于这条线直接拒绝，
// 避免 vault 文件被改成超低强度参数后用户不知情。
const (
	minMemoryKiB   = 8 * 1024
	minIterations  = 1
	minParallelism = 1
)

// DeriveKEK 用 Argon2id 派生 32 字节 KEK
//
// 参数与 RFC 9106 / golang.org/x/crypto/argon2.IDKey 对应：
//   - password   主密码（UTF-8 字符串；Java 端 String 也是 UTF-16 → 转 byte 时是 UTF-8）
//   - salt       32 字节随机盐
//   - memKiB     内存成本（KiB）；不得低于 8192
//   - iter       时间成本（pass 数）
//   - par        并行度（lane 数）
//   - keyLen     输出长度；目前调用方恒传 32
//
// 阻塞 CPU + 内存计算。JS 调用方需要在异步路径里调用（gomobile bind 生成的
// Java 方法在调用线程上跑；Expo Module 用协程跳出主线程即可）。
func DeriveKEK(password string, salt []byte, memKiB, iter, par, keyLen int) ([]byte, error) {
	if password == "" {
		return nil, errors.New("master password cannot be empty")
	}
	if len(salt) != SaltSize {
		return nil, fmt.Errorf("salt length must be %d, got %d", SaltSize, len(salt))
	}
	if memKiB < minMemoryKiB {
		return nil, fmt.Errorf("argon2id memory too low: %d KiB (min %d)", memKiB, minMemoryKiB)
	}
	if iter < minIterations {
		return nil, fmt.Errorf("argon2id iterations too low: %d", iter)
	}
	if par < minParallelism {
		return nil, fmt.Errorf("argon2id parallelism too low: %d", par)
	}
	if keyLen != KeySize {
		return nil, fmt.Errorf("argon2id keyLen must be %d, got %d", KeySize, keyLen)
	}
	if par > 0xff {
		return nil, fmt.Errorf("argon2id parallelism overflow: %d", par)
	}
	key := argon2.IDKey(
		[]byte(password),
		salt,
		uint32(iter),
		uint32(memKiB),
		uint8(par),
		uint32(keyLen),
	)
	return key, nil
}

// SealAEAD XChaCha20-Poly1305 加密。
// 输出布局：[24-byte nonce][ciphertext][16-byte tag]
//
// aad 不参与加密但参与认证。上层用 aad 绑定上下文（"zpass:dek" / item.id …），
// 防止密文跨上下文挪用。
func SealAEAD(key, plaintext, aad []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("aead key length must be %d, got %d", KeySize, len(key))
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("init xchacha20poly1305: %w", err)
	}
	nonce, err := RandomBytes(NonceSize)
	if err != nil {
		return nil, err
	}
	out := make([]byte, NonceSize, NonceSize+len(plaintext)+chacha20poly1305.Overhead)
	copy(out, nonce)
	out = aead.Seal(out, nonce, plaintext, aad)
	return out, nil
}

// OpenAEAD 解密 SealAEAD 的输出。tag 校验失败统一返回模糊错误，避免泄露
// "密码错 / 数据库损坏 / aad 不匹配" 的差异。
func OpenAEAD(key, sealed, aad []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("aead key length must be %d, got %d", KeySize, len(key))
	}
	if len(sealed) < NonceSize+chacha20poly1305.Overhead {
		return nil, fmt.Errorf("aead ciphertext too short: %d bytes", len(sealed))
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("init xchacha20poly1305: %w", err)
	}
	nonce := sealed[:NonceSize]
	ct := sealed[NonceSize:]
	pt, err := aead.Open(nil, nonce, ct, aad)
	if err != nil {
		return nil, errors.New("aead authentication failed")
	}
	return pt, nil
}

// RandomBytes 用 crypto/rand 生成 n 字节随机数据。
// rand.Read 失败时直接返回错误，绝不回退弱随机。
func RandomBytes(n int) ([]byte, error) {
	if n <= 0 {
		return nil, fmt.Errorf("invalid random byte count: %d", n)
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("crypto/rand failed: %w", err)
	}
	return buf, nil
}
