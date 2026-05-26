// 顶层 frame 专属的内联菜单 DOM 注入器。
//
// 架构形状参考 Bitwarden 浏览器扩展(GPL-3.0, bitwarden/clients,
// apps/browser/src/autofill/overlay/inline-menu/content/
// autofill-inline-menu-content.service.ts):
//
//   1. 随机命名的 Custom Element 作为外壳, 避开宿主页 CSS 选择器
//   2. 外壳挂 `popover="manual"` + `showPopover()`, 借助 HTML Top Layer
//      规避宿主页 z-index / overflow 限制
//   3. closed ShadowRoot 包扩展自家 iframe, 宿主页脚本无法穿透
//   4. 三重 MutationObserver:
//      - html/body attribute 变化(opacity/visibility) → 整页隐时立即关菜单
//      - container(通常 body) 末尾子节点被换 → 重新搬到末尾
//      - 顶层劫持退避:5s 内复位超 N 次 → 永久关停本页
//
// 干净室实现, 未复制 Bitwarden 源码。

import {
  InlineMenuOverlayElement,
  INLINE_MENU_LIST_HTML,
  type InlineMenuFieldRect,
  type InlineMenuOverlayElementType,
} from "../shared/inline-menu-enums";
import { InlineMenuIframeShell } from "./inline-menu-iframe";

const SHELL_STYLE: Record<string, string> = {
  all: "initial",
  position: "fixed",
  display: "block",
  "z-index": "2147483647",
  inset: "auto",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  "pointer-events": "auto",
};

/** 5s 滑窗内 popover 复位上限。超过即判定为顶层劫持。 */
const POPOVER_REFRESH_THRESHOLD = 10;
const REFRESH_TIME_WINDOW_MS = 5000;

function applyStyles(
  element: HTMLElement,
  styles: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(styles)) {
    element.style.setProperty(name, value, "important");
  }
}

/**
 * 生成合法的随机 Custom Element tag name。
 *
 * Custom Element 规范要求必须含 `-` 且首字母小写。crypto.randomUUID
 * 取一段十六进制 + 固定前缀即可彻底避开宿主页选择器命中。
 */
function generateRandomTagName(prefix: string): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const suffix = uuid.replace(/[^a-f0-9]/g, "").slice(0, 12) || "fallback";
  return `${prefix}-${suffix}`;
}

interface ShellRecord {
  tagName: string;
  element: HTMLElement;
  shadow: ShadowRoot;
  iframe: InlineMenuIframeShell;
  /** 最近一次设置的 rect, 复位后用于恢复位置。 */
  lastRect: InlineMenuFieldRect | null;
}

/**
 * 顶层 frame 注入器。一个 tab 生命周期内单例。
 *
 * sub-frame 不实例化(仅顶层有 popover top-layer)。
 */
export class InlineMenuInjector {
  private disabled = false;
  private list: ShellRecord | null = null;
  private readonly refreshTimestamps: number[] = [];
  private readonly htmlObserver: MutationObserver;
  private readonly bodyObserver: MutationObserver;
  private readonly containerObserver: MutationObserver;
  private currentContainer: HTMLElement | null = null;

  constructor() {
    this.htmlObserver = new MutationObserver(this.handleRiskMutation);
    this.bodyObserver = new MutationObserver(this.handleRiskMutation);
    this.containerObserver = new MutationObserver(this.handleContainerMutation);
    this.observePageAttributes();
  }

  isListOpen(): boolean {
    return this.list !== null;
  }

  /**
   * 判定一个元素是否归属于本注入器的 overlay shell。
   *
   * 焦点进入 closed ShadowRoot 内 iframe 时, document.activeElement 在
   * 宿主层只会看到 shell Custom Element 本身, 因此用 element === shell
   * 严格相等即可命中。controller 用此判断 focus 是否落在自家菜单上,
   * 落在自家菜单则不触发 blur-close。
   */
  ownsElement(element: EventTarget | null): boolean {
    if (!(element instanceof Element)) return false;
    return this.list !== null && this.list.element === element;
  }

  /**
   * 打开 list 内联菜单。重复调用安全:已开则仅刷新 rect, 不重建。
   * 返回 false 表示已被永久关停。
   */
  openList(rect: InlineMenuFieldRect): boolean {
    if (this.disabled) {
      console.log("[ZPass inline-menu] injector disabled (top-layer hijack)");
      return false;
    }
    if (this.list) {
      console.log("[ZPass inline-menu] injector reposition existing list");
      this.list.lastRect = rect;
      this.list.iframe.setPosition(rect);
      this.ensureShellVisible(this.list);
      return true;
    }
    this.list = this.createShell(
      InlineMenuOverlayElement.List,
      "ZPass autofill list",
    );
    console.log(
      "[ZPass inline-menu] injector created shell",
      "tag=", this.list.tagName,
      "iframe.src=", this.list.iframe.iframeSrc(),
    );
    this.appendToContainer(this.list.element);
    this.ensureShellVisible(this.list);
    this.list.lastRect = rect;
    this.list.iframe.setPosition(rect);
    console.log(
      "[ZPass inline-menu] injector mounted",
      "container=", this.currentContainer?.tagName,
      "shellConnected=", this.list.element.isConnected,
    );
    return true;
  }

  /** 更新位置(滚动/缩放时由 controller 调)。 */
  updatePosition(rect: InlineMenuFieldRect): void {
    if (!this.list) return;
    this.list.lastRect = rect;
    this.list.iframe.setPosition(rect);
  }

  /** 关闭列表。idempotent。 */
  closeList(): void {
    if (!this.list) return;
    try {
      this.list.iframe.destroy();
    } finally {
      if (this.list.element.isConnected) this.list.element.remove();
      this.list = null;
    }
    this.containerObserver.disconnect();
    this.currentContainer = null;
  }

  /** 完全销毁。 */
  destroy(): void {
    this.closeList();
    this.htmlObserver.disconnect();
    this.bodyObserver.disconnect();
    this.containerObserver.disconnect();
  }

  // =================================================================
  // 内部:shell 构造
  // =================================================================

  private createShell(
    overlayElement: InlineMenuOverlayElementType,
    title: string,
  ): ShellRecord {
    const tagName = generateRandomTagName(overlayElement);
    try {
      globalThis.customElements?.define(tagName, class extends HTMLElement {});
    } catch {
      // 名字撞了 —— 极不可能(uuid 碰撞), 静默继续。
    }
    const element = document.createElement(tagName) as HTMLElement;
    // 不再走 HTML Popover API:实测在 closed ShadowRoot + iframe 组合下,
    // popover=manual 状态机让元素维持 display:none, inline !important 也
    // 无法稳定覆盖, 导致 iframe.getBoundingClientRect() 为 0。
    // 改回经典 position:fixed + max z-index, 兼容性更好(Bitwarden 在
    // Firefox 上同样走 div 降级路径)。SHELL_STYLE 已含 display:block。
    applyStyles(element, SHELL_STYLE);
    const shadow = element.attachShadow({ mode: "closed" });
    const src = browser.runtime.getURL(`/${INLINE_MENU_LIST_HTML}`);
    const iframe = new InlineMenuIframeShell(shadow, src, title);
    return { tagName, element, shadow, iframe, lastRect: null };
  }

  // 不再需要 ensurePopoverOpen —— 改用 fixed+z-index 路径。
  private ensureShellVisible(shell: ShellRecord): void {
    // 防御:宿主页可能注入 display:none 之类的样式 → 复位关键 layout 属性。
    applyStyles(shell.element, {
      display: "block",
      visibility: "visible",
      opacity: "1",
      "pointer-events": "auto",
    });
  }

  // =================================================================
  // 内部:挂载点选择 + container 监听
  // =================================================================

  private appendToContainer(element: HTMLElement): void {
    const focused = document.activeElement;
    const dialog = focused?.closest?.("dialog");
    if (
      dialog instanceof HTMLDialogElement &&
      dialog.open &&
      typeof dialog.matches === "function" &&
      dialog.matches(":modal")
    ) {
      this.currentContainer = dialog;
      dialog.appendChild(element);
      this.containerObserver.observe(dialog, { childList: true });
      return;
    }
    this.currentContainer = document.body;
    document.body.appendChild(element);
    this.containerObserver.observe(document.body, { childList: true });
  }

  // =================================================================
  // 内部:页面属性 / container 监听
  // =================================================================

  private observePageAttributes(): void {
    const filter = ["style", "hidden", "popover", "width", "height"];
    if (document.documentElement) {
      this.htmlObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: filter,
      });
    }
    if (document.body) {
      this.bodyObserver.observe(document.body, {
        attributes: true,
        attributeFilter: filter,
      });
    }
  }

  private handleRiskMutation = (): void => {
    if (!this.list) return;
    if (this.pageIsOpaque()) return;
    // 整页透明/隐藏 → 直接关菜单, 避免悬空显示。
    this.closeList();
  };

  private pageIsOpaque(): boolean {
    const pages = document.querySelectorAll<HTMLElement>("html, body");
    if (pages.length === 0) return false;
    for (const page of Array.from(pages)) {
      const opacity = parseFloat(window.getComputedStyle(page).opacity || "1");
      if (!Number.isFinite(opacity) || opacity <= 0.6) return false;
    }
    return true;
  }

  private handleContainerMutation = (mutations: MutationRecord[]): void => {
    if (!this.list || !this.currentContainer) return;
    let needRefresh = false;
    for (const m of mutations) {
      if (m.type !== "childList") continue;
      const last = this.currentContainer.lastElementChild;
      if (last && last !== this.list.element) {
        needRefresh = true;
        break;
      }
    }
    if (!needRefresh) return;
    if (this.isHijackThresholdReached()) {
      this.disable("inline menu disabled: too many top-layer refreshes");
      return;
    }
    try {
      this.currentContainer.appendChild(this.list.element);
      this.ensureShellVisible(this.list);
      if (this.list.lastRect) this.list.iframe.setPosition(this.list.lastRect);
    } catch {
      this.closeList();
    }
  };

  private isHijackThresholdReached(): boolean {
    const now = Date.now();
    while (
      this.refreshTimestamps.length > 0 &&
      now - this.refreshTimestamps[0]! > REFRESH_TIME_WINDOW_MS
    ) {
      this.refreshTimestamps.shift();
    }
    this.refreshTimestamps.push(now);
    return this.refreshTimestamps.length > POPOVER_REFRESH_THRESHOLD;
  }

  private disable(reason: string): void {
    this.disabled = true;
    console.log("[ZPass]", reason);
    this.closeList();
    this.htmlObserver.disconnect();
    this.bodyObserver.disconnect();
    this.containerObserver.disconnect();
  }
}
