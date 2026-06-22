import { Bell, ChevronRight, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { formatShortcut, SHORTCUTS } from "@/lib/keys";
import { useUIStore } from "@/stores/ui";
import { useVaultStore, type VaultFilter } from "@/stores/vault";

/**
 * filter → 面包屑文案 i18n key 映射
 *
 * 顶部 FilterChip 行已被移除（侧边栏单点切换分类即可），分类的"当前选中"
 * 状态由 Topbar 面包屑承担：filter=login 时面包屑显示"登录"，filter=card
 * 显示"银行卡"，依此类推。filter=all 时回到"保险库"根标题。
 *
 * 复用 vault_filter_xxx 文案（短标签风格已经合适做面包屑尾段）。
 */
const FILTER_LABEL_KEY: Record<Exclude<VaultFilter, "all">, string> = {
	login: "vault_filter_login",
	card: "vault_filter_card",
	note: "vault_filter_note",
	identity: "vault_filter_identity",
	ssh: "vault_filter_ssh",
	passkey: "vault_filter_passkey",
	totp: "vault_filter_totp",
	fav: "vault_filter_fav",
};

/**
 * 顶部栏：面包屑 + 搜索入口（触发 ⌘K）+ 主题切换 + 通知 + 新建
 *
 * 对标 ZPassDesign/src/app.jsx 中的 Topbar 组件。
 *
 * 设计要点：
 *   - 不再通过 props
 传入 section / selectedName，而是直接从 react-router 的
 *     useLocation / useMatch 推断当前所在路由；AppShell 无需关心路由状态。
 *   - 选中条目名从 useVaultStore 读取 —— 当 URL 是 /vault/:itemId 时展示，
 *     否则只显示区块名。
 *   - 所有交互按钮严格黑白化：不再使用 --accent 填色，"新建" 按钮用 --text / --bg
 *     反差（dark 白底黑字 / light 黑底白字），与 UnlockPage 的解锁按钮风格一致。
 *   - 语言切换**不在 Topbar** —— 统一迁到 Settings 页（/settings），Topbar 保持
 *     "当前任务/快速动作" 的克制心智。主题切换是高频动作（明暗适应环境光），
 *     保留在 Topbar；语言是一次性配置，放 Settings 更合适。
 */

type Section = "vault" | "generator" | "totp" | "health" | "settings";

/** 从当前 pathname 推断 section；默认回退到 vault */
function resolveSection(pathname: string): Section {
	if (pathname.startsWith("/generator")) return "generator";
	if (pathname.startsWith("/totp")) return "totp";
	if (pathname.startsWith("/health")) return "health";
	if (pathname.startsWith("/settings")) return "settings";
	return "vault";
}

/**
 * TotpPage 的来源筛选取值集合
 *
 * 与 TotpPage.tsx 的 SourceFilter 类型对齐：
 *   - "all"   ：全部 TOTP 条目（login + 独立 totp）
 *   - "login" ：仅 login 类型且带 totp 字段的条目
 *   - "totp"  ：仅独立 totp 类型条目
 *
 * URL 表达：?source=all|login|totp（缺省视为 all）
 *
 * 状态放 URL 而不是组件 state：让 Topbar 上的 chip（顶部框架层）与
 * TotpPage（页面内容层）共享同一个事实来源，互不耦合，浏览器前进后退
 * 也能正确恢复筛选态。与 VaultPage 用 ?filter= 同样的模式。
 */
const TOTP_SOURCES = ["all", "login", "totp"] as const;
type TotpSource = (typeof TOTP_SOURCES)[number];

function isValidTotpSource(v: string | null): v is TotpSource {
	return v !== null && (TOTP_SOURCES as readonly string[]).includes(v);
}

export function Topbar() {
	const { t } = useTranslation();
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const section = resolveSection(pathname);

	const openCmdk = useUIStore((s) => s.openCmdk);
	const requestNewItem = useUIStore((s) => s.requestNewItem);

	// vault 当前 filter —— 用于面包屑显示分类名（"登录"/"银行卡"/...）
	const vaultFilter = useVaultStore((s) => s.filter);

	// URL search params —— 当前主要给 TotpPage 的来源 chip 用
	const [searchParams, setSearchParams] = useSearchParams();
	const totpSource: TotpSource = isValidTotpSource(searchParams.get("source"))
		? (searchParams.get("source") as TotpSource)
		: "all";

	// TotpPage 的条目计数 —— Topbar chip 旁边的"全部 N / 登录 M / 验证器 K"
	// hasTOTP 由后端 ListItems 在解密时填充，无需依赖 itemDetails 缓存。
	// chip 计数仅在 section === "totp" 时才会被消费，其它 section 下虽然
	// 还是会跑（hooks 不能条件调用），但成本是 O(items.length)，可忽略。
	const items = useVaultStore((s) => s.items);
	// hasTOTP 由后端 ListItems 在解密时填充，无需依赖 itemDetails 缓存
	const totpCounts = (() => {
		let login = 0;
		let totp = 0;
		for (const it of items) {
			if (it.type === "totp") {
				totp += 1;
			} else if (it.type === "login" && it.hasTOTP) {
				login += 1;
			}
		}
		return { all: login + totp, login, totp };
	})();

	/**
	 * "新建" 按钮处理
	 * ---------------------------------------------------------------------------
	 * 行为：
	 *   1. 当前不在 /vault → 先 navigate 过去，让 VaultPage 挂载
	 *   2. 触发全局信号（计数器 ++），VaultPage 订阅到信号后打开 NewItemDialog
	 *
	 * 为什么不直接在 Topbar 里渲染对话框：
	 *   对话框需要 useVaultStore.create 的回调、需要选中新建条目，逻辑高度
	 *   依赖 vault 视图。把对话框留在 VaultPage 内，Topbar 仅做"召唤"动作，
	 *   职责更单一，跨页面跳转也只跑一处对话框实现。
	 *
	 * 与 ⌘N 快捷键对齐 —— 后续 Shortcuts 注册 ⌘N 时调同一个 requestNewItem。
	 */
	const onNewClick = () => {
		// totp 工作区点「+ 新建」→ 期望是新建一个独立验证器条目，
		// 因此先 navigate 到 ?filter=totp 让 VaultPage 的 presetType
		// 推导成 "totp"（VaultPage.filterToPresetType），再发信号。
		// 其他 non-vault 页（generator / health / settings）默认走 login。
		if (section === "totp") {
			navigate("/vault?filter=totp");
		} else if (section !== "vault") {
			navigate("/vault");
		}
		// 用 requestAnimationFrame 让 navigate 先生效再触发信号 ——
		// 避免 VaultPage 还没挂载就拿不到信号变化的边缘情况
		requestAnimationFrame(() => {
			requestNewItem();
		});
	};

	/**
	 * 切换 TotpPage 的来源筛选 ——
	 * "all" 走裸路径（不带 search param），其它值显式写 ?source=xxx。
	 * 用 setSearchParams 而不是 navigate 是为了保留 history stack 的
	 * 平滑（前进后退能恢复筛选态），与 VaultPage 的 ?filter= 同样行为。
	 */
	const onTotpSourceChange = (next: TotpSource) => {
		if (next === "all") {
			setSearchParams({}, { replace: true });
		} else {
			setSearchParams({ source: next }, { replace: true });
		}
	};

	// 仅在 /vault/:itemId 时取选中条目名作为面包屑尾段
	const vaultItemMatch = useMatch("/vault/:itemId");
	const selectedId = vaultItemMatch?.params.itemId ?? null;
	const selectedName = useVaultStore((s) =>
		selectedId ? (s.items.find((i) => i.id === selectedId)?.name ?? null) : null,
	);

	const crumbs = (() => {
		switch (section) {
			case "vault": {
				// 优先级：选中条目 > 分类过滤 > 根标题
				//   - 选中具体条目：保险库 › <条目名>
				//   - 仅切换了分类（filter !== "all"）：保险库 › <分类名>
				//   - 默认：保险库（加粗）
				if (selectedName) {
					return (
						<>
							<span>{t("topbar_vault")}</span>
							<ChevronRight
								size={13}
								strokeWidth={1.5}
								className="mx-0.5 shrink-0 text-(--text-4)"
							/>
							<b className="text-(--text)">{selectedName}</b>
						</>
					);
				}
				if (vaultFilter !== "all") {
					return (
						<>
							<span>{t("topbar_vault")}</span>
							<ChevronRight
								size={13}
								strokeWidth={1.5}
								className="mx-0.5 shrink-0 text-(--text-4)"
							/>
							<b className="text-(--text)">{t(FILTER_LABEL_KEY[vaultFilter])}</b>
						</>
					);
				}
				return <b className="text-(--text)">{t("topbar_vault")}</b>;
			}
			case "generator":
				return <b className="text-(--text)">{t("topbar_generator")}</b>;
			case "totp":
				return <b className="text-(--text)">{t("topbar_totp")}</b>;
			case "health":
				return <b className="text-(--text)">{t("topbar_security")}</b>;
			case "settings":
				return <b className="text-(--text)">{t("topbar_settings")}</b>;
		}
	})();

	return (
		<header className="flex h-11 items-center gap-2 border-b border-(--line) bg-(--bg-elev) px-4">
			<div className="flex items-center text-[13px] text-(--text-2)">{crumbs}</div>

			{/* TotpPage 专属：来源快速筛选 chip ——
			 *
			 * 紧贴面包屑右侧（视觉上属于"当前页头操作区"，不属于通用 Topbar 工具）。
			 * 仅当 section === "totp" 且至少存在两类来源时才渲染：
			 *   - 用户只用 login 类型存 TOTP（最常见）→ 不需要切换，省略 chip
			 *   - 用户只用独立 totp 类型 → 同上
			 *   - 两者都有 → 显示三个 chip 让用户切分类
			 */}
			{section === "totp" && totpCounts.login > 0 && totpCounts.totp > 0 && (
				<div className="ml-3 flex items-center gap-1 border-l border-(--line) pl-3">
					{TOTP_SOURCES.map((src) => {
						const active = totpSource === src;
						return (
							<button
								key={src}
								type="button"
								onClick={() => onTotpSourceChange(src)}
								onMouseDown={(e) => e.preventDefault()}
								tabIndex={-1}
								className={
									active
										? "flex h-7 items-center gap-1.5 rounded-(--radius) bg-(--bg-active) px-2.5 text-[12px] text-(--text) transition-colors focus:outline-none focus-visible:outline-none"
										: "flex h-7 items-center gap-1.5 rounded-(--radius) px-2.5 text-[12px] text-(--text-3) transition-colors hover:bg-(--bg-hover) hover:text-(--text-2) focus:outline-none focus-visible:outline-none"
								}
							>
								<span>{t(`totp_filter_${src}` as const)}</span>
								<span className="font-mono text-[10px] text-(--text-3)">{totpCounts[src]}</span>
							</button>
						);
					})}
				</div>
			)}

			<div className="flex-1" />

			{/* 搜索触发 —— 点击打开 ⌘K 命令面板
			 *
			 * 桌面 app 化要点（与 design/vault-home.html `.search` 一致）：
			 *   - hover 不变 border 色（"border-color shift on hover" 是 Bootstrap/shadcn 标志味）
			 *     只换底色 + 微 inset 阴影，模拟 NSSearchField 的"凹陷"感
			 *   - 响应式：< lg 收掉最小宽度
			 */}
			<button
				type="button"
				onClick={openCmdk}
				className="flex h-8 min-w-44 items-center gap-2 rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) px-3 text-[13px] text-(--text-3) transition-colors hover:bg-(--bg-hover) hover:text-(--text-2) lg:min-w-60"
			>
				<Search size={13} strokeWidth={1.8} />
				<span className="hidden sm:inline">{t("topbar_search")}</span>
				<div className="flex-1" />
				{/* 跨平台快捷键 hint：mac → ⌘K，win/linux → Ctrl+K */}
				<kbd className="rounded border border-(--line-soft) bg-(--bg) px-1.5 py-0.5 font-mono text-[10px] text-(--text-3)">
					{formatShortcut(SHORTCUTS.CMDK_OPEN)}
				</kbd>
			</button>

			{/* 通知 —— 当前为占位，没有 panel/路由 */}
			<button
				type="button"
				aria-disabled="true"
				tabIndex={-1}
				title={t("topbar_notifications")}
				className="flex h-8 w-8 cursor-default items-center justify-center rounded-(--radius) text-(--text-3) opacity-60"
			>
				<Bell size={14} />
			</button>

			{/* 新建条目 —— 黑白高对比按钮（macOS Aqua 实心按钮配方）
			 *   - bg-(--text) / color-(--bg) 反差填充
			 *   - inset 1px 白色高光（顶部"反光"）
			 *   - 落影 2 层（1px 锐影 + 2px 散影）做出"凸起"质感
			 * 桌面 app 的"主按钮立体感"= 内高光 + 多层外阴影,缺一回到 web 扁平
			 */}
			<button
				type="button"
				onClick={onNewClick}
				className="flex h-8 items-center gap-1.5 rounded-(--radius) bg-(--text) px-3 text-[13px] font-medium text-(--bg) transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97]"
				style={{
					boxShadow:
						"inset 0 1px 0 rgba(255,255,255,0.12), 0 1px 2px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)",
				}}
				title={`${formatShortcut(SHORTCUTS.NEW_ITEM)} ${t("vault_kbd_new_label")}`}
			>
				<Plus size={14} />
				<span>{t("topbar_new")}</span>
			</button>
		</header>
	);
}

export default Topbar;
