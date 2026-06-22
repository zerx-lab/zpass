import { clsx } from "clsx";
import {
	ChevronsLeft,
	ChevronsRight,
	CreditCard,
	IdCard,
	KeyRound,
	LogIn,
	ShieldCheck,
	Smartphone,
	StickyNote,
	TerminalSquare,
	Vault as VaultIcon,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";
import { SpaceAvatar } from "@/components/SpaceAvatar";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import type { useSidebar } from "@/lib/useSidebar";
import { useAccountStore } from "@/stores/account";
import { useActiveSpace } from "@/stores/spaces";
import { useVaultStore } from "@/stores/vault";

/**
 * Sidebar — 支持收起/展开 + 拖拽宽度（对标 shadcn/ui Sidebar 能力）
 *
 * 状态由 useSidebar() hook 统一管理（localStorage 持久化）：
 *   - collapsed=false：正常展开，显示图标 + 文字 + 数量，可拖拽右侧分隔线调整宽度
 *   - collapsed=true：icon-only 模式（52px），仅显示图标，hover 时 tooltip 提示文字
 *
 * 分隔线（resize handle）位于 aside 右侧，4px 宽透明热区 + 1px 可见线：
 *   - 正常状态：鼠标悬停变为 col-resize 光标
 *   - 收起状态：点击分隔线 → 展开
 *   - 展开状态：拖拽调整宽度，拖到阈值以下 → snap 收起
 *
 * 宽度/收起状态由父层 AppShell 通过 useSidebar() 同步控制 grid-cols。
 * Sidebar 内部也消费同一个 hook（通过 SidebarContext 共享）。
 *
 * Toggle 按钮：
 *   - 展开态：显示在侧边栏底部账户区右侧（ChevronsLeft）
 *   - 收起态：显示在 icon 栏底部（ChevronsRight）
 *   - 快捷键：⌘B / Ctrl+B（由 Shortcuts.tsx 统一注册）
 */

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

interface NavDef {
	to: string;
	icon: IconComp;
	labelKey: string;
	count?: number;
	badge?: string;
	exactSearch?: boolean;
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function SectionLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
	if (collapsed) {
		// 收起时用细线分隔替代文字 label
		return <div className="mx-3 my-2 h-px bg-(--line)" />;
	}
	return (
		// 对齐 standalone 设计稿 .nav-label：mono 10px / tracking .13em / text-4，
		// 间距 margin:13px 8px 3px（收紧分组间距，原 pt-5 偏大）。
		<div className="mx-2 mt-[13px] mb-[3px] flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.13em] text-(--text-4) first:mt-1">
			{children}
		</div>
	);
}

/**
 * 解析 to 字符串为 { pathname, filter }
 */
function parseTo(to: string): { pathname: string; filter: string | null } {
	const [pathname, search = ""] = to.split("?");
	const params = new URLSearchParams(search);
	return { pathname, filter: params.get("filter") };
}

function NavRow({
	to,
	icon: Icon,
	labelKey,
	count,
	badge,
	exactSearch,
	collapsed,
}: NavDef & { collapsed: boolean }) {
	const { t } = useTranslation();
	const location = useLocation();

	const computeActive = (defaultIsActive: boolean) => {
		if (!exactSearch) return defaultIsActive;
		const target = parseTo(to);
		if (location.pathname !== target.pathname) return false;
		const current = new URLSearchParams(location.search);
		const curFilter = current.get("filter");
		return (target.filter ?? null) === (curFilter ?? null);
	};

	const label = t(labelKey);

	return (
		<NavLink
			to={to}
			end={exactSearch ? false : undefined}
			title={collapsed ? label : undefined}
			className={({ isActive }) => {
				const active = computeActive(isActive);
				return clsx(
					// 对齐 standalone 设计稿 .nav-item：padding 6px 9px（展开态用 py-1.5 px-2.5，
					// 内容撑开约 30px，比原固定 h-9=36px 更紧凑贴合设计稿）。
					// 收起态保持 h-9 方形以容纳居中图标。
					"group relative mx-2 flex items-center gap-2.5 rounded-(--radius) transition-colors",
					collapsed ? "h-9 justify-center px-0" : "py-1.5 px-2.5",
					// active：bg-active + text + 左 3px brand 竖条（zpass-nav-active）+ 字重 500，
					// 图标转 brand 色（设计稿 .nav-item.is-active .ni-ico { color: brand }）。
					active
						? "bg-(--bg-active) font-medium text-(--text) zpass-nav-active"
						: "text-(--text-2) hover:bg-(--bg-hover) hover:text-(--text)",
				);
			}}
		>
			{({ isActive }: { isActive: boolean }) => {
				const active = computeActive(isActive);
				return (
					<>
						<Icon
							size={14}
							strokeWidth={1.5}
							className={clsx(
								"shrink-0",
								collapsed && "mx-auto",
								active ? "text-(--brand)" : "text-(--text-3)",
							)}
						/>
						{!collapsed && (
							<>
								<span className="flex-1 truncate text-[13px]">{label}</span>
								{count != null && (
									<span className="font-mono text-[10.5px] text-(--text-4)">{count}</span>
								)}
								{badge && (
									<span className="ml-auto rounded-full border border-(--line-soft) bg-(--bg-elev-2) px-1.5 py-px font-mono text-[10px] text-(--text-2)">
										{badge}
									</span>
								)}
							</>
						)}
					</>
				);
			}}
		</NavLink>
	);
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

interface SidebarProps {
	/** 由 AppShell 传入，共享同一个 useSidebar 实例 */
	sidebarState: ReturnType<typeof useSidebar>;
}

export function Sidebar({ sidebarState }: SidebarProps) {
	const { t } = useTranslation();

	const { collapsed, toggle, resizeHandleRef, isDragging } = sidebarState;

	const accountMode = useAccountStore((s) => s.mode);
	const accountUser = useAccountStore((s) => s.user);

	// 当前激活空间 —— 底部头像与顶部 WorkspaceSwitcher 共用同一数据源，
	// 确保切换/重命名/换图后侧边栏上下两处头像始终同步。
	// 本地模式（guest）没有云端用户头像，直接复用空间头像更自然。
	const activeSpace = useActiveSpace();

	const items = useVaultStore((s) => s.items);

	const healthIssueCount = useVaultStore((s) => s.healthIssueCount);

	const counts = items.reduce(
		(acc, i) => {
			acc[i.type] = (acc[i.type] ?? 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);

	// hasTOTP 由后端 ListItems 在解密时填充，无需依赖 itemDetails 缓存
	const totpCount = items.reduce((n, i) => {
		if (i.type === "totp") return n + 1;
		if (i.type === "login" && i.hasTOTP) return n + 1;
		return n;
	}, 0);

	return (
		// 外层 wrapper 是相对定位容器，分隔线绝对定位在右侧
		<div
			className="relative flex h-full w-full flex-col"
			data-sidebar-collapsed={collapsed ? "true" : "false"}
		>
			{/* ── 主体 aside ──
			 * 玻璃质感侧边栏：半透明 elev 底（titlebar-glass：72% elev + blur24 saturate150）
			 * 叠 --bg-gradient 软渐晕。AppShell 画布是 --bg（比 elev 暗一档），半透明底
			 * 透出一丝画布暗色 + blur 柔化渐变，形成 Linear / Arc 的"舞台灯"通透感，
			 * 与主内容 --bg-elev 白纸拉开层次。
			 */}
			<aside className="flex h-full w-full min-w-0 flex-col titlebar-glass zpass-bg-gradient overflow-hidden">
				{/* WorkspaceSwitcher — 收起时显示 logo 方块 */}
				<WorkspaceSwitcher collapsed={collapsed} />

				{/* 中间 nav（可滚动） */}
				<nav
					className={clsx(
						"flex-1 overflow-y-auto overflow-x-hidden pb-2",
						collapsed && "overflow-x-visible",
					)}
				>
					<SectionLabel collapsed={collapsed}>{t("nav_workspace")}</SectionLabel>
					<NavRow
						to="/vault"
						icon={VaultIcon}
						labelKey="nav_all_items"
						count={items.length}
						exactSearch
						collapsed={collapsed}
					/>
					<NavRow to="/generator" icon={KeyRound} labelKey="nav_generator" collapsed={collapsed} />
					{/* TOTP 聚合页 ——
					 *
					 * 工作区级别的"全局视图"，与 /vault?filter=login 等"分类视图"分层：
					 *   - 工作区入口（/totp）：跨类型聚合所有含 totp 字段的条目，
					 *     展示实时 6 位码 + 倒计时
					 *   - 分类入口（/vault?filter=totp，见下方 categories）：
					 *     仅展示独立 totp 类型条目，进入 VaultPage 标准列表/详情
					 *
					 * 两者不冗余：前者面向"我现在要登录某站需要快速看码"，
					 * 后者面向"我要管理 TOTP 条目本身（增删改）"。
					 */}
					<NavRow
						to="/totp"
						icon={Smartphone}
						labelKey="nav_totp"
						count={totpCount > 0 ? totpCount : undefined}
						collapsed={collapsed}
					/>
					<NavRow
						to="/health"
						icon={ShieldCheck}
						labelKey="nav_security"
						badge={
							collapsed || healthIssueCount === null || healthIssueCount === 0
								? undefined
								: String(healthIssueCount)
						}
						collapsed={collapsed}
					/>

					<SectionLabel collapsed={collapsed}>{t("nav_categories")}</SectionLabel>
					<NavRow
						to="/vault?filter=login"
						icon={LogIn}
						labelKey="nav_logins"
						count={counts.login ?? 0}
						exactSearch
						collapsed={collapsed}
					/>
					<NavRow
						to="/vault?filter=card"
						icon={CreditCard}
						labelKey="nav_cards"
						count={counts.card ?? 0}
						exactSearch
						collapsed={collapsed}
					/>
					<NavRow
						to="/vault?filter=note"
						icon={StickyNote}
						labelKey="nav_notes"
						count={counts.note ?? 0}
						exactSearch
						collapsed={collapsed}
					/>
					<NavRow
						to="/vault?filter=identity"
						icon={IdCard}
						labelKey="nav_identities"
						count={counts.identity ?? 0}
						exactSearch
						collapsed={collapsed}
					/>
					<NavRow
						to="/vault?filter=ssh"
						icon={TerminalSquare}
						labelKey="nav_ssh"
						count={counts.ssh ?? 0}
						exactSearch
						collapsed={collapsed}
					/>
					<NavRow
						to="/vault?filter=passkey"
						icon={KeyRound}
						labelKey="nav_passkeys"
						count={counts.passkey ?? 0}
						exactSearch
						collapsed={collapsed}
					/>
				</nav>

				{/* ── 底部账户区 ──
				 * 仅承担"收起/展开侧边栏"交互；账户与保险库相关操作已上移到顶部
				 * WorkspaceSwitcher 的下拉菜单。
				 * border-top 改用 line-soft —— 软线只勾出层级而不抢视觉。
				 */}
				<div className="shrink-0 border-t border-(--line-soft) flex items-center gap-1.5 px-2.5 py-2">
					{/* 头像按钮 —— 点击切换侧边栏收起/展开
					 *   收起态：hover 时头像淡出、叠加展开箭头
					 *   展开态：与右侧 ChevronsLeft 等效，点击收起
					 */}
					<button
						type="button"
						onClick={toggle}
						title={(collapsed ? t("sidebar_expand") : t("sidebar_collapse")) ?? ""}
						aria-label={(collapsed ? t("sidebar_expand") : t("sidebar_collapse")) ?? ""}
						className={clsx(
							"relative flex shrink-0 items-center justify-center rounded-(--radius)",
							"h-5 w-5",
							"outline-none transition-colors overflow-hidden",
							"focus:outline-none focus-visible:outline-none",
							collapsed ? "hover:ring-1 hover:ring-(--text-4) group" : "hover:opacity-80",
						)}
					>
						{/* 空间头像 —— 收起态 hover 时淡出，让位给展开箭头 */}
						<span
							className={clsx(
								"absolute inset-0 flex items-center justify-center transition-opacity duration-150",
								collapsed && "group-hover:opacity-0",
							)}
						>
							{activeSpace ? (
								<SpaceAvatar
									space={activeSpace}
									className="h-full w-full rounded-(--radius) text-[9px]"
								/>
							) : (
								// 兜底：spaces 还没初始化（首启 onboarding 前）
								<span className="flex h-full w-full items-center justify-center rounded-(--radius) border border-(--line) bg-(--bg-active) font-mono text-[9px] text-(--text-2)">
									·
								</span>
							)}
						</span>
						{/* 收起态 hover 时叠加展开箭头 */}
						{collapsed && (
							<ChevronsRight
								size={10}
								strokeWidth={2}
								className="absolute inset-0 m-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100 text-(--text-2)"
							/>
						)}
					</button>

					{/* 展开态のみ：账户名 + 收起按钮 */}
					{!collapsed && (
						<>
							<span className="min-w-0 flex-1 truncate text-[10.5px] text-(--text-3) select-none pointer-events-none font-mono">
								{accountMode === "signed-in" && accountUser
									? accountUser.displayName
									: t("sidebar_local_mode")}
							</span>
							<button
								type="button"
								onClick={toggle}
								title={t("sidebar_collapse") ?? ""}
								aria-label={t("sidebar_collapse") ?? ""}
								className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius) text-(--text-3) transition-colors hover:bg-(--bg-hover) hover:text-(--text)"
							>
								<ChevronsLeft size={11} strokeWidth={1.5} />
							</button>
						</>
					)}
				</div>
			</aside>

			{/* ── Resize Handle（分隔线，绝对定位于右侧） ──
			 *
			 * 热区 8px 宽（透明），可见线 1px（CSS ::after 或内部 div）。
			 * 收起状态点击 → 展开；展开状态拖拽 → 调整宽度。
			 * isDragging 时全局 cursor 变为 col-resize（通过 data 属性 + CSS 控制）。
			 */}
			<div
				ref={resizeHandleRef}
				data-dragging={isDragging ? "true" : "false"}
				className={clsx(
					"resize-handle absolute inset-y-0 right-0 z-10 flex w-3 cursor-col-resize items-stretch select-none",
					collapsed && "cursor-e-resize",
				)}
				aria-hidden="true"
			>
				{/* 可见的 1px 分隔线 — 固定在热区最右侧 */}
				<div
					className={clsx(
						"resize-handle-line ml-auto w-px transition-colors duration-150",
						isDragging ? "bg-(--text-3)" : "bg-(--line)",
					)}
				/>
			</div>
		</div>
	);
}

export default Sidebar;
