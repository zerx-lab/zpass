// Chrome Native Messaging Host —— 浏览器与桌面 GUI 的薄桥
//
// ---------------------------------------------------------------------------
// 设计原则（v2 安全模型）
//
// 本进程**不再**直接读 vault DB，**不再**尝试 Trusted Device 自动解锁。
// 所有 vault 操作必须经由桌面 GUI 进程：
//
//   浏览器扩展 ─stdin/stdout─▶ nativehost ─HTTP─▶ Desktop GUI ─▶ Vault
//
// nativehost 完全是"无密钥转发器"，本身不持有任何凭据。
//
// ---------------------------------------------------------------------------
// GUI 不在线时的行为
//
//  1. 读 browser-bridge.json，端口可达 → 转发
//  2. 配置缺失 / 端口不可达 → 调用 spawnGUI 拉起 Desktop GUI
//  3. 启动后轮询 bridge 直到 ready 或超时（waitBridgeTimeout）
//  4. ready 后转发本次请求；超时 → 返回结构化错误让扩展提示用户
//
// 拉起冷却：spawnGUI 同 zpass-agent 的 launcher，避免高频重试。
//
// ---------------------------------------------------------------------------
// 不持有 Vault → 单元测试集中在 protocol 层（nativebridge_protocol_test.go）

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/zerx-lab/zpass/internal/nativebridge"
)

// 等待 GUI 启动后 bridge 可用的总超时
//
// Desktop GUI 冷启动 Wails + Vite + WebView2 + sqlite 句柄要 1-3 秒，
// 留出 5 秒给慢机器与首次 IO。超时后返回结构化错误让 popup 提示。
const waitBridgeTimeout = 5 * time.Second

// 轮询 bridge 是否上线的间隔
const waitBridgePollInterval = 200 * time.Millisecond

// forwardToDesktopClient 失败时给扩展的标准化错误码
//
// 扩展 popup 用此判断是否显示"Desktop 启动中"特殊态。
const (
	errCodeDesktopUnavailable = "ZPass Desktop is unavailable. Please open ZPass Desktop and unlock the vault."
	errCodeDesktopStarting    = "ZPass Desktop is starting up. Please try again in a moment."
	// errCodeDesktopOffline专用于 ping / launchDesktop 探测：GUI 不在线，
	// 完全不尝试 spawn。popup 识别该文案后渲染「Desktop 未启动」状态
	// + 一键启动按钮。
	errCodeDesktopOffline = "ZPass Desktop is not running."
)

// stdoutMu 串行化 writeNative。
//
// Chrome native messaging 是「4 字节 little-endian 长度前缀 + JSON body」的帧
// 协议，跨 goroutine 交错写会坏帧。dispatchMessage 现在并发跑（见 main 循环
// 注释），必须在这里加锁。
var stdoutMu sync.Mutex

func main() {
	for {
		msg, err := readNative(os.Stdin)
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			writeNative(nativeResponse{OK: false, Error: "Invalid native message."})
			return
		}
		// 每条请求一个 goroutine。动机：资源型调用（status/queryLogins）在
		// desktop 离线时会阐 spawn + waitForBridge 走 5s。串行主循环会让
		// 同一 port 上后续的 ping 排队等这 5s，直接拖慢 popup。
		//
		// 并发后：底下 dispatch 互不阻塞；background 端 NativeBridge.handleMessage
		// 按 id 匹配 pending，乱序响应完全 OK。forwardToDesktopClient 里每次
		// 都在 ReadStandardConfig + http.Client.Do 中独立走，无共享状态；
		// ensureGUIRunning 自带 mutex + flight 原子 flag，多 goroutine 调安全。
		go func(m nativeEnvelope) {
			writeNative(dispatchMessage(m))
		}(msg)
	}
}

// dispatchMessage 转发一条扩展请求到 Desktop GUI
//
// 特殊类型：
//   - ping            → 单次探测，不 spawn，不重试，用于 popup liveness
//   - launchDesktop   → 不转发，直接调 ensureGUIRunning（用户主动点启动按钮）
//
// 其它类型（资源性调用，如 status/queryLogins/revealLogin）：
//  1. 尝试直接 forward
//  2. forward 失败 → 拉起 GUI（异步、幂等）→ 轮询 bridge 直到 ready
//  3. ready 后重试一次 forward
//  4. 仍失败 → 返回结构化错误
func dispatchMessage(msg nativeEnvelope) nativeResponse {
	switch msg.Type {
	case "ping":
		return handlePing(msg)
	case "launchDesktop":
		return handleLaunchDesktop(msg)
	}

	if resp, err := forwardToDesktopClient(msg); err == nil {
		return resp
	}

	// bridge 不可达 —— 拉起 GUI 并等待
	if err := ensureGUIRunning(); err != nil {
		return nativeResponse{
			ID:    msg.ID,
			OK:    false,
			Error: errCodeDesktopUnavailable,
		}
	}

	if !waitForBridge() {
		// GUI 已启动但 bridge 还没起来 —— 让扩展稍后重试
		return nativeResponse{
			ID:    msg.ID,
			OK:    false,
			Error: errCodeDesktopStarting,
		}
	}

	if resp, err := forwardToDesktopClient(msg); err == nil {
		return resp
	}

	return nativeResponse{
		ID:    msg.ID,
		OK:    false,
		Error: errCodeDesktopUnavailable,
	}
}

// handlePing 探测 GUI 是否在线，不会触发 spawn。
//
// popup 打开时首调该接口：GUI 在 → 走正常 status/query 流程；GUI 不在
// → 直接渲染「桌面未启动 + 一键启动」状态。避免「点击调起 + 5s 等待」
// 的等待感。
//
// 向后兼容：旧版 GUI bridge 不认识 "ping"，会返回
// `{ok:false, error:"Unknown native request: ping"}` (HTTP 200)。forward
// 本身 err==nil，不能当成 alive 信号。需要检查 resp.OK 才能识别
// “连上了但不能服务” 这种中间状态。这种场景下仅获取 GUI 连接性即
//
// 副作用：连不通时主动删 browser-bridge.json。 Desktop GUI 被强杀 /
// 崩溃时来不及跑 Shutdown 清理这个文件，留着会让后续每个资源型调用
// (status/queryLogins) 走 spawn + waitBridge 5s 慢路径。ping 是 popup
// 启动时首调用，这里清理后下一次任何调用 ReadStandardConfig 会直接
// 返 err、立即识别 desktop offline。
func handlePing(msg nativeEnvelope) nativeResponse {
	if resp, err := forwardToDesktopClient(msg); err == nil {
		if resp.OK {
			return resp
		}
		// GUI 连上了但不认识 ping (旧版) —— 以 alive=true 返回让
		// popup 能继续走 status 流程，避免“明明 GUI 在却被拒”的错误提示
		return nativeResponse{
			ID:     msg.ID,
			OK:     true,
			Result: map[string]bool{"alive": true},
		}
	}
	// forward 失败：json 存在但端口拒绝连接 — 删僵尸 json。
	// ReadStandardConfig 缺失时这里是 no-op。
	if path, err := nativebridge.ConfigPath(); err == nil {
		_ = os.Remove(path)
	}
	return nativeResponse{
		ID:    msg.ID,
		OK:    false,
		Error: errCodeDesktopOffline,
	}
}

// handleLaunchDesktop 显式拉起 GUI（用户点「启动 Desktop」按钮触发）。
//
// 不等待 bridge ready，返回后 popup 自己轮询 ping 直到 GUI 上线。
func handleLaunchDesktop(msg nativeEnvelope) nativeResponse {
	if err := ensureGUIRunning(); err != nil {
		return nativeResponse{
			ID:    msg.ID,
			OK:    false,
			Error: errCodeDesktopUnavailable,
		}
	}
	return nativeResponse{ID: msg.ID, OK: true, Result: map[string]bool{"launched": true}}
}

// waitForBridge 轮询 browser-bridge.json 直到端口可达或超时
//
// 返回 true 表示 bridge 已就绪，可以发请求；false 表示超时。
func waitForBridge() bool {
	deadline := time.Now().Add(waitBridgeTimeout)
	for time.Now().Before(deadline) {
		if _, err := nativebridge.ReadStandardConfig(); err == nil {
			if bridgeReachable() {
				return true
			}
		}
		time.Sleep(waitBridgePollInterval)
	}
	return false
}

// bridgeReachable 发一个低开销的 status 探测确认 bridge 真的能应答
//
// 仅检查配置文件存在是不够的：GUI 写完 json 到真正 listen 之间有窗口期。
//
// id 用随机 hex 而非固定 "probe"：waitForBridge 可能在同一秒内多次探测，
// 也可能与并发的 dispatchMessage 共享 GUI bridge；固定 id 在 GUI 端虽不
// 路由冲突（probe 不会与扩展 seq 撞），但日志/审计层面无法区分单次探测。
func bridgeReachable() bool {
	cfg, err := nativebridge.ReadStandardConfig()
	if err != nil {
		return false
	}
	id, err := randomProbeID()
	if err != nil {
		return false
	}
	body, err := json.Marshal(nativeEnvelope{ID: id, Type: "status"})
	if err != nil {
		return false
	}
	req, err := http.NewRequest(
		http.MethodPost,
		"http://127.0.0.1:"+cfg.Port+"/native",
		bytes.NewReader(body),
	)
	if err != nil {
		return false
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+cfg.Token)
	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func randomProbeID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "probe-" + hex.EncodeToString(buf[:]), nil
}

func forwardToDesktopClient(msg nativeEnvelope) (nativeResponse, error) {
	cfg, err := nativebridge.ReadStandardConfig()
	if err != nil {
		return nativeResponse{}, err
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return nativeResponse{}, err
	}
	req, err := http.NewRequest(
		http.MethodPost,
		"http://127.0.0.1:"+cfg.Port+"/native",
		bytes.NewReader(payload),
	)
	if err != nil {
		return nativeResponse{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+cfg.Token)

	client := &http.Client{Timeout: 1500 * time.Millisecond}
	httpResp, err := client.Do(req)
	if err != nil {
		return nativeResponse{}, err
	}
	defer httpResp.Body.Close()
	if httpResp.StatusCode != http.StatusOK {
		return nativeResponse{}, errors.New("desktop bridge rejected request")
	}
	var resp nativeResponse
	if err := json.NewDecoder(httpResp.Body).Decode(&resp); err != nil {
		return nativeResponse{}, err
	}
	return resp, nil
}

func readNative(r io.Reader) (nativeEnvelope, error) {
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return nativeEnvelope{}, err
	}
	if size == 0 || size > nativebridge.MaxMessageBytes {
		return nativeEnvelope{}, errors.New("native message size rejected")
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nativeEnvelope{}, err
	}
	var msg nativeEnvelope
	if err := json.Unmarshal(buf, &msg); err != nil {
		return nativeEnvelope{}, err
	}
	return msg, nil
}

func writeNative(resp nativeResponse) {
	payload, err := json.Marshal(resp)
	if err != nil {
		payload = []byte(`{"ok":false,"error":"Native response encoding failed."}`)
	}
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	_ = binary.Write(os.Stdout, binary.LittleEndian, uint32(len(payload)))
	_, _ = os.Stdout.Write(payload)
}
