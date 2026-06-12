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
 *
 * 开机启动（launchAtLogin）：同一流向推送给主进程，由其在 macOS/Windows 注册
 * 登录项、在 Linux 写/删 XDG autostart 文件。dev（未打包）构建下主进程会 no-op。
 * ─────────────────────────────────────────────────────────── */

const CLOSE_BEHAVIOR_OPTIONS: { value: CloseBehavior; labelKey: string }[] = [
	{ value: "quit", labelKey: "settings_close_behavior_quit" },
	{ value: "tray", labelKey: "settings_close_behavior_tray" },
];

/** 文本 + switch 行（与 SecuritySection 的 TriggerRow 风格一致）。 */
function ToggleRow({
	label,
	checked,
	onChange,
	disabled = false,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<div
			className={
				"flex items-center justify-between border-b border-(--line-soft) px-5 py-3" +
				(disabled ? " opacity-40" : "")
			}
		>
			<span className="text-[13px] text-(--text-2)">{label}</span>
			<div
				className={
					"relative h-5 w-8.5 shrink-0 rounded-full transition-colors " +
					(disabled ? "cursor-not-allowed " : "cursor-pointer ") +
					(checked ? "bg-(--text)" : "bg-(--line)")
				}
				role="switch"
				aria-checked={checked}
				aria-disabled={disabled}
				tabIndex={disabled ? -1 : 0}
				onClick={() => {
					if (!disabled) onChange(!checked);
				}}
				onKeyDown={(e) => {
					if (disabled) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onChange(!checked);
					}
				}}
			>
				<span
					className={
						"absolute top-0.5 left-0.5 h-4 w-4 rounded-full transition-transform " +
						(checked ? "translate-x-3.5 bg-(--bg)" : "bg-(--text)")
					}
				/>
			</div>
		</div>
	);
}

export function WindowSection() {
	const { t } = useTranslation();
	const closeBehavior = usePrefsStore((s) => s.closeBehavior);
	const setCloseBehavior = usePrefsStore((s) => s.setCloseBehavior);
	const launchAtLogin = usePrefsStore((s) => s.launchAtLogin);
	const setLaunchAtLogin = usePrefsStore((s) => s.setLaunchAtLogin);
	const launchHidden = usePrefsStore((s) => s.launchHidden);
	const setLaunchHidden = usePrefsStore((s) => s.setLaunchHidden);

	return (
		<Section
			icon={AppWindow}
			title={t("settings_section_window")}
			description={t("settings_section_window_desc")}
		>
			<div className="flex flex-col">
				<div className="border-b border-(--line-soft) px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-(--text-3)">
					{t("settings_startup")}
				</div>
				<ToggleRow
					label={t("settings_launch_at_login")}
					checked={launchAtLogin}
					onChange={setLaunchAtLogin}
				/>
				<ToggleRow
					label={t("settings_launch_hidden")}
					checked={launchHidden}
					onChange={setLaunchHidden}
					disabled={!launchAtLogin}
				/>
			</div>
			<div className="px-5 pt-3 pb-1 text-[11.5px] leading-relaxed text-(--text-4)">
				{t("settings_launch_at_login_desc")}
				<br />
				{t("settings_launch_hidden_desc")}
			</div>
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
