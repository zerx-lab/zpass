// SpaceAvatar —— 空间头像统一渲染组件
// ---------------------------------------------------------------------------
// 抽出独立组件的原因：
//   头像在 4 处出现（WorkspaceSwitcher 触发按钮 / WorkspaceSwitcher 下拉
//   列表项 / SettingsPage 空间列表项 / SpaceEditDialog 预览区），且每处
//   尺寸 + 圆角约束都不同，但"图片优先于文字"的回退逻辑完全一致。
//   把分支收在这里，确保任何地方修改回退规则都只改一处。
//
// 渲染优先级：
//   1. space.avatarDataUrl 有值 —— 渲染 <img>，保持方块整体外观（同色描边
//      + 同色底，避免透明 PNG 露出 page bg 显得脏）
//   2. space.glyph 非空 —— 渲染 mono font 大写字母方块
//   3. 都没有 —— 用 "·" 占位（与 deriveGlyph 兜底字符一致）
//
// 视觉约束（AGENTS.md "严格黑白"）：
//   - 不引入 accent 色；图片以 cover 填充避免变形
//   - 圆角通过 className 外部传入（业界 5 / 7 / 10 / 14 px 体系）
//   - 不写 boxShadow / hover 装饰 —— 调用方可在外层包一层 hover 效果

import { clsx } from "clsx";
import type { Space } from "@/stores/spaces";

interface SpaceAvatarProps {
	/** 空间对象（只读取 avatarDataUrl / glyph / name） */
	space: Pick<Space, "avatarDataUrl" | "glyph" | "name">;
	/** 方块 CSS 尺寸（含 h-/w-/text-/rounded-* 等所有视觉类） */
	className?: string;
	/** 字体尺寸 className（仅在文字回退时生效）；默认由调用方控制 */
	textClassName?: string;
}

/**
 * 渲染空间头像方块。
 *
 * 用法示例：
 *   <SpaceAvatar
 *     space={active}
 *     className="h-7 w-7 rounded-(--radius)"
 *     textClassName="text-[13px]"
 *   />
 *
 * 调用方负责定义"方块大小 + 圆角"，本组件只负责"图片 / 文字"的二选一渲染。
 */
export function SpaceAvatar({
	space,
	className,
	textClassName,
}: SpaceAvatarProps) {
	// 图片优先 —— 用户上传过自定义头像就不再展示文字
	if (space.avatarDataUrl) {
		return (
			<div
				className={clsx(
					"flex shrink-0 items-center justify-center overflow-hidden",
					"border border-(--line) bg-(--bg-elev-2)",
					className,
				)}
			>
				<img
					src={space.avatarDataUrl}
					alt={space.name}
					className="h-full w-full object-cover"
					// 防止图片加载失败时残留 alt 文字溢出方块；失败时
					// 直接置空 src 让外层 bg 兜底
					onError={(e) => {
						(e.currentTarget as HTMLImageElement).style.display = "none";
					}}
					draggable={false}
				/>
			</div>
		);
	}

	// 文字回退 —— glyph 已由 deriveGlyph 保证非空，但仍做一次防御
	const text = space.glyph || "·";
	// 中性灰底 + 深字方块。早期版本用 brand 蓝渐变 + 白字,但 sidebar 顶/底
	// 两处同时出现时与列表的 tint 头像、右上 CTA 共同抢视觉,品牌色失去
	// "指向 CTA"的语义。现在退到中性,字色 / 描边 / 阴影全部交由
	// .zpass-workspace-avatar 定义,组件这里只负责形状 + 字符 fallback。
	return (
		<div
			className={clsx(
				"zpass-workspace-avatar",
				"flex shrink-0 items-center justify-center",
				"font-mono font-semibold",
				className,
				textClassName,
			)}
		>
			{text}
		</div>
	);
}

export default SpaceAvatar;
