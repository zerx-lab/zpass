import * as Popover from "@radix-ui/react-popover";
import { clsx } from "clsx";
import { Check, ChevronDown, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

export interface FontSelectProps {
	/** 当前选中字体名，空串 = 使用系统默认 */
	value: string;
	onChange: (font: string) => void;
	/** 全量字体名列表（已排序，内置字体在最前） */
	fonts: string[];
	/** 空值时显示的标签，如 "Default (Geist)" */
	defaultLabel: string;
	ariaLabel?: string;
	className?: string;
	/** 字体列表加载中 */
	loading?: boolean;
	/** 搜索无结果时的提示文字 */
	noResultsLabel?: string;
}

export function FontSelect({
	value,
	onChange,
	fonts,
	defaultLabel,
	ariaLabel,
	className,
	loading = false,
	noResultsLabel = "No fonts found",
}: FontSelectProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	/** 打开时重置搜索词，同时在下一帧聚焦搜索框 */
	function handleOpenChange(next: boolean) {
		setOpen(next);
		if (next) {
			setQuery("");
			// 等 Popover 内容挂载到 DOM 后再聚焦
			requestAnimationFrame(() => {
				inputRef.current?.focus();
			});
		}
	}

	/** 过滤后的字体列表（useMemo 避免每次渲染重跑） */
	const filtered = useMemo(() => {
		if (!query.trim()) return fonts;
		const q = query.trim().toLowerCase();
		return fonts.filter((f) => f.toLowerCase().includes(q));
	}, [fonts, query]);

	/** 点击某一项：调 onChange 并关闭 */
	function select(font: string) {
		onChange(font);
		setOpen(false);
	}

	/** 触发按钮展示文字 */
	const displayLabel = value || defaultLabel;

	return (
		<Popover.Root open={open} onOpenChange={handleOpenChange}>
			{/* ── 触发按钮：样式严格对齐 Select.tsx 的 Trigger ── */}
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={ariaLabel}
					className={clsx(
						"group inline-flex h-8 min-w-[170px] items-center gap-1.5 rounded-(--radius) border bg-(--bg-elev-2) px-2.5",
						"transition-[background-color,border-color,box-shadow,color] duration-150",
						"border-(--line) text-(--text)",
						"outline-none focus:outline-none focus-visible:outline-none",
						"hover:border-(--text-3) hover:bg-(--bg-hover) hover:shadow-sm",
						// open 态复用 data-[state=open] 等价：通过 aria-expanded 驱动
						open && "border-(--text-2) bg-(--bg-active) shadow-sm",
						"disabled:cursor-not-allowed disabled:opacity-60",
						className,
					)}
				>
					<span className="flex min-w-0 flex-1 items-center truncate text-left text-[12px] font-medium">
						{loading ? (
							<span className="text-(--text-3)">Loading…</span>
						) : (
							// title 给浏览器原生 tooltip —— 字体全名经常很长（如
							// "Maple Mono NF CN Medium"），按钮宽度有限会被 truncate 截掉，
							// 鼠标悬停时通过 title 把全称显示出来，避免用户看不到完整名字。
							<span
								style={value ? { fontFamily: value } : undefined}
								className="truncate"
								title={displayLabel}
							>
								{displayLabel}
							</span>
						)}
					</span>
					<ChevronDown
						size={12}
						strokeWidth={1.75}
						className={clsx(
							"shrink-0 text-(--text-4) transition-[transform,color] duration-150",
							"group-hover:text-(--text-2)",
							open && "rotate-180 text-(--text)",
						)}
					/>
				</button>
			</Popover.Trigger>

			{/* ── 下拉弹出层：挂到 #portal-root（与 Select 保持一致） ── */}
			<Popover.Portal
				container={
					typeof document !== "undefined"
						? (document.getElementById("portal-root") ?? document.body)
						: undefined
				}
			>
				<Popover.Content
					side="bottom"
					align="start"
					sideOffset={6}
					// min-w 跟随触发按钮宽度（Radix Popover CSS 变量）
					className={clsx(
						"z-50 w-(--radix-popover-trigger-width)",
						"zpass-glass rounded-(--radius)",
						"origin-(--radix-popover-content-transform-origin)",
						"transition-[opacity,transform] duration-100 ease-out",
						"data-[state=open]:opacity-100 data-[state=open]:scale-100",
						"data-[state=closed]:opacity-0 data-[state=closed]:scale-95",
						"flex flex-col overflow-hidden",
					)}
					// 避免点击 Input 时 Popover 意外关闭
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					{/* ── 搜索框区域 ── */}
					<div className="flex items-center gap-2 px-2.5 py-2 border-b border-(--line-soft)">
						<Search
							size={12}
							strokeWidth={1.75}
							className="shrink-0 text-(--text-4)"
						/>
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search fonts…"
							className={clsx(
								"flex-1 bg-transparent text-[12px] text-(--text) placeholder:text-(--text-4)",
								"outline-none focus:outline-none border-none",
								"min-w-0",
							)}
						/>
					</div>

					{/* ── 字体列表 ── */}
					<div
						className="flex flex-col overflow-y-auto py-1"
						style={{
							maxHeight: 280,
							// 提示浏览器优化滚动性能
							willChange: "scroll-position",
						}}
					>
						{/* 「默认」项：始终显示 */}
						<FontItem
							label={defaultLabel}
							font=""
							isSelected={value === ""}
							onSelect={() => select("")}
						/>

						{/* 过滤后的字体项 */}
						{filtered.length === 0 ? (
							<div className="flex items-center justify-center h-8 text-[12px] text-(--text-4) select-none">
								{noResultsLabel}
							</div>
						) : (
							filtered.map((font) => (
								<FontItem
									key={font}
									label={font}
									font={font}
									isSelected={value === font}
									onSelect={() => select(font)}
								/>
							))
						)}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** 单个字体列表项 */
function FontItem({
	label,
	font,
	isSelected,
	onSelect,
}: {
	label: string;
	font: string;
	isSelected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			// title 提供原生 tooltip —— 列表项被 truncate 截断后用户
			// 鼠标悬停仍能看到字体的完整名称。
			title={label}
			className={clsx(
				"relative flex h-8 w-full cursor-default items-center gap-2 px-2 pr-7",
				"text-[12.5px] text-left text-(--text-2) select-none",
				"outline-none focus:outline-none focus-visible:outline-none",
				"transition-colors duration-75",
				"hover:bg-(--bg-hover) hover:text-(--text)",
				isSelected && "text-(--text)",
			)}
		>
			<span
				className="flex-1 truncate"
				// 字体名用该字体渲染，直观预览字形
				style={font ? { fontFamily: font } : undefined}
			>
				{label}
			</span>
			{isSelected && (
				<span className="absolute right-2 inline-flex items-center">
					<Check size={12} strokeWidth={2} className="text-(--text)" />
				</span>
			)}
		</button>
	);
}

export default FontSelect;
