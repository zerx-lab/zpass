// ============================================================================
// ZPass Save Popup — 独立 OS 窗口内部脚本
// ----------------------------------------------------------------------------
// 该脚本运行在 chrome.windows.create({ type: "popup" }) 打开的独立窗口里，
// origin = chrome-extension://<id>。脱离宿主页面 DOM 生命周期，无论登录页
// 如何跳转 / SPA 重绘都不会被销毁，用户有足够时间确认保存。
//
// 与已废弃的 in-page notification-bar iframe 方案相比：
//   - 不再受宿主页面跳转 / unload 影响——独立 OS 窗口、独立进程视图。
//   - 与 background 通信走 browser.runtime.sendMessage（自身就在扩展上下文）。
//   - 启动后通过 zpass.savePopupFetch 主动拉 capture；background 把 capture
//     绑定到 popup 的 windowId 上（不能通过 URL 传明文密码）。
// ============================================================================

import type {
  SaveLoginDecision,
  ShowSaveToastMessage,
} from "../../src/shared/messages";
import { zMatrixIcon } from "../../src/shared/icons";
import "./style.css";

/** 当前 popup 窗口的 id，启动时由 browser.windows.getCurrent() 拿到。 */
let currentWindowId: number | null = null;

bootstrap();

async function bootstrap(): Promise<void> {
  try {
    const win = await browser.windows.getCurrent();
    if (typeof win.id === "number") currentWindowId = win.id;
  } catch {
    // 取不到 windowId 也继续——background 也可以从 sender.tab.windowId 推断。
  }

  // 监听 background 主动推升级 payload（locked → save 的解锁回放路径）。
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string };
    if (!msg || typeof msg !== "object") return undefined;
    if (msg.type === "zpass.showSaveToast") {
      renderSaveBar(message as ShowSaveToastMessage);
    } else if (msg.type === "zpass.showLocked") {
      renderLockedBar();
    }
    return undefined;
  });

  // 主动 fetch 一次：刚启动时 background 已经持有 capture，直接拿来渲染。
  try {
    const response = (await browser.runtime.sendMessage({
      type: "zpass.savePopupFetch",
      payload: { windowId: currentWindowId },
    })) as
      | {
          ok: boolean;
          result?: {
            decision: SaveLoginDecision;
            capture: ShowSaveToastMessage["capture"];
          };
          error?: string;
        }
      | undefined;
    if (response?.ok && response.result) {
      const { decision, capture } = response.result;
      if (decision.status === "locked") {
        renderLockedBar();
      } else {
        renderSaveBar({ type: "zpass.showSaveToast", decision, capture });
      }
    } else {
      renderError(response?.error ?? "未能加载保存信息。");
    }
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

/* ============================================================================
 * 渲染：保存 / 更新登录条
 * ========================================================================== */

function renderSaveBar(payload: ShowSaveToastMessage): void {
  const { decision, capture } = payload;
  const isUpdate = decision.status === "update";
  const title = isUpdate ? "更新 ZPass 中的密码？" : "保存登录到 ZPass？";
  const subtitle = isUpdate
    ? `${decision.itemName || decision.origin} 的密码已变更。`
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
      void browser.runtime.sendMessage({
        type: "zpass.ignoreSaveOrigin",
        payload: { origin: capture.origin, url: capture.url },
      });
      close();
      return;
    }
    if (action === "save") {
      void handleSave(payload, bar);
    }
  });

  root.append(bar);
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
    origin: capture.origin,
    url: capture.url,
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
    window.setTimeout(close, 2000);
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

  const bar = createBarSkeleton("ZPass 已锁定", "解锁桌面端后将自动继续保存。");

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
      // 不关窗：让用户继续看到「锁定中」直到 background 主推升级后的
      // zpass.showSaveToast 把内容替换为 save bar。
      return;
    }
    close();
  });

  root.append(bar);
}

/* ============================================================================
 * 渲染：完成态 / 错误态
 * ========================================================================== */

function renderSuccess(title: string, subtitle: string): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";
  root.append(createBarSkeleton(title, subtitle));
}

function renderError(message: string): void {
  const root = document.getElementById("root");
  if (!root) return;
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
  icon.innerHTML = zMatrixIcon({ size: 22 });

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

  const body = document.createElement("div");
  body.className = "bar-body";

  const actions = document.createElement("div");
  actions.className = "bar-actions";

  bar.append(head, body, actions);
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
  // 独立 OS 窗口直接 window.close()；background 的 windows.onRemoved 监听
  // 会负责清理 windowId ↔ pendingKey 映射。
  window.close();
}
