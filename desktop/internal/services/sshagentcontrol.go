// SSH agent 服务 —— 控制通道 server 端
// ---------------------------------------------------------------------------
// 本文件 GUI 进程侧的控制通道服务端实现。监听 unix socket / named pipe，
// 等 zpass-agent 守护进程连过来握手，建立长连接处理：
//
//   agent → GUI: SignRequest（请求签名）/ Ping
//   GUI → agent: PushKeys（推送公钥列表）/ State（解锁状态）/ SignReply
//
// agent 客户端实现见 cmd/zpass-agent/control.go。两端协议契约共享在
// internal/sshagentproto。
//
// ---------------------------------------------------------------------------
// 单连接模型
//
// MVP 阶段允许一次只有一个 agent 连进来（后到的会覆盖前面已连接的）。
// 实际部署模型也只会有一个 agent 实例（systemd / launchd 保证），多 agent
// 是异常路径。
//
// 多 agent 同时连的话：
//   - 第二个 connect 成功 + 握手成功后，旧连接会被替换
//   - 旧连接上的 sign 请求继续在旧 channel 上等（但 GUI 端推送 PushKeys
//     只会推到新连接），结果是旧 agent 看到的公钥列表过期。MVP 阶段不
//     处理这个细节，下版本可以选择 reject 第二个连接。
//
// ---------------------------------------------------------------------------
// 持久化的内部状态
//
// 即便 agent 还没连上，GUI 端也要把「当前应该推送的 keys + 解锁状态」
// 缓存下来 —— 一旦 agent 握手成功就立即下发。这避免「vault 先解锁再
// 启动 agent」的时序里 agent 拿不到 keys 的问题。

package services

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/zerx-lab/zpass/internal/sshagentproto"
)

// ---------------------------------------------------------------------------
// controlListener
// ---------------------------------------------------------------------------

// controlListener 是 GUI 进程侧的控制通道 server
//
// 维护：
//   - 底层 net.Listener（unix socket / named pipe）
//   - 缓存的最新 keys + unlocked 状态（供新连接握手后立即下发）
//   - 当前活跃连接（最多 1 个，新连接 accept 时取代旧的）
type controlListener struct {
	ln        net.Listener
	tokenPath string
	service   *SshAgentService
	logger    *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	mu sync.Mutex
	// 最新需要下推的 keys 快照（即便 agent 未连接也持有）
	pendingKeys []sshagentproto.PublicKeyEntry
	// 最新解锁状态（同 keys）
	pendingUnlocked bool

	// active 当前握手成功的连接，nil 时无 agent
	active *controlServerConn
}

// newControlListener 在 socketPath 上启动 listener
//
// 失败原因：
//   - socket 路径所在目录不存在 → 调用方应先确保 EnsureAgentDir
//   - 同名 socket 已被占用 → 视为另一个 ZPass GUI 在跑，返回错误
//     （MVP 阶段允许并发实例，但同时启用 SSH agent 服务会冲突）
func newControlListener(
	socketPath, tokenPath string,
	service *SshAgentService,
) (*controlListener, error) {
	ln, err := listenControlSocket(socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", socketPath, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cl := &controlListener{
		ln:        ln,
		tokenPath: tokenPath,
		service:   service,
		logger:    service.logger.With("subsystem", "controlListener"),
		ctx:       ctx,
		cancel:    cancel,
	}

	go cl.acceptLoop()
	return cl, nil
}

// Stop 关闭 listener + 断开所有连接
//
// 幂等（多次 Stop 是 no-op）。
func (c *controlListener) Stop() {
	c.cancel()
	_ = c.ln.Close()

	c.mu.Lock()
	active := c.active
	c.active = nil
	c.mu.Unlock()

	if active != nil {
		active.close("listener stopped")
	}
}

// UpdateKeys 缓存最新 keys 快照 + 如果有活跃连接则下推
//
// 由 SshAgentService.PushVaultKeys 调用。
func (c *controlListener) UpdateKeys(entries []sshagentproto.PublicKeyEntry) {
	c.mu.Lock()
	c.pendingKeys = entries
	active := c.active
	c.mu.Unlock()

	if active != nil {
		active.sendPushKeys(entries)
	}
}

// UpdateState 缓存最新解锁状态 + 下推
//
// 由 SshAgentService.NotifyVaultUnlocked / NotifyVaultLocked 调用。
func (c *controlListener) UpdateState(unlocked bool) {
	c.mu.Lock()
	c.pendingUnlocked = unlocked
	active := c.active
	c.mu.Unlock()

	if active != nil {
		active.sendState(unlocked)
	}
}

// snapshotPending 拿当前缓存的 keys + unlocked，握手成功时下推用
func (c *controlListener) snapshotPending() (keys []sshagentproto.PublicKeyEntry, unlocked bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pendingKeys, c.pendingUnlocked
}

// setActive 替换当前活跃连接（旧的会被关闭）
func (c *controlListener) setActive(conn *controlServerConn) {
	c.mu.Lock()
	prev := c.active
	c.active = conn
	c.service.activeConn = conn
	c.mu.Unlock()

	if prev != nil && prev != conn {
		prev.close("replaced by new agent connection")
	}
}

// clearActive 在连接关闭时清空 active 引用（仅在当前 active 等于 conn 时）
//
// 防御场景：旧连接关闭事件到达时，新连接可能已经替换 active，此时不应
// 把新连接也清掉。
func (c *controlListener) clearActive(conn *controlServerConn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active == conn {
		c.active = nil
		c.service.activeConn = nil
	}
}

// acceptLoop 持续 accept 新连接，每个连接起一个 goroutine 跑 serve
//
// ctx cancel → Stop 关 listener → Accept 返回 net.ErrClosed → 退出
func (c *controlListener) acceptLoop() {
	for {
		conn, err := c.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || c.ctx.Err() != nil {
				return
			}
			c.logger.Warn("accept failed", "err", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go c.serve(conn)
	}
}

// serve 处理单个 agent 连接：握手 → 注册 active → 读循环 → 清理
func (c *controlListener) serve(conn net.Conn) {
	defer conn.Close()

	// 读 token —— 每次新连接都重新读，让用户「重置 token」立即生效
	token, err := sshagentproto.ReadToken(c.tokenPath)
	if err != nil {
		c.logger.Warn("read token failed", "err", err)
		return
	}

	// 握手 —— GUI 是应答方
	if err := c.performHandshake(conn, token); err != nil {
		c.logger.Warn("handshake failed", "err", err)
		return
	}

	// 创建 serverConn 包装：内部启动 writer goroutine
	sc := newControlServerConn(conn, c.logger, c.service)
	c.setActive(sc)
	defer c.clearActive(sc)

	c.logger.Info("agent handshake ok")

	// 握手后立即下推当前缓存的 keys + state
	keys, unlocked := c.snapshotPending()
	sc.sendState(unlocked)
	sc.sendPushKeys(keys)

	// 阻塞在读循环直到连接关闭
	sc.readLoop(c.ctx)
}

// performHandshake GUI 端握手实现
//
// GUI 作为应答方：
//  1. 读 Hello{Nonce, Role}
//  2. 算 HMAC(token, nonce) + 协商版本
//  3. 发 HelloAck{NonceHMAC, AgreedVersion}
func (c *controlListener) performHandshake(conn net.Conn, token []byte) error {
	deadline := time.Now().Add(5 * time.Second)
	_ = conn.SetDeadline(deadline)
	defer conn.SetDeadline(time.Time{})

	env, err := sshagentproto.ReadFrame(conn)
	if err != nil {
		return fmt.Errorf("recv hello: %w", err)
	}
	if err := env.ValidateForOp(); err != nil {
		return fmt.Errorf("invalid hello: %w", err)
	}
	if env.Op != sshagentproto.OpHello {
		return fmt.Errorf("expected hello, got %q", env.Op)
	}
	if env.Role != sshagentproto.RoleAgent {
		// 防御性：role 必须是 agent，GUI 不能 hello GUI
		return fmt.Errorf("hello from unexpected role %q", env.Role)
	}

	// 解码 nonce —— validateForOp 已经校验长度
	nonce, err := hex.DecodeString(env.Nonce)
	if err != nil {
		return fmt.Errorf("decode nonce: %w", err)
	}

	// 协商版本
	agreedVersion, err := sshagentproto.NegotiateVersion(
		sshagentproto.MinSupportedVersion, sshagentproto.MaxSupportedVersion,
		env.MinVersion, env.MaxVersion,
	)
	if err != nil {
		return fmt.Errorf("negotiate version: %w", err)
	}

	// 算 HMAC
	mac := sshagentproto.ComputeNonceHMAC(token, nonce)

	ack := &sshagentproto.Envelope{
		Op:              sshagentproto.OpHelloAck,
		ProtocolVersion: sshagentproto.ProtocolVersion,
		AgreedVersion:   agreedVersion,
		NonceHMAC:       mac,
	}
	if err := sshagentproto.WriteFrame(conn, ack); err != nil {
		return fmt.Errorf("send hello_ack: %w", err)
	}
	return nil
}
