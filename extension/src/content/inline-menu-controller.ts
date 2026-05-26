// 内联菜单事件控制器(per-frame)。
//
// 架构形状参考 Bitwarden 浏览器扩展(GPL-3.0, bitwarden/clients,
// apps/browser/src/autofill/services/autofill-overlay-content.service.ts):
//
//   - 对 login 候选 input 绑 focus/click/blur/input/keyup
//   - focus/click → 本地 injector.openList(rect) + 上报 background "open"
//   - 滚动/缩放 → 本地 injector.updatePosition + 上报 background "updatePosition"
//   - blur 短延时 → 本地 injector.closeList + 上报 background "close"
//   - input → 本地 closeList(用户开始打字时让出列表)
//   - Escape → 同 close
//   - ArrowDown → 重新 open + 让 background 标 focusList
//
// background 那边只负责按 origin 拉 ciphers + 经 iframe port 推送, 不再
// 决定 DOM 何时挂卸 —— 顶层 frame 内自己定。
//
// 干净室实现, 未复制 Bitwarden 源码。

import { isLoginCandidate, findLoginFormForInput } from "./forms";
import { isTotpCandidate, isTotpField } from "./totp-fields";
import { isTrustedEvent } from "../shared/event-security";
import { InlineMenuInjector } from "./inline-menu-injector";
import {
  MAX_SUB_FRAME_DEPTH,
  type InlineMenuFieldRect,
  type InlineMenuInputKind,
  type InlineMenuPostMessageEnvelope,
  type InlineMenuRemoteOpenRequest,
} from "../shared/inline-menu-enums";
import { getHttpOrigin } from "../shared/messages";

/**
 * 判定 input 的 inline-menu 触发性质。
 *   - TOTP 字段优先级最高(命中 isTotpField 直接返 totp)
 *   - 普通 login 候选返 login
 *   - 其他返 null —— 不弹菜单
 */
function inputKindFor(
  input: HTMLInputElement,
): InlineMenuInputKind | null {
  if (isTotpCandidate(input)) return "totp";
  if (isLoginCandidate(input)) return "login";
  return null;
}

const FOCUS_DEBOUNCE_MS = 50;
const BLUR_CLOSE_DELAY_MS = 120;

/**
 * Inline menu controller。
 *
 * 顶层 frame 实例化时同时传入 injector(顶层 frame 才有 popover);
 * sub-frame 传 null injector —— 子 frame 仅做事件采集 + 上报 background,
 * 实际浮层在顶层 frame 由该 frame 的 injector 处理(本期未实现子 frame
 * 偏移传递, 子 frame 上报会被 background 用 sender.frameId 区分但不绘)。
 */
export class InlineMenuController {
  private focusedInput: HTMLInputElement | null = null;
  private focusedKind: InlineMenuInputKind | null = null;
  private blurCloseTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private lastOpenAt = 0;
  private destroyed = false;

  constructor(private readonly injector: InlineMenuInjector | null) {}

  init(): void {
    if (this.destroyed) return;
    // background 完成 fill / 主动要求关闭时, 广播 zpass.inlineMenu.close
    // 给所有 frame 的 content; 我们这里收到就拆 iframe + 清焦点。与
    // zpass.fillLogin 的 listener 共存(那条由 content.ts 注册, 负责真正
    // 写入 DOM)。
    browser.runtime.onMessage.addListener((message: unknown) => {
      const msg = message as { type?: string } | null;
      if (!msg) return undefined;

      // background → 所有 frame: 关闭浮层。fillSelected / blur / 等触发。
      if (msg.type === "zpass.inlineMenu.close") {
        this.injector?.closeList();
        this.clearBlurCloseTimer();
        this.focusedInput = null;
        this.focusedKind = null;
        return undefined;
      }

      // background → 顶层 frame: sub-frame offset 协议完成后, 用绝对
      // (顶层 viewport) 坐标挂浮层。
      if (msg.type === "zpass.inlineMenu.remoteOpen") {
        if (!this.injector) {
          // sub-frame 不参与: 浮层只能在顶层 frame。
          return undefined;
        }
        const remote = msg as InlineMenuRemoteOpenRequest;
        if (!remote.rect) return undefined;
        const opened = this.injector.openList(remote.rect);
        if (opened) {
          // sub-frame 触发的浮层 —— focusedInput 不属于本 frame,
          // 但记下 inputKind 让后续键盘事件(如本 frame 无关 input
          // 上的 ArrowDown) 能拿到正确 kind。focusedInput 保持 null,
          // close 由 sub-frame 那边的事件经 background 广播触发。
          this.focusedKind = remote.inputKind ?? "login";
        }
        return undefined;
      }

      return undefined;
    });
    document.addEventListener("focusin", this.handleFocusIn, true);
    document.addEventListener("focusout", this.handleFocusOut, true);
    document.addEventListener("click", this.handleClick, true);
    document.addEventListener("input", this.handleInput, true);
    document.addEventListener("keydown", this.handleKeyDown, true);
    window.addEventListener("blur", this.handleWindowBlur, true);
    window.addEventListener("scroll", this.handleViewportChange, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", this.handleViewportChange, true);
  }

  destroy(): void {
    this.destroyed = true;
    document.removeEventListener("focusin", this.handleFocusIn, true);
    document.removeEventListener("focusout", this.handleFocusOut, true);
    document.removeEventListener("click", this.handleClick, true);
    document.removeEventListener("input", this.handleInput, true);
    document.removeEventListener("keydown", this.handleKeyDown, true);
    window.removeEventListener("blur", this.handleWindowBlur, true);
    window.removeEventListener("scroll", this.handleViewportChange, true);
    window.removeEventListener("resize", this.handleViewportChange, true);
    this.clearBlurCloseTimer();
    this.injector?.destroy();
    this.focusedInput = null;
  }

  // ==================================================================
  // 事件入口
  // ==================================================================

  private handleFocusIn = (event: Event): void => {
    if (!isTrustedEvent(event)) {
      // 合成事件 —— 静默(高频)。
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const kind = inputKindFor(target);
    if (kind === null) return;
    this.focusedInput = target;
    this.focusedKind = kind;
    this.clearBlurCloseTimer();
    globalThis.setTimeout(() => {
      if (this.focusedInput === target) this.requestOpen(target, kind);
    }, FOCUS_DEBOUNCE_MS);
  };

  private handleClick = (event: Event): void => {
    if (!isTrustedEvent(event)) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const kind = inputKindFor(target);
    if (kind === null) return;
    this.focusedInput = target;
    this.focusedKind = kind;
    this.clearBlurCloseTimer();
    this.requestOpen(target, kind);
  };

  private handleFocusOut = (event: Event): void => {
    if (!isTrustedEvent(event)) return;
    const target = event.target;
    if (target !== this.focusedInput) return;
    // 焦点的去向:
    //   - 落在自家 overlay shell(用户点击/Tab 进列表) → 不关菜单
    //   - 落在其他 input(同 frame 内切换) → 由后续 focusin 的 clearBlurCloseTimer 取消关闭
    //   - 落在页面其他地方 / 离开页面 → 120ms 后关
    const focusEvent = event as FocusEvent;
    const nextFocus = focusEvent.relatedTarget;
    if (this.injector?.ownsElement(nextFocus)) {
      return;
    }
    this.scheduleBlurClose();
  };

  private handleInput = (event: Event): void => {
    if (!isTrustedEvent(event)) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target !== this.focusedInput) return;
    // 用户开始打字 → 关菜单, 让出键盘。
    this.injector?.closeList();
    void this.notify({ type: "zpass.inlineMenu.close", reason: "input" });
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!isTrustedEvent(event)) return;
    if (this.focusedInput === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.injector?.closeList();
      void this.notify({ type: "zpass.inlineMenu.close", reason: "escape" });
      return;
    }
    if (event.key === "ArrowDown") {
      // 让 iframe 自己抢焦点 —— controller 只负责打开 + 标 focusList。
      event.preventDefault();
      event.stopPropagation();
      this.requestOpen(
        this.focusedInput,
        this.focusedKind ?? "login",
        true,
      );
    }
  };

  private handleWindowBlur = (): void => {
    if (this.focusedInput === null) return;
    this.scheduleBlurClose();
  };

  private handleViewportChange = (): void => {
    if (this.focusedInput === null || !this.injector?.isListOpen()) return;
    const rect = this.measureRect(this.focusedInput);
    if (!rect) return;
    this.injector.updatePosition(rect);
    const origin = currentOrigin();
    if (!origin) return;
    void this.notify({
      type: "zpass.inlineMenu.updatePosition",
      origin,
      rect,
    });
  };

  // ==================================================================
  // 调度
  // ==================================================================

  private requestOpen(
    input: HTMLInputElement,
    kind: InlineMenuInputKind,
    focusList = false,
  ): void {
    const now = Date.now();
    if (now - this.lastOpenAt < 30 && !focusList) return;
    this.lastOpenAt = now;

    // login 模式仍要求归属于一个 login form(防止在搜索框等输入框误弹);
    // totp 模式只要是被 isTotpCandidate 识别的 OTP input 即可, 不强求
    // 同 form 内有 password(常见站点 2FA 单独一页, 只有 OTP input)。
    if (kind === "login") {
      const form = findLoginFormForInput(input);
      if (!form) return;
    }
    const rect = this.measureRect(input);
    if (!rect) return;

    if (this.injector) {
      // 顶层 frame —— rect 已是顶层 viewport 坐标, 直接挂浮层。
      const origin = currentOrigin();
      if (!origin) return;
      const opened = this.injector.openList(rect);
      if (!opened) return;
      void this.notify({
        type: "zpass.inlineMenu.open",
        origin,
        rect,
        inputKind: kind,
        ...(focusList ? { focusList: true } : {}),
      });
      return;
    }

    // sub-frame —— 浮层不能在本 frame 挂(会被父页 iframe 元素物理裁切),
    // 走 postMessage 累加链让 parent 一路向上累加 iframe 偏移,
    // 顶层 frame 用 absoluteRect 调 sendMessage subFrameOpen。
    //
    // 这里**不**调 notify("open") —— background 等顶层 frame 自报。
    const envelope: InlineMenuPostMessageEnvelope = {
      source: "zpass-inline-menu",
      command: "calc-sub-frame-positioning",
      payload: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        inputKind: kind,
        depth: 0,
      },
    };
    try {
      window.parent.postMessage(envelope, "*");
    } catch {
      // 极端情况下 parent 受 sandbox 限制 —— 静默放弃, 用户走 popup 兜底。
    }
  }

  private scheduleBlurClose(): void {
    this.clearBlurCloseTimer();
    this.blurCloseTimer = globalThis.setTimeout(() => {
      this.blurCloseTimer = null;
      this.injector?.closeList();
      void this.notify({
        type: "zpass.inlineMenu.close",
        reason: "blur",
      });
      this.focusedInput = null;
      this.focusedKind = null;
    }, BLUR_CLOSE_DELAY_MS);
  }

  private clearBlurCloseTimer(): void {
    if (this.blurCloseTimer !== null) {
      globalThis.clearTimeout(this.blurCloseTimer);
      this.blurCloseTimer = null;
    }
  }

  private measureRect(input: HTMLInputElement): InlineMenuFieldRect | null {
    const r = input.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      top: r.top,
      left: r.left,
      width: r.width,
      height: r.height,
    };
  }

  private async notify(message: unknown): Promise<void> {
    try {
      await browser.runtime.sendMessage(message);
    } catch {
      // SW unloaded / 扩展失效 —— 静默, watchdog 处理。
    }
  }
}

function currentOrigin(): string | null {
  if (typeof location === "undefined" || !location.href) return null;
  return getHttpOrigin(location.href);
}
