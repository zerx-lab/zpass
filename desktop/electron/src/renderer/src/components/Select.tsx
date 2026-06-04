import * as SelectPrimitive from "@radix-ui/react-select";
import { clsx } from "clsx";
import { Check, ChevronDown } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { forwardRef } from "react";

/**
 * Select 下拉组件 —— 基于 Radix UI Select primitive 的薄包装
 * ---------------------------------------------------------------------------
 * 历史背景：
 *   本组件此前是一份手写的 470 行实现（portal + 手算定位 + 手写键盘导航 +
 *   点击外部关闭 …）。用户在视觉走查中反馈"hover 没有效果 / 没有背景"，
 *   并明确表达偏好："可以调研使用现成的组件而不是造轮子"。
 *
 *   因此改为包装 @radix-ui/react-select（2.2.x）：
 *     - a11y 完整（role=listbox / option、aria-selected / highlighted、
 *       screen reader 播报、键盘 ↑↓ / Home / End / Enter / Esc / 字母跳转）
 *     - 定位由 @radix-ui/react-popper 负责（Floating UI 思路，处理
 *       视口溢出、翻转、scroll 容器跟随）
 *     - 提供 `[data-highlighted]` 和 `[data-state=checked]` 的 data
 *       attribute，方便用 Tailwind `data-[highlighted]:…` 写样式，
 *       解决之前"hover/highlight 态对比度不够"的根因
 *     - React 19 兼容（peerDependencies 声明 ^19）
 *
 * API 兼容性：
 *   为避免改动消费侧（SettingsPage 已经用 `<Select value options onChange />`
 *   的风格），本文件保留原 `SelectProps<T>` 的对外形状。组件内部用 Radix 的
 *   composable parts 拼出同样效果。
 *
 * 视觉约束（沿用黑白高级感）：
 *   - 触发按钮三态（默认 / hover / open）通过 border 深浅 + bg 层级 + shadow
 *     共同表达，不用 accent 色
 *   - 下拉项 highlighted 态用 `--bg-hover` 底 + `--text` 前景，而不是上一版
 *     的 `--bg-active` —— 后者在浅色主题下与 `--bg` 差值过弱（#f5f5f3 ↔ #e4e4e0）
 *   - 选中项（checked）额外显示右侧 ✓ 标记
 */

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export interface SelectOption<T extends string> {
	value: T;
	label: string;
	/** 选项左侧小图标（可选） */
	icon?: IconComp;
	/** 选项右侧辅助说明（如语言 BCP-47 标签、快捷键等） */
	hint?: string;
	/** 禁用该选项 */
	disabled?: boolean;
}

export interface SelectProps<T extends string> {
	value: T;
	onChange: (next: T) => void;
	options: Array<SelectOption<T>>;
	/** 无障碍标签（读屏软件） */
	ariaLabel?: string;
	/** 触发按钮尺寸 —— 默认 "sm"，与 Settings 行控件节奏一致 */
	size?: "sm" | "md";
	/** 额外 className 透传到触发按钮（常用于 min-w） */
	className?: string;
	/** 禁用整个 Select */
	disabled?: boolean;
	/** 触发按钮未选中时的 placeholder */
	placeholder?: string;
}

/**
 * 单个选项 —— forwardRef 以满足 Radix 的 ref 要求
 * ---------------------------------------------------------------------------
 * Radix Select.Item 的标准写法：
 *   - 内部必须有 <Select.ItemText>（供触发按钮读取选中态显示文本）
 *   - 可选 <Select.ItemIndicator>（仅选中时渲染，用于放 ✓ 之类的标记）
 *
 * 样式要点：
 *   - `data-[highlighted]:…` —— Radix 在键盘高亮或鼠标悬停时给 item 加
 *     `data-highlighted` 属性；我们用它驱动 bg / text 色切换，一条 CSS
 *     选择器同时
覆盖键盘和鼠标两种路径（解决"鼠标悬浮没有效果"的痛点）。
 *   - `data-[state=checked]:…` —— 当前选中项；这里让 ✓ 图标只在该态显示。
 *   - `data-[disabled]:…` —— 禁用项变灰 + 去除 cursor。
 *   - `outline-none` —— Radix 会自动 focus item 以传递键盘事件，我们不要
 *     浏览器默认的 outline（焦点反馈已经由 bg-hover 提供了）。
 */
const OptionRow = forwardRef<
	HTMLDivElement,
	{
		option: SelectOption<string>;
	}
>(({ option }, ref) => {
	const Icon = option.icon;
	return (
		<SelectPrimitive.Item
			ref={ref}
			value={option.value}
			disabled={option.disabled}
			className={clsx(
				"relative flex h-8 cursor-default items-center gap-2 rounded-sm px-2 pr-7 text-[12.5px] text-(--text-2)",
				// 冗余保护：关闭所有 focus 相关浏览器默认 outline；
				// 高亮态完全由 [data-highlighted] 的背景 + 前景表达
				"outline-none focus:outline-none focus-visible:outline-none",
				"transition-colors select-none",
				"data-highlighted:bg-(--bg-hover) data-highlighted:text-(--text)",
				"data-[state=checked]:text-(--text)",
				"data-disabled:cursor-not-allowed data-disabled:opacity-40",
			)}
		>
			{Icon && (
				<Icon
					size={12}
					strokeWidth={1.75}
					className="shrink-0 text-(--text-3) data-highlighted:text-(--text-2)"
				/>
			)}
			<SelectPrimitive.ItemText>
				<span className="truncate">{option.label}</span>
			</SelectPrimitive.ItemText>
			{option.hint && (
				<span className="ml-auto font-mono text-[10.5px] text-(--text-4)">
					{option.hint}
				</span>
			)}
			<SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center">
				<Check size={12} strokeWidth={2} className="text-(--text)" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
});
OptionRow.displayName = "OptionRow";

/**
 * Select 组件本体
 * ---------------------------------------------------------------------------
 * 泛型 T 约束为 string，便于和 Radix 的 value/onValueChange 对接
 * （Radix Select 仅接受 string；如需存储复杂对象，调用方自行维护映射）。
 */
export function Select<T extends string>({
	value,
	onChange,
	options,
	ariaLabel,
	size = "sm",
	className,
	disabled,
	placeholder,
}: SelectProps<T>) {
	return (
		<SelectPrimitive.Root
			value={value}
			onValueChange={(v) => onChange(v as T)}
			disabled={disabled}
		>
			{/*
			 * 触发按钮
			 * -----------------------------------------------------------------
			 * 三态反馈：
			 *   默认 —— border-(--line) + bg-(--bg-elev-2)
			 *   hover —— border-(--text-3) + bg-(--bg-hover) + shadow-sm
			 *   open（`data-[
state=open]`，Radix 自动加）—— border-(--text-2)
			 *           + bg-(--bg-active) + shadow-sm
			 *
			 * 这里 transition 显式列出 `background-color,border-color,box-shadow,color`，
			 * 避免 `transition-all` 触发布局属性（width/height）的动画。
			 */}
			<SelectPrimitive.Trigger
				aria-label={ariaLabel}
				className={clsx(
					"group inline-flex items-center gap-1.5 rounded-(--radius) border bg-(--bg-elev-2)",
					"px-2.5 transition-[background-color,border-color,box-shadow,color] duration-150",
					size === "sm" ? "h-8" : "h-9",
					// 默认 min-w-40 仅在调用方未自带 min-w 时生效 —— 避免与传入的
					// `min-w-0` / `min-w-[…]` 在同一 utilities layer 里靠源序决胜（不可控）。
					// 紧凑/流式场景由调用方用自己的 min-w 覆盖。
					!className?.includes("min-w") && "min-w-40",
					"border-(--line) text-(--text)",
					// 冗余保护：显式关闭 focus outline —— 即便 globals.css 未来被改，
					// Select 触发按钮也不会出现双层描边（border + outline）
					"outline-none focus:outline-none focus-visible:outline-none",
					// hover 仅换底色 + 微阴影，不动 border 色（桌面 app 不做边框色 hover 反馈）；
					// 仅 open（committed 态）才允许 border 变化
					"hover:bg-(--bg-hover) hover:shadow-sm",
					"data-[state=open]:border-(--text-2) data-[state=open]:bg-(--bg-active) data-[state=open]:shadow-sm",
					"data-disabled:cursor-not-allowed data-disabled:opacity-60 data-disabled:hover:border-(--line) data-disabled:hover:bg-(--bg-elev-2) data-disabled:hover:shadow-none",
					className,
				)}
			>
				{/*
				 * Select.Value 会渲染当前选中项的 ItemText 内容；
				 * 未选中时显示 placeholder。
				 * 用 truncate 限制宽度溢出，字号与下拉项一致避免切换时"跳字"。
				 */}
				<span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-[12px] font-medium">
					<SelectPrimitive.Value placeholder={placeholder} />
				</span>
				<SelectPrimitive.Icon
					asChild
					className="shrink-0 text-(--text-4) transition-colors duration-150 group-hover:text-(--text-2) group-data-[state=open]:text-(--text)"
				>
					<ChevronDown size={12} strokeWidth={1.75} />
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>

			{/*
			 * Portal —— 下拉内容挂载到 #portal-root（<body> 下与 #root 并列的
			 * 兄弟节点），而不是默认的 document.body。
			 *
			 * 为什么不用默认的 body：
			 *   ThemeSync 会在 `#root` 上写 inline `zoom: <pct>%` 实现整体界面
			 *   缩放。若 Portal 挂到 body，内容自然也进入 zoom 子树，但 Radix
			 *   popper 定位通过 `trigger.getBoundingClientRect()` 读到的是**物理
			 *   视口坐标**（已含 zoom 放大），再写到 Portal 内容的
			 *   `transform: translate(x, y)` 上 —— 此时 translate 值会被 zoom
			 *   **二次放大**，下拉面板向右下偏移，缩放越大偏移越明显（110%
			 *   时肉眼可见，150% 时完全错位）。
			 *
			 *   把 Portal 挂到 zoom 子树外的 `#portal-root` 后，transform 值
			 *   按 1:1 解释，popper 定位精确对齐触发按钮。代价是下拉面板
			 *   本身**不跟随缩放**（按 100% 物理尺寸渲染），这在桌面端符合
			 *   系统级下拉控件的惯例（macOS / Windows 原生 Select 菜单都
			 *   不随应用内缩放变化）。
			 *
			 * container 在 SSR / 容器暂未挂载时会是 null，此时 Radix 回落到
			 * 默认 body 行为，无需额外空判断。
			 */}
			<SelectPrimitive.Portal
				container={
					typeof document !== "undefined"
						? document.getElementById("portal-root")
						: null
				}
			>
				<SelectPrimitive.Content
					/*
					 * position="popper" + side/align 让 Radix 用 popper 定位策略：
					 *   - 默认显示在触发按钮下方
					 *   - 空间不够时自动翻到上方
					 *   - 对齐触发按钮的起始边
					 * sideOffset=6 与自写版本的 GAP 一致。
					 */
					position="popper"
					side="bottom"
					align="start"
					sideOffset={6}
					className={clsx(
						"z-50 min-w-(--radix-select-trigger-width) overflow-hidden",
						// 改用 .zpass-glass 让浮层带玻璃质感（与 CmdK / Dropdown 一致）
						"zpass-glass rounded-(--radius)",
						// 说明：
						//   早先此处用了 `animate-in / fade-in-0 / zoom-in-95` 等类名，
						//   它们属于 `tw-animate-css` / `tailwindcss-animate` 插件。项目
						//   尚未安装这类插件，Tailwind v4 会把它们视为未知 utility 全部
						//   丢弃 —— 结果既没报错也没动画。
						//
						//   为避免引入新依赖，这里改用 Radix 暴露的 data-state 手写一个
						//   极简淡入/淡出 + 轻微缩放。transition 只列具体属性，避免
						//   transition-all 触发布局属性动画。
						"origin-(--radix-select-content-transform-origin)",
						"transition-[opacity,transform] duration-100 ease-out",
						"data-[state=open]:opacity-100 data-[state=open]:scale-100",
						"data-[state=closed]:opacity-0 data-[state=closed]:scale-95",
					)}
				>
					{/*
					 * ScrollUpButton / ScrollDownButton —— 选项较多（超过可视高度）
					 * 时出现的"滚上 / 滚下"小三角。这里给 Settings 场景选项都 ≤3，
					 * 实际不会显示，但保留以兼容未来扩展。
					 */}
					<SelectPrimitive.ScrollUpButton className="flex h-6 cursor-default items-center justify-center text-(--text-3)">
						<ChevronDown size={12} strokeWidth={1.75} className="rotate-180" />
					</SelectPrimitive.ScrollUpButton>
					<SelectPrimitive.Viewport className="flex flex-col gap-0.5 p-1">
						{options.map((opt) => (
							<OptionRow key={opt.value} option={opt} />
						))}
					</SelectPrimitive.Viewport>
					<SelectPrimitive.ScrollDownButton className="flex h-6 cursor-default items-center justify-center text-(--text-3)">
						<ChevronDown size={12} strokeWidth={1.75} />
					</SelectPrimitive.ScrollDownButton>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}

export default Select;
