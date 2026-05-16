// zpass-agent 守护进程 —— SSH agent 协议实现
//
// ---------------------------------------------------------------------------
// 本文件职责
//
// 实现 golang.org/x/crypto/ssh/agent.ExtendedAgent 接口（只读子集），
// 让 SSH agent listener 通过 agent.ServeAgent(conn, ourAgent) 把每个
// 进来的连接 dispatch 到本文件的方法上。
//
// **协议核心是只读的**：
//
//	List              ✓ 实现：返回 AgentState.ListKeys 的快照
//	Sign / SignWithFlags ✓ 实现：路由到 AgentState.RequestSign（转发 GUI）
//	Signers           ✓ 实现：返回空 + ErrReadOnly（不暴露 in-process signer）
//	Add               ✗ 实现：返回 ErrReadOnly（攻击者不能往 agent 塞 key）
//	Remove / RemoveAll ✗ 实现：返回 ErrReadOnly
//	Lock / Unlock     ✗ 实现：返回 ErrReadOnly（vault 解锁靠 ZPass GUI）
//	Extension         ✗ 实现：返回 ErrExtensionUnsupported
//
// 这套「只读 agent」的安全收益（参见 sshagent 方案文档 §0 ~ §7）：
//   - 即便 agent 进程被攻破，攻击者最多看到公钥列表 + 触发 sign 请求
//     （会被 GUI 用户确认窗拦下来）
//   - 攻击者无法把自己的恶意 key 临时塞进 agent 借此通过 ssh 认证
//   - 「锁定 agent」语义被 vault 锁定吸收，避免双重状态混乱
//
// ---------------------------------------------------------------------------
// 关键 API 取舍：实现 ExtendedAgent 还是 Agent
//
// golang.org/x/crypto/ssh/agent 包暴露两个 interface：
//
//	Agent          基础（List / Sign / Add / Remove / RemoveAll / Lock /
//	               Unlock / Signers）—— SSH agent protocol RFC 草案直接对应
//	ExtendedAgent  扩展（Agent 之上加 SignWithFlags / Extension）
//
// `agent.ServeAgent(agentImpl, conn)` 接受 Agent，会自动检测 agentImpl
// 是否同时实现 ExtendedAgent 并用扩展能力。
//
// 我们实现 ExtendedAgent：
//   - SignWithFlags 是 git commit signing / 新版 OpenSSH 客户端要的，
//     不实现会让 rsa-sha2-256 / rsa-sha2-512 全部退化为 SHA-1 失败
//   - Extension 即便返回 unsupported，实现也只多一行
//
// ---------------------------------------------------------------------------
// 关键 API 取舍：sign 路径的 ctx
//
// agent.Sign 的签名没有 context.Context 参数（设计于 ctx 普及之前）。
// 我们内部用 context.WithTimeout 把 signDeadline 转成 ctx 传给
// AgentState.RequestSign —— 这样将来如果 ssh/agent 改 API 引入 ctx，
// 顶替为传入 ctx 只需要改一行。

package main

import (
	"context"
	b64 "encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// b64StdEncoding 是包内共享的 base64 编解码器
//
// 抽出一个变量是为了避免每次都写 base64.StdEncoding.EncodeToString，
// 同时让 import 块短一些（state.go 中 base64Encode 也复用此变量）。
// 用 StdEncoding 而非 URLEncoding：JSON 协议层无 URL 上下文，StdEncoding
// 输出更短（不替换 / 和 + 为 _ 和 -）。
var b64StdEncoding = b64.StdEncoding

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

// ErrReadOnly 所有写操作（Add / Remove / Lock 等）的统一返回错误
//
// 错误信息刻意不携带具体原因细节 —— 哪个方法被调用都返回同一错误，
// 减少给攻击者的侧信道。
var ErrReadOnly = errors.New("zpass-agent: agent is read-only; manage keys in ZPass GUI")

// ErrExtensionUnsupported Extension RPC 返回的错误
//
// SSH agent protocol 的扩展机制允许厂商定义私有 op（如 query session-bind）。
// 我们不支持任何扩展，统一返回此错误。
var ErrExtensionUnsupported = errors.New("zpass-agent: agent extensions are not supported")

// ---------------------------------------------------------------------------
// zpassAgent —— ExtendedAgent 实现
// ---------------------------------------------------------------------------

// zpassAgent 实现 golang.org/x/crypto/ssh/agent.ExtendedAgent
//
// 字段：
//   - state：共享的 AgentState 指针，承载公钥索引 + GUI 状态 + pending 注册表
//   - logger：结构化日志器，记录每次 Sign 调用的 fingerprint + 客户端 metadata
//   - peerResolver：从连接拿到客户端 PID / exe / exe SHA256 的回调
//     （build-tag 分平台实现，见 peer_*.go）
//
// peerResolver 用 closure 注入而非接口：每次 Sign 都会调用一次，结构简单
// 一个函数指针够用。每个连接的 resolver 由 listener 在 accept 时绑定 ——
// 因为 net.Conn 接口不携带操作系统级 peer 信息，必须在拿到具体 *net.UnixConn
// 或 winio.PipeConn 时通过 syscall 提取，listener 是最合适的注入点。
type zpassAgent struct {
	state        *AgentState
	logger       *slog.Logger
	peerResolver func() (peerInfo, error)
}

// peerInfo 是对端 SSH 客户端的进程级标识
//
// 字段都是「best-effort」—— 取不到时用零值，不视为错误。
// GUI 端拿到 zero ClientPID 时弹窗显示「未知进程」。
type peerInfo struct {
	PID     int32
	Exe     string
	ExeHash string // exe 文件的 SHA256 hex
}

// newZPassAgent 构造一个 zpassAgent 实例
//
// peerResolver 由调用方在 accept 单连接时绑定。MVP 阶段实现可能直接返回
// peerInfo{}（不识别进程），换 UX 上的「未知进程」展示。
func newZPassAgent(state *AgentState, logger *slog.Logger, peerResolver func() (peerInfo, error)) *zpassAgent {
	if peerResolver == nil {
		peerResolver = func() (peerInfo, error) { return peerInfo{}, nil }
	}
	return &zpassAgent{
		state:        state,
		logger:       logger,
		peerResolver: peerResolver,
	}
}

// ---------------------------------------------------------------------------
// 只读方法 —— 实现实质功能
// ---------------------------------------------------------------------------

// List 返回 agent 中所有公钥
//
// SSH agent protocol 11 (SSH_AGENTC_REQUEST_IDENTITIES)。
//
// 返回值的 ssh.PublicKey 是 wire format 的字节 + 类型 metadata；ssh/agent
// 包会序列化为 SSH_AGENT_IDENTITIES_ANSWER 帧（消息 12）发回客户端。
//
// 不需要等 GUI 也不需要 vault 解锁 —— 公钥是公开信息，agent 一启动就能
// 提供（哪怕列表为空）。这是「fast list」对 git / IDE 自动刷新身份列表的
// 性能保证。
//
// 实现注意：sshagentproto.PublicKeyEntry.PublicKey 是 authorized_keys
// 一行的 base64 字节，需要先解码再交给 ssh.ParseAuthorizedKey；后者
// 把字符串重新做整行解析（含算法前缀 / base64 / comment）。
func (a *zpassAgent) List() ([]*agent.Key, error) {
	entries := a.state.ListKeys()
	out := make([]*agent.Key, 0, len(entries))

	for _, e := range entries {
		// 解码 entry.PublicKey 拿到 authorized_keys 一行
		// GUI 推送时是「base64(整行 ASCII)」格式
		line, err := b64StdEncoding.DecodeString(e.PublicKey)
		if err != nil {
			// 单条 entry 损坏不该让整个 List 失败 —— 跳过 + log
			a.logger.Warn("List: skip malformed entry",
				"fingerprint", e.Fingerprint, "err", err)
			continue
		}
		pub, _, _, _, err := ssh.ParseAuthorizedKey(line)
		if err != nil {
			a.logger.Warn("List: skip unparseable key",
				"fingerprint", e.Fingerprint, "err", err)
			continue
		}
		out = append(out, &agent.Key{
			Format:  pub.Type(),
			Blob:    pub.Marshal(),
			Comment: e.Comment,
		})
	}

	a.logger.Debug("List", "count", len(out))
	return out, nil
}

// Sign 用指定公钥签名 data，等价于 SignWithFlags(key, data, 0)
//
// SSH agent protocol 13 (SSH_AGENTC_SIGN_REQUEST)。
//
// 老版本 SSH 客户端走这条路径（SHA-1 签名）。新版本会走 SignWithFlags
// 携带 algorithm preference。
func (a *zpassAgent) Sign(key ssh.PublicKey, data []byte) (*ssh.Signature, error) {
	return a.SignWithFlags(key, data, 0)
}

// SignWithFlags 用指定公钥签名 data，flags 携带算法偏好
//
// flags 取值（来自 ssh/agent 包）：
//   - 0                        老 SSH-1 协议 / 默认（RSA → SHA-1）
//   - SignatureFlagRsaSha256   要求用 rsa-sha2-256
//   - SignatureFlagRsaSha512   要求用 rsa-sha2-512
//
// 我们把 flags 原样传给 GUI，让 GUI 调 ssh.AlgorithmSigner.SignWithAlgorithm
// 完成具体签名。
//
// 流程：
//  1. 把 ssh.PublicKey 转成 fingerprint 字符串（同 GUI 推送时的格式）
//  2. 解析 peer 信息（PID / exe / exe SHA256）
//  3. 用 ctx + signDeadline 调 state.RequestSign 阻塞等结果
//  4. 把 SignResult 转成 ssh.Signature 返回
func (a *zpassAgent) SignWithFlags(key ssh.PublicKey, data []byte, flags agent.SignatureFlags) (*ssh.Signature, error) {
	fingerprint := ssh.FingerprintSHA256(key)

	peer, err := a.peerResolver()
	if err != nil {
		// peer 信息获取失败不是致命错误，UX 退化为「未知进程」继续走
		a.logger.Warn("SignWithFlags: resolve peer failed", "err", err)
		peer = peerInfo{}
	}

	a.logger.Info("SignWithFlags begin",
		"fingerprint", fingerprint,
		"flags", uint32(flags),
		"clientPid", peer.PID,
		"clientExe", peer.Exe,
	)

	// RequestSign 内部有自己的 signDeadline 兜底超时；这里再加一层 ctx
	// 不会冲突 —— select 拿先到的事件。ctx 主要给将来 ssh/agent 引入
	// ctx 参数时方便接入。
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	result, err := a.state.RequestSign(
		ctx,
		fingerprint,
		data,
		uint32(flags),
		peer.PID,
		peer.Exe,
		peer.ExeHash,
	)
	if err != nil {
		a.logger.Warn("SignWithFlags failed",
			"fingerprint", fingerprint, "err", err)
		return nil, fmt.Errorf("zpass-agent sign: %w", err)
	}
	if result.Err != nil {
		a.logger.Warn("SignWithFlags rejected",
			"fingerprint", fingerprint, "err", result.Err)
		return nil, fmt.Errorf("zpass-agent sign: %w", result.Err)
	}

	a.logger.Info("SignWithFlags ok",
		"fingerprint", fingerprint,
		"format", result.SignatureFormat,
		"signatureLen", len(result.Signature),
	)

	return &ssh.Signature{
		Format: result.SignatureFormat,
		Blob:   result.Signature,
	}, nil
}

// ---------------------------------------------------------------------------
// 只读 agent —— 写操作全部拒绝
// ---------------------------------------------------------------------------

// Add 拒绝向 agent 添加 key
//
// 安全收益：攻击者即便 connect 上 SSH agent socket 也不能注入 key 借此
// 通过 ssh 认证。所有 key 管理走 ZPass GUI，受 vault 主密码保护。
func (a *zpassAgent) Add(key agent.AddedKey) error {
	a.logger.Warn("Add rejected (read-only agent)", "comment", key.Comment)
	_ = key
	return ErrReadOnly
}

// Remove 拒绝从 agent 移除 key
//
// 同 Add：所有变更走 GUI。让 ssh-add -d 报错让用户去 GUI 操作。
func (a *zpassAgent) Remove(key ssh.PublicKey) error {
	a.logger.Warn("Remove rejected (read-only agent)")
	_ = key
	return ErrReadOnly
}

// RemoveAll 拒绝清空 agent
//
// 同 Remove。
func (a *zpassAgent) RemoveAll() error {
	a.logger.Warn("RemoveAll rejected (read-only agent)")
	return ErrReadOnly
}

// Lock 拒绝「锁定 agent」操作
//
// SSH agent protocol 的 Lock = 给 agent 加 passphrase 让任何后续操作都
// 失败直到 Unlock。我们不实现这个状态机 —— vault 解锁状态由 GUI 全权管理，
// 双重状态机会让 UX 混乱（「我已经在 GUI 锁了 vault，为什么 ssh-add 还要
// 再输入 lock passphrase？」）。
func (a *zpassAgent) Lock(passphrase []byte) error {
	a.logger.Warn("Lock rejected (managed by ZPass vault)")
	// 立刻清零 passphrase —— 即便我们不用，也不让它在内存里飘
	for i := range passphrase {
		passphrase[i] = 0
	}
	return ErrReadOnly
}

// Unlock 拒绝「解锁 agent」操作
//
// 见 Lock 的注释。
func (a *zpassAgent) Unlock(passphrase []byte) error {
	a.logger.Warn("Unlock rejected (managed by ZPass vault)")
	for i := range passphrase {
		passphrase[i] = 0
	}
	return ErrReadOnly
}

// Signers 拒绝暴露 in-process signer
//
// agent.NewClient 的某些代码路径会调 Signers() 拿到能直接用的 ssh.Signer
// 列表（绕过 agent 协议）。我们没有 in-process signer（私钥在 GUI 进程），
// 返回空 + 错误。
func (a *zpassAgent) Signers() ([]ssh.Signer, error) {
	a.logger.Debug("Signers rejected (read-only agent has no in-process signers)")
	return nil, ErrReadOnly
}

// Extension 拒绝扩展 RPC
//
// SSH agent extension（session-bind / query / hostkeys-00@openssh.com 等）
// 我们一概不支持 —— ssh / git 不依赖任何扩展，禁用是更小攻击面的选择。
//
// 注意返回 agent.ErrExtensionUnsupported 而非自定义错误 —— ssh/agent 包
// 用这个 sentinel 决定要不要给客户端发 SSH_AGENT_FAILURE。返回别的错误
// 会让协议层混乱。
func (a *zpassAgent) Extension(extensionType string, contents []byte) ([]byte, error) {
	a.logger.Debug("Extension rejected", "type", extensionType)
	_ = contents
	return nil, agent.ErrExtensionUnsupported
}
