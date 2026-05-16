import type {
  LoginSummary,
  PasskeyDescriptor,
  PasskeyListResult,
  QueryLoginsResult,
  VaultStatus
} from "../shared/messages";
import "./popup.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing popup root.");
const root = app;

void render();

async function render(): Promise<void> {
  root.innerHTML = `<section class="panel"><header><strong>ZPass</strong><span>正在检查桌面端</span></header></section>`;
  const statusResponse = await browser.runtime.sendMessage({ type: "zpass.status" });
  if (!statusResponse?.ok) {
    renderMessage(
      "桌面端未连接",
      `${statusResponse?.error ?? "请安装 native messaging host。"}\nExtension ID: ${browser.runtime.id}`
    );
    return;
  }
  const status = statusResponse.result as VaultStatus;
  if (!status.initialized) {
    renderMessage("保险库未初始化", "打开 ZPass Desktop 并创建保险库。");
    return;
  }
  if (!status.unlocked) {
    renderMessage("保险库已锁定", "解锁 ZPass Desktop 后才能使用自动填充和 Passkey。");
    return;
  }

  const queryResponse = await browser.runtime.sendMessage({ type: "zpass.queryLogins" });
  if (!queryResponse?.ok) {
    renderMessage("无法检查当前页面", queryResponse?.error ?? "请打开 http 或 https 页面。");
    return;
  }
  const loginResult = queryResponse.result as QueryLoginsResult;
  const passkeyResult = await queryPasskeysForActiveTab();
  renderMatches(loginResult.items, passkeyResult?.items ?? []);
}

function renderMessage(title: string, body: string): void {
  root.innerHTML = `<section class="panel"><header><strong>ZPass</strong></header><div class="empty"><b></b><p></p></div></section>`;
  root.querySelector("b")!.textContent = title;
  root.querySelector("p")!.textContent = body;
}

function renderMatches(logins: LoginSummary[], passkeys: PasskeyDescriptor[]): void {
  const total = logins.length + passkeys.length;
  root.innerHTML = `<section class="panel"><header><strong>ZPass</strong><span></span></header><div class="list"></div></section>`;
  root.querySelector("header span")!.textContent = `${total} 项匹配`;
  const list = root.querySelector(".list")!;
  if (total === 0) {
    list.innerHTML = `<div class="empty"><b>没有匹配项目</b><p>当前站点还没有保存在 ZPass Desktop 中的登录项或 Passkey。</p></div>`;
    return;
  }
  if (passkeys.length > 0) {
    list.append(sectionTitle("Passkey 账户"));
    for (const item of passkeys) {
      const row = document.createElement("div");
      row.className = "passkey";
      row.innerHTML = `<strong></strong><span></span>`;
      row.querySelector("strong")!.textContent = item.userDisplayName || item.userName || item.name;
      row.querySelector("span")!.textContent = `已保存于 ${item.rpId}`;
      list.append(row);
    }
  }
  if (logins.length > 0) {
    list.append(sectionTitle("登录项"));
  }
  for (const item of logins) {
    const row = document.createElement("button");
    row.className = "login";
    row.type = "button";
    row.innerHTML = `<strong></strong><span></span>`;
    row.querySelector("strong")!.textContent = item.name;
    row.querySelector("span")!.textContent = item.username || item.displayUrl;
    row.addEventListener("click", () => void fillActiveTab(item));
    list.append(row);
  }
}

function sectionTitle(label: string): HTMLDivElement {
  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = label;
  return title;
}

async function queryPasskeysForActiveTab(): Promise<PasskeyListResult | null> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return null;
  const rpId = getRpId(tab.url);
  if (!rpId) return null;
  const response = await browser.runtime.sendMessage({
    type: "zpass.passkeyList",
    payload: { rpId }
  });
  if (!response?.ok) return null;
  const result = response.result as PasskeyListResult;
  return result.unlocked ? result : null;
}

function getRpId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

async function fillActiveTab(item: LoginSummary): Promise<void> {
  const response = await browser.runtime.sendMessage({ type: "zpass.fillActiveTab", itemId: item.id });
  if (!response?.ok) {
    renderMessage("填充失败", response?.error ?? "ZPass 无法填充当前页面。");
    return;
  }
  window.close();
}
