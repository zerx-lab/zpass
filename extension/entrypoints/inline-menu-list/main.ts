// 内联自动填充列表 iframe 内页。
//
// 架构形状参考 Bitwarden 浏览器扩展(GPL-3.0, bitwarden/clients,
// apps/browser/src/autofill/overlay/inline-menu/pages/list/*):
//
//   - 本页运行在扩展自身 origin, 直接 chrome.runtime.connect 到 background
//   - background 推 init(portKey, origin, translations) + updateCiphers(items)
//   - 渲染列表; 用户点击 → port.postMessage({ command: FillSelected })
//   - background 收到后调 revealLogin 并广播 zpass.fillLogin 给 tab
//
// 干净室实现, 未复制 Bitwarden 源码。

import {
  InlineMenuBackgroundCommand,
  InlineMenuListCommand,
  InlineMenuPort,
  type InlineMenuCiphersPayload,
  type InlineMenuCipherSummary,
  type InlineMenuIframeMessage,
  type InlineMenuInitPayload,
} from "../../src/shared/inline-menu-enums";
import "./list.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root in inline-menu-list iframe");

let port: Browser.runtime.Port | null = null;
let portKey: string | null = null;
let translations: InlineMenuInitPayload["translations"] | null = null;
let currentOrigin: string = "";
let ciphers: InlineMenuCiphersPayload | null = null;
let focusedRowIndex = -1;

connectPort();

function connectPort(): void {
  try {
    port = browser.runtime.connect({ name: InlineMenuPort.List });
  } catch {
    renderError("ZPass 扩展未能就绪");
    return;
  }
  port.onMessage.addListener((raw: unknown) => handlePortMessage(raw));
  port.onDisconnect.addListener(() => {
    port = null;
    portKey = null;
  });
}

function handlePortMessage(raw: unknown): void {
  const message = raw as InlineMenuIframeMessage | undefined;
  if (!message || typeof message !== "object") return;
  switch (message.command) {
    case InlineMenuBackgroundCommand.Init:
      handleInit(message);
      return;
    case InlineMenuBackgroundCommand.UpdateCiphers:
      handleCiphers(message);
      return;
    case InlineMenuBackgroundCommand.Close:
      // background 主动要求关闭 —— content 那边已经移除了 iframe,
      // 这里基本拿不到此消息(iframe 早被 unmount), 防御性 noop。
      return;
    default:
      // FadeIn / UpdatePosition 与本页无关(外壳处理), 静默。
      return;
  }
}

function handleInit(message: InlineMenuIframeMessage): void {
  const payload = (message.payload ?? null) as InlineMenuInitPayload | null;
  if (!payload || typeof payload !== "object") return;
  portKey = payload.portKey;
  translations = payload.translations;
  currentOrigin = payload.origin;
  render();
}

function handleCiphers(message: InlineMenuIframeMessage): void {
  const payload = (message.payload ?? null) as InlineMenuCiphersPayload | null;
  if (!payload || typeof payload !== "object") return;
  ciphers = payload;
  focusedRowIndex = ciphers.items.length > 0 ? 0 : -1;
  render();
}

function render(): void {
  if (!translations || !portKey) {
    // 还没收到 init —— 维持隐藏。
    return;
  }
  root!.hidden = false;
  root!.replaceChildren(buildShell());
  // 关键:render 时**不**自动 focusRow。
  // 一旦在 iframe 内 focus, 宿主 input 立刻 focusout, controller 会
  // scheduleBlurClose 120ms 后关菜单 → 死循环(关掉再 open 再 focus 再
  // 关掉)。键盘 ArrowDown 走 host controller 那边专门发的开列表请求,
  // 由那条路径触发 focusRow。鼠标 hover/click 不需要预聚焦。
  reportHeight();
}

/**
 * 测量 .shell 的实际像素高度并上报给 parent 的 IframeShell。
 *
 * iframe 元素默认高度 150px(HTML 规范), `height: auto` 对 iframe 不会
 * 按内容自适应 —— 不上报的话, 单条目浮层下半部分是透明 iframe 内容区,
 * 宿主页的"登录"按钮等元素会从透明区域穿透出来, 视觉上像被遮挡。
 *
 * 我们用 parent.postMessage 而非 port —— 这条消息走 host window, content
 * 主世界的 IframeShell 用 event.source === iframe.contentWindow 鉴权,
 * 宿主页 JS 即使能监听到也只会看到一个高度数字, 无敏感数据。
 */
function reportHeight(): void {
  globalThis.requestAnimationFrame(() => {
    const shell = root!.firstElementChild as HTMLElement | null;
    if (!shell) return;
    const height = Math.ceil(shell.scrollHeight);
    if (height <= 0) return;
    try {
      window.parent.postMessage(
        { source: "zpass-inline-menu", type: "resize", height },
        "*",
      );
    } catch {
      // parent 已断或 sandbox 阻止 —— 静默。
    }
  });
}

function buildShell(): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "shell";
  shell.append(buildHeader());
  shell.append(buildBody());
  return shell;
}

function buildHeader(): HTMLElement {
  const header = document.createElement("div");
  header.className = "header";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = translations?.title ?? "ZPass";
  header.append(title);
  if (currentOrigin) {
    const origin = document.createElement("span");
    origin.className = "origin";
    origin.textContent = hostnameOf(currentOrigin);
    origin.title = currentOrigin;
    header.append(origin);
  }
  return header;
}

function buildBody(): HTMLElement {
  if (!ciphers) {
    // 收到 init 但 ciphers 还没到 —— 占位避免空 shell。
    return placeholder(translations!.title, "正在加载…", null);
  }
  if (!ciphers.unlocked) {
    return placeholder(
      translations!.lockedTitle,
      translations!.lockedDescription,
      {
        label: translations!.unlockCta,
        onClick: () => sendUpstream(InlineMenuListCommand.Unlock),
      },
    );
  }
  if (ciphers.items.length === 0) {
    return placeholder(
      translations!.emptyTitle,
      translations!.emptyDescription,
      null,
    );
  }
  const list = document.createElement("ul");
  list.className = "list";
  list.setAttribute("role", "listbox");
  ciphers.items.forEach((item, index) => {
    list.append(buildRow(item, index));
  });
  return list;
}

function buildRow(item: InlineMenuCipherSummary, index: number): HTMLElement {
  const li = document.createElement("li");
  li.setAttribute("role", "presentation");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "row";
  btn.dataset.index = String(index);
  btn.setAttribute("role", "option");
  btn.setAttribute("aria-label", `${item.name || item.username || "登录条目"}`);
  btn.addEventListener("click", () => fillItem(item));
  btn.addEventListener("focus", () => {
    focusedRowIndex = index;
  });
  btn.addEventListener("keydown", (event) => handleRowKeydown(event, index));

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.append(keyIconSvg());
  btn.append(badge);

  const text = document.createElement("span");
  text.className = "text";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = item.name || hostnameOf(currentOrigin) || "登录条目";
  text.append(name);
  if (item.username) {
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = item.username;
    text.append(meta);
  }
  btn.append(text);

  if (item.hasTotp) {
    const tag = document.createElement("span");
    tag.className = "totp-tag";
    tag.textContent = "TOTP";
    btn.append(tag);
  }

  li.append(btn);
  return li;
}

function placeholder(
  title: string,
  description: string,
  cta: { label: string; onClick: () => void } | null,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "placeholder";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const p = document.createElement("p");
  p.textContent = description;
  wrap.append(strong, p);
  if (cta) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unlock-cta";
    btn.textContent = cta.label;
    btn.addEventListener("click", cta.onClick);
    wrap.append(btn);
  }
  return wrap;
}

function handleRowKeydown(event: KeyboardEvent, index: number): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusRow(index + 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    focusRow(index - 1);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    sendUpstream(InlineMenuListCommand.Close);
  }
}

function focusRow(index: number): void {
  const rows = Array.from(
    root!.querySelectorAll<HTMLButtonElement>("button.row"),
  );
  if (rows.length === 0) return;
  const clamped = Math.max(0, Math.min(index, rows.length - 1));
  const target = rows[clamped];
  if (!target) return;
  rows.forEach((r) => r.removeAttribute("data-focused"));
  target.setAttribute("data-focused", "true");
  try {
    target.focus({ preventScroll: false });
  } catch {
    // 视图未真正聚焦时(iframe 没拿到焦点), 静默。
  }
  focusedRowIndex = clamped;
}

function fillItem(item: InlineMenuCipherSummary): void {
  sendUpstream(InlineMenuListCommand.FillSelected, { itemId: item.itemId });
}

function sendUpstream(
  command: string,
  extra: Record<string, unknown> = {},
): void {
  if (!port || !portKey) return;
  const message: InlineMenuIframeMessage = {
    source: "zpass-inline-menu",
    portKey,
    command,
    ...extra,
  };
  try {
    port.postMessage(message);
  } catch {
    // 端口可能已断 —— 不再重试, content 那边的 injector 会按 blur/Escape
    // 自己清场。
  }
}

function renderError(message: string): void {
  root!.hidden = false;
  root!.replaceChildren(placeholder("ZPass", message, null));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** 简单的钥匙图标 SVG —— 与 shared/icons.ts 同 lucide 风格, 不引入额外依赖。 */
function keyIconSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "7.5");
  circle.setAttribute("cy", "15.5");
  circle.setAttribute("r", "3.5");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M10 13l11-11M16 8l4 4M14 10l4 4");
  svg.append(circle, path);
  return svg;
}
