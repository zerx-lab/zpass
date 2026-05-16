// Package sshagentproto 定义 zpass-agent 守护进程与 ZPass GUI 之间的
// 控制通道协议。
//
// ---------------------------------------------------------------------------
// 为什么需要单独一个包
//
// SSH agent 功能采用「双进程架构」：
//
//	┌──────────────────────┐  SSH agent protocol  ┌──────────┐
//	│  zpass-agent (常驻)   │ ◄──────────────────► │ ssh/git  │
//	└──────────┬───────────┘                      └──────────┘
//	           │ 本协议（控制通道）
//	           ▼
//	┌──────────────────────┐
//	│  ZPass GUI (Wails)   │  持有 DEK，弹确认窗，做 sign
//	└──────────────────────┘
//
// `cmd/zpass-agent/` 编译为独立 binary，而 `zpass-desktop` GUI 是另一个
// `package main`。两个进程必须用「位对位完全一致」的消息结构序列化通讯，
// 任何字段顺序、名字、类型不同步都会立即破坏端到端通路。
//
// 把协议放在 `internal/sshagentproto/` 解决两件事：
//
//  1. **类型只定义一次** —— 编译期就能发现两端不同步（一边改字段，另一边
//     不会再编译过）。这是单纯把 JSON 形状写在文档里做不到的保证。
//  2. **internal/ 路径保护** —— Go 工具链强制只允许 `github.com/zerx-lab/
//     zpass/zpass-desktop/...` 下的包 import 本包，杜绝第三方误用。
//
// ---------------------------------------------------------------------------
// 协议设计要点
//
// 选用 **length-prefixed JSON**：
//
//	┌────────────────────────────────────────────────────────────┐
//	│  4-byte big-endian length (uint32) │ JSON payload (length 字节) │
//	└────────────────────────────────────────────────────────────┘
//
//	- JSON：调试友好（tcpdump / socat 直接看得懂），跨语言后续若要重写
//	  agent 为 Rust / Zig 也不会被 protobuf / msgpack 绑死。
//	- length 前缀：本协议是字节流（unix socket / named pipe），必须显式
//	  消息边界。用 4 字节 uint32 = 最大单消息 4 GiB —— 远超实际需要，但
//	  仍给上限校验留出空间（MaxFrameBytes 兜底拒绝异常大帧防 DoS）。
//	- big-endian：与 SSH agent protocol（RFC 4251）一致的网络字节序，
//	  习惯成自然。
//
// 选用 **discriminated union by `op` 字段**：
//
//	{"op":"sign_request","reqId":17,"fingerprint":"SHA256:...","data":"..."}
//
//	Envelope 结构持有所有可能字段，类型零值 = 该消息不携带。这种"宽表"
//	风格在小协议下比"每个 op 一个 interface 实现"心智负担更轻，缺点是
//	类型安全靠运行时校验 —— ValidateForOp 函数集中处理。
//
// ---------------------------------------------------------------------------
// 版本兼容策略
//
// `HELLO` 消息携带 ProtocolVersion 整数。当前协议版本 = 1。
//
//   - 升级新字段（只加不改）：版本号不变，旧端口忽略未知字段（json 解码
//     默认行为）。
//   - 升级语义破坏（必须改）：版本号 +1，HelloAck 时两端取 min(ours, theirs)
//     若不在双方支持范围内则关闭连接，前端弹「请升级 / 降级 agent」提示。
//
// 不要往 op 字符串里塞版本号（"sign_request_v2"），那样会让代码处处
// switch case，远不如版本字段干净。
//
// ---------------------------------------------------------------------------
// 鉴权（capability token）
//
// 控制通道虽然有 unix socket / named pipe 的 ACL 保护（限当前 OS 用户），
// 但同一 user 下别的进程依然能 connect 上来冒充 GUI。所以 HELLO 阶段
// 用一个共享 secret 做 HMAC 挑战应答：
//
//  1. GUI 第一次启动时生成 32 字节随机 token，写到
//     `~/.config/zpass/agent.cap`（0600，仅当前用户可读）。
//  2. zpass-agent 启动时也读这个文件 —— 如果不存在，等 GUI 起来推。
//  3. 任一端 connect/accept 时发 HELLO 带 nonce(16B)，对端用
//     HMAC-SHA256(token, nonce) 应答 HELLO_ACK，本端校验通过才视为
//     可信对端，继续后续消息处理。
//  4. 同一 token 不被任何消息明文传输，永远只走 HMAC 派生。
//
// 这等价于「两个进程共享同一个 OS 用户的 secret」，威胁模型与 vault.db
// 文件权限保护一致。
package sshagentproto

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// ProtocolVersion 是当前控制通道协议版本号
//
// 任何破坏性修改（删字段、改字段语义、改 op 集合）必须 +1 并在
// CompatibleRange 里调整兼容范围。仅新增可选字段不算破坏。
const ProtocolVersion uint32 = 1

// MinSupportedVersion / MaxSupportedVersion 描述本端能识别的协议版本范围
//
// HelloAck 阶段双方各自报告这两个区间，取交集；如果交集为空则关闭连接，
// agent 退出 + GUI 提示「请重新安装让两端版本一致」。
const (
	MinSupportedVersion uint32 = 1
	MaxSupportedVersion uint32 = 1
)

// MaxFrameBytes 是单个 length-prefixed 消息的字节上限
//
// 防御内存炸弹：恶意端发个长度 = 2^32-1 的帧，本端会试图 alloc 4GiB 缓冲。
// 4 MiB 远超任何合理消息（签名 data 最大 ~32KB，公钥列表上千条也撑不到
// 几百 KB），同时小到拒绝异常请求时不会触发 OOM。
const MaxFrameBytes uint32 = 4 * 1024 * 1024

// CapabilityTokenSize 是 ~/.config/zpass/agent.cap 文件中 token 的字节长度
//
// 32 字节 = 256 bit 熵，远超暴力枚举可行性。生成走 crypto/rand。
const CapabilityTokenSize = 32

// HelloNonceSize 是 HELLO 阶段挑战应答的 nonce 字节长度
//
// 16 字节 = 128 bit，避免 nonce 复用导致重放攻击的可能性极低
// （生日界 2^64 次握手才有碰撞概率）。
const HelloNonceSize = 16

// CapabilityFilename 是 GUI 写入 / agent 读取的 token 文件名（在
// ~/.config/zpass/ 下）。常量在这里定义而非 paths.go 是为了让协议契约
// 自包含 —— 同一个文件名既是协议的一部分（双方读同一文件）也是路径解析
// 的一部分，把它绑在协议包里更清晰。
const CapabilityFilename = "agent.cap"

// ---------------------------------------------------------------------------
// 消息类型（op 枚举）
// ---------------------------------------------------------------------------

// Op 是 Envelope.Op 字段的取值类型
//
// 用独立的 string 类型而非裸 string，可以让 IDE / 编译器在 switch case
// 漏掉某个 op 时给出 exhaustiveness 警告（配合 golangci-lint 的 exhaustive
// linter）。
type Op string

// 控制通道支持的所有消息类型
//
// 命名约定：
//   - 由 GUI 主动发起的消息无后缀（"push_keys"、"state"、"sign_reply"）
//   - 由 agent 主动发起的消息无后缀（"sign_request"、"ping"）
//   - 双向握手用 _ack 后缀（"hello_ack"）
//
// 不用 iota 整数枚举：JSON 文本协议下整数 op 调试时还要查表，字符串可读性
// 收益远大于几字节带宽。
const (
	// OpHello 双向握手第一帧。任意一端 accept/connect 成功后立即发送。
	// 字段：ProtocolVersion / MinVersion / MaxVersion / Nonce / Role
	OpHello Op = "hello"

	// OpHelloAck 对 Hello 的应答。携带本端对 nonce 的 HMAC，以及本端
	// 接受的协议版本号。
	// 字段：AgreedVersion / NonceHMAC
	OpHelloAck Op = "hello_ack"

	// OpPushKeys GUI → agent：全量替换 agent 的内存公钥索引
	//
	// 在以下时机推送：
	//  1. GUI 解锁后第一次连上 agent
	//  2. 用户在 GUI 里 CRUD 了 ssh 类型条目（vault 变更事件）
	//  3. agent 主动 PING 询问最新状态时（容错路径，正常不需要）
	//
	// 全量替换而不是增量同步是刻意选择 —— SSH key 通常 < 100 把，全量
	// JSON 几 KB，逻辑简单，避免增量协议的去重 / 排序 / 一致性问题。
	OpPushKeys Op = "push_keys"

	// OpState GUI → agent：通知 vault 解锁状态变化
	//
	// agent 在 Locked 状态下对 sign_request 一律返回 SSH_AGENT_FAILURE，
	// 不再转发给 GUI（避免每次签名都唤醒 GUI 弹窗）。但 List 仍可工作 ——
	// agent 缓存的是公钥（公开信息），不依赖 DEK。
	//
	// 字段：Unlocked
	OpState Op = "state"

	// OpSignRequest agent → GUI：转发 SSH_AGENTC_SIGN_REQUEST
	//
	// 字段：ReqID / Fingerprint / Data / Flags / ClientPID / ClientExe /
	//      ClientExeHash
	//
	// Data 是 SSH 客户端要求签名的原始字节（认证消息 / commit hash 等），
	// 必须原样传给 ssh.Signer。注意：data 可能含敏感信息（commit 摘要），
	// 审计日志不应记录其内容，只记 fingerprint + 客户端 metadata。
	OpSignRequest Op = "sign_request"

	// OpSignReply GUI → agent：返回签名结果
	//
	// 字段：ReqID（与 SignRequest 对应）/ Signature 或 Error
	//
	// 用户拒绝 / 超时 / 解锁失败 / 私钥不可用都走 Error 分支，agent 转
	// SSH_AGENT_FAILURE 给客户端。
	OpSignReply Op = "sign_reply"

	// OpGoodbye 任一端主动断开前的告别消息。可选 —— TCP 半关闭也能达到
	// 同样效果，但 Goodbye 让对端能拿到「为什么断开」用于诊断 / 日志。
	OpGoodbye Op = "goodbye"

	// OpPing / OpPong 心跳，30 秒一次。
	//
	// 不靠 TCP keepalive 是因为 unix socket 上 keepalive 默认关闭，
	// Windows named pipe 也没有等价机制。心跳是检测「另一端进程已死但
	// socket fd 还在」的唯一可靠方法。
	OpPing Op = "ping"
	OpPong Op = "pong"
)

// Role 标识 Envelope 来源（hello 阶段使用）
type Role string

const (
	// RoleGUI 表示发送方是 ZPass 桌面应用
	RoleGUI Role = "gui"
	// RoleAgent 表示发送方是 zpass-agent 守护进程
	RoleAgent Role = "agent"
)

// ---------------------------------------------------------------------------
// Envelope —— 所有控制通道消息的载体
// ---------------------------------------------------------------------------

// Envelope 是控制通道上传输的统一消息结构
//
// 设计成「宽字段并集」而非每个 op 一个独立 struct 的取舍：
//
//	优点：
//	  - 编解码只走 json.Marshal/Unmarshal 一次，无需 type switch
//	  - 序列化器可以共用一对函数（WriteFrame/ReadFrame），调用方零样板
//	  - 新增 op 只需要往 Envelope 加字段 + 在 Op 常量集添加
//
//	缺点：
//	  - 类型不安全：sign_request 不应该带 Unlocked 字段，但 struct 允许
//	  - 字段数量随 op 数增长，envelope 变胖
//
// 缓解：ValidateForOp() 集中做"op X 必须 / 不许携带哪些字段"的检查，
// 在 ReadFrame 之后调用。任何端发非法组合 → 立即关闭连接 + log。
//
// JSON tag 全部使用小写驼峰，与 ZPass 项目内其它 IPC 消息（VaultService
// 返回给前端的 JSON）风格一致。带 `,omitempty` 的字段在零值时不出现在
// 线上，省带宽 + 看 dump 时一目了然。
type Envelope struct {
	// Op 消息类型，决定其它字段的语义。必填。
	Op Op `json:"op"`

	// --- HELLO / HELLO_ACK 字段 ---

	// ProtocolVersion 发送方当前协议版本（仅 hello / hello_ack）
	ProtocolVersion uint32 `json:"protocolVersion,omitempty"`

	// MinVersion / MaxVersion 发送方接受的协议版本范围（仅 hello）
	MinVersion uint32 `json:"minVersion,omitempty"`
	MaxVersion uint32 `json:"maxVersion,omitempty"`

	// AgreedVersion hello_ack 中本端接受的协商版本（取 min(ours.Max, theirs.Max)
	// 且 >= max(ours.Min, theirs.Min)）
	AgreedVersion uint32 `json:"agreedVersion,omitempty"`

	// Role 发送方身份（仅 hello）—— 防止两个 GUI / 两个 agent 误握手
	Role Role `json:"role,omitempty"`

	// Nonce 16 字节随机挑战（hello 阶段），hex 编码
	Nonce string `json:"nonce,omitempty"`

	// NonceHMAC hello_ack 中对收到 nonce 的 HMAC-SHA256，hex 编码
	NonceHMAC string `json:"nonceHmac,omitempty"`

	// --- PUSH_KEYS 字段 ---

	// Keys 全量公钥索引（仅 push_keys）。agent 收到后整体替换内存索引。
	Keys []PublicKeyEntry `json:"keys,omitempty"`

	// --- STATE 字段 ---

	// Unlocked vault 是否已解锁（仅 state）
	Unlocked bool `json:"unlocked,omitempty"`

	// --- SIGN_REQUEST 字段 ---

	// ReqID 是 agent 为每次 sign 分配的序列号（同时用于 SignReply 关联）
	// uint64 单调递增，重启后归零 —— 因为只在单次连接内有效，无需持久化。
	ReqID uint64 `json:"reqId,omitempty"`

	// Fingerprint 形如 "SHA256:Ux9..."，标识要用哪把 key 签名。
	// agent 拿到 SignRequest 后用 ssh.FingerprintSHA256(pubkey) 算出，
	// GUI 用 fingerprint 反查 vault item ID。
	Fingerprint string `json:"fingerprint,omitempty"`

	// Data SSH 客户端要求签名的原始字节，base64 编码
	//
	// 为什么 base64 而非 hex：data 经常较长（几百到几千字节），base64
	// 比 hex 省 33% 带宽。JSON 标准没有 binary 类型，必须 ASCII 化。
	Data string `json:"data,omitempty"`

	// Flags SSH agent protocol 的 SignatureFlags（决定 RSA 用 SHA-1 / SHA-256
	// / SHA-512 等）。透传给 ssh.AlgorithmSigner.SignWithAlgorithm。
	Flags uint32 `json:"flags,omitempty"`

	// ClientPID 对端 SSH 客户端的进程 ID（agent 通过 SO_PEERCRED 等拿到）
	// 0 = 未能识别（不视为错误，只是 UX 退化为"某进程"）
	ClientPID int32 `json:"clientPid,omitempty"`

	// ClientExe 对端可执行文件的绝对路径（如 /usr/bin/ssh、C:\Program Files\Git\...）
	ClientExe string `json:"clientExe,omitempty"`

	// ClientExeHash 对端可执行文件的 SHA256 哈希（hex），用于 GUI 端
	// 「同 exe 5 分钟信任」cache 的 key —— 比 PID 复用安全。
	// 计算可能耗时（exe 几十 MB 时），agent 端按需缓存。
	ClientExeHash string `json:"clientExeHash,omitempty"`

	// --- SIGN_REPLY 字段 ---

	// Signature SSH wire format 的签名（[]byte），base64 编码
	// 与 Data 字段一样用 base64 是为了 JSON 兼容性。
	Signature string `json:"signature,omitempty"`

	// SignatureFormat 签名算法标识，例如 "ssh-ed25519" / "rsa-sha2-256"
	// 客户端在解析 Signature 时需要这个 hint。
	SignatureFormat string `json:"signatureFormat,omitempty"`

	// --- 通用错误字段 ---

	// Error 简要错误描述，所有可能失败的 op 都可用。
	//
	// 错误内容必须是「对 UI 友好的人类可读字符串」而非内部诊断信息 ——
	// 比如「user declined」/「vault is locked」/「key not found」，
	// 不要带文件路径、进程号等可能泄露的元数据。
	Error string `json:"error,omitempty"`

	// --- GOODBYE 字段 ---

	// Reason 主动断开的原因（仅 goodbye），如 "shutdown" / "version mismatch"
	Reason string `json:"reason,omitempty"`
}

// PublicKeyEntry 是 PushKeys 消息中携带的单条公钥条目
//
// 注意：故意不包含 PrivateKey / vault Item 的明文字段。agent 进程不持有
// 任何「能解密私钥」的东西 —— 这是双进程安全模型的核心约束。私钥只在
// GUI 收到 SignRequest 时解密、签名、立即丢弃。
type PublicKeyEntry struct {
	// Fingerprint 形如 "SHA256:Ux9..."，主键，agent 用此查找 entry
	Fingerprint string `json:"fingerprint"`

	// PublicKey SSH wire format 公钥（authorized_keys 一行的字节），
	// base64 编码（不是 base64 中已嵌的 base64，是真整行字节的 base64）。
	//
	// agent 收到后用 ssh.ParseAuthorizedKey 解析，再用 .Marshal() 得到
	// SSH wire format 字节返回给 ssh/git。
	PublicKey string `json:"publicKey"`

	// Comment 公钥末尾的注释（OpenSSH 格式：算法 base64 comment）
	// 例如 "alex@ZPass-MBP"，作为 SSH agent List 响应的 Comment 字段
	Comment string `json:"comment"`

	// ItemID vault 中对应条目的 ID，仅给 GUI 自己用
	//
	// 严格来说 agent 进程不需要这个字段 —— SignRequest 转发给 GUI 时只
	// 带 Fingerprint，GUI 用 fingerprint 查 ItemID。但 agent 缓存里保留
	// ItemID 让审计日志能记录「哪把 key 被签名」更直观，不依赖 GUI
	// 实时映射。
	ItemID string `json:"itemId"`

	// RequireConfirm 是否每次签名都强制弹确认窗（绕过信任 cache）
	//
	// 由用户在 GUI 设置页针对单把 key 配置。生产环境密钥（aws-prod）
	// 应当强制每次确认，开发环境密钥（local-dev）可以走信任 cache。
	RequireConfirm bool `json:"requireConfirm"`
}

// ---------------------------------------------------------------------------
// 帧编解码：length-prefixed JSON
// ---------------------------------------------------------------------------

// ErrFrameTooLarge 表示收到的 length 前缀超过 MaxFrameBytes
//
// 调用方应该立即关闭连接（不要试图 drain bytes）—— 这通常是协议错位
// 或恶意端口探测，继续读毫无意义。
var ErrFrameTooLarge = errors.New("sshagentproto: frame exceeds max size")

// ErrShortRead 表示连接在帧未完整读完前 EOF
//
// 区别于 io.EOF：io.EOF 在「整齐断开」（length 都没读到）时返回，
// ErrShortRead 在「读了 length 但 payload 不够」时返回 —— 后者意味着
// 对端协议层出问题。两种情况调用方都应关闭连接。
var ErrShortRead = errors.New("sshagentproto: short read")

// WriteFrame 序列化 envelope 并按 length-prefix 协议写到 w
//
// 写入是原子的从 caller 视角看 —— 要么完整成功，要么返回 error（部分
// 写入由 io.Writer 实现的故障语义决定，调用方应在 error 后关闭连接）。
//
// 输出格式：
//
//	┌──────────────────────────────────────────┐
//	│ 4-byte BE length │ JSON bytes (length 字节) │
//	└──────────────────────────────────────────┘
//
// 不在内部加 Flush —— 调用方负责 buffered writer 的 flush 时机
// （多数情况下直接传 net.Conn，写入即立即落到内核 socket buffer）。
func WriteFrame(w io.Writer, env *Envelope) error {
	if env == nil {
		return errors.New("sshagentproto: nil envelope")
	}
	if env.Op == "" {
		return errors.New("sshagentproto: envelope.Op cannot be empty")
	}

	payload, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("sshagentproto: marshal envelope: %w", err)
	}
	if uint32(len(payload)) > MaxFrameBytes {
		return fmt.Errorf("sshagentproto: outbound frame too large: %d bytes (max %d)",
			len(payload), MaxFrameBytes)
	}

	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))

	// 两次 Write 之间不能有任何 yield，让对端要么看到完整长度 + payload
	// 要么 connection reset；同一 goroutine 内的 syscall 已经是顺序的。
	if _, err := w.Write(header[:]); err != nil {
		return fmt.Errorf("sshagentproto: write length: %w", err)
	}
	if _, err := w.Write(payload); err != nil {
		return fmt.Errorf("sshagentproto: write payload: %w", err)
	}
	return nil
}

// ReadFrame 从 r 读取一个完整的 length-prefixed 帧并反序列化为 Envelope
//
// 错误返回值：
//   - io.EOF：连接整齐断开（length 都没读到），调用方按正常结束处理
//   - ErrShortRead：连接中断在帧内，对端协议有问题
//   - ErrFrameTooLarge：length 超过 MaxFrameBytes，立即关闭连接
//   - 其它 error：JSON 解析失败 / 网络错误
//
// io.ReadFull 用于一次性读满 N 字节 —— 内部循环 Read 直到拿够 / EOF /
// error，比手写 for 循环更不易出错。
func ReadFrame(r io.Reader) (*Envelope, error) {
	var header [4]byte
	_, err := io.ReadFull(r, header[:])
	if err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			// 读了 1-3 字节后 EOF —— 这是协议错位，明确返回 ShortRead 而非 EOF
			return nil, ErrShortRead
		}
		// 包括 io.EOF（整齐断开）和真实 IO 错误，原样上抛让调用方区分
		return nil, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 {
		// 0 字节 payload 不合法（即使 op 字段也至少要几个字节 JSON）
		return nil, errors.New("sshagentproto: zero-length frame")
	}
	if length > MaxFrameBytes {
		return nil, fmt.Errorf("%w: %d bytes", ErrFrameTooLarge, length)
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
			return nil, ErrShortRead
		}
		return nil, fmt.Errorf("sshagentproto: read payload: %w", err)
	}

	var env Envelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil, fmt.Errorf("sshagentproto: unmarshal envelope: %w", err)
	}
	if env.Op == "" {
		return nil, errors.New("sshagentproto: missing op in envelope")
	}
	return &env, nil
}

// ---------------------------------------------------------------------------
// 字段级校验
// ---------------------------------------------------------------------------

// ValidateForOp 检查 envelope 字段组合对其 Op 是否合法
//
// 「宽 struct」设计的代价是类型不安全，这里集中弥补 —— 在 ReadFrame
// 之后调用，发现非法立即关连接。调用方典型用法：
//
//	env, err := sshagentproto.ReadFrame(conn)
//	if err != nil { ... }
//	if err := env.ValidateForOp(); err != nil {
//	    log.Error("malformed envelope: %v", err)
//	    conn.Close()
//	    return
//	}
//
// 校验项：
//   - hello / hello_ack：版本字段非零、Role 合法、Nonce 16 字节 hex
//   - sign_request：ReqID > 0，Fingerprint / Data 非空
//   - sign_reply：ReqID > 0，要么 Signature 非空要么 Error 非空
//   - push_keys：Keys slice 内每条 entry 字段非空
//   - state / ping / pong / goodbye：op 单独即可
//
// 实现刻意「严格而非宽容」：未列出的字段如果设了，不一定 reject（因为
// envelope struct 没法区分「故意填了」vs「default 零值」），但任何必要
// 字段缺失或非法格式必然 reject。
func (e *Envelope) ValidateForOp() error {
	if e == nil {
		return errors.New("sshagentproto: nil envelope")
	}
	switch e.Op {
	case OpHello:
		if e.ProtocolVersion == 0 || e.MinVersion == 0 || e.MaxVersion == 0 {
			return errors.New("hello: missing version fields")
		}
		if e.MinVersion > e.MaxVersion {
			return errors.New("hello: minVersion > maxVersion")
		}
		if e.Role != RoleGUI && e.Role != RoleAgent {
			return fmt.Errorf("hello: invalid role %q", e.Role)
		}
		if len(e.Nonce) != HelloNonceSize*2 { // hex 编码长度 = 字节数 * 2
			return fmt.Errorf("hello: nonce hex length must be %d, got %d",
				HelloNonceSize*2, len(e.Nonce))
		}
	case OpHelloAck:
		if e.AgreedVersion == 0 {
			return errors.New("hello_ack: missing agreedVersion")
		}
		if e.NonceHMAC == "" {
			return errors.New("hello_ack: missing nonceHmac")
		}
	case OpPushKeys:
		// Keys 可以为空（用户删完所有 ssh key），但每条 entry 必须自洽
		for i, k := range e.Keys {
			if k.Fingerprint == "" {
				return fmt.Errorf("push_keys: keys[%d].fingerprint empty", i)
			}
			if k.PublicKey == "" {
				return fmt.Errorf("push_keys: keys[%d].publicKey empty", i)
			}
		}
	case OpSignRequest:
		if e.ReqID == 0 {
			return errors.New("sign_request: reqId must be > 0")
		}
		if e.Fingerprint == "" {
			return errors.New("sign_request: fingerprint empty")
		}
		if e.Data == "" {
			return errors.New("sign_request: data empty")
		}
	case OpSignReply:
		if e.ReqID == 0 {
			return errors.New("sign_reply: reqId must be > 0")
		}
		if e.Signature == "" && e.Error == "" {
			return errors.New("sign_reply: must have signature or error")
		}
		if e.Signature != "" && e.SignatureFormat == "" {
			return errors.New("sign_reply: signature without format")
		}
	case OpState:
		// Unlocked 是 bool，零值合法
	case OpPing, OpPong, OpGoodbye:
		// 这几种 op 不要求额外字段
	default:
		return fmt.Errorf("unknown op: %q", e.Op)
	}
	return nil
}

// ---------------------------------------------------------------------------
// 版本协商辅助
// ---------------------------------------------------------------------------

// NegotiateVersion 计算双方都能接受的协议版本
//
// 算法：取双方支持区间的交集的最大值。无交集返回 0 + error。
//
// 例：
//
//	ours   = [1, 2]
//	theirs = [2, 3]
//	→ agreed = 2
//
//	ours   = [1, 1]
//	theirs = [2, 3]
//	→ error
//
// 调用方：HELLO 阶段双方都执行一次，输出必须一致；不一致说明实现有 bug
// 或对端在恶意伪造，关闭连接。
func NegotiateVersion(ourMin, ourMax, theirMin, theirMax uint32) (uint32, error) {
	if ourMin == 0 || ourMax == 0 || theirMin == 0 || theirMax == 0 {
		return 0, errors.New("version range fields cannot be zero")
	}
	if ourMin > ourMax || theirMin > theirMax {
		return 0, errors.New("invalid version range (min > max)")
	}
	lo := ourMin
	if theirMin > lo {
		lo = theirMin
	}
	hi := ourMax
	if theirMax < hi {
		hi = theirMax
	}
	if lo > hi {
		return 0, fmt.Errorf("no common protocol version: ours [%d,%d] theirs [%d,%d]",
			ourMin, ourMax, theirMin, theirMax)
	}
	return hi, nil
}
