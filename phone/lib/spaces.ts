// ZPass Phone —— "空间"（Space）模型
//
// 空间是 vault 内的逻辑分组：
//   - 共用同一份主密码 / KEK / DEK / vault 文件（不增加额外加密层）
//   - 每条 item 在 fields 之外另带一个 spaceId 字段，标识所属空间
//   - "当前激活空间"决定 UI（vault tab / totp tab / 统计）显示哪些 item
//
// 设计取舍：
//   - 名称 / 排序作为 plaintext 元信息落到 vault 文件顶层。空间名通常
//     是"工作 / 个人 / 家庭"这类标签，敏感度低于条目本身；plaintext 让
//     未来"未解锁状态下展示当前空间"成为可能。
//   - 空间 id 用 sp- 前缀的随机字符串。预留一个保留 id "default"
//     用于首次启动 / 自动归位场景。

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

/** 默认空间的保留 id */
export const DEFAULT_SPACE_ID = "default";

/** 默认空间名（首次自动建库时使用） */
export const DEFAULT_SPACE_NAME = "默认";

/** 生成新空间 id —— sp- 前缀便于一眼区分 */
export function newSpaceId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 构造默认空间记录 */
export function buildDefaultSpace(createdAt = Date.now()): Space {
  return {
    id: DEFAULT_SPACE_ID,
    name: DEFAULT_SPACE_NAME,
    order: 1,
    createdAt,
  };
}

/** 按 order 升序排列空间 */
export function sortSpaces(arr: Space[]): Space[] {
  return [...arr].sort((a, b) => a.order - b.order);
}

/**
 * 派生空间字形（头像里展示的单字符）。
 *
 * 与 desktop stores/spaces.ts 的 deriveGlyph 行为对齐：
 *   - 取名称 trim 后第一个"可视字符"（用 Array.from 防止 emoji / 组合字符
 *     被 substring(0,1) 截断成乱码）
 *   - 转大写（中文 / 数字 / emoji 走 toUpperCase 是 no-op）
 *   - 空串回落到 "·" 占位
 *
 * UI 层每次渲染从 name 派生即可，无需在 Space 模型上额外存字段；这样
 * 重命名后头像首字符会自动跟随，避免出现"T 头像 + zerx 名字"的不一致。
 */
export function deriveGlyph(name: string | undefined | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "·";
  const first = Array.from(trimmed)[0] ?? "·";
  return first.toUpperCase();
}
