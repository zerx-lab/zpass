// ============================================================================
// ZPass Notification Bar — content-script 端容器管理器
// ----------------------------------------------------------------------------
// 负责把扩展 origin 的 iframe 注入到宿主页面，并代理 background ↔ iframe
// 之间的初始化数据流。这个文件的核心使命：让保存条**完全脱离宿主页面 DOM
// / CSS / JS 的影响**，无论宿主用什么妖魔骨架样式都能稳定渲染。
//
// 关键决策：
//   - 只挂一个 iframe，复用——多次 push 同 origin 时只更新 init 数据。
//   - iframe 默认 width=380、height=由内部 postMessage resize 控制。
//   - iframe position: fixed; right: 16px; bottom: 16px; z-index: 顶满。
//     用 isolation/all:initial 防止宿主 CSS 覆盖到 iframe 元素自身。
//   - iframe 加载完成后等其 postMessage(ready)，再回推 init 数据；不预设
//     timeout 强推，避免 init 数据丢失。
// ============================================================================

import type { ShowSaveToastMessage } from "../shared/messages";

const IFRAME_ID = "zpass-notification-bar-frame";
const DEFAULT_HEIGHT = 96;
const FRAME_WIDTH = 380;

interface PendingInit {
  ready: boolean;
  payload: ShowSaveToastMessage | "locked" | null;
}

const state: PendingInit = { ready: false, payload: null };
let frame: HTMLIFrameElement | null = null;
let messageListenerInstalled = false;

/**
 * 显示「保存 / 更新」条。重复调用安全：会更新内部数据并通过 postMessage
 * 把新 payload 推到 iframe（iframe 内会替换内容）。
 */
export function showSaveBar(payload: ShowSaveToastMessage): void {
  ensureFrame();
  state.payload = payload;
  flushIfReady();
}

/**
 * 显示「ZPass 锁定」条。background 在 vault 解锁后会通过 zpass.showSaveToast
 * 推升级后的 payload 把这里替换为 save bar，不需要 content 端主动转换。
 */
export function showLockedBar(): void {
  ensureFrame();
  state.payload = "locked";
  flushIfReady();
}

/** 主动卸载 iframe。被 iframe 内部「×」/「永不」/「保存成功」触发。 */
export function closeBar(): void {
  if (frame) {
    frame.remove();
    frame = null;
  }
  state.ready = false;
  state.payload = null;
}

/* ============================================================================
 * 内部
 * ========================================================================== */

function ensureFrame(): void {
  if (frame && frame.isConnected) return;

  installMessageListener();

  const iframe = document.createElement("iframe");
  iframe.id = IFRAME_ID;
  iframe.src = browser.runtime.getURL("/notification-bar.html");
  iframe.setAttribute("aria-label", "ZPass 保存登录");
  // 关键：sandbox 不能加（否则 iframe 内无法用 browser.runtime APIs）。
  // 但加 referrerpolicy=no-referrer 避免泄露宿主 URL 给扩展页（虽然同一进程，
  // 但保持卫生）。
  iframe.referrerPolicy = "no-referrer";

  // 反宿主 CSS 防御：iframe 元素自身的样式用 cssText + !important 写在 style
  // attr 里，比 stylesheet 优先级高、宿主难以覆盖；all:initial 把任何继承样式
  // 清零，再叠加我们的 fixed 定位。
  iframe.style.cssText = [
    "all: initial !important",
    "position: fixed !important",
    "right: 16px !important",
    "bottom: 16px !important",
    `width: ${FRAME_WIDTH}px !important`,
    `height: ${DEFAULT_HEIGHT}px !important`,
    "border: 0 !important",
    "background: transparent !important",
    "color-scheme: normal !important",
    "z-index: 2147483647 !important",
    "pointer-events: auto !important",
    // isolation 创建一个独立堆叠 / 渲染上下文，避免被宿主 backdrop-filter 等
    // 拉进它的合成层。
    "isolation: isolate !important",
    // 防止宿主 `transform` 祖先把我们 fixed 定位变成 absolute——浏览器规范
    // 里 iframe 本身不参与外部 transform 上下文，这里加 will-change 强化。
    "will-change: auto !important",
  ].join("; ");

  document.documentElement.append(iframe);
  frame = iframe;
}

/**
 * 注册一次 message 监听，处理来自 iframe 的：
 *   - ready：iframe 加载完成可接 init 数据
 *   - close：iframe 内用户操作 → 卸载
 *   - resize：iframe 内容高度变化 → 调整外层 iframe 元素 height
 *
 * 安全：仅接收来自我们注入的 iframe.contentWindow 的消息；且校验 event.origin
 * 来自扩展 origin。
 */
function installMessageListener(): void {
  if (messageListenerInstalled) return;
  messageListenerInstalled = true;

  const extensionOrigin = new URL(browser.runtime.getURL("/")).origin;

  window.addEventListener("message", (event) => {
    if (event.origin !== extensionOrigin) return;
    if (!frame || event.source !== frame.contentWindow) return;
    const msg = event.data as {
      type?: string;
      height?: number;
    };
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "zpass.bar.ready") {
      state.ready = true;
      flushIfReady();
    } else if (msg.type === "zpass.bar.close") {
      closeBar();
    } else if (
      msg.type === "zpass.bar.resize" &&
      typeof msg.height === "number" &&
      frame
    ) {
      const clamped = Math.max(72, Math.min(280, msg.height));
      frame.style.setProperty("height", `${clamped}px`, "important");
    }
  });
}

/**
 * iframe 已 ready + state.payload 已有 → 把数据 postMessage 给 iframe。
 * iframe 未 ready 时数据先存着，等 ready 信号到再 flush。
 */
function flushIfReady(): void {
  if (!state.ready || !frame || !frame.contentWindow) return;
  if (state.payload === null) return;

  const extensionOrigin = new URL(browser.runtime.getURL("/")).origin;
  if (state.payload === "locked") {
    frame.contentWindow.postMessage(
      { type: "zpass.bar.locked" },
      extensionOrigin,
    );
  } else {
    frame.contentWindow.postMessage(
      { type: "zpass.bar.init", payload: state.payload },
      extensionOrigin,
    );
  }
}
