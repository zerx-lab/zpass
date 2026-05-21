// zpass-agent 守护进程 —— 与 GUI 的控制通道客户端
//
// ---------------------------------------------------------------------------
// 本文件职责
//
// **拓扑选择**：在 zpass-agent ↔ GUI 这条控制通道上，谁监听谁连接？
//
// 我们选择 **GUI 监听 + agent connect**。理由：
//
//  1. agent 是「常驻服务」，GUI 是「按需启动」。当 agent 已经在跑、GUI 还
//     没起来时，让 agent 主动 connect 会立即失败 —— 这正是我们想要的
//     「GUI 不在则签名失败」语义。如果反过来 GUI 监听 agent connect，
//     则 GUI 启动顺序不可控（启动早于 agent 时连不上，要做重试，复杂）。
//  2. GUI 端的 Wails Service 天然能在 Initialize 时启动 listener，无需
//     单独维护连接生命周期。
//  3. ssh 客户端连的是 agent 的 socket，agent connect GUI 的 socket，
//     物理上分得开 —— 用户不会把两条 socket 路径搞混。
//
// 因此：
//   - GUI 端：在 ControlSocketPath() 上 listen（见 sshagentservice.go）
//   - agent 端：connect 到同一路径，握手 → 复用同一长连接处理多消息
//
// ---------------------------------------------------------------------------
// 连接生命周期
//
// agent 启动后维护单条长连接，断线自动重连：
//
//	┌── connect 失败 ──► 退避重连（1s → 2s → 5s → 10s 上限）
//	│
//	connect ──► HELLO 握手 ──► 失败：关闭连接 + 重连
//	              │
//	              ▼ 成功
//	          注入 dispatcher 到 state
//	              │
//	              ▼
//	          读循环：接收 GUI 主动推送的 PushKeys / State / SignReply
//	              │
//	              ▼ EOF / 错误
//	          清理 state.SetDispatcher(nil) → 重连
//
// 单连接 + 多消息复用：所有 SignRequest / SignReply 共享同一物理通道。
// JSON 帧自带 reqID，并发 sign 请求不会混淆。
//
// ---------------------------------------------------------------------------
// 写并发安全
//
// 多个 SSH client 同时签名时，多个 goroutine 会通过 dispatchSignRequest
// 并发调 controlClient.send。net.Conn 的 Write 不保证并发安全（io.Writer
// 不要求），裸调可能交错字节让对端解析失败。
//
// 解决方案：内部 writeQueue (chan *Envelope) + 单 writer goroutine 串行
// 写出。RequestSign 端是 buffered send，对调用方零开销。

package main

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
// 重连策略
// ---------------------------------------------------------------------------

// 重连退避表 —— 单位秒
//
// 第 1 次失败立刻重试，之后用指数退避。10 秒上限避免「GUI 不在」时
// agent 进程占满 CPU 不停尝试连接。
var reconnectBackoffSeconds = []int{1, 2, 5, 10}

// writeQueueDepth 控制通道 outbound 消息队列长度
//
// 给突发并发签名留 buffer。32 远超日常使用 —— 一般用户不会有 32 个 ssh
// session 同时启动。超出时 RequestSign 端的 send 会阻塞（不直接丢消息），
// 协议正确性比丢消息更重要。
const writeQueueDepth = 32

// ---------------------------------------------------------------------------
// controlClient
// ---------------------------------------------------------------------------

// controlClient 管理 agent 到 GUI 的长连接
//
// 单例存在，由 main 创建。生命周期与 agent 进程对齐。
type controlClient struct {
	socketPath string
	tokenPath  string
	state      *AgentState
	logger     *slog.Logger

	// cancel 由 Run 启动的 ctx 派生，Stop 调用时触发让 Run 退出
	mu     sync.Mutex
	cancel context.CancelFunc

	// conn 当前活跃连接，仅 writer goroutine 持有写权
	// 由于读 / 写在不同 goroutine 但都需要访问，用 mu 短暂保护
	conn net.Conn

	// writeQueue 出站消息队列
	//
	// 由 RequestSign / SetUnlocked 等多 goroutine 投递，单个 writer
	// goroutine 消费。容量见 writeQueueDepth。
	//
	// 每次重连后重建 queue —— 旧 queue 里的消息属于旧连接，重连后
	// 不应该被发出（GUI 端可能已经重启状态了）。
	writeQueue chan *sshagentproto.Envelope
}

// newControlClient 构造 controlClient
//
// socketPath 与 tokenPath 通常来自 sshagentproto.ControlSocketPath()
// 和 sshagentproto.CapabilityTokenPath()。允许外部传入便于测试时用临
// 时路径。
func newControlClient(socketPath, tokenPath string, state *AgentState, logger *slog.Logger) *controlClient {
	return &controlClient{
		socketPath: socketPath,
		tokenPath:  tokenPath,
		state:      state,
		logger:     logger,
	}
}

// Run 启动连接 + 自动重连主循环
//
// 阻塞直到 ctx 取消或不可恢复的错误。调用方应在 goroutine 中调用：
//
//	go client.Run(ctx)
//
// 错误恢复策略：
//   - connect 失败 → 按 reconnectBackoffSeconds 退避重试
//   - 握手失败 → 退避重试（GUI 可能在升级 token / 启动中）
//   - 读循环 EOF → 立即重连（GUI 优雅退出 / 重启）
//   - 读循环非 EOF 错误 → log + 退避重连
func (c *controlClient) Run(ctx context.Context) {
	c.mu.Lock()
	innerCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	c.mu.Unlock()
	defer cancel()

	backoffIdx := 0
	for {
		// ctx 取消则退出
		select {
		case <-innerCtx.Done():
			return
		default:
		}

		err := c.runOnce(innerCtx)
		if err != nil {
			c.logger.Warn("controlClient connection ended",
				"err", err, "backoffIdx", backoffIdx)
		}

		// 计算等待时间
		wait := time.Duration(reconnectBackoffSeconds[backoffIdx]) * time.Second
		if backoffIdx < len(reconnectBackoffSeconds)-1 {
			backoffIdx++
		}

		// 等待时仍要响应 ctx 取消
		select {
		case <-innerCtx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// Stop 通知 Run 退出
//
// 幂等：多次调用 Stop 等价于一次。
func (c *controlClient) Stop() {
	c.mu.Lock()
	cancel := c.cancel
	conn := c.conn
	c.cancel = nil
	c.conn = nil
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if conn != nil {
		_ = conn.Close()
	}
}

// runOnce 完成单次连接的完整生命周期
//
// 返回 nil 时表示连接被外部 ctx 取消（不要重连）；非 nil 时调用方应
// 退避后重连。
func (c *controlClient) runOnce(ctx context.Context) error {
	// 读取 token —— 在 connect 之前；如果 token 文件不存在说明 GUI 还
	// 没启动过，等下一轮重试（GUI 起来会生成 token）
	token, err := sshagentproto.ReadToken(c.tokenPath)
	if err != nil {
		if errors.Is(err, sshagentproto.ErrTokenFileMissing) ||
			errors.Is(err, sshagentproto.ErrTokenFileInvalid) {
			return fmt.Errorf("token unavailable, GUI not initialized yet: %w", err)
		}
		return fmt.Errorf("read capability token: %w", err)
	}

	// connect
	conn, err := dialControl(ctx, c.socketPath)
	if err != nil {
		return fmt.Errorf("connect %s: %w", c.socketPath, err)
	}

	// 设置连接 + 重建 writeQueue
	c.mu.Lock()
	c.conn = conn
	c.writeQueue = make(chan *sshagentproto.Envelope, writeQueueDepth)
	c.mu.Unlock()

	defer func() {
		_ = conn.Close()
		c.state.SetDispatcher(nil) // 通知 state 当前没有可用 GUI
		c.mu.Lock()
		c.conn = nil
		c.writeQueue = nil
		c.mu.Unlock()
	}()

	// 握手 —— agent 作为发起方先发 Hello
	if err := c.performHandshake(ctx, conn, token); err != nil {
		return fmt.Errorf("handshake: %w", err)
	}

	c.logger.Info("controlClient handshake ok")

	// 握手成功是「GUI 正在使用本 agent」的明确信号 —— 重置 idle
	c.state.touchActivity()

	// 注入 dispatcher 让 state 可以转发 SignRequest
	c.state.SetDispatcher(c.enqueue)

	// 启动 writer goroutine
	writerDone := make(chan struct{})
	go c.writeLoop(conn, writerDone)

	// 主线程跑读循环
	readErr := c.readLoop(ctx, conn)

	// 关闭 writeQueue 让 writer 退出
	c.mu.Lock()
	q := c.writeQueue
	c.mu.Unlock()
	if q != nil {
		// drain + close —— writer 见 closed channel 退出
		// 不能用 select 关闭，必须用 close()
		// 但 producer 也会往里写，先把 dispatcher 撤掉再 close 才安全
		c.state.SetDispatcher(nil)
		close(q)
	}
	<-writerDone

	return readErr
}

// performHandshake 双向 hello 挑战应答
//
// agent 作为发起方：
//  1. 发 Hello{Nonce: ours_nonce, Role: agent}
//  2. 读 HelloAck{NonceHMAC: hmac(token, ours_nonce)}
//  3. 验证 hmac 通过 → 认证完成
//
// 注意单向认证 —— 我们不再让 GUI 也对 agent 发挑战，因为攻击者要么
// 能读 token 文件（那他能伪装任意一端）要么不能（他什么也做不了）。
func (c *controlClient) performHandshake(ctx context.Context, conn net.Conn, token []byte) error {
	// 设置握手阶段的超时 —— 避免恶意端口让我们卡在 read 上
	deadline := time.Now().Add(5 * time.Second)
	_ = conn.SetDeadline(deadline)
	defer conn.SetDeadline(time.Time{}) // 清除 deadline，让后续读循环 / 写循环自管

	// 生成 nonce
	nonce, err := sshagentproto.NewNonce()
	if err != nil {
		return fmt.Errorf("generate nonce: %w", err)
	}

	helloOut := &sshagentproto.Envelope{
		Op:              sshagentproto.OpHello,
		ProtocolVersion: sshagentproto.ProtocolVersion,
		MinVersion:      sshagentproto.MinSupportedVersion,
		MaxVersion:      sshagentproto.MaxSupportedVersion,
		Role:            sshagentproto.RoleAgent,
		Nonce:           hex.EncodeToString(nonce),
	}
	if err := sshagentproto.WriteFrame(conn, helloOut); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	ack, err := sshagentproto.ReadFrame(conn)
	if err != nil {
		return fmt.Errorf("recv hello_ack: %w", err)
	}
	if err := ack.ValidateForOp(); err != nil {
		return fmt.Errorf("invalid hello_ack: %w", err)
	}
	if ack.Op != sshagentproto.OpHelloAck {
		return fmt.Errorf("expected hello_ack, got %q", ack.Op)
	}
	if !sshagentproto.VerifyNonceHMAC(token, nonce, ack.NonceHMAC) {
		return errors.New("hello_ack hmac mismatch (token may differ between GUI and agent)")
	}

	// 协商版本 —— 这里 GUI 提交 AgreedVersion，我们做合理性检查
	if ack.AgreedVersion < sshagentproto.MinSupportedVersion ||
		ack.AgreedVersion > sshagentproto.MaxSupportedVersion {
		return fmt.Errorf("agreed protocol version %d not supported by agent (range [%d,%d])",
			ack.AgreedVersion, sshagentproto.MinSupportedVersion, sshagentproto.MaxSupportedVersion)
	}

	_ = ctx // ctx 暂未在握手内部使用，预留给将来「握手期间也允许取消」
	return nil
}

// enqueue 把 envelope 放入 writeQueue 发送
//
// 这是注入到 state.SetDispatcher 的回调。多 goroutine 安全（chan 自带）。
//
// writeQueue 已被关闭（连接断开）→ 返回 ErrGUIUnavailable 让 RequestSign
// 立即失败而非卡死。
func (c *controlClient) enqueue(env *sshagentproto.Envelope) error {
	c.mu.Lock()
	q := c.writeQueue
	c.mu.Unlock()
	if q == nil {
		return ErrGUIUnavailable
	}
	// 带超时的 send —— 队列满时给 500ms 等 writer 消费
	select {
	case q <- env:
		return nil
	case <-time.After(500 * time.Millisecond):
		return errors.New("controlClient write queue full")
	}
}

// writeLoop 单 writer goroutine，从 writeQueue 串行写到 conn
//
// 退出条件：writeQueue closed。写 error 不退出 —— 由读循环统一感知
// 连接断开后让外层关闭 queue。
func (c *controlClient) writeLoop(conn net.Conn, done chan struct{}) {
	defer close(done)
	c.mu.Lock()
	q := c.writeQueue
	c.mu.Unlock()
	if q == nil {
		return
	}
	for env := range q {
		if err := sshagentproto.WriteFrame(conn, env); err != nil {
			c.logger.Warn("writeLoop frame write failed", "op", env.Op, "err", err)
			// 不退出，继续读 queue —— 否则 producer 阻塞在 send 上。
			// 当连接彻底断开时 readLoop 会感知并触发 queue 关闭。
		}
	}
}

// readLoop 持续读取 GUI 主动推送的消息
//
// 处理的消息类型：
//   - OpPushKeys → state.ReplaceKeys
//   - OpState    → state.SetUnlocked
//   - OpSignReply → state.DeliverSignReply
//   - OpPing     → 回 Pong
//   - OpGoodbye  → 优雅退出
//
// 返回错误时调用方应当关闭连接 + 重连。返回 nil 仅在 ctx 取消时。
func (c *controlClient) readLoop(ctx context.Context, conn net.Conn) error {
	for {
		// ctx 取消立即退出
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		env, err := sshagentproto.ReadFrame(conn)
		if err != nil {
			return fmt.Errorf("read frame: %w", err)
		}
		if err := env.ValidateForOp(); err != nil {
			c.logger.Warn("readLoop invalid envelope", "op", env.Op, "err", err)
			return fmt.Errorf("invalid envelope: %w", err)
		}

		switch env.Op {
		case sshagentproto.OpPushKeys:
			c.state.ReplaceKeys(env.Keys)
			c.logger.Info("PushKeys received", "count", len(env.Keys))
		case sshagentproto.OpState:
			c.state.SetUnlocked(env.Unlocked)
			c.logger.Info("State received", "unlocked", env.Unlocked)
		case sshagentproto.OpSignReply:
			result := decodeSignReply(env)
			c.state.DeliverSignReply(env.ReqID, result)
		case sshagentproto.OpPing:
			// 回 Pong 走 enqueue 让 writer 串行发，不直接写 conn 避免并发
			_ = c.enqueue(&sshagentproto.Envelope{Op: sshagentproto.OpPong})
		case sshagentproto.OpGoodbye:
			c.logger.Info("GUI sent goodbye", "reason", env.Reason)
			return nil
		default:
			c.logger.Warn("readLoop unknown op", "op", env.Op)
			// 不退出 —— 容忍 GUI 未来加新 op；只是忽略
		}
	}
}

// decodeSignReply 把 SignReply envelope 解码为 SignResult
//
// 校验：
//   - Error 非空 → SignResult{Err: error}
//   - 否则 base64 解码 Signature → 字节切片
//
// 解码失败也视为 Err 路径 —— 让 RequestSign 拿到诚实的错误而非乱字节。
func decodeSignReply(env *sshagentproto.Envelope) SignResult {
	if env.Error != "" {
		return SignResult{Err: errors.New(env.Error)}
	}
	sig, err := b64StdEncoding.DecodeString(env.Signature)
	if err != nil {
		return SignResult{Err: fmt.Errorf("decode signature: %w", err)}
	}
	return SignResult{
		Signature:       sig,
		SignatureFormat: env.SignatureFormat,
	}
}

// dialControl 在指定 socketPath 上发起连接
//
// 平台分支：
//   - linux / darwin → net.Dial("unix", path)
//   - windows        → winio.DialPipe(path, ...)（见 dial_windows.go）
//
// 用 build tag 分开避免在非 Windows 上引入 winio 依赖。
//
// ctx 用于取消阻塞的 dial（Windows pipe DialPipe 支持 ctx，unix socket
// net.Dial 不支持 ctx 但有 deadline；这里统一加 5 秒 timeout 兜底）。
func dialControl(ctx context.Context, socketPath string) (net.Conn, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return dialControlPlatform(dialCtx, socketPath)
}
