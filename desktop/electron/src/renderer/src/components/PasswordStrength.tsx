// 密码强度条组件
// ---------------------------------------------------------------------------
// 把 lib/password.ts 的 estimateStrength + strengthLabel + estimateEntropy
// 三个纯函数包装成可视化条 + 文字标签的复用 UI。多处场景需要同款显示：
//
//   - GeneratorPage 主显示区（实时反映用户调节滑块/字符集后的密码强度）
//   - NewItemDialog / EditItemDialog 的密码字段下方（输入时即时反馈）
//   - 未来 Health 页"弱密码列表"行内迷你版
//
// ---------------------------------------------------------------------------
// 设计要点
//
// 1. 视觉档位与配色
//    严格沿用 ZPass 黑白基调 + 三色语义（--danger / --warn / --ok / --text）：
//      - weak       (0..39)  → --danger（红）
//      - fair       (40..69) → --warn  （橙）
//      - strong     (70..84) → --ok    （绿）
//      - excellent  (85..100)→ --text  （高对比白/黑，强调"满分"质感）
//    不引入额外色板。绿色用于 strong 而 excellent 用 --text 是有意：满分
//    密码用更克制的"高级灰白"反而更显档次，避免"绿条到顶"的廉价感。
//
// 2. 三种 size
//    - "sm"：高 4px，无文字 —— 用在密集列表行内
//    - "md"：高 6px + 一行 label/分数文字 —— 表单字段下方
//    - "lg"：高 8px + label + 熵 + 破解时间 —— Generator 页主显示区
//    通过 prop 切换，不分开实现三个组件，避免重复样式漂移。
//
// 3. 文案本地化
//    label 通过 i18n key `strength_${label}` 读取，调用方不传文字。这样
//    新增/修改文案只动 i18n 字典一处。
//
// 4. 渐变切换动画
//    width 用 transition: 240ms ease-out，密码字符变化时填充条平滑伸缩，
//    避免"瞬间从 30% 跳到 80%"的闪烁。颜色不动画（避免红橙绿过渡途中
//    出现非语义色）。
//
// 5. 空密码降级
//    pw === "" 时仅渲染空槽（width: 0%），不显示 label —— 避免"未输入
//    时显示 weak 红条"的视觉噪声。

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	estimateCrackTime,
	estimateEntropy,
	estimateStrength,
	strengthLabel,
} from "@/lib/password";

export type PasswordStrengthSize = "sm" | "md" | "lg";

export interface PasswordStrengthProps {
	/** 待评估的密码。空串等价于 0 分，仅渲染空槽。 */
	password: string;
	/** 视觉规格，影响高度与文字密度。默认 "md"。 */
	size?: PasswordStrengthSize;
	/** 额外样式类（外层容器） */
	className?: string;
}

/**
 * 把 strengthLabel 映射到 CSS 变量
 *
 * 不内联在 JSX 里是为了：
 *   - 一处定义，三个 size 共享
 *   - 未来主题升级时只动这张表
 */
function colorForLabel(label: ReturnType<typeof strengthLabel>): string {
	switch (label) {
		case "weak":
			return "var(--danger)";
		case "fair":
			return "var(--warn)";
		case "strong":
			return "var(--ok)";
		case "excellent":
			return "var(--text)";
	}
}

/**
 * 把 size 映射到具体高度类（Tailwind 类名 + 内联高度兜底）
 *
 * 用 height inline style 而不是 Tailwind h-* 是因为 Tailwind v4 在
 * arbitrary value 解析下偶有 cache miss 风险；几个 px 的固定值直接
 * 写 style 既可读又无歧义。
 */
function trackHeightPx(size: PasswordStrengthSize): number {
	switch (size) {
		case "sm":
			return 4;
		case "md":
			return 6;
		case "lg":
			return 8;
	}
}

export function PasswordStrength({
	password,
	size = "md",
	className,
}: PasswordStrengthProps) {
	const { t } = useTranslation();

	// 三个派生值用 useMemo 缓存：避免每帧 re-render 时重复跑黑名单
	// 比对、熵估算（estimateStrength 内部已经跑了一遍，但语义上分开
	// 调用更清晰；相同输入下 V8 会把这些纯函数都内联缓存得很快）。
	const { score, label, entropy, crackTime } = useMemo(() => {
		const s = estimateStrength(password);
		return {
			score: s,
			label: strengthLabel(s),
			entropy: estimateEntropy(password),
			crackTime: estimateCrackTime(estimateEntropy(password)),
		};
	}, [password]);

	const color = colorForLabel(label);
	const height = trackHeightPx(size);
	const isEmpty = password.length === 0;

	// label 文案：从 i18n 取，key 形如 strength_weak / strength_fair / ...
	const labelText = t(`strength_${label}`);

	return (
		<div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
			{/*
				轨道 + 填充
				- 轨道：bg-(--bg-elev-2)，圆角=高度的一半（永远是胶囊）
				- 填充：内部 div，width 按 score%，背景按 label 染色
				- transition 仅作用于 width，颜色无过渡（避免穿过非语义色）
			*/}
			<div
				className="relative w-full overflow-hidden rounded-full bg-(--bg-elev-2)"
				style={{ height }}
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={score}
				aria-valuetext={isEmpty ? undefined : `${score} / 100, ${labelText}`}
			>
				<div
					className="h-full rounded-full"
					style={{
						width: isEmpty ? "0%" : `${score}%`,
						backgroundColor: color,
						transition: "width 240ms ease-out",
					}}
				/>
			</div>

			{/*
				文字行 —— 仅 md / lg 显示
				sm 用于密集列表，省略文字以节省纵向空间
			*/}
			{size !== "sm" && !isEmpty && (
				<div className="flex items-center justify-between gap-3 text-[11px] leading-tight">
					<div className="flex items-center gap-2">
						<span
							className="font-mono uppercase tracking-[0.08em]"
							style={{ color }}
						>
							{labelText}
						</span>
						<span className="font-mono tabular-nums text-(--text-3)">
							{score}
							<span className="text-(--text-4)">/100</span>
						</span>
					</div>

					{/*
						lg 模式额外显示熵 + 破解时间
						md 模式只显 label + 分数，避免输入框下方过分拥挤
					*/}
					{size === "lg" && (
						<div className="flex items-center gap-3 font-mono text-(--text-3)">
							<span>
								{t("strength_entropy")}{" "}
								<b className="text-(--text-2)">{Math.round(entropy)}</b>
								<span className="text-(--text-4)"> bits</span>
							</span>
							<span>
								{t("strength_crack")}{" "}
								<b className="text-(--text-2)">{crackTime}</b>
							</span>
						</div>
					)}
				</div>
			)}

			{/*
				空密码占位文案 —— 仅 lg 显示，避免 md 在表单里上下抖动
			*/}
			{size === "lg" && isEmpty && (
				<div className="text-[11px] text-(--text-4)">
					{t("strength_empty_hint")}
				</div>
			)}
		</div>
	);
}

export default PasswordStrength;
