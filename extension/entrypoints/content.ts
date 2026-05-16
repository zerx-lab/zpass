import {
  type LoginSecret,
  type LoginSummary,
  type PasskeyDescriptor,
  type PasskeyListResult,
  type QueryLoginsResult
} from "../src/shared/messages";
import {
  choosePasskeyCredential,
  closeCredentialMenus,
  confirmPasskeyCreate,
  createAutofillButton,
  showCredentialMenu,
  showPageToast,
  showTransientNotice
} from "../src/content/ui";
import {
  fillLoginForm,
  findLoginFormForInput,
  findLoginForms,
  isLoginCandidate,
  type LoginForm
} from "../src/content/forms";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    const controller = new AutofillController();
    controller.scan();

    const observer = new MutationObserver(() => controller.scheduleScan());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    browser.runtime.onMessage.addListener(async (message: unknown) => {
      const msg = message as { type?: string; secret?: LoginSecret };
      if (msg.type !== "zpass.fillLogin" || !msg.secret) return undefined;
      try {
        const activeForm = findLoginFormForInput(document.activeElement as HTMLInputElement);
        const form = activeForm ?? findLoginForms(document)[0];
        if (!form) {
          return { ok: false, error: "No fillable login form found in this frame." };
        }
        fillLoginForm(form, msg.secret);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data as PageBridgeRequest;
      if (event.source !== window || !isPageBridgeRequest(message)) return;
      void relayPasskeyRequest(message);
    });

    document.addEventListener("focusin", (event) => {
      void controller.openInlineForTarget(event.target);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeCredentialMenus();
      if (event.key === "ArrowDown" && isLoginCandidate(document.activeElement)) {
        void controller.openInlineForTarget(document.activeElement);
      }
    });
  }
});

interface PageBridgeRequest {
  source: "zpass-page";
  channel: "passkey";
  id: string;
  type: "zpass.passkeyList" | "zpass.passkeyCreate" | "zpass.passkeySign" | "zpass.passkeyChoose";
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
      payload: message.payload
    });
    if (response?.ok) {
      showPasskeySuccessToast(message.type);
    }
    postPasskeyResponse(message.id, !!response?.ok, response?.result, response?.error);
  } catch (error) {
    postPasskeyResponse(message.id, false, undefined, error instanceof Error ? error.message : String(error));
  }
}

async function handlePasskeyCreate(message: PageBridgeRequest): Promise<void> {
  const info = passkeyPromptInfo(message.payload);
  const listResponse = await sendExtensionRequest<PasskeyListResult>({
    type: "zpass.passkeyList",
    payload: { rpId: info.rpId }
  });
  if (!listResponse?.ok) {
    postPasskeyResponse(message.id, false, undefined, listResponse?.error ?? "无法读取现有 Passkey。");
    return;
  }
  const list = listResponse.result;
  if (!list?.unlocked) {
    postPasskeyResponse(message.id, false, undefined, "请先解锁 ZPass Desktop，再保存 Passkey。");
    return;
  }

  const existing = findSamePasskeyAccount(list.items, message.payload);
  const action = await confirmPasskeyCreate(info, existing);
  if (action === "cancel") {
    postPasskeyResponse(message.id, false, undefined, "用户已取消保存 Passkey。");
    return;
  }

  if (action === "replace") {
    for (const item of existing) {
      const deleteResponse = await sendExtensionRequest({
        type: "zpass.passkeyDelete",
        payload: { rpId: list.rpId, itemId: item.itemId }
      });
      if (!deleteResponse?.ok) {
        postPasskeyResponse(message.id, false, undefined, deleteResponse?.error ?? "无法替换现有 Passkey。");
        return;
      }
    }
  }

  const createResponse = await sendExtensionRequest({
    type: "zpass.passkeyCreate",
    payload: message.payload
  });
  if (createResponse?.ok) {
    showPasskeySuccessToast("zpass.passkeyCreate");
  }
  postPasskeyResponse(message.id, !!createResponse?.ok, createResponse?.result, createResponse?.error);
}

async function handlePasskeyChoose(message: PageBridgeRequest): Promise<void> {
  const payload = passkeyPayload(message.payload);
  const rpId = stringValue(payload.rpId) || window.location.hostname;
  const listResponse = await sendExtensionRequest<PasskeyListResult>({
    type: "zpass.passkeyList",
    payload: { rpId }
  });
  if (!listResponse?.ok) {
    postPasskeyResponse(message.id, false, undefined, listResponse?.error ?? "无法读取 Passkey。");
    return;
  }
  const list = listResponse.result;
  if (!list?.unlocked) {
    postPasskeyResponse(message.id, false, undefined, "请先解锁 ZPass Desktop，再使用 Passkey 登录。");
    return;
  }

  const items = filterAllowedPasskeys(list.items, payload).sort((a, b) => b.updatedAt - a.updatedAt);
  if (items.length === 0) {
    postPasskeyResponse(message.id, true, null);
    return;
  }
  const selected = items.length === 1 ? items[0] : await choosePasskeyCredential(items, list.rpId);
  if (!selected) {
    postPasskeyResponse(message.id, false, undefined, "用户已取消使用 Passkey。");
    return;
  }
  postPasskeyResponse(message.id, true, selected);
}

function sendExtensionRequest<T = unknown>(message: {
  type: string;
  payload?: unknown;
  itemId?: string;
}): Promise<ExtensionRuntimeResponse<T>> {
  return browser.runtime.sendMessage(message) as Promise<ExtensionRuntimeResponse<T>>;
}

function showPasskeySuccessToast(type: PageBridgeRequest["type"]): void {
  if (type === "zpass.passkeyCreate") {
    showPageToast("Passkey 已保存到 ZPass", window.location.hostname);
  }
  if (type === "zpass.passkeySign") {
    showPageToast("已使用 ZPass Passkey 登录", window.location.hostname);
  }
}

function postPasskeyResponse(id: string, ok: boolean, result?: unknown, error?: string): void {
  window.postMessage(
    {
      source: "zpass-extension",
      channel: "passkey",
      id,
      ok,
      result,
      error
    },
    window.location.origin
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

function findSamePasskeyAccount(items: PasskeyDescriptor[], payload: unknown): PasskeyDescriptor[] {
  const data = passkeyPayload(payload);
  const userId = stringValue(data.userId);
  const userName = stringValue(data.userName);
  if (!userId && !userName) return [];
  return items.filter((item) => {
    if (userId && item.userId === userId) return true;
    return !!userName && item.userName === userName;
  });
}

function filterAllowedPasskeys(items: PasskeyDescriptor[], payload: Record<string, unknown>): PasskeyDescriptor[] {
  const allowCredentialIds = payload.allowCredentialIds;
  if (!Array.isArray(allowCredentialIds) || allowCredentialIds.length === 0) {
    return items;
  }
  const allowed = new Set(allowCredentialIds.filter((value): value is string => typeof value === "string" && value.length > 0));
  return items.filter((item) => allowed.has(item.credentialId));
}

function passkeyPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

class AutofillController {
  private readonly seen = new WeakSet<HTMLInputElement>();
  private scanTimer: number | undefined;
  private cachedLogins: QueryLoginsResult | null = null;
  private cachedAt = 0;

  scheduleScan(): void {
    if (this.scanTimer !== undefined) return;
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = undefined;
      this.scan();
    }, 250);
  }

  scan(): void {
    for (const form of findLoginForms(document)) {
      if (this.seen.has(form.password)) continue;
      this.seen.add(form.password);
      const button = createAutofillButton();
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openMenu(form, button);
      });
      document.documentElement.append(button);
      positionButton(button, form.password);
      window.addEventListener("scroll", () => positionButton(button, form.password), {
        passive: true
      });
      window.addEventListener("resize", () => positionButton(button, form.password), {
        passive: true
      });
    }
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
      fillLoginForm(form, secret);
    });
  }

  async openInlineForTarget(target: EventTarget | null): Promise<void> {
    if (!isLoginCandidate(target)) return;
    const form = findLoginFormForInput(target);
    if (!form) return;
    const result = await this.queryLogins(target);
    if (!result || result.items.length === 0) return;
    showCredentialMenu(target, result.items, async (item) => {
      const secret = await reveal(item);
      if (!secret) return;
      fillLoginForm(form, secret);
    });
  }

  private async queryLogins(anchor: HTMLElement): Promise<QueryLoginsResult | null> {
    if (this.cachedLogins && Date.now() - this.cachedAt < 5000) {
      return this.cachedLogins;
    }
    const response = await browser.runtime.sendMessage({ type: "zpass.queryLogins" });
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
    itemId: item.id
  });
  if (!response?.ok) {
    return null;
  }
  return response.result as LoginSecret;
}

function positionButton(button: HTMLElement, input: HTMLInputElement): void {
  const rect = input.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.style.left = `${window.scrollX + rect.right - 34}px`;
  button.style.top = `${window.scrollY + rect.top + Math.max(3, (rect.height - 28) / 2)}px`;
}
