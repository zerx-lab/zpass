// ZPass HarmonyOS —— "空间"（Space）模型
//
// 直接 1:1 翻译自 phone/lib/spaces.ts。语义说明见原文件。

export interface Space {
  /** 唯一标识；保留 id "default" 表示初始默认空间 */
  id: string;
  /** 展示名 */
  name: string;
  /** 显示顺序（1 起步，新建追加到末尾） */
  order: number;
  /** 创建时间（毫秒） */
  createdAt: number;
}

export const DEFAULT_SPACE_ID: string = 'default';
export const DEFAULT_SPACE_NAME: string = '默认';

export function newSpaceId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildDefaultSpace(createdAt: number = Date.now()): Space {
  return {
    id: DEFAULT_SPACE_ID,
    name: DEFAULT_SPACE_NAME,
    order: 1,
    createdAt,
  };
}

export function sortSpaces(arr: Space[]): Space[] {
  // ArkTS strict 不允许 spread 数组拷贝时返回 readonly；用 slice
  return arr.slice().sort((a, b) => a.order - b.order);
}

/**
 * 派生空间字形（头像里展示的单字符）
 *
 * 与 desktop / phone 端 deriveGlyph 行为对齐：
 *   - 取名称 trim 后第一个"可视字符"
 *   - 转大写
 *   - 空串回落到 "·" 占位
 */
export function deriveGlyph(name: string | undefined | null): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '·';
  // Array.from 处理 emoji / 组合字符
  const first = Array.from(trimmed)[0] ?? '·';
  return first.toUpperCase();
}
