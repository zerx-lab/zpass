import { AppWindow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type CloseBehavior, usePrefsStore } from "@/stores/prefs";
import { Section } from "../shared";

/* ────────────────────────────────────────────────────────────
 * 窗口行为 section —— 关闭按钮：退出应用 / 收进托盘
 *
 * 渲染为 Section 下的单一 radio group（与 SecuritySection 里的"自动锁定超时"
 * 一致）。选"退出"是传统语义、与 Electron 默认一致；选"收进托盘"后 Electron
 * 主进程会拦截 close 事件并隐藏窗口，以便据点托盘图标随时拉回。
 *
 * 偏好流向：Settings UI → usePrefsStore.setCloseBehavior → persist 落盘 +
 * ThemeSync useEffect → window.desktop.window.setCloseBehavior(v) IPC →
 * 主进程缓存变量。重启后同一链路重走一遍，保证项 hydrate 后主进程能拿到最新值。
 *
 * macOS 提示：Cmd+Q 是系统级语义，不管该偏好是什么都能真退出；该 section 仅
 * 控制窗口 X / Alt+F4 / 标题栏关闭按钮的语义。
 * ─────────────────────────────────────────────────────────── */

const CLOSE_BEHAVIOR_OPTIONS: { value: CloseBehavior; labelKey: string }[] = [
	{ value: "quit", labelKey: "settings_close_behavior_quit" },
	{ value: "tray", labelKey: "settings_close_behavior_tray" },
];

export function WindowSection() {
	const { t } = useTranslation();
	const closeBehavior = usePrefsStore((s) => s.closeBehavior);
	const setCloseBehavior = usePrefsStore((s) => s.setCloseBehavior);

	return (
		<Section
			icon={AppWindow}
			title={t("settings_section_window")}
			description={t("settings_section_window_desc")}
		>
			<div className="flex flex-col">
				<div className="border-b border-(--line-soft) px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-(--text-3)">
					{t("settings_close_behavior")}
				</div>
				{CLOSE_BEHAVIOR_OPTIONS.map((opt) => {
					const isActive = closeBehavior === opt.value;
					return (
						<div
							key={opt.value}
							className={
								"flex cursor-pointer items-center gap-3 border-b border-(--line-soft) px-5 py-2.5 text-[13px] transition-colors last:border-b-0 hover:bg-(--bg-hover) " +
								(isActive ? "text-(--text)" : "text-(--text-2)")
							}
							role="radio"
							aria-checked={isActive}
							tabIndex={0}
							onClick={() => setCloseBehavior(opt.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									setCloseBehavior(opt.value);
								}
							}}
						>
							<span
								className={
									"flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors " +
									(isActive ? "border-(--text)" : "border-(--text-4)")
								}
							>
								{isActive && (
									<span className="h-2 w-2 rounded-full bg-(--text)" />
								)}
							</span>
							<span className="flex-1">{t(opt.labelKey)}</span>
						</div>
					);
				})}
			</div>
			<div className="px-5 py-3 text-[11.5px] leading-relaxed text-(--text-4)">
				{t("settings_close_behavior_desc")}
				<br />
				{t("settings_tray_hint")}
			</div>
		</Section>
	);
}

export default WindowSection;
