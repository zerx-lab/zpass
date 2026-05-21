import { NativeBridge } from "../src/background/native-bridge";
import {
  initBadge,
  clearAllBadges,
  refreshActiveTabBadge,
  updateBadgeFromQueryResult,
} from "../src/background/badge";
import {
  type ActiveTabInfo,
  getHttpOrigin,
  type ExtensionRequest,
  type ExtensionResponse,
  type PasskeyCreatePayload,
  type PasskeyDeletePayload,
  type PasskeySignPayload,
  type QueryLoginsResult,
  type SaveLoginDecision,
} from "../src/shared/messages";

const bridge = new NativeBridge();

// ============================================================================
// 「锁定状态下捕获」等待区
// ----------------------------------------------------------------------------
// 用户身份验证完后发起了一次 captureLogin，如果当时 desktop vault 处于锁定
// 状态，我们不能直接弹「保存」（干方拿不到 vault 读写权限）。反之，我们要做三件事：
//
//   1. 让 content-script 弹个「解锁并保存」的提示 toast。
//   2. 在本模块内存里以 tabId+origin 为键留住 capture 负载。
//   3. 开启一个低频次 status 轮询，一旦发现 unlocked → 重评 captureLogin、
//      如果评估不是 "none" 就把对应 toast 推回 content-script。
//
// 为什么设超时：service worker 梦想里可以跳完才恢复，但现实是
// MV3 会主动 unload。我们接受「用户 5 分钟内不解锁 → 丢丢 capture」的
// 技术代价，避免明文密码在内存里退到后台越久越危险。
// ============================================================================

interface PendingCapture {
  tabId: number;
  url: string;
  origin: string;
  username: string;
  password: string;
  expiresAt: number;
}

const pendingCaptures = new Map<string, PendingCapture>();
const PENDING_CAPTURE_TTL_MS = 5 * 60 * 1000; // 5 分钟

let unlockPollTimer: ReturnType<typeof globalThis.setInterval> | null = null;
const UNLOCK_POLL_INTERVAL_MS = 1500;

function pendingKey(tabId: number, origin: string): string {
  return `${tabId}::${origin}`;
}

function rememberPendingCapture(capture: PendingCapture): void {
  pendingCaptures.set(pendingKey(capture.tabId, capture.origin), capture);
  startUnlockPolling();
}

function forgetPendingCapture(tabId: number, origin: string): void {
  pendingCaptures.delete(pendingKey(tabId, origin));
  if (pendingCaptures.size === 0) stopUnlockPolling();
}

function startUnlockPolling(): void {
  if (unlockPollTimer !== null) return;
  unlockPollTimer = globalThis.setInterval(() => {
    void drainPendingCapturesOnUnlock();
  }, UNLOCK_POLL_INTERVAL_MS);
}

function stopUnlockPolling(): void {
  if (unlockPollTimer !== null) {
    globalThis.clearInterval(unlockPollTimer);
    unlockPollTimer = null;
  }
}

async function drainPendingCapturesOnUnlock(): Promise<void> {
  if (pendingCaptures.size === 0) {
    stopUnlockPolling();
    return;
  }
  // 先 ping 一下避免 desktop 完全离线时每 1.5s 都打 status。
  let unlocked = false;
  try {
    const status = await bridge.status();
    unlocked = status.unlocked === true;
  } catch {
    // desktop 不可达 —— 保留 capture，下轮再试。不丢 expired 那些。
    pruneExpiredCaptures();
    return;
  }
  if (!unlocked) {
    pruneExpiredCaptures();
    return;
  }

  // 解锁了 —— 逐个重评 并超推 toast。完成后跳出轮询（stopUnlockPolling 由
  // forgetPendingCapture 在 size 归零时触发）。
  const snapshot = Array.from(pendingCaptures.values());
  for (const capture of snapshot) {
    const fresh = pendingCaptures.get(
      pendingKey(capture.tabId, capture.origin),
    );
    if (!fresh) continue;
    try {
      const decision = await bridge.captureLogin({
        origin: capture.origin,
        url: capture.url,
        username: capture.username,
        password: capture.password,
      });
      if (decision.status === "none") {
        forgetPendingCapture(capture.tabId, capture.origin);
        continue;
      }
      if (decision.status === "locked") {
        // 生袣状态。同下轮再试。
        continue;
      }
      // new / update —— 推送「现在可以保存」toast给 content-script
      const pushed = await pushSaveToast(capture.tabId, capture, decision);
      if (pushed) {
        forgetPendingCapture(capture.tabId, capture.origin);
      }
    } catch {
      // 零星错误不阻断其他 capture 重评。
    }
  }
  pruneExpiredCaptures();
}

function pruneExpiredCaptures(): void {
  const now = Date.now();
  for (const [key, capture] of pendingCaptures) {
    if (capture.expiresAt <= now) {
      pendingCaptures.delete(key);
    }
  }
  if (pendingCaptures.size === 0) stopUnlockPolling();
}

/**
 * 推「保存 / 更新」toast 到指定 tab。返 true 表示 content-script 存在
 * 且接收了；false 表示 tab 已关闭 / 不受例、需从待处理集合删除。
 */
async function pushSaveToast(
  tabId: number,
  capture: PendingCapture,
  decision: SaveLoginDecision,
): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "zpass.showSaveToast",
      decision,
      capture: {
        origin: capture.origin,
        url: capture.url,
        username: capture.username,
        password: capture.password,
      },
    });
    return true;
  } catch {
    // tab 已关 / content-script 未加载——删除会调、不重试。
    return false;
  }
}

export default defineBackground(() => {
  initBadge(bridge);
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
    return { ok: false, error: "无效的扩展请求。" };
  }

  try {
    if (req.type === "zpass.ping") {
      const result = await bridge.ping();
      return { ok: true, result };
    }

    if (req.type === "zpass.launchDesktop") {
      const result = await bridge.launchDesktop();
      return { ok: true, result };
    }

    if (req.type === "zpass.status") {
      const status = await bridge.status();
      // 解锁状态可能在 popup 打开时刚刚变化——主动刷新当前 tab 的 badge。
      if (!status.unlocked) {
        // 全局锁定：清掉所有已知 tab 的 badge。
        void clearAllBadges();
      } else {
        void refreshActiveTabBadge();
      }
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

    // 统一参数缺失提示文案——可能是扩展内部逻辑 bug，推给用户的入口都使用中文
    const missingItemId = { ok: false as const, error: "缺少条目 ID。" };
    const missingPasskeyRpId = {
      ok: false as const,
      error: "缺少 Passkey rpId。",
    };
    const missingPasskeyRegistration = {
      ok: false as const,
      error: "缺少 Passkey 注册字段。",
    };
    const missingPasskeyAssertion = {
      ok: false as const,
      error: "缺少 Passkey 验证字段。",
    };
    const missingPasskeyDelete = {
      ok: false as const,
      error: "缺少 Passkey 删除字段。",
    };

    if (req.type === "zpass.queryLogins") {
      const result = await bridge.queryLogins({ origin, url: tab.url });
      // 顺手把结果同步给 badge，省一次 native 往返。
      if (tab.id !== undefined) {
        void updateBadgeFromQueryResult(
          tab.id,
          origin,
          result.unlocked,
          (result as QueryLoginsResult).items.length,
        );
      }
      return { ok: true, result };
    }

    if (req.type === "zpass.revealLogin") {
      if (!req.itemId) {
        return missingItemId;
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
        return missingPasskeyRpId;
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
        return missingPasskeyRegistration;
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
        return missingPasskeyAssertion;
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
        return missingPasskeyDelete;
      }
      const deleteRequest = { origin, url: tab.url, rpId };
      if (itemId) Object.assign(deleteRequest, { itemId });
      if (credentialId) Object.assign(deleteRequest, { credentialId });
      const result = await bridge.passkeyDelete(deleteRequest);
      return { ok: true, result };
    }

    if (req.type === "zpass.generateLoginTotp") {
      if (!req.itemId) {
        return missingItemId;
      }
      const result = await bridge.generateLoginTotp({
        origin,
        url: tab.url,
        itemId: req.itemId,
      });
      return { ok: true, result };
    }

    if (req.type === "zpass.captureLogin") {
      const payload = parsePasskeyPayload<{
        username?: unknown;
        password?: unknown;
      }>(req.payload);
      const username = stringField(payload, "username");
      const password =
        typeof payload.password === "string" ? payload.password : "";
      if (!username || !password) {
        // 空账密不报错，返 status=none 让 content-script 走「不弹」分支。
        return {
          ok: true,
          result: {
            status: "none",
            origin,
            reason: "empty credentials",
          } satisfies SaveLoginDecision,
        };
      }
      const decision = await bridge.captureLogin({
        origin,
        url: tab.url,
        username,
        password,
      });
      if (decision.status === "locked" && tab.id !== undefined) {
        // 留着凭据等解锁后重试。不在这里主动推 toast，content-script 拿到
        // decision.status=locked 后自己弹 「解锁并保存」 toast。
        rememberPendingCapture({
          tabId: tab.id,
          url: tab.url,
          origin,
          username,
          password,
          expiresAt: Date.now() + PENDING_CAPTURE_TTL_MS,
        });
      } else if (decision.status === "none" && tab.id !== undefined) {
        // 跳过 —— 能越跟越好，别让旧 capture 留着。
        forgetPendingCapture(tab.id, origin);
      }
      return { ok: true, result: decision };
    }

    if (req.type === "zpass.saveLogin") {
      const payload = parsePasskeyPayload<{
        itemId?: unknown;
        username?: unknown;
        password?: unknown;
        name?: unknown;
      }>(req.payload);
      const username = stringField(payload, "username");
      const password =
        typeof payload.password === "string" ? payload.password : "";
      const itemId = stringField(payload, "itemId");
      const name = stringField(payload, "name");
      if (!username || !password) {
        return { ok: false, error: "账号和密码不能为空。" };
      }
      const saveReq = {
        origin,
        url: tab.url,
        username,
        password,
      };
      if (itemId) Object.assign(saveReq, { itemId });
      if (name) Object.assign(saveReq, { name });
      const result = await bridge.saveLogin(saveReq);
      // 保存成功后清掉该 tab+origin 的待存 capture，避免重复弹。
      if (tab.id !== undefined) {
        forgetPendingCapture(tab.id, origin);
      }
      // 顺手刷一下 badge（新增凭据让当前站点“可填充”计数 +1）。
      void refreshActiveTabBadge();
      return { ok: true, result };
    }

    if (req.type === "zpass.ignoreSaveOrigin") {
      const result = await bridge.ignoreSaveOrigin({ origin, url: tab.url });
      if (tab.id !== undefined) {
        forgetPendingCapture(tab.id, origin);
      }
      return { ok: true, result };
    }

    if (req.type === "zpass.fillActiveTab") {
      if (!req.itemId) {
        return missingItemId;
      }
      if (tab.id === undefined) {
        return { ok: false, error: "无法访问当前标签页。" };
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

    return { ok: false, error: `未知请求类型：${req.type}` };
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
