import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router-dom";
import { NAV_GROUPS, NAV_ITEMS } from "./nav";

/**
 * 设置页外壳 —— 左侧分组导航 + 右侧 Outlet 面板
 * ---------------------------------------------------------------------------
 * 取代旧 SettingsPage 的"一张长滚动页 + IntersectionObserver 锚点联动"写法：
 *   - 每个菜单是一个真实子路由（/settings/<id>，见 app/router.tsx），切换菜单
 *     即切换路由，**只挂载当前面板**。未访问的面板（信任设备 probe、LAN 同步、
 *     SSH agent 等）不会在进入设置页时就跑副作用 —— 性能优先。
 *   - 导航高亮交给 react-router 的 NavLink isActive，不再需要 activeId /
 *     IntersectionObserver / scrollIntoView / sectionRefs 那套锚点机制。
 *   - 面板间切换用 `replace`：不污染历史栈，浏览器后退键不会在设置子页间穿梭，
 *     更贴近原生 PC 设置应用。
 *
 * 视觉沿用既有设计 token：严格黑白、无 accent、圆角走 token、Geist 字体。
 */

function SettingsNav() {
	const { t } = useTranslation();

	return (
		<nav className="flex flex-col gap-4 py-1">
			{NAV_GROUPS.map((group) => {
				const items = NAV_ITEMS.filter((i) => i.group === group.key);
				return (
					<div key={group.key} className="flex flex-col gap-0.5">
						<div className="mb-1 px-2.5 font-mono text-[10px] uppercase tracking-widest text-(--text-4)">
							{t(group.labelKey)}
						</div>
						{items.map((item) => (
							<NavLink
								key={item.id}
								to={`/settings/${item.id}`}
								replace
								className={({ isActive }) =>
									"flex w-full items-center gap-2.5 rounded-(--radius) px-2.5 py-2 text-left text-[13px] transition-colors " +
									(isActive
										? "bg-(--bg-elev) font-medium text-(--text) shadow-sm border border-(--line)"
										: "text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text-2)")
								}
							>
								{({ isActive }) => (
									<>
										<item.icon
											size={14}
											strokeWidth={1.5}
											className={isActive ? "text-(--text-2)" : "text-(--text-4)"}
										/>
										<span className="truncate">{t(item.labelKey)}</span>
									</>
								)}
							</NavLink>
						))}
					</div>
				);
			})}
		</nav>
	);
}

export function SettingsLayout() {
	const { t } = useTranslation();

	return (
		<div className="flex h-full w-full overflow-hidden bg-(--bg)">
			{/* ── 左侧固定导航 ── */}
			<aside className="flex h-full w-56 shrink-0 flex-col border-r border-(--line-soft) bg-(--bg-elev) px-3 py-6">
				{/* 标题区 */}
				<div className="mb-5 flex flex-col gap-0.5 px-2.5">
					<h1 className="text-[15px] font-semibold text-(--text)">
						{t("settings_title")}
					</h1>
					<p className="text-[11.5px] text-(--text-4)">
						{t("settings_subtitle")}
					</p>
				</div>
				<SettingsNav />
			</aside>

			{/* ── 右侧可滚动面板（当前子路由） ── */}
			<div className="flex-1 overflow-y-auto bg-(--bg-elev-2)">
				<div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-8">
					<Outlet />
				</div>
			</div>
		</div>
	);
}

export default SettingsLayout;
