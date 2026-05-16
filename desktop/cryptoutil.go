package main

// 加密原语工具集 —— ZPass 桌面客户端
// ---------------------------------------------------------------------------
// 本文件是 vault 加密层的"原子操作底座"，只暴露最小必要的密码学函数。
// 上层（vaultservice.go / vaultdb.go）通过组合这些原子构成"零知识"
// 双层密钥架构（KEK / DEK），确保即便 vault.db 被整库拖走，攻击者在
// 没有主密码的前提下也拿不到任何明文条目。
//
// ---------------------------------------------------------------------------
// 算法选型与理由
//
// 1. KDF：Argon2id（不是 PBKDF2 / scrypt / bcrypt）
//    - Argon2 是 2015 年密码哈希竞赛（PHC）冠军，是当前最公认的密码 KDF。
//    - "id" 变体同时抗 GPU 并行（依赖内存）与抗侧信道（数据无关访问）。
//    - 参数：memory=64 MiB, iterations=3, parallelism=4
//      * 这套参数符合 OWASP 2023 Password Storage Cheat Sheet 推荐
//        ("m=65536 KiB, t=3, p=4")，在 2024 年的桌面机器上每次派生
//        约 200-400ms —— 用户感知不到延迟，但攻击者每秒只能尝试 2-5 次/核，
//        即使租用大型 GPU 集群也极度昂贵。
//      * 64 MiB 内存上限挡住了 ASIC / GPU 暴力破解：单卡 24 GB 显存最多
//        并行 ~370 个会话，远低于 PBKDF2-HMAC-SHA256 同等算力下的 100M+ /s。
//      * 三个参数都存进 vault_meta 表（见 vaultdb.go），未来需要"变强"
//        时（例如 2030 年硬件升级）只需写迁移：用旧参数解锁后用新参数
//        重新派生 + 重新包装 DEK，所有 item 不变。
//    - salt：32 字节随机，每个 vault 一份，存 vault_meta；防"彩虹表"。
//
// 2. AEAD：XChaCha20-Poly1305（不是 AES-GCM）
//    - 24 字节 nonce vs AES-GCM 的 12 字节。12 字节 nonce 在 2^32 次
//      操作后碰撞概率显著（生日界），不适合"随机 nonce"模式 —— 会迫使
//      调用方维护计数器或 KDF nonce derivation。XChaCha 的 24 字节
//      nonce 让"每次写入随机生成"在密码学上完全安全（2^96 次操作才有
//      相同概率），实现简单且无状态。
//    - 纯 Go 实现，无 CGO 依赖（golang.org/x/crypto/chacha20poly1305），
//      跨平台编译零负担，与 modernc.org/sqlite 的纯 Go 选型一致。
//    - 在不带 AES-NI 指令集的 ARM 设备上比 AES-GCM 更快；x86 上接近。
//    - Authenticated（AEAD）：自带 16 字节 Poly1305 tag，密文被篡改解密
//      会失败 —— 这正是 verifier 机制（用 DEK 解 verifier，tag 错 = 密码
//      错）的基础。我们**不**单独存"密码哈希"，避免给离线爆破留任何
//      靶子；攻击者必须做完整的 Argon2id 派生 + AEAD 解密才能验证一次
//      猜测，每次成本是数百毫秒的 Argon2id 而非微秒级 SHA-256。
//
// 3. 随机数：crypto/rand
//    - 所有 nonce / salt / DEK 生成都走 crypto/rand。一旦 rand.Read 失败
//      （极罕见，比如 /dev/urandom 不可用），直接返回错误，**绝不**回退到
//      math/rand —— 弱随机会让整个体系崩盘。
//
// ---------------------------------------------------------------------------
// 与上层的契约
//
// - DeriveKEK(password, salt, params) → [32]byte
//     给 vaultservice.Initialize / Unlock 使用：把主密码派生为 KEK
// - GenerateRandomBytes(n) → []byte
//     给 vaultservice.Initialize 使用：生成 salt(32) / DEK(32)
// - SealAEAD(key, plaintext, aad) → ciphertext (含 24B nonce 前缀)
// - OpenAEAD(key, ciphertext, aad) → plaintext
//     用于：包装 DEK（aad="dek"）、加密 verifier（aad="verifier"）、
//          加密 item payload（aad=item.id，绑定 ID 防止条目调换攻击）
// - WipeBytes(buf)
//     在不再使用的 key 上调用，尽量减少 KEK / DEK 在内存里的驻留时间
//
// 这些函数都做了输入校验并返回 error，调用方不需要再做长度断言。

import (
	"crypto/rand"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const (
	// KeySize 是对称密钥长度（KEK / DEK 都用同一长度）
	// XChaCha20-Poly1305 需要恰好 32 字节
	KeySize = chacha20poly1305.KeySize // = 32

	// NonceSize 是 XChaCha20-Poly1305 的 nonce 长度（24 字节）
	// 与 AES-GCM 的 12 字节相比，足够支持每次随机生成而不碰撞
	NonceSize = chacha20poly1305.NonceSizeX // = 24

	// SaltSize 是 Argon2id 派生时使用的 salt 长度
	// 32 字节远超 NIST 推荐的 16 字节下限，无副作用，留出冗余
	SaltSize = 32

	// VerifierPlaintext 是用 DEK 加密后存到 vault_meta.verifier 的"已知明文"
	// Unlock 时解密这块数据并比对前缀，AEAD tag 校验失败 → 密码错误
	// 选用一个固定字符串（带版本号方便未来格式迁移识别）
	VerifierPlaintext = "zpass-vault-verifier-v1"
)

// ---------------------------------------------------------------------------
// Argon2id 参数
// ---------------------------------------------------------------------------

// Argon2idParams 描述一次 Argon2id 派生的可调参数
//
// 这套结构会作为字段存进 vault_meta 表（见 vaultdb.go），让"vault 创建
// 时所用的参数"和"vault 文件本身"打包在一起：未来即使改了 DefaultArgon2id，
// 也能用旧参数解锁老 vault；解锁成功后再升级参数 + 重新包装 DEK。
//
// 所有字段对应 argon2.IDKey 的同名参数：
//   - MemoryKiB:  每次派生消耗的内存（KiB）。越大越抗 GPU
//   - Iterations: 时间成本（pass 数）
//   - Parallelism: 并行度（lane 数）
//   - KeyLen:     输出密钥长度（字节）—— 我们恒为 KeySize=32
type Argon2idParams struct {
	MemoryKiB   uint32
	Iterations  uint32
	Parallelism uint8
	KeyLen      uint32
}

// DefaultArgon2id 返回 2024 年桌面端的推荐参数
//
// memory=64 MiB / iter=3 / parallelism=4 ：
//   - 在 M1 / Ryzen 5000 / Intel 12 代上单次派生 ~250-400 ms
//   - 用户每次解锁感知"略有停顿但可接受"，攻击者每核每秒只能跑 ~2-4 次
//   - 64 MiB 内存上限堵死了 GPU/ASIC 大规模并行（消费级 GPU 24 GB 显存
//     最多 ~370 并行，对比 PBKDF2 的百万倍并行，攻击预算翻 10000+ 倍）
//
// 这套参数明确**不**作为常量编进调用方，每个 vault 在 Initialize 时把
// 当时的 DefaultArgon2id() 拷贝一份存进 vault_meta —— 解锁永远用 DB 里
// 记录的参数，避免升级 DefaultArgon2id 把老用户挡在门外。
func DefaultArgon2id() Argon2idParams {
	return Argon2idParams{
		MemoryKiB:   64 * 1024, // 64 MiB
		Iterations:  3,
		Parallelism: 4,
		KeyLen:      KeySize,
	}
}

// Validate 校验 Argon2id 参数取值合理
//
// 防御场景：从 vault_meta 反序列化时，若 DB 文件被外部篡改成"超低成本"
// 参数（例如 memory=8 KiB / iter=1），我们应该拒绝继续派生 —— 否则
// 用户主密码会被以一个被攻击者预先选好的、非常容易爆破的强度去派生，
// 形同把保险柜降级。
//
// 阈值：选择"明显低于 OWASP 历史最低推荐"的下限 —— memory<8 MiB 或
// iter<1 直接拒绝。这些值即使在 2015 年的 PHC 推荐里都不会出现。
func (p Argon2idParams) Validate() error {
	if p.MemoryKiB < 8*1024 {
		return fmt.Errorf("argon2id memory too low: %d KiB (min 8192 KiB / 8 MiB)", p.MemoryKiB)
	}
	if p.Iterations < 1 {
		return fmt.Errorf("argon2id iterations too low: %d (min 1)", p.Iterations)
	}
	if p.Parallelism < 1 {
		return fmt.Errorf("argon2id parallelism too low: %d (min 1)", p.Parallelism)
	}
	if p.KeyLen != KeySize {
		return fmt.Errorf("argon2id key length must be %d, got %d", KeySize, p.KeyLen)
	}
	return nil
}

// ---------------------------------------------------------------------------
// KDF：Argon2id 派生
// ---------------------------------------------------------------------------

// DeriveKEK 用 Argon2id 把主密码派生为 KEK（Key Encryption Key）
//
// 输入：
//   - password：用户输入的主密码（明文 string）
//     调用方应在使用完成后立即清空（如本地变量超出作用域）
//   - salt    ：32 字节随机盐，每个 vault 一份，存 vault_meta
//   - params  ：Argon2id 参数（从 vault_meta 读出，不直接用 DefaultArgon2id）
//
// 输出：
//   - 32 字节 KEK，调用方在用完后必须 WipeBytes 清零
//
// 错误：
//   - password 为空（防御性 —— vault service 已经先校验过，但密码学层
//     再校一遍以保证调用安全）
//   - salt 长度错误
//   - 参数非法（Validate 失败）
//
// 注意：
//   - argon2.IDKey 内部会对 password 做 utf8 字节序列化；用户输入任何
//     Unicode 字符都安全
//   - 派生过程是阻塞的纯 CPU + 内存计算，调用方需要在 goroutine 里跑
//     避免阻塞 Wails 事件循环（vaultservice 已经走的是请求-响应模式，
//     每次调用本来就是新 goroutine，无需额外处理）
func DeriveKEK(password string, salt []byte, params Argon2idParams) ([]byte, error) {
	if password == "" {
		return nil, errors.New("master password cannot be empty")
	}
	if len(salt) != SaltSize {
		return nil, fmt.Errorf("kdf salt length must be %d, got %d", SaltSize, len(salt))
	}
	if err := params.Validate(); err != nil {
		return nil, err
	}

	// argon2.IDKey 是纯函数式接口，没有副作用，输出固定长度的 key
	// 不传 secret/data 等可选参数，遵循 RFC 9106 的最小调用形态
	key := argon2.IDKey(
		[]byte(password),
		salt,
		params.Iterations,
		params.MemoryKiB,
		params.Parallelism,
		params.KeyLen,
	)
	return key, nil
}

// ---------------------------------------------------------------------------
// 随机
// ---------------------------------------------------------------------------

// GenerateRandomBytes 用 crypto/rand 生成 n 字节随机数据
//
// 用途：
//   - 生成 KDF salt（n=SaltSize=32）
//   - 生成 DEK（n=KeySize=32）
//   - 生成 AEAD nonce（n=NonceSize=24，但通常通过 SealAEAD 内部完成）
//   - 生成 item id 的随机后缀（如果未来不用 UUID）
//
// 失败处理：
//   - rand.Read 在主流操作系统上几乎不会失败（macOS getentropy / Linux
//     getrandom / Windows BCryptGenRandom 都是稳定 syscall）。一旦失败
//     表示系统熵池处于异常状态，直接返回错误而不重试 —— 调用方应该把
//     这种错误升级为"无法初始化 vault"，绝不能用 math/rand 顶替
func GenerateRandomBytes(n int) ([]byte, error) {
	if n <= 0 {
		return nil, fmt.Errorf("invalid random byte count: %d", n)
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("crypto/rand failed: %w", err)
	}
	return buf, nil
}

// ---------------------------------------------------------------------------
// AEAD：XChaCha20-Poly1305
// ---------------------------------------------------------------------------

// SealAEAD 用 key 加密 plaintext，并用 aad 绑定上下文
//
// 输出格式：[24-byte nonce][ciphertext][16-byte Poly1305 tag]
//
// 把 nonce 内联在密文前缀是密码学常用约定 —— 既不会泄露任何信息（nonce
// 本来就需要随密文一起传输才能解密），又让上层只需要存一个 BLOB 字段
// 而不是 nonce / ct 两个字段。
//
// aad（Additional Authenticated Data）的作用：
//   - 不参与加密，但参与认证
//   - 解密时必须传入完全相同的 aad，否则 tag 校验失败
//   - 我们用 aad 绑定 "ciphertext 应该出现在哪种上下文"：
//   - 包装 DEK 时 aad="zpass:dek"
//   - 加密 verifier 时 aad="zpass:verifier"
//   - 加密 item 时 aad=item.id（hex string）
//     这样攻击者即使有 DB 写权限，也不能把 item A 的密文搬到 item B 的
//     行里 —— 解密 B 时 aad=B.id 不匹配 A 的 aad=A.id，tag 失败。
//
// 错误：
//   - key 长度不为 KeySize
//   - 随机生成 nonce 失败
//   - cipher 初始化失败（理论上不会，参数固定）
func SealAEAD(key, plaintext, aad []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("aead key length must be %d, got %d", KeySize, len(key))
	}

	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		// 仅在 key 长度错误时发生，上面已经校验过；保留错误传递保险
		return nil, fmt.Errorf("init xchacha20poly1305: %w", err)
	}

	nonce, err := GenerateRandomBytes(NonceSize)
	if err != nil {
		return nil, err
	}

	// Seal 第一个参数是 dst —— 传入预先填好 nonce 的切片，让 Seal 在其后
	// 追加 ciphertext+tag。这样最终输出就是 nonce||ct||tag 的拼接，无需
	// 再做一次 append。dst 容量预留足够空间避免重新分配。
	out := make([]byte, NonceSize, NonceSize+len(plaintext)+chacha20poly1305.Overhead)
	copy(out, nonce)
	out = aead.Seal(out, nonce, plaintext, aad)
	return out, nil
}

// OpenAEAD 解密 SealAEAD 的输出
//
// 输入 sealed 必须是 [nonce(24)][ct][tag(16)] 的连续字节。tag 验证失败
// 会返回错误 —— 这是验证密码正确性、防止数据库被篡改的核心机制。
//
// 调用方拿到 plaintext 后用完应当 WipeBytes 清零（特别是包装 DEK / 主密钥
// 之类的密钥材料）。
//
// 错误：
//   - sealed 长度不足以容纳 nonce+tag
//   - aead 初始化失败
//   - tag 校验失败（密码错 / 数据被篡改 / aad 不匹配 —— 上层会把这一类
//     统一翻译成"主密码错误"暴露给前端，避免攻击者通过错误消息辨别是
//     "密码错"还是"数据库损坏"）
func OpenAEAD(key, sealed, aad []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("aead key length must be %d, got %d", KeySize, len(key))
	}
	if len(sealed) < NonceSize+chacha20poly1305.Overhead {
		return nil, fmt.Errorf("aead ciphertext too short: %d bytes (need >= %d)",
			len(sealed), NonceSize+chacha20poly1305.Overhead)
	}

	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("init xchacha20poly1305: %w", err)
	}

	nonce := sealed[:NonceSize]
	ciphertext := sealed[NonceSize:]

	plaintext, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		// 不要把底层错误信息原样上抛 —— Open 失败的具体原因（密文长度异常
		// vs tag 错）对攻击者有信息价值。统一返回模糊错误。
		return nil, errors.New("aead authentication failed")
	}
	return plaintext, nil
}

// ---------------------------------------------------------------------------
// 内存清理
// ---------------------------------------------------------------------------

// WipeBytes 把切片内容置零
//
// Go 的 GC 不保证敏感字节及时被覆写，KEK / DEK 这类密钥材料在用完后
// 应主动覆盖 —— 即便不能阻止 swap / coredump 完全暴露内存（那需要
// mlock / VirtualLock，跨平台代价高且 Wails 的 webview 进程同样能读
// 这块内存），也能缩小窗口。
//
// 使用注意：
//   - WipeBytes 只对**底层数组**生效，不会改变切片头。如果 buf 是 string
//     转出来的（不可变），不能这么做（会 panic on write）。所以调用方
//     必须保证 buf 是 make/append 出来的可写切片。
//   - 调用后切片仍可读但全是 0。一般紧接着把外层引用置 nil 让 GC 回收。
//
// 注：Go 编译器不会主动优化掉这个循环（subtle.ConstantTimeCompare 等
// 也不主动 zeroize），实务上够用。需要更强保证可改成 runtime.KeepAlive +
// crypto/subtle 的内存屏障组合，但本项目当前威胁模型不需要那个层级。
func WipeBytes(buf []byte) {
	for i := range buf {
		buf[i] = 0
	}
}
