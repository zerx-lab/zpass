import type { PasskeyDescriptor } from "../shared/messages";
import { el, trapFocus } from "../shared/dom";
import "./ui.css";

/* ============================================================================
 * Content Script 内浮层 UI
 * ----------------------------------------------------------------------------
 * 仅剩两类浮层：
 *   - showPageToast：右上角短暂提示（passkey 创建 / 登录成功反馈）
 *   - confirmPasskeyCreate / choosePasskeyCredential：passkey 流程对话框
 *
 * 自动填充入口现在唯一：扩展工具栏 popup → background → content
 * 广播 zpass.fillLogin。内嵌的浮动按钮 / 自动菜单 / ArrowDown 触发等
 * 旧路径已全部移除（见 entrypoints/content.ts）。
 * ========================================================================== */

export interface PasskeyCreatePromptInfo {
  rpId: string;
  rpName?: string;
  userName?: string;
  userDisplayName?: string;
}

export type PasskeyRegistrationAction = "create" | "replace" | "cancel";

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

function passkeyTitle(item: PasskeyDescriptor): string {
  return item.userDisplayName || item.userName || item.name || item.rpId;
}

function passkeyDetail(item: PasskeyDescriptor): string {
  const id = item.credentialId
    ? `凭据 ${item.credentialId.slice(-8)}`
    : "Passkey";
  return `${item.rpId} · ${id}`;
}
