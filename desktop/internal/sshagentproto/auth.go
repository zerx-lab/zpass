// 鉴权辅助 —— capability token 的生成、读写与 HMAC 挑战应答
//
// ---------------------------------------------------------------------------
// 为什么把这些函数放在协议包里
//
// HMAC 算法、token 文件名（CapabilityFilename）、nonce 字节长度等都属于
// 协议契约的一部分。GUI 和 agent 必须用「位对位完全一致」的实现，否则
// 一端验签永远失败。集中放在 sshagentproto 让两端共用同一份代码，编译期
// 就能发现实现不同步。
//
// ---------------------------------------------------------------------------
// 鉴权流程总览
//
//	(GUI 第一次启动)
//	  GenerateToken() → 32 字节随机
//	  WriteToken(path, token)            ← 0600 文件权限
//
//	(zpass-agent 启动)
//	  ReadToken(path) → 同一份 32 字节
//	  如果文件不存在 → 等待 GUI 起来写入（不退出，进入待命）
//
//	(每次 accept / connect)
//	  发起方                                 应答方
//	  ──────────────────────────────────────────────────
//	  生成 nonce(16B)
//	  发 OpHello{Nonce: hex(nonce)} ────►
//	                                        校验 nonce 格式
//	                                        H = HMAC-SHA256(token, nonce)
//	                                  ◄──── 发 OpHelloAck{NonceHMAC: hex(H)}
//	  本端也算 H' = HMAC(token, nonce)
//	  ConstantTimeCompare(H, H') ✓
//	  → 连接可信
//
// 注意：本流程「单向认证」—— 只是发起方校验应答方知道 token。理论上
// 应当双向（每端都对对端发挑战），但实际威胁模型里：
//   - 攻击者如果能 connect 到 agent 的 socket，他能假装 GUI；
//   - 但应答方 (agent) 验证完发起方持有 token 之后，已经确认「对端知道
//     ~/.config/zpass/agent.cap 的内容」—— 这等价于已经能读到 vault.db
//     一类同权限文件，威胁不是 agent 协议层能挡住的，也没必要在协议层
//     双向折腾。
//
// 如果未来需要双向（例如允许 agent 主动 connect 回 GUI），加一个
// ChallengeFromAgent 字段在 hello_ack，GUI 再发 final_ack 校验即可。

package sshagentproto

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
)

// ---------------------------------------------------------------------------
// Token 文件 IO
// ---------------------------------------------------------------------------

// ErrTokenFileMissing 表示 ~/.config/zpass/agent.cap 文件不存在
//
// 这通常意味着 GUI 还没启动过（首次安装），或用户手动删了文件。
// agent 收到此错误时应当 ** 不退出 **，而是进入「待命」状态轮询文件
// 是否出现 —— 让用户启动 GUI 时无缝衔接。
var ErrTokenFileMissing = errors.New("sshagentproto: capability token file not found")

// ErrTokenFileInvalid 表示 token 文件存在但内容长度不对
//
// 可能场景：用户手工编辑过文件 / 文件被截断 / 磁盘损坏。
// 调用方应当当作 ErrTokenFileMissing 处理 —— 让 GUI 下次启动重新生成。
var ErrTokenFileInvalid = errors.New("sshagentproto: capability token file invalid")

// GenerateToken 生成一个新的 32 字节随机 token
//
// 走 crypto/rand 而不是 math/rand —— 这个 token 是控制通道鉴权的核心
// 凭据，弱随机会让攻击者预测出值进而冒充 GUI。
//
// 调用时机：GUI 首次启动 + 用户主动「重置 agent token」时。
// 一旦写入文件，原则上整个安装生命周期都不变 —— 不会过期 / 不会自动轮换，
// 与 vault.db 一样直到用户重装才会换。
func GenerateToken() ([]byte, error) {
	tok := make([]byte, CapabilityTokenSize)
	if _, err := rand.Read(tok); err != nil {
		return nil, fmt.Errorf("sshagentproto: generate token: %w", err)
	}
	return tok, nil
}

// WriteToken 把 token 原子写入 path（权限 0600）
//
// 「原子」实现：先写到 path+".tmp" 再 rename，与 configservice.go 的
// writeAndSync 同样思路。这样即便写入中途崩溃也不会留下半截 token 文件
// 让 agent 误以为是合法 token。
//
// path 由调用方解析（GUI 与 agent 都通过 paths.go 的 CapabilityTokenPath()
// 拿到完全相同的路径）。本函数不解析路径，纯做 IO。
//
// 权限 0600：仅当前 OS 用户可读写。这是控制通道鉴权的最后一道防线 ——
// 与 vault.db 文件权限一致，让威胁模型对称。
//
// Windows 上 0600 mode 被忽略，由 NTFS ACL 默认的「用户目录仅自身可访问」
// 承担保护，等价。
func WriteToken(path string, token []byte) error {
	if len(token) != CapabilityTokenSize {
		return fmt.Errorf("sshagentproto: token must be %d bytes, got %d",
			CapabilityTokenSize, len(token))
	}

	tmpPath := path + ".tmp"
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("sshagentproto: create %s: %w", tmpPath, err)
	}
	if _, err := f.Write(token); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("sshagentproto: write %s: %w", tmpPath, err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("sshagentproto: sync %s: %w", tmpPath, err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("sshagentproto: close %s: %w", tmpPath, err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("sshagentproto: rename %s -> %s: %w", tmpPath, path, err)
	}
	return nil
}

// ReadToken 读取 path 的 token，校验长度
//
// 返回值约定：
//   - 文件不存在 → ErrTokenFileMissing
//   - 文件长度不为 CapabilityTokenSize → ErrTokenFileInvalid
//   - 其它 IO 错误 → 原样上抛
//
// 校验长度而不是「读多少算多少」是必要的：HMAC 用错长度的 key 不会
// crash，只会得到一个无法和对端匹配的值，调试极难。强校验让错误尽早暴露。
func ReadToken(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrTokenFileMissing
		}
		return nil, fmt.Errorf("sshagentproto: read %s: %w", path, err)
	}
	if len(data) != CapabilityTokenSize {
		return nil, fmt.Errorf("%w: got %d bytes, expected %d",
			ErrTokenFileInvalid, len(data), CapabilityTokenSize)
	}
	return data, nil
}

// ---------------------------------------------------------------------------
// 挑战应答
// ---------------------------------------------------------------------------

// NewNonce 生成一个 hello 阶段的随机 nonce
//
// 长度 = HelloNonceSize (16 字节)，hex 编码后 32 字符。
//
// nonce 用途：让应答方算 HMAC(token, nonce) 证明自己持有 token。
// 由于 nonce 是每次连接重新生成的，攻击者无法重放之前嗅探到的 hmac
// 响应到新连接 —— 即便他用 socat 嗅探到了某次成功的 HelloAck，下一次
// nonce 不同，hmac 也不同。
//
// 调用方拿到字节切片，序列化时转 hex 放进 Envelope.Nonce。本函数不直接
// 返回 hex 字符串是为了保留 raw 字节给后续 ComputeNonceHMAC 用，减少
// 一次 encode/decode 来回。
func NewNonce() ([]byte, error) {
	n := make([]byte, HelloNonceSize)
	if _, err := rand.Read(n); err != nil {
		return nil, fmt.Errorf("sshagentproto: generate nonce: %w", err)
	}
	return n, nil
}

// ComputeNonceHMAC 计算 HMAC-SHA256(token, nonce)，输出 hex 字符串
//
// 算法选型：HMAC-SHA256 而非 SHA512 / SHA3：
//   - 性能：SHA-256 在所有目标平台都有硬件加速（Intel SHA-NI / ARM
//     CryptoExtensions），单次计算 < 1μs
//   - 安全：256 bit 输出对 128 bit 安全等级（CapabilityTokenSize 给 256 bit
//     原始熵，HMAC 输出 256 bit）完全足够
//   - 标准：HMAC 是 RFC 2104，几乎所有平台 / 语言都有实现，未来若用别的
//     语言重写 agent 也能无缝对接
//
// 输出 hex 而非 base64：JSON 里 hex 比 base64 多 33% 字节，但对于 32
// 字节输出（hex = 64 字符），可读性收益远大于带宽差异。
func ComputeNonceHMAC(token, nonce []byte) string {
	mac := hmac.New(sha256.New, token)
	mac.Write(nonce)
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyNonceHMAC 用常量时间比较验证 mac 是否等于 HMAC(token, nonce)
//
// **必须**使用 subtle.ConstantTimeCompare 而非 == ：标准库 strings/bytes
// 比较是逐字节短路的，时序侧信道可能让攻击者从响应延迟里逐字节猜测
// 正确 HMAC。虽然在本地 IPC 场景下时序攻击难以利用，但密码学代码用
// 常量时间比较是「无成本的好习惯」，写错的成本远大于写对。
//
// 返回 bool 而非 error：调用方关心的就是「匹配 / 不匹配」，不需要错误
// 类型区分。
func VerifyNonceHMAC(token, nonce []byte, mac string) bool {
	if mac == "" {
		return false
	}
	expected := ComputeNonceHMAC(token, nonce)
	// 长度不等时 ConstantTimeCompare 直接返回 0，避免 panic on different len
	if len(expected) != len(mac) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(mac)) == 1
}
