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
  type ShowSaveToastMessage,
} from "../src/shared/messages";

const bridge = new NativeBridge();

// ============================================================================
// 「锁定状态下捕获」等待区
// ----------------------------------------------------------------------------
// 用户身份验证完后发起了一次 captureLogin，如果当时 desktop vault 处于锁定
// 状态，我们不能直接弹「保存」（干方拿不到 vault 读写权限）。反之，我们要做三件事：
//
//   1. 让 content-script 弹个「解锁并保存」的提示 toast。
//   2. 在本模块里以 tabId+origin 为键留住 capture 负载。
//   3. 开启一个低频次 status 轮询，一旦发现 unlocked → 重评 captureLogin、
//      如果评估不是 "none" 就把对应 toast 推回 content-script。
//
// **什么使用 chrome.storage.session：**
// MV3 service worker 在 30 秒空闲后会被 terminate，模块级内存 Map 全部丢。
// 跳转页面期间容易命中这个窗口，导致 capture 遗失。storage.session 是内存存
// 储、不落盘、SW 重启不丢，浏览器关 / 扩展重载才清——Bitwarden / 1Password
// 同样选择，是此场景的正确答案。明文密码仅驻内存、仍满足安全要求。
//
// 为避免每次调用都 async 走一趟 storage，另维护一份内存镜像；SW 启动时
// 延迟从 storage 装载，装载完后后续所有读走内存、写同时写内存及 storage。
// 任何外部 entry point（handleMessage / tabs.onUpdated / pruneExpired）调读前
// 都需 await ensurePendingLoaded() 以保证镜像是新的。
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
   *   - new/update：可直接弹保存 toast。
   *   - locked：需等 vault 解锁后 drainPendingCapturesOnUnlock 重评。
   * 仅保存 new/update/locked 三种，不存 none。
   */
  decision: SaveLoginDecision;
  /** 页面推荐的条目名称（原页 document.title），可空。 */
  suggestedName?: string;
}

const PENDING_CAPTURE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const SESSION_KEY = "zpass.pendingCaptures.v1";

// 内存镜像。所有读都从这里拿；所有写同时走内存 + storage.session。
// 仅在模块首次访问时从 storage 预热（SW 启动后可能没镜像但 storage 里有数据）。
const pendingCaptures = new Map<string, PendingCapture>();
let pendingLoadPromise: Promise<void> | null = null;

let unlockPollTimer: ReturnType<typeof globalThis.setInterval> | null = null;
const UNLOCK_POLL_INTERVAL_MS = 1500;

function pendingKey(tabId: number, origin: string): string {
  return `${tabId}::${origin}`;
}

/**
 * 确保内存镜像从 storage.session 装载过。多次调用只走一次 round-trip。
 * 所有压需访问 pendingCaptures 的入口都要 await 这个。
 */
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
      // SW 重启后会丢 capture，但 UI 表现与原来一致，不障碍其他功能。
    }
    // 装载后启动 locked 轮询（如果有遗留的 locked capture）
    if (hasLockedPending()) startUnlockPolling();
  })();
  return pendingLoadPromise;
}

/**
 * 把当前镜像同步到 storage.session。写是全量写——队列小（边外套几条），
 * 不会是热点。fire-and-forget，调用者不提供 await 路径。
 */
function persistPending(): void {
  const snapshot: Record<string, PendingCapture> = {};
  for (const [key, value] of pendingCaptures) {
    snapshot[key] = value;
  }
  void browser.storage.session.set({ [SESSION_KEY]: snapshot }).catch(() => {
    // storage 不可用：内存镜像仍准，仅多 SW 重启送丢。
  });
}

function rememberPendingCapture(capture: PendingCapture): void {
  pendingCaptures.set(pendingKey(capture.tabId, capture.origin), capture);
  persistPending();
  // 诊断日志：不打密码、仅记关键路径用于排查
  console.log(
    "[ZPass] remember capture",
    capture.decision.status,
    capture.origin,
    capture.username,
  );
  // 仅 locked 需要轮询解锁状态；new/update 是等 tabs.onUpdated 或 content-script pull，
  // 不消耗轮询资源。
  if (capture.decision.status === "locked") {
    startUnlockPolling();
  }
}

function forgetPendingCapture(tabId: number, origin: string): void {
  const had = pendingCaptures.delete(pendingKey(tabId, origin));
  if (had) persistPending();
  if (!hasLockedPending()) stopUnlockPolling();
}

/** 任一 pending capture 是 locked 状态吗？决定是否需保持轮询。 */
function hasLockedPending(): boolean {
  for (const capture of pendingCaptures.values()) {
    if (capture.decision.status === "locked") return true;
  }
  return false;
}

/**
 * 清掉指定 tab 的所有 pending capture（不限 origin）。
 * 用于 tab 关闭 / 跳转到不匹配 origin 的场景。
 */
function forgetAllPendingForTab(tabId: number): void {
  let dirty = false;
  for (const [key, capture] of pendingCaptures) {
    if (capture.tabId === tabId) {
      pendingCaptures.delete(key);
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
        // 还是 locked。下轮重试。
        continue;
      }
      // new / update —— 升级 decision 并尝试 push。push 失败（content-script
      // 不在）不丢 capture：升级后的队列可被 tabs.onUpdated / checkSaveQueue 领走。
      const upgraded: PendingCapture = { ...fresh, decision };
      pendingCaptures.set(pendingKey(capture.tabId, capture.origin), upgraded);
      persistPending();
      const pushed = await pushSaveToast(capture.tabId, upgraded, decision);
      if (pushed) {
        forgetPendingCapture(capture.tabId, capture.origin);
      }
      // 本轮完了。升级后不再 locked，后面 hasLockedPending() 如所有 capture 都
      // 不是 locked了则轮询会被 stopUnlockPolling 停掉。
    } catch {
      // 零星错误不阻断其他 capture 重评。
    }
  }
  pruneExpiredCaptures();
  // 轮询是为 locked 的——如果本轮之后所有 locked 都被升级为 new/update
  // 或 forget 了，该停轮询。forget* 函数会自动 stopUnlockPolling，这里
  // 仅为「只升级了、一个 forget 都没」的路径补一下。
  if (!hasLockedPending()) stopUnlockPolling();
}

function pruneExpiredCaptures(): void {
  const now = Date.now();
  let dirty = false;
  for (const [key, capture] of pendingCaptures) {
    if (capture.expiresAt <= now) {
      pendingCaptures.delete(key);
      dirty = true;
    }
  }
  if (dirty) persistPending();
  if (!hasLockedPending()) stopUnlockPolling();
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
    const message: ShowSaveToastMessage = {
      type: "zpass.showSaveToast",
      decision,
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
    await browser.tabs.sendMessage(tabId, message);
    console.log(
      "[ZPass] push save toast OK",
      tabId,
      capture.origin,
      decision.status,
    );
    return true;
  } catch (error) {
    console.log(
      "[ZPass] push save toast failed",
      tabId,
      capture.origin,
      error instanceof Error ? error.message : error,
    );
    // tab 已关 / content-script 未加载——删除会调、不重试。
    return false;
  }
}

export default defineBackground(() => {
  initBadge(bridge);
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    return handleMessage(message, sender);
  });

  // ──── 跨页面跳转后推「保存 toast」的主动分支 ────
  //
  // 场景：用户在 A 页提交登录，成功后浏览器跳转到 B 页。原 content-script 被
  // unload 了，另外 toast 也随旧 DOM 丢。这里监听 tabs.onUpdated，在新页面
  // status==="complete" 后看看队列里该 tab 还有没有未消费的 new/update
  // capture、有就 push 一次。这与 content-script 启动时主动 pull (见
  // zpass.checkSaveQueue) 双保险——以 push 为主、pull 兑底，哪个先到包都能弹。
  //
  // 不接「domain」随意变化：只有新 URL 的 origin 与 capture origin 严格一致才 push。
  // 跳到不同 origin 的页面 = 用户不再为当初 origin 口告责任，不弹，仅等过期
  // 或 onRemoved 清掉。
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
    if (!tab.url) return;
    const newOrigin = getHttpOrigin(tab.url);
    if (!newOrigin) return;
    void (async () => {
      // 必须 await：SW 刚被页面导航拉起来、镜像还空。
      await ensurePendingLoaded();
      const capture = pendingCaptures.get(pendingKey(tabId, newOrigin));
      if (!capture) return;
      if (
        capture.decision.status !== "new" &&
        capture.decision.status !== "update"
      )
        return;
      // 跨 origin 为了不误弹，这里 capture.origin === newOrigin 被 pendingKey 隐含保证。
      await pushSaveToast(tabId, capture, capture.decision);
      // 不在这里 forget：用户可能点了关闭、或 SPA 中多次 tabs.onUpdated 跳转仍同
      // origin——保留队列让其能重推。forget 只在 saveLogin / ignoreSaveOrigin /
      // 跨 origin 跳转 / tab 关闭 / TTL 过期 这几个明确信号上才发生。
    })();
  });

  // tab 关闭 → 丢掉该 tab 的所有 pending capture。安全性：避免明文密码在
  // 内存里驻留超过用户意预期的时间。
  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      await ensurePendingLoaded();
      forgetAllPendingForTab(tabId);
    })();
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

    // 以下所有分支可能访问 pendingCaptures——在其它代码跳进分支前确保
    // 镜像从 storage.session 装载过。首次调用带一次 storage round-trip，后续
    // 调用都是已 resolved promise、几乎零开销。
    await ensurePendingLoaded();

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
        suggestedName?: unknown;
      }>(req.payload);
      const username = stringField(payload, "username");
      const password =
        typeof payload.password === "string" ? payload.password : "";
      const suggestedName = stringField(payload, "suggestedName");
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
      console.log(
        "[ZPass] captureLogin decision",
        decision.status,
        origin,
        username,
        decision.reason ?? "",
      );
      // 不同决策分别入/出队。**与上一版的最大区别：**这里对 new/update
      // 也 rememberPendingCapture，为「提交后页面跳转」场景兼底——content-script
      // 拿到 decision 后在旧页上“能弹就弹”，页面一跳丢了也不要紧，
      // tabs.onUpdated / checkSaveQueue 会从队列重推。
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
      } else if (decision.status === "none" && tab.id !== undefined) {
        // 决策怎么动都不弹，该清就清。避免旧 capture 遗留在内存里。
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

    // content-script 启动 / 页面 ready 后主动 pull。background 查队列里
    // 该 tab+origin 还有没有未消费的 new/update capture，有就立即 push。
    //
    // 安全考量：
    //   - origin / tab.id 都是 background 从 sender 重推出来的（见上面 resolveTab
    //     + getHttpOrigin），content-script 端伪造不了。pendingKey 同时锁
    //     tabId + origin，根本不可能跳 tab 拿别人的密码。
    //   - locked 状态不走 push 路径；content-script 拿到 status=locked 后自己
    //     弹「解锁并保存」 toast。
    if (req.type === "zpass.checkSaveQueue") {
      if (tab.id === undefined) return { ok: true };
      const capture = pendingCaptures.get(pendingKey(tab.id, origin));
      if (!capture) return { ok: true };
      if (capture.expiresAt <= Date.now()) {
        forgetPendingCapture(tab.id, origin);
        return { ok: true };
      }
      if (
        capture.decision.status === "new" ||
        capture.decision.status === "update"
      ) {
        // 异步 push，不阻塞响应。content-script 会从同一 onMessage 通道拿到。
        void pushSaveToast(tab.id, capture, capture.decision);
      }
      return { ok: true };
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
