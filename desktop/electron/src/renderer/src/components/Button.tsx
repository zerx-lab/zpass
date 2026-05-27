import * as React from "react";

/**
 * Button — ZPass 全局通用按钮组件
 * ---------------------------------------------------------------------------
 * 参考 shadcn/ui Button 的 variant + size 两轴设计，但基于 ZPass 设计系统
 * CSS token（不引入 class-variance-authority / clsx 等额外依赖）。
 *
 * Variants:
 *   default  — 主操作：实心 --text 背景 + --bg 文字（暗色/亮色主题自动反相）
 *   secondary— 次要操作：--bg-elev-2 背景 + 明显描边，视觉权重低于 default
 *   ghost    — 最低权重：透明背景 + hover 时出现 --bg-hover 底色
 *   danger   — 破坏性操作：实心 --danger 红 + 白字
 *   warn     — 风险操作：实心 --warn 橙 + 白字
 *   outline  — 描边主操作：透明底 + --text 描边 + --text 文字（比 secondary 更强调）
 *   link     — 纯文字链接样式，带 hover 下划线
 *
 * Sizes:
 *   sm   — h-7  px-2.5  text-[12px]  gap-1      (辅助操作、toolbar icon-label)
 *   md   — h-9  px-4    text-[13px]  gap-1.5    (默认，Dialog / Form 按钮)
 *   lg   — h-10 px-5    text-[14px]  gap-2      (页面级主 CTA，如登录/解锁)
 *   icon — h-8  w-8     无内边距                  (纯图标按钮，正方形)
 *
 * 额外 props:
 *   loading  — 显示 spinner，自动禁用按钮
 *   leftIcon / rightIcon — 前置/后置图标 slot
 *
 * 设计约束（来自 AGENTS.md + 历史决策）：
 *   - 不使用 Tailwind accent color；严格黑白 + --danger/--warn 特殊色
 *   - border 宽度：default/danger/warn 无描边，secondary/outline 用 1px，ghost 无
 *   - 圆角：--radius（7px），保持与 token 一致
 *   - 禁用态：cursor-not-allowed + opacity-40
 *   - 过渡：transition-[opacity,transform,background,border-color,color] 150ms
 *   - active: scale-[0.97] 给予触感反馈
 */

type Variant =
	| "default"
	| "secondary"
	| "ghost"
	| "danger"
	| "warn"
	| "outline"
	| "link";
type Size = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant;
	size?: Size;
	loading?: boolean;
	leftIcon?: React.ReactNode;
	rightIcon?: React.ReactNode;
	asChild?: boolean; // 保留兼容性，暂不实现（不依赖 Radix Slot）
}

// ─── variant → className ───────────────────────────────────────────────────

// 桌面 app 化按钮配方 —— 关键差异点（见 design/vault-home.html 注释）：
//   1. primary（default / danger / warn）：实心填充 + inset 1px 高光 + 双层
//      外阴影。这是 macOS Aqua 的"凸起"配方,即便 BigSur 后扁平化仍保留;
//      缺这两层(高光 + 阴影)就回到 web 扁平按钮观感
//   2. secondary：去掉 hover 时 border 变色(Bootstrap/shadcn 标志味),
//      只换底色,active 才微缩
//   3. ghost：透明底,完全无边框,只靠 hover 底色反馈
//
// CSS-level 阴影必须用 [box-shadow:...] arbitrary value 套进 Tailwind,
// 这样可与 hover/active 状态切换。
const VARIANT_CLASSES: Record<Variant, string> = {
	default:
		"zpass-btn-primary " +
		"bg-(--text) text-(--bg) font-semibold border border-transparent " +
		"hover:opacity-90 active:scale-[0.97]",

	secondary:
		// 去掉 hover:border-(--text-3) —— 桌面 app 不做边框色 hover 反馈
		"bg-(--bg-elev-2) text-(--text) font-medium border border-(--line-soft) " +
		"hover:bg-(--bg-hover) active:scale-[0.97] active:bg-(--bg-active)",

	ghost:
		"bg-transparent text-(--text-2) font-medium border border-transparent " +
		"hover:bg-(--bg-hover) hover:text-(--text) active:scale-[0.97] active:bg-(--bg-active)",

	danger:
		"zpass-btn-primary " +
		"bg-(--danger) text-(--danger-ink) font-semibold border border-transparent " +
		"hover:opacity-90 active:scale-[0.97]",

	warn:
		"zpass-btn-primary " +
		"bg-(--warn) text-(--warn-ink) font-semibold border border-transparent " +
		"hover:opacity-90 active:scale-[0.97]",

	outline:
		"bg-transparent text-(--text) font-semibold border border-(--text) " +
		"hover:bg-(--bg-hover) active:scale-[0.97]",

	link:
		"bg-transparent text-(--text-2) font-medium border border-transparent underline-offset-4 " +
		"hover:text-(--text) hover:underline active:scale-[0.97]",
};

// ─── size → className ──────────────────────────────────────────────────────

const SIZE_CLASSES: Record<Size, string> = {
	sm: "h-7  min-w-0 px-2.5 text-[12px] gap-1   rounded-(--radius)",
	md: "h-9  min-w-0 px-4   text-[13px] gap-1.5 rounded-(--radius)",
	lg: "h-10 min-w-0 px-5   text-[14px] gap-2   rounded-(--radius)",
	icon: "h-8  w-8     p-0    text-[14px] gap-0   rounded-(--radius) shrink-0",
};

// ─── Spinner (inline svg, no deps) ────────────────────────────────────────

function Spinner({ size }: { size: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className="animate-spin"
			aria-hidden
		>
			<circle
				cx="8"
				cy="8"
				r="6"
				stroke="currentColor"
				strokeWidth="2"
				strokeOpacity="0.25"
			/>
			<path
				d="M14 8a6 6 0 0 0-6-6"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
		</svg>
	);
}

// ─── Button ────────────────────────────────────────────────────────────────

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	function Button(
		{
			variant = "default",
			size = "md",
			loading = false,
			leftIcon,
			rightIcon,
			disabled,
			className = "",
			children,
			...props
		},
		ref,
	) {
		const isDisabled = disabled || loading;

		// spinner 尺寸跟 size 档位走
		const spinnerSize = size === "lg" ? 15 : size === "sm" ? 12 : 14;

		const base =
			"inline-flex items-center justify-center whitespace-nowrap select-none " +
			"transition-[opacity,transform,background-color,border-color,color] duration-150 " +
			// 键盘聚焦走 globals.css 统一 outline（1px var(--text) + offset 2px）。
			// 这里不再叠加 ring/ring-offset，避免与全局 outline 双层视觉冲突（§6）。
			"disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none";

		const classes = [
			base,
			VARIANT_CLASSES[variant],
			SIZE_CLASSES[size],
			className,
		]
			.filter(Boolean)
			.join(" ");

		return (
			<button ref={ref} disabled={isDisabled} className={classes} {...props}>
				{loading ? (
					<Spinner size={spinnerSize} />
				) : (
					leftIcon && (
						<span className="shrink-0 flex items-center">{leftIcon}</span>
					)
				)}

				{/* icon size 时不渲染 children 容器（避免撑宽），否则保留。
				 * 用 inline-flex 而非裸 inline-block：如果调用方误把 icon 作为 children
				 * 第一项传进来（而非 leftIcon prop），svg + 文字的混合仍能水平
				 * 排在一起 —— inline-flex 默认 row + nowrap，比裸 inline 更安全。
				 * gap-1.5 让 icon 与文字之间有适度间距。 */}
				{size === "icon" ? (
					children
				) : (
					<span className="inline-flex items-center gap-1.5 leading-none">
						{children}
					</span>
				)}

				{!loading && rightIcon && (
					<span className="shrink-0 flex items-center">{rightIcon}</span>
				)}
			</button>
		);
	},
);

Button.displayName = "Button";
