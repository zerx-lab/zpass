// 浏览器扩展「捕获登录 → 提示保存」核心 content-script 模块。
//
// 设计参照 Bitwarden NotificationBar / overlay-notifications 的策略：
//
//   1. 持续 watch 页面里所有 password input + 它最近的 username 候选；
//      用户每输一个字符都把当前快照存到 watcher state（仅内存，不上报）。
//   2. "提交"信号触发 finalize（拍快照 → 上报 background）：
//      a) <form>.addEventListener("submit", ...)
//      b) submit-button click（type=submit / 文案含 login/sign in 等关键词）
//      c) 在 password input 上按 Enter
//      d) URL 变化（导航 / SPA pushState / popstate）
//      e) beforeunload 兜底
//   3. 上报后立即清掉快照——避免重复触发；后续真用户在该页面又改字段
//      再次产生新快照。
//   4. 注册表单识别：同 form 内有 2 个或以上 password input 视为注册 /
//      "确认密码" 场景，不上报（Bitwarden 同启发）。
//
// 限制：
//   - 我们不试图分辨"提交成功 vs 失败"。Bitwarden 同样不分辨；接受偶尔
//     在登录失败的页面也弹一次保存提示——用户点取消就行。
//   - SPA 路由切换通过 URL 变化检测兜底，不 patch history（避免污染
//     页面全局），轮询频率低（200ms）足以捕获正常导航。

import { isTotpField } from "./totp-fields";
import { showLockedSaveToast, showSaveLoginToast } from "./ui";
import type { SaveLoginDecision } from "../shared/messages";

interface CredentialSnapshot {
  username: string;
  password: string;
  pageTitle: string;
}

interface FormWatch {
  passwordInputs: HTMLInputElement[];
  usernameInput: HTMLInputElement | null;
  currentSnapshot: CredentialSnapshot | null;
}

// formMap 把 <form>（或一个伪 form：当 password 没在 form 里时用 document）
// 映射到当前 watch 状态。
const formMap = new WeakMap<Element | Document, FormWatch>();

// 最近一次上报的指纹，用于去重——相同账密在 5 秒内不重复触发。
let lastReportedFingerprint: string | null = null;
let lastReportedAt = 0;
const REPORT_DEDUPE_WINDOW_MS = 5000;

// 启动时记下当前 URL，后续 pollUrl 用它判定是否变化（触发兜底 finalize）。
let lastUrl = "";
let urlPollTimer: ReturnType<typeof globalThis.setInterval> | null = null;

/**
 * 安装捕获 watcher。重复调用安全（重入幂等）。
 */
export function installLoginCapture(): void {
  if (lastUrl === "" && typeof location !== "undefined") {
    lastUrl = location.href;
  }
  // 在已有 password input 上 attach
  rescanDocument();

  // DOM 变化：新插入的表单也要 watch（SPA 常见）。
  const observer = new MutationObserver(() => rescanDocument());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  document.addEventListener("input", handleInput, true);
  document.addEventListener("change", handleInput, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("beforeunload", handleBeforeUnload, {
    capture: true,
  });
  window.addEventListener("pagehide", handleBeforeUnload, { capture: true });

  // URL 变化轮询（兜底 SPA pushState 不触发 popstate 的情况）。
  if (urlPollTimer === null) {
    urlPollTimer = globalThis.setInterval(() => {
      if (location.href !== lastUrl) {
        const previous = lastUrl;
        lastUrl = location.href;
        finalizeAllWatchers(`url-change ${previous} → ${lastUrl}`);
      }
    }, 250);
  }

  // 接收 background 在解锁后回放的「保存」推送。
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as {
      type?: string;
      decision?: SaveLoginDecision;
      capture?: {
        origin: string;
        url: string;
        username: string;
        password: string;
      };
    };
    if (msg?.type !== "zpass.showSaveToast" || !msg.decision || !msg.capture) {
      return undefined;
    }
    if (msg.decision.status === "new" || msg.decision.status === "update") {
      showSaveLoginToast({
        decision: msg.decision,
        username: msg.capture.username,
        password: msg.capture.password,
        suggestedName: deriveSuggestedName(),
      });
    }
    return { ok: true };
  });
}

function rescanDocument(): void {
  const passwords = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ).filter((el) => !el.disabled && !el.readOnly);
  // 按 form 分组
  const grouped = new Map<Element | Document, HTMLInputElement[]>();
  for (const pwd of passwords) {
    const scope = pwd.form ?? document;
    const list = grouped.get(scope) ?? [];
    list.push(pwd);
    grouped.set(scope, list);
  }
  for (const [scope, list] of grouped) {
    const watch = formMap.get(scope);
    if (watch) {
      watch.passwordInputs = list;
      watch.usernameInput = findUsernameInput(list[0]!);
    } else {
      formMap.set(scope, {
        passwordInputs: list,
        usernameInput: findUsernameInput(list[0]!),
        currentSnapshot: null,
      });
      // 只在首次看到该 form 时 attach submit 监听，不会重复绑。
      if (scope instanceof HTMLFormElement) {
        scope.addEventListener(
          "submit",
          () => finalizeAllWatchers("form-submit"),
          { capture: true },
        );
      }
    }
  }
}

function handleInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const scope: Element | Document = target.form ?? document;
  const watch = formMap.get(scope);
  if (!watch) return;
  if (!watch.passwordInputs.includes(target) && watch.usernameInput !== target)
    return;

  // 多个 password input 视为注册/确认密码，跳过快照。
  if (watch.passwordInputs.length >= 2) {
    watch.currentSnapshot = null;
    return;
  }

  const password = watch.passwordInputs[0]?.value ?? "";
  const username = watch.usernameInput?.value ?? "";
  if (!password || !username) {
    watch.currentSnapshot = null;
    return;
  }
  watch.currentSnapshot = {
    username,
    password,
    pageTitle: document.title,
  };
}

function handleClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>(
    'button, [role="button"], input[type="submit"], input[type="button"]',
  );
  if (!button) return;
  if (!isLikelyLoginButton(button)) return;
  finalizeAllWatchers(`click ${describeButton(button)}`);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (
    target.type === "password" ||
    (target.form && isLoginLikeForm(target.form))
  ) {
    finalizeAllWatchers("enter-key");
  }
}

function handleBeforeUnload(): void {
  finalizeAllWatchers("beforeunload");
}

function finalizeAllWatchers(reason: string): void {
  // formMap 是 WeakMap，没法迭代——我们改成从文档里现拉一次所有 form
  // + document 来检查。
  const scopes: Array<Element | Document> = [
    document,
    ...Array.from(document.querySelectorAll("form")),
  ];
  for (const scope of scopes) {
    const watch = formMap.get(scope);
    if (!watch || !watch.currentSnapshot) continue;
    const snapshot = watch.currentSnapshot;
    watch.currentSnapshot = null; // 立即清，避免被同一信号重复触发
    void reportCapture(snapshot, reason);
  }
}

async function reportCapture(
  snapshot: CredentialSnapshot,
  reason: string,
): Promise<void> {
  const fingerprint = `${snapshot.username}::${snapshot.password}`;
  const now = Date.now();
  if (
    lastReportedFingerprint === fingerprint &&
    now - lastReportedAt < REPORT_DEDUPE_WINDOW_MS
  ) {
    return;
  }
  lastReportedFingerprint = fingerprint;
  lastReportedAt = now;

  try {
    const response = await browser.runtime.sendMessage({
      type: "zpass.captureLogin",
      payload: {
        username: snapshot.username,
        password: snapshot.password,
      },
    });
    if (!response || response.ok !== true || !response.result) {
      // background 没把 decision 返回（desktop 不在线 / 别的错误）——
      // 静默：用户的登录不应该被插件错误打扰。debug 时可以解开 console。
      void reason;
      return;
    }
    const decision = response.result as SaveLoginDecision;
    if (decision.status === "new" || decision.status === "update") {
      showSaveLoginToast({
        decision,
        username: snapshot.username,
        password: snapshot.password,
        suggestedName: snapshot.pageTitle || deriveSuggestedName(),
      });
    } else if (decision.status === "locked") {
      // 用户没解锁 —— 弹「解锁并保存」 toast。background 已记下 capture，
      // 解锁后会主动 push showSaveToast。
      showLockedSaveToast();
    }
    // status=none 静默
  } catch {
    // 通信失败（service worker 短暂 unload / desktop 离线）——静默。
  }
}

function findUsernameInput(
  password: HTMLInputElement,
): HTMLInputElement | null {
  const scope = password.form ?? password.ownerDocument ?? document;
  const all = Array.from(
    scope.querySelectorAll<HTMLInputElement>("input"),
  ).filter((input) => {
    if (input === password) return false;
    if (input.disabled || input.readOnly) return false;
    if (input.type === "hidden") return false;
    const type = (input.getAttribute("type") ?? "").toLowerCase();
    if (
      type !== "" &&
      type !== "text" &&
      type !== "email" &&
      type !== "tel" &&
      type !== "url"
    )
      return false;
    if (isTotpField(input)) return false;
    return true;
  });
  // 优先取在 password 之前 + autocomplete 命中 username/email 的。
  const before = all.filter(
    (i) =>
      i.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const named = before.find((i) => looksLikeUsername(i));
  if (named) return named;
  return (
    before.at(-1) ?? all.find((i) => looksLikeUsername(i)) ?? all[0] ?? null
  );
}

function looksLikeUsername(input: HTMLInputElement): boolean {
  const ac = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  if (ac.includes("username") || ac.includes("email")) return true;
  const haystack = [
    input.getAttribute("name") ?? "",
    input.id,
    input.getAttribute("placeholder") ?? "",
    input.getAttribute("aria-label") ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return /user|email|账号|login|account/.test(haystack);
}

// 登录按钮文案启发（多语言粗略覆盖）。Bitwarden 的判断更复杂，这里采用
// 简化版本——配合 type=submit 已经能覆盖大多数场景。
const LOGIN_BUTTON_KEYWORDS = [
  "log in",
  "login",
  "sign in",
  "signin",
  "submit",
  "continue",
  "登录",
  "登陆",
  "登入",
  "确认",
  "ログイン",
  "iniciar",
  "entrar",
];

function isLikelyLoginButton(button: HTMLElement): boolean {
  if (button instanceof HTMLInputElement && button.type === "submit")
    return true;
  if (button instanceof HTMLButtonElement) {
    if (button.type === "submit") return true;
  }
  const text = (button.textContent ?? button.getAttribute("aria-label") ?? "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  return LOGIN_BUTTON_KEYWORDS.some((kw) => text.includes(kw));
}

function describeButton(button: HTMLElement): string {
  const text = (button.textContent ?? "").trim().slice(0, 40);
  return `${button.tagName.toLowerCase()}[${text}]`;
}

function isLoginLikeForm(form: HTMLFormElement): boolean {
  return form.querySelector('input[type="password"]') !== null;
}

function deriveSuggestedName(): string {
  // 优先取 document.title（去掉 "- 登录"、" | Login" 这种后缀效果不显著，留给后端处理）。
  const title = (document.title || "").trim();
  if (title) return title;
  try {
    return new URL(location.href).hostname;
  } catch {
    return location.host || "";
  }
}
