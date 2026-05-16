import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { Command } from "cmdk";
import {
	Command as CommandIcon,
	KeyRound,
	Lock,
	Moon,
	Plus,
	Search,
	Settings as SettingsIcon,
	ShieldCheck,
	Sun,
	Vault as VaultIcon,
} from "lucide-react";
import type { ComponentType, CSSProperties, SVGProps } from "react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { VaultItemSummary } from "@/lib/vault-api";
import { useLockStore } from "@/stores/lock";
import { usePrefsStore } from "@/stores/prefs";
import { useUIStore } from "@/stores/ui";
import { useVaultStore } from "@/stores/vault";

import { SHORTCUTS, formatShortcut, KEY_SYMBOL } from "@/lib/keys";

// 注：cmdk 的 "新建条目" 命令通过 useUIStore.requestNewItem 触发同样的
// 全局信号（与 Topbar "New" 按钮 / ⌘N 快捷键共用一条事件总线），
// 由 VaultPage 订阅 newItemRequest 计数器变化打开 NewItemDialog。
// 这样三处入口（Topbar / CmdK / Shortcuts）只通过 store 信号通信，
// 不需要彼此直接 import 对方组件。

/**
 * ⌘K 命令面板（Command Palette）—— 基于 pacocoursey/cmdk 库
 * ---------------------------------------------------------------------------
 * 改造背景：
 *   原实现是一份约 550 行的手写代码：自建 <dialog> + 手算高亮 + 手写键盘
 *   导航 + hover/selected 同步。用户反馈"没有任何背景样式 / 鼠标悬浮没效果"，
 *   并明确偏好："可以调研使用现成的组件而不是造轮子"。
 *
 *   改为包装 `cmdk` 库（Paco Coursey 出品，Linear / Vercel / shadcn-ui 同款）：
 *     - 自动过滤 + fuzzy 排序（Command.Input 的输入值会和 Item 的 textContent
 *       / keywords 做匹配，不需要手写 useMemo(results) 逻辑）
 *     - 键盘 ↑↓ 自动驱动 [data-selected] 属性，配合 Tailwind
 *       `data-[selected=true]:…` 一套规则同时覆盖键盘高亮与鼠标悬停
 *     - Command.Dialog 内部用 Radix Dialog，自带 focus trap / portal /
 *       Esc 关闭 / 背景点击关闭 / body scroll lock
 *     - 原生支持 React 19，peerDependencies 明
确声明 ^19
 *
 * 关于 Ctrl+N / Ctrl+P（vim 风格）：
 *   cmdk 默认仅响应 ArrowDown / ArrowUp。为保留 vim / readline 用户体验，
 *   我们在 Command.Input 上挂 onKeyDown 监听：命中 Ctrl+N/P 时 preventDefault
 *   并派发一个合成的 ArrowDown/Up KeyboardEvent 让 cmdk 内部的 reducer 处理。
 *   这样不需要 fork cmdk 源码，也不需要手算 selected 索引。
 *
 * 业务命令：
 *   - 导航命令：vault / generator / health / settings / 锁定 / 切主题 / 新建
 *   - 条目搜索：vault store 里的 VaultItem 列表
 *   两类混排在一个 Command.List 里，用 Command.Group 的 heading 分区。
 */

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/**
 * 屏幕阅读器专用视觉隐藏样式
 * ---------------------------------------------------------------------------
 * 给 Radix Dialog Title / Description 用：视觉上不可见，但保留在可访问树里，
 * 让 aria-labelledby / aria-describedby 仍能指向有效文本节点。等价于 Tailwind
 * 的 sr-only，内联写一份避免依赖插件输出。
 */
const srOnlyStyle: CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	padding: 0,
	margin: -1,
	overflow: "hidden",
	clip: "rect(0, 0, 0, 0)",
	whiteSpace: "nowrap",
	borderWidth: 0,
};

/** 单个导航命令的结构 —— 只在本组件内部使用，不外发 */
interface NavCommand {
	id: string;
	title: string;
	hint: string;
	icon: IconComp;
	run: () => void;
	/** 给 cmdk 用的关键词（辅助搜索匹配），避免用户输入中文但命令只有英文时搜不到 */
	keywords?: string[];
}

/* ─────────────────────────────────────────────────────────────
 * 组件原子
 * ───────────────────────────────────────────────────────────── */

/**
 * 单行命令 —— Command.Item 薄包装
 * ---------------------------------------------------------------------------
 * 样式要点：
 *   - cmdk 会给当前高亮行加 `data-selected="true"`（键盘 ↑↓ 或鼠标悬停都会触发），
 *     我们用 `data-[selected=true]:…` 驱动背景 / 前景 / 左侧竖条
 *   - 左侧竖条用 `before:` 伪元素 + absolute 定位，避免 active 状态下给行加
 *     border 导致文字左右抖动
 *   - hover 和键盘高亮视觉一致（用户反馈"鼠标悬浮也应该有选中效果"）
 */
function ItemRow({
	value,
	keywords,
	onSelect,
	icon: Icon,
	label,
	sublabel,
	right,
	badge,
	iconSlot,
}: {
	value: string;
	keywords?: string[];
	onSelect: () => void;
	icon?: IconComp;
	label: string;
	sublabel?: string;
	/** 右侧辅助内容（通常是快捷键 kbd 或类型徽章） */
	right?: React.ReactNode;
	/** 徽章（如条目类型 LOGIN/CARD） */
	badge?: string;
	/** 自定义左侧图标槽，优先级高于 icon；用于条目行里的两字母缩写方块 */
	iconSlot?: React.ReactNode;
}) {
	return (
		<Command.Item
			value={value}
			keywords={keywords}
			onSelect={onSelect}
			className={clsx(
				// 基础布局
				"group relative mx-2 flex cursor-default items-center gap-2.5 rounded-md pl-3 pr-2.5",
				"text-[13px] text-(--text-2) transition-colors select-none",
				// 行高按是否有副标题决定 —— 条目行略高
				sublabel ? "h-10" : "h-9",
				// 冗余保护：关闭 focus outline —— 高亮态完全由 data-[selected=true] 的背景 + 前景 + 竖条表达；
				// 即便 globals.css 未来被改、cmdk 把 role=option 焦点落到 Item 上，也不会出现"选中底色 + 一圈黑框"的双层视觉
				"outline-none focus:outline-none focus-visible:outline-none",
				// cmdk 选中态 —— 键盘 + 鼠标统一视觉
				"data-[selected=true]:bg-(--bg-hover) data-[selected=true]:text-(--text)",
				// active 状态左侧竖条（absolute，不占布局）
				"before:pointer-events-none before:absolute before:left-1 before:top-1/2 before:h-[55%] before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-transparent",
				"data-[selected=true]:before:bg-(--text)",
				// 禁用项（cmdk 对应 disabled=true）
				"data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40",
			)}
		>
			{/* 左侧图标 / 缩写方块 */}
			{iconSlot ?? (Icon && <Icon size={14} strokeWidth={1.5} />)}

			{/* 文本区 */}
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<span className="truncate">{label}</span>
				{sublabel && (
					<span className="truncate font-mono text-[11px] text-(--text-3)">
						{sublabel}
					</span>
				)}
			</div>

			{/* 条目类型徽章（LOGIN / CARD / NOTE 等） */}
			{badge && (
				<span className="font-mono text-[10px] uppercase text-(--text-4)">
					{badge}
				</span>
			)}

			{/* 右侧快捷键提示 */}
			{right}
		</Command.Item>
	);
}

/* ─────────────────────────────────────────────────────────────
 * 主组件
 * ───────────────────────────────────────────────────────────── */

export function CmdK() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const inputRef = useRef<HTMLInputElement>(null);

	// 全局状态
	const cmdkOpen = useUIStore((s) => s.cmdkOpen);
	const closeCmdk = useUIStore((s) => s.closeCmdk);
	const requestNewItem = useUIStore((s) => s.requestNewItem);
	const items = useVaultStore((s) => s.items);
	const selectItem = useVaultStore((s) => s.selectItem);
	const lock = useLockStore((s) => s.lock);
	const theme = usePrefsStore((s) => s.theme);
	const toggleTheme = usePrefsStore((s) => s.toggleTheme);

	/**
	 * 导航命令集合
	 * ---------------------------------------------------------------------------
	 * - keywords 里加中英文别名，提升中文用户在搜"设置 / setting"时的命中率
	 * - run() 内部统一：先关面板、再执行副作用（导航 / 调用 store）
	 *   例外是"切主题"—— 执行后保持面板打开，便于用户立刻继续操作
	 */
	const navCommands: NavCommand[] = useMemo(
		() => [
			{
				id: "nav-vault",
				title: t("cmdk_nav_vault"),
				hint: "G V",
				icon: VaultIcon,
				keywords: ["vault", "保险库", "主页", "home"],
				run: () => {
					closeCmdk();
					navigate("/vault");
				},
			},
			{
				id: "nav-gen",
				title: t("cmdk_nav_gen"),
				hint: "G G",
				icon: KeyRound,
				keywords: ["generator", "生成", "密码"],
				run: () => {
					closeCmdk();
					navigate("/generator");
				},
			},
			{
				id: "nav-health",
				title: t("cmdk_nav_health"),
				hint: "G H",
				icon: ShieldCheck,
				keywords: ["health", "security", "安全", "健康"],
				run: () => {
					closeCmdk();
					navigate("/health");
				},
			},
			{
				id: "nav-settings",
				title: t("cmdk_nav_settings"),
				hint: "G S",
				icon: SettingsIcon,
				keywords: ["settings", "preferences", "设置", "偏好"],
				run: () => {
					closeCmdk();
					navigate("/settings");
				},
			},
			{
				id: "nav-new",
				title: t("cmdk_nav_new"),
				hint: formatShortcut(SHORTCUTS.NEW_ITEM),
				icon: Plus,
				keywords: ["new", "create", "新建", "添加"],
				run: () => {
					closeCmdk();
					// 不在 /vault 时先跳过去，让 VaultPage 挂载后能响应信号
					navigate("/vault");
					// rAF 让 navigate 先生效，避免 VaultPage 还没挂载就拿不到信号
					requestAnimationFrame(() => {
						requestNewItem();
					});
				},
			},
			{
				id: "nav-lock",
				title: t("cmdk_nav_lock"),
				hint: formatShortcut(SHORTCUTS.LOCK),
				icon: Lock,
				keywords: ["lock", "锁定", "退出"],
				run: () => {
					closeCmdk();
					lock();
				},
			},
			{
				id: "nav-theme",
				title: t("cmdk_nav_theme"),
				hint: "T",
				icon: theme === "dark" ? Sun : Moon,
				keywords: ["theme", "dark", "light", "主题", "深色", "浅色"],
				run: () => {
					toggleTheme();
					// 切主题后保持面板打开，便于用户直接继续操作
				},
			},
		],
		[t, navigate, closeCmdk, lock, theme, toggleTheme, requestNewItem],
	);

	/**
	 * 打开 dialog 后自动聚焦输入框
	 * ---------------------------------------------------------------------------
	 * Command.Dialog 内部使用 Radix Dialog，开启时会自动把焦点放到首个可聚焦
	 * 元素。但我们希望无论 DOM 顺序，首帧焦点一定落在搜索输入框上 —— 用一个
	 * rAF 兜底更可靠。
	 */
	useEffect(() => {
		if (!cmdkOpen) return;
		const raf = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(raf);
	}, [cmdkOpen]);

	/**
	 * Ctrl+N / Ctrl+P 支持（vim / readline 风格）
	 * ---------------------------------------------------------------------------
	 * cmdk 仅原生响应 ArrowDown / ArrowUp。我们在 Input 上额外监听：
	 *   - 严格判定"仅按 Ctrl"（排除 Shift/Alt/Meta，避免误吞 Ctrl+Shift+N 等）
	 *   - 命中后 preventDefault 并派发一个合成的 ArrowDown/Up keydown
	 *     事件给同一个 input 节点；cmdk 内部的 reducer 会把合成事件当作
	 *     真的方向键处理，从而推进 data-selected 状态
	 *
	 * 为什么不直接改 useState(selected)：
	 *   cmdk 的 selected 状态不是我们管理的（它在内部 Context 里），
	 *   我们只能通过"模拟用户按了方向键"的方式驱动它。这种方式是 cmdk 作者
	 *   在 GitHub issues 里推荐的兼容做法（不需要 patch 库源码）。
	 */
	const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		const isPlainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
		if (!isPlainCtrl) return;
		let mapped: "ArrowDown" | "ArrowUp" | null = null;
		if (e.key === "n" || e.key === "N") mapped = "ArrowDown";
		else if (e.key === "p" || e.key === "P") mapped = "ArrowUp";
		if (!mapped) return;

		e.preventDefault();
		// 派发合成方向键事件给 cmdk 的 Input（bubbles=true 让外层 Command 拿到）
		const synth = new KeyboardEvent("keydown", {
			key: mapped,
			code: mapped,
			bubbles: true,
			cancelable: true,
		});
		e.currentTarget.dispatchEvent(synth);
	};

	/**
	 * 条目行点击 / 回车
	 * ---------------------------------------------------------------------------
	 * cmdk 的 onSelect 回调会把 Item 的 value 作为参数返回。为避免依赖字符串
	 * 解析，我们直接在回调的闭包里引用对应的 item 实例。
	 */
	// VaultItemSummary（不含 fields）已经足够命令面板使用 —— 行点击只需要
	// id 来切换路由 / 选中条目；详情字段（username / password 等）会在
	// VaultPage 选中后由 fetchItem 按需拉取。
	const runItem = (item: VaultItemSummary) => {
		// 走 `/vault?filter=<类型>` 而不是 `/vault/:id`，是为了让 Sidebar.NavRow
		// 能在跳转后高亮对应分类（exactSearch 要求 pathname === '/vault'）。
		// VaultPage 不从 URL 同步 :itemId，详情聚焦仅靠 selectItem。
		selectItem(item.id);
		closeCmdk();
		navigate(`/vault?filter=${item.type}`);
	};

	// 条目行限制到最多 10 条；cmdk 会按输入过滤，我们只负责提供候选池
	const vaultCandidates = useMemo(() => items.slice(0, 20), [items]);

	return (
		<Command.Dialog
			open={cmdkOpen}
			onOpenChange={(open) => {
				if (!open) closeCmdk();
			}}
			label={t("cmdk_placeholder")}
			/*
			 * overlayClassName / contentClassName 是 cmdk 提供给底层 Radix Dialog
			 * 的 overlay / content 样式入口。这里做的事：
			 *   - overlay：半透明 backdrop（颜色与 globals.css 中 dialog::backdrop 一致）
			 *   - content：固定宽度面板，居中，黑白高级感配色
			 * 所有定位 / focus trap / esc 关闭由 Radix Dialog 负责，我们只管皮肤。
			 */
			overlayClassName="fixed inset-0 z-40 zpass-backdrop data-[state=open]:opacity-100 data-[state=closed]:opacity-0 transition-opacity duration-150"
			contentClassName={clsx(
				"fixed left-1/2 top-[18vh] z-50 w-full max-w-[640px] -translate-x-1/2 px-4",
				"focus:outline-none",
				// 入场动画：从上方 6px 微微下落 + 淡入 + 95% 缩放
				"data-[state=open]:animate-[zpass-dialog-in_180ms_ease-out]",
			)}
		>
			{/*
			 * 无障碍 —— Radix Dialog Title / Description
			 * -----------------------------------------------------------------
			 * cmdk 的 <Command.Dialog> 内部用的是 Radix Dialog，但只给 Content
			 * 传了 aria-label，未渲染 DialogTitle / DialogDescription。Radix 在
			 * 开发模式下会发两条 warning：
			 *   - "DialogContent requires a DialogTitle..."
			 *   - "Missing Description or aria-describedby={undefined}..."
			 * Radix 的 Title / Description 通过 DialogContext 自动把自身 id 注册
			 * 给 Content（设置 aria-labelledby / aria-describedby），所以放在
			 * 这里（Content 的子树里）就能消除警告。用 sr-only 内联样式视觉隐藏，
			 * 屏幕阅读器仍能朗读。
			 */}
			<RadixDialog.Title style={srOnlyStyle}>
				{t("cmdk_a11y_title")}
			</RadixDialog.Title>
			<RadixDialog.Description style={srOnlyStyle}>
				{t("cmdk_a11y_description")}
			</RadixDialog.Description>

			{/*
			 * 面板外壳
			 * -----------------------------------------------------------------
			 * Command.Dialog 不会自带视觉样式，需要我们在内部再包一层 div 画
			 * 真正的"卡片"。contentClassName 负责定位，这里负责外观。
			 *
			 * 视觉：使用 .zpass-glass 让面板带玻璃质感（轻微透出后景），
			 * 配合外层 .zpass-backdrop 形成 visionOS 风的浮层层级。
			 */}
			<div className="zpass-glass flex flex-col overflow-hidden rounded-xl shadow-lg">
				{/* 输入条 */}
				<div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-(--line-soft) px-4">
					<Search size={15} strokeWidth={1.5} className="text-(--text-3)" />
					<Command.Input
						ref={inputRef}
						placeholder={t("cmdk_placeholder")}
						onKeyDown={onInputKeyDown}
						className="flex-1 border-0 bg-transparent text-[14px] text-(--text) outline-none placeholder:text-(--text-4)"
					/>
					<kbd className="rounded-sm border border-(--line) bg-(--bg-elev-2) px-1.5 py-0.5 font-mono text-[10px] text-(--text-3)">
						ESC
					</kbd>
				</div>

				{/* 结果列表 */}
				<Command.List className="flex max-h-[50vh] flex-col overflow-y-auto py-2">
					<Command.Empty className="px-4 py-12 text-center text-sm text-(--text-3)">
						{t("cmdk_empty")}
					</Command.Empty>

					{/* 命令组 —— 导航动作 */}
					<Command.Group
						heading={t("cmdk_commands")}
						className={clsx(
							// Group 自身只负责标题样式，具体行样式在 ItemRow 里
							"**:[[cmdk-group-heading]]:px-4 **:[[cmdk-group-heading]]:py-1.5",
							"**:[[cmdk-group-heading]]:font-mono **:[[cmdk-group-heading]]:text-[10px]",
							"**:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-[0.08em]",
							"**:[[cmdk-group-heading]]:text-(--text-4)",
						)}
					>
						{navCommands.map((cmd) => (
							<ItemRow
								key={cmd.id}
								value={cmd.id}
								keywords={[cmd.title, ...(cmd.keywords ?? [])]}
								onSelect={cmd.run}
								icon={cmd.icon}
								label={cmd.title}
								right={
									<kbd className="rounded-sm border border-(--line) bg-(--bg-elev-2) px-1.5 py-0.5 font-mono text-[10px] text-(--text-3)">
										{cmd.hint}
									</kbd>
								}
							/>
						))}
					</Command.Group>

					{/* 条目组 —— vault 数据 */}
					<Command.Group
						heading={t("cmdk_items")}
						className={clsx(
							"**:[[cmdk-group-heading]]:px-4 **:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:pb-1.5",
							"**:[[cmdk-group-heading]]:font-mono **:[[cmdk-group-heading]]:text-[10px]",
							"**:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-[0.08em]",
							"**:[[cmdk-group-heading]]:text-(--text-4)",
						)}
					>
						{vaultCandidates.map((item) => {
							// VaultItemSummary 只包含 name / type / 时间戳 ——
							// 详细字段（username / url / email）在加密 payload 内，
							// 命令面板出于"快速且不阻塞"的诉求只用 name + type
							// 参与搜索；用户键入更精确的关键词时仍能命中条目名。
							//
							// 未来若要支持"按用户名 / 站点 URL 模糊搜索"，需要在
							// 解锁后预先解密所有 payload 进内存索引（vaultApi 可以
							// 加 listItemsFull 接口）；当前阶段保持简单。
							const kw: string[] = [item.name, item.type];

							return (
								<ItemRow
									key={item.id}
									// 用 item.id 作 value 保证唯一；keywords 提供可搜索文本
									value={`item-${item.id}`}
									keywords={kw}
									onSelect={() => runItem(item)}
									label={item.name}
									sublabel={item.type.toUpperCase()}
									badge={item.type.toUpperCase()}
									iconSlot={
										<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-(--line) bg-(--bg-elev-2) font-mono text-[10px] text-(--text-2)">
											{item.name.slice(0, 2).toUpperCase()}
										</div>
									}
								/>
							);
						})}
					</Command.Group>
				</Command.List>

				{/* 底栏 —— 快捷键提示 */}
				<div className="flex h-9 shrink-0 items-center gap-4 border-t border-(--line-soft) px-4 font-mono text-[11px] text-(--text-3)">
					<span className="flex items-center gap-1.5">
						{/*
						 * 同时展示 ↑↓ 与 vim/readline 风格的"下一项"键
						 *   - mac:    ⌃N
						 *   - win/linux: Ctrl+N
						 * 由 formatShortcut(SHORTCUTS.CMDK_NAV_NEXT) 跨平台渲染
						 */}
						<kbd className="rounded-sm border border-(--line) bg-(--bg-elev-2) px-1 py-0.5 text-[9px]">
							{KEY_SYMBOL.up}
							{KEY_SYMBOL.down}
						</kbd>
						<span className="text-(--text-4)">/</span>
						<kbd className="rounded-sm border border-(--line) bg-(--bg-elev-2) px-1 py-0.5 text-[9px]">
							{formatShortcut(SHORTCUTS.CMDK_NAV_NEXT)}
						</kbd>
						{t("cmdk_navigate")}
					</span>
					<span className="flex items-center gap-1.5">
						<kbd className="rounded-sm border border-(--line) bg-(--bg-elev-2) px-1 py-0.5 text-[9px]">
							{KEY_SYMBOL.enter}
						</kbd>
						{t("cmdk_select")}
					</span>
					<span className="flex items-center gap-1.5">
						{/* 关闭/切换面板：mac → ⌘K，win/linux → Ctrl+K */}
						<kbd className="rounded-sm border border-(--line) bg-(--bg-elev-2) px-1 py-0.5 text-[9px]">
							{formatShortcut(SHORTCUTS.CMDK_OPEN)}
						</kbd>
						{t("cmdk_toggle")}
					</span>
					{/* 右侧品牌标识 —— 原 `zpass://palette` 占位字符串无实际跳转，
					 * 改成简短的品牌字样，与 Linear/Raycast 命令面板尾部信息
					 * 风格一致：告知用户 "我在用什么"，不引入死链接。
					 */}
					<div className="ml-auto flex items-center gap-1.5 text-(--text-4)">
						<CommandIcon size={11} strokeWidth={1.5} />
						<span>ZPass</span>
					</div>
				</div>
			</div>
		</Command.Dialog>
	);
}

export default CmdK;
