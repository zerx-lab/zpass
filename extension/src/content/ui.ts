import type { LoginSummary, PasskeyDescriptor } from "../shared/messages";
import "./ui.css";

export interface PasskeyCreatePromptInfo {
  rpId: string;
  rpName?: string;
  userName?: string;
  userDisplayName?: string;
}

export type PasskeyRegistrationAction = "create" | "replace" | "cancel";

export function createAutofillButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "zpass-fill-button";
  button.title = "使用 ZPass 填充";
  button.setAttribute("aria-label", "使用 ZPass 填充");
  button.textContent = "Z";
  return button;
}

export function showCredentialMenu(
  anchor: HTMLElement,
  items: LoginSummary[],
  onSelect: (item: LoginSummary) => Promise<void>
): void {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "zpass-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "zpass-menu-item";
    option.innerHTML = `<strong></strong><span></span>`;
    option.querySelector("strong")!.textContent = item.name;
    option.querySelector("span")!.textContent = item.username || item.displayUrl;
    option.addEventListener("click", () => {
      closeMenus();
      void onSelect(item);
    });
    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    menu.append(option);
  }
  document.documentElement.append(menu);
  positionMenu(menu, anchor);

  const close = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node) && event.target !== anchor) {
      closeMenus();
      document.removeEventListener("mousedown", close, true);
    }
  };
  window.setTimeout(() => document.addEventListener("mousedown", close, true), 0);
}

export function closeCredentialMenus(): void {
  closeMenus();
}

export function showTransientNotice(anchor: HTMLElement, message: string): void {
  closeMenus();
  const notice = document.createElement("div");
  notice.className = "zpass-notice";
  notice.textContent = message;
  document.documentElement.append(notice);
  positionMenu(notice, anchor);
  window.setTimeout(() => notice.remove(), 2600);
}

export function showPageToast(title: string, message: string): void {
  document.querySelectorAll(".zpass-toast").forEach((node) => node.remove());
  const toast = document.createElement("div");
  toast.className = "zpass-toast";
  toast.setAttribute("role", "status");
  toast.innerHTML = `<strong></strong><span></span>`;
  toast.querySelector("strong")!.textContent = title;
  toast.querySelector("span")!.textContent = message;
  document.documentElement.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

export function confirmPasskeyCreate(
  info: PasskeyCreatePromptInfo,
  existing: PasskeyDescriptor[] = []
): Promise<PasskeyRegistrationAction> {
  return new Promise((resolve) => {
    const hasDuplicate = existing.length > 0;
    const backdrop = document.createElement("div");
    backdrop.className = "zpass-dialog-backdrop";
    backdrop.innerHTML = `
      <section class="zpass-passkey-dialog" role="dialog" aria-modal="true" aria-labelledby="zpass-passkey-title">
        <div>
          <h2 id="zpass-passkey-title"></h2>
          <p></p>
        </div>
        <div class="zpass-passkey-meta">
          <strong></strong>
          <span></span>
        </div>
        <div class="zpass-passkey-list" hidden></div>
        <div class="zpass-dialog-actions">
          <button type="button" data-action="cancel"></button>
          <button type="button" data-action="create" hidden></button>
          <button type="button" class="zpass-primary" data-action="primary"></button>
        </div>
      </section>
    `;
    backdrop.querySelector("h2")!.textContent = hasDuplicate ? "已存在此账户的 Passkey" : "保存 Passkey 到 ZPass？";
    backdrop.querySelector("p")!.textContent = hasDuplicate
      ? "该网站正在为同一账户创建新的 Passkey。你可以替换现有凭证，也可以保留旧凭证并新增一条。"
      : "网站正在创建新的 Passkey。确认后，私钥会保存在 ZPass 桌面保险库中。";
    backdrop.querySelector("strong")!.textContent = info.rpName || info.rpId;
    backdrop.querySelector("span")!.textContent = info.userDisplayName || info.userName || info.rpId;
    backdrop.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.textContent = "取消";
    const create = backdrop.querySelector<HTMLButtonElement>('[data-action="create"]')!;
    const primary = backdrop.querySelector<HTMLButtonElement>('[data-action="primary"]')!;
    primary.dataset.action = hasDuplicate ? "replace" : "create";
    primary.textContent = hasDuplicate ? "替换现有" : "保存";
    if (hasDuplicate) {
      create.hidden = false;
      create.textContent = "仍然新增";
      const list = backdrop.querySelector<HTMLDivElement>(".zpass-passkey-list")!;
      list.hidden = false;
      for (const item of existing) {
        const row = document.createElement("div");
        row.className = "zpass-passkey-row";
        row.innerHTML = `<strong></strong><span></span>`;
        row.querySelector("strong")!.textContent = passkeyTitle(item);
        row.querySelector("span")!.textContent = passkeyDetail(item);
        list.append(row);
      }
    }

    const finish = (action: PasskeyRegistrationAction) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKeyDown, true);
      resolve(action);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish("cancel");
    };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish("cancel");
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "replace" || action === "create" || action === "cancel") {
        finish(action);
      }
    });
    document.addEventListener("keydown", onKeyDown, true);
    document.documentElement.append(backdrop);
    primary.focus();
  });
}

export function choosePasskeyCredential(items: PasskeyDescriptor[], rpId: string): Promise<PasskeyDescriptor | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "zpass-dialog-backdrop";
    backdrop.innerHTML = `
      <section class="zpass-passkey-dialog" role="dialog" aria-modal="true" aria-labelledby="zpass-passkey-title">
        <div>
          <h2 id="zpass-passkey-title">选择 Passkey 登录</h2>
          <p></p>
        </div>
        <div class="zpass-passkey-list"></div>
        <div class="zpass-dialog-actions">
          <button type="button" data-action="cancel">取消</button>
        </div>
      </section>
    `;
    backdrop.querySelector("p")!.textContent = `选择要用于 ${rpId} 的账户。`;
    const list = backdrop.querySelector<HTMLDivElement>(".zpass-passkey-list")!;
    items.forEach((item, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "zpass-passkey-option";
      option.dataset.index = String(index);
      option.innerHTML = `<strong></strong><span></span>`;
      option.querySelector("strong")!.textContent = passkeyTitle(item);
      option.querySelector("span")!.textContent = passkeyDetail(item);
      list.append(option);
    });

    const finish = (item: PasskeyDescriptor | null) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKeyDown, true);
      resolve(item);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(null);
    };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish(null);
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
    document.addEventListener("keydown", onKeyDown, true);
    document.documentElement.append(backdrop);
    list.querySelector<HTMLButtonElement>(".zpass-passkey-option")?.focus();
  });
}

function closeMenus(): void {
  document.querySelectorAll(".zpass-menu, .zpass-notice").forEach((node) => node.remove());
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 286)}px`;
  menu.style.top = `${window.scrollY + rect.bottom + 6}px`;
}

function passkeyTitle(item: PasskeyDescriptor): string {
  return item.userDisplayName || item.userName || item.name || item.rpId;
}

function passkeyDetail(item: PasskeyDescriptor): string {
  const id = item.credentialId ? `凭据 ${item.credentialId.slice(-8)}` : "Passkey";
  return `${item.rpId} · ${id}`;
}
