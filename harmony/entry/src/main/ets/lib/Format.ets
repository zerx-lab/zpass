// 展示层格式化工具 —— 与 phone/lib/format.ts 对齐

import type { VaultItemType } from '../model/Vault';
import { ZColors } from '../theme/Tokens';

/* ----------------------------------------------------------------------------
 * 相对时间
 * -------------------------------------------------------------------------- */

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
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

/**
 * favicon 头像底色 —— 走 ZColors.faviconColors（@ObservedV2 单例）
 * 主题切换时 palette 自动切板，调用点（组件 build / @Builder）会因
 * 依赖了同一实例的其他 @Trace 字段而触发重渲，自然拿到新色。
 */
export function faviconColor(name: string): string {
  const palette = ZColors.faviconColors;
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length];
}

export function faviconInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first = trimmed[0];
  if (/[一-龥]/.test(first)) return first;
  const word = trimmed.replace(/[^A-Za-z0-9]/g, '');
  return (word.slice(0, 2) || first).toUpperCase();
}

/* ----------------------------------------------------------------------------
 * 条目元信息 —— 用 Map<X, Y> 替代 Record<X, Y> 对象字面量
 * -------------------------------------------------------------------------- */

const TYPE_LABELS_MAP: Map<VaultItemType, string> = new Map<VaultItemType, string>([
  ['login', '登录凭据'],
  ['card', '支付卡'],
  ['note', '安全笔记'],
  ['identity', '身份信息'],
  ['ssh', 'SSH 密钥'],
  ['passkey', '通行密钥'],
  ['totp', '验证码'],
]);

export function typeLabel(t: VaultItemType): string {
  return TYPE_LABELS_MAP.get(t) ?? t;
}

const TYPE_GLYPH_MAP: Map<VaultItemType, string> = new Map<VaultItemType, string>([
  ['login', 'L'],
  ['card', 'C'],
  ['note', 'N'],
  ['identity', 'I'],
  ['ssh', 'S'],
  ['passkey', 'P'],
  ['totp', 'T'],
]);

export function typeGlyph(t: VaultItemType): string {
  return TYPE_GLYPH_MAP.get(t) ?? '·';
}
