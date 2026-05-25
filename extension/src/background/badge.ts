/**
 * Badge ——在浏览器工具栏图标右上角标注当前页面状态。
 *
 * 行为与 Bitwarden 插件对齐：
 *   - 当前 tab 是 http(s)，保险库已解锁，origin 有匹配 → 绿底数字（>99 显示 "99+"）
 *   - 桌面端离线 / vault 锁定 → 红底圆点（替代以前的「光标聚焦时弹气泡」侵入式提示）
 *   - 已解锁但 origin 无匹配 / 非 http(s) → 清空 badge
 *
 * 数据来源复用现有的 native queryLogins 调用，per-tab 缓存避免抖动。
 * popup 打开时也会触发 queryLogins，handler 会顺手把结果灌回这里更新 badge。
 */
import { getHttpOrigin } from "../shared/messages";
import type { NativeBridge } from "./native-bridge";

/** badge 颜色：深绿底 + 白字，深浅主题下都能读清；与品牌 accent 同色系。 */
const BADGE_BG = "#5a8a0c";
const BADGE_FG = "#ffffff";
/**
 * desktop 未启动 / vault 锁定时的红色 alert 徽章。用一个 ASCII 圆点而非
 * unicode 装饰符或 emoji，避免被 OS/字体 fallback 渲染成意外字形。
 */
const BADGE_ALERT_BG = "#c73a3a";
const BADGE_ALERT_TEXT = ".";

/** per-tab 最近一次成功查询的缓存，避免短时间内重复打 native。 */
interface TabEntry {
  origin: string;
  count: number;
  at: number;
}
const cache = new Map<number, TabEntry>();
const CACHE_TTL_MS = 5_000;

/** per-tab 正在飞的查询，避免并发重复请求。 */
const inflight = new Map<number, Promise<void>>();

let bridge: NativeBridge | null = null;

export function initBadge(b: NativeBridge): void {
  bridge = b;

  browser.tabs.onActivated.addListener((info) => {
    void refreshTab(info.tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 只在 url 变了或页面加载完成时刷新——避免 favicon、title 等无关变化抖动。
    if (changeInfo.url || changeInfo.status === "complete") {
      // url 变化时旧缓存作废
      if (changeInfo.url) cache.delete(tabId);
      void refreshTab(tabId, tab.url);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    cache.delete(tabId);
    inflight.delete(tabId);
  });

  if (browser.windows?.onFocusChanged) {
    browser.windows.onFocusChanged.addListener(async (windowId) => {
      if (windowId === browser.windows.WINDOW_ID_NONE) return;
      const [tab] = await browser.tabs.query({ active: true, windowId });
      if (tab?.id !== undefined) void refreshTab(tab.id, tab.url);
    });
  }
}

/**
 * 主动刷新指定 tab 的 badge。会查 native（除非命中缓存）。
 * 失败、未解锁、非 http(s) 都会清空 badge。
 */
export async function refreshTab(
  tabId: number,
  knownUrl?: string,
): Promise<void> {
  const existing = inflight.get(tabId);
  if (existing) return existing;

  const run = (async () => {
    try {
      let url = knownUrl;
      if (!url) {
        try {
          const tab = await browser.tabs.get(tabId);
          url = tab.url;
        } catch {
          await clearBadge(tabId);
          return;
        }
      }
      const origin = url ? getHttpOrigin(url) : null;
      if (!origin) {
        await clearBadge(tabId);
        return;
      }

      const cached = cache.get(tabId);
      if (
        cached &&
        cached.origin === origin &&
        Date.now() - cached.at < CACHE_TTL_MS
      ) {
        await applyCount(tabId, cached.count);
        return;
      }

      if (!bridge) {
        await setAlertBadge(tabId);
        return;
      }
      // 先用 ping 探活，避免 desktop 离线时 queryLogins 走 nativehost 的
      // spawn + waitBridge 路径。后者是为 popup 用户主动操作设计的重路径
      // （5s 轮询 + 可能 spawn GUI），badge 刷新是隐式反应 tabs.onActivated
      // / onUpdated 事件，不该代用户决定拉起 GUI。且该隐式调用会占据
      // nativehost 串行 stdin 队列，拖慢 popup 后续的 ping。
      try {
        await bridge.ping();
      } catch {
        // desktop 未启动 → 红色 alert，提示用户「需要处理」而不弹气泡打扰输入
        cache.delete(tabId);
        await setAlertBadge(tabId);
        return;
      }
      try {
        const result = await bridge.queryLogins({ origin, url: url! });
        if (!result.unlocked) {
          cache.delete(tabId);
          await setAlertBadge(tabId);
          return;
        }
        const count = result.items.length;
        cache.set(tabId, { origin, count, at: Date.now() });
        await applyCount(tabId, count);
      } catch {
        // native 不可达 / 桌面端中途崩溃 —— 同样给红 alert。
        cache.delete(tabId);
        await setAlertBadge(tabId);
      }
    } finally {
      inflight.delete(tabId);
    }
  })();

  inflight.set(tabId, run);
  return run;
}

/**
 * 用外部已经拿到的 queryLogins 结果直接更新 badge。
 * popup / content script 通过 background 调 queryLogins 时复用这一路径，
 * 不再重复打 native。
 */
export async function updateBadgeFromQueryResult(
  tabId: number,
  origin: string,
  unlocked: boolean,
  count: number,
): Promise<void> {
  if (!unlocked) {
    cache.delete(tabId);
    await setAlertBadge(tabId);
    return;
  }
  cache.set(tabId, { origin, count, at: Date.now() });
  await applyCount(tabId, count);
}

async function applyCount(tabId: number, count: number): Promise<void> {
  if (count <= 0) {
    await clearBadge(tabId);
    return;
  }
  const text = count > 99 ? "99+" : String(count);
  await setBadge(tabId, text);
}

async function setBadge(tabId: number, text: string): Promise<void> {
  const action = getAction();
  if (!action) return;
  try {
    await action.setBadgeBackgroundColor({ color: BADGE_BG, tabId });
    // setBadgeTextColor 在较老的 Chrome 上可能不存在——做存在性检查。
    if (typeof action.setBadgeTextColor === "function") {
      await action.setBadgeTextColor({ color: BADGE_FG, tabId });
    }
    await action.setBadgeText({ text, tabId });
  } catch {
    // tab 已关 / 切换太快导致 tabId 失效——忽略即可。
  }
}

async function clearBadge(tabId: number): Promise<void> {
  const action = getAction();
  if (!action) return;
  try {
    await action.setBadgeText({ text: "", tabId });
  } catch {
    // 同上。
  }
}

/**
 * 设置红色 alert 徽章。用于 desktop 未启动 / vault 锁定的场景——比
 * 单纯清空更显眼，又不会像 content-script 弹气泡那样打扰用户输入。
 */
async function setAlertBadge(tabId: number): Promise<void> {
  const action = getAction();
  if (!action) return;
  try {
    await action.setBadgeBackgroundColor({ color: BADGE_ALERT_BG, tabId });
    if (typeof action.setBadgeTextColor === "function") {
      await action.setBadgeTextColor({ color: BADGE_FG, tabId });
    }
    await action.setBadgeText({ text: BADGE_ALERT_TEXT, tabId });
  } catch {
    // tab 已关 / 切换太快导致 tabId 失效——忽略即可。
  }
}

/**
 * 清空当前所有已知 tab 的 badge。
 */
export async function clearAllBadges(): Promise<void> {
  const tabs = await browser.tabs.query({});
  cache.clear();
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id !== undefined) await clearBadge(tab.id);
    }),
  );
}

/**
 * 把所有已知 tab 都置成红色 alert 徽章。收到全局锁定 / desktop 离线
 * 信号时调用，替代 clearAllBadges 的「悄悄消失」语义。
 */
export async function setAlertOnAllTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  cache.clear();
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id !== undefined) await setAlertBadge(tab.id);
    }),
  );
}

/**
 * 刷新当前激活 tab 的 badge（绕过缓存）。
 */
export async function refreshActiveTabBadge(): Promise<void> {
  const [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab?.id === undefined) return;
  cache.delete(tab.id);
  await refreshTab(tab.id, tab.url);
}

/** MV3 用 browser.action，MV2 (Firefox) 兼容 browserAction。 */
function getAction(): typeof browser.action | undefined {
  const anyBrowser = browser as unknown as {
    action?: typeof browser.action;
    browserAction?: typeof browser.action;
  };
  return anyBrowser.action ?? anyBrowser.browserAction;
}
