// 极简 DOM 助手与 a11y 工具
//
// 设计目标：避免在业务代码中堆砌 `innerHTML` + `querySelector` 链；
// 提供 focus trap 与 reduced-motion 检测，让弹层组件键盘可用。

export interface ElProps {
  /** CSS class 字符串 */
  class?: string;
  /** 纯文本内容（与 html 互斥；XSS 安全） */
  text?: string;
  /** HTML 字符串（仅用于受信内容，例如内置 SVG） */
  html?: string;
  /** HTML 属性键值对 */
  attrs?: Record<string, string>;
  /** 子节点列表，null/undefined/false 会被忽略，便于条件渲染 */
  children?: (Node | string | null | undefined | false)[];
  /** 事件监听键值对 */
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
}

/** 简洁 DOM 构造工具（替代 innerHTML 拼接 + querySelector 链） */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      node.setAttribute(key, value);
    }
  }
  if (props.children) {
    for (const child of props.children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child as Node | string);
    }
  }
  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) {
      if (handler) node.addEventListener(type, handler as EventListener);
    }
  }
  return node;
}

/** 检测用户是否启用「减少动效」系统偏好 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * 在容器内安装 focus trap：
 * - Tab / Shift+Tab 在容器内循环
 * - Escape 触发 onEscape 回调（用于关闭弹层）
 * - 自动聚焦第一个可聚焦元素
 *
 * 返回 release 函数：调用后解绑事件并把焦点还给打开弹层前的元素。
 */
export function trapFocus(
  container: HTMLElement,
  onEscape?: () => void,
): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const getFocusables = (): HTMLElement[] => {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((node) => !node.hasAttribute("hidden"));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      onEscape?.();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = getFocusables();
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", onKeyDown, true);
  // 自动聚焦：用 microtask 确保子节点已 paint
  window.setTimeout(() => {
    const focusables = getFocusables();
    focusables[0]?.focus();
  }, 0);

  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    previouslyFocused?.focus?.();
  };
}
