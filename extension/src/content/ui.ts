import type { LoginSummary, PasskeyDescriptor } from "../shared/messages";
import { keyIcon, zMatrixIcon } from "../shared/icons";
import { el, trapFocus } from "../shared/dom";
import "./ui.css";

/**
 * 时钟 / 定时器图标 — 与 shared/icons.ts 同风格（stroke 1.75 lucide 风）。
 * 放在这里不放 shared：仅 inline menu 的 TOTP 模式用。
 */
function clockIcon(size = 15): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
}

/* ============================================================================
 * Content Script 内浮层 UI
 * ----------------------------------------------------------------------------
 * 与旧实现的关键差异：
 *   - 浮动按钮换成 5×5 点阵 Z（与 desktop logo 同源），不再是 Z 字
 *   - 凭据菜单支持 ArrowUp/ArrowDown 键盘导航 + Enter 确认 + Escape 关闭
 *   - 菜单滚动 / 视口尺寸变化时自动重新定位，并在下方空间不足时翻转到上方
 *   - Passkey 对话框安装 focus trap，按钮使用 accent 品牌色，替换为 danger 红
 *   - Toast 加 role=status + aria-live，屏幕阅读器可读
 *   - 菜单关闭时通过 __cleanup 机制完整解绑滚动 / 键盘事件，杜绝泄漏
 * ========================================================================== */

export interface PasskeyCreatePromptInfo {
  rpId: string;
  rpName?: string;
  userName?: string;
  userDisplayName?: string;
}

export type PasskeyRegistrationAction = "create" | "replace" | "cancel";

interface CleanupHost extends HTMLElement {
  __cleanup?: () => void;
}

/** 创建浮动填充按钮（点阵 Z 图标） */
export function createAutofillButton(): HTMLButtonElement {
  const button = el("button", {
    class: "zpass-fill-button",
    attrs: {
      type: "button",
      title: "使用 ZPass 填充",
      "aria-label": "使用 ZPass 填充",
    },
    html: zMatrixIcon({ size: 14 }),
  });
  return button;
}

/**
 * 在 anchor 下方弹出凭据菜单。
 *
 * mode 控制副标题 + 动作指示：
 *   - "login"（默认）：显示 username/account，走账密填充路径
 *   - "totp"：动作提示「填充验证码」，选择后去 generateLoginTotp
 *
 * 行布局（与 Bitwarden popup 风格对齐）：
 *   [图标]  条目名                            · 右边预留指示区
 *           username/account
 *
 * 图标选择：
 *   - itemType="totp" → 时钟图标（「独立身份验证器」）
 *   - 其他 → 钥匙图标
 *
 * onSelect 由调用方插入不同后续动作。
 */
export function showCredentialMenu(
  anchor: HTMLElement,
  items: LoginSummary[],
  onSelect: (item: LoginSummary) => Promise<void>,
  mode: "login" | "totp" = "login",
): void {
  closeMenus();

  const menu = el("div", {
    class: "zpass-menu",
    attrs: { role: "menu", "data-mode": mode },
  }) as CleanupHost;

  items.forEach((item) => {
    const iconHtml = item.itemType === "totp" ? clockIcon(16) : keyIcon(16);
    const meta = item.username || item.displayUrl;
    const option = el("button", {
      class: "zpass-menu-item",
      attrs: { type: "button", role: "menuitem" },
      children: [
        el("span", { class: "zpass-menu-item-icon", html: iconHtml }),
        el("span", {
          class: "zpass-menu-item-body",
          children: [
            el("strong", { text: item.name || item.displayUrl }),
            el("span", {
              class: "zpass-menu-item-sub",
              text: meta,
            }),
          ],
        }),
        // 右侧动作标签：TOTP 模式下提示「验证码」；login 模式下隐藏
        mode === "totp"
          ? el("span", { class: "zpass-menu-item-action", text: "验证码" })
          : null,
      ],
    });
    option.addEventListener("click", () => {
      closeMenus();
      void onSelect(item);
    });
    // 阻止 mousedown 抢焦点，保持原 input 焦点
    option.addEventListener("mousedown", (event) => event.preventDefault());
    menu.append(option);
  });

  document.documentElement.append(menu);
  positionFloating(menu, anchor, 280);

  // ====== 键盘导航 ======
  const handleKey = (event: KeyboardEvent) => {
    const options = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(".zpass-menu-item"),
    );
    const focusedIndex = options.findIndex(
      (opt) => opt === document.activeElement,
    );
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenus();
      anchor.focus?.();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      options[(focusedIndex + 1 + options.length) % options.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      options[(focusedIndex - 1 + options.length) % options.length]?.focus();
    } else if (event.key === "Enter" && focusedIndex >= 0) {
      options[focusedIndex]?.click();
    }
  };

  // ====== 点击外部关闭 ======
  const onOutside = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node) && event.target !== anchor) {
      closeMenus();
    }
  };

  // ====== 滚动/尺寸变化重新定位 ======
  const reposition = () => positionFloating(menu, anchor, 280);

  document.addEventListener("keydown", handleKey, true);
  window.addEventListener("scroll", reposition, {
    passive: true,
    capture: true,
  });
  window.addEventListener("resize", reposition, { passive: true });
  // 延迟挂载点击外部监听，避免与触发按钮的当前 click 冲突
  window.setTimeout(
    () => document.addEventListener("mousedown", onOutside, true),
    0,
  );

  menu.__cleanup = () => {
    document.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
  };
}

/** 外部 API：关闭所有 zpass 浮层 */
export function closeCredentialMenus(): void {
  closeMenus();
}

/** 在 anchor 下方显示短暂提示气泡（2.6s 自动消失） */
export function showTransientNotice(
  anchor: HTMLElement,
  message: string,
): void {
  closeMenus();
  const notice = el("div", {
    class: "zpass-notice",
    attrs: { role: "status", "aria-live": "polite" },
    text: message,
  });
  document.documentElement.append(notice);
  positionFloating(notice, anchor, 280);
  window.setTimeout(() => notice.remove(), 2600);
}

/** 右上角持久通知（4.2s） */
export function showPageToast(title: string, message: string): void {
  document.querySelectorAll(".zpass-toast").forEach((node) => node.remove());
  const toast = el("div", {
    class: "zpass-toast",
    attrs: { role: "status", "aria-live": "polite" },
    children: [el("strong", { text: title }), el("span", { text: message })],
  });
  document.documentElement.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

/** Passkey 创建确认对话框（含「替换现有」分支） */
export function confirmPasskeyCreate(
  info: PasskeyCreatePromptInfo,
  existing: PasskeyDescriptor[] = [],
): Promise<PasskeyRegistrationAction> {
  return new Promise((resolve) => {
    const hasDuplicate = existing.length > 0;

    const dialog = el("section", {
      class: "zpass-passkey-dialog",
      attrs: {
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "zpass-passkey-title",
      },
      children: [
        el("div", {
          children: [
            el("h2", {
              attrs: { id: "zpass-passkey-title" },
              text: hasDuplicate
                ? "已存在此账户的 Passkey"
                : "保存 Passkey 到 ZPass？",
            }),
            el("p", {
              text: hasDuplicate
                ? "该网站正在为同一账户创建新的 Passkey。可以替换现有凭证，也可以保留旧凭证并新增一条。"
                : "网站正在创建新的 Passkey。确认后，私钥会保存在 ZPass 桌面保险库中。",
            }),
          ],
        }),
        el("div", {
          class: "zpass-passkey-meta",
          children: [
            el("strong", { text: info.rpName || info.rpId }),
            el("span", {
              text: info.userDisplayName || info.userName || info.rpId,
            }),
          ],
        }),
        hasDuplicate
          ? el("div", {
              class: "zpass-passkey-list",
              children: existing.map((item) =>
                el("div", {
                  class: "zpass-passkey-row",
                  children: [
                    el("strong", { text: passkeyTitle(item) }),
                    el("span", { text: passkeyDetail(item) }),
                  ],
                }),
              ),
            })
          : null,
        el("div", {
          class: "zpass-dialog-actions",
          children: [
            actionButton("cancel", "取消"),
            // 主操作的视觉权重：新增 = primary 黄绿；替换 = danger 红描边
            hasDuplicate ? actionButton("create", "保留并新增") : null,
            hasDuplicate
              ? actionButton("replace", "替换现有", "zpass-danger")
              : actionButton("create", "保存", "zpass-primary"),
          ],
        }),
      ],
    });

    const backdrop = el("div", {
      class: "zpass-dialog-backdrop",
      children: [dialog],
    });

    const finish = (action: PasskeyRegistrationAction) => {
      releaseTrap();
      backdrop.remove();
      resolve(action);
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        finish("cancel");
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "replace" || action === "create" || action === "cancel") {
        finish(action);
      }
    });

    document.documentElement.append(backdrop);
    const releaseTrap = trapFocus(dialog, () => finish("cancel"));
  });
}

/** Passkey 登录选择对话框 */
export function choosePasskeyCredential(
  items: PasskeyDescriptor[],
  rpId: string,
): Promise<PasskeyDescriptor | null> {
  return new Promise((resolve) => {
    const list = el("div", {
      class: "zpass-passkey-list",
      children: items.map((item, index) =>
        el("button", {
          class: "zpass-passkey-option",
          attrs: { type: "button", "data-index": String(index) },
          children: [
            el("strong", { text: passkeyTitle(item) }),
            el("span", { text: passkeyDetail(item) }),
          ],
        }),
      ),
    });

    const dialog = el("section", {
      class: "zpass-passkey-dialog",
      attrs: {
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "zpass-passkey-title",
      },
      children: [
        el("div", {
          children: [
            el("h2", {
              attrs: { id: "zpass-passkey-title" },
              text: "选择 Passkey 登录",
            }),
            el("p", { text: `选择要用于 ${rpId} 的账户。` }),
          ],
        }),
        list,
        el("div", {
          class: "zpass-dialog-actions",
          children: [actionButton("cancel", "取消")],
        }),
      ],
    });

    const backdrop = el("div", {
      class: "zpass-dialog-backdrop",
      children: [dialog],
    });

    const finish = (item: PasskeyDescriptor | null) => {
      releaseTrap();
      backdrop.remove();
      resolve(item);
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        finish(null);
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest<HTMLButtonElement>('[data-action="cancel"]')) {
        finish(null);
        return;
      }
      const option = target.closest<HTMLButtonElement>(".zpass-passkey-option");
      if (!option) return;
      const index = Number(option.dataset.index);
      if (Number.isInteger(index) && items[index]) {
        finish(items[index]);
      }
    });

    document.documentElement.append(backdrop);
    const releaseTrap = trapFocus(dialog, () => finish(null));
  });
}

/* ============ 内部工具 ============ */

function actionButton(
  action: PasskeyRegistrationAction,
  label: string,
  extraClass = "",
): HTMLButtonElement {
  return el("button", {
    class: extraClass,
    attrs: { type: "button", "data-action": action },
    text: label,
  });
}

function closeMenus(): void {
  document
    .querySelectorAll<CleanupHost>(".zpass-menu, .zpass-notice")
    .forEach((node) => {
      node.__cleanup?.();
      node.remove();
    });
}

/**
 * 智能定位：优先放在 anchor 下方；下方空间不足且上方更宽时翻转到上方；
 * 水平方向若超出视口右边则左移贴边。
 *
 * 同时按可用空间动态限制 max-height，并写回 node.style，让
 * 条目过多的菜单能在视口内滚动（而不是被裁掉无法选择）。
 */
function positionFloating(
  node: HTMLElement,
  anchor: HTMLElement,
  width: number,
): void {
  const rect = anchor.getBoundingClientRect();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const margin = 8;
  const gap = 6; // anchor 与浮层之间的留白

  // 水平
  let left = rect.left;
  if (left + width > vpW - margin) {
    left = Math.max(margin, vpW - width - margin);
  }
  if (left < margin) left = margin;

  // 先按当前内容测一次自然高度（max-height 还未限制）
  node.style.maxHeight = "";
  const naturalH = node.offsetHeight || 200;

  const spaceBelow = vpH - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  // 翻转条件：下方放不下整个菜单，且上方比下方更宽裕
  const flipUp = naturalH > spaceBelow && spaceAbove > spaceBelow;
  const avail = Math.max(120, flipUp ? spaceAbove : spaceBelow);

  // 限制高度：取 min(实际所需, 可用空间, 上限 480)
  const limited = Math.min(naturalH, avail, 480);
  node.style.maxHeight = `${limited}px`;

  const top = flipUp ? rect.top - limited - gap : rect.bottom + gap;
  node.style.left = `${window.scrollX + left}px`;
  node.style.top = `${window.scrollY + Math.max(margin, top)}px`;
}

function passkeyTitle(item: PasskeyDescriptor): string {
  return item.userDisplayName || item.userName || item.name || item.rpId;
}

function passkeyDetail(item: PasskeyDescriptor): string {
  const id = item.credentialId
    ? `凭据 ${item.credentialId.slice(-8)}`
    : "Passkey";
  return `${item.rpId} · ${id}`;
}

/* ============================================================================
 * 「保存登录 / 更新密码」的 UI 已迁到 entrypoints/notification-bar。
 * 这里留不起现、避免宿主 CSS / SPA 上的各种军军魔鬼（transform 祖先、
 * shadow DOM 隔离、CSP、backdrop-filter、SPA 路由重渲染等）干扰。见
 * src/content/notification-bar.ts + entrypoints/notification-bar/*。
 * ========================================================================== */
