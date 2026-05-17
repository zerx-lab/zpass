import {
  type LoginSecret,
  type LoginSummary,
  type LoginTotpCode,
  type PasskeyDescriptor,
  type PasskeyListResult,
  type QueryLoginsResult,
} from "../src/shared/messages";
import {
  choosePasskeyCredential,
  closeCredentialMenus,
  confirmPasskeyCreate,
  createAutofillButton,
  showCredentialMenu,
  showPageToast,
  showTransientNotice,
} from "../src/content/ui";
import {
  fillLoginForm,
  fillTotpInput,
  findLoginFormForInput,
  findLoginForms,
  isLoginCandidate,
  type LoginForm,
} from "../src/content/forms";
import { isTotpCandidate } from "../src/content/totp-fields";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    const controller = new AutofillController();

    // 窗口 scroll / resize 时同步按钮位置（仅在按钮可见时重定位）
    window.addEventListener("scroll", () => controller.repositionIfVisible(), {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", () => controller.repositionIfVisible(), {
      passive: true,
    });

    browser.runtime.onMessage.addListener(async (message: unknown) => {
      const msg = message as { type?: string; secret?: LoginSecret };
      if (msg.type !== "zpass.fillLogin" || !msg.secret) return undefined;
      try {
        const activeForm = findLoginFormForInput(
          document.activeElement as HTMLInputElement,
        );
        const form = activeForm ?? findLoginForms(document)[0];
        if (!form) {
          // 本 frame 没有可填充的表单 —— 不返回应答，让主 frame
          // 或其他 frame 的 listener 应答。返回 undefined 会让 sender
          // 看到 sendResponse 不被调用。allFrames:true 下多 frame 同时收
          // 到广播，只有能处理的那个应该应答。
          return undefined;
        }
        // 走 controller.performFill 不是裸调 fillLoginForm，让 filling 守卫生效
        controller.performFill(form, msg.secret);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data as PageBridgeRequest;
      if (event.source !== window || !isPageBridgeRequest(message)) return;
      void relayPasskeyRequest(message);
    });

    // 跟随光标焦点 — 按钮只在 login candidate input 获焦时出现
    document.addEventListener("focusin", (event) => {
      controller.handleFocusin(event.target);
    });
    document.addEventListener("focusout", () => {
      controller.handleFocusout();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeCredentialMenus();
      if (event.key === "ArrowDown") {
        const active = document.activeElement;
        if (isLoginCandidate(active)) {
          void controller.openInlineForTarget(active);
        } else if (isTotpCandidate(active)) {
          void controller.openTotpInlineForTarget(active);
        }
      }
    });
  },
});

interface PageBridgeRequest {
  source: "zpass-page";
  channel: "passkey";
  id: string;
  type:
    | "zpass.passkeyList"
    | "zpass.passkeyCreate"
    | "zpass.passkeySign"
    | "zpass.passkeyChoose";
  payload?: unknown;
}

interface ExtensionRuntimeResponse<T = unknown> {
  ok?: boolean;
  result?: T;
  error?: string;
}

function isPageBridgeRequest(value: unknown): value is PageBridgeRequest {
  const message = value as PageBridgeRequest;
  return (
    !!message &&
    message.source === "zpass-page" &&
    message.channel === "passkey" &&
    typeof message.id === "string" &&
    (message.type === "zpass.passkeyList" ||
      message.type === "zpass.passkeyCreate" ||
      message.type === "zpass.passkeySign" ||
      message.type === "zpass.passkeyChoose")
  );
}

async function relayPasskeyRequest(message: PageBridgeRequest): Promise<void> {
  try {
    if (message.type === "zpass.passkeyCreate") {
      await handlePasskeyCreate(message);
      return;
    }

    if (message.type === "zpass.passkeyChoose") {
      await handlePasskeyChoose(message);
      return;
    }

    const response = await sendExtensionRequest({
      type: message.type,
      payload: message.payload,
    });
    if (response?.ok) {
      showPasskeySuccessToast(message.type);
    }
    postPasskeyResponse(
      message.id,
      !!response?.ok,
      response?.result,
      response?.error,
    );
  } catch (error) {
    postPasskeyResponse(
      message.id,
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handlePasskeyCreate(message: PageBridgeRequest): Promise<void> {
  const info = passkeyPromptInfo(message.payload);
  const listResponse = await sendExtensionRequest<PasskeyListResult>({
    type: "zpass.passkeyList",
    payload: { rpId: info.rpId },
  });
  if (!listResponse?.ok) {
    postPasskeyResponse(
      message.id,
      false,
      undefined,
      listResponse?.error ?? "无法读取现有 Passkey。",
    );
    return;
  }
  const list = listResponse.result;
  if (!list?.unlocked) {
    postPasskeyResponse(
      message.id,
      false,
      undefined,
      "请先解锁 ZPass Desktop，再保存 Passkey。",
    );
    return;
  }

  const existing = findSamePasskeyAccount(list.items, message.payload);
  const action = await confirmPasskeyCreate(info, existing);
  if (action === "cancel") {
    postPasskeyResponse(
      message.id,
      false,
      undefined,
      "用户已取消保存 Passkey。",
    );
    return;
  }

  if (action === "replace") {
    for (const item of existing) {
      const deleteResponse = await sendExtensionRequest({
        type: "zpass.passkeyDelete",
        payload: { rpId: list.rpId, itemId: item.itemId },
      });
      if (!deleteResponse?.ok) {
        postPasskeyResponse(
          message.id,
          false,
          undefined,
          deleteResponse?.error ?? "无法替换现有 Passkey。",
        );
        return;
      }
    }
  }

  const createResponse = await sendExtensionRequest({
    type: "zpass.passkeyCreate",
    payload: message.payload,
  });
  if (createResponse?.ok) {
    showPasskeySuccessToast("zpass.passkeyCreate");
  }
  postPasskeyResponse(
    message.id,
    !!createResponse?.ok,
    createResponse?.result,
    createResponse?.error,
  );
}

async function handlePasskeyChoose(message: PageBridgeRequest): Promise<void> {
  const payload = passkeyPayload(message.payload);
  const rpId = stringValue(payload.rpId) || window.location.hostname;
  const listResponse = await sendExtensionRequest<PasskeyListResult>({
    type: "zpass.passkeyList",
    payload: { rpId },
  });
  if (!listResponse?.ok) {
    postPasskeyResponse(
      message.id,
      false,
      undefined,
      listResponse?.error ?? "无法读取 Passkey。",
    );
    return;
  }
  const list = listResponse.result;
  if (!list?.unlocked) {
    postPasskeyResponse(
      message.id,
      false,
      undefined,
      "请先解锁 ZPass Desktop，再使用 Passkey 登录。",
    );
    return;
  }

  const items = filterAllowedPasskeys(list.items, payload).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  if (items.length === 0) {
    postPasskeyResponse(message.id, true, null);
    return;
  }
  const selected =
    items.length === 1
      ? items[0]
      : await choosePasskeyCredential(items, list.rpId);
  if (!selected) {
    postPasskeyResponse(
      message.id,
      false,
      undefined,
      "用户已取消使用 Passkey。",
    );
    return;
  }
  postPasskeyResponse(message.id, true, selected);
}

function sendExtensionRequest<T = unknown>(message: {
  type: string;
  payload?: unknown;
  itemId?: string;
}): Promise<ExtensionRuntimeResponse<T>> {
  return browser.runtime.sendMessage(message) as Promise<
    ExtensionRuntimeResponse<T>
  >;
}

function showPasskeySuccessToast(type: PageBridgeRequest["type"]): void {
  if (type === "zpass.passkeyCreate") {
    showPageToast("Passkey 已保存到 ZPass", window.location.hostname);
  }
  if (type === "zpass.passkeySign") {
    showPageToast("已使用 ZPass Passkey 登录", window.location.hostname);
  }
}

function postPasskeyResponse(
  id: string,
  ok: boolean,
  result?: unknown,
  error?: string,
): void {
  window.postMessage(
    {
      source: "zpass-extension",
      channel: "passkey",
      id,
      ok,
      result,
      error,
    },
    window.location.origin,
  );
}

function passkeyPromptInfo(payload: unknown): {
  rpId: string;
  rpName?: string;
  userName?: string;
  userDisplayName?: string;
} {
  const data = passkeyPayload(payload);
  const info: {
    rpId: string;
    rpName?: string;
    userName?: string;
    userDisplayName?: string;
  } = { rpId: stringValue(data.rpId) || window.location.hostname };
  const rpName = stringValue(data.rpName);
  const userName = stringValue(data.userName);
  const userDisplayName = stringValue(data.userDisplayName);
  if (rpName) info.rpName = rpName;
  if (userName) info.userName = userName;
  if (userDisplayName) info.userDisplayName = userDisplayName;
  return info;
}

function findSamePasskeyAccount(
  items: PasskeyDescriptor[],
  payload: unknown,
): PasskeyDescriptor[] {
  const data = passkeyPayload(payload);
  const userId = stringValue(data.userId);
  const userName = stringValue(data.userName);
  if (!userId && !userName) return [];
  return items.filter((item) => {
    if (userId && item.userId === userId) return true;
    return !!userName && item.userName === userName;
  });
}

function filterAllowedPasskeys(
  items: PasskeyDescriptor[],
  payload: Record<string, unknown>,
): PasskeyDescriptor[] {
  const allowCredentialIds = payload.allowCredentialIds;
  if (!Array.isArray(allowCredentialIds) || allowCredentialIds.length === 0) {
    return items;
  }
  const allowed = new Set(
    allowCredentialIds.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  return items.filter((item) => allowed.has(item.credentialId));
}

function passkeyPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/* ============================================================================
 * AutofillController — 单按钮跟随光标焦点模型
 * ----------------------------------------------------------------------------
 * 替代旧版「每个 password input 永久挂一个按钮」的设计：
 *   - 全局只创建 1 个浮动 Z 按钮
 *   - 监听 focusin / focusout，按钮跟随当前光标所在的 login input
 *     （username 或 password 均可触发，与 1Password / Bitwarden 一致）
 *   - 失焦后延迟 180ms 隐藏，给用户从 input 移到按钮的过渡时间
 *   - 鼠标 hover 按钮时保持显示
 *   - 填充进行中通过 filling 守卫禁用 focusin 反复弹菜单
 * ========================================================================== */
class AutofillController {
  /** 全局唯一浮动按钮 */
  private readonly button: HTMLButtonElement;
  /** 当前按钮锚定的 input；null 表示按钮处于隐藏状态 */
  private currentAnchor: HTMLInputElement | null = null;
  /**
   * 当前锚定上下文是 login 还是 totp。为了在按钮被点击后，以及
   * performFill 末尾重新 handleFocusin 时能走对的装配路径。
   * - "login": 走 username/password下拉菜单 → revealLogin → fillLoginForm
   * - "totp":  走 hasTotp 过滤后菜单 → generateLoginTotp → fillTotpInput
   * - null:    按钮隐藏中
   */
  private currentMode: "login" | "totp" | null = null;
  /** 锚定 input 的尺寸 / 位置变化监听器 */
  private positionWatcher: ResizeObserver | null = null;
  /** 失焦延迟隐藏的 timer */
  private hideTimer: number | undefined;
  private cachedLogins: QueryLoginsResult | null = null;
  private cachedAt = 0;
  /** 填充进行中标记 — 期间禁止 focusin 反复弹菜单（详 performFill） */
  private filling = false;
  /**
   * 一次性标记：下一次 handleFocusin 只更新按钮位置，不自动弹下拉菜单。
   * 用于 performFill 末尾：填充后按钮需要跟随到 password 旁，但用户并未希望
   * 填完又弹个菜单出来遮住。
   */
  private suppressAutoMenuOnce = false;

  constructor() {
    this.button = createAutofillButton();
    this.button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openMenuOnAnchor();
    });
    // mousedown 阻止 default 焦点切换：保留 input 焦点，避免触发站点的 onBlur 验证
    this.button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    // hover 按钮时取消隐藏调度，避免用户从 input 移到按钮过程中按钮消失
    this.button.addEventListener("mouseenter", () => this.cancelHide());
    this.button.addEventListener("mouseleave", () => this.scheduleHide());
    document.documentElement.append(this.button);
  }

  isFilling(): boolean {
    return this.filling;
  }

  /**
   * 统一的填充入口：inline menu / Z button menu / popup fillLogin 三条路径皆走此。
   * filling 守卫期间禁止 focusin 自动弹新菜单，本次填充末尾以 setTimeout(0)
   * 释放（含义：让 fillLoginForm 同步触发的所有 focus / focusin / await microtask
   * 跟完）。释放后主动 handleFocusin 一遍，让按钮跟随到填充末尾的 active input 旁。
   */
  performFill(form: LoginForm, secret: LoginSecret): void {
    this.filling = true;
    try {
      fillLoginForm(form, secret);
    } finally {
      window.setTimeout(() => {
        this.filling = false;
        // focus() 在 already-focused 元素上不 fire focusin，手动重新评估
        // 同时打上 suppressAutoMenuOnce：只跟随按钮，不自动重新弹菜单
        this.suppressAutoMenuOnce = true;
        this.handleFocusin(document.activeElement);
      }, 0);
    }
  }

  /**
   * focusin handler — 依次判定（TOTP 优先于 login）：
   *   1) totp candidate (autocomplete=one-time-code 或 OTP 关键字) → mode=totp,
   *      弹 hasTotp 过滤过的菜单。优先于 login 是因为 OTP input 常常同时
   *      是 type=text（与 USERNAME_TYPES 重叠），必须先拦截，避免被误路由。
   *      另 isLoginCandidate 内部也已排除 TOTP，这里属于双重防护。
   *   2) login candidate (username/password) → mode=login, 弹凭据菜单
   *   3) 都不是 → 调度隐藏按钮
   * suppressAutoMenuOnce 场景下只更新按钮位置，不自动弹菜单。
   */
  handleFocusin(target: EventTarget | null): void {
    if (this.filling) return;

    if (isTotpCandidate(target)) {
      const input = target as HTMLInputElement;
      this.cancelHide();
      this.attachTo(input, "totp");
      if (this.suppressAutoMenuOnce) {
        this.suppressAutoMenuOnce = false;
        return;
      }
      void this.openTotpInlineForTarget(input);
      return;
    }

    if (isLoginCandidate(target)) {
      const input = target as HTMLInputElement;
      if (!this.belongsToLoginForm(input)) {
        this.scheduleHide();
        return;
      }
      this.cancelHide();
      this.attachTo(input, "login");
      if (this.suppressAutoMenuOnce) {
        this.suppressAutoMenuOnce = false;
        return;
      }
      void this.openInlineForTarget(input);
      return;
    }

    this.scheduleHide();
  }

  /** focusout handler — 延迟隐藏给用户机会移到按钮上 */
  handleFocusout(): void {
    if (this.filling) return;
    this.scheduleHide();
  }

  /** 窗口 scroll / resize / ResizeObserver 触发时调用 */
  repositionIfVisible(): void {
    if (this.currentAnchor) {
      positionButton(this.button, this.currentAnchor);
    }
  }

  async openInlineForTarget(target: EventTarget | null): Promise<void> {
    if (this.filling) return;
    if (!isLoginCandidate(target)) return;
    const form = findLoginFormForInput(target);
    if (!form) return;
    const result = await this.queryLogins(target);
    if (!result || result.items.length === 0) return;
    showCredentialMenu(target, result.items, async (item) => {
      const secret = await reveal(item);
      if (!secret) return;
      this.performFill(form, secret);
    });
  }

  /**
   * TOTP 场景下的 inline 菜单。与 openInlineForTarget 并列：
   *   - 显示所有匹配当前 origin 的条目（不过滤 hasTotp，对齐 Bitwarden）。
   *     原因：用户可能有个账号没上 TOTP 但需要看到在 popup 手工复制，菜单过滤
   *     会让他以为该账号不存在。
   *   - 点击有 hasTotp 的 → 调 generateLoginTotp 要码，拿到填入 input
   *   - 点击没 hasTotp 的 → 提示“该凭据未存 TOTP”（不报错、不填）
   *   - 空列表时不会弹（避免遮担用户输入）
   */
  async openTotpInlineForTarget(target: EventTarget | null): Promise<void> {
    if (this.filling) return;
    if (!isTotpCandidate(target)) return;
    const result = await this.queryLogins(target);
    if (!result) return;
    if (result.items.length === 0) return;
    showCredentialMenu(
      target,
      result.items,
      async (item) => {
        if (!item.hasTotp) {
          showTransientNotice(
            target as HTMLInputElement,
            "该凭据未存验证码秘钥。",
          );
          return;
        }
        const code = await requestTotpCode(item);
        if (!code) return;
        this.performTotpFill(target as HTMLInputElement, code);
      },
      "totp",
    );
  }

  /**
   * TOTP 填充。与 performFill 同样使用 filling 守卫——TOTP input 上 focusin
   * 反复弹菜单的问题与 password 场景一致，复用同一套机制。
   */
  performTotpFill(input: HTMLInputElement, code: LoginTotpCode): void {
    this.filling = true;
    try {
      fillTotpInput(input, code.code);
    } finally {
      window.setTimeout(() => {
        this.filling = false;
        this.suppressAutoMenuOnce = true;
        this.handleFocusin(document.activeElement);
      }, 0);
    }
  }

  private belongsToLoginForm(input: HTMLInputElement): boolean {
    const forms = findLoginForms(document);
    return forms.some(
      (form) => form.password === input || form.username === input,
    );
  }

  private attachTo(input: HTMLInputElement, mode: "login" | "totp"): void {
    this.currentAnchor = input;
    this.currentMode = mode;
    this.positionWatcher?.disconnect();
    this.positionWatcher = new ResizeObserver(() => this.repositionIfVisible());
    this.positionWatcher.observe(input);
    positionButton(this.button, input);
    this.button.setAttribute("data-state", "visible");
    this.button.setAttribute("data-mode", mode);
  }

  private hide(): void {
    this.button.removeAttribute("data-state");
    this.button.removeAttribute("data-mode");
    this.currentAnchor = null;
    this.currentMode = null;
    this.positionWatcher?.disconnect();
    this.positionWatcher = null;
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => this.hide(), 180);
  }

  private cancelHide(): void {
    if (this.hideTimer !== undefined) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
  }

  /**
   * 点击浮动 Z 按钮时的入口。根据 currentMode 分流到 login 菜单或 TOTP 菜单。
   */
  private async openMenuOnAnchor(): Promise<void> {
    if (!this.currentAnchor) return;
    if (this.currentMode === "totp") {
      await this.openTotpMenu(this.currentAnchor, this.button);
      return;
    }
    const form = findLoginFormForInput(this.currentAnchor);
    if (!form) return;
    await this.openMenu(form, this.button);
  }

  private async openMenu(form: LoginForm, anchor: HTMLElement): Promise<void> {
    const result = await this.queryLogins(anchor);
    if (!result) return;
    if (result.items.length === 0) {
      showTransientNotice(anchor, "当前站点没有匹配的 ZPass 登录项。");
      return;
    }
    showCredentialMenu(anchor, result.items, async (item) => {
      const secret = await reveal(item);
      if (!secret) return;
      this.performFill(form, secret);
    });
  }

  /**
   * 点击浮动 Z 按钮时的 TOTP 路径。与 openTotpInlineForTarget 不同的是
   * 这里 anchor 是按钮本身（菜单弹在按钮下方），填充目标仍是当前 input。
   * 同样不过滤 hasTotp，与 Bitwarden 对齐。
   */
  private async openTotpMenu(
    input: HTMLInputElement,
    anchor: HTMLElement,
  ): Promise<void> {
    const result = await this.queryLogins(anchor);
    if (!result) return;
    if (result.items.length === 0) {
      showTransientNotice(anchor, "当前站点没有匹配的 ZPass 条目。");
      return;
    }
    showCredentialMenu(
      anchor,
      result.items,
      async (item) => {
        if (!item.hasTotp) {
          showTransientNotice(anchor, "该凭据未存验证码秘钥。");
          return;
        }
        const code = await requestTotpCode(item);
        if (!code) return;
        this.performTotpFill(input, code);
      },
      "totp",
    );
  }

  private async queryLogins(
    anchor: HTMLElement,
  ): Promise<QueryLoginsResult | null> {
    if (this.cachedLogins && Date.now() - this.cachedAt < 5000) {
      return this.cachedLogins;
    }
    const response = await browser.runtime.sendMessage({
      type: "zpass.queryLogins",
    });
    if (!response?.ok) {
      showTransientNotice(anchor, response?.error ?? "ZPass 当前不可用。");
      return null;
    }
    const result = response.result as QueryLoginsResult;
    if (!result.unlocked) {
      showTransientNotice(anchor, "请先解锁 ZPass Desktop，再使用自动填充。");
      return null;
    }
    this.cachedLogins = result;
    this.cachedAt = Date.now();
    return result;
  }
}

async function reveal(item: LoginSummary): Promise<LoginSecret | null> {
  const response = await browser.runtime.sendMessage({
    type: "zpass.revealLogin",
    itemId: item.id,
  });
  if (!response?.ok) {
    return null;
  }
  return response.result as LoginSecret;
}

/**
 * 请求指定 login 条目的当前 OTP 码。失败返 null，调用方自行静默；
 * 包装后端错误为 toast 是 openTotpMenu / openTotpInlineForTarget 的职责，
 * 由于这里拿不到 anchor，仍然在外部控制路径里选择是否提示。
 */
async function requestTotpCode(
  item: LoginSummary,
): Promise<LoginTotpCode | null> {
  const response = await browser.runtime.sendMessage({
    type: "zpass.generateLoginTotp",
    itemId: item.id,
  });
  if (!response?.ok) return null;
  return response.result as LoginTotpCode;
}

/**
 * input 不可见时 (width/height = 0 / display:none) 隐藏按钮，避免浮游位置错误。
 */
function positionButton(button: HTMLElement, input: HTMLInputElement): void {
  const rect = input.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    button.style.display = "none";
    return;
  }
  button.style.display = "";

  const BUTTON_SIZE = 24;
  // 距输入框右边的内边距。取 8px 是与 Bitwarden / Chrome 默认 password
  // manager 图标同位置。为了让按钮与可能存在的原生 icon 错开，本可以检测
  // input 内部是否有同肳兄弟中的 button/svg，但 v1 先保持简单。
  const INSIDE_PADDING = 8;

  // 水平：压入输入框内部右侧
  const left = rect.right - BUTTON_SIZE - INSIDE_PADDING;
  // 垂直：与输入框中线对齐
  const top = rect.top + (rect.height - BUTTON_SIZE) / 2;

  button.style.left = `${window.scrollX + left}px`;
  button.style.top = `${window.scrollY + top}px`;
}
