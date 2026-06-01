import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { vaultApi, vaultErrorKind } from "@/lib/vault-api";
import {
	ConfirmDialog,
	DIALOG_CONTENT_BASE_CLASS,
	DIALOG_OVERLAY_CLASS,
	dialogPortalContainer,
	Section,
} from "../shared";

/* ─────────────────────────────────────────────────────────────
 * 信任设备（重启免主密码）section
 * ─────────────────────────────────────────────────────────────
 *
 * 让用户在指定设备上重启 ZPass 后无需输入主密码即可解锁保险库。
 * 实现详见：
 *   - desktop/trusteddevice.go            跨平台抽象
 *   - desktop/trusteddevice_windows.go    DPAPI 实现
 *   - desktop/frontend/src/lib/vault-api  四个 IPC 方法
 *   - desktop/frontend/src/app/LockSync   启动时自动解锁触发
 *
 * 安全模型：DPAPI/Keychain 包装的 DEK，离开当前 OS 用户会话即不可解。
 * 拷走 vault.db 到另一台机器无法解 —— 严格优于 Bitwarden「永不超时」
 * 的明文落盘做法。详见 mem://bitwarden-zpass-dpapi 调研记录。
 *
 * 交互流程：
 *   1. 进入 Settings 时探测平台支持 + 当前是否已启用
 *   2. 用户切换开关：
 *      - 关 → 开：弹启用对话框（含安全说明 + 主密码二次确认）
 *      - 开 → 关：弹简短确认对话框（不需要主密码）
 *   3. 平台不支持时整个 section 置灰 + 显示「此平台暂不支持」
 */

export function TrustedDeviceSection() {
	const { t } = useTranslation();

	// 异步状态：平台支持 + 当前启用 —— 启动时探测一次
	// `null` 表示「正在探测」，区分于明确的 false（避免开关闪烁）
	const [supported, setSupported] = useState<boolean | null>(null);
	const [enabled, setEnabled] = useState<boolean | null>(null);

	// 弹窗状态
	const [showEnable, setShowEnable] = useState(false);
	const [showDisable, setShowDisable] = useState(false);

	// 启动时探测一次。两个查询都不需要 DEK，可以在锁定状态下安全调用 ——
	// 但实际上 SettingsPage 只在解锁后渲染，所以无关紧要。
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const [sup, en] = await Promise.all([
					vaultApi.isTrustedDeviceSupported(),
					vaultApi.isTrustedDeviceEnabled(),
				]);
				if (cancelled) return;
				setSupported(sup);
				setEnabled(en);
			} catch (err) {
				if (cancelled) return;
				console.error("[TrustedDeviceSection] probe failed:", err);
				setSupported(false);
				setEnabled(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// 启用成功后 callback（由对话框在密码验证通过后调用）
	const handleEnableSuccess = useCallback(() => {
		setEnabled(true);
		setShowEnable(false);
	}, []);

	// 关闭确认 —— 不需要主密码，直接调后端清行
	const handleDisableConfirm = useCallback(async () => {
		try {
			await vaultApi.disableTrustedDevice();
			setEnabled(false);
		} catch (err) {
			// 关闭失败极罕见（如 DB I/O 异常），不阻塞 UI
			console.error("[TrustedDeviceSection] disable failed:", err);
		} finally {
			setShowDisable(false);
		}
	}, []);

	// 开关 toggle —— 根据当前状态分流到启用 / 关闭对话框
	const handleToggle = useCallback(() => {
		if (supported !== true) return; // 不支持时点击无效
		if (enabled) {
			setShowDisable(true);
		} else {
			setShowEnable(true);
		}
	}, [supported, enabled]);

	const isLoading = supported === null || enabled === null;
	const isDisabled = supported === false;

	return (
		<>
			<Section
				icon={ShieldCheck}
				title={t("settings_section_trusted_device")}
				description={t("settings_section_trusted_device_desc")}
			>
				<div
					className={
						"flex items-center justify-between px-5 py-4" +
						(isDisabled ? " opacity-60" : "")
					}
				>
					<div className="flex min-w-0 flex-col leading-tight">
						<span className="text-[13px] font-medium text-(--text)">
							{t("settings_trusted_device_toggle")}
						</span>
						<span className="mt-0.5 text-[11.5px] text-(--text-3)">
							{isDisabled
								? t("settings_trusted_device_unsupported")
								: enabled
									? t("settings_trusted_device_enabled_hint")
									: t("settings_trusted_device_toggle_desc")}
						</span>
					</div>
					<div
						className={
							"relative h-5 w-8.5 shrink-0 rounded-full transition-colors " +
							(isDisabled || isLoading
								? "cursor-not-allowed bg-(--line)"
								: "cursor-pointer ") +
							(!isDisabled && enabled
								? "bg-(--text)"
								: !isDisabled
									? "bg-(--line)"
									: "")
						}
						role="switch"
						aria-checked={enabled === true}
						aria-disabled={isDisabled || isLoading}
						tabIndex={isDisabled || isLoading ? -1 : 0}
						onClick={() => {
							if (!isDisabled && !isLoading) handleToggle();
						}}
						onKeyDown={(e) => {
							if (isDisabled || isLoading) return;
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								handleToggle();
							}
						}}
					>
						<span
							className={
								"absolute top-0.5 h-4 w-4 rounded-full bg-(--bg) transition-transform " +
								(enabled ? "translate-x-4" : "translate-x-0.5")
							}
						/>
					</div>
				</div>
			</Section>

			{/* 启用对话框：含安全说明 + 主密码二次确认 */}
			<EnableTrustedDeviceDialog
				open={showEnable}
				onClose={() => setShowEnable(false)}
				onSuccess={handleEnableSuccess}
			/>

			{/* 关闭确认 —— 复用通用 ConfirmDialog */}
			<ConfirmDialog
				open={showDisable}
				onClose={() => setShowDisable(false)}
				title={t("settings_trusted_device_disable_title")}
				message={t("settings_trusted_device_disable_msg")}
				confirmLabel={t("settings_trusted_device_disable_confirm")}
				cancelLabel={t("settings_trusted_device_disable_cancel")}
				onConfirm={handleDisableConfirm}
				variant="warn"
			/>
		</>
	);
}

/**
 * 启用「信任此设备」专用对话框
 *
 * 与通用 ConfirmDialog 不同：必须收集主密码做二次确认。后端会用此密码
 * 走完整 KDF + AEAD 验证（与 Unlock 等价强度），通过后才把 DEK 包装为
 * DPAPI/Keychain blob 落盘。
 *
 * 不复用 ConfirmDialog 的原因：
 *   - 需要密码输入框 + 错误提示状态机
 *   - 需要更长的安全说明（适用 / 不适用场景列表）
 *   - 提交需要 await + loading + 错误分支处理
 *
 * 关闭对话框时清空 password / errorMsg —— 避免下次打开时残留上次输入。
 */
function EnableTrustedDeviceDialog({
	open,
	onClose,
	onSuccess,
}: {
	open: boolean;
	onClose: () => void;
	onSuccess: () => void;
}) {
	const { t } = useTranslation();
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	// 关闭时清状态 —— useEffect 依赖 open 变化做重置，比在 onClose
	// 里手动清更不容易遗漏（任何关闭路径都触发）。
	useEffect(() => {
		if (!open) {
			setPassword("");
			setErrorMsg(null);
			setLoading(false);
		}
	}, [open]);

	const handleClose = useCallback(() => {
		if (loading) return; // 提交中禁止关闭，避免悬空状态
		onClose();
	}, [loading, onClose]);

	const handleSubmit = useCallback(async () => {
		if (!password.trim() || loading) return;
		setErrorMsg(null);
		setLoading(true);
		try {
			await vaultApi.enableTrustedDevice(password);
			onSuccess();
		} catch (err) {
			console.error("[EnableTrustedDeviceDialog] failed:", err);
			const kind = vaultErrorKind(err);
			if (kind === "invalid-password") {
				setErrorMsg(t("settings_trusted_device_err_invalid_password"));
			} else if (
				err instanceof Error &&
				err.message.includes("not supported")
			) {
				// 后端在不支持平台直接抛 ErrTrustedDeviceUnsupported
				// 正常路径不会触达（UI 已经把开关置灰），这里兜底防御
				setErrorMsg(t("settings_trusted_device_err_unsupported"));
			} else {
				setErrorMsg(t("settings_trusted_device_err_unknown"));
			}
		} finally {
			setLoading(false);
		}
	}, [password, loading, t, onSuccess]);

	return (
		<RadixDialog.Root
			open={open}
			onOpenChange={(v) => {
				if (!v) handleClose();
			}}
		>
			<RadixDialog.Portal container={dialogPortalContainer()}>
				<RadixDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
				<RadixDialog.Content
					aria-describedby={undefined}
					className={clsx(DIALOG_CONTENT_BASE_CLASS, "w-110")}
					onEscapeKeyDown={(e) => {
						if (loading) e.preventDefault();
					}}
				>
					<RadixDialog.Title className="text-[16px] font-semibold text-(--text)">
						{t("settings_trusted_device_enable_title")}
					</RadixDialog.Title>
					<p className="text-[13px] leading-relaxed text-(--text-2)">
						{t("settings_trusted_device_enable_msg")}
					</p>

					{/* 适用 / 不适用场景说明 —— 帮助用户判断是否真应该启用 */}
					<div className="flex flex-col gap-2.5 rounded-sm border border-(--line-soft) bg-(--bg-elev) px-3.5 py-3 text-[12px] leading-relaxed">
						<div className="flex flex-col gap-1">
							<span className="text-[11px] font-medium text-(--text-2)">
								{t("settings_trusted_device_enable_when_safe")}
							</span>
							<ul className="flex flex-col gap-0.5 pl-3 text-(--text-3)">
								<li>· {t("settings_trusted_device_enable_safe_1")}</li>
								<li>· {t("settings_trusted_device_enable_safe_2")}</li>
								<li>· {t("settings_trusted_device_enable_safe_3")}</li>
							</ul>
						</div>
						<div className="flex flex-col gap-1">
							<span className="text-[11px] font-medium text-(--warn)">
								{t("settings_trusted_device_enable_when_unsafe")}
							</span>
							<ul className="flex flex-col gap-0.5 pl-3 text-(--text-3)">
								<li>· {t("settings_trusted_device_enable_unsafe_1")}</li>
								<li>· {t("settings_trusted_device_enable_unsafe_2")}</li>
							</ul>
						</div>
					</div>

					{/* 主密码确认输入 */}
					<div className="flex flex-col gap-1.5">
						<label className="text-[12px] text-(--text-2)">
							{t("settings_trusted_device_enable_password_label")}
						</label>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									void handleSubmit();
								}
							}}
							placeholder={t(
								"settings_trusted_device_enable_password_placeholder",
							)}
							disabled={loading}
							autoFocus
							className="rounded-sm border border-(--line) bg-(--bg) px-3 py-2 text-[13px] text-(--text) outline-none transition-colors focus:border-(--text-3) disabled:opacity-60"
						/>
						{errorMsg && (
							<div className="flex items-start gap-2 text-[12px] text-(--warn)">
								<AlertTriangle
									size={13}
									strokeWidth={1.5}
									className="mt-0.5 shrink-0"
								/>
								<span>{errorMsg}</span>
							</div>
						)}
					</div>

					<div className="flex justify-end gap-3 pt-1">
						<Button
							variant="secondary"
							size="md"
							onClick={handleClose}
							disabled={loading}
						>
							{t("settings_trusted_device_enable_cancel")}
						</Button>
						<Button
							variant="default"
							size="md"
							onClick={() => void handleSubmit()}
							disabled={loading || !password.trim()}
						>
							{t("settings_trusted_device_enable_confirm")}
						</Button>
					</div>
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}

export default TrustedDeviceSection;
