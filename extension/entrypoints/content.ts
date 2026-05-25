import {
  type LoginSecret,
  type PasskeyDescriptor,
  type PasskeyListResult,
} from "../src/shared/messages";
import {
  choosePasskeyCredential,
  confirmPasskeyCreate,
  showPageToast,
} from "../src/content/ui";
import {
  fillLoginForm,
  fillTotpInput,
  findLoginFormForInput,
  findLoginForms,
} from "../src/content/forms";
import { installLoginCapture } from "../src/content/capture-login";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    // 扩展失效自愈：dev 热重载 / 扩展更新会让本 content script 变孤儿，
    // 后续 browser.runtime.* 调用全部抛 "Extension context invalidated"。
    // 检测到失效就静默错误 + reload 顶层页（子 frame 会随父页一起被重新注入）。
    installExtensionContextWatchdog();

    // 提交时提示保存登录 —— 与填充 UI 解耦，独立挂载。
    installLoginCapture();

    // 唯一的填充入口：popup 选条目后由 background 广播 zpass.fillLogin。
    // 不再有 inline 浮动按钮 / 自动菜单 / ArrowDown 触发等任何页内 UI 路径。
    browser.runtime.onMessage.addListener(async (message: unknown) => {
      const msg = message as { type?: string; secret?: LoginSecret };
      if (msg.type !== "zpass.fillLogin" || !msg.secret) return undefined;
      try {
        // 仅当焦点真的在 input 上时,才用「找焦点所在 form」路径。
        // 否则 document.activeElement 通常是 <body>,会被 findLoginFormForInput
        // 误当作 username 槽位返回,导致后续 simulateUserFill 对非 input 节点
        // 调 valueSetter 抛 Illegal invocation,表现为「没聚焦就填不上」。
        const active = document.activeElement;
        const activeForm =
          active instanceof HTMLInputElement
            ? findLoginFormForInput(active)
            : null;
        const form = activeForm ?? findLoginForms(document)[0];
        if (!form) {
          // 本 frame 无可填表单 —— 不应答，allFrames:true 下交给其他 frame。
          return undefined;
        }
        fillLoginForm(form, msg.secret);
        if (msg.secret.totp?.code) {
          // popup 携带了 TOTP code 时顺手填进 OTP input（如果页内存在）。
          // 找不到 OTP input 就算了，main flow 已完成。
          const otpInput = findOtpInput(form);
          if (otpInput) fillTotpInput(otpInput, msg.secret.totp.code);
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    // Passkey 桥接：网页通过 window.postMessage 请求 list/create/sign/choose。
    window.addEventListener("message", (event) => {
      const message = event.data as PageBridgeRequest;
      if (event.source !== window || !isPageBridgeRequest(message)) return;
      void relayPasskeyRequest(message);
    });
  },
});

/**
 * 看门狗：定期检查 browser.runtime.id 是否还在。失效时静默 unhandledrejection
 * 并 reload 顶层页面 —— 让 host page 重新加载一次,新 content script 会接上
 * 新 service worker。子 frame 不主动 reload,等父页 reload 时一起被重新注入。
 *
 * 触发场景:
 *   - WXT dev 模式热重载（最常见）
 *   - chrome://extensions 手动重新加载
 *   - 扩展自动更新 / 被禁用
 */
function installExtensionContextWatchdog(): void {
  let triggered = false;
  const handleInvalidated = (): void => {
    if (triggered) return;
    triggered = true;
    if (window === window.top) {
      try {
        globalThis.location.reload();
      } catch {
        // sandboxed / cross-origin 限制下 reload 可能 throw —— 没辙,静默。
      }
    }
  };

  const isContextAlive = (): boolean => {
    try {
      return !!browser.runtime?.id;
    } catch {
      return false;
    }
  };

  // 主动轮询：1s 频率,失效时 runtime API 通常在下一次调用前就被检测到。
  const timer = globalThis.setInterval(() => {
    if (!isContextAlive()) {
      globalThis.clearInterval(timer);
      handleInvalidated();
    }
  }, 1000);

  // 被动监听：sendMessage 失败时 Chrome 抛 unhandledrejection,
  // 我们 preventDefault 掉这条特定错误,顺手触发 reload。
  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? reason.message : String(reason ?? "");
    if (message.includes("Extension context invalidated")) {
      event.preventDefault();
      handleInvalidated();
    }
  });
}

/**
 * 在已识别的 LoginForm 周边寻找 OTP input —— 简化版。
 * 不依赖 totp-fields.ts 的 isTotpCandidate（那是面向 focus 触发的复杂判定）；
 * 这里只取 form / 上层 fieldset 里 autocomplete=one-time-code 的第一个，
 * 或 name/id 含 "otp"/"code"/"verify" 的 type=text。找不到返回 null。
 */
function findOtpInput(form: { password: HTMLInputElement }): HTMLInputElement | null {
  const root = form.password.form ?? document;
  const explicit = root.querySelector<HTMLInputElement>(
    'input[autocomplete="one-time-code"]',
  );
  if (explicit) return explicit;
  const inputs = root.querySelectorAll<HTMLInputElement>(
    'input[type="text"], input[type="tel"], input:not([type])',
  );
  for (const input of inputs) {
    const key = `${input.name} ${input.id} ${input.placeholder ?? ""}`.toLowerCase();
    if (/(otp|one[-_]?time|verify|verification|code|短信|验证码)/.test(key)) {
      return input;
    }
  }
  return null;
}

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

