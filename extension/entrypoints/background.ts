import { NativeBridge } from "../src/background/native-bridge";
import {
  initBadge,
  refreshActiveTabBadge,
  setAlertOnAllTabs,
  updateBadgeFromQueryResult,
} from "../src/background/badge";
import {
  InlineMenuBridge,
  isInlineMenuRequest,
} from "../src/background/inline-menu-bridge";
import { InlineMenuPort } from "../src/shared/inline-menu-enums";
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
  type ShowSaveToastMessage,
} from "../src/shared/messages";

const bridge = new NativeBridge();
const inlineMenu = new InlineMenuBridge(bridge);

// ============================================================================
// 「保存登录」捕获 + 独立 popup 窗口调度
// ----------------------------------------------------------------------------
// 用户提交登录后，content-script 上报 captureLogin。background 做两件事：
//
//   1. 调 native bridge 评估 decision（new / update / locked / none）。
//   2. 对 new/update/locked 三种状态，**立刻打开一个独立 OS 级 popup 窗口**
//      展示保存提示（位置：浏览器活动窗口右上角，420×220）。
//
// 为什么用独立窗口而不是注入页面 iframe：
//   - 登录提交后宿主页面通常立即跳转 / SPA 重绘，iframe 随宿主 DOM 销毁，
//     用户来不及点保存。
//   - 独立窗口脱离宿主页面生命周期，无论页面如何跳转都不受影响——这是
//     Bitwarden / 1Password 的「弹出窗口」模式。
//
// **为什么使用 chrome.storage.session：**
// MV3 service worker 在 30 秒空闲后会被 terminate，模块级内存 Map 全部丢。
// 跳转页面期间容易命中这个窗口，导致 capture 遗失。storage.session 是内存存
// 储、不落盘、SW 重启不丢，浏览器关 / 扩展重载才清。明文密码仅驻内存、仍满足安全要求。
//
// 为避免每次调用都 async 走一趟 storage，另维护一份内存镜像；SW 启动时
// 延迟从 storage 装载，装载完后后续所有读走内存、写同时写内存及 storage。
//
// 为什么设超时：service worker 梦想里可以跳完才恢复，但现实是明文密码在
// 内存里退到后台越久越危险。接受「用户 5 分钟内不解锁 → 丢丢 capture」。
// ============================================================================

interface PendingCapture {
  tabId: number;
  url: string;
  origin: string;
  username: string;
  password: string;
  expiresAt: number;
  /**
   * captureLogin 评估结果。
   *   - new/update：可直接弹保存 popup。
   *   - locked：需等 vault 解锁后 drainPendingCapturesOnUnlock 重评。
   * 仅保存 new/update/locked 三种，不存 none。
   */
  decision: SaveLoginDecision;
  /** 页面推荐的条目名称（原页 document.title），可空。 */
  suggestedName?: string;
}

const PENDING_CAPTURE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const SESSION_KEY = "zpass.pendingCaptures.v1";

// 独立 popup 窗口尺寸 —— 与 AGENTS 决策一致：420×220 稳过 Chrome 最小尺寸。
const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 220;
// 弹出位置参考浏览器活动窗口的右上角，距离窗口右边缘 24px、距标题栏下 70px
// （绕开标签栏 / 地址栏的视觉冲突，且不挡住关闭按钮）。
const POPUP_RIGHT_INSET = 24;
const POPUP_TOP_INSET = 70;

// 内存镜像。所有读都从这里拿；所有写同时走内存 + storage.session。
const pendingCaptures = new Map<string, PendingCapture>();
let pendingLoadPromise: Promise<void> | null = null;

let unlockPollTimer: ReturnType<typeof globalThis.setInterval> | null = null;
const UNLOCK_POLL_INTERVAL_MS = 1500;

// popup 窗口 ↔ pendingKey 双向映射。
// - popup → key：windows.onRemoved 触发清理时需要反查 key 丢 capture。
// - key → popup：同 tab+origin 二次提交时复用窗口（聚焦 + 推升级 payload），
//   避免一次会话里弹多个 popup 拥挤。
const popupByKey = new Map<string, number>();
const keyByPopup = new Map<number, string>();

function pendingKey(tabId: number, origin: string): string {
  return `${tabId}::${origin}`;
}

function ensurePendingLoaded(): Promise<void> {
  if (pendingLoadPromise !== null) return pendingLoadPromise;
  pendingLoadPromise = (async () => {
    try {
      const stored = await browser.storage.session.get(SESSION_KEY);
      const raw = stored[SESSION_KEY] as
        | Record<string, PendingCapture>
        | undefined;
      if (raw && typeof raw === "object") {
        const now = Date.now();
        for (const [key, value] of Object.entries(raw)) {
          if (value && value.expiresAt > now) {
            pendingCaptures.set(key, value);
          }
        }
      }
    } catch {
      // storage.session 在某些环境下不可用（如很老的 Chrome）——退化为纯内存。
    }
    if (hasLockedPending()) startUnlockPolling();
  })();
  return pendingLoadPromise;
}

function persistPending(): void {
  const snapshot: Record<string, PendingCapture> = {};
  for (const [key, value] of pendingCaptures) {
    snapshot[key] = value;
  }
  void browser.storage.session.set({ [SESSION_KEY]: snapshot }).catch(() => {});
}

function rememberPendingCapture(capture: PendingCapture): void {
  pendingCaptures.set(pendingKey(capture.tabId, capture.origin), capture);
  persistPending();
  if (capture.decision.status === "locked") {
    startUnlockPolling();
  }
}

function forgetPendingCapture(tabId: number, origin: string): void {
  const key = pendingKey(tabId, origin);
  const had = pendingCaptures.delete(key);
  if (had) persistPending();
  // 顺手关掉关联的 popup 窗口（如果还在）——业务流已经结束，没必要让它留着。
  const winId = popupByKey.get(key);
  if (winId !== undefined) {
    popupByKey.delete(key);
    keyByPopup.delete(winId);
    void browser.windows.remove(winId).catch(() => {});
  }
  if (!hasLockedPending()) stopUnlockPolling();
}

function hasLockedPending(): boolean {
  for (const capture of pendingCaptures.values()) {
    if (capture.decision.status === "locked") return true;
  }
  return false;
}

function forgetAllPendingForTab(tabId: number): void {
  let dirty = false;
  for (const [key, capture] of pendingCaptures) {
    if (capture.tabId === tabId) {
      pendingCaptures.delete(key);
      const winId = popupByKey.get(key);
      if (winId !== undefined) {
        popupByKey.delete(key);
        keyByPopup.delete(winId);
        void browser.windows.remove(winId).catch(() => {});
      }
      dirty = true;
    }
  }
  if (dirty) persistPending();
  if (!hasLockedPending()) stopUnlockPolling();
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
  await ensurePendingLoaded();
  if (pendingCaptures.size === 0) {
    stopUnlockPolling();
    return;
  }
  let unlocked = false;
  try {
    const status = await bridge.status();
    unlocked = status.unlocked === true;
  } catch {
    pruneExpiredCaptures();
    return;
  }
  if (!unlocked) {
    pruneExpiredCaptures();
    return;
  }

  const snapshot = Array.from(pendingCaptures.values());
  for (const capture of snapshot) {
    const key = pendingKey(capture.tabId, capture.origin);
    const fresh = pendingCaptures.get(key);
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
        continue;
      }
      const upgraded: PendingCapture = { ...fresh, decision };
      pendingCaptures.set(key, upgraded);
      persistPending();
      // 已经有 popup 在开（locked 态）→ 推升级 payload；否则新开一个。
      await openOrUpdateSavePopup(upgraded);
    } catch {
      // 单条错误不阻断其他 capture 的重评。
    }
  }
  pruneExpiredCaptures();
  if (!hasLockedPending()) stopUnlockPolling();
}

function pruneExpiredCaptures(): void {
  const now = Date.now();
  let dirty = false;
  for (const [key, capture] of pendingCaptures) {
    if (capture.expiresAt <= now) {
      pendingCaptures.delete(key);
      const winId = popupByKey.get(key);
      if (winId !== undefined) {
        popupByKey.delete(key);
        keyByPopup.delete(winId);
        void browser.windows.remove(winId).catch(() => {});
      }
      dirty = true;
    }
  }
  if (dirty) persistPending();
  if (!hasLockedPending()) stopUnlockPolling();
}

/* ============================================================================
 * 独立 popup 窗口调度
 * ========================================================================== */

/**
 * 打开 / 更新对应 capture 的独立 popup 窗口。
 *
 *   - 已有窗口 → focus 一下，并通过 runtime.sendMessage 推升级 payload
 *     （locked → new/update 解锁回放路径）。
 *   - 无窗口 → 用 windows.create 弹出，位置参考活动浏览器窗口的右上角。
 *
 * 窗口和 pendingKey 通过 popupByKey / keyByPopup 双向绑定；popup 启动后
 * 用 zpass.savePopupFetch 拉取自己的 capture。
 */
async function openOrUpdateSavePopup(capture: PendingCapture): Promise<void> {
  const key = pendingKey(capture.tabId, capture.origin);
  const existing = popupByKey.get(key);
  if (existing !== undefined) {
    // 复用已开的 popup —— focus + 推升级消息。
    try {
      await browser.windows.update(existing, { focused: true });
    } catch {
      // 窗口已被用户关闭但 onRemoved 还没冒泡——清干净 registry 再走新建。
      popupByKey.delete(key);
      keyByPopup.delete(existing);
    }
    if (popupByKey.has(key)) {
      pushPayloadToPopup(capture);
      return;
    }
  }

  // 计算弹出位置：浏览器活动窗口右上角内侧。失败兜底用 (100, 100)。
  let left = 100;
  let top = 100;
  try {
    const win = await browser.windows.getCurrent();
    if (
      typeof win.left === "number" &&
      typeof win.top === "number" &&
      typeof win.width === "number"
    ) {
      left = Math.max(
        0,
        Math.round(win.left + win.width - POPUP_WIDTH - POPUP_RIGHT_INSET),
      );
      top = Math.max(0, Math.round(win.top + POPUP_TOP_INSET));
    }
  } catch {
    // 取不到当前窗口（极少见）—— 用兜底坐标即可。
  }

  try {
    const created = await browser.windows.create({
      url: browser.runtime.getURL("/save-popup.html"),
      type: "popup",
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      left,
      top,
      focused: true,
    });
    if (created && typeof created.id === "number") {
      popupByKey.set(key, created.id);
      keyByPopup.set(created.id, key);
    }
  } catch {
    // windows.create 失败（无权限 / 窗口数上限）—— 静默放弃，
    // 下次 capture 重评时会再次尝试。
  }
}

/**
 * 推升级 payload 给已存在的 popup。
 * popup 内 onMessage 监听 zpass.showSaveToast 后会替换 UI（锁定 → 保存）。
 */
function pushPayloadToPopup(capture: PendingCapture): void {
  const message: ShowSaveToastMessage = {
    type: "zpass.showSaveToast",
    decision: capture.decision,
    capture: {
      origin: capture.origin,
      url: capture.url,
      username: capture.username,
      password: capture.password,
    },
  };
  if (capture.suggestedName) {
    message.capture.suggestedName = capture.suggestedName;
  }
  // 整个扩展上下文共享 runtime.sendMessage：所有打开的 popup / popup.html
  // 都会收到，但 type 是唯一识别，且 popup 自己只在「期望接收」时渲染——
  // popup 启动 fetch 一次后驻留监听器，命中即替换 UI；其他扩展页面不会
  // 注册这个 type 的 handler，自然忽略。
  void browser.runtime.sendMessage(message).catch(() => {
    // popup 可能在解锁延迟期内被用户关掉——下次重评时 openOrUpdateSavePopup
    // 会发现窗口不存在并重新创建。
  });
}

export default defineBackground(() => {
  initBadge(bridge);
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    return handleMessage(message, sender);
  });

  // 内联菜单 list iframe 直接 runtime.connect 过来 —— 名字命中即转交 bridge,
  // 不命中(扩展其他模块 / 异常) 静默忽略。
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === InlineMenuPort.List) {
      inlineMenu.attachPort(port);
    }
  });

  // popup 窗口被用户关掉 → 释放 registry，并丢掉该 capture（明文密码不再
  // 长留内存）。这里 forget 之后下一轮 unlock poll 不再考虑这条。
  browser.windows.onRemoved.addListener((windowId) => {
    const key = keyByPopup.get(windowId);
    if (key === undefined) return;
    keyByPopup.delete(windowId);
    popupByKey.delete(key);
    void (async () => {
      await ensurePendingLoaded();
      const capture = pendingCaptures.get(key);
      if (!capture) {
        if (!hasLockedPending()) stopUnlockPolling();
        return;
      }
      pendingCaptures.delete(key);
      persistPending();
      if (!hasLockedPending()) stopUnlockPolling();
    })();
  });

  // tab 关闭 → 丢掉该 tab 的所有 pending capture + 关掉关联 popup。
  // 安全性：避免明文密码在内存里驻留超过用户意预期的时间。
  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      await ensurePendingLoaded();
      forgetAllPendingForTab(tabId);
      inlineMenu.forgetTab(tabId);
    })();
  });
});

async function handleMessage(
  message: unknown,
  sender: Browser.runtime.MessageSender,
): Promise<ExtensionResponse> {
  // 内联菜单消息走独立分支(非业务 RPC, 与 native bridge 解耦)。
  // 不进入 try 块 —— bridge 内部自己吞错。
  if (isInlineMenuRequest(message)) {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
      return { ok: false, error: "无法识别来源标签页。" };
    }
    // 关键:cipher 查询永远走 sender.tab.url 的 top-frame origin,
    // 不信任 content 上报的 req.origin —— 阿里邮箱等会把登录表单
    // 嵌在 cross-origin iframe 里, 子 frame 上报的 origin 不是
    // 用户认知里的"当前网站"。
    const tabUrl = sender.tab?.url ?? "";
    const tabOrigin = getHttpOrigin(tabUrl);
    if (!tabOrigin) {
      return { ok: false, error: "当前页面不能使用 ZPass 自动填充。" };
    }
    if (message.type === "zpass.inlineMenu.open") {
      await inlineMenu.handleOpen(tabId, {
        ...message,
        origin: tabOrigin,
      });
      return { ok: true };
    }
    if (message.type === "zpass.inlineMenu.subFrameOpen") {
      // sub-frame 触发, rect 已是顶层 viewport 绝对坐标(content 链上累加完成);
      // origin 信任 sender.tab.url 而非 sub-frame 自身 origin。
      await inlineMenu.handleSubFrameOpen(tabId, message, tabOrigin);
      return { ok: true };
    }
    if (message.type === "zpass.inlineMenu.close") {
      inlineMenu.handleClose(tabId);
      return { ok: true };
    }
    if (message.type === "zpass.inlineMenu.updatePosition") {
      inlineMenu.handleUpdatePosition(tabId, {
        ...message,
        origin: tabOrigin,
      });
      return { ok: true };
    }
    return { ok: false, error: "未知 inline menu 请求。" };
  }

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
      if (!status.unlocked) {
        void setAlertOnAllTabs();
      } else {
        void refreshActiveTabBadge();
      }
      return { ok: true, result: status };
    }

    // save-popup 启动后第一时间调用，请求自己关联的 capture。
    // 通过 sender 的 windowId 反查 keyByPopup 即可，无需信任 payload。
    if (req.type === "zpass.savePopupFetch") {
      await ensurePendingLoaded();
      const winId = sender.tab?.windowId;
      if (typeof winId !== "number") {
        return { ok: false, error: "无法识别 popup 窗口。" };
      }
      const key = keyByPopup.get(winId);
      if (!key) {
        return { ok: false, error: "未找到对应的保存请求。" };
      }
      const capture = pendingCaptures.get(key);
      if (!capture) {
        return { ok: false, error: "保存请求已过期。" };
      }
      return {
        ok: true,
        result: {
          decision: capture.decision,
          capture: {
            origin: capture.origin,
            url: capture.url,
            username: capture.username,
            password: capture.password,
            suggestedName: capture.suggestedName,
          },
        },
      };
    }

    // 以下几条来自 save-popup（扩展上下文），sender 没有 web tab origin。
    // origin/url 必须从 payload 显式带，且通过 popup 关联的 capture 校验。
    if (req.type === "zpass.saveLogin") {
      await ensurePendingLoaded();
      const popupKey = popupKeyFromSender(sender);
      const payload = parsePasskeyPayload<{
        itemId?: unknown;
        username?: unknown;
        password?: unknown;
        name?: unknown;
        origin?: unknown;
        url?: unknown;
      }>(req.payload);
      const ctx = resolvePopupContext(popupKey, payload);
      if (!ctx) {
        return { ok: false, error: "ZPass 只支持 http 和 https 页面。" };
      }
      const username = stringField(payload, "username");
      const password =
        typeof payload.password === "string" ? payload.password : "";
      const itemId = stringField(payload, "itemId");
      const name = stringField(payload, "name");
      if (!username || !password) {
        return { ok: false, error: "账号和密码不能为空。" };
      }
      const saveReq = {
        origin: ctx.origin,
        url: ctx.url,
        username,
        password,
      };
      if (itemId) Object.assign(saveReq, { itemId });
      if (name) Object.assign(saveReq, { name });
      const result = await bridge.saveLogin(saveReq);
      if (ctx.tabId !== undefined) {
        forgetPendingCapture(ctx.tabId, ctx.origin);
      }
      void refreshActiveTabBadge();
      return { ok: true, result };
    }

    if (req.type === "zpass.ignoreSaveOrigin") {
      await ensurePendingLoaded();
      const popupKey = popupKeyFromSender(sender);
      const payload = parsePasskeyPayload<{ origin?: unknown; url?: unknown }>(
        req.payload,
      );
      const ctx = resolvePopupContext(popupKey, payload);
      if (!ctx) {
        return { ok: false, error: "ZPass 只支持 http 和 https 页面。" };
      }
      const result = await bridge.ignoreSaveOrigin({
        origin: ctx.origin,
        url: ctx.url,
      });
      if (ctx.tabId !== undefined) {
        forgetPendingCapture(ctx.tabId, ctx.origin);
      }
      return { ok: true, result };
    }

    const tab = await resolveTab(sender);
    if (!tab.url) {
      return { ok: false, error: "当前页面不能使用 ZPass 自动填充。" };
    }
    const origin = getHttpOrigin(tab.url);
    if (!origin) {
      return { ok: false, error: "ZPass 只支持 http 和 https 页面。" };
    }

    await ensurePendingLoaded();

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
        suggestedName?: unknown;
      }>(req.payload);
      const username = stringField(payload, "username");
      const password =
        typeof payload.password === "string" ? payload.password : "";
      const suggestedName = stringField(payload, "suggestedName");
      if (!username || !password) {
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
      if (
        tab.id !== undefined &&
        (decision.status === "new" ||
          decision.status === "update" ||
          decision.status === "locked")
      ) {
        const capture: PendingCapture = {
          tabId: tab.id,
          url: tab.url,
          origin,
          username,
          password,
          expiresAt: Date.now() + PENDING_CAPTURE_TTL_MS,
          decision,
        };
        if (suggestedName) capture.suggestedName = suggestedName;
        rememberPendingCapture(capture);
        // 立即开/聚焦 popup —— content-script 拿到 decision 后无需再做任何 UI。
        await openOrUpdateSavePopup(capture);
      } else if (decision.status === "none" && tab.id !== undefined) {
        forgetPendingCapture(tab.id, origin);
      }
      return { ok: true, result: decision };
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

/* ============================================================================
 * popup 上下文解析
 * ----------------------------------------------------------------------------
 * 来自 save-popup 的 saveLogin / ignoreSaveOrigin 请求，sender 是扩展自身，
 * 没有 web 业务 origin。我们用 sender.tab.windowId 反查 keyByPopup 拿到
 * 关联的 pendingKey，进而拿到真实的 (tabId, origin)。
 *
 * payload 里 popup 也会带 origin/url 兜底——如果 windowId 反查失败（极少见，
 * 比如用户重新加载了 popup），就退回 payload 提供的 origin/url。但这条路径
 * 需要 origin 是合法 http(s) origin，避免被滥用。
 * ========================================================================== */

function popupKeyFromSender(sender: Browser.runtime.MessageSender):
  | { key: string; tabId: number; origin: string; url: string }
  | null {
  const winId = sender.tab?.windowId;
  if (typeof winId !== "number") return null;
  const key = keyByPopup.get(winId);
  if (!key) return null;
  const capture = pendingCaptures.get(key);
  if (!capture) return null;
  return {
    key,
    tabId: capture.tabId,
    origin: capture.origin,
    url: capture.url,
  };
}

function resolvePopupContext(
  popupKey: { tabId: number; origin: string; url: string } | null,
  payload: { origin?: unknown; url?: unknown },
): { tabId?: number; origin: string; url: string } | null {
  if (popupKey) {
    return {
      tabId: popupKey.tabId,
      origin: popupKey.origin,
      url: popupKey.url,
    };
  }
  // popup 反查失败时的兜底：信任 payload 里的 origin/url，但要求是合法
  // http(s) 来源（防止扩展页里被注入恶意 URL 滥用 saveLogin）。
  const origin = typeof payload.origin === "string" ? payload.origin : "";
  const url = typeof payload.url === "string" ? payload.url : "";
  const safeOrigin = getHttpOrigin(url);
  if (!safeOrigin || safeOrigin !== origin) return null;
  return { origin: safeOrigin, url };
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
