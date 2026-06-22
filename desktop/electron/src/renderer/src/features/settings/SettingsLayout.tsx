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
						<div className="mx-2.5 mt-4 mb-[5px] font-mono text-[10px] uppercase tracking-[0.12em] text-(--text-4) first:mt-0">
							{t(group.labelKey)}
						</div>
						{items.map((item) => (
							<NavLink
								key={item.id}
								to={`/settings/${item.id}`}
								replace
								className={({ isActive }) =>
									"flex w-full items-center gap-2.5 rounded-(--radius) px-2.5 py-[7px] text-left text-[13px] transition-colors " +
									(isActive
										? "bg-(--bg-active) font-medium text-(--text)"
										: "text-(--text-2) hover:bg-(--bg-hover) hover:text-(--text)")
								}
							>
								{({ isActive }) => (
									<>
										<item.icon
											size={14}
											strokeWidth={1.5}
											className={isActive ? "text-(--brand)" : "text-(--text-3)"}
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
		// 对齐 standalone 设计稿 .settings：容器底 --bg-elev，
		// 左侧 set-nav 用更暗的 --bg（比内容暗一档形成"画布 vs 面板"分层），
		// 右侧 set-body 透明继承容器 --bg-elev。
		<div className="flex h-full w-full overflow-hidden bg-(--bg-elev)">
			{/* ── 左侧固定导航（set-nav）——
			 * 设计稿：background:var(--bg)（暗）+ border-right line-soft + padding 18px 12px。
			 */}
			<aside className="flex h-full w-56 shrink-0 flex-col border-r border-(--line-soft) bg-(--bg) px-3 py-[18px]">
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

			{/* ── 右侧可滚动面板（set-body）——
			 * 设计稿：透明继承容器 --bg-elev，padding 36px 40px 60px（max-w 620 居中）。
			 */}
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-2xl flex-col gap-5 px-10 py-9">
					<Outlet />
				</div>
			</div>
		</div>
	);
}

export default SettingsLayout;
