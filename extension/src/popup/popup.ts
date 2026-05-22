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
  asterisksIcon,
  checkIcon,
  copyIcon,
  keyIcon,
  lockIcon,
  powerIcon,
  refreshIcon,
  searchIcon,
  shieldIcon,
  userIcon,
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

// 模块级 ctx 引用 —— 让 handleRowClick 等事件点刷新 popup。
// popup 生命周期内唯一，不紧调。
let currentCtx: RenderContext | null = null;

void main();

async function main(): Promise<void> {
  const ctx: RenderContext = {};
  ctx.host = await currentHost();
  currentCtx = ctx;
  renderShell(ctx);
  await refresh(ctx);
}

async function refresh(ctx: RenderContext): Promise<void> {
  setMainBusy(true);
  try {
    // 1) liveness 探测：首先确认 GUI 在线。ping 不会触发 spawn，
    //    快速返回。避免出现「列表看似可用但点击空响」。
    ctx.status = undefined;
    updateHeaderState(ctx);
    const pingResponse = await browser.runtime.sendMessage({
      type: "zpass.ping",
    });
    if (!pingResponse?.ok) {
      const errMsg = String(pingResponse?.error ?? "");
      // nativehost 连不上 GUI —— 正是「desktop 未启」场景，渲染
      // 一键启动状态。区别「native host 未安装」则看错误详情。
      const desktopOffline =
        errMsg.includes("not running") || errMsg.includes("unavailable");
      if (desktopOffline) {
        renderDesktopOffline(ctx);
      } else {
        renderNativeHostMissing(ctx, errMsg);
      }
      return;
    }

    // 2) GUI 在线 → 拉 status
    const statusResponse = await browser.runtime.sendMessage({
      type: "zpass.status",
    });
    if (!statusResponse?.ok) {
      const errMsg = String(statusResponse?.error ?? "");
      // 与 ping 间隐 race：GUI 刚被关。退化为 desktop offline 状态。
      if (errMsg.includes("starting up")) {
        renderState({
          tone: "warn",
          icon: powerIcon(22),
          title: "桌面端启动中",
          description: "ZPass Desktop 正在启动，请稍等…",
          actions: [
            {
              label: "重试",
              primary: true,
              icon: refreshIcon(14),
              onClick: () => refresh(ctx),
              successToast: "已重试",
            },
          ],
        });
        globalThis.setTimeout(() => void refresh(ctx), 1500);
        return;
      }
      renderDesktopOffline(ctx);
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
            onClick: () => refresh(ctx),
            successToast: "已刷新",
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
            onClick: () => refresh(ctx),
            successToast: "已刷新",
          },
        ],
      });
      return;
    }

    // status 确认 unlocked 后，queryLogins 与 queryPasskeysForActiveTab 互不依赖。
    // 串行 → 并行省一个 sendMessage RTT（每个 RTT 含 SW 到2native一趟来回，冷启动 可能 100ms）。
    const [queryResponse, passkeyResult] = await Promise.all([
      browser.runtime.sendMessage({ type: "zpass.queryLogins" }),
      queryPasskeysForActiveTab(),
    ]);
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
            onClick: () => refresh(ctx),
            successToast: "已重试",
          },
        ],
      });
      return;
    }
    const loginResult = queryResponse.result as QueryLoginsResult;
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
      buildHeaderRefreshButton(ctx),
    ],
  });
}

// buildHeaderRefreshButton header 右侧的刷新按钮 —— 点击后图标
// 旋转、按钮禁用，刷新完成后弹一个「已刷新」toast。
function buildHeaderRefreshButton(ctx: RenderContext): HTMLElement {
  const iconEl = svgSpan(refreshIcon(15), "zp-spin-icon");
  const btn = el("button", {
    class: "zp-icon-btn",
    attrs: { type: "button", "aria-label": "刷新", title: "刷新" },
    children: [iconEl],
  });
  btn.addEventListener("click", async () => {
    if (btn.hasAttribute("disabled")) return;
    btn.setAttribute("disabled", "");
    iconEl.setAttribute("data-spinning", "true");
    try {
      await refresh(ctx);
      showInlineToast("已刷新");
    } finally {
      if (btn.isConnected) {
        btn.removeAttribute("disabled");
        iconEl.removeAttribute("data-spinning");
      }
    }
  });
  return btn;
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

interface StateActionDef {
  label: string;
  icon?: string;
  primary?: boolean;
  onClick: () => void | Promise<void>;
  // 点击后完成时弹 toast 提示 (默认不弹)
  successToast?: string;
  // 点击期间在按钮上旋转图标 (默认 true —— 不想要动画传 false)
  spinWhilePending?: boolean;
}

interface StateView {
  tone: "locked" | "warn" | "err" | "empty";
  icon: string;
  title: string;
  description: string;
  actions?: StateActionDef[];
}

function buildStateView(view: StateView): HTMLElement {
  const buttons = (view.actions ?? []).map((action) => {
    return buildAsyncActionButton(action);
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

// buildAsyncActionButton为状态面板按钮提供「点击 → 旋转中 → 完成 toast」
// 的统一可视反馈。图标被包进 .zp-spin-icon 可送动画宿主，点击后加
// `data-spinning="true"` 让 CSS 起旋转；onClick 完成后取消。
function buildAsyncActionButton(action: StateActionDef): HTMLElement {
  const iconEl = action.icon ? svgSpan(action.icon, "zp-spin-icon") : null;
  const btn = el("button", {
    class: `zp-btn${action.primary ? " zp-btn-primary" : ""}`,
    attrs: { type: "button" },
    children: [iconEl, document.createTextNode(action.label)],
  });
  const spinWhile = action.spinWhilePending !== false;
  btn.addEventListener("click", async () => {
    if (btn.hasAttribute("disabled")) return;
    btn.setAttribute("disabled", "");
    if (spinWhile && iconEl) iconEl.setAttribute("data-spinning", "true");
    try {
      await action.onClick();
      if (action.successToast) showInlineToast(action.successToast);
    } finally {
      // 按钮可能随 renderState 被销毁（refresh 会渲染新面板），
      // 付付会跳接。安全 fallback。
      if (btn.isConnected) {
        btn.removeAttribute("disabled");
        iconEl?.removeAttribute("data-spinning");
      }
    }
  });
  return btn;
}

/* ============ 与 Desktop 连接性相关的特殊状态 ============ */

// renderDesktopOffline渲染「Desktop 未启动」状态。提供一键启动按钮，
// 点击后调 zpass.launchDesktop 拉起 GUI，随后轮询 ping 直到 GUI 上线。
function renderDesktopOffline(ctx: RenderContext): void {
  renderState({
    tone: "warn",
    icon: powerIcon(22),
    title: "ZPass Desktop 未启动",
    description: "需要启动并解锁 ZPass Desktop 后才能填充账密。",
    actions: [
      {
        label: "启动 Desktop",
        primary: true,
        icon: powerIcon(14),
        onClick: () => launchDesktopAndWait(ctx),
      },
      {
        label: "重试",
        icon: refreshIcon(14),
        onClick: () => refresh(ctx),
        successToast: "已重试",
      },
    ],
  });
}

// renderNativeHostMissing区别于「desktop 未启」：连 nativehost 都调不动
// （未安装 / 错误的 extension id 注册等）。需要用户手工介入。
function renderNativeHostMissing(ctx: RenderContext, errMsg: string): void {
  renderState({
    tone: "err",
    icon: alertIcon(22),
    title: "尚未安装 native messaging host",
    description: `${translateNativeError(errMsg) || "请安装 ZPass Desktop 并运行 native messaging host 注册脚本。"}\n\nExtension ID: ${browser.runtime.id}`,
    actions: [
      {
        label: "重试",
        primary: true,
        icon: refreshIcon(14),
        onClick: () => refresh(ctx),
        successToast: "已重试",
      },
      {
        label: "复制 Extension ID",
        icon: copyIcon(14),
        // 不需旋转（复制是瞬间动作），依靠 copyToClipboard 自带 toast
        spinWhilePending: false,
        onClick: () =>
          copyToClipboard(browser.runtime.id, "已复制 Extension ID"),
      },
    ],
  });
}

// translateNativeError把 nativehost / Desktop GUI 返回的英文错误映射为中文。
// 未识别的错误原样返回。协议层错误码不动，仅展示层翻译。
function translateNativeError(errMsg: string): string {
  if (!errMsg) return errMsg;
  const map: Array<[string | RegExp, string]> = [
    [
      "ZPass Desktop is not running.",
      "ZPass Desktop 未启动。请启动并解锁后重试。",
    ],
    [
      "ZPass Desktop is unavailable. Please open ZPass Desktop and unlock the vault.",
      "ZPass Desktop 不可用，请手动打开并解锁保险库。",
    ],
    [
      "ZPass Desktop is starting up. Please try again in a moment.",
      "ZPass Desktop 正在启动，请稍候重试。",
    ],
    ["ZPass Desktop did not respond.", "ZPass Desktop 未应答。"],
    ["ZPass Desktop disconnected.", "ZPass Desktop 已断开连接。"],
    ["ZPass Desktop request failed.", "ZPass Desktop 请求失败。"],
    [
      "Unlock ZPass Desktop to use autofill.",
      "请解锁 ZPass Desktop 以使用自动填充。",
    ],
    [
      "This ZPass item does not match the current site.",
      "该 ZPass 条目与当前站点不匹配。",
    ],
    [
      "This ZPass login does not match the current site.",
      "该 ZPass 登录条目与当前站点不匹配。",
    ],
    ["Unable to read ZPass vault.", "无法读取 ZPass 保险库。"],
    ["Unable to read this ZPass login.", "无法读取该 ZPass 登录条目。"],
    ["Missing vault item id.", "缺少条目 ID。"],
    ["Invalid native message.", "无效的本地消息。"],
    ["Invalid page context.", "无效的页面上下文。"],
    ["Invalid reveal request.", "无效的查看请求。"],
    ["Invalid totp request.", "无效的 TOTP 请求。"],
    [/^Unknown native request: /, "未知本地请求："],
  ];
  for (const [pattern, zh] of map) {
    if (typeof pattern === "string") {
      if (errMsg === pattern) return zh;
    } else if (pattern.test(errMsg)) {
      return errMsg.replace(pattern, zh);
    }
  }
  return errMsg;
}

// launchDesktopAndWait调起 GUI 后轮询 ping，直到 GUI 上线或超时。
// 与 popup 生命周期绑定：popup 被关闭会中断轮询，不危险。
async function launchDesktopAndWait(ctx: RenderContext): Promise<void> {
  renderState({
    tone: "warn",
    icon: powerIcon(22),
    title: "正在启动 ZPass Desktop…",
    description: "请稍候，启动后会自动刷新。",
  });
  const launchResp = await browser.runtime.sendMessage({
    type: "zpass.launchDesktop",
  });
  if (!launchResp?.ok) {
    renderState({
      tone: "err",
      icon: alertIcon(22),
      title: "无法启动 ZPass Desktop",
      description: translateNativeError(
        String(launchResp?.error ?? "请手动打开 ZPass Desktop。"),
      ),
      actions: [
        {
          label: "重试",
          primary: true,
          icon: refreshIcon(14),
          onClick: () => refresh(ctx),
          successToast: "已重试",
        },
      ],
    });
    return;
  }
  // 轮询 ping 直到 GUI 上线，最多 10s
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((r) => globalThis.setTimeout(r, 500));
    const pingResp = await browser.runtime.sendMessage({
      type: "zpass.ping",
    });
    if (pingResp?.ok) {
      await refresh(ctx);
      return;
    }
  }
  renderDesktopOffline(ctx);
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
            ? miniCopyButton(
                "复制用户名",
                item.username,
                "已复制用户名",
                userIcon(13),
              )
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
  // 点击前再探测一次 GUI liveness：避免 popup 上中间用户关了
  // GUI，列表仍在但点击调不动。ping 快速（2s 超时）。
  const pingResp = await browser.runtime.sendMessage({
    type: "zpass.ping",
  });
  if (!pingResp?.ok) {
    if (currentCtx) await refresh(currentCtx);
    return;
  }

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
    showInlineToast(
      translateNativeError(response?.error ?? "") || "无法生成验证码",
    );
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
  iconHtml: string = copyIcon(13),
): HTMLElement {
  const button = el("button", {
    class: "zp-mini-btn",
    attrs: { type: "button", "aria-label": label, title: label },
    html: iconHtml,
  });
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await copyToClipboard(value, toast);
    flashCopied(button, iconHtml);
  });
  return button;
}

function miniRevealPasswordButton(item: LoginSummary): HTMLElement {
  const iconHtml = asterisksIcon(13);
  const button = el("button", {
    class: "zp-mini-btn",
    attrs: { type: "button", "aria-label": "复制密码", title: "复制密码" },
    html: iconHtml,
  });
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const response = (await browser.runtime.sendMessage({
      type: "zpass.revealLogin",
      itemId: item.id,
    })) as { ok?: boolean; result?: LoginSecret; error?: string } | undefined;
    if (!response?.ok || !response.result?.password) {
      showInlineToast(
        translateNativeError(response?.error ?? "") || "无法读取密码",
      );
      return;
    }
    await copyToClipboard(response.result.password, "已复制密码");
    flashCopied(button, iconHtml);
  });
  return button;
}

/**
 * 复制当前 TOTP 验证码的 mini 按钮。与「复制密码」同一风格，但走 generateLoginTotp
 * 获取现场潮。点击不关闭 popup（跟「复制密码」一致）。
 */
function miniRevealTotpButton(item: LoginSummary): HTMLElement {
  const iconHtml = clockIcon(13);
  const button = el("button", {
    class: "zp-mini-btn",
    attrs: { type: "button", "aria-label": "复制验证码", title: "复制验证码" },
    html: iconHtml,
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
      showInlineToast(
        translateNativeError(response?.error ?? "") || "无法生成验证码",
      );
      return;
    }
    await copyToClipboard(response.result.code, "已复制验证码");
    flashCopied(button, iconHtml);
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

function flashCopied(button: HTMLElement, originalIconHtml: string): void {
  button.innerHTML = checkIcon(13);
  button.setAttribute("data-copied", "true");
  window.setTimeout(() => {
    button.innerHTML = originalIconHtml;
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

function svgSpan(svg: string, className?: string): HTMLElement {
  const props: Parameters<typeof el>[1] = {
    html: svg,
    attrs: { "aria-hidden": "true" },
  };
  if (className) props.class = className;
  return el("span", props);
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
    showInlineToast(
      translateNativeError(response?.error ?? "") || "ZPass 无法填充当前页面。",
    );
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
