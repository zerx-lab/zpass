import { NativeBridge } from "../src/background/native-bridge";
import {
  type ActiveTabInfo,
  getHttpOrigin,
  type ExtensionRequest,
  type ExtensionResponse,
  type PasskeyCreatePayload,
  type PasskeyDeletePayload,
  type PasskeySignPayload,
} from "../src/shared/messages";

const bridge = new NativeBridge();

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    return handleMessage(message, sender);
  });
});

async function handleMessage(
  message: unknown,
  sender: Browser.runtime.MessageSender,
): Promise<ExtensionResponse> {
  const req = message as ExtensionRequest;
  if (!req || typeof req !== "object" || typeof req.type !== "string") {
    return { ok: false, error: "Invalid extension request." };
  }

  try {
    if (req.type === "zpass.status") {
      const status = await bridge.status();
      return { ok: true, result: status };
    }

    const tab = await resolveTab(sender);
    if (!tab.url) {
      return { ok: false, error: "当前页面不能使用 ZPass 自动填充。" };
    }
    const origin = getHttpOrigin(tab.url);
    if (!origin) {
      return { ok: false, error: "ZPass 只支持 http 和 https 页面。" };
    }

    if (req.type === "zpass.queryLogins") {
      const result = await bridge.queryLogins({ origin, url: tab.url });
      return { ok: true, result };
    }

    if (req.type === "zpass.revealLogin") {
      if (!req.itemId) {
        return { ok: false, error: "Missing vault item id." };
      }
      const result = await bridge.revealLogin({
        origin,
        url: tab.url,
        itemId: req.itemId,
      });
      return { ok: true, result };
    }

    if (req.type === "zpass.passkeyList") {
      const payload = parsePasskeyPayload<{ rpId?: unknown }>(req.payload);
      const rpId = stringField(payload, "rpId");
      if (!rpId) {
        return { ok: false, error: "Missing passkey rpId." };
      }
      const result = await bridge.passkeyList({ origin, url: tab.url, rpId });
      return { ok: true, result };
    }

    if (req.type === "zpass.passkeyCreate") {
      const payload = parsePasskeyPayload<PasskeyCreatePayload>(req.payload);
      const rpId = stringField(payload, "rpId");
      const userId = stringField(payload, "userId");
      const userName = stringField(payload, "userName");
      if (!rpId || !userId || !userName) {
        return { ok: false, error: "Missing passkey registration fields." };
      }
      const createRequest = {
        origin,
        url: tab.url,
        rpId,
        userId,
        userName,
      };
      const rpName = stringField(payload, "rpName");
      const userDisplayName = stringField(payload, "userDisplayName");
      const name = stringField(payload, "name");
      if (rpName) Object.assign(createRequest, { rpName });
      if (userDisplayName) Object.assign(createRequest, { userDisplayName });
      if (name) Object.assign(createRequest, { name });
      const result = await bridge.passkeyCreate(createRequest);
      return { ok: true, result };
    }

    if (req.type === "zpass.passkeySign") {
      const payload = parsePasskeyPayload<PasskeySignPayload>(req.payload);
      const rpId = stringField(payload, "rpId");
      const credentialId = stringField(payload, "credentialId");
      const clientDataHash = stringField(payload, "clientDataHash");
      if (!rpId || !credentialId || !clientDataHash) {
        return { ok: false, error: "Missing passkey assertion fields." };
      }
      const result = await bridge.passkeySign({
        origin,
        url: tab.url,
        rpId,
        credentialId,
        clientDataHash,
      });
      return { ok: true, result };
    }

    if (req.type === "zpass.passkeyDelete") {
      const payload = parsePasskeyPayload<PasskeyDeletePayload>(req.payload);
      const rpId = stringField(payload, "rpId");
      const itemId = stringField(payload, "itemId");
      const credentialId = stringField(payload, "credentialId");
      if (!rpId || (!itemId && !credentialId)) {
        return { ok: false, error: "Missing passkey delete fields." };
      }
      const deleteRequest = { origin, url: tab.url, rpId };
      if (itemId) Object.assign(deleteRequest, { itemId });
      if (credentialId) Object.assign(deleteRequest, { credentialId });
      const result = await bridge.passkeyDelete(deleteRequest);
      return { ok: true, result };
    }

    if (req.type === "zpass.generateLoginTotp") {
      if (!req.itemId) {
        return { ok: false, error: "Missing vault item id." };
      }
      const result = await bridge.generateLoginTotp({
        origin,
        url: tab.url,
        itemId: req.itemId,
      });
      return { ok: true, result };
    }

    if (req.type === "zpass.fillActiveTab") {
      if (!req.itemId) {
        return { ok: false, error: "Missing vault item id." };
      }
      if (tab.id === undefined) {
        return { ok: false, error: "Cannot access the active tab." };
      }
      const secret = await bridge.revealLogin({
        origin,
        url: tab.url,
        itemId: req.itemId,
      });
      // 有密码才发 fillLogin；secret.password 为空（独立 TOTP 条目 / 仅存 username 的 login）
      // 跳过填充环节，仅将 totp 码返给 popup 让其复制到剪贴板。
      let filled = false;
      if (secret.password) {
        const fillResponse = await browser.tabs.sendMessage(tab.id, {
          type: "zpass.fillLogin",
          secret,
        });
        if (fillResponse && fillResponse.ok === false) {
          return {
            ok: false,
            error: fillResponse.error ?? "ZPass 无法填充当前页面。",
          };
        }
        filled = true;
      }
      // 把 TOTP 码一起返给 popup 决定是否复制。不在 background 里复制是因为
      // service worker 上下文没有 navigator.clipboard / document.execCommand,
      // 必须在 popup 窗口上下文完成。
      return {
        ok: true,
        result: {
          filled,
          totpCode: secret.totp?.code ?? null,
          hasPassword: !!secret.password,
        },
      };
    }

    return { ok: false, error: `Unknown request type: ${req.type}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveTab(
  sender: Browser.runtime.MessageSender,
): Promise<ActiveTabInfo> {
  if (sender.url && getHttpOrigin(sender.url)) {
    const info: ActiveTabInfo = { url: sender.url };
    if (sender.tab?.id !== undefined) info.id = sender.tab.id;
    return info;
  }
  if (sender.tab?.id !== undefined && sender.tab.url) {
    return { id: sender.tab.id, url: sender.tab.url };
  }
  const [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const info: ActiveTabInfo = {};
  if (tab?.id !== undefined) info.id = tab.id;
  if (tab?.url !== undefined) info.url = tab.url;
  return info;
}

function parsePasskeyPayload<T extends object>(payload: unknown): Partial<T> {
  if (!payload || typeof payload !== "object") return {};
  return payload as Partial<T>;
}

function stringField<T extends object>(
  payload: Partial<T>,
  key: keyof T,
): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}
