// SSH agent 服务 —— 控制通道单连接处理
// ---------------------------------------------------------------------------
// 本文件实现 GUI 与单个 zpass-agent 连接的双向消息处理：
//
//   - 一个 writer goroutine 串行 send envelope（防 net.Conn.Write 并发交错）
//   - 一个 reader（在 controlListener.serve 中直接跑）处理 agent 推来的 op
//
// 内部状态：lastPushedKeyCount（给 Status() 用）。

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zerx-lab/zpass/zpass-desktop/internal/sshagentproto"
)

// controlServerConnWriteQueueDepth 出站消息队列长度
//
// 32 远超日常使用 —— GUI 主动推消息频率很低（vault 变更才推 PushKeys），
// 主要的并发来源是 SignReply（一个 agent 进来的并发 SignRequest 数 = 同时
// 在跑的 ssh 命令数）。
const controlServerConnWriteQueueDepth = 32

// controlServerConn 是单个 agent 连接的封装
//
// 用结构体而非裸 net.Conn：要管理 writer goroutine、关闭幂等、读快照
// 等状态，封装成对象更内聚。
type controlServerConn struct {
	conn    net.Conn
	logger  *slog.Logger
	service *SshAgentService

	writeQueue chan *sshagentproto.Envelope

	closeOnce sync.Once
	closed    chan struct{}

	// keyCount 最后一次 sendPushKeys 推送的 entry 数（atomic 读避免锁）
	keyCount atomic.Int32
}

// newControlServerConn 建立连接对象 + 启动 writer goroutine
//
// 调用方应在握手成功后调用，conn 必须已经处于「正常字节流」状态
// （没有未读的握手字节）。
func newControlServerConn(
	conn net.Conn,
	logger *slog.Logger,
	service *SshAgentService,
) *controlServerConn {
	sc := &controlServerConn{
		conn:       conn,
		logger:     logger.With("conn", conn.RemoteAddr().String()),
		service:    service,
		writeQueue: make(chan *sshagentproto.Envelope, controlServerConnWriteQueueDepth),
		closed:     make(chan struct{}),
	}
	go sc.writeLoop()
	return sc
}

// close 关闭连接（幂等）
//
// reason 仅记录在日志；不发 Goodbye envelope —— 调用方可以在 close 前
// 主动 sendGoodbye，但通常网络层断开足够清晰。
func (sc *controlServerConn) close(reason string) {
	sc.closeOnce.Do(func() {
		sc.logger.Info("closing connection", "reason", reason)
		close(sc.closed)
		_ = sc.conn.Close()
	})
}

// lastPushedKeyCount 给 Status() 用
func (sc *controlServerConn) lastPushedKeyCount() int {
	return int(sc.keyCount.Load())
}

// ---------------------------------------------------------------------------
// 出站消息
// ---------------------------------------------------------------------------

// sendPushKeys 给 agent 推送公钥列表（全量替换）
//
// 不阻塞调用方：失败时只 log warn，让上层重试或忽略。
func (sc *controlServerConn) sendPushKeys(entries []sshagentproto.PublicKeyEntry) {
	if entries == nil {
		// 让 JSON 序列化为 [] 而非 null —— agent 端代码兼容两种，
		// 但 [] 更明确表达「空列表」语义
		entries = []sshagentproto.PublicKeyEntry{}
	}
	env := &sshagentproto.Envelope{
		Op:   sshagentproto.OpPushKeys,
		Keys: entries,
	}
	sc.keyCount.Store(int32(len(entries)))
	sc.enqueue(env)
}

// sendState 推送解锁状态
func (sc *controlServerConn) sendState(unlocked bool) {
	env := &sshagentproto.Envelope{
		Op:       sshagentproto.OpState,
		Unlocked: unlocked,
	}
	sc.enqueue(env)
}

// sendSignReply 给 agent 回签名结果
//
// 由 readLoop 在 SignRequest 处理完后调用。
func (sc *controlServerConn) sendSignReply(reqID uint64, signature []byte, format string, errMsg string) {
	env := &sshagentproto.Envelope{
		Op:    sshagentproto.OpSignReply,
		ReqID: reqID,
	}
	if errMsg != "" {
		env.Error = errMsg
	} else {
		env.Signature = b64StdEncodingForGUI.EncodeToString(signature)
		env.SignatureFormat = format
	}
	sc.enqueue(env)
}

// enqueue 把 envelope 放进 writeQueue
//
// 队列满时（agent 不消费）丢消息 + log warn —— 阻塞会让整个 GUI 调用链
// 卡死，宁可丢消息也不卡。GUI 是「请求驱动」无心跳，丢一个 push 不会
// 影响下次推送。
func (sc *controlServerConn) enqueue(env *sshagentproto.Envelope) {
	select {
	case sc.writeQueue <- env:
	case <-sc.closed:
		// 已关闭，丢消息
	default:
		sc.logger.Warn("write queue full, dropping envelope", "op", env.Op)
	}
}

// writeLoop 单 writer goroutine
//
// 退出条件：sc.closed 关闭。退出前会 drain 队列让 in-flight 消息有机会发出
// （但仍可能因 conn 已关闭而失败）。
func (sc *controlServerConn) writeLoop() {
	for {
		select {
		case <-sc.closed:
			return
		case env := <-sc.writeQueue:
			if err := sshagentproto.WriteFrame(sc.conn, env); err != nil {
				// 写失败通常意味着 agent 端已断开；让 reader 感知并触发 close
				sc.logger.Warn("write frame failed", "op", env.Op, "err", err)
				_ = sc.conn.Close()
				return
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 入站读循环
// ---------------------------------------------------------------------------

// readLoop 持续读取 agent 推来的 envelope 并 dispatch
//
// 阻塞调用，由 controlListener.serve 直接 invoke。
//
// 退出条件：
//   - 连接关闭 / EOF
//   - ctx cancel（Stop 被调）
//   - 协议错误（ValidateForOp 失败）
//
// SignRequest 处理在独立 goroutine 中跑（私钥解析 + 签名可能耗时），
// 不阻塞读循环。
func (sc *controlServerConn) readLoop(ctx context.Context) {
	defer sc.close("read loop ended")

	for {
		// 不在 ReadFrame 之前做 ctx select —— ReadFrame 内部是阻塞 IO，
		// 我们靠外部 close(conn) 让 ReadFrame 返回 error。
		env, err := sshagentproto.ReadFrame(sc.conn)
		if err != nil {
			if ctx.Err() != nil {
				return // ctx cancel：正常退出
			}
			sc.logger.Info("read loop ending", "err", err)
			return
		}
		if err := env.ValidateForOp(); err != nil {
			sc.logger.Warn("invalid envelope", "op", env.Op, "err", err)
			return // 协议错误，关连接
		}

		switch env.Op {
		case sshagentproto.OpSignRequest:
			// 独立 goroutine 处理 —— 签名可能需要弹窗等几秒到几十秒
			go sc.handleSignRequest(ctx, env)
		case sshagentproto.OpPong:
			// 心跳响应，无需处理
		case sshagentproto.OpGoodbye:
			sc.logger.Info("agent sent goodbye", "reason", env.Reason)
			return
		default:
			sc.logger.Warn("unknown op from agent", "op", env.Op)
		}
	}
}

// handleSignRequest 处理签名请求
//
// 流程：
//  1. base64 解码 data
//  2. 调 SshAgentService.HandleSignRequest 走完整签名流程
//  3. 回 SignReply
//
// 错误都被翻译成 SignReply{Error: msg} 让 agent 转 SSH_AGENT_FAILURE 给客户端。
func (sc *controlServerConn) handleSignRequest(ctx context.Context, env *sshagentproto.Envelope) {
	data, err := b64StdEncodingForGUI.DecodeString(env.Data)
	if err != nil {
		sc.sendSignReply(env.ReqID, nil, "", fmt.Sprintf("decode data: %v", err))
		return
	}

	// 加 30 秒 timeout —— 即便用户的确认窗未来落地，30 秒也够看 + 确认
	signCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	sig, format, err := sc.service.HandleSignRequestExt(
		signCtx,
		env.Fingerprint,
		data,
		env.Flags,
		env.ClientPID,
		env.ClientExe,
		env.ClientExeHash,
	)
	if err != nil {
		// 把内部错误翻译成对 UI 友好的字符串
		msg := translateSignError(err)
		sc.sendSignReply(env.ReqID, nil, "", msg)
		return
	}

	sc.sendSignReply(env.ReqID, sig, format, "")
}

// translateSignError 把内部错误翻译成对 UI 友好的字符串
//
// agent 收到 SignReply{Error: msg} 后会原样翻译为 SSH agent 协议的失败
// 响应，最终 ssh / git 客户端看到的就是这条 msg。所以应当：
//   - 简短：一行内描述清楚
//   - 不泄露内部细节（文件路径、内部 errno 等）
//   - 用户能理解：「主密码错误」「私钥已损坏」而非 "ParseFail"
func translateSignError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "sign request timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "sign request cancelled"
	}
	// 大多数情况直接用 err.Error()，调用栈包装已经够人类可读
	// （如 "parse private key: ssh: this private key is passphrase protected"）
	return err.Error()
}
