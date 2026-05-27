import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import {
	AlertTriangle,
	Download,
	Fingerprint,
	KeyRound,
	Lock,
	ShieldCheck,
	StickyNote,
	TerminalSquare,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { vaultApi } from "@/lib/vault-api";
import { useUIStore } from "@/stores/ui";

/**
 * ExportDialog —— 整库明文备份对话框
 * ---------------------------------------------------------------------------
 * 与 ImportDialog 对称的「导出」入口，挂在 Sidebar 账户菜单内。
 *
 * 安全模型：
 *   1. 显著警告 + 完整披露：用图标列表让用户清楚导出文件会包含哪些
 *      敏感字段（账号密码 / SSH 私钥 / Passkey 私钥 / TOTP 秘钥），
 *      避免用户因「以为只是条目名」而误把文件上传到 GitHub / 群文件夹。
 *   2. 主密码二次确认：调 vaultApi.verifyMasterPassword(password)，
 *      后端会重新跑一次 Argon2id 派生，确认是本人操作。
 *      错误时仅显示「主密码不正确」，不区分密码错 / DB 错（与 Unlock 一致）。
 *   3. 全程在 Go 进程内完成：通过 vaultApi.exportAllToFile() 让后端
 *      解密 → 组装 JSON → 弹系统 SaveFile dialog → 原子写文件，整库
 *      明文不通过 IPC 回传到 webview。
 *
 * 流程：
 *   关闭 → open=false → 重置内部状态
 *   打开 → 用户读完警告 → 输入主密码 → 点击「导出…」
 *     → 调 verifyMasterPassword：密码错 → 红字提示，保留 dialog
 *                                 → 通过 → 调 exportAllToFile，
 *                                          弹系统保存对话框
 *     → cancelled=true：toast「已取消」+ 关 dialog
 *     → cancelled=false：toast「已导出 N 个条目到 PATH」+ 关 dialog
 *     → 抛错（写盘失败等）：红字提示，保留 dialog 让用户重试
 *
 * Radix Dialog Portal 通过 #portal-root 挂载，使 Titlebar 仍可拖动（与
 * ImportDialog 同款处理，详见历史 bugfix 注释）。
 */

export interface ExportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
	const { t } = useTranslation();
	const pushToast = useUIStore((s) => s.pushToast);

	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [errMsg, setErrMsg] = useState<string | null>(null);
	const passwordInputRef = useRef<HTMLInputElement>(null);

	// 关闭时清空状态，防止下次打开仍残留旧密码 / 错误提示
	useEffect(() => {
		if (!open) {
			setPassword("");
			setBusy(false);
			setErrMsg(null);
		}
	}, [open]);

	// 打开时把焦点放到密码输入框 —— 用户立刻能开始输入
	// Radix Dialog 的 autoFocus 不一定命中我们的密码框（其它按钮可能抢焦点），
	// 显式 ref + useEffect 兜底。
	useEffect(() => {
		if (open) {
			const id = window.setTimeout(() => {
				passwordInputRef.current?.focus();
			}, 50);
			return () => window.clearTimeout(id);
		}
	}, [open]);

	const handleExport = async () => {
		if (busy) return;
		setErrMsg(null);

		// 1. 主密码二次确认
		try {
			await vaultApi.verifyMasterPassword(password);
		} catch (err) {
			const kind = vaultApi.errorKind(err);
			if (kind === "invalid-password") {
				setErrMsg(t("export_invalid_password"));
			} else {
				const message = err instanceof Error ? err.message : String(err);
				setErrMsg(t("export_error_generic", { message }));
			}
			passwordInputRef.current?.focus();
			passwordInputRef.current?.select();
			return;
		}

		// 2. 调后端弹保存对话框 + 写文件
		setBusy(true);
		try {
			const result = await vaultApi.exportAllToFile();
			if (result.cancelled) {
				pushToast({
					text: t("export_cancelled"),
					icon: "x",
					duration: 2000,
				});
			} else {
				pushToast({
					text: t("export_done", {
						n: result.itemCount,
						path: result.path,
					}),
					icon: "check",
					// 给「打开目录」按钮多留点时间被点到；4 秒在长路径 + 中文阅读
					// 速度下偏紧，bumped 到 8 秒。
					duration: 8000,
					action: {
						label: t("export_open_folder"),
						onClick: () => {
							void window.desktop.shell.showInFolder(result.path);
						},
					},
				});
			}
			onOpenChange(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setErrMsg(t("export_error_generic", { message }));
		} finally {
			setBusy(false);
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		handleExport();
	};

	return (
		<RadixDialog.Root open={open} onOpenChange={onOpenChange}>
			<RadixDialog.Portal
				container={typeof document !== "undefined" ? document.getElementById("portal-root") : null}
			>
				<RadixDialog.Overlay
					className={clsx(
						"fixed inset-0 z-50 zpass-backdrop",
						"data-[state=open]:animate-[zpass-overlay-in_140ms_ease-out]",
					)}
				/>
				<RadixDialog.Content
					aria-describedby={undefined}
					className={clsx(
						"fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
						"w-full min-w-[480px] max-w-xl max-h-[88vh] overflow-hidden",
						"zpass-glass rounded-(--radius-xl)",
						"flex flex-col",
						"data-[state=open]:animate-[zpass-dialog-in_180ms_ease-out]",
						"focus:outline-none",
					)}
				>
					{/* 头部 */}
					<div className="flex shrink-0 items-start justify-between gap-3 border-b border-(--line-soft) px-6 pt-5 pb-3.5">
						<div className="flex flex-col gap-0.5">
							<RadixDialog.Title className="text-[15px] font-semibold tracking-tight text-(--text)">
								{t("export_title")}
							</RadixDialog.Title>
							<RadixDialog.Description className="text-[11.5px] leading-snug text-(--text-3)">
								{t("export_sub")}
							</RadixDialog.Description>
						</div>
						<RadixDialog.Close asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label={t("common_close")}
								className="-mt-0.5 -mr-1.5"
								disabled={busy}
							>
								<X size={14} strokeWidth={1.5} />
							</Button>
						</RadixDialog.Close>
					</div>

					{/* 主体 */}
					<form
						onSubmit={handleSubmit}
						className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
					>
						{/* ── 高对比明文警告 ── */}
						<section className="flex flex-col gap-2.5 rounded-(--radius) border border-(--danger)/45 bg-(--danger)/8 px-4 py-3.5">
							<div className="flex items-start gap-2.5">
								<AlertTriangle size={16} strokeWidth={1.6} className="mt-0.5 shrink-0 text-(--danger)" />
								<div className="flex flex-col gap-1">
									<span className="text-[13px] font-semibold text-(--danger)">
										{t("export_warning_title")}
									</span>
									<p className="text-[12px] leading-relaxed text-(--text-2)">{t("export_warning_body")}</p>
								</div>
							</div>
						</section>

						{/* ── 内容清单：图标列表显式告知导出包含什么 ── */}
						<section className="flex flex-col gap-2">
							<div className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--text-3)">
								{t("export_includes_label")}
							</div>
							<div className="grid grid-cols-2 gap-1.5">
								<IncludeChip icon={KeyRound} label={t("export_includes_logins")} />
								<IncludeChip icon={TerminalSquare} label={t("export_includes_ssh")} />
								<IncludeChip icon={Fingerprint} label={t("export_includes_passkey")} />
								<IncludeChip icon={ShieldCheck} label={t("export_includes_totp")} />
								<IncludeChip icon={StickyNote} label={t("export_includes_notes")} className="col-span-2" />
							</div>
						</section>

						{/* ── 格式说明（当前唯一支持 zpass JSON） ── */}
						<section className="flex flex-col gap-2">
							<div className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--text-3)">
								{t("export_format_label")}
							</div>
							<div className="flex items-start gap-2.5 rounded-(--radius) border border-(--text) bg-(--bg-active) px-3 py-2.5">
								<input
									type="radio"
									name="exp-fmt"
									checked
									readOnly
									className="mt-0.5 shrink-0 accent-(--accent)"
								/>
								<div className="flex min-w-0 flex-col gap-0.5">
									<div className="truncate text-[13px] font-medium text-(--text)">
										{t("export_format_json")}
									</div>
									<div className="font-mono text-[10.5px] leading-snug text-(--text-3)">
										{t("export_format_json_hint")}
									</div>
								</div>
							</div>
						</section>

						{/* ── 主密码二次确认 ── */}
						<section className="flex flex-col gap-2">
							<label
								htmlFor="export-password"
								className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--text-3)"
							>
								{t("export_confirm_password_label")}
							</label>
							<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev) px-3 focus-within:border-(--text-3)">
								<Lock size={14} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
								<input
									ref={passwordInputRef}
									id="export-password"
									type="password"
									autoComplete="current-password"
									value={password}
									onChange={(e) => {
										setPassword(e.target.value);
										if (errMsg) setErrMsg(null);
									}}
									placeholder={t("export_confirm_password_placeholder")}
									disabled={busy}
									className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-(--text) outline-none placeholder:text-(--text-4)"
								/>
							</div>
							<p className="text-[11px] leading-snug text-(--text-3)">
								{t("export_confirm_password_hint")}
							</p>
							{errMsg && (
								<div className="flex items-center gap-2 rounded-(--radius-sm) border border-(--danger)/40 bg-(--danger)/8 px-3 py-2 text-[12px] text-(--danger)">
									<AlertTriangle size={14} strokeWidth={1.5} className="shrink-0" />
									<span>{errMsg}</span>
								</div>
							)}
						</section>

						{/* form submit 触发器：Enter 提交 ——
						 *
						 * 真正的「Export」按钮在外层 footer，这里用一个 sr-only 的 submit
						 * 让 password input 上 Enter 也能提交，UX 与「输入主密码后回车解锁」
						 * 的解锁页一致。 */}
						<button type="submit" className="sr-only" tabIndex={-1}>
							submit
						</button>
					</form>

					{/* 底部 */}
					<div className="flex shrink-0 flex-nowrap items-center justify-end gap-2 border-t border-(--line-soft) bg-(--bg-elev) px-6 py-3">
						<RadixDialog.Close asChild>
							<Button variant="ghost" size="md" disabled={busy} className="shrink-0 whitespace-nowrap">
								{t("export_cancel")}
							</Button>
						</RadixDialog.Close>
						<Button
							type="button"
							variant="default"
							size="md"
							onClick={handleExport}
							disabled={!password || busy}
							loading={busy}
							leftIcon={<Download size={13} strokeWidth={1.5} />}
							className="shrink-0 whitespace-nowrap"
						>
							{busy ? t("export_running") : t("export_run")}
						</Button>
					</div>
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}

// ── 辅助子组件 ─────────────────────────────────────────────────

interface IncludeChipProps {
	icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
	label: string;
	className?: string;
}

/**
 * IncludeChip —— 「本次导出将包含」清单项
 *
 * 视觉上是一个带细描边的小方块，左侧图标 + 右侧文字。在 grid 网格里
 * 排成两列，长文案可通过 className="col-span-2" 跨整行。
 */
function IncludeChip({ icon: Icon, label, className }: IncludeChipProps) {
	return (
		<div
			className={clsx(
				"flex items-center gap-2 rounded-sm border border-(--line) bg-(--bg-elev) px-2.5 py-1.5 text-[12px] text-(--text-2)",
				className,
			)}
		>
			<Icon size={13} strokeWidth={1.5} />
			<span className="truncate">{label}</span>
		</div>
	);
}

export default ExportDialog;
