import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { clsx } from "clsx";
import {
	ChevronsLeft,
	ChevronsRight,
	CreditCard,
	Download,
	IdCard,
	KeyRound,
	Lock,
	LogIn,
	LogOut,
	ShieldCheck,
	Smartphone,
	StickyNote,
	TerminalSquare,
	Upload,
	Vault as VaultIcon,
} from "lucide-react";
import { type ComponentType, type SVGProps, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { ExportDialog } from "@/components/ExportDialog";
import { ImportDialog } from "@/components/ImportDialog";
import { SpaceAvatar } from "@/components/SpaceAvatar";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import type { useSidebar } from "@/lib/useSidebar";
import { useAccountStore } from "@/stores/account";
import { useLockStore } from "@/stores/lock";
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
		<div className="px-4 pt-5 pb-2 text-[11px] uppercase tracking-[0.08em] text-(--text-3)">
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
					"group relative mx-2 flex h-9 items-center gap-2.5 rounded-(--radius) transition-colors",
					collapsed ? "justify-center px-0" : "px-2.5",
					active
						? "bg-(--bg-active) text-(--text)"
						: "text-(--text-2) hover:bg-(--bg-hover) hover:text-(--text)",
				);
			}}
		>
			<Icon size={14} strokeWidth={1.5} className={clsx("shrink-0", collapsed && "mx-auto")} />
			{!collapsed && (
				<>
					<span className="flex-1 truncate text-[13px]">{label}</span>
					{count != null && <span className="font-mono text-[11px] text-(--text-3)">{count}</span>}
					{badge && (
						<span className="ml-auto rounded-sm border border-(--line) bg-(--bg-elev-2) px-1.5 py-0.5 font-mono text-[10px] text-(--text-2)">
							{badge}
						</span>
					)}
				</>
			)}
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
	const navigate = useNavigate();

	const { collapsed, toggle, resizeHandleRef, isDragging } = sidebarState;

	const lock = useLockStore((s) => s.lock);

	// 导入对话框开关 —— 由账户菜单的"导入数据"项触发
	const [importOpen, setImportOpen] = useState(false);
	// 导出对话框开关 —— 由账户菜单的"导出保险库"项触发
	const [exportOpen, setExportOpen] = useState(false);

	const accountMode = useAccountStore((s) => s.mode);
	const accountUser = useAccountStore((s) => s.user);
	const signOut = useAccountStore((s) => s.signOut);

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
			{/* ── 主体 aside ── */}
			<aside className="flex h-full w-full min-w-0 flex-col bg-(--bg-elev) overflow-hidden">
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

				{/* ── 账户头像菜单（底部） ── */}
				<div className="shrink-0 border-t border-(--line) bg-(--bg-elev) flex items-center gap-1.5 px-2.5 py-2">
					{/* 头像按钮 + Dropdown 菜单
					 *   收起态：
					 *     - 左键 → 展开侧边栏
					 *     - 右键 → 打开账户菜单
					 *     - hover → 头像上叠加展开箭头提示
					 *   展开态：
					 *     - 左键/右键 → 打开账户菜单
					 */}
					<DropdownMenu.Root modal={false}>
						<DropdownMenu.Trigger asChild>
							{/* 收起态：relative 容器，hover 时箭头叠层淡入
							 * 头像内容统一走 <SpaceAvatar>，与顶部 WorkspaceSwitcher
							 * 完全同步；按钮本身负责交互（点击/右键/dropdown trigger）。 */}
							<button
								type="button"
								aria-label={
									accountMode === "signed-in" && accountUser
										? (accountUser.displayName ??
											accountUser.email ??
											activeSpace?.name ??
											t("sidebar_local_mode"))
										: (activeSpace?.name ?? t("sidebar_local_mode"))
								}
								onClick={(e) => {
									if (collapsed) {
										e.preventDefault();
										toggle();
									}
								}}
								onContextMenu={(e) => {
									e.preventDefault();
									e.currentTarget.click();
								}}
								className={clsx(
									"relative flex shrink-0 items-center justify-center rounded-(--radius)",
									"h-5 w-5",
									"outline-none transition-colors overflow-hidden",
									"focus:outline-none focus-visible:outline-none",
									"data-[state=open]:ring-1 data-[state=open]:ring-(--text-4)",
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
						</DropdownMenu.Trigger>

						<DropdownMenu.Portal
							container={typeof document !== "undefined" ? document.getElementById("portal-root") : null}
						>
							<DropdownMenu.Content
								side="top"
								align="start"
								sideOffset={8}
								collisionPadding={8}
								className={clsx(
									"z-50 min-w-45 zpass-glass rounded-(--radius) shadow-md",
									"outline-none",
									"origin-(--radix-dropdown-menu-content-transform-origin)",
									"transition-[opacity,transform] duration-100 ease-out",
									"data-[state=open]:scale-100 data-[state=open]:opacity-100",
									"data-[state=closed]:scale-95 data-[state=closed]:opacity-0",
								)}
							>
								{/* 账户信息头部 */}
								<div className="px-3 py-2.5 border-b border-(--line)">
									<p className="truncate text-[12px] font-medium text-(--text)">
										{accountMode === "signed-in" && accountUser
											? accountUser.displayName
											: t("sidebar_local_mode")}
									</p>
									<p className="truncate text-[10.5px] text-(--text-3)">
										{accountMode === "signed-in" && accountUser
											? accountUser.email
											: t("sidebar_local_mode_sub")}
									</p>
								</div>

								<div className="p-1">
									{/* 导入数据 */}
									<DropdownMenu.Item
										onSelect={() => setImportOpen(true)}
										className="flex h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-(--text-2) outline-none transition-colors hover:bg-(--bg-hover) hover:text-(--text) focus:bg-(--bg-hover) focus:text-(--text)"
									>
										<Upload size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
										{t("menu_import")}
									</DropdownMenu.Item>

									{/* 导出明文备份 —— 二次主密码确认 + 系统 SaveFile dialog */}
									<DropdownMenu.Item
										onSelect={() => setExportOpen(true)}
										className="flex h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-(--text-2) outline-none transition-colors hover:bg-(--bg-hover) hover:text-(--text) focus:bg-(--bg-hover) focus:text-(--text)"
									>
										<Download size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
										{t("menu_export")}
									</DropdownMenu.Item>

									<DropdownMenu.Separator className="my-1 h-px bg-(--line-soft)" />

									{/* 锁定 */}
									<DropdownMenu.Item
										onSelect={lock}
										className="flex h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-(--text-2) outline-none transition-colors hover:bg-(--bg-hover) hover:text-(--text) focus:bg-(--bg-hover) focus:text-(--text)"
									>
										<Lock size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
										{t("nav_lock_title")}
									</DropdownMenu.Item>

									{/* 退出/登录 */}
									{accountMode === "signed-in" ? (
										<DropdownMenu.Item
											onSelect={signOut}
											className="flex h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-(--text-2) outline-none transition-colors hover:bg-(--bg-hover) hover:text-(--danger) focus:bg-(--bg-hover) focus:text-(--danger)"
										>
											<LogOut size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
											{t("nav_sign_out")}
										</DropdownMenu.Item>
									) : (
										<DropdownMenu.Item
											onSelect={() => navigate("/signin")}
											className="flex h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-(--text-2) outline-none transition-colors hover:bg-(--bg-hover) hover:text-(--text) focus:bg-(--bg-hover) focus:text-(--text)"
										>
											<LogIn size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
											{t("sidebar_signin")}
										</DropdownMenu.Item>
									)}
								</div>
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>

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

			{/* 导入数据对话框 —— 挂在 Sidebar 根上，让 dropdown 关闭后 dialog 仍持续显示 */}
			<ImportDialog open={importOpen} onOpenChange={setImportOpen} />
			{/* 导出保险库对话框 —— 同上，独立于 dropdown 生命周期 */}
			<ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
		</div>
	);
}

export default Sidebar;
