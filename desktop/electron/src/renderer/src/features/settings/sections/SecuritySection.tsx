import { Shield } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LockTimeout, usePrefsStore } from "@/stores/prefs";
import { ConfirmDialog, Section } from "../shared";

const LOCK_OPTIONS: { value: LockTimeout; labelKey: string }[] = [
	{ value: "1m", labelKey: "settings_lock_1m" },
	{ value: "5m", labelKey: "settings_lock_5m" },
	{ value: "15m", labelKey: "settings_lock_15m" },
	{ value: "30m", labelKey: "settings_lock_30m" },
	{ value: "1h", labelKey: "settings_lock_1h" },
	{ value: "4h", labelKey: "settings_lock_4h" },
	{ value: "never", labelKey: "settings_lock_never" },
];

/** 触发条件行 —— 文本 + switch */
function TriggerRow({
	label,
	checked,
	onChange,
	last,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	last?: boolean;
}) {
	return (
		<div
			className={
				"flex items-center justify-between px-5 py-3" +
				(last ? "" : " border-b border-(--line-soft)")
			}
		>
			<span className="text-[13px] text-(--text-2)">{label}</span>
			<div
				className={
					"relative h-5 w-8.5 shrink-0 cursor-pointer rounded-full transition-colors " +
					(checked ? "bg-(--text)" : "bg-(--line)")
				}
				role="switch"
				aria-checked={checked}
				tabIndex={0}
				onClick={() => onChange(!checked)}
				onKeyDown={(e) => {
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

export function SecuritySection() {
	const { t } = useTranslation();
	const lockTimeout = usePrefsStore((s) => s.lockTimeout);
	const setLockTimeout = usePrefsStore((s) => s.setLockTimeout);
	const lockOnSleep = usePrefsStore((s) => s.lockOnSleep);
	const setLockOnSleep = usePrefsStore((s) => s.setLockOnSleep);
	const lockOnSwitch = usePrefsStore((s) => s.lockOnSwitch);
	const setLockOnSwitch = usePrefsStore((s) => s.setLockOnSwitch);
	const lockOnClose = usePrefsStore((s) => s.lockOnClose);
	const setLockOnClose = usePrefsStore((s) => s.setLockOnClose);

	const [showNeverWarn, setShowNeverWarn] = useState(false);

	const handleTimeoutChange = useCallback(
		(v: LockTimeout) => {
			if (v === "never") {
				setShowNeverWarn(true);
			} else {
				setLockTimeout(v);
			}
		},
		[setLockTimeout],
	);

	const confirmNever = useCallback(() => {
		setLockTimeout("never");
		setShowNeverWarn(false);
	}, [setLockTimeout]);

	return (
		<>
			<Section
				icon={Shield}
				title={t("settings_section_security")}
				description={t("settings_section_security_desc")}
			>
				{/* 超时时间 —— radio group */}
				<div className="flex flex-col">
					<div className="border-b border-(--line-soft) px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-(--text-3)">
						{t("settings_lock_timeout")}
					</div>
					{LOCK_OPTIONS.map((opt) => {
						const isActive = lockTimeout === opt.value;
						const isNever = opt.value === "never";
						return (
							<div
								key={opt.value}
								className={
									"flex cursor-pointer items-center gap-3 border-b border-(--line-soft) px-5 py-2.5 text-[13px] transition-colors last:border-b-0 hover:bg-(--bg-hover) " +
									(isActive ? "text-(--text)" : "text-(--text-2)") +
									(isNever ? " text-(--warn)" : "")
								}
								role="radio"
								aria-checked={isActive}
								tabIndex={0}
								onClick={() => handleTimeoutChange(opt.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										handleTimeoutChange(opt.value);
									}
								}}
							>
								{/* radio 圆点 */}
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
								<span>{t(opt.labelKey)}</span>
							</div>
						);
					})}
				</div>

				{/* 触发条件 —— switch toggles */}
				<div className="flex flex-col">
					<div className="border-b border-(--line-soft) px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-(--text-3)">
						{t("settings_lock_trigger")}
					</div>
					<TriggerRow
						label={t("settings_lock_sleep")}
						checked={lockOnSleep}
						onChange={setLockOnSleep}
					/>
					<TriggerRow
						label={t("settings_lock_switch")}
						checked={lockOnSwitch}
						onChange={setLockOnSwitch}
					/>
					<TriggerRow
						label={t("settings_lock_close")}
						checked={lockOnClose}
						onChange={setLockOnClose}
						last
					/>
				</div>
			</Section>

			{/* "永不锁定"二次确认 */}
			<ConfirmDialog
				open={showNeverWarn}
				onClose={() => setShowNeverWarn(false)}
				title={t("settings_lock_never_title")}
				message={t("settings_lock_never_msg")}
				warning={t("settings_lock_never_msg")}
				confirmLabel={t("settings_lock_never_confirm")}
				cancelLabel={t("settings_lock_never_cancel")}
				onConfirm={confirmNever}
				variant="danger"
			/>
		</>
	);
}

export default SecuritySection;
