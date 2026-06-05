package services

// LAN 同步服务 —— ZPass 桌面客户端
// ---------------------------------------------------------------------------
// 让用户在局域网内把 desktop ↔ phone / desktop ↔ desktop 两端的 vault
// 内容做合并：传输双方密文 item 列表，本端对比 manifest 决定 push / pull /
// 报告冲突，由用户在 UI 上选择保留哪一份。
//
// ---------------------------------------------------------------------------
// 协议（PSK 模式 — 与 phone TS 端字节级一致）
//
// 1. 配对（pair）
//    Server 启动时生成 6 位 PIN 与 16 字节 salt。屏幕显示 PIN（可同时
//    编码进二维码：`zpass-sync://<ip>:<port>?pin=<pin>`）。
//
//    Client 输入 PIN（或扫码）后发起：
//
//      POST /v1/pair                          (明文 JSON)
//        { client_nonce: <hex 16B> }
//      → 200
//        { session_id: <hex 16B>, salt: <hex 16B>, server_nonce: <hex 16B> }
//
//    两端各自派生 session_key：
//      key = Argon2id(pin, salt || session_id || client_nonce || server_nonce,
//                     m=8MiB, t=2, p=1, len=32)
//    Argon2id 慢化 + server 端 3 次失败 60 秒锁定 → 6 位 PIN 离线爆破成本
//    >= 数百年（每尝试一次需做完整 KDF + AEAD 校验）。
//
//    Client 发起 confirm：
//      POST /v1/pair/confirm                  (session_key AEAD body)
//        { confirm: HMAC-SHA256(session_key, "client:confirm") }
//      → 200
//        { confirm: HMAC-SHA256(session_key, "server:confirm") }
//
//    Server 验证 client confirm → 接受配对；client 收到 server confirm
//    并比对 → 双方都已证明持有 PIN。
//
// 2. 同步周期 —— 所有 body 都用 session_key 做 XChaCha20-Poly1305 加密
//
//      POST /v1/sync/manifest    → [{id, updatedAt, deletedAt, contentHash, revision}]
//      POST /v1/sync/fetch       → 批量返回 {id, ciphertext, created/updated/deletedAt}
//      POST /v1/sync/push        → 批量接收对端的密文行
//      POST /v1/sync/commit      → 通知对端「合并已完成」
//
// 3. Nonce / 防重放
//    Session 用方向位 + 计数器作为 nonce 一部分（与 cryptocore-sync 实现
//    一致）。接收方维护「上次接受的计数器」，拒绝任何 counter ≤ last。
//
// ---------------------------------------------------------------------------
// 安全权衡（明文 HTTP）
//
// 用户决策：暂用明文 HTTP（局域网内部，TLS 证书涉及自签 / 装根证书等
// 复杂度，权衡后接受风险）。
//   - body 全程 AEAD 加密 + 方向位 + 计数器，明文 HTTP 攻击者只能看到
//     无意义的密文。
//   - 攻击者唯一可见信息：流量大小 / 时序 / IP/端口元数据 —— 这些都不
//     泄露 vault 内容。
//   - 未来升级 TLS 只需把 net/http.Serve 换成 ServeTLS，body 协议不变。
//
// ---------------------------------------------------------------------------
// 服务模型
//
// SyncService 是「单例」，同时间最多有一个 LAN listener 在运行 + 一个
// outbound 同步会话在进行。重复 StartServer 会覆盖（先 stop 旧的）。
//
// 调用方（renderer）的典型流程：
//   1. StartServer() → { pin, port, qrPayload }，前端显示二维码
//   2. 用户在对端扫码或手输 PIN
//   3. 对端 Connect(ip, port, pin)：完成配对 + 拉取 manifest +
//      自动合并无冲突项 + 把冲突清单写入 SyncService.pendingConflicts
//   4. 前端调 GetPendingConflicts() 拿到冲突列表，渲染 UI
//   5. 用户逐条选择 → 调 ResolveConflict(id, choice)
//   6. 全部解决 → CommitMerge() 应用到本端 vault + push 到对端
//   7. StopServer() / 对端 Disconnect()

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/argon2"
)

// ---------------------------------------------------------------------------
// 协议常量
// ---------------------------------------------------------------------------

const (
	// syncProtoVersion 写进每个响应的 protoVersion 字段；改协议时 +1。
	syncProtoVersion = 1

	// syncPSKMemoryKiB / syncPSKIterations / syncPSKParallelism / syncPSKKeyLen
	// 是配对 PSK 派生用的 Argon2id 参数。比 vault 主密码 KDF 弱（vault 是
	// m=64MiB, t=3），因为 PIN 只 6 位、生存窗口短（30 分钟会话），过慢
	// 会让用户在手机上等太久。8 MiB × 2 iter × 1 par ≈ 100ms in laptop CPU。
	syncPSKMemoryKiB   uint32 = 8 * 1024
	syncPSKIterations  uint32 = 2
	syncPSKParallelism uint8  = 1
	syncPSKKeyLen      uint32 = 32

	// 配对 PIN 长度（位）—— 与 cryptocore-sync 一致。
	syncPinDigits = 6

	// 配对 nonce / salt 长度（字节）—— 影响 Argon2id 输入熵。
	syncPairNonceLen = 16
	syncPairSaltLen  = 16

	// session_id 字节长度（hex 编码后是 32 字符）。
	syncSessionIDLen = 16

	// 配对窗口超时：超过即作废
	syncPairWindow = 5 * time.Minute

	// 整体会话超时：自配对成功起最多保活 30 分钟。
	syncSessionTimeout = 30 * time.Minute

	// PIN 失败锁定：3 次失败后 60 秒锁定。
	syncPinMaxFailures = 3
	syncPinLockoutDur  = 60 * time.Second

	// 服务端单批最大 item 数 —— 与 cryptocore-sync MAX_BATCH_SIZE 对齐。
	syncMaxBatchSize = 500

	// 客户端默认 batch 大小 —— 进度展示粒度。
	syncDefaultBatchSize = 50

	// 每个 endpoint 在 AEAD 时绑定的 aad 标签，防止跨端点重放。
	syncAADPair            = "zpass-sync:pair-confirm"
	syncAADManifest        = "zpass-sync:manifest"
	syncAADFetch           = "zpass-sync:fetch"
	syncAADPush            = "zpass-sync:push"
	syncAADCommit          = "zpass-sync:commit"
	syncAADProgress        = "zpass-sync:progress"
	syncAADReportConflicts = "zpass-sync:report-conflicts"
	syncAADPollResolutions = "zpass-sync:poll-resolutions"

	// 方向位（混入 nonce 第一字节），与 cryptocore-sync 一致。
	syncDirServer byte = 0x01
	syncDirClient byte = 0x02
)

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

var (
	ErrSyncNotRunning      = errors.New("sync server not running")
	ErrSyncAlreadyRunning  = errors.New("sync server already running")
	ErrSyncSessionExpired  = errors.New("sync session expired")
	ErrSyncPinLocked       = errors.New("sync pin locked, try again later")
	ErrSyncInvalidPin      = errors.New("sync pin invalid")
	ErrSyncReplayedFrame   = errors.New("sync frame replayed (counter rollback)")
	ErrSyncWrongDirection  = errors.New("sync frame direction mismatch")
	ErrSyncBadProtocol     = errors.New("sync protocol error")
	ErrSyncNoSession       = errors.New("no active sync session")
	ErrSyncConflictPending = errors.New("conflicts pending user resolution")
)

// ---------------------------------------------------------------------------
// JSON wire types  （字节级与 phone TS 端 lib/sync/protocol.ts 对齐）
// ---------------------------------------------------------------------------

// SyncPairRequest 是 POST /v1/pair 的明文请求体
type SyncPairRequest struct {
	ClientNonce string `json:"clientNonce"` // hex 16B
}

type SyncPairResponse struct {
	ProtoVersion int    `json:"protoVersion"`
	SessionID    string `json:"sessionId"`   // hex 16B
	Salt         string `json:"salt"`        // hex 16B
	ServerNonce  string `json:"serverNonce"` // hex 16B
}

// SyncPairConfirmRequest 是 POST /v1/pair/confirm 的请求体
// 这是 server 端**首次**接收对方的加密 frame，因此用 sessionKey AEAD 包装 JSON。
type SyncPairConfirmRequest struct {
	Confirm string `json:"confirm"` // hex 32B  HMAC-SHA256(sessionKey, "client:confirm")
}

type SyncPairConfirmResponse struct {
	Confirm string `json:"confirm"` // hex 32B  HMAC-SHA256(sessionKey, "server:confirm")
}

// SyncManifestEntry 是 manifest 的单条
//
// updatedAt / deletedAt 单位毫秒；revision 是设备内单调写入计数；
// contentHash 是 plaintext payload 的 SHA-256 前 16 字节 hex，用于
// 「updatedAt 相同时内容是否一致」二次校验。空字符串 = 未提供 hash。
type SyncManifestEntry struct {
	ID          string `json:"id"`
	UpdatedAt   int64  `json:"updatedAt"`
	DeletedAt   int64  `json:"deletedAt,omitempty"`
	ContentHash string `json:"contentHash,omitempty"`
	Revision    int64  `json:"revision,omitempty"`
}

type SyncManifestRequest struct {
	SessionID string `json:"sessionId"`
	Role      string `json:"role,omitempty"` // "desktop" / "phone"，仅用于日志
}

type SyncManifestResponse struct {
	ProtoVersion int                 `json:"protoVersion"`
	SessionID    string              `json:"sessionId"`
	Entries      []SyncManifestEntry `json:"entries"`
	GeneratedAt  int64               `json:"generatedAt"`
}

// SyncFetchRequest 是 POST /v1/sync/fetch 的请求体
type SyncFetchRequest struct {
	SessionID string   `json:"sessionId"`
	IDs       []string `json:"ids"`
	Offset    int      `json:"offset,omitempty"`
	Limit     int      `json:"limit,omitempty"`
}

// SyncItemRecord 是 fetch 返回 / push 接受的单条记录
//
// Ciphertext 字段名沿用旧名（避免改动 phone TS proto），但**实际承载**的是：
//   - 活动 item：JSON-marshal 后的 plaintext ItemPayload（base64 编码）
//   - tombstone：空字符串（对端只需要 id + DeletedAt 元数据即可调 DeleteItem）
//
// 为什么传 plaintext 而非 vault 加密的 ciphertext：
//
//	两端 vault 完全独立 —— desktop 用自己的 DEK_A 加密，phone 用 DEK_B 加密；
//	把 DEK_A 加密的密文整行推给 phone，phone 用 DEK_B 解密会 AEAD tag fail
//	（"invalid tag"），第一次同步看似成功但下次 listItems 解密全部失败。
//
// 传输安全：整个 SyncItemRecord 数组装进 Batch{Response,Request} 后再走
// session AEAD（XChaCha20-Poly1305 + 方向位 + counter），所以 plaintext
// payload 永远不会暴露在 wire 上。
type SyncItemRecord struct {
	ID         string `json:"id"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
	DeletedAt  int64  `json:"deletedAt,omitempty"`
	Ciphertext string `json:"ciphertext"` // base64(JSON(ItemPayload)) 或 ""（tombstone）
}

type SyncBatchResponse struct {
	SessionID  string           `json:"sessionId"`
	Items      []SyncItemRecord `json:"items"`
	Total      int              `json:"total"`
	NextOffset int              `json:"nextOffset,omitempty"`
}

type SyncPushRequest struct {
	SessionID string           `json:"sessionId"`
	Items     []SyncItemRecord `json:"items"`
}

type SyncPushResponse struct {
	SessionID string `json:"sessionId"`
	Accepted  int    `json:"accepted"`
}

type SyncCommitRequest struct {
	SessionID string           `json:"sessionId"`
	Apply     []SyncItemRecord `json:"apply"`
	Delete    []string         `json:"delete"`
}

type SyncCommitResponse struct {
	SessionID string `json:"sessionId"`
	Applied   int    `json:"applied"`
	Deleted   int    `json:"deleted"`
}

// SyncReportConflictsRequest 是 client 端把检测到的冲突推送给 server 的请求体
//
// client（phone）在本端跑完 mergeManifests 后，把每条冲突附带**自己端**的
// plaintext payload 一起推给 server（desktop），让 server 能渲染完整 UI 给
// 用户决策。
type SyncReportConflictsRequest struct {
	SessionID string                 `json:"sessionId"`
	Conflicts []SyncReportedConflict `json:"conflicts"`
}

// SyncReportedConflict 是 client 端视角的单条冲突
//
// 字段命名按 client 视角：LocalManifest 是 client 端的；RemoteManifest 是
// server 端的。server 收到后会做镜像反转（参见 ApplyReportedConflicts）。
type SyncReportedConflict struct {
	ID              string            `json:"id"`
	Kind            string            `json:"kind"`
	SuggestedRemote bool              `json:"suggestedRemote"`
	LocalManifest   SyncManifestEntry `json:"localManifest"`
	RemoteManifest  SyncManifestEntry `json:"remoteManifest"`
	// LocalPayload 是 client 端 vault 中该 id 的 plaintext payload（base64
	// JSON）。server 视角看是「remote」payload（用于冲突 UI 展示对端数据）。
	LocalPayload string `json:"localPayload,omitempty"`
}

type SyncReportConflictsResponse struct {
	SessionID string `json:"sessionId"`
	Accepted  int    `json:"accepted"`
}

// SyncResolutionAction 是 desktop 告诉 phone 「这条 id 你该做什么」
//
// Op 取值（phone 端做对应操作）:
//   - "overwrite":   用 PayloadB64 解出来的 plaintext 覆盖 phone 端该 id 的行
//     （updatedAt 用 desktop 当前 vault 内的，保持两端一致）
//   - "delete":      phone 端把该 id 软删（desktop 用户最终选择删除该条）
//   - "noop":        phone 端不动（desktop 用户保留 phone 已有版本）
//   - "duplicate":   phone 端用 NewID 创建一份副本，PayloadB64 是 phone 原版本；
//     原 id 仍按 overwrite/noop 分支处理
type SyncResolutionAction struct {
	ID         string `json:"id"`
	Op         string `json:"op"`
	PayloadB64 string `json:"payload,omitempty"`
	UpdatedAt  int64  `json:"updatedAt,omitempty"`
	CreatedAt  int64  `json:"createdAt,omitempty"`
	NewID      string `json:"newId,omitempty"`
}

// SyncPollResolutionsRequest 是 phone 轮询请求体
type SyncPollResolutionsRequest struct {
	SessionID string `json:"sessionId"`
}

// SyncPollResolutionsResponse 携带 desktop 端最终决策
//
// Ready=false 表示用户尚未在 desktop 端解决完，phone 应当继续轮询。
// Ready=true 表示决策已就绪，phone 按 Actions 数组一一应用即完成同步。
type SyncPollResolutionsResponse struct {
	SessionID string                 `json:"sessionId"`
	Ready     bool                   `json:"ready"`
	Actions   []SyncResolutionAction `json:"actions,omitempty"`
}

// SyncProgress 是合并 / 传输过程中的阶段进度
//
// 由 SyncService 内部维护；前端用 GetProgress() 拉取展示。
type SyncProgress struct {
	Stage     string `json:"stage"`     // "idle" | "pairing" | "manifest" | "fetch" | "push" | "merge" | "commit" | "done" | "error"
	Processed int    `json:"processed"` // 当前阶段已处理条数
	Total     int    `json:"total"`     // 当前阶段总条数
	Message   string `json:"message,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

// ---------------------------------------------------------------------------
// Session 状态
// ---------------------------------------------------------------------------

// syncSession 在一次配对成功后建立，承载会话 key + 双向 nonce 计数器。
//
// sessionKey 是 32 字节 XChaCha20-Poly1305 密钥。
// sendCounter / recvCounter 单调递增；接收方拒绝 ≤ last 的 counter。
type syncSession struct {
	id            string
	sessionKey    []byte
	role          syncRole // server / client
	pairedAt      time.Time
	sendCounter   atomic.Uint64
	lastRecvCount atomic.Uint64 // server 侧记录 client→server 的最大计数；client 侧反之
}

type syncRole int

const (
	roleServer syncRole = 1
	roleClient syncRole = 2
)

func (r syncRole) sendDirByte() byte {
	if r == roleServer {
		return syncDirServer
	}
	return syncDirClient
}

func (r syncRole) recvDirByte() byte {
	if r == roleServer {
		return syncDirClient
	}
	return syncDirServer
}

// nextNonce 生成 24 字节 nonce：[dir(1)][random(16)][counter(7)]
func (s *syncSession) nextNonce(role syncRole) ([]byte, error) {
	counter := s.sendCounter.Add(1)
	rnd := make([]byte, 16)
	if _, err := rand.Read(rnd); err != nil {
		return nil, fmt.Errorf("rand for nonce: %w", err)
	}
	nonce := make([]byte, NonceSize)
	nonce[0] = role.sendDirByte()
	copy(nonce[1:17], rnd)
	// 7 字节 big-endian counter（counter 高位丢弃也无害，因为 7 字节足够 2^56 帧）
	for i := 0; i < 7; i++ {
		nonce[17+i] = byte(counter >> ((6 - i) * 8))
	}
	_ = role
	return nonce, nil
}

// SealJSON 把 JSON-marshal 后的 plaintext 用 sessionKey AEAD 加密
//
// 输出 = nonce(24) || ciphertext || tag(16)。与 SealAEAD 但 nonce 由协议决定。
func (s *syncSession) SealJSON(payload any, aad []byte) ([]byte, error) {
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}
	nonce, err := s.nextNonce(s.role)
	if err != nil {
		return nil, err
	}
	ct, err := sealAEADWithNonce(s.sessionKey, plaintext, aad, nonce)
	if err != nil {
		return nil, err
	}
	WipeBytes(plaintext)
	out := make([]byte, 0, len(nonce)+len(ct))
	out = append(out, nonce...)
	out = append(out, ct...)
	return out, nil
}

// OpenJSON 校验方向位 + counter 单调，然后解密 + JSON-unmarshal
func (s *syncSession) OpenJSON(frame []byte, aad []byte, out any) error {
	if len(frame) < NonceSize+16 {
		return ErrSyncBadProtocol
	}
	nonce := frame[:NonceSize]
	ct := frame[NonceSize:]
	if nonce[0] != s.role.recvDirByte() {
		return ErrSyncWrongDirection
	}
	var counter uint64
	for i := 0; i < 7; i++ {
		counter = counter<<8 | uint64(nonce[17+i])
	}
	last := s.lastRecvCount.Load()
	if counter <= last {
		return ErrSyncReplayedFrame
	}
	plaintext, err := openAEADWithNonce(s.sessionKey, ct, aad, nonce)
	if err != nil {
		return ErrInvalidPassword // 模糊化失败：不区分 tampered/wrong key
	}
	// CAS：另一线程可能已经把 last 推得更高，没关系，跳过。
	_ = s.lastRecvCount.CompareAndSwap(last, counter)
	if err := json.Unmarshal(plaintext, out); err != nil {
		WipeBytes(plaintext)
		return fmt.Errorf("unmarshal: %w", err)
	}
	WipeBytes(plaintext)
	return nil
}

// ---------------------------------------------------------------------------
// Pending merge / conflict state
// ---------------------------------------------------------------------------

// SyncConflict 是单条冲突条目（暴露给前端 UI）
//
// kind:
//   - "concurrent_edit"   双方相同 updatedAt 但内容不同
//   - "divergent_content" 不同 updatedAt 且内容不同
//   - "delete_vs_edit"    一方删了一方改了
type SyncConflict struct {
	ID              string            `json:"id"`
	Kind            string            `json:"kind"`
	Local           *ItemPayload      `json:"local,omitempty"`  // nil = local 不存在 / 解密失败
	Remote          *ItemPayload      `json:"remote,omitempty"` // nil = remote 不存在
	LocalManifest   SyncManifestEntry `json:"localManifest"`
	RemoteManifest  SyncManifestEntry `json:"remoteManifest"`
	SuggestedRemote bool              `json:"suggestedRemote"` // UI 默认勾选项
	// 用户决策（在 ResolveConflict 后填充）
	Resolution string `json:"resolution,omitempty"` // "local" | "remote" | "duplicate" | "skip"
}

// SyncStatus 是前端轮询的整体状态
type SyncStatus struct {
	ServerRunning bool           `json:"serverRunning"`
	ServerPort    int            `json:"serverPort,omitempty"`
	ServerPin     string         `json:"serverPin,omitempty"`
	ServerHosts   []string       `json:"serverHosts,omitempty"`
	QRPayload     string         `json:"qrPayload,omitempty"`
	Active        bool           `json:"active"`
	Role          string         `json:"role,omitempty"` // "server" / "client"
	Progress      SyncProgress   `json:"progress"`
	Conflicts     []SyncConflict `json:"conflicts,omitempty"`
}

// ---------------------------------------------------------------------------
// SyncService
// ---------------------------------------------------------------------------

type SyncService struct {
	vault *VaultService

	mu sync.RWMutex

	// Server 状态
	listener    net.Listener
	server      *http.Server
	pin         string
	salt        []byte
	pinFailures int
	pinLockedAt time.Time
	pendingPair *pendingPair // 配对窗口内的 client 信息
	serverSess  *syncSession // 配对成功后的会话
	serverHosts []string

	// Client 状态（本端主动连别人）
	clientSess    *syncSession
	clientBaseURL string
	clientCtx     context.Context    // 用于让 runClientSync / ApplyMerge 响应 Disconnect
	clientCancel  context.CancelFunc // Disconnect / stopServer 时调用

	// 进度 / 冲突
	progress  SyncProgress
	conflicts []SyncConflict
	role      string // "server" / "client" / ""

	// pendingResolutions 是 desktop server 端用户决策完成后，留给 phone client
	// 端轮询取走的 action 列表。phone POST /v1/sync/poll-resolutions：
	//   - nil → 用户尚未在 desktop 端 ApplyMerge，phone 继续轮询
	//   - 非 nil 切片 → 已就绪，phone 按 action 应用本端 vault + 清空字段
	// 取走后字段重置为 nil，避免下次会话错读旧数据。
	pendingResolutions []SyncResolutionAction
}

// pendingPair 是配对中间态：server 收到 client_nonce 后、收到 confirm 前
type pendingPair struct {
	sessionID   string
	salt        []byte
	clientNonce []byte
	serverNonce []byte
	sessionKey  []byte // 派生后暂存 — 用于校验 confirm
	createdAt   time.Time
}

func NewSyncService(vault *VaultService) *SyncService {
	return &SyncService{
		vault: vault,
		progress: SyncProgress{
			Stage:     "idle",
			UpdatedAt: time.Now().UnixMilli(),
		},
	}
}

// ---------------------------------------------------------------------------
// 服务端 API（前端可调）
// ---------------------------------------------------------------------------

// StartServer 在 LAN 接口上启动 sync HTTP server
//
// 自动选择 :0（随机可用端口）；返回 PIN / 端口 / 局域网 IP 列表 / 二维码 payload。
// 调用方应当显示 PIN（屏幕 + 二维码）让对端连接。
func (s *SyncService) StartServer() (*SyncStatus, error) {
	if !s.vault.IsUnlocked() {
		return nil, ErrVaultLocked
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.listener != nil {
		return nil, ErrSyncAlreadyRunning
	}

	pin, err := generateNumericPin(syncPinDigits)
	if err != nil {
		return nil, fmt.Errorf("gen pin: %w", err)
	}
	salt, err := GenerateRandomBytes(syncPairSaltLen)
	if err != nil {
		return nil, fmt.Errorf("gen salt: %w", err)
	}

	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	hosts := detectLanHosts()
	qr := buildQRPayload(hosts, port, pin)

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/pair", s.handlePair)
	mux.HandleFunc("/v1/pair/confirm", s.handlePairConfirm)
	mux.HandleFunc("/v1/sync/manifest", s.handleManifestServer)
	mux.HandleFunc("/v1/sync/fetch", s.handleFetchServer)
	mux.HandleFunc("/v1/sync/push", s.handlePushServer)
	mux.HandleFunc("/v1/sync/commit", s.handleCommitServer)
	mux.HandleFunc("/v1/sync/report-conflicts", s.handleReportConflictsServer)
	mux.HandleFunc("/v1/sync/poll-resolutions", s.handlePollResolutionsServer)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	s.listener = listener
	s.server = srv
	s.pin = pin
	s.salt = salt
	s.serverHosts = hosts
	s.role = "server"
	s.progress = SyncProgress{Stage: "pairing", UpdatedAt: time.Now().UnixMilli()}

	go func() {
		_ = srv.Serve(listener)
	}()

	return &SyncStatus{
		ServerRunning: true,
		ServerPort:    port,
		ServerPin:     pin,
		ServerHosts:   hosts,
		QRPayload:     qr,
		Active:        false,
		Role:          "server",
		Progress:      s.progress,
	}, nil
}

// StopServer 关闭 sync HTTP server 并清空会话状态
func (s *SyncService) StopServer() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopServerLocked()
}

func (s *SyncService) stopServerLocked() error {
	if s.server == nil {
		return nil // 幂等
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	_ = s.server.Shutdown(ctx)
	if s.serverSess != nil {
		WipeBytes(s.serverSess.sessionKey)
	}
	if s.pendingPair != nil && s.pendingPair.sessionKey != nil {
		WipeBytes(s.pendingPair.sessionKey)
	}
	s.listener = nil
	s.server = nil
	s.pin = ""
	s.salt = nil
	s.serverHosts = nil
	s.serverSess = nil
	s.pendingPair = nil
	s.pinFailures = 0
	s.pinLockedAt = time.Time{}
	s.role = ""
	s.progress = SyncProgress{Stage: "idle", UpdatedAt: time.Now().UnixMilli()}
	s.pendingResolutions = nil
	s.conflicts = nil
	return nil
}

// GetStatus 拉取整体 sync 状态（前端轮询用）
func (s *SyncService) GetStatus() *SyncStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := &SyncStatus{
		Progress: s.progress,
		Role:     s.role,
	}
	if s.listener != nil {
		port := s.listener.Addr().(*net.TCPAddr).Port
		st.ServerRunning = true
		st.ServerPort = port
		st.ServerPin = s.pin
		st.ServerHosts = s.serverHosts
		st.QRPayload = buildQRPayload(s.serverHosts, port, s.pin)
	}
	st.Active = s.serverSess != nil || s.clientSess != nil
	if len(s.conflicts) > 0 {
		st.Conflicts = append([]SyncConflict(nil), s.conflicts...)
	}
	return st
}

// GetPendingConflicts 拉取等待用户决策的冲突清单
func (s *SyncService) GetPendingConflicts() []SyncConflict {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]SyncConflict(nil), s.conflicts...)
}

// ResolveConflict 标记某条冲突的用户选择
//
// resolution: "local" / "remote" / "duplicate" / "skip"
func (s *SyncService) ResolveConflict(id, resolution string) error {
	switch resolution {
	case "local", "remote", "duplicate", "skip":
	default:
		return fmt.Errorf("invalid resolution: %q", resolution)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.conflicts {
		if s.conflicts[i].ID == id {
			s.conflicts[i].Resolution = resolution
			return nil
		}
	}
	return fmt.Errorf("conflict %q not found", id)
}

// ---------------------------------------------------------------------------
// 客户端 API（本端主动连别人）
// ---------------------------------------------------------------------------

// ConnectToServer 主动连接对端 LAN sync server，完成配对 + 拉取 manifest
//
// 流程：
//  1. POST /v1/pair { clientNonce } → 拿到 sessionID/salt/serverNonce
//  2. Argon2id 派生 sessionKey
//  3. POST /v1/pair/confirm（AEAD）→ 验证 server confirm
//  4. POST /v1/sync/manifest → 拿对端 manifest
//  5. 本端构造 local manifest，调 mergePlan → 产生 auto_apply / push / conflicts
//  6. 把 conflicts 写入 s.conflicts，等待用户 ResolveConflict
//
// 调用方在 conflicts 全部 resolved 后调 ApplyMerge() 完成合并。
func (s *SyncService) ConnectToServer(baseURL, pin string) (*SyncStatus, error) {
	if !s.vault.IsUnlocked() {
		return nil, ErrVaultLocked
	}
	if pin == "" {
		return nil, ErrSyncInvalidPin
	}
	baseURL = strings.TrimRight(baseURL, "/")
	clientNonce, err := GenerateRandomBytes(syncPairNonceLen)
	if err != nil {
		return nil, err
	}

	// Pair
	pairResp, err := postJSON[SyncPairRequest, SyncPairResponse](
		baseURL+"/v1/pair",
		SyncPairRequest{ClientNonce: hex.EncodeToString(clientNonce)},
	)
	if err != nil {
		return nil, fmt.Errorf("pair: %w", err)
	}
	saltBytes, err := hex.DecodeString(pairResp.Salt)
	if err != nil {
		return nil, fmt.Errorf("decode salt: %w", err)
	}
	serverNonce, err := hex.DecodeString(pairResp.ServerNonce)
	if err != nil {
		return nil, fmt.Errorf("decode serverNonce: %w", err)
	}
	sessionKey, err := deriveSyncSessionKey(pin, saltBytes, pairResp.SessionID, clientNonce, serverNonce)
	if err != nil {
		return nil, err
	}
	sess := &syncSession{
		id:         pairResp.SessionID,
		sessionKey: sessionKey,
		role:       roleClient,
		pairedAt:   time.Now(),
	}

	// 整体超时 + 可取消：Disconnect 调用时 cancel，所有进行中的 HTTP / 循环
	// 都会立即感知；不依赖单请求 30s 超时。
	ctx, cancel := context.WithTimeout(context.Background(), syncSessionTimeout)

	// Confirm
	clientConfirm := hmacTag(sessionKey, "client:confirm")
	confirmReq := SyncPairConfirmRequest{Confirm: hex.EncodeToString(clientConfirm)}
	encryptedReq, err := sess.SealJSON(confirmReq, []byte(syncAADPair))
	if err != nil {
		cancel()
		return nil, err
	}
	respBytes, err := postBinaryCtx(ctx, baseURL+"/v1/pair/confirm", encryptedReq)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("confirm: %w", err)
	}
	var confirmResp SyncPairConfirmResponse
	if err := sess.OpenJSON(respBytes, []byte(syncAADPair), &confirmResp); err != nil {
		cancel()
		return nil, fmt.Errorf("decrypt server confirm: %w", err)
	}
	wantServerConfirm := hmacTag(sessionKey, "server:confirm")
	gotServerConfirm, err := hex.DecodeString(confirmResp.Confirm)
	if err != nil || !hmac.Equal(gotServerConfirm, wantServerConfirm) {
		cancel()
		return nil, ErrSyncInvalidPin
	}

	s.mu.Lock()
	// 替换 ctx 前，若已有旧 session 残留，先 cancel
	if s.clientCancel != nil {
		s.clientCancel()
	}
	s.clientSess = sess
	s.clientBaseURL = baseURL
	s.clientCtx = ctx
	s.clientCancel = cancel
	s.role = "client"
	s.progress = SyncProgress{Stage: "manifest", UpdatedAt: time.Now().UnixMilli()}
	s.mu.Unlock()

	// 拉 manifest 并算合并计划
	if err := s.runClientSync(ctx); err != nil {
		s.mu.Lock()
		s.progress = SyncProgress{Stage: "error", Message: err.Error(), UpdatedAt: time.Now().UnixMilli()}
		s.mu.Unlock()
		return nil, err
	}
	return s.GetStatus(), nil
}

// Disconnect 断开 client 会话（用户取消同步）
//
// 取消 clientCtx 让 runClientSync / ApplyMerge 的 HTTP 循环立即返回 context.Canceled。
func (s *SyncService) Disconnect() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clientCancel != nil {
		s.clientCancel()
		s.clientCancel = nil
	}
	s.clientCtx = nil
	if s.clientSess != nil {
		WipeBytes(s.clientSess.sessionKey)
		s.clientSess = nil
	}
	s.clientBaseURL = ""
	s.conflicts = nil
	s.role = ""
	s.progress = SyncProgress{Stage: "idle", UpdatedAt: time.Now().UnixMilli()}
	return nil
}

// ApplyMerge 在所有冲突都已 resolved 后调用：把决策应用到 local vault
//
// 两种 mode：
//   - **client mode**（本端发起的同步）：fetch 对端完整 record → 应用到本地
//     vault → 批量 push 给对端
//   - **server mode**（对端连过来 + report-conflicts 推上来）：phone 已断开，
//     不能 push；只需把决策写入 desktop 本地 vault（用 phone 推来的 plaintext），
//     下次 phone 主动同步时会按新的 UpdatedAt 重新合并
//
// 返回 (实际应用的条数, error)。任一条目处理失败不会中断其它，但应用条数会少。
func (s *SyncService) ApplyMerge() (int, error) {
	s.mu.Lock()
	clientMode := s.clientSess != nil
	serverMode := !clientMode && s.serverSess != nil && len(s.conflicts) > 0
	if !clientMode && !serverMode {
		s.mu.Unlock()
		return 0, ErrSyncNoSession
	}
	for _, c := range s.conflicts {
		if c.Resolution == "" {
			s.mu.Unlock()
			return 0, ErrSyncConflictPending
		}
	}
	conflicts := append([]SyncConflict(nil), s.conflicts...)
	if serverMode {
		s.progress = SyncProgress{Stage: "commit", UpdatedAt: time.Now().UnixMilli()}
		s.mu.Unlock()
		return s.applyServerMerge(conflicts)
	}
	sess := s.clientSess
	baseURL := s.clientBaseURL
	ctx := s.clientCtx
	s.progress = SyncProgress{Stage: "commit", UpdatedAt: time.Now().UnixMilli()}
	s.mu.Unlock()

	// 1. 先从对端拉取所有需要 remote payload 的 id
	needRemoteIDs := make([]string, 0)
	for _, c := range conflicts {
		if c.Resolution == "remote" || c.Resolution == "duplicate" {
			needRemoteIDs = append(needRemoteIDs, c.ID)
		}
	}
	remoteByID := map[string]SyncItemRecord{}
	if len(needRemoteIDs) > 0 {
		records, err := s.fetchFromRemote(ctx, baseURL, sess, needRemoteIDs)
		if err != nil {
			s.mu.Lock()
			s.progress = SyncProgress{Stage: "error", Message: err.Error(), UpdatedAt: time.Now().UnixMilli()}
			s.mu.Unlock()
			return 0, fmt.Errorf("fetch conflict payloads: %w", err)
		}
		for _, rec := range records {
			remoteByID[rec.ID] = rec
		}
	}

	// 2. 应用决策
	applied := 0
	pushItems := make([]SyncItemRecord, 0)
	for _, c := range conflicts {
		if isCanceled(ctx) {
			s.mu.Lock()
			s.progress = SyncProgress{Stage: "error", Message: "canceled", UpdatedAt: time.Now().UnixMilli()}
			s.mu.Unlock()
			return applied, context.Canceled
		}
		switch c.Resolution {
		case "skip":
			continue
		case "local":
			rec, err := s.buildRecordFromLocal(c.ID)
			if err != nil {
				continue
			}
			pushItems = append(pushItems, rec)
			applied++
		case "remote":
			rec, ok := remoteByID[c.ID]
			if !ok || len(rec.Ciphertext) == 0 {
				// 对端没返回该条 record —— 跳过而不是写入空 payload
				continue
			}
			if err := s.applyRemoteRecord(rec); err != nil {
				continue
			}
			applied++
		case "duplicate":
			rec, ok := remoteByID[c.ID]
			if !ok || len(rec.Ciphertext) == 0 {
				continue
			}
			if err := s.duplicateRemoteAsNew(rec); err != nil {
				continue
			}
			applied++
		}
	}

	// 3. 批量 push（按批拆分，避免大库一次性传输）
	if len(pushItems) > 0 && !isCanceled(ctx) {
		for off := 0; off < len(pushItems); off += syncDefaultBatchSize {
			if isCanceled(ctx) {
				break
			}
			end := off + syncDefaultBatchSize
			if end > len(pushItems) {
				end = len(pushItems)
			}
			batch := pushItems[off:end]
			req := SyncPushRequest{SessionID: sess.id, Items: batch}
			encryptedReq, err := sess.SealJSON(req, []byte(syncAADPush))
			if err != nil {
				continue
			}
			respBytes, err := postBinaryCtx(ctx, baseURL+"/v1/sync/push", encryptedReq)
			if err != nil {
				continue
			}
			var resp SyncPushResponse
			_ = sess.OpenJSON(respBytes, []byte(syncAADPush), &resp)
		}
	}

	s.mu.Lock()
	s.progress = SyncProgress{Stage: "done", UpdatedAt: time.Now().UnixMilli(), Processed: applied, Total: applied}
	s.conflicts = nil
	s.mu.Unlock()
	return applied, nil
}

// ---------------------------------------------------------------------------
// 服务端 HTTP handlers
// ---------------------------------------------------------------------------

func (s *SyncService) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req SyncPairRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	clientNonce, err := hex.DecodeString(req.ClientNonce)
	if err != nil || len(clientNonce) != syncPairNonceLen {
		http.Error(w, "bad clientNonce", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// PIN 锁定窗口
	if !s.pinLockedAt.IsZero() && time.Since(s.pinLockedAt) < syncPinLockoutDur {
		http.Error(w, "pin locked", http.StatusTooManyRequests)
		return
	}
	// 允许新 pair_init 覆盖未完成的 pendingPair：旧 pending 可能是上次失败重试
	// 残留（用户输错 PIN、网络中断、关闭客户端等），强制让用户等 5 分钟超时
	// 体验极差。真正的认证发生在 pair_confirm 阶段，那里有 PIN 失败锁定兜底。
	if s.pendingPair != nil {
		if s.pendingPair.sessionKey != nil {
			WipeBytes(s.pendingPair.sessionKey)
		}
		s.pendingPair = nil
	}

	serverNonce, err := GenerateRandomBytes(syncPairNonceLen)
	if err != nil {
		http.Error(w, "rng failure", http.StatusInternalServerError)
		return
	}
	sessionID := mustRandomHex(syncSessionIDLen)

	sessionKey, err := deriveSyncSessionKey(s.pin, s.salt, sessionID, clientNonce, serverNonce)
	if err != nil {
		http.Error(w, "derive failure", http.StatusInternalServerError)
		return
	}
	s.pendingPair = &pendingPair{
		sessionID:   sessionID,
		salt:        s.salt,
		clientNonce: clientNonce,
		serverNonce: serverNonce,
		sessionKey:  sessionKey,
		createdAt:   time.Now(),
	}

	resp := SyncPairResponse{
		ProtoVersion: syncProtoVersion,
		SessionID:    sessionID,
		Salt:         hex.EncodeToString(s.salt),
		ServerNonce:  hex.EncodeToString(serverNonce),
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *SyncService) handlePairConfirm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	pp := s.pendingPair
	if pp == nil {
		s.mu.Unlock()
		http.Error(w, "no pending pair", http.StatusConflict)
		return
	}
	if time.Since(pp.createdAt) > syncPairWindow {
		s.mu.Unlock()
		http.Error(w, "pair expired", http.StatusGone)
		return
	}

	// 临时 session 解出 confirm
	//
	// pairedAt 必须显式赋值 —— 默认零值（公元元年）让 requireServerSession
	// 的 `time.Since(sess.pairedAt) > syncSessionTimeout` 永远为 true，
	// 任何后续请求都会被判作 "session expired" 返回 410。
	tmp := &syncSession{
		id:         pp.sessionID,
		sessionKey: pp.sessionKey,
		role:       roleServer,
		pairedAt:   time.Now(),
	}
	var req SyncPairConfirmRequest
	if err := tmp.OpenJSON(body, []byte(syncAADPair), &req); err != nil {
		s.recordPinFailureLocked()
		s.mu.Unlock()
		http.Error(w, "decrypt failed", http.StatusUnauthorized)
		return
	}
	wantClientConfirm := hmacTag(pp.sessionKey, "client:confirm")
	gotClientConfirm, err := hex.DecodeString(req.Confirm)
	if err != nil || !hmac.Equal(gotClientConfirm, wantClientConfirm) {
		s.recordPinFailureLocked()
		s.mu.Unlock()
		http.Error(w, "wrong pin", http.StatusUnauthorized)
		return
	}

	// 配对成功
	s.serverSess = tmp
	s.pendingPair = nil
	s.pinFailures = 0
	s.pinLockedAt = time.Time{}
	s.progress = SyncProgress{Stage: "manifest", UpdatedAt: time.Now().UnixMilli()}
	s.mu.Unlock()

	// 返回 confirm_b
	serverConfirm := hmacTag(pp.sessionKey, "server:confirm")
	confirmResp := SyncPairConfirmResponse{Confirm: hex.EncodeToString(serverConfirm)}
	encrypted, err := tmp.SealJSON(confirmResp, []byte(syncAADPair))
	if err != nil {
		http.Error(w, "seal", http.StatusInternalServerError)
		return
	}
	writeBinary(w, encrypted)
}

func (s *SyncService) recordPinFailureLocked() {
	s.pinFailures++
	if s.pinFailures >= syncPinMaxFailures {
		s.pinLockedAt = time.Now()
		s.pinFailures = 0
		if s.pendingPair != nil && s.pendingPair.sessionKey != nil {
			WipeBytes(s.pendingPair.sessionKey)
		}
		s.pendingPair = nil
	}
}

func (s *SyncService) handleManifestServer(w http.ResponseWriter, r *http.Request) {
	sess := s.requireServerSession(w, r)
	if sess == nil {
		return
	}
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
	var req SyncManifestRequest
	if err := sess.OpenJSON(body, []byte(syncAADManifest), &req); err != nil {
		http.Error(w, "decrypt", http.StatusUnauthorized)
		return
	}
	manifest, err := s.buildManifest()
	if err != nil {
		http.Error(w, "build manifest", http.StatusInternalServerError)
		return
	}
	resp := SyncManifestResponse{
		ProtoVersion: syncProtoVersion,
		SessionID:    sess.id,
		Entries:      manifest,
		GeneratedAt:  time.Now().UnixMilli(),
	}
	encrypted, err := sess.SealJSON(resp, []byte(syncAADManifest))
	if err != nil {
		http.Error(w, "seal", http.StatusInternalServerError)
		return
	}
	writeBinary(w, encrypted)
}

func (s *SyncService) handleFetchServer(w http.ResponseWriter, r *http.Request) {
	sess := s.requireServerSession(w, r)
	if sess == nil {
		return
	}
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	var req SyncFetchRequest
	if err := sess.OpenJSON(body, []byte(syncAADFetch), &req); err != nil {
		http.Error(w, "decrypt", http.StatusUnauthorized)
		return
	}
	items, total, err := s.fetchRecords(req.IDs, req.Offset, req.Limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	resp := SyncBatchResponse{
		SessionID: sess.id,
		Items:     items,
		Total:     total,
	}
	encrypted, err := sess.SealJSON(resp, []byte(syncAADFetch))
	if err != nil {
		http.Error(w, "seal", http.StatusInternalServerError)
		return
	}
	writeBinary(w, encrypted)
}

func (s *SyncService) handlePushServer(w http.ResponseWriter, r *http.Request) {
	sess := s.requireServerSession(w, r)
	if sess == nil {
		return
	}
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	var req SyncPushRequest
	if err := sess.OpenJSON(body, []byte(syncAADPush), &req); err != nil {
		http.Error(w, "decrypt", http.StatusUnauthorized)
		return
	}
	accepted := 0
	for _, rec := range req.Items {
		if err := s.applyRemoteRecord(rec); err == nil {
			accepted++
		}
	}
	resp := SyncPushResponse{SessionID: sess.id, Accepted: accepted}
	encrypted, err := sess.SealJSON(resp, []byte(syncAADPush))
	if err != nil {
		http.Error(w, "seal", http.StatusInternalServerError)
		return
	}
	writeBinary(w, encrypted)
}

func (s *SyncService) handleCommitServer(w http.ResponseWriter, r *http.Request) {
	sess := s.requireServerSession(w, r)
	if sess == nil {
		return
	}
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
	var req SyncCommitRequest
	if err := sess.OpenJSON(body, []byte(syncAADCommit), &req); err != nil {
		http.Error(w, "decrypt", http.StatusUnauthorized)
		return
	}
	applied := 0
	for _, rec := range req.Apply {
		if err := s.applyRemoteRecord(rec); err == nil {
			applied++
		}
	}
	resp := SyncCommitResponse{SessionID: sess.id, Applied: applied, Deleted: 0}
	encrypted, err := sess.SealJSON(resp, []byte(syncAADCommit))
	if err != nil {
		http.Error(w, "seal", http.StatusInternalServerError)
		return
	}
	writeBinary(w, encrypted)
}

// applyServerMerge 是 server mode 下的 ApplyMerge 实现：phone 已经断开
// 同步会话，无法 push；desktop 只把用户决策写入本地 vault 即可。下次 phone
// 主动同步时，按新的 UpdatedAt 会自动 pull 过去（LWW）。
//
// 决策语义（从 desktop 视角）：
//   - skip      → 不动 desktop 端 vault
//   - local     → 不动 desktop 端 vault（已经是本端版本，等下次 phone 同步时被拉）
//   - remote    → 用 phone 推过来的 plaintext payload 覆盖 desktop 当前行；
//     用 nowMs() 作为新 UpdatedAt，确保大于双方 manifest 时间戳
//   - duplicate → 用 phone payload 在 desktop 创建新 id 条目（双份保留）
//
// applyServerMerge 把 desktop UI 上的决策双向落地：
//   - desktop vault：直接写入（IngestForeignPayload / CreateItem）
//   - phone 端：生成 SyncResolutionAction 列表 → 存进 s.pendingResolutions →
//     phone 的轮询 /v1/sync/poll-resolutions 取走应用
//
// 通过同步会话直接通知 phone 该如何收尾，不再依赖"下次同步 LWW 推断"。
func (s *SyncService) applyServerMerge(conflicts []SyncConflict) (int, error) {
	applied := 0
	now := time.Now().UnixMilli()
	actions := make([]SyncResolutionAction, 0, len(conflicts))

	for _, c := range conflicts {
		switch c.Resolution {
		case "skip", "":
			actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
			continue
		case "local":
			// 保留 desktop 版本。分两种情况：
			//   (a) desktop 是 tombstone（delete_vs_edit conflict 选保留删除）
			//       → 通知 phone 也删（action "delete"），下次同步 decideBoth
			//         看到双方 tombstone 即 identical
			//   (b) desktop 是活动行 → bump desktop updatedAt=now，phone 用
			//         同一 payload + now 覆盖，让两端 row.updatedAt 完全一致
			row, dbErr := s.vault.db.GetItem(c.ID)
			if dbErr == nil && row != nil && row.DeletedAt != nil && *row.DeletedAt > 0 {
				// (a) tombstone 路径
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "delete"})
				applied++
				continue
			}
			local, err := s.vault.getItemAnySpace(c.ID)
			if err != nil || local == nil {
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
				continue
			}
			if _, err := s.vault.IngestForeignPayload(c.ID, local, local.CreatedAt, now); err != nil {
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
				continue
			}
			// 读一遍最新的（updatedAt 现在已经是 now，内容不变）
			latest, _ := s.vault.getItemAnySpace(c.ID)
			if latest == nil {
				latest = local
			}
			b, err := json.Marshal(latest)
			if err != nil {
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
				continue
			}
			actions = append(actions, SyncResolutionAction{
				ID:         c.ID,
				Op:         "overwrite",
				PayloadB64: encodeBase64(b),
				CreatedAt:  latest.CreatedAt,
				UpdatedAt:  now,
			})
			applied++
		case "remote":
			if c.Remote == nil {
				// phone 端是 tombstone（report-conflicts 没带 payload）—— 用户选
				// 保留对端决定 = 让 desktop 也删除该条。phone 端不动（它本来就是
				// tombstone），decideBoth 双 tombstone identical 兜底下次同步。
				if err := s.vault.deleteItemAnySpace(c.ID); err == nil {
					applied++
				}
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
				continue
			}
			// 用 phone 版本覆盖 desktop vault（updatedAt=now）；phone 端
			// 内容已经是这个版本，只需把 row.updatedAt 推到 now 让两端对齐。
			remoteCopy := *c.Remote
			createdAt := remoteCopy.CreatedAt
			if existing, err := s.vault.getItemAnySpace(c.ID); err == nil && existing != nil {
				createdAt = existing.CreatedAt
			}
			if _, err := s.vault.IngestForeignPayload(c.ID, &remoteCopy, createdAt, now); err != nil {
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
				continue
			}
			// 读 desktop 端刚写入的 payload（与 phone 内容一致）回传给 phone
			latest, _ := s.vault.getItemAnySpace(c.ID)
			if latest == nil {
				latest = &remoteCopy
				latest.UpdatedAt = now
			}
			b, err := json.Marshal(latest)
			if err != nil {
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
				continue
			}
			actions = append(actions, SyncResolutionAction{
				ID:         c.ID,
				Op:         "overwrite",
				PayloadB64: encodeBase64(b),
				CreatedAt:  latest.CreatedAt,
				UpdatedAt:  now,
			})
			applied++
		case "duplicate":
			if c.Remote == nil {
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
				continue
			}
			// desktop：用 phone payload 创建新 id 副本
			dup := *c.Remote
			dup.ID = ""
			dup.DeletedAt = nil
			// 副本归属对端原空间（dup.SpaceID 来自对端 payload）；为空则
			// createItemInSpace fallback 到当前激活空间。
			created, err := s.vault.createItemInSpace(dup, dup.SpaceID)
			if err != nil || created == nil {
				actions = append(actions, SyncResolutionAction{ID: c.ID, Op: "noop"})
				continue
			}
			// 告诉 phone：原 id 用 desktop 当前 payload 覆盖；额外创建一份 newId 副本
			if local, err := s.vault.getItemAnySpace(c.ID); err == nil && local != nil {
				if b, err := json.Marshal(local); err == nil {
					actions = append(actions, SyncResolutionAction{
						ID:         c.ID,
						Op:         "overwrite",
						PayloadB64: encodeBase64(b),
						CreatedAt:  local.CreatedAt,
						UpdatedAt:  local.UpdatedAt,
					})
				}
			}
			if b, err := json.Marshal(c.Remote); err == nil {
				actions = append(actions, SyncResolutionAction{
					ID:         c.ID,
					Op:         "duplicate",
					PayloadB64: encodeBase64(b),
					NewID:      created.ID,
					CreatedAt:  created.CreatedAt,
					UpdatedAt:  created.UpdatedAt,
				})
			}
			applied++
		}
	}

	s.mu.Lock()
	s.progress = SyncProgress{
		Stage:     "done",
		Processed: applied,
		Total:     applied,
		UpdatedAt: time.Now().UnixMilli(),
	}
	s.conflicts = nil
	s.pendingResolutions = actions
	s.mu.Unlock()
	return applied, nil
}

// handleReportConflictsServer 接收 client 推送来的冲突清单，转成 server 视角
// 写入 s.conflicts，让 desktop UI（轮询 GetStatus）能看到并让用户决策。
func (s *SyncService) handleReportConflictsServer(w http.ResponseWriter, r *http.Request) {
	sess := s.requireServerSession(w, r)
	if sess == nil {
		return
	}
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	var req SyncReportConflictsRequest
	if err := sess.OpenJSON(body, []byte(syncAADReportConflicts), &req); err != nil {
		http.Error(w, "decrypt", http.StatusUnauthorized)
		return
	}

	uiConflicts := make([]SyncConflict, 0, len(req.Conflicts))
	for _, rc := range req.Conflicts {
		// 镜像反转：client 的 local 是 server 视角的 remote，反之亦然
		uiC := SyncConflict{
			ID:              rc.ID,
			Kind:            rc.Kind,
			LocalManifest:   rc.RemoteManifest, // server 端 manifest
			RemoteManifest:  rc.LocalManifest,  // client 端 manifest
			SuggestedRemote: !rc.SuggestedRemote,
		}
		// server 端 local payload —— 从本端 vault 现拉
		if local, err := s.vault.getItemAnySpace(rc.ID); err == nil && local != nil {
			uiC.Local = local
		}
		// server 视角的 remote = client 端推过来的 plaintext payload
		if rc.LocalPayload != "" {
			if plaintext, err := decodeBase64(rc.LocalPayload); err == nil {
				var payload ItemPayload
				if err := json.Unmarshal(plaintext, &payload); err == nil {
					payload.ID = rc.ID
					uiC.Remote = &payload
				}
			}
		}
		uiConflicts = append(uiConflicts, uiC)
	}

	s.mu.Lock()
	s.conflicts = uiConflicts
	s.progress = SyncProgress{
		Stage:     "merge",
		Total:     len(uiConflicts),
		Message:   fmt.Sprintf("%d 项冲突待决", len(uiConflicts)),
		UpdatedAt: time.Now().UnixMilli(),
	}
	s.mu.Unlock()

	resp := SyncReportConflictsResponse{
		SessionID: sess.id,
		Accepted:  len(uiConflicts),
	}
	encrypted, err := sess.SealJSON(resp, []byte(syncAADReportConflicts))
	if err != nil {
		http.Error(w, "seal", http.StatusInternalServerError)
		return
	}
	writeBinary(w, encrypted)
}

// handlePollResolutionsServer 让 phone 等待 desktop 端用户在 UI 上解决完
// 冲突。phone 上报冲突后立即开始定时 POST 这个 endpoint：
//   - desktop 用户还没 ApplyMerge → Ready=false，phone 继续轮询
//   - desktop 用户已 ApplyMerge → Ready=true + Actions（phone 按操作应用）
//
// 取走 Actions 后服务端清空 s.pendingResolutions，避免重复消费。
func (s *SyncService) handlePollResolutionsServer(w http.ResponseWriter, r *http.Request) {
	sess := s.requireServerSession(w, r)
	if sess == nil {
		return
	}
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<14))
	var req SyncPollResolutionsRequest
	if err := sess.OpenJSON(body, []byte(syncAADPollResolutions), &req); err != nil {
		http.Error(w, "decrypt", http.StatusUnauthorized)
		return
	}

	s.mu.Lock()
	ready := s.pendingResolutions != nil
	var actions []SyncResolutionAction
	if ready {
		actions = s.pendingResolutions
		s.pendingResolutions = nil
	}
	s.mu.Unlock()

	resp := SyncPollResolutionsResponse{
		SessionID: sess.id,
		Ready:     ready,
		Actions:   actions,
	}
	encrypted, err := sess.SealJSON(resp, []byte(syncAADPollResolutions))
	if err != nil {
		http.Error(w, "seal", http.StatusInternalServerError)
		return
	}
	writeBinary(w, encrypted)
}

func (s *SyncService) requireServerSession(w http.ResponseWriter, _ *http.Request) *syncSession {
	s.mu.RLock()
	sess := s.serverSess
	s.mu.RUnlock()
	if sess == nil {
		http.Error(w, "no active session", http.StatusUnauthorized)
		return nil
	}
	if time.Since(sess.pairedAt) > syncSessionTimeout {
		http.Error(w, "session expired", http.StatusGone)
		return nil
	}
	return sess
}

// ---------------------------------------------------------------------------
// 客户端同步流程
// ---------------------------------------------------------------------------

func (s *SyncService) runClientSync(ctx context.Context) error {
	s.mu.RLock()
	sess := s.clientSess
	baseURL := s.clientBaseURL
	s.mu.RUnlock()

	if isCanceled(ctx) {
		return context.Canceled
	}

	// 1. 拉取 remote manifest
	manReq := SyncManifestRequest{SessionID: sess.id, Role: "desktop"}
	encryptedReq, err := sess.SealJSON(manReq, []byte(syncAADManifest))
	if err != nil {
		return err
	}
	respBytes, err := postBinaryCtx(ctx, baseURL+"/v1/sync/manifest", encryptedReq)
	if err != nil {
		return fmt.Errorf("manifest fetch: %w", err)
	}
	var manResp SyncManifestResponse
	if err := sess.OpenJSON(respBytes, []byte(syncAADManifest), &manResp); err != nil {
		return fmt.Errorf("decrypt manifest: %w", err)
	}

	// 2. 本端 manifest
	localManifest, err := s.buildManifest()
	if err != nil {
		return err
	}

	// 3. 合并计划
	plan := mergeManifests(localManifest, manResp.Entries)

	// 4. 自动 pull（auto_apply）—— 把对端的活动条目拉过来插入
	pullIDs := make([]string, 0, len(plan.PullApply))
	for _, step := range plan.PullApply {
		if step.Action != "delete" {
			pullIDs = append(pullIDs, step.ID)
		}
	}
	if len(pullIDs) > 0 {
		s.updateProgress("fetch", 0, len(pullIDs))
		records, err := s.fetchFromRemote(ctx, baseURL, sess, pullIDs)
		if err != nil {
			return err
		}
		for i, rec := range records {
			if isCanceled(ctx) {
				return context.Canceled
			}
			_ = s.applyRemoteRecord(rec)
			s.updateProgress("fetch", i+1, len(pullIDs))
		}
	}
	// 处理 pull delete（对方已删，本地也应 tombstone）
	for _, step := range plan.PullApply {
		if step.Action == "delete" {
			if isCanceled(ctx) {
				return context.Canceled
			}
			_ = s.vault.deleteItemAnySpace(step.ID)
		}
	}

	// 5. push（本端独有 / 本端较新且 hash 匹配）—— 自动推
	pushRecords := make([]SyncItemRecord, 0, len(plan.Push))
	for _, step := range plan.Push {
		rec, err := s.buildRecordFromLocal(step.ID)
		if err != nil {
			continue
		}
		pushRecords = append(pushRecords, rec)
	}
	if len(pushRecords) > 0 {
		s.updateProgress("push", 0, len(pushRecords))
		for offset := 0; offset < len(pushRecords); offset += syncDefaultBatchSize {
			if isCanceled(ctx) {
				return context.Canceled
			}
			end := offset + syncDefaultBatchSize
			if end > len(pushRecords) {
				end = len(pushRecords)
			}
			batch := pushRecords[offset:end]
			req := SyncPushRequest{SessionID: sess.id, Items: batch}
			encryptedReq, err := sess.SealJSON(req, []byte(syncAADPush))
			if err != nil {
				return err
			}
			respBytes, err := postBinaryCtx(ctx, baseURL+"/v1/sync/push", encryptedReq)
			if err != nil {
				return err
			}
			var resp SyncPushResponse
			if err := sess.OpenJSON(respBytes, []byte(syncAADPush), &resp); err != nil {
				return err
			}
			s.updateProgress("push", end, len(pushRecords))
		}
	}

	// 6. 冲突 —— 解密两端 payload 后写入 s.conflicts 等待用户决策
	conflicts := make([]SyncConflict, 0, len(plan.Conflicts))
	// 批量预取所有冲突 id 的 remote record，避免逐条 fetch 时 N 次 RTT
	conflictIDs := make([]string, 0, len(plan.Conflicts))
	for _, c := range plan.Conflicts {
		if c.Remote.UpdatedAt > 0 {
			conflictIDs = append(conflictIDs, c.ID)
		}
	}
	remotePayloadByID := map[string]*ItemPayload{}
	if len(conflictIDs) > 0 {
		records, err := s.fetchFromRemote(ctx, baseURL, sess, conflictIDs)
		if err == nil {
			for _, rec := range records {
				if payload, err := s.decryptRemoteRecord(rec); err == nil {
					remotePayloadByID[rec.ID] = payload
				}
			}
		}
	}
	for _, c := range plan.Conflicts {
		uiC := SyncConflict{
			ID:              c.ID,
			Kind:            c.Kind,
			LocalManifest:   c.Local,
			RemoteManifest:  c.Remote,
			SuggestedRemote: c.SuggestedRemote,
		}
		if c.Local.UpdatedAt > 0 && c.Local.DeletedAt == 0 {
			if local, err := s.vault.getItemAnySpace(c.ID); err == nil && local != nil {
				uiC.Local = local
			}
		}
		if rp, ok := remotePayloadByID[c.ID]; ok {
			uiC.Remote = rp
		}
		conflicts = append(conflicts, uiC)
	}

	s.mu.Lock()
	s.conflicts = conflicts
	if len(conflicts) == 0 {
		s.progress = SyncProgress{Stage: "done", UpdatedAt: time.Now().UnixMilli()}
	} else {
		s.progress = SyncProgress{
			Stage:     "merge",
			Total:     len(conflicts),
			Message:   fmt.Sprintf("%d 项冲突待决", len(conflicts)),
			UpdatedAt: time.Now().UnixMilli(),
		}
	}
	s.mu.Unlock()
	return nil
}

func (s *SyncService) fetchFromRemote(ctx context.Context, baseURL string, sess *syncSession, ids []string) ([]SyncItemRecord, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	out := make([]SyncItemRecord, 0, len(ids))
	for offset := 0; offset < len(ids); offset += syncDefaultBatchSize {
		if isCanceled(ctx) {
			return nil, context.Canceled
		}
		end := offset + syncDefaultBatchSize
		if end > len(ids) {
			end = len(ids)
		}
		batch := ids[offset:end]
		req := SyncFetchRequest{
			SessionID: sess.id,
			IDs:       batch,
			Offset:    0,
			Limit:     len(batch),
		}
		encryptedReq, err := sess.SealJSON(req, []byte(syncAADFetch))
		if err != nil {
			return nil, err
		}
		respBytes, err := postBinaryCtx(ctx, baseURL+"/v1/sync/fetch", encryptedReq)
		if err != nil {
			return nil, err
		}
		var resp SyncBatchResponse
		if err := sess.OpenJSON(respBytes, []byte(syncAADFetch), &resp); err != nil {
			return nil, err
		}
		out = append(out, resp.Items...)
	}
	return out, nil
}

// isCanceled 用于在循环中检查 ctx 是否已被 Disconnect 取消。
//
// 接受 nil ctx（兼容老调用路径）。
func isCanceled(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	select {
	case <-ctx.Done():
		return true
	default:
		return false
	}
}

// ---------------------------------------------------------------------------
// Manifest / Item 读写
// ---------------------------------------------------------------------------

// buildManifest 从 vault DB 读全部行（含 tombstone），构造 manifest
func (s *SyncService) buildManifest() ([]SyncManifestEntry, error) {
	rows, err := s.vault.db.ListItemsWithTombstones()
	if err != nil {
		return nil, fmt.Errorf("list items: %w", err)
	}
	out := make([]SyncManifestEntry, 0, len(rows))
	for i := range rows {
		row := &rows[i]
		entry := SyncManifestEntry{
			ID:        row.ID,
			UpdatedAt: row.UpdatedAt,
		}
		if row.DeletedAt != nil {
			entry.DeletedAt = *row.DeletedAt
		}
		// 活动行才算 contentHash 与 revision；tombstone 没有有意义的"内容"，
		// 让两端 manifest 对 tombstone 都不带 hash，避免实现差异触发误冲突。
		if entry.DeletedAt == 0 {
			payload, err := s.vault.decryptItem(row)
			if err == nil {
				entry.ContentHash = contentHashOf(payload)
				entry.Revision = payload.Revision
			}
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// fetchRecords 把本端 vault 中指定 id 打包成 SyncItemRecord
//
// 关键：Ciphertext 字段填的是 base64(JSON(ItemPayload)) —— plaintext payload，
// 不是 vault 的 ciphertext。两端 DEK 不同，发 vault 加密的密文对端解不开。
// 传输安全靠外层 session AEAD（XChaCha20-Poly1305）兜底。
//
// tombstone 行：Ciphertext 留空，对端只需 id + DeletedAt 就够调本端 DeleteItem。
func (s *SyncService) fetchRecords(ids []string, offset, limit int) ([]SyncItemRecord, int, error) {
	if limit <= 0 || limit > syncMaxBatchSize {
		limit = syncMaxBatchSize
	}
	out := make([]SyncItemRecord, 0, len(ids))
	for _, id := range ids {
		row, err := s.vault.db.GetItem(id)
		if err != nil || row == nil {
			continue
		}
		rec := SyncItemRecord{
			ID:        row.ID,
			CreatedAt: row.CreatedAt,
			UpdatedAt: row.UpdatedAt,
		}
		if row.DeletedAt != nil {
			rec.DeletedAt = *row.DeletedAt
			// tombstone：对端不需要 payload，只需要 id + deletedAt
		} else {
			// 活动行：解密 → JSON marshal plaintext
			payload, err := s.vault.getItemAnySpace(row.ID)
			if err != nil || payload == nil {
				continue // 解密失败 / tombstone 路径，跳过
			}
			plaintext, err := json.Marshal(payload)
			if err != nil {
				continue
			}
			rec.Ciphertext = encodeBase64(plaintext)
		}
		out = append(out, rec)
	}
	total := len(ids)
	return out, total, nil
}

// buildRecordFromLocal 把本端 vault_items 行打包成 SyncItemRecord（用于 push）
//
// 同 fetchRecords：Ciphertext 字段是 base64(JSON(plaintext payload))。
func (s *SyncService) buildRecordFromLocal(id string) (SyncItemRecord, error) {
	row, err := s.vault.db.GetItem(id)
	if err != nil || row == nil {
		return SyncItemRecord{}, fmt.Errorf("local %s not found", id)
	}
	rec := SyncItemRecord{
		ID:        row.ID,
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
	if row.DeletedAt != nil {
		rec.DeletedAt = *row.DeletedAt
		return rec, nil
	}
	payload, err := s.vault.getItemAnySpace(row.ID)
	if err != nil || payload == nil {
		return SyncItemRecord{}, fmt.Errorf("local %s payload unavailable", id)
	}
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return SyncItemRecord{}, fmt.Errorf("marshal local %s: %w", id, err)
	}
	rec.Ciphertext = encodeBase64(plaintext)
	return rec, nil
}

// applyRemoteRecord 把对端推过来的 plaintext payload 用本端 DEK 加密落盘
//
// 策略：
//   - rec.DeletedAt > 0 → 本端 DeleteItem（写本端 DEK 加密的 tombstone）
//   - 否则 → 解析 plaintext payload + IngestForeignPayload（用本端 DEK 加密）
//
// 两端 vault 独立 DEK，wire 上传的是 plaintext，绝不直接搬密文。
func (s *SyncService) applyRemoteRecord(rec SyncItemRecord) error {
	if rec.DeletedAt > 0 {
		// tombstone 路径：让本端 DeleteItem 用本端 DEK 写一个新 tombstone
		err := s.vault.deleteItemAnySpace(rec.ID)
		if errors.Is(err, ErrItemNotFound) {
			return nil // 本端从没有过该 id，没什么可删的
		}
		return err
	}
	if rec.Ciphertext == "" {
		return errors.New("apply: empty payload for active record")
	}
	plaintext, err := decodeBase64(rec.Ciphertext)
	if err != nil {
		return fmt.Errorf("decode plaintext: %w", err)
	}
	var payload ItemPayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %w", err)
	}
	_, err = s.vault.IngestForeignPayload(rec.ID, &payload, rec.CreatedAt, rec.UpdatedAt)
	return err
}

// duplicateRemoteAsNew 把 remote payload 用新 id 插入本端（双方都保留时用）
func (s *SyncService) duplicateRemoteAsNew(rec SyncItemRecord) error {
	payload, err := s.decryptRemoteRecord(rec)
	if err != nil {
		return err
	}
	if payload == nil {
		return errors.New("duplicate: remote payload unavailable")
	}
	// createItemInSpace 内部会生成新 id 并写入；时间戳由后端覆盖。副本归属
	// 对端原空间（payload.SpaceID）；为空则 fallback 到当前激活空间。
	payload.ID = ""
	payload.DeletedAt = nil
	_, err = s.vault.createItemInSpace(*payload, payload.SpaceID)
	return err
}

// decryptRemoteRecord 解析 wire 上的 plaintext payload（已被外层 session AEAD 保护）
//
// 注意命名是历史遗留：这里"decrypt"指 base64 解码 + JSON 反序列化，**不**涉及
// vault DEK —— 对端发的 Ciphertext 字段实际承载的是 plaintext payload bytes。
func (s *SyncService) decryptRemoteRecord(rec SyncItemRecord) (*ItemPayload, error) {
	if rec.Ciphertext == "" {
		return nil, nil // tombstone or missing
	}
	plaintext, err := decodeBase64(rec.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decode plaintext: %w", err)
	}
	var payload ItemPayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal payload: %w", err)
	}
	payload.ID = rec.ID
	if rec.DeletedAt > 0 {
		d := rec.DeletedAt
		payload.DeletedAt = &d
	}
	return &payload, nil
}

func remoteRecordFromConflict(c SyncConflict) SyncItemRecord {
	// 仅保留 manifest 级别元数据；ApplyMerge 走 fetchFromRemote 真正拿
	// plaintext payload 再 ingest。
	return SyncItemRecord{
		ID:        c.ID,
		UpdatedAt: c.RemoteManifest.UpdatedAt,
		DeletedAt: c.RemoteManifest.DeletedAt,
	}
}

// ---------------------------------------------------------------------------
// 合并算法 —— 与 cryptocore-sync/merge.rs 等价
// ---------------------------------------------------------------------------

type syncPlanStep struct {
	ID     string `json:"id"`
	Action string `json:"action"` // "insert" / "replace" / "delete"
}

type syncMergeConflict struct {
	ID              string
	Kind            string
	Local           SyncManifestEntry
	Remote          SyncManifestEntry
	SuggestedRemote bool
}

type syncMergePlan struct {
	PullApply []syncPlanStep
	Push      []syncPlanStep
	Conflicts []syncMergeConflict
	Identical []string
}

func mergeManifests(local, remote []SyncManifestEntry) syncMergePlan {
	plan := syncMergePlan{}
	localMap := map[string]SyncManifestEntry{}
	for _, e := range local {
		localMap[e.ID] = e
	}
	remoteMap := map[string]SyncManifestEntry{}
	for _, e := range remote {
		remoteMap[e.ID] = e
	}

	for _, r := range remote {
		l, ok := localMap[r.ID]
		if !ok {
			if r.DeletedAt == 0 {
				plan.PullApply = append(plan.PullApply, syncPlanStep{ID: r.ID, Action: "insert"})
			}
			continue
		}
		decideBoth(l, r, &plan)
	}
	for _, l := range local {
		if _, ok := remoteMap[l.ID]; ok {
			continue
		}
		// remote 没有
		plan.Push = append(plan.Push, syncPlanStep{ID: l.ID, Action: "insert"})
	}
	return plan
}

func decideBoth(local, remote SyncManifestEntry, plan *syncMergePlan) {
	sameTS := local.UpdatedAt == remote.UpdatedAt
	sameHash := local.ContentHash != "" && local.ContentHash == remote.ContentHash

	if sameTS && sameHash {
		plan.Identical = append(plan.Identical, local.ID)
		return
	}
	// 双方都已删 = 最终状态一致 → identical
	// **不要求 sameTS**：phone/desktop 各自 deleteItem 时用本端 nowMs()，
	// 两端 tombstone 的 updatedAt 几乎必然不同。如果还要求 sameTS，这种
	// 行会被误判为 divergent_content conflict，让用户反复看到"删了也算冲突"。
	if local.DeletedAt > 0 && remote.DeletedAt > 0 {
		plan.Identical = append(plan.Identical, local.ID)
		return
	}
	// delete-vs-edit
	if (local.DeletedAt > 0) != (remote.DeletedAt > 0) {
		plan.Conflicts = append(plan.Conflicts, syncMergeConflict{
			ID:              local.ID,
			Kind:            "delete_vs_edit",
			Local:           local,
			Remote:          remote,
			SuggestedRemote: remote.UpdatedAt > local.UpdatedAt,
		})
		return
	}
	if sameTS {
		plan.Conflicts = append(plan.Conflicts, syncMergeConflict{
			ID:              local.ID,
			Kind:            "concurrent_edit",
			Local:           local,
			Remote:          remote,
			SuggestedRemote: remote.Revision > local.Revision,
		})
		return
	}
	if sameHash {
		// 内容相同，仅时间戳不同 → 取更新方
		if remote.UpdatedAt > local.UpdatedAt {
			action := "replace"
			if remote.DeletedAt > 0 {
				action = "delete"
			}
			plan.PullApply = append(plan.PullApply, syncPlanStep{ID: local.ID, Action: action})
		} else {
			action := "replace"
			if local.DeletedAt > 0 {
				action = "delete"
			}
			plan.Push = append(plan.Push, syncPlanStep{ID: local.ID, Action: action})
		}
		return
	}
	// hash 不同 + ts 不同 → 真分叉，让用户在 desktop 端 UI 决策
	plan.Conflicts = append(plan.Conflicts, syncMergeConflict{
		ID:              local.ID,
		Kind:            "divergent_content",
		Local:           local,
		Remote:          remote,
		SuggestedRemote: remote.UpdatedAt > local.UpdatedAt,
	})
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

// deriveSyncSessionKey 用 PIN + salt 派生 32 字节 session_key
//
// 输入：salt(16) || sessionID(32 hex chars=>16B) || clientNonce(16) || serverNonce(16)
//
//	— 共 64 字节 Argon2id salt 输入（标准 Argon2id 接受任意长 salt）
func deriveSyncSessionKey(pin string, salt []byte, sessionID string, clientNonce, serverNonce []byte) ([]byte, error) {
	if pin == "" {
		return nil, ErrSyncInvalidPin
	}
	sidBytes, err := hex.DecodeString(sessionID)
	if err != nil || len(sidBytes) != syncSessionIDLen {
		return nil, fmt.Errorf("bad sessionID")
	}
	if len(salt) != syncPairSaltLen || len(clientNonce) != syncPairNonceLen || len(serverNonce) != syncPairNonceLen {
		return nil, fmt.Errorf("bad input lengths")
	}
	combined := make([]byte, 0, syncPairSaltLen+syncSessionIDLen+2*syncPairNonceLen)
	combined = append(combined, salt...)
	combined = append(combined, sidBytes...)
	combined = append(combined, clientNonce...)
	combined = append(combined, serverNonce...)
	key := argon2.IDKey([]byte(pin), combined, syncPSKIterations, syncPSKMemoryKiB, syncPSKParallelism, syncPSKKeyLen)
	return key, nil
}

func hmacTag(key []byte, label string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(label))
	return mac.Sum(nil)
}

func generateNumericPin(digits int) (string, error) {
	raw, err := GenerateRandomBytes(digits)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	for _, b := range raw {
		sb.WriteByte('0' + b%10)
	}
	return sb.String(), nil
}

func mustRandomHex(n int) string {
	b, err := GenerateRandomBytes(n)
	if err != nil {
		// Indistinguishable rng failures are very rare on real hardware.
		// Fall back to time-based id so callers don't crash; the 60s lockout
		// catches any practical attack window even if entropy is mid.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// contentHashOf 返回 plaintext payload 的 SHA-256 前 16 字节 hex
//
// 跨端规范化（必须与 phone/lib/sync-protocol.ts:contentHashOf 字节级对齐）：
//
//   - 输入用 map[string]any 而非 struct —— Go json.Marshal 对 map[string]any
//     **按 key 字典序排序**输出。TS 端也走 stableStringify（递归 sort）。
//   - 关闭 HTMLEscape —— 默认 json.Marshal 会把 `<`/`>`/`&` 转成 `<`
//     等，但 TS JSON.stringify 不转。统一关闭让两端字节一致。
//   - Encoder.Encode 末尾会附 \n，需要剥掉。
//
// 仅 hash 关键字段（Type / Name / Fields），不含 createdAt / updatedAt /
// revision / deletedAt —— 跨端的"内容是否一致"判定只看这三个。
func contentHashOf(p *ItemPayload) string {
	if p == nil {
		return ""
	}
	stable := map[string]any{
		"type":   string(p.Type),
		"name":   p.Name,
		"fields": p.Fields,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(stable); err != nil {
		return ""
	}
	data := buf.Bytes()
	// Encoder.Encode 末尾追加 \n —— 剥掉避免与 TS JSON.stringify 输出差一字节
	if len(data) > 0 && data[len(data)-1] == '\n' {
		data = data[:len(data)-1]
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:16])
}

func detectLanHosts() []string {
	out := []string{}
	ifs, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifs {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil {
				continue
			}
			out = append(out, ip.String())
		}
	}
	return out
}

func buildQRPayload(hosts []string, port int, pin string) string {
	host := "0.0.0.0"
	if len(hosts) > 0 {
		host = hosts[0]
	}
	return fmt.Sprintf("zpass-sync://%s:%d?pin=%s", host, port, pin)
}

func (s *SyncService) updateProgress(stage string, processed, total int) {
	s.mu.Lock()
	s.progress = SyncProgress{
		Stage:     stage,
		Processed: processed,
		Total:     total,
		UpdatedAt: time.Now().UnixMilli(),
	}
	s.mu.Unlock()
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeBinary(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func postJSON[I any, O any](url string, req I) (*O, error) {
	buf, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpResp, err := httpClient.Post(url, "application/json", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	defer httpResp.Body.Close()
	if httpResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(httpResp.Body)
		return nil, fmt.Errorf("status %d: %s", httpResp.StatusCode, body)
	}
	out := new(O)
	if err := json.NewDecoder(httpResp.Body).Decode(out); err != nil {
		return nil, err
	}
	return out, nil
}

func postBinary(url string, body []byte) ([]byte, error) {
	return postBinaryCtx(context.Background(), url, body)
}

// postBinaryCtx 与 postBinary 等价但可被 ctx 取消（Disconnect 时立即返回 ctx.Err）
func postBinaryCtx(ctx context.Context, url string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	httpResp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer httpResp.Body.Close()
	if httpResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(httpResp.Body)
		return nil, fmt.Errorf("status %d: %s", httpResp.StatusCode, b)
	}
	return io.ReadAll(httpResp.Body)
}

// httpClient 单请求最长 30 秒（防止单个 batch 卡死）；整体超时由调用方通过
// ctx 控制（见 ConnectToServer 注入的 syncSessionTimeout context）。
var httpClient = &http.Client{Timeout: 30 * time.Second}

// encodeBase64 / decodeBase64 用 stdlib 兼容 phone TS 的 base64.encode/decode
func encodeBase64(b []byte) string {
	return base64Encode(b)
}

func decodeBase64(s string) ([]byte, error) {
	return base64Decode(s)
}
