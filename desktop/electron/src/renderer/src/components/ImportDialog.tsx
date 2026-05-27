import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import {
	AlertTriangle,
	CreditCard,
	Download,
	IdCard,
	LogIn,
	StickyNote,
	TerminalSquare,
	Upload,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import {
	dedupeByName,
	type ImportError,
	type ImportResult,
	importBitwardenText,
} from "@/lib/import-bitwarden";
import type { VaultItemInput } from "@/lib/vault-api";
import { useUIStore } from "@/stores/ui";
import { useVaultStore } from "@/stores/vault";

/**
 * ImportDialog — Bitwarden 数据导入对话框
 *
 * 流程：
 *   1. 选格式（目前只 Bitwarden JSON；CXF 占位灰显，等 FIDO Alliance 规范稳定）
 *   2. 选文件 / 拖拽 → 前端解析 → 显示统计 + 前 5 条预览
 *   3. 选冲突策略（追加 / 按名称跳过）
 *   4. 提交：循环 vaultApi.createItem，最后 toast 报告结果
 *
 * 解析全在前端完成，文件内容不上传任何地方；写库走与"新建条目"完全一致的
 * 加密路径（vaultApi.createItem → SealAEAD），不会在内存中长时间留存明文。
 */
export interface ImportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type Strategy = "append" | "skip-dupe";

export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
	const { t } = useTranslation();
	const pushToast = useUIStore((s) => s.pushToast);
	const items = useVaultStore((s) => s.items);
	const importMany = useVaultStore((s) => s.importMany);

	const [fileName, setFileName] = useState("");
	const [result, setResult] = useState<ImportResult | ImportError | null>(null);
	const [strategy, setStrategy] = useState<Strategy>("append");
	const [busy, setBusy] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	// 关闭时重置状态，避免下次打开仍残留上一次的预览
	useEffect(() => {
		if (!open) {
			setFileName("");
			setResult(null);
			setStrategy("append");
			setBusy(false);
			setSubmitting(false);
			setDragOver(false);
		}
	}, [open]);

	const readFile = (file: File) => {
		setFileName(file.name);
		setBusy(true);
		const reader = new FileReader();
		reader.onload = () => {
			const text = String(reader.result || "");
			setResult(importBitwardenText(text));
			setBusy(false);
		};
		reader.onerror = () => {
			setResult({ ok: false, reason: "parse_error" });
			setBusy(false);
		};
		reader.readAsText(file);
	};

	const onPick: React.ChangeEventHandler<HTMLInputElement> = (e) => {
		const f = e.target.files?.[0];
		if (f) readFile(f);
		// 清空 value，便于用户连续选同一个文件后仍触发 change 事件
		e.target.value = "";
	};

	const onDrop: React.DragEventHandler<HTMLDivElement> = (e) => {
		e.preventDefault();
		setDragOver(false);
		const f = e.dataTransfer?.files?.[0];
		if (f) readFile(f);
	};

	const apply = async () => {
		if (!result || !result.ok) return;
		let toAdd: VaultItemInput[] = result.items;
		let droppedDupes = 0;
		if (strategy === "skip-dupe") {
			const r = dedupeByName(items, toAdd);
			toAdd = r.kept;
			droppedDupes = r.dropped.length;
		}
		setSubmitting(true);
		try {
			const { ok, fail } = await importMany(toAdd);
			if (fail > 0) {
				pushToast({
					text: t("import_partial_fail", { ok, fail }),
					icon: "x",
					duration: 3000,
				});
			} else if (droppedDupes > 0) {
				pushToast({
					text: t("import_done_some", { ok, skip: droppedDupes }),
					icon: "check",
					duration: 2500,
				});
			} else {
				pushToast({
					text: t("import_done", { n: ok }),
					icon: "check",
					duration: 2500,
				});
			}
			onOpenChange(false);
		} finally {
			setSubmitting(false);
		}
	};

	const okN = result?.ok ? result.items.length : 0;
	const totalN = result?.ok ? result.total : 0;
	const skippedN = result?.ok ? result.skipped.length : 0;
	const stats = result?.ok ? result.stats : null;
	const previewItems = result?.ok ? result.items.slice(0, 5) : [];

	const errMsg = (() => {
		if (!result || result.ok) return null;
		if (result.reason === "encrypted") return t("import_encrypted");
		return t("import_parse_error");
	})();

	return (
		<RadixDialog.Root open={open} onOpenChange={onOpenChange}>
			<RadixDialog.Portal
				container={
					typeof document !== "undefined"
						? document.getElementById("portal-root")
						: null
				}
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
						// min-w 保底 —— 避免内容窄时底部按钮区因父级宽度收缩而换行
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
								{t("import_title")}
							</RadixDialog.Title>
							<RadixDialog.Description className="text-[11.5px] leading-snug text-(--text-3)">
								{t("import_sub")}
							</RadixDialog.Description>
						</div>
						<RadixDialog.Close asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label={t("common_close")}
								className="-mt-0.5 -mr-1.5"
							>
								<X size={14} strokeWidth={1.5} />
							</Button>
						</RadixDialog.Close>
					</div>

					{/* 主体 */}
					<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
						{/* 格式选择 */}
						<section className="flex flex-col gap-2">
							<div className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--text-3)">
								{t("import_format_label")}
							</div>
							<div className="grid grid-cols-2 gap-2">
								<div
									className={clsx(
										"flex min-w-0 items-start gap-2.5 rounded-(--radius) border px-3 py-2.5",
										"border-(--text) bg-(--bg-active)",
									)}
								>
									<input
										type="radio"
										name="imp-fmt"
										checked
										readOnly
										className="mt-0.5 shrink-0 accent-(--accent)"
									/>
									<div className="flex min-w-0 flex-col gap-0.5">
										<div className="truncate text-[13px] font-medium text-(--text)">
											{t("import_format_bw")}
										</div>
										<div className="font-mono text-[10.5px] leading-snug text-(--text-3)">
											{t("import_format_bw_hint")}
										</div>
									</div>
								</div>
								<div
									className={clsx(
										"flex min-w-0 items-start gap-2.5 rounded-(--radius) border px-3 py-2.5",
										"border-(--line) bg-(--bg-elev) opacity-50",
									)}
								>
									<input
										type="radio"
										name="imp-fmt"
										disabled
										className="mt-0.5 shrink-0"
									/>
									<div className="flex min-w-0 flex-col gap-0.5">
										<div className="text-[13px] font-medium leading-snug text-(--text)">
											{t("import_format_cxf")}
										</div>
									</div>
								</div>
							</div>
						</section>

						{/* 文件选择 / 拖拽 */}
						<section className="flex flex-col gap-2">
							<div
								className={clsx(
									"grid grid-cols-[auto_1fr_auto] items-center gap-3",
									"rounded-(--radius) border border-dashed bg-(--bg-elev) px-4 py-4",
									"transition-colors",
									dragOver
										? "border-(--text) bg-(--bg-active)"
										: result?.ok
											? "border-(--ok)/40"
											: result && !result.ok
												? "border-(--danger)/50"
												: "border-(--line)",
								)}
								onDragOver={(e) => {
									e.preventDefault();
									setDragOver(true);
								}}
								onDragLeave={() => setDragOver(false)}
								onDrop={onDrop}
							>
								<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-sm) border border-(--line) bg-(--bg-elev-2) text-(--text-2)">
									<Upload size={18} strokeWidth={1.5} />
								</div>
								<div className="flex min-w-0 items-center gap-2.5">
									<Button
										type="button"
										variant="secondary"
										size="sm"
										onClick={() => fileRef.current?.click()}
										disabled={busy || submitting}
										className="shrink-0 whitespace-nowrap"
									>
										{t("import_choose")}
									</Button>
									{/* 提示文本：单行，溢出截断；窄宽下让位给文件名 */}
									<span className="truncate font-mono text-[11px] text-(--text-3)">
										{t("import_drop")}
									</span>
								</div>
								<div
									className={clsx(
										"max-w-[180px] shrink-0 truncate text-right font-mono text-[11px]",
										fileName ? "text-(--text-2)" : "text-(--text-3)",
									)}
									title={fileName || undefined}
								>
									{fileName || t("import_no_file")}
								</div>
								<input
									ref={fileRef}
									type="file"
									accept=".json,application/json"
									className="hidden"
									onChange={onPick}
								/>
							</div>
							{errMsg && (
								<div className="flex items-center gap-2 rounded-(--radius-sm) border border-(--danger)/40 bg-(--danger)/8 px-3 py-2 text-[12px] text-(--danger)">
									<AlertTriangle size={14} strokeWidth={1.5} className="shrink-0" />
									<span>{errMsg}</span>
								</div>
							)}
						</section>

						{/* 统计 + 预览 + 策略 */}
						{result?.ok && (
							<>
								<section className="flex flex-col gap-2">
									<div className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--text-3)">
										{t("import_breakdown")}
									</div>
									<div className="text-[13px] text-(--text)">
										{okN > 0
											? t("import_summary", { n: okN, total: totalN })
											: t("import_summary_zero")}
									</div>
									<div className="flex flex-wrap gap-1.5">
										{stats && stats.login > 0 && (
											<StatChip icon={LogIn} label={t("import_count_login")} value={stats.login} />
										)}
										{stats && stats.card > 0 && (
											<StatChip icon={CreditCard} label={t("import_count_card")} value={stats.card} />
										)}
										{stats && stats.note > 0 && (
											<StatChip icon={StickyNote} label={t("import_count_note")} value={stats.note} />
										)}
										{stats && stats.identity > 0 && (
											<StatChip icon={IdCard} label={t("import_count_identity")} value={stats.identity} />
										)}
										{stats && stats.ssh > 0 && (
											<StatChip icon={TerminalSquare} label={t("import_count_ssh")} value={stats.ssh} />
										)}
										{skippedN > 0 && (
											<StatChip
												icon={AlertTriangle}
												label={t("import_count_skipped")}
												value={skippedN}
												tone="warn"
											/>
										)}
									</div>
									{skippedN > 0 && (
										<div className="rounded-(--radius-sm) border border-(--warn)/30 bg-(--warn)/8 px-3 py-2 text-[12px] text-(--warn)">
											{t("import_warning_skipped", { n: skippedN })}
										</div>
									)}
								</section>

								{previewItems.length > 0 && (
									<section className="flex flex-col gap-2">
										<div className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--text-3)">
											{t("import_preview")}
										</div>
										<div className="overflow-hidden rounded-(--radius-sm) border border-(--line) bg-(--bg-elev)">
											{previewItems.map((p, i) => {
												const f = (p.fields ?? {}) as Record<string, unknown>;
												const sub =
													(f.username as string) ||
													(f.url as string) ||
													(f.cardholder as string) ||
													(f.email as string) ||
													"";
												return (
													<div
														key={`${p.name}-${i}`}
														className="grid grid-cols-[80px_1fr_1fr] items-center gap-3 border-b border-(--line-soft) px-3 py-2 text-[12px] last:border-b-0"
													>
														<span className="inline-block w-fit rounded-sm border border-(--line) px-1.5 font-mono text-[10px] uppercase tracking-[0.05em] text-(--text-3)">
															{p.type}
														</span>
														<span className="truncate text-(--text)">{p.name}</span>
														<span className="truncate font-mono text-(--text-3)">
															{sub}
														</span>
													</div>
												);
											})}
										</div>
									</section>
								)}

								<section className="flex flex-col gap-2">
									<div className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--text-3)">
										{t("import_strategy_label")}
									</div>
									<div className="flex flex-col gap-1">
										<label className="flex cursor-pointer items-center gap-2 text-[13px] text-(--text-2) hover:text-(--text)">
											<input
												type="radio"
												name="imp-strat"
												value="append"
												checked={strategy === "append"}
												onChange={() => setStrategy("append")}
												className="accent-(--accent)"
											/>
											<span>{t("import_strategy_append")}</span>
										</label>
										<label className="flex cursor-pointer items-center gap-2 text-[13px] text-(--text-2) hover:text-(--text)">
											<input
												type="radio"
												name="imp-strat"
												value="skip-dupe"
												checked={strategy === "skip-dupe"}
												onChange={() => setStrategy("skip-dupe")}
												className="accent-(--accent)"
											/>
											<span>{t("import_strategy_skip_dupe")}</span>
										</label>
									</div>
								</section>
							</>
						)}
					</div>

					{/* 底部
					 *
					 * 注意：
					 * - flex-nowrap + 按钮 shrink-0 + whitespace-nowrap 保证窄宽下也不换行
					 * - 图标走 Button 的 leftIcon 而非 children，避免 loading 态时
					 *   spinner 与图标重叠（Button 内部 loading=true 时只渲染 spinner）
					 */}
					<div className="flex shrink-0 flex-nowrap items-center justify-end gap-2 border-t border-(--line-soft) bg-(--bg-elev) px-6 py-3">
						<RadixDialog.Close asChild>
							<Button
								variant="ghost"
								size="md"
								disabled={submitting}
								className="shrink-0 whitespace-nowrap"
							>
								{t("import_cancel")}
							</Button>
						</RadixDialog.Close>
						<Button
							variant="default"
							size="md"
							onClick={apply}
							disabled={!result?.ok || okN === 0 || submitting}
							loading={submitting}
							leftIcon={<Download size={13} strokeWidth={1.5} />}
							className="shrink-0 whitespace-nowrap"
						>
							{submitting ? t("import_running") : t("import_run")}
						</Button>
					</div>
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}

// ── 辅助子组件 ──────────────────────────────────────────────────

interface StatChipProps {
	icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
	label: string;
	value: number;
	tone?: "default" | "warn";
}

function StatChip({ icon: Icon, label, value, tone = "default" }: StatChipProps) {
	return (
		<span
			className={clsx(
				"inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border bg-(--bg-elev-2) px-2 py-0.5 font-mono text-[11px]",
				tone === "warn"
					? "border-(--warn)/35 text-(--warn)"
					: "border-(--line) text-(--text-2)",
			)}
		>
			<Icon size={12} strokeWidth={1.5} />
			<span>{label}</span>
			<b className={tone === "warn" ? "text-(--warn)" : "text-(--text)"}>
				{value}
			</b>
		</span>
	);
}

export default ImportDialog;
