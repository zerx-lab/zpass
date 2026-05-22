// ============================================================================
// ZPass Notification Bar — iframe 内部脚本
// ----------------------------------------------------------------------------
// 该脚本运行在 iframe 文档中，origin = chrome-extension://<id>。
// 与外层 content-script 通过 window.postMessage 通信；与 background 通过
// browser.runtime.sendMessage 直连（iframe 本身就是扩展上下文，权限齐全）。
//
// 与 content-script DOM toast 方案相比的关键差异：
//   - 完全隔离于宿主页面 CSS / JS / CSP，对任何站点（包括有 transform 祖先
//     破坏 fixed 定位的站点）都能稳定呈现。
//   - 因为是独立 frame，宿主 SPA 路由切换不会清掉它（清掉的是外层 iframe
//     元素，由 content-script 的 NotificationBarManager 控制）。
// ============================================================================

import type { SaveLoginDecision, ShowSaveToastMessage } from "../../src/shared/messages";
import { zMatrixIcon } from "../../src/shared/icons";
import "./style.css";

/** parent ↔ iframe 通信协议。parent 是 content-script，origin 是宿主页面。 */
type InboundMessage =
  | {
      type: "zpass.bar.init";
      payload: ShowSaveToastMessage;
    }
  | { type: "zpass.bar.locked" };

type OutboundMessage =
  | { type: "zpass.bar.ready" }
  | { type: "zpass.bar.close" }
  | { type: "zpass.bar.resize"; height: number };

/**
 * iframe 启动 → 通知 parent「我 ready 了，把数据 postMessage 过来」。
 * 之所以不用 query string 传数据：URL 会被记录到浏览器 history / referrer，
 * 明文密码不能走 URL。
 */
function postToParent(message: OutboundMessage): void {
  // 不指定 targetOrigin = "*" —— parent.origin 是宿主页（哪个站都可能）。
  // 这里传出去的内容不包含敏感数据，只有「ready / close / resize」三种控制消息。
  window.parent.postMessage(message, "*");
}

/**
 * 监听 parent 推过来的初始化数据。
 *
 * 安全：仅接收来自 window.parent 的消息；event.source !== window.parent 一律丢。
 * 不校验 event.origin —— iframe 处在宿主页 origin 之外，parent.origin 多种多样。
 * 数据本身就在 background→content→iframe 这条链上由 background 单点裁决，
 * 这里只是 UI 渲染层，无独立信任决策。
 */
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data as InboundMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "zpass.bar.init") {
    renderSaveBar(msg.payload);
  } else if (msg.type === "zpass.bar.locked") {
    renderLockedBar();
  }
});

postToParent({ type: "zpass.bar.ready" });

/* ============================================================================
 * 渲染：保存 / 更新登录条
 * ========================================================================== */

function renderSaveBar(payload: ShowSaveToastMessage): void {
  const { decision, capture } = payload;
  const isUpdate = decision.status === "update";
  const title = isUpdate ? "更新 ZPass 中的密码？" : "保存登录到 ZPass？";
  const subtitle = isUpdate
    ? `${decision.itemName || decision.origin} 的密码变了。`
    : `保存 ${capture.username} 到 ${decision.origin}。`;

  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";

  const bar = createBarSkeleton(title, subtitle);

  const neverBtn = button("永不", "btn-secondary", "never");
  const saveBtn = button(isUpdate ? "更新密码" : "保存", "btn-primary", "save");
  const actions = bar.querySelector(".bar-actions")!;
  actions.append(neverBtn, saveBtn);

  bar.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "dismiss") {
      close();
      return;
    }
    if (action === "never") {
      void browser.runtime.sendMessage({ type: "zpass.ignoreSaveOrigin" });
      close();
      return;
    }
    if (action === "save") {
      void handleSave(payload, bar);
    }
  });

  root.append(bar);
  reportHeight();
}

async function handleSave(
  payload: ShowSaveToastMessage,
  bar: HTMLElement,
): Promise<void> {
  const { decision, capture } = payload;
  const isUpdate = decision.status === "update";
  const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>("button"));
  buttons.forEach((b) => (b.disabled = true));

  const saveLoginPayload: Record<string, unknown> = {
    username: capture.username,
    password: capture.password,
  };
  if (decision.itemId) saveLoginPayload.itemId = decision.itemId;
  if (capture.suggestedName) saveLoginPayload.name = capture.suggestedName;

  try {
    const response = await browser.runtime.sendMessage({
      type: "zpass.saveLogin",
      payload: saveLoginPayload,
    });
    if (response && response.ok === false) {
      renderError(response.error ?? "请重试。");
      return;
    }
    renderSuccess(isUpdate ? "密码已更新" : "已保存到 ZPass", decision.origin);
    window.setTimeout(close, 2200);
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

/* ============================================================================
 * 渲染：vault 锁定提示
 * ========================================================================== */

function renderLockedBar(): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";

  const bar = createBarSkeleton("ZPass 已锁定", "解锁后可保存这条登录。");

  const laterBtn = button("稍后", "btn-secondary", "dismiss");
  const unlockBtn = button("打开 ZPass", "btn-primary", "unlock");
  const actions = bar.querySelector(".bar-actions")!;
  actions.append(laterBtn, unlockBtn);

  bar.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "unlock") {
      void browser.runtime.sendMessage({ type: "zpass.launchDesktop" });
      // 不主动 close：让用户继续看到「锁定中」直到 background 主推升级
      // 后的 zpass.showSaveToast 把 init 数据 postMessage 过来。
      return;
    }
    close();
  });

  root.append(bar);
  reportHeight();
}

/* ============================================================================
 * 渲染：完成态 / 错误态（轻量替换内容，仍占同一个 bar）
 * ========================================================================== */

function renderSuccess(title: string, subtitle: string): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";
  root.append(createBarSkeleton(title, subtitle));
  reportHeight();
}

function renderError(message: string): void {
  const root = document.getElementById("root");
  if (!root) return;
  // 错误态仍保留按钮：让用户能关闭。复用 dismiss action。
  root.innerHTML = "";
  const bar = createBarSkeleton("保存失败", message);
  const closeBtn = button("关闭", "btn-secondary", "dismiss");
  bar.querySelector(".bar-actions")!.append(closeBtn);
  bar.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button[data-action]")) {
      close();
    }
  });
  root.append(bar);
  reportHeight();
}

/* ============================================================================
 * 工具
 * ========================================================================== */

function createBarSkeleton(title: string, subtitle: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", title);

  const head = document.createElement("div");
  head.className = "bar-head";

  const icon = document.createElement("span");
  icon.className = "bar-icon";
  icon.innerHTML = zMatrixIcon({ size: 18 });

  const text = document.createElement("div");
  text.className = "bar-text";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("span");
  span.textContent = subtitle;
  text.append(strong, span);

  const closeBtn = document.createElement("button");
  closeBtn.className = "bar-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.dataset.action = "dismiss";
  closeBtn.textContent = "×";

  head.append(icon, text, closeBtn);

  const actions = document.createElement("div");
  actions.className = "bar-actions";

  bar.append(head, actions);
  return bar;
}

function button(
  label: string,
  variant: "btn-primary" | "btn-secondary",
  action: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = variant;
  btn.type = "button";
  btn.dataset.action = action;
  btn.textContent = label;
  return btn;
}

function close(): void {
  postToParent({ type: "zpass.bar.close" });
}

/**
 * 把当前内容实际高度报给 parent，让 outer iframe 元素跟着收缩 / 扩展。
 * 用 requestAnimationFrame 等一帧、保证布局已稳定。
 */
function reportHeight(): void {
  requestAnimationFrame(() => {
    const root = document.getElementById("root");
    if (!root) return;
    const bar = root.querySelector<HTMLElement>(".bar");
    if (!bar) return;
    // padding 8 上下都给阴影留空间。
    const total = bar.getBoundingClientRect().height + 16;
    postToParent({ type: "zpass.bar.resize", height: Math.ceil(total) });
  });
}

// 兜底：iframe 内任意状态都把 SaveLoginDecision 类型暴露给 TS 检查。
export type { SaveLoginDecision };
