import type {
  LoginSecret,
  LoginSummary,
  PasskeyDescriptor,
  PasskeyListResult,
  QueryLoginsResult,
  VaultStatus,
} from "../shared/messages";
import {
  alertIcon,
  checkIcon,
  copyIcon,
  keyIcon,
  lockIcon,
  powerIcon,
  refreshIcon,
  searchIcon,
  shieldIcon,
  zMatrixIcon,
} from "../shared/icons";
import { el } from "../shared/dom";
import "./popup.css";

/* ============================================================================
 * Popup 渲染入口
 * ----------------------------------------------------------------------------
 * 状态机：
 *   ① CHECKING        刚打开 popup，向 background 询问状态中
 *   ② DISCONNECTED    桌面端 native host 不可达
 *   ③ NOT_INITIALIZED 桌面端尚未创建保险库
 *   ④ LOCKED          桌面端已初始化但锁定
 *   ⑤ MATCHES         正常列出匹配的登录项 + Passkey
 *
 * 与旧实现的关键差异：
 *   - header 持久化，状态切换只换主区域，不再整段重渲染
 *   - 每行末尾内联「复制用户名 / 复制密码」mini button
 *   - 匹配项 > 3 时显示搜索框，支持名称 / 域名 / 用户名过滤
 *   - 错误状态附带可操作 CTA（重试 / 复制 Extension ID）
 *   - Passkey 行带正确语义（role=listitem + aria-label 说明触发方式）
 * ========================================================================== */

interface RenderContext {
  // exactOptionalPropertyTypes 下显式允许 undefined，避免赋值时收紧
  host?: string | undefined;
  status?: VaultStatus | undefined;
}

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing popup root.");
const root = app;

void main();

async function main(): Promise<void> {
  const ctx: RenderContext = {};
  ctx.host = await currentHost();
  renderShell(ctx);
  await refresh(ctx);
}

async function refresh(ctx: RenderContext): Promise<void> {
  setMainBusy(true);
  try {
    const statusResponse = await browser.runtime.sendMessage({
      type: "zpass.status",
    });
    if (!statusResponse?.ok) {
      ctx.status = undefined;
      updateHeaderState(ctx);
      renderState({
        tone: "err",
        icon: alertIcon(22),
        title: "桌面端未连接",
        description: `${statusResponse?.error ?? "请安装 native messaging host。"}\n\nExtension ID: ${browser.runtime.id}`,
        actions: [
          {
            label: "重试",
            primary: true,
            icon: refreshIcon(14),
            onClick: () => void refresh(ctx),
          },
          {
            label: "复制 Extension ID",
            icon: copyIcon(14),
            onClick: () =>
              void copyToClipboard(browser.runtime.id, "已复制 Extension ID"),
          },
        ],
      });
      return;
    }
    const status = statusResponse.result as VaultStatus;
    ctx.status = status;
    updateHeaderState(ctx);

    if (!status.initialized) {
      renderState({
        tone: "warn",
        icon: powerIcon(22),
        title: "保险库未初始化",
        description: "打开 ZPass Desktop 并创建保险库后回到这里。",
        actions: [
          {
            label: "刷新状态",
            primary: true,
            icon: refreshIcon(14),
            onClick: () => void refresh(ctx),
          },
        ],
      });
      return;
    }
    if (!status.unlocked) {
      renderState({
        tone: "locked",
        icon: lockIcon(22),
        title: "保险库已锁定",
        description: "解锁 ZPass Desktop 后才能使用自动填充和 Passkey。",
        actions: [
          {
            label: "已解锁，刷新",
            primary: true,
            icon: refreshIcon(14),
            onClick: () => void refresh(ctx),
          },
        ],
      });
      return;
    }

    const queryResponse = await browser.runtime.sendMessage({
      type: "zpass.queryLogins",
    });
    if (!queryResponse?.ok) {
      renderState({
        tone: "err",
        icon: alertIcon(22),
        title: "无法检查当前页面",
        description: queryResponse?.error ?? "请打开 http 或 https 页面。",
        actions: [
          {
            label: "重试",
            primary: true,
            icon: refreshIcon(14),
            onClick: () => void refresh(ctx),
          },
        ],
      });
      return;
    }
    const loginResult = queryResponse.result as QueryLoginsResult;
    const passkeyResult = await queryPasskeysForActiveTab();
    renderMatches(ctx, loginResult, passkeyResult?.items ?? []);
  } finally {
    setMainBusy(false);
  }
}

/* ============ 框架 ============ */

function renderShell(ctx: RenderContext): void {
  root.replaceChildren(
    el("section", {
      class: "panel",
      attrs: { "aria-busy": "false" },
      children: [
        renderHeader(ctx),
        el("div", { class: "zp-main", attrs: { id: "zp-main" } }),
      ],
    }),
  );
}

function setMainBusy(busy: boolean): void {
  root
    .querySelector<HTMLElement>(".panel")
    ?.setAttribute("aria-busy", busy ? "true" : "false");
}

function renderHeader(ctx: RenderContext): HTMLElement {
  return el("header", {
    class: "zp-header",
    children: [
      el("span", { class: "zp-header-logo", html: zMatrixIcon({ size: 22 }) }),
      el("strong", { class: "zp-header-title", text: "ZPass" }),
      el("span", { class: "zp-header-spacer" }),
      renderStatusPill(ctx),
      el("button", {
        class: "zp-icon-btn",
        attrs: { type: "button", "aria-label": "刷新", title: "刷新" },
        html: refreshIcon(15),
        on: { click: () => void refresh(ctx) },
      }),
    ],
  });
}

function renderStatusPill(ctx: RenderContext): HTMLElement {
  let state: string;
  let label: string;
  if (!ctx.status) {
    state = "";
    label = "Checking";
  } else if (!ctx.status.initialized) {
    state = "warn";
    label = "Setup";
  } else if (!ctx.status.unlocked) {
    state = "locked";
    label = "Locked";
  } else {
    state = "ok";
    label = "Unlocked";
  }
  return el("span", {
    class: "zp-status-pill",
    attrs: { "data-state": state, "aria-live": "polite" },
    text: label,
  });
}

function updateHeaderState(ctx: RenderContext): void {
  const old = root.querySelector<HTMLElement>(".zp-status-pill");
  if (old) old.replaceWith(renderStatusPill(ctx));
}

function getMain(): HTMLElement {
  const main = root.querySelector<HTMLElement>("#zp-main");
  if (!main) throw new Error("Missing #zp-main");
  return main;
}

/* ============ 状态视图 ============ */

interface StateView {
  tone: "locked" | "warn" | "err" | "empty";
  icon: string;
  title: string;
  description: string;
  actions?: {
    label: string;
    icon?: string;
    primary?: boolean;
    onClick: () => void;
  }[];
}

function buildStateView(view: StateView): HTMLElement {
  const buttons = (view.actions ?? []).map((action) => {
    const btn = el("button", {
      class: `zp-btn${action.primary ? " zp-btn-primary" : ""}`,
      attrs: { type: "button" },
      children: [
        action.icon ? svgSpan(action.icon) : null,
        document.createTextNode(action.label),
      ],
    });
    btn.addEventListener("click", action.onClick);
    return btn;
  });
  return el("div", {
    class: "zp-state",
    attrs: { "data-tone": view.tone },
    children: [
      el("div", { class: "zp-state-icon", html: view.icon }),
      el("h2", { class: "zp-state-title", text: view.title }),
      el("p", { class: "zp-state-desc", text: view.description }),
      buttons.length > 0
        ? el("div", { class: "zp-state-actions", children: buttons })
        : null,
    ],
  });
}

function renderState(view: StateView): void {
  getMain().replaceChildren(buildStateView(view));
}

/* ============ 匹配视图 ============ */

type ListEntry =
  | { kind: "passkey"; item: PasskeyDescriptor }
  | { kind: "login"; item: LoginSummary };

function renderMatches(
  ctx: RenderContext,
  login: QueryLoginsResult,
  passkeys: PasskeyDescriptor[],
): void {
  const total = login.items.length + passkeys.length;
  const main = getMain();
  const context = el("div", {
    class: "zp-context",
    children: [
      el("span", {
        class: "zp-context-host",
        html: `${shieldIcon(13)} <span style="margin-left:6px;vertical-align:middle">${escapeHtml(
          ctx.host ?? "—",
        )}</span>`,
      }),
      el("span", {
        class: "zp-context-count",
        text: `${total} match${total === 1 ? "" : "es"}`,
      }),
    ],
  });

  if (total === 0) {
    main.replaceChildren(
      context,
      buildStateView({
        tone: "empty",
        icon: keyIcon(22),
        title: "没有匹配项目",
        description:
          "当前站点还没有保存在 ZPass Desktop 中的登录项或 Passkey。",
      }),
    );
    return;
  }

  const allEntries: ListEntry[] = [
    ...passkeys.map((item) => ({ kind: "passkey" as const, item })),
    ...login.items.map((item) => ({ kind: "login" as const, item })),
  ];

  const list = el("div", { class: "zp-list", attrs: { role: "list" } });

  const renderList = (query: string): void => {
    list.replaceChildren();
    const filtered = filterEntries(allEntries, query);
    const filteredPasskeys = filtered.filter(
      (entry): entry is Extract<ListEntry, { kind: "passkey" }> =>
        entry.kind === "passkey",
    );
    const filteredLogins = filtered.filter(
      (entry): entry is Extract<ListEntry, { kind: "login" }> =>
        entry.kind === "login",
    );

    if (filteredPasskeys.length > 0) {
      list.append(el("div", { class: "zp-section-title", text: "Passkey" }));
      for (const entry of filteredPasskeys)
        list.append(renderPasskeyRow(entry.item));
    }
    if (filteredLogins.length > 0) {
      list.append(el("div", { class: "zp-section-title", text: "登录项" }));
      for (const entry of filteredLogins)
        list.append(renderLoginRow(entry.item));
    }
    if (filteredPasskeys.length === 0 && filteredLogins.length === 0) {
      list.append(
        el("div", {
          class: "zp-section-title",
          attrs: { style: "padding:16px 14px;text-align:center" },
          text: "没有匹配的项",
        }),
      );
    }
  };

  const children: Node[] = [context];
  let searchInput: HTMLInputElement | null = null;
  if (total > 3) {
    searchInput = el("input", {
      attrs: {
        type: "search",
        placeholder: "搜索登录项 / Passkey…",
        "aria-label": "搜索",
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    searchInput.addEventListener("input", () => renderList(searchInput!.value));
    children.push(
      el("div", {
        class: "zp-search",
        children: [
          el("span", { class: "zp-search-icon", html: searchIcon(14) }),
          searchInput,
        ],
      }),
    );
  }
  children.push(list);
  main.replaceChildren(...children);
  renderList("");
  searchInput?.focus();
}

function filterEntries(entries: ListEntry[], query: string): ListEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) => {
    if (entry.kind === "passkey") {
      const p = entry.item;
      return [p.name, p.userDisplayName, p.userName, p.rpId, p.rpName].some(
        (s) => s?.toLowerCase().includes(q),
      );
    }
    const l = entry.item;
    return [l.name, l.username, l.displayUrl].some((s) =>
      s?.toLowerCase().includes(q),
    );
  });
}

/**
 * 渲染单条凭据行。与 Bitwarden popup 行为对齐：
 *
 *   点击整行：
 *     - hasPassword + hasTotp → 填账密 + 自动复制 TOTP，关闭 popup
 *     - hasPassword only      → 填账密，关闭 popup
 *     - hasTotp only          → 复制 TOTP 到剪贴板，不关闭 popup
 *     - 都没 (理论上不会发生) → 提示“条目为空”
 *
 *   右边 mini 按钮按存在的字段按需出现：
 *     - username 非空 → 复制用户名
 *     - hasPassword → 复制密码
 *     - hasTotp → 复制当前验证码
 *
 *   图标依 itemType 区分（独立 TOTP 条目用时钟，login 用钥匙），
 *   在混合条目（login + totp）上仍用钥匙图标（与 Bitwarden 一致，主身份
 *   仍是账号类，TOTP 是附加能力）。
 */
function renderLoginRow(item: LoginSummary): HTMLElement {
  const iconHtml = item.itemType === "totp" ? clockIcon(15) : keyIcon(15);
  const row = el("button", {
    class: "zp-row",
    attrs: {
      type: "button",
      "data-kind": "login",
      "data-item-type": item.itemType,
      role: "listitem",
    },
    children: [
      el("span", { class: "zp-row-icon", html: iconHtml }),
      el("span", { class: "zp-row-name", text: item.name || item.displayUrl }),
      el("span", {
        class: "zp-row-meta",
        text: item.username || item.displayUrl,
      }),
      el("span", {
        class: "zp-row-actions",
        children: [
          item.username
            ? miniCopyButton("复制用户名", item.username, "已复制用户名")
            : null,
          item.hasPassword ? miniRevealPasswordButton(item) : null,
          item.hasTotp ? miniRevealTotpButton(item) : null,
        ],
      }),
    ],
  });
  row.addEventListener("click", (event) => {
    // 防止子按钮的 click 冒泡触发「填充整行」
    if ((event.target as HTMLElement).closest(".zp-mini-btn")) return;
    void handleRowClick(item);
  });
  return row;
}

/**
 * 行点击总调度。按条目形态分流，与 Bitwarden 「doAutoFill + shouldAutoCopyTotp」逻辑对齐。
 *
 * 返回：仅错误场景可能 showInlineToast，不抩出错误。
 */
async function handleRowClick(item: LoginSummary): Promise<void> {
  // 独立 TOTP 条目（或仅存 TOTP 没存密码的 login）→ 复制验证码，不关闭 popup
  if (!item.hasPassword) {
    if (!item.hasTotp) {
      showInlineToast("该条目为空。");
      return;
    }
    await copyTotpToClipboard(item);
    return;
  }
  // 有密码 → 填账密；如同时有 TOTP 则自动复制到剪贴板（Bitwarden 默认行为）
  await fillActiveTab(item);
}

/**
 * 调 background 生成该条目的当前 TOTP 码并复制。错误静默提示。
 */
async function copyTotpToClipboard(item: LoginSummary): Promise<void> {
  const response = (await browser.runtime.sendMessage({
    type: "zpass.generateLoginTotp",
    itemId: item.id,
  })) as
    | { ok?: boolean; result?: { code?: string }; error?: string }
    | undefined;
  if (!response?.ok || !response.result?.code) {
    showInlineToast(response?.error ?? "无法生成验证码");
    return;
  }
  await copyToClipboard(response.result.code, "已复制验证码");
}

function renderPasskeyRow(item: PasskeyDescriptor): HTMLElement {
  // Passkey 由网站的 WebAuthn 按钮触发，popup 内只做展示，不是按钮
  return el("div", {
    class: "zp-row",
    attrs: {
      "data-kind": "passkey",
      role: "listitem",
      tabindex: "0",
      "aria-label": `Passkey ${item.userDisplayName || item.userName || item.name}，由网站登录按钮触发`,
      title: "Passkey - 由网站登录按钮触发",
    },
    children: [
      el("span", { class: "zp-row-icon", html: keyIcon(15) }),
      el("span", {
        class: "zp-row-name",
        text: item.userDisplayName || item.userName || item.name,
      }),
      el("span", { class: "zp-row-meta", text: `${item.rpId} · Passkey` }),
    ],
  });
}

function miniCopyButton(
  label: string,
  value: string,
  toast: string,
): HTMLElement {
  const button = el("button", {
    class: "zp-mini-btn",
    attrs: { type: "button", "aria-label": label, title: label },
    html: copyIcon(13),
  });
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await copyToClipboard(value, toast);
    flashCopied(button);
  });
  return button;
}

function miniRevealPasswordButton(item: LoginSummary): HTMLElement {
  const button = el("button", {
    class: "zp-mini-btn",
    attrs: { type: "button", "aria-label": "复制密码", title: "复制密码" },
    html: copyIcon(13),
  });
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const response = (await browser.runtime.sendMessage({
      type: "zpass.revealLogin",
      itemId: item.id,
    })) as { ok?: boolean; result?: LoginSecret; error?: string } | undefined;
    if (!response?.ok || !response.result?.password) {
      showInlineToast(response?.error ?? "无法读取密码");
      return;
    }
    await copyToClipboard(response.result.password, "已复制密码");
    flashCopied(button);
  });
  return button;
}

/**
 * 复制当前 TOTP 验证码的 mini 按钮。与「复制密码」同一风格，但走 generateLoginTotp
 * 获取现场潮。点击不关闭 popup（跟「复制密码」一致）。
 */
function miniRevealTotpButton(item: LoginSummary): HTMLElement {
  const button = el("button", {
    class: "zp-mini-btn",
    attrs: { type: "button", "aria-label": "复制验证码", title: "复制验证码" },
    html: clockIcon(13),
  });
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const response = (await browser.runtime.sendMessage({
      type: "zpass.generateLoginTotp",
      itemId: item.id,
    })) as
      | { ok?: boolean; result?: { code?: string }; error?: string }
      | undefined;
    if (!response?.ok || !response.result?.code) {
      showInlineToast(response?.error ?? "无法生成验证码");
      return;
    }
    await copyToClipboard(response.result.code, "已复制验证码");
    flashCopied(button);
  });
  return button;
}

/**
 * 时钟图标 — 与 shared/icons.ts 同风（stroke 1.75 lucide 风）。未提到 shared
 * 是因为现阶段仅 popup 用。
 */
function clockIcon(size = 13): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
}

function flashCopied(button: HTMLElement): void {
  button.innerHTML = checkIcon(13);
  button.setAttribute("data-copied", "true");
  window.setTimeout(() => {
    button.innerHTML = copyIcon(13);
    button.removeAttribute("data-copied");
  }, 1400);
}

/* ============ 工具 ============ */

async function copyToClipboard(
  text: string,
  toastMessage: string,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showInlineToast(toastMessage);
  } catch {
    showInlineToast("复制失败，请手动复制");
  }
}

function showInlineToast(message: string): void {
  document.querySelector(".zp-toast-inline")?.remove();
  const toast = el("div", {
    class: "zp-toast-inline",
    attrs: { role: "status", "aria-live": "polite" },
    text: message,
  });
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 1800);
}

function svgSpan(svg: string): HTMLElement {
  return el("span", { html: svg, attrs: { "aria-hidden": "true" } });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function currentHost(): Promise<string | undefined> {
  const [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.url) return undefined;
  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return undefined;
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

async function queryPasskeysForActiveTab(): Promise<PasskeyListResult | null> {
  const [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.url) return null;
  const rpId = getRpId(tab.url);
  if (!rpId) return null;
  const response = await browser.runtime.sendMessage({
    type: "zpass.passkeyList",
    payload: { rpId },
  });
  if (!response?.ok) return null;
  const result = response.result as PasskeyListResult;
  return result.unlocked ? result : null;
}

function getRpId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * 填充当前标签页的账密 + （可选）自动复制 TOTP。
 *
 * background 返回中会携带 totpCode（有 totp 秘钥的账号）。只要 totpCode 非空，
 * 在 popup 关闭前同步复制到剪贴板——这是 Bitwarden enableAutoTotpCopy=true
 * 默认行为。Toast 在复制后短暂提示 600ms 再关 popup，让用户看到反馈。
 *
 * 与原状区别：仅能处理 hasPassword 场景（handleRowClick 已提前准出）。
 */
async function fillActiveTab(item: LoginSummary): Promise<void> {
  const response = (await browser.runtime.sendMessage({
    type: "zpass.fillActiveTab",
    itemId: item.id,
  })) as
    | {
        ok?: boolean;
        result?: { filled?: boolean; totpCode?: string | null };
        error?: string;
      }
    | undefined;
  if (!response?.ok) {
    showInlineToast(response?.error ?? "ZPass 无法填充当前页面。");
    return;
  }
  const totpCode = response.result?.totpCode;
  if (totpCode) {
    try {
      await navigator.clipboard.writeText(totpCode);
      showInlineToast("已填充账密 · 验证码已复制");
      window.setTimeout(() => window.close(), 700);
      return;
    } catch {
      // 剪贴板失败不抩提示——账密填充仍是主动作。快速关 popup。
    }
  }
  window.close();
}
