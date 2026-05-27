import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { clsx } from "clsx";
import {
	Check,
	ChevronsUpDown,
	Plus,
	Settings as SettingsIcon,
} from "lucide-react";
import { forwardRef, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { SpaceAvatar } from "@/components/SpaceAvatar";
import { SHORTCUTS, formatShortcut } from "@/lib/keys";
import { type Space, useActiveSpace, useSpacesStore } from "@/stores/spaces";

/**
 * Workspace Switcher —— 侧边栏顶部空间切换器
 * ---------------------------------------------------------------------------
 * 改造背景：
 *   原版是约 470 行手写 popover（createPortal + 手算 top/left + 手写点击
 *   外部关闭 + 手写 onKeyDown）。用户反馈"可以调研使用现成的组件而不是造轮子"，
 *   且截图中 popover 在浅色主题下视觉层级不够清晰。
 *
 *   改为包装 @radix-ui/react-dropdown-menu：
 *     - 定位由 @radix-ui/react-popper 负责，自动处理视口翻转 / scroll 跟随
 *     - 键盘 ↑↓ / Home / End / Esc / Tab 全由 Radix 接管
 *     - 内置 focus trap 与 DismissableLayer（点击外部自动关闭）
 *     - 提供 `[data-highlighted]` 属性可用 `data-highlighted:…` 直接出样式
 *     - a11y：role=menu / menuitem / menuitemradio 语义完备
 *
 * 特殊点：
 *   "新建空间"是一个内联输入态 —— 在 DropdownMenu 打开期间动态切换到输入框。
 *   Radix 的 Item 默认会在 click 后关闭菜单，为了让"点击 New workspace"只
 *   切换内部子态而不关菜单，需要在 Item 的 onSelect 里调用 `event.preventDefault()`。
 *   这是 Radix 官方文档推荐的 submenu / form 入口模式。
 *
 *   输入框需要稳定焦点（不能被 DropdownMenu 的自动焦点管理拉走），用 useEffect
 *   + rAF 在 creating=true 时手动聚焦。
 */

/* ─────────────────────────────────────────────────────────────
 * 触发按钮
 * ─────────────────────────────────────────────────────────────
 * Radix 要求 `asChild` 子元素必须能接收所有透传 props（aria-* / data-state /
 * onClick / onKeyDown 等）和 ref。因此用 forwardRef 包一层标准 <button>，
 * 把 active / fallbackTag 作为自定义 props，其余 props 用 ...rest 透传。
 *
 * 视觉：
 *   - hover 态：bg-hover（比底色稍深）
 *   - open 态（data-state=open）：bg-active（最深）
 *   - Chevron 颜色跟随 open 状态变深，强化"已展开"反馈
 */
interface TriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	active: Space;
	fallbackTag: string;
	collapsed?: boolean;
}

const SwitcherTrigger = forwardRef<HTMLButtonElement, TriggerProps>(
	function SwitcherTrigger(
		{ active, fallbackTag, collapsed, className, ...rest },
		ref,
	) {
		// 收起态：只渲染头像方块（图片或字形），居中显示，不展示名称和 chevron
		if (collapsed) {
			return (
				<button
					ref={ref}
					type="button"
					aria-label={active.name}
					title={active.name}
					{...rest}
					className={clsx(
						"group mx-auto mt-3 mb-2 flex h-7 w-7 items-center justify-center rounded-(--radius)",
						"outline-none transition-colors hover:bg-(--bg-hover)",
						"focus:outline-none focus-visible:outline-none",
						"data-[state=open]:bg-(--bg-active)",
						className,
					)}
				>
					<SpaceAvatar
						space={active}
						className="h-7 w-7 rounded-(--radius) text-[13px]"
					/>
				</button>
			);
		}

		return (
			<button
				ref={ref}
				type="button"
				aria-label="Switch workspace"
				{...rest}
				className={clsx(
					"group mx-2 mt-3 mb-2 flex h-10 w-[calc(100%-1rem)] items-center gap-2.5 rounded-(--radius) px-2",
					"transition-colors",
					"hover:bg-(--bg-hover)",
					"data-[state=open]:bg-(--bg-active)",
					// 键盘聚焦走 globals.css §"聚焦样式" 统一 outline（1px var(--text)
					// + offset 2px）。这里不再写局部 ring/outline-none —— 与 §6 对齐。
					className,
				)}
			>
				{/* 空间头像方块（图片或字形）—— 代替原固定 "Z" 标志 */}
				<SpaceAvatar
					space={active}
					className="h-7 w-7 rounded-(--radius) text-[13px]"
				/>
				<div className="flex min-w-0 flex-1 flex-col leading-tight text-left">
					<span className="truncate text-[13px] font-semibold tracking-tight text-(--text)">
						{active.name}
					</span>
					<span className="truncate text-[10.5px] text-(--text-3)">
						{active.tag ?? fallbackTag}
					</span>
				</div>
				<ChevronsUpDown
					size={13}
					strokeWidth={1.5}
					/*
					 * group-data-[state=open] —— Radix 在触发按钮上加 data-state="open"，
					 * 这里让 Chevron 颜色同步变深。
					 */
					className="shrink-0 text-(--text-4) transition-colors group-hover:text-(--text-3) group-data-[state=open]:text-(--text-2)"
				/>
			</button>
		);
	},
);

/* ─────────────────────────────────────────────────────────────
 * 主组件
 * ───────────────────────────────────────────────────────────── */

/**
 * 降级态触发按钮 —— 当 useActiveSpace 返回 null 时渲染
 * ---------------------------------------------------------------------------
 * 触发条件：
 *   首次启动、尚未创建任何空间；或配置文件被外部清空后重启。
 *   正常产品流程下 OnboardingGuard 会把这种用户挡在 /onboarding，不会
 *   让他们进入渲染 Sidebar 的 AppShell；但为了覆盖"配置文件被外部清空"
 *   等极端场景，这里提供一个可点击的降级按钮，引导用户回到 onboarding。
 *
 * 为什么抽成独立组件：
 *   主组件 WorkspaceSwitcher 用了 useState / useEffect / useRef 等 hooks，
 *   如果在 hooks 之间用 `if (!active) return ...` 做 early return，会违反
 *   React Hooks 规则（必须在每次渲染中以同一顺序调用所有 hooks）。
 *   把降级态拆成一个独立的、不调用 hooks 的叶子组件，由父组件在进入任何
 *   hook 之前根据 active 做条件渲染，既满足 Hooks 规则又保留防御性。
 */
function WorkspaceSwitcherFallback({ collapsed }: { collapsed?: boolean }) {
	const { t } = useTranslation();
	const navigate = useNavigate();

	if (collapsed) {
		return (
			<div className="flex justify-center px-1.5 pt-3 pb-2">
				<button
					type="button"
					aria-label="Create workspace"
					onClick={() => navigate("/onboarding")}
					title={t("workspace_new")}
					className="flex h-7 w-7 items-center justify-center rounded-(--radius) border border-(--line) border-dashed bg-(--bg-elev-2) font-mono text-[13px] font-semibold text-(--text-3) transition-colors hover:bg-(--bg-hover) hover:text-(--text)"
				>
					+
				</button>
			</div>
		);
	}

	return (
		<button
			type="button"
			aria-label="Create workspace"
			onClick={() => navigate("/onboarding")}
			className="group mx-2 mt-3 mb-2 flex h-10 w-[calc(100%-1rem)] items-center gap-2.5 rounded-(--radius) px-2 outline-none transition-colors hover:bg-(--bg-hover) focus:outline-none focus-visible:outline-none"
		>
			<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius) border border-(--line) border-dashed bg-(--bg-elev-2) font-mono text-[13px] font-semibold text-(--text-3)">
				+
			</div>
			<div className="flex min-w-0 flex-1 flex-col leading-tight text-left">
				<span className="truncate text-[13px] font-semibold tracking-tight text-(--text-2)">
					{t("workspace_new")}
				</span>
				<span className="truncate text-[10.5px] text-(--text-4)">
					{t("brand_tag")}
				</span>
			</div>
		</button>
	);
}

/**
 * WorkspaceSwitcher 主组件
 *
 * 先做一次 active 判空 —— 没有激活空间时直接委派给
 * WorkspaceSwitcherFallback（不调用任何 hooks 之后才 return，满足
 * Hooks 规则），正常态才进入完整实现。
 */
export function WorkspaceSwitcher({ collapsed }: { collapsed?: boolean }) {
	const active = useActiveSpace();
	if (!active) {
		return <WorkspaceSwitcherFallback collapsed={collapsed} />;
	}
	return <WorkspaceSwitcherMain active={active} collapsed={collapsed} />;
}

/**
 * 主实现 —— 已保证 active 非 null
 *
 * 把原函数体移到这里并接收 active 作为 prop，组件内部调用的所有 hooks
 * 都在同一个稳定的渲染路径上，永远不会因为 active 变化而出现"某次渲染
 * 少调用了一个 hook"的情况。
 */
function WorkspaceSwitcherMain({
	active,
	collapsed,
}: {
	active: Space;
	collapsed?: boolean;
}) {
	const { t } = useTranslation();
	const navigate = useNavigate();

	const spaces = useSpacesStore((s) => s.spaces);
	const switchSpace = useSpacesStore((s) => s.switchSpace);
	const createSpace = useSpacesStore((s) => s.createSpace);

	// Radix 受控 open —— 需要能从"新建提交成功"后主动关闭菜单
	const [open, setOpen] = useState(false);

	// "新建空间"内联输入态
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState("");
	const createInputRef = useRef<HTMLInputElement>(null);

	// 菜单关闭时重置创建态，避免下次打开残留
	useEffect(() => {
		if (!open) {
			setCreating(false);
			setDraftName("");
		}
	}, [open]);

	// 进入创建态时把焦点抢到输入框；rAF 确保在 Radix 焦点管理之后执行
	useEffect(() => {
		if (!creating) return;
		const raf = requestAnimationFrame(() => {
			createInputRef.current?.focus();
		});
		return () => cancelAnimationFrame(raf);
	}, [creating]);

	/** 选中某个空间 —— 仅在与当前不同时切换；然后关菜单
	 *
	 * 此时 active 已经通过上方 early return 保证非 null，可以安全解引用。
	 */
	const handleSelectSpace = (id: string) => {
		if (id !== active.id) switchSpace(id);
		setOpen(false);
	};

	/** 提交创建 —— 空名称则退出创建态不报错 */
	const submitCreate = () => {
		const name = draftName.trim();
		if (!name) {
			setCreating(false);
			return;
		}
		createSpace({ name });
		setOpen(false); // useEffect 会清 creating / draftName
	};

	const onDraftKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			submitCreate();
		} else if (e.key === "Escape") {
			// Esc 仅退出创建态，不关整个菜单；stopPropagation 防止 Radix 吞 Esc 关菜单
			e.preventDefault();
			e.stopPropagation();
			setCreating(false);
			setDraftName("");
		}
	};

	const openSettings = () => {
		setOpen(false);
		navigate("/settings");
	};

	return (
		<DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
			{/*
			 * asChild 让 Trigger 渲染成我们的自定义按钮而不是默认的 div/button。
			 * 配合 forwardRef 的 SwitcherTrigger 正确吃到 Radix 透传的 props + ref。
			 */}
			<DropdownMenu.Trigger asChild>
				<SwitcherTrigger
					active={active}
					fallbackTag={t("brand_tag")}
					collapsed={collapsed}
				/>
			</DropdownMenu.Trigger>

			{/*
			 * Portal 挂载到 #portal-root（<body> 下与 #root 并列的兄弟节点），
			 * 而非默认的 document.body。
			 *
			 * 为什么：ThemeSync 会在 `#root` 上写 inline `zoom: <pct>%` 实现
			 * 整体界面缩放。若 Portal 挂到 body（在 zoom 子树内），Radix popper
			 * 定位通过 `trigger.getBoundingClientRect()` 读到的是**物理视口坐标**
			 * （已含 zoom 放大），再写到 Portal 内容的 `transform: translate(x,y)`
			 * 上，此时 translate 值会被 zoom **二次放大**，下拉面板向右下偏移，
			 * 缩放越大偏移越明显。挂到 zoom 子树外的 #portal-root 后，
			 * translate 值按 1:1 解释，定位精确。代价是下拉面板本身不跟随
			 * 缩放（按 100% 物理尺寸渲染），符合系统级下拉菜单的惯例。
			 *
			 * container 为 null 时 Radix 回落默认 body 行为，无需额外空判断。
			 */}
			<DropdownMenu.Portal
				container={
					typeof document !== "undefined"
						? document.getElementById("portal-root")
						: null
				}
			>
				<DropdownMenu.Content
					/*
					 * align=start + side=bottom + sideOffset=6：
					 *   - 从触发按钮下方展开、左对齐；空间不够时 Radix 会自动翻到上方
					 * loop：键盘 ↑↓ 到首/末时循环
					 * collisionPadding：距离视口边界 8px，防贴边
					 */
					align="start"
					side="bottom"
					sideOffset={6}
					loop
					collisionPadding={8}
					className={clsx(
						// 玻璃质感（与 CmdK / Select 浮层一致），替代原硬色 bg-(--bg-elev)
						"z-50 w-61 zpass-glass rounded-(--radius)",
						"outline-none",
						// 淡入淡出 —— 用 Radix 暴露的 data-state；不依赖额外动画插件
						"origin-(--radix-dropdown-menu-content-transform-origin)",
						"transition-[opacity,transform] duration-100 ease-out",
						"data-[state=open]:scale-100 data-[state=open]:opacity-100",
						"data-[state=closed]:scale-95 data-[state=closed]:opacity-0",
					)}
				>
					{/* 分组标题 */}
					<DropdownMenu.Label className="px-3 pt-2.5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-(--text-4)">
						{t("workspace_section_title")}
					</DropdownMenu.Label>

					{/* 空间列表 —— RadioGroup 语义（多选一） */}
					<DropdownMenu.RadioGroup
						value={active.id}
						onValueChange={handleSelectSpace}
						className="flex max-h-70 flex-col overflow-y-auto px-1 pb-1"
					>
						{spaces.map((sp) => {
							return (
								<DropdownMenu.RadioItem
									key={sp.id}
									value={sp.id}
									className={clsx(
										"relative flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2 text-[12.5px] text-(--text-2)",
										// 冗余保护：关闭 focus outline —— 高亮态完全由 data-highlighted 的背景 + 前景表达
										"outline-none focus:outline-none focus-visible:outline-none",
										"transition-colors select-none",
										// Radix 给键盘高亮 / 鼠标悬停都加 data-highlighted
										"data-highlighted:bg-(--bg-hover) data-highlighted:text-(--text)",
										"data-[state=checked]:text-(--text)",
									)}
								>
									<SpaceAvatar
										space={sp}
										className="h-6 w-6 rounded-sm text-[11px]"
									/>
									<div className="flex min-w-0 flex-1 flex-col leading-tight text-left">
										<span className="truncate font-medium">{sp.name}</span>
										{sp.tag && (
											<span className="truncate text-[10.5px] text-(--text-4)">
												{sp.tag}
											</span>
										)}
									</div>
									{/*
									 * ItemIndicator 仅在 checked 时渲染；给它外层留个宽度占位，
									 * 避免选中 / 未选中时文字位置发生左右跳动。
									 */}
									<span className="flex w-3 shrink-0 items-center justify-center">
										<DropdownMenu.ItemIndicator>
											<Check
												size={12}
												strokeWidth={2}
												className="text-(--text)"
											/>
										</DropdownMenu.ItemIndicator>
									</span>
								</DropdownMenu.RadioItem>
							);
						})}
					</DropdownMenu.RadioGroup>

					<DropdownMenu.Separator className="h-px bg-(--line-soft)" />

					{/*
					 * 新建空间 —— 两种状态：按钮 / 内联输入
					 * ---------------------------------------------------------------
					 * 按钮态：点击切到 creating=true，保持菜单打开（onSelect 里 preventDefault）
					 * 输入态：独立 div 放在 Menu 内部，不用 Radix Item 包裹
					 *         （输入框需要自由焦点，不应被 Radix 的 arrow key 导航接管）
					 */}
					{creating ? (
						/*
						 * 容器 div 上的 onKeyDown 仅用于阻止 ↑↓ / Home / End 等导航键
						 * 冒泡到 Radix 菜单（否则输入时这些键会把菜单高亮跳走）。
						 * 这不是"交互控件"，真正的交互是内部的 input / button；
						 * 因此抑制 a11y/noStaticElementInteractions 规则。
						 */
						// biome-ignore lint/a11y/noStaticElementInteractions: 容器仅拦截键盘事件冒泡，交互入口是内部的 input 与 button
						<div
							className="flex flex-col gap-1.5 p-2"
							onKeyDown={(e) => {
								if (
									e.key === "ArrowUp" ||
									e.key === "ArrowDown" ||
									e.key === "Home" ||
									e.key === "End"
								) {
									e.stopPropagation();
								}
							}}
						>
							<label
								htmlFor="ws-switcher-new-input"
								className="px-1 font-mono text-[10px] uppercase tracking-[0.08em] text-(--text-4)"
							>
								{t("workspace_new_label")}
							</label>
							<input
								ref={createInputRef}
								id="ws-switcher-new-input"
								value={draftName}
								onChange={(e) => setDraftName(e.target.value)}
								onKeyDown={onDraftKeyDown}
								placeholder={t("workspace_new_placeholder")}
								maxLength={32}
								className={clsx(
									"h-8 rounded-sm border border-(--line) bg-(--bg-elev-2) px-2",
									"text-[12.5px] text-(--text) placeholder:text-(--text-4)",
									"focus:border-(--text-3) focus:outline-none",
								)}
							/>
							<div className="flex items-center justify-end gap-1.5">
								<button
									type="button"
									onClick={() => {
										setCreating(false);
										setDraftName("");
									}}
									className={clsx(
										"h-7 rounded-sm px-2 text-[11.5px] font-medium",
										"text-(--text-3) hover:text-(--text-2)",
									)}
								>
									{t("workspace_cancel")}
								</button>
								<button
									type="button"
									disabled={!draftName.trim()}
									onClick={submitCreate}
									className={clsx(
										"h-7 rounded-sm px-2 text-[11.5px] font-medium transition-colors",
										draftName.trim()
											? "bg-(--text) text-(--bg) hover:opacity-90"
											: "cursor-not-allowed bg-(--bg-elev-2) text-(--text-4)",
									)}
								>
									{t("workspace_create")}
								</button>
							</div>
						</div>
					) : (
						<DropdownMenu.Item
							onSelect={(event) => {
								// 阻止 Radix 默认的"选中即关菜单"，改为切换内部状态
								event.preventDefault();
								setCreating(true);
								setDraftName("");
							}}
							className={clsx(
								"mx-1 mt-1 flex h-9 cursor-default items-center gap-2 rounded-sm px-2 text-[12.5px]",
								"text-(--text-2) transition-colors select-none",
								// 冗余保护：关闭 focus outline
								"outline-none focus:outline-none focus-visible:outline-none",
								"data-highlighted:bg-(--bg-hover) data-highlighted:text-(--text)",
							)}
						>
							<Plus size={13} strokeWidth={1.75} />
							<span className="flex-1 text-left">{t("workspace_new")}</span>
						</DropdownMenu.Item>
					)}

					<DropdownMenu.Separator className="mt-1 h-px bg-(--line-soft)" />

					{/* 全局设置入口 —— 替代原左下角齿轮 */}
					<DropdownMenu.Item
						onSelect={openSettings}
						className={clsx(
							"mx-1 mt-1 mb-1 flex h-9 cursor-default items-center gap-2 rounded-sm px-2 text-[12.5px]",
							"text-(--text-2) transition-colors select-none",
							// 冗余保护：关闭 focus outline
							"outline-none focus:outline-none focus-visible:outline-none",
							"data-highlighted:bg-(--bg-hover) data-highlighted:text-(--text)",
						)}
					>
						<SettingsIcon size={13} strokeWidth={1.5} />
						<span className="flex-1 text-left">{t("topbar_settings")}</span>
						{/* 设置快捷键 hint：mac → ⌘,，win/linux → Ctrl+,
						 * 由 formatShortcut(SHORTCUTS.SETTINGS) 跨平台渲染，
						 * 与全站 kbd 渲染来源一致（避免硬编码 ⌘ 让 Windows 用户困惑）。
						 */}
						<span className="font-mono text-[10px] text-(--text-4)">
							{formatShortcut(SHORTCUTS.SETTINGS)}
						</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

export default WorkspaceSwitcher;
