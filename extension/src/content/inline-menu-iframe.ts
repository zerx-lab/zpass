// 内联菜单 iframe DOM 壳。
//
// 架构形状参考 Bitwarden 浏览器扩展(GPL-3.0, bitwarden/clients,
// apps/browser/src/autofill/overlay/inline-menu/iframe-content/
// autofill-inline-menu-iframe.service.ts):
//
//   - 把扩展自家 HTML 包到 cross-origin iframe 里
//   - !important 样式 + MutationObserver 防宿主页篡改 attribute
//   - 初始 opacity:0, 加载完后 fadeIn
//
// 与 Bitwarden 不同之处:本壳不持有 runtime port。port 由 iframe 页(扩展
// 上下文)自己开, 走 background runtime.onConnect, 避免依赖 parent.postMessage
// 把数据回吐到宿主 window —— 后者会让宿主页脚本读到回信。
// 干净室实现, 未复制 Bitwarden 源码。

import type { InlineMenuFieldRect } from "../shared/inline-menu-enums";

/**
 * 基础样式 —— 全部 !important。坐标先以 0,0 起手, 接 setPosition 才挂正确位置。
 */
const BASE_STYLE: Record<string, string> = {
  all: "initial",
  position: "fixed",
  display: "block",
  top: "0",
  left: "0",
  width: "0",
  height: "0",
  "z-index": "2147483647",
  border: "0",
  margin: "0",
  padding: "0",
  overflow: "hidden",
  background: "transparent",
  "color-scheme": "normal",
  opacity: "0",
  transition: "opacity 120ms ease-out",
  "pointer-events": "auto",
  visibility: "visible",
};

/** iframe attribute 白名单 —— 出现白名单外的 attribute 直接清掉。 */
const FIXED_ATTRS: Record<string, string> = {
  credentialless: "",
  allowtransparency: "true",
  scrolling: "no",
  tabindex: "-1",
};

const FADE_IN_DELAY_MS = 80;
const MAX_LIST_HEIGHT_PX = 320;
const MIN_LIST_HEIGHT_PX = 56;
/** 来自 iframe 内页的"自报实际高度"消息 source 标识。 */
const RESIZE_MESSAGE_SOURCE = "zpass-inline-menu";
const RESIZE_MESSAGE_TYPE = "resize";

function applyStyles(
  element: HTMLElement,
  styles: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(styles)) {
    element.style.setProperty(name, value, "important");
  }
}

function makeIframe(src: string, title: string): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.title = title;
  for (const [k, v] of Object.entries(FIXED_ATTRS)) {
    iframe.setAttribute(k, v);
  }
  applyStyles(iframe, BASE_STYLE);
  return iframe;
}

/**
 * 把 anchor 的 viewport rect 转成 iframe 位置:浮在 anchor 正下方,
 * 并避开右边缘溢出。
 *
 * 视口尺寸优先用 visualViewport(适配 mobile pinch-zoom), 兜底 innerWidth/Height。
 */
function rectToIframeStyle(
  rect: InlineMenuFieldRect,
): Record<string, string> {
  const vw =
    globalThis.visualViewport?.width ?? globalThis.innerWidth ?? document.documentElement.clientWidth;
  const vh =
    globalThis.visualViewport?.height ?? globalThis.innerHeight ?? document.documentElement.clientHeight;

  const width = Math.max(rect.width, 240);
  // 默认贴 anchor 下方 4px。若下方空间不足且上方更宽 → 翻到上方。
  const spaceBelow = vh - (rect.top + rect.height);
  const spaceAbove = rect.top;
  let top = rect.top + rect.height + 4;
  if (spaceBelow < MIN_LIST_HEIGHT_PX && spaceAbove > spaceBelow) {
    top = Math.max(0, rect.top - MAX_LIST_HEIGHT_PX - 4);
  }

  // 水平上贴 anchor 左边。若右侧溢出 → 向左挪。
  let left = rect.left;
  if (left + width > vw) {
    left = Math.max(0, vw - width - 8);
  }

  return {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    width: `${Math.round(width)}px`,
    "max-height": `${MAX_LIST_HEIGHT_PX}px`,
    height: "auto",
    "min-height": `${MIN_LIST_HEIGHT_PX}px`,
  };
}

/**
 * IframeShell —— 一个 iframe 元素 + MutationObserver + 自动 fade-in。
 *
 * 构造时立即 append 到 ShadowRoot, 由 injector 负责把 ShadowRoot
 * 关联到自家的 Custom Element。
 */
export class InlineMenuIframeShell {
  private readonly iframe: HTMLIFrameElement;
  private readonly observer: MutationObserver;
  private fadeInTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private styleResetting = false;
  private destroyed = false;

  constructor(
    private readonly shadow: ShadowRoot,
    src: string,
    title: string,
  ) {
    this.iframe = makeIframe(src, title);
    this.iframe.addEventListener("load", this.handleLoad);
    this.observer = new MutationObserver(this.handleMutations);
    this.shadow.appendChild(this.iframe);
    // iframe 内页通过 window.parent.postMessage 上报自家 scrollHeight ——
    // host window 收到后我们应用到 iframe outer 元素的 height。这样浮层
    // 高度严格贴合内容, 不会出现 iframe 透明下半部分让宿主按钮"穿过来"
    // 的视觉遮挡。我们用 event.source === iframe.contentWindow 严格甄别。
    window.addEventListener("message", this.handleParentMessage);
    // 注意:不监视 style attribute。
    // 我们自己的 setPosition() 就要写 style, 监视会触发 reset →
    // 把刚设的 top/left/width/height 抹回 BASE_STYLE 的 0 值, iframe
    // 永远是 0x0。iframe 处在 closed ShadowRoot + extension origin 内,
    // 宿主页本来就拿不到 element 引用篡改不了 style, 不需要守护。
    this.observer.observe(this.iframe, {
      attributes: true,
      attributeFilter: [
        "src",
        "title",
        "tabindex",
        "credentialless",
        "allowtransparency",
        "scrolling",
        "class",
        "id",
      ],
    });
  }

  private handleParentMessage = (event: MessageEvent): void => {
    if (this.destroyed) return;
    const data = event.data as
      | { source?: unknown; type?: unknown; height?: unknown }
      | null;
    if (!data || typeof data !== "object") return;
    if (data.source !== RESIZE_MESSAGE_SOURCE) return;
    if (data.type !== RESIZE_MESSAGE_TYPE) return;
    // event.source 是 cross-origin WindowProxy; 引用比较有时在
    // isolated world 不可靠。改用 origin 鉴权:iframe src 是
    // chrome-extension://EXT_ID/..., event.origin 必须是同 origin。
    let expectedOrigin = "";
    try {
      expectedOrigin = new URL(this.iframe.src).origin;
    } catch {
      // src 不合法 —— 静默。
    }
    if (!expectedOrigin || event.origin !== expectedOrigin) return;
    if (typeof data.height !== "number" || !Number.isFinite(data.height)) return;
    const clamped = Math.min(
      MAX_LIST_HEIGHT_PX,
      Math.max(MIN_LIST_HEIGHT_PX, Math.round(data.height)),
    );
    this.iframe.style.setProperty("height", `${clamped}px`, "important");
    this.iframe.style.setProperty("min-height", `${clamped}px`, "important");
    this.iframe.style.setProperty("max-height", `${clamped}px`, "important");
  };

  /** 设置/更新内联菜单在视口里的位置。 */
  setPosition(rect: InlineMenuFieldRect): void {
    if (this.destroyed) return;
    applyStyles(this.iframe, rectToIframeStyle(rect));
  }

  /** 调试用。 */
  iframeSrc(): string {
    return this.iframe.src;
  }

  /** 销毁 —— 移除 iframe, 停 observer, 清 timer, 移除 message 监听。 */
  destroy(): void {
    this.destroyed = true;
    this.observer.disconnect();
    this.iframe.removeEventListener("load", this.handleLoad);
    window.removeEventListener("message", this.handleParentMessage);
    if (this.fadeInTimer !== null) {
      globalThis.clearTimeout(this.fadeInTimer);
      this.fadeInTimer = null;
    }
    if (this.iframe.isConnected) this.iframe.remove();
  }

  // ==================================================================
  // 内部
  // ==================================================================

  private handleLoad = (): void => {
    if (this.destroyed) return;
    if (this.fadeInTimer !== null) globalThis.clearTimeout(this.fadeInTimer);
    this.fadeInTimer = globalThis.setTimeout(() => {
      this.fadeInTimer = null;
      if (this.destroyed) return;
      applyStyles(this.iframe, { opacity: "1" });
    }, FADE_IN_DELAY_MS);
  };

  private handleMutations = (mutations: MutationRecord[]): void => {
    if (this.styleResetting || this.destroyed) return;
    let styleDirty = false;
    for (const mutation of mutations) {
      if (mutation.type !== "attributes") continue;
      const name = mutation.attributeName;
      if (!name) continue;
      if (name === "style") {
        styleDirty = true;
        continue;
      }
      const expected = this.expectedAttribute(name);
      if (expected === undefined) {
        this.iframe.removeAttribute(name);
        continue;
      }
      if (this.iframe.getAttribute(name) !== expected) {
        this.iframe.setAttribute(name, expected);
      }
    }
    if (styleDirty) {
      this.styleResetting = true;
      this.iframe.removeAttribute("style");
      applyStyles(this.iframe, BASE_STYLE);
      // 复位完同样恢复当前位置 —— 否则会回到 0,0。这里读不出当前 rect,
      // 由 injector 在 risk 后重新调 setPosition 即可。
      queueMicrotask(() => {
        this.styleResetting = false;
      });
    }
  };

  private expectedAttribute(name: string): string | undefined {
    if (name === "src") return this.iframe.src;
    if (name === "title") return this.iframe.title;
    return FIXED_ATTRS[name];
  }
}
