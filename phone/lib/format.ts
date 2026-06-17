// 展示层格式化工具 —— 相对时间、字形标记、品牌配色等。

import type { VaultItem, VaultItemType } from "@/data/vault";

/* ----------------------------------------------------------------------------
 * 相对时间
 * -------------------------------------------------------------------------- */

/** 将毫秒时间戳格式化为「1小时前 / 2天前」等中文相对时间 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天前`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}个月前`;
  return `${Math.floor(mon / 12)}年前`;
}

/* ----------------------------------------------------------------------------
 * 字形标记 / 品牌配色
 * -------------------------------------------------------------------------- */

/** 调色板 —— 与 ZPass 设计语言协调的低饱和深色系 */
const FAVICON_COLORS = [
  "#1a1a2e",
  "#5e6ad2",
  "#2c2c2c",
  "#ff7262",
  "#141414",
  "#ff9900",
  "#f38020",
  "#635bff",
  "#c8292b",
  "#1e4d2b",
  "#3b6ea5",
  "#7d4f9e",
];

/** 根据名称稳定哈希出一个配色（同名永远同色） */
export function faviconColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return FAVICON_COLORS[h % FAVICON_COLORS.length];
}

/** 取名称首字母作为字形标记（中文取首字，英文取前两字母） */
export function faviconInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = trimmed[0];
  if (/[一-龥]/.test(first)) return first;
  // 英文：取首个单词前两字母
  const word = trimmed.replace(/[^A-Za-z0-9]/g, "");
  return (word.slice(0, 2) || first).toUpperCase();
}

/* ----------------------------------------------------------------------------
 * 条目元信息
 * -------------------------------------------------------------------------- */

/** 条目类型 → 中文标签 */
export const TYPE_LABELS: Record<VaultItemType, string> = {
  login: "登录凭据",
  card: "支付卡",
  note: "安全笔记",
  identity: "身份信息",
  ssh: "SSH 密钥",
  passkey: "Passkey",
  totp: "验证码",
};

/** 条目类型 → SF Symbol 图标名 */
export const TYPE_ICONS: Record<VaultItemType, string> = {
  login: "key.fill",
  card: "creditcard.fill",
  note: "note.text",
  identity: "person.fill",
  ssh: "terminal.fill",
  passkey: "lock.fill",
  totp: "clock.fill",
};

/** 取条目的副标题（列表第二行） */
export function itemSubtitle(item: VaultItem): string {
  switch (item.type) {
    case "login":
      return item.username;
    case "card":
      return "•••• " + item.number.replace(/\s/g, "").slice(-4);
    case "note":
      return item.note ? item.note.split("\n")[0] : "安全笔记";
    case "identity":
      return item.email;
    case "ssh":
      return item.apiKey ? "API Token" : item.username || item.keyType || "SSH";
    case "passkey":
      return item.rpId;
    case "totp":
      return item.account || item.issuer || "TOTP";
  }
}

/** 取条目用于搜索匹配的文本 */
export function itemSearchText(item: VaultItem): string {
  const parts = [item.name, ...(item.tags ?? [])];
  if (item.type === "login") parts.push(item.username, item.url ?? "");
  if (item.type === "identity") parts.push(item.email, item.first, item.last);
  if (item.type === "passkey") parts.push(item.rpId);
  if (item.type === "ssh" && item.username) parts.push(item.username);
  if (item.type === "totp")
    parts.push(item.issuer ?? "", item.account ?? "");
  return parts.join(" ").toLowerCase();
}
