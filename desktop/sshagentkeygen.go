// SSH agent 服务 —— vault 内密钥生成
//
// ---------------------------------------------------------------------------
// 目标
//
// 在新建 SSH item 时让用户「一键生成」而不是手动粘贴 OpenSSH 私钥。
// 这与 1Password / Bitwarden 的最佳实践一致 —— 生成应当是首屏路径，
// 「导入已有密钥」是次要选项。
//
// 流程：
//   1. 用户在前端选算法（默认 ed25519）+ 可选 comment
//   2. 前端调 GenerateKeyPair → 后端在内存中生成密钥对
//   3. 后端返回 { privateKeyPEM, publicKeyOpenSSH, fingerprint }
//   4. 前端把这些预填到 SSH item dialog 的字段
//   5. 用户点保存 → 走正常 CreateItem 流程，私钥被 vault 加密落盘
//
// ---------------------------------------------------------------------------
// 算法选型
//
// 支持三种现代算法：
//   - ed25519（默认推荐）：32 字节私钥，快，无量子前夕兼容好
//   - rsa-3072：兼容老服务器（< OpenSSH 7.0）
//   - ecdsa-p256：硬件 token 友好（YubiKey、TPM）
//
// 不支持：
//   - rsa-1024 / rsa-2048：已被多数服务器拒绝，不该生成
//   - ssh-dss：已弃用
//
// ---------------------------------------------------------------------------
// 安全注意
//
// - 生成时 crypto/rand 是唯一熵源；rand.Read 失败立即返错，绝不退化到 math/rand
// - 私钥 PEM 字节从 ssh.MarshalPrivateKey 返回后，由 caller（前端 IPC）短暂
//   持有。前端在「填入 dialog」后调用 CreateItem 把它加密入 vault，过程中
//   私钥在 Wails IPC 通道里以 base64 字符串形式传输 —— 这是当前架构的接受
//   的暴露窗口（与「用户粘贴私钥到 dialog」等价）
// - 不在后端缓存生成的私钥 —— 一次性返回，调用方负责入库
//
// ---------------------------------------------------------------------------
// 为什么不直接在后端「生成 + 入库」一站式
//
// 让前端先拿到生成结果再走 CreateItem 是为了：
//   1. 用户可以在保存前看到 fingerprint / 公钥，决定要不要保存
//   2. 用户可以编辑 comment 等字段
//   3. 复用现有 CreateItem 流程（含通知 ssh agent 重推等）
//   4. 失败回滚简单 —— 用户取消 dialog 时不用「删刚建的 vault item」

package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"
)

// ---------------------------------------------------------------------------
// 支持的算法
// ---------------------------------------------------------------------------

// SSHKeyAlgo 用户在前端可选的密钥算法
//
// 命名直接对应 OpenSSH 的算法标识（`ssh -t`），让用户看到熟悉的字面量。
type SSHKeyAlgo string

const (
	// SSHAlgoEd25519 默认推荐 —— 现代、快、抗量子前夕
	SSHAlgoEd25519 SSHKeyAlgo = "ed25519"

	// SSHAlgoRSA3072 OpenSSH 7.0 之前服务器的兼容选项
	//
	// 3072 是「PCI DSS 2030+ 推荐」最小值，不再支持 2048（虽然仍广泛使用，
	// 但作为新生成密钥的下限不再合适）。
	SSHAlgoRSA3072 SSHKeyAlgo = "rsa-3072"

	// SSHAlgoRSA4096 高安全等级场景，性能稍慢
	SSHAlgoRSA4096 SSHKeyAlgo = "rsa-4096"

	// SSHAlgoECDSAP256 NIST P-256 曲线 —— 多数硬件 token 原生支持
	SSHAlgoECDSAP256 SSHKeyAlgo = "ecdsa-p256"
)

// ErrUnknownAlgo 未知的算法标识
var ErrUnknownAlgo = errors.New("unknown SSH key algorithm")

// ---------------------------------------------------------------------------
// GeneratedKeyPair —— 返回给前端的结果
// ---------------------------------------------------------------------------

// GeneratedKeyPair 是 GenerateKeyPair 返回给前端的数据
//
// 字段 JSON tag 小写驼峰，与项目其它 IPC 一致。
//
// 注意：PrivateKeyPEM 是明文 —— 仅在前端 dialog 寿命内存在，用户保存后
// 走 CreateItem 加密入 vault。前端绝不能写 localStorage / 持久化。
type GeneratedKeyPair struct {
	// Algo 实际使用的算法（与入参一致，回显方便前端展示）
	Algo string `json:"algo"`

	// PrivateKeyPEM OpenSSH 格式私钥（"-----BEGIN OPENSSH PRIVATE KEY-----..."）
	PrivateKeyPEM string `json:"privateKeyPem"`

	// PublicKeyOpenSSH authorized_keys 一行（"ssh-ed25519 AAAA... comment"）
	PublicKeyOpenSSH string `json:"publicKeyOpenSsh"`

	// Fingerprint SHA256 指纹（与 ssh-keygen -lf 输出一致）
	Fingerprint string `json:"fingerprint"`
}

// ---------------------------------------------------------------------------
// GenerateKeyPair —— Wails 暴露的生成方法
// ---------------------------------------------------------------------------

// GenerateKeyPair 在内存中生成一对 SSH 密钥，返回给前端用于预填 dialog
//
// 参数：
//   - algo: 算法标识（SSHAlgoEd25519 等）。空字符串 → 默认 ed25519
//   - comment: 写入公钥末尾的注释（"user@host" 风格）。空 → 用 "zpass" 兜底
//
// 返回的私钥 PEM 已经是 OpenSSH 格式，可直接写到 ~/.ssh/id_ed25519 并被
// 系统 ssh 客户端读取。但实际流程是前端把它放进 vault item 的 private_key
// 字段。
//
// 错误：
//   - 算法非法 → ErrUnknownAlgo
//   - crypto/rand 失败（极罕见，系统熵池异常） → 包装后返错
//
// 安全：
//   - 全程在内存生成，不写盘
//   - rand.Reader 失败立即 abort，不退化
//   - 返回后调用者（Wails IPC）通过 JSON 传给前端 —— 这是「Wails 信任边界
//     内」的暴露，与「用户直接粘贴私钥」威胁等级一致
func (s *SshAgentService) GenerateKeyPair(algo string, comment string) (*GeneratedKeyPair, error) {
	chosen := SSHKeyAlgo(strings.TrimSpace(algo))
	if chosen == "" {
		chosen = SSHAlgoEd25519
	}

	// 标准化 comment —— 空字符串用品牌兜底，让生成的公钥不至于「裸 base64
	// 不带注释」，方便用户在 ~/.ssh/authorized_keys 之类的地方识别来源
	comment = strings.TrimSpace(comment)
	if comment == "" {
		comment = "zpass"
	}

	priv, pub, err := generateRawKey(chosen)
	if err != nil {
		return nil, err
	}

	// 序列化私钥为 OpenSSH 格式
	//
	// ssh.MarshalPrivateKey 接受任意标准库私钥类型（ed25519.PrivateKey /
	// *rsa.PrivateKey / *ecdsa.PrivateKey），输出未加密的 OpenSSH 私钥
	// PEM block。第二个参数 comment 会被嵌进 PEM 内部。
	pemBlock, err := ssh.MarshalPrivateKey(priv, comment)
	if err != nil {
		return nil, fmt.Errorf("marshal private key: %w", err)
	}
	privPEM := string(pem.EncodeToMemory(pemBlock))

	// 序列化公钥为 authorized_keys 一行
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, fmt.Errorf("derive ssh public key: %w", err)
	}

	// MarshalAuthorizedKey 输出 "ssh-ed25519 AAAA...\n"（带末尾换行）
	// 我们追加 comment 让格式与 ssh-keygen 一致："ssh-ed25519 AAAA... user@host"
	pubLine := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub)))
	pubLineWithComment := pubLine + " " + comment

	fingerprint := ssh.FingerprintSHA256(sshPub)

	s.logger.Info("ssh key pair generated",
		"algo", string(chosen),
		"fingerprint", fingerprint,
		"hasComment", comment != "zpass",
	)

	return &GeneratedKeyPair{
		Algo:             string(chosen),
		PrivateKeyPEM:    privPEM,
		PublicKeyOpenSSH: pubLineWithComment,
		Fingerprint:      fingerprint,
	}, nil
}

// generateRawKey 按算法生成裸私钥 + 对应公钥
//
// 返回类型是 `any` —— 上层 ssh.MarshalPrivateKey 接受 ed25519.PrivateKey /
// *rsa.PrivateKey / *ecdsa.PrivateKey 之一，靠类型断言分流。我们不在此
// 包装为接口让代码更直接。
//
// 不导出 —— 仅 GenerateKeyPair 内部使用。
func generateRawKey(algo SSHKeyAlgo) (priv any, pub any, err error) {
	switch algo {
	case SSHAlgoEd25519:
		pubKey, privKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, nil, fmt.Errorf("generate ed25519: %w", err)
		}
		return privKey, pubKey, nil

	case SSHAlgoRSA3072:
		key, err := rsa.GenerateKey(rand.Reader, 3072)
		if err != nil {
			return nil, nil, fmt.Errorf("generate rsa-3072: %w", err)
		}
		return key, &key.PublicKey, nil

	case SSHAlgoRSA4096:
		key, err := rsa.GenerateKey(rand.Reader, 4096)
		if err != nil {
			return nil, nil, fmt.Errorf("generate rsa-4096: %w", err)
		}
		return key, &key.PublicKey, nil

	case SSHAlgoECDSAP256:
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, nil, fmt.Errorf("generate ecdsa-p256: %w", err)
		}
		return key, &key.PublicKey, nil

	default:
		return nil, nil, fmt.Errorf("%w: %q", ErrUnknownAlgo, algo)
	}
}

// SupportedSSHAlgos 返回前端可选的算法列表
//
// 顺序即推荐顺序：默认 ed25519 在第一个。前端的 <select> 用此列表渲染。
func (s *SshAgentService) SupportedSSHAlgos() []string {
	return []string{
		string(SSHAlgoEd25519),
		string(SSHAlgoRSA3072),
		string(SSHAlgoRSA4096),
		string(SSHAlgoECDSAP256),
	}
}
