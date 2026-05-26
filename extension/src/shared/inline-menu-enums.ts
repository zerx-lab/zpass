// 内联自动填充菜单的端口名与元素名常量。
//
// 架构参考 Bitwarden 开源浏览器扩展（GPL-3.0,bitwarden/clients,
// apps/browser/src/autofill/enums/autofill-overlay.enum.ts）。
// 端口名与角色枚举是公共 API 形状,这里独立命名以归 ZPass 命名空间所有。
// 实现代码全部按 ZPass 工程风格干净室复刻,未复制源码片段。

/** 内联菜单的两类 overlay 元素 —— 一个按钮一个列表(本期先实现列表)。 */
export const InlineMenuOverlayElement = {
  Button: "zpass-inline-menu-button",
  List: "zpass-inline-menu-list",
} as const;
export type InlineMenuOverlayElementType =
  (typeof InlineMenuOverlayElement)[keyof typeof InlineMenuOverlayElement];

/**
 * runtime.connect 通道命名。
 *
 * - `List` / `Button`:iframe 内向 background 建立的长连接,用于推送 ciphers、
 *   位置、主题、关闭信号。
 * - `*MessageConnector`:content 主世界向 background 的辅助端口(本期未启用,
 *   保留命名以与 Bitwarden 对齐, 便于后续 sub-frame 拓展)。
 */
export const InlineMenuPort = {
  List: "zpass-inline-menu-list-port",
  Button: "zpass-inline-menu-button-port",
  ListMessageConnector: "zpass-inline-menu-list-message-connector",
  ButtonMessageConnector: "zpass-inline-menu-button-message-connector",
} as const;
export type InlineMenuPortType =
  (typeof InlineMenuPort)[keyof typeof InlineMenuPort];

/** ArrowDown 进入列表后,焦点导出时的方向。 */
export const RedirectFocusDirection = {
  Current: "current",
  Previous: "previous",
  Next: "next",
} as const;
export type RedirectFocusDirectionType =
  (typeof RedirectFocusDirection)[keyof typeof RedirectFocusDirection];

/**
 * 内联菜单位置数据 —— content 测量后传给 background,background 计算后
 * 经端口下发给 iframe 渲染。坐标系是 viewport 像素。
 */
export interface InlineMenuFieldRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** iframe ↔ content postMessage 协议。 */
export interface InlineMenuIframeMessage {
  source: "zpass-inline-menu";
  portKey: string;
  command: string;
  [key: string]: unknown;
}

/**
 * background 向 list iframe 推送的"初始化"payload。
 */
export interface InlineMenuInitPayload {
  portKey: string;
  origin: string;
  /** 推荐 UI 主题,本期固定 "auto" 走 prefers-color-scheme。 */
  theme: "auto" | "light" | "dark";
  /** 给 iframe 的本地化字符串。无后端 i18n,固定中文。 */
  translations: {
    title: string;
    emptyTitle: string;
    emptyDescription: string;
    lockedTitle: string;
    lockedDescription: string;
    unlockCta: string;
  };
}

/** background → iframe 推送的 ciphers 列表条目。与 LoginSummary 同构,精简版。 */
export interface InlineMenuCipherSummary {
  itemId: string;
  name: string;
  username: string;
  /** 是否带 TOTP,UI 用于条目右上小标。 */
  hasTotp: boolean;
}

/**
 * background → iframe 推送的完整 ciphers payload。
 */
export interface InlineMenuCiphersPayload {
  /** vault 是否已解锁。锁定时 iframe 仅渲染解锁提示。 */
  unlocked: boolean;
  /** 当前 tab origin。仅展示用,不参与判定。 */
  origin: string;
  /** 匹配条目列表。未解锁时为空。 */
  items: InlineMenuCipherSummary[];
}

/** iframe → background 上行命令。 */
export const InlineMenuListCommand = {
  Ready: "ready",
  FillSelected: "fillSelected",
  Unlock: "unlock",
  Close: "close",
} as const;
export type InlineMenuListCommandType =
  (typeof InlineMenuListCommand)[keyof typeof InlineMenuListCommand];

/** background → iframe 下行命令。 */
export const InlineMenuBackgroundCommand = {
  Init: "init",
  UpdateCiphers: "updateCiphers",
  UpdatePosition: "updatePosition",
  FadeIn: "fadeIn",
  Close: "close",
} as const;
export type InlineMenuBackgroundCommandType =
  (typeof InlineMenuBackgroundCommand)[keyof typeof InlineMenuBackgroundCommand];

/**
 * content → background 的扩展消息(走 browser.runtime.sendMessage,
 * 与现有 zpass.* 消息共享通道)。
 *
 * 之所以与 list iframe 的 port 通道分开:
 *   - content 主世界只关心"何时该打开/关闭/重定位",轻量请求即可
 *   - iframe 端需要双向 streaming(ciphers/position/theme/close 都靠 port 推)
 */
/**
 * 触发菜单的 input 性质:
 *   - "login":  username / password 字段, 列表展示全部凭据, 点击填账密
 *   - "totp":   one-time-code 字段, 列表只展示 hasTotp=true 凭据,
 *               点击只填当前 OTP code 到 input
 */
export type InlineMenuInputKind = "login" | "totp";

export type InlineMenuExtensionRequest =
  | {
      type: "zpass.inlineMenu.open";
      origin: string;
      rect: InlineMenuFieldRect;
      inputKind: InlineMenuInputKind;
      /** 是否同时聚焦列表(ArrowDown 触发)。 */
      focusList?: boolean;
    }
  | {
      /**
       * sub-frame 触发: rect 已经过 parent frame 链通过 window.postMessage
       * + `event.source === iframe.contentWindow` 精确匹配累加, 是顶层
       * frame viewport 的绝对坐标。background 拿到后跟 "open" 同流程
       * (query ciphers → push remoteOpen 给顶层 frame 让它挂浮层)。
       */
      type: "zpass.inlineMenu.subFrameOpen";
      rect: InlineMenuFieldRect;
      inputKind: InlineMenuInputKind;
    }
  | {
      type: "zpass.inlineMenu.close";
      reason: "blur" | "escape" | "url-change" | "input" | "page-risk";
    }
  | {
      type: "zpass.inlineMenu.updatePosition";
      origin: string;
      rect: InlineMenuFieldRect;
    };

/**
 * sub-frame → parent frame 的 window.postMessage 偏移累加协议数据。
 *
 * 每一级 parent 收到后:
 *   1. 用 `event.source === iframe.contentWindow` 严格匹配自家 iframe
 *   2. 累加 iframe.getBoundingClientRect() + padding/border 到 top/left
 *   3. 如果自己是顶层 frame → 通过 browser.runtime.sendMessage 上报
 *      background "subFrameOpen" 完成流程
 *   4. 否则继续 `window.parent.postMessage` 给自己的 parent
 *
 * 这是 Bitwarden 主路径同款思路: contentWindow 引用比较是唯一能在
 * cross-origin 场景下精确定位 iframe 元素的方式; URL 匹配在多 iframe
 * 共享 src 时会错配 → 浮层弹位置不对。
 */
export interface InlineMenuPostMessageEnvelope {
  source: "zpass-inline-menu";
  command: "calc-sub-frame-positioning";
  payload: {
    /** anchor 内坐标 (从最初的 sub-frame 出发, 经各级累加)。 */
    top: number;
    left: number;
    /** input 自身宽高, 累加过程中不变, 仅顶层上报时使用。 */
    width: number;
    height: number;
    /** input 性质, 顶层上报时透给 background。 */
    inputKind: InlineMenuInputKind;
    /** 累加深度计数, 防御无限循环 / 过深嵌套。 */
    depth: number;
  };
}

/** 最大 frame 嵌套深度。超过即放弃, 避免恶意页用嵌套 iframe 致死循环。 */
export const MAX_SUB_FRAME_DEPTH = 8;

/**
 * sub-frame offset 协议消息。background → 各 frame 内容脚本。
 *
 * 阿里云等站点把登录表单嵌在 cross-origin iframe 里(如 alibaba-login-iframe),
 * iframe element 的高度被父页限定 → sub-frame 内 viewport 容不下浮层 →
 * 浮层挂在 sub-frame body 会被父页 iframe 元素物理裁剪。
 *
 * 解决:浮层唯一挂在顶层 frame body, 用累加偏移把 sub-frame 内 rect 翻译成
 * 顶层 frame viewport 坐标。
 */
export interface InlineMenuMeasureChildIframeRequest {
  type: "zpass.inlineMenu.measureChildIframe";
  /** 待测量子 frame 的 URL —— 用于在自家 document 里匹配 iframe.src。 */
  childUrl: string;
}

/**
 * background → 顶层 frame: 用绝对(顶层 viewport)坐标挂浮层。
 *
 * sub-frame 触发的 open 流程的最后一步, 由 background 累加偏移完成后派发。
 */
export interface InlineMenuRemoteOpenRequest {
  type: "zpass.inlineMenu.remoteOpen";
  rect: InlineMenuFieldRect;
  inputKind: InlineMenuInputKind;
}

/** 列表 iframe 注册的 HTML 文件名,WXT 生成的 dist 路径。 */
export const INLINE_MENU_LIST_HTML = "inline-menu-list.html";
