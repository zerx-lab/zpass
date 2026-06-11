// 内联菜单 background 端口路由。
//
// 架构形状参考 Bitwarden 浏览器扩展(GPL-3.0, bitwarden/clients,
// apps/browser/src/autofill/background/overlay.background.ts):
//
//   - 接 content 主世界的 zpass.inlineMenu.* 扩展消息(open/close/updatePosition)
//   - 维护每 tab 一个 list/button port(目前仅 list)
//   - 收 open → 查 native bridge ciphers → 推 init + ciphers → 推 position → 推 fadeIn
//   - 收 list iframe 的 fillSelected → 调 revealLogin → 广播 zpass.fillLogin
//
// 干净室实现, 未复制 Bitwarden 源码。

import type { NativeBridge } from "./native-bridge";
import {
  InlineMenuBackgroundCommand,
  InlineMenuListCommand,
  InlineMenuPort,
  type InlineMenuCiphersPayload,
  type InlineMenuExtensionRequest,
  type InlineMenuFieldRect,
  type InlineMenuIframeMessage,
  type InlineMenuInitPayload,
  type InlineMenuInputKind,
  type InlineMenuPortType,
} from "../shared/inline-menu-enums";
import {
  getHttpOrigin,
  type LoginSecret,
  type QueryLoginsResult,
} from "../shared/messages";

/** tab 级 inline menu 状态。 */
interface TabState {
  /** list iframe 与 background 的 long-lived port。 */
  listPort: Browser.runtime.Port | null;
  /** portKey:每次 open 重新生成, 防 host 页伪造 postMessage。 */
  portKey: string;
  /** 当前 frame origin —— 用于 cipher 查询。 */
  origin: string;
  /** 最近一次 input rect, 端口重连后立即推位置避免空窗。 */
  rect: InlineMenuFieldRect | null;
  /** 缓存的 ciphers payload, 端口连上后即推送。 */
  ciphers: InlineMenuCiphersPayload | null;
  /** 是否在 init 完成后立即聚焦 list(ArrowDown 触发场景)。 */
  pendingFocus: boolean;
  /** 触发菜单的 input 性质 —— 决定列表过滤 + fill 路径。 */
  inputKind: InlineMenuInputKind;
}

function randomPortKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return uuid.replace(/-/g, "");
}

/** 固定的本地化字符串。content scripts 不要 i18n 平台特性, 直接硬中文。 */
const TRANSLATIONS = {
  title: "ZPass 自动填充",
  emptyTitle: "没有匹配项目",
  emptyDescription: "当前网站还没有保存的登录条目。",
  lockedTitle: "ZPass 已锁定",
  lockedDescription: "请解锁 ZPass Desktop 后再使用自动填充。",
  unlockCta: "打开 ZPass",
} as const;

/**
 * Inline menu bridge。background 模块, 与 NativeBridge 一对一持有。
 *
 * 调用方约定:
 *   1. background.ts 拿到 zpass.inlineMenu.* 扩展消息时, 调对应方法。
 *   2. background.ts 在 defineBackground 里挂 runtime.onConnect 监听,
 *      把端口名是 InlineMenuPort.List 的连接交给 attachListPort。
 */
export class InlineMenuBridge {
  private readonly tabs = new Map<number, TabState>();

  constructor(private readonly native: NativeBridge) {}

  /** runtime.onConnect 入口 —— 把 list iframe 的端口挂到 tab 上。 */
  attachPort(port: Browser.runtime.Port): boolean {
    if (port.name !== InlineMenuPort.List) return false;
    const tabId = port.sender?.tab?.id;
    if (typeof tabId !== "number") {
      try {
        port.disconnect();
      } catch {
        // ignore
      }
      return true;
    }
    const state = this.ensureTabState(tabId);
    // 旧端口可能还活着(浏览器某些情况下重复 connect), 先断旧的。
    if (state.listPort) {
      try {
        state.listPort.disconnect();
      } catch {
        // ignore
      }
    }
    state.listPort = port;
    port.onMessage.addListener((raw: unknown) =>
      this.handlePortMessage(tabId, raw),
    );
    port.onDisconnect.addListener(() => {
      const cur = this.tabs.get(tabId);
      if (cur && cur.listPort === port) {
        cur.listPort = null;
      }
    });
    // iframe 已连上 → 立即推 init + 缓存的 ciphers + position。
    this.pushInit(tabId);
    if (state.ciphers) {
      this.pushCiphers(tabId, state.ciphers);
    }
    if (state.rect) {
      this.pushPosition(tabId, state.rect);
    }
    this.pushFadeIn(tabId);
    return true;
  }

  /** content → background:open inline menu。 */
  /** 顶层 frame controller 直接触发的 open(rect 已是顶层 viewport 坐标)。 */
  async handleOpen(
    tabId: number,
    req: Extract<InlineMenuExtensionRequest, { type: "zpass.inlineMenu.open" }>,
  ): Promise<void> {
    await this.startOpen(tabId, req.origin, req.rect, req.inputKind, req.focusList === true, false);
  }

  /**
   * sub-frame 触发的 open 路径:rect 已通过 postMessage 累加链算成顶层
   * frame viewport 的绝对坐标; origin 由 background 用 sender.tab.url 注入。
   */
  async handleSubFrameOpen(
    tabId: number,
    req: Extract<InlineMenuExtensionRequest, { type: "zpass.inlineMenu.subFrameOpen" }>,
    topOrigin: string,
  ): Promise<void> {
    await this.startOpen(tabId, topOrigin, req.rect, req.inputKind, false, true);
  }

  /**
   * 统一入口:
   *   - 重置 state
   *   - 查 ciphers, 按 kind 过滤
   *   - 缓存 + push 到 list port(若已连)
   *   - 若是 sub-frame 触发(needsRemoteOpen=true): 派 remoteOpen 给顶层 frame
   *     让它的 controller 用绝对 rect 调 injector.openList
   */
  private async startOpen(
    tabId: number,
    origin: string,
    rect: InlineMenuFieldRect,
    inputKind: InlineMenuInputKind,
    focusList: boolean,
    needsRemoteOpen: boolean,
  ): Promise<void> {
    const state = this.ensureTabState(tabId);
    state.origin = origin;
    state.rect = rect;
    state.portKey = randomPortKey();
    state.pendingFocus = focusList;
    state.ciphers = null;
    state.inputKind = inputKind;

    // 通知 content 已建立的 list port(若有) 重新 init —— portKey 已轮换。
    this.pushInit(tabId);
    if (state.rect) this.pushPosition(tabId, state.rect);

    // 查 ciphers —— 失败时仍发空 list, iframe 渲染"没有匹配项"。
    let payload: InlineMenuCiphersPayload;
    try {
      const result = await this.native.queryLogins({
        origin,
        url: origin,
      });
      payload = this.toCiphersPayload(result);
      // TOTP 模式 —— 只展示带 OTP 秘钥的条目, 否则用户点了也无法生成 code。
      if (state.inputKind === "totp") {
        payload = { ...payload, items: payload.items.filter((i) => i.hasTotp) };
      }
    } catch {
      // desktop 离线 / vault 未解锁 / 网络错误 —— 当作空 list 处理,
      // iframe 仍渲染"没有匹配项"或"已锁定"占位。
      payload = {
        unlocked: false,
        origin,
        items: [],
      };
    }
    state.ciphers = payload;

    // sub-frame 触发的 open 路径:浮层必须挂在顶层 frame。给顶层 frame
    // 发 remoteOpen, 让它的 controller 用 injector 挂浮层 + 启动 iframe
    // 来 connect 本 background port 接 ciphers。
    if (needsRemoteOpen) {
      try {
        await browser.tabs.sendMessage(
          tabId,
          {
            type: "zpass.inlineMenu.remoteOpen",
            rect,
            inputKind,
          },
          { frameId: 0 },
        );
      } catch {
        // 顶层 frame 没接听 —— 极少见(扩展失效中), 静默。
      }
    }

    this.pushCiphers(tabId, payload);
    this.pushFadeIn(tabId);
  }

  /** content → background:close inline menu。 */
  handleClose(tabId: number): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    if (state.listPort) {
      this.send(state.listPort, {
        source: "zpass-inline-menu",
        portKey: state.portKey,
        command: InlineMenuBackgroundCommand.Close,
      });
      try {
        state.listPort.disconnect();
      } catch {
        // ignore
      }
      state.listPort = null;
    }
    state.ciphers = null;
    state.rect = null;
    // 同时广播给所有 frame 的 controller, 让顶层 frame 把 injector 拆掉。
    // sub-frame 触发的 close(用户在 sub-frame 内打字/blur) 必须经此路径
    // 才能拆掉顶层 frame 的浮层 DOM。
    void browser.tabs
      .sendMessage(tabId, { type: "zpass.inlineMenu.close" })
      .catch(() => {});
  }

  /** content → background:viewport 变了, 重定位浮层。 */
  handleUpdatePosition(
    tabId: number,
    req: Extract<
      InlineMenuExtensionRequest,
      { type: "zpass.inlineMenu.updatePosition" }
    >,
  ): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    state.rect = req.rect;
    this.pushPosition(tabId, req.rect);
  }

  /** tab 关闭 → 清理状态。background.ts 的 tabs.onRemoved 调。 */
  forgetTab(tabId: number): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    if (state.listPort) {
      try {
        state.listPort.disconnect();
      } catch {
        // ignore
      }
    }
    this.tabs.delete(tabId);
  }

  // ==================================================================
  // 内部:状态
  // ==================================================================

  private ensureTabState(tabId: number): TabState {
    let state = this.tabs.get(tabId);
    if (!state) {
      state = {
        listPort: null,
        portKey: randomPortKey(),
        origin: "",
        rect: null,
        ciphers: null,
        pendingFocus: false,
        inputKind: "login",
      };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  private toCiphersPayload(
    result: QueryLoginsResult,
  ): InlineMenuCiphersPayload {
    return {
      unlocked: result.unlocked,
      origin: result.origin,
      items: result.items.map((item) => ({
        itemId: item.id,
        name: item.name,
        username: item.username,
        hasTotp: item.hasTotp,
      })),
    };
  }

  // ==================================================================
  // 内部:推送到 list iframe
  // ==================================================================

  private pushInit(tabId: number): void {
    const state = this.tabs.get(tabId);
    if (!state || !state.listPort) return;
    const init: InlineMenuInitPayload = {
      portKey: state.portKey,
      origin: state.origin,
      theme: "auto",
      translations: TRANSLATIONS,
    };
    this.send(state.listPort, {
      source: "zpass-inline-menu",
      portKey: state.portKey,
      command: InlineMenuBackgroundCommand.Init,
      payload: init,
    });
  }

  private pushCiphers(tabId: number, payload: InlineMenuCiphersPayload): void {
    const state = this.tabs.get(tabId);
    if (!state || !state.listPort) return;
    this.send(state.listPort, {
      source: "zpass-inline-menu",
      portKey: state.portKey,
      command: InlineMenuBackgroundCommand.UpdateCiphers,
      payload,
    });
  }

  private pushPosition(tabId: number, rect: InlineMenuFieldRect): void {
    const state = this.tabs.get(tabId);
    if (!state || !state.listPort) return;
    this.send(state.listPort, {
      source: "zpass-inline-menu",
      portKey: state.portKey,
      command: InlineMenuBackgroundCommand.UpdatePosition,
      rect,
    });
  }

  private pushFadeIn(tabId: number): void {
    const state = this.tabs.get(tabId);
    if (!state || !state.listPort) return;
    this.send(state.listPort, {
      source: "zpass-inline-menu",
      portKey: state.portKey,
      command: InlineMenuBackgroundCommand.FadeIn,
    });
  }

  private send(port: Browser.runtime.Port, message: InlineMenuIframeMessage): void {
    try {
      port.postMessage(message);
    } catch {
      // 端口可能已断, 静默。
    }
  }

  // ==================================================================
  // 内部:list iframe 上行
  // ==================================================================

  private async handlePortMessage(tabId: number, raw: unknown): Promise<void> {
    const message = raw as InlineMenuIframeMessage | undefined;
    if (!message || typeof message !== "object") return;
    const state = this.tabs.get(tabId);
    if (!state) return;
    // portKey 校验 —— list iframe 在每个上行消息里都必须带回 background 发的 token。
    if (message.portKey !== state.portKey) return;
    switch (message.command) {
      case InlineMenuListCommand.Ready:
        // iframe 已渲染好首屏 —— 缓存的 ciphers 一定已经发过, 这里不重复。
        return;
      case InlineMenuListCommand.FillSelected:
        await this.fillSelected(tabId, message);
        return;
      case InlineMenuListCommand.Close:
        this.handleClose(tabId);
        return;
      case InlineMenuListCommand.Unlock:
        // 用户点了"打开 ZPass" —— 拉起 desktop, list 自身保留显示, 等用户解锁。
        try {
          await this.native.launchDesktop();
        } catch {
          // 静默, list iframe 会在下一次 ciphers 推送时看到 unlocked。
        }
        return;
      default:
        return;
    }
  }

  private async fillSelected(
    tabId: number,
    message: InlineMenuIframeMessage,
  ): Promise<void> {
    const itemId = typeof message.itemId === "string" ? message.itemId : "";
    if (!itemId) return;
    const state = this.tabs.get(tabId);
    if (!state || !state.origin) return;

    if (state.inputKind === "totp") {
      await this.fillTotpOnly(tabId, state.origin, itemId);
    } else {
      await this.fillLogin(tabId, state.origin, itemId);
    }

    // handleClose 内部会广播 zpass.inlineMenu.close 给所有 frame, 让顶层
    // frame 的 controller 拆 injector + 各 frame 清焦点状态; 这里不再重复广播。
    this.handleClose(tabId);
  }

  /** login 模式:revealLogin → 广播 zpass.fillLogin 让 content 填账密。 */
  private async fillLogin(
    tabId: number,
    origin: string,
    itemId: string,
  ): Promise<void> {
    let secret: LoginSecret;
    try {
      secret = await this.native.revealLogin({ origin, url: origin, itemId });
    } catch {
      return;
    }
    // 账密全空才放弃;空密码条目仍可在 identifier-first 页(如 Google 第一步,
    // 只有 email 框无 password 框)填用户名。fillLoginForm 对空 password 有守卫,
    // 不会去清空表单,所以放行只填 username 的条目是安全的。
    if (!secret.password && !secret.username) return;
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "zpass.fillLogin",
        secret,
      });
    } catch {
      // content listener 不在 —— 极少见, 静默。
    }
  }

  /**
   * totp 模式:generateLoginTotp 拿当前 OTP code, 广播 zpass.fillTotpOnly
   * 让 content 找当前 OTP input 填入。不动 username / password。
   */
  private async fillTotpOnly(
    tabId: number,
    origin: string,
    itemId: string,
  ): Promise<void> {
    let code: string;
    try {
      const result = await this.native.generateLoginTotp({
        origin,
        url: origin,
        itemId,
      });
      code = result.code ?? "";
    } catch {
      return;
    }
    if (!code) return;
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "zpass.fillTotpOnly",
        code,
      });
    } catch {
      // 静默。
    }
  }
}

/**
 * background 一键判定:消息是否属于 inline menu 通道。
 * 配合 background.ts 的 handleMessage 分流。
 */
export function isInlineMenuRequest(
  message: unknown,
): message is InlineMenuExtensionRequest {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;
  if (typeof type !== "string") return false;
  return type.startsWith("zpass.inlineMenu.");
}

/** 给 background.ts 用的辅助:取 sender tabId, 取不到返 -1。 */
export function senderTabId(
  sender: Browser.runtime.MessageSender | undefined,
): number {
  const id = sender?.tab?.id;
  return typeof id === "number" ? id : -1;
}

/** 复用现有 origin 解析(避开下游 import cycle)。 */
export function senderOrigin(
  sender: Browser.runtime.MessageSender | undefined,
): string {
  const url = sender?.url ?? sender?.tab?.url ?? "";
  return getHttpOrigin(url) ?? "";
}
