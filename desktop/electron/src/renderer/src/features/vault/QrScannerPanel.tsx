// QrScannerPanel.tsx —— ItemDialog 内嵌的「从二维码导入身份验证器密钥」面板
// ---------------------------------------------------------------------------
// 设计目标：
//
//   1. 不开新 Modal —— 复用 ItemDialog 已有的 Radix Dialog 容器，避免叠加
//      z-index / focus trap 难题。展开/折叠状态由父组件 ItemDialog 持有。
//
//   2. 三种输入并存（用户自由选择，不强迫一种）：
//      - 粘贴：面板可见时全局监听 paste 事件，从 ClipboardEvent 取 image blob
//      - 选择文件：点按钮调 <input type=file accept=image/*>
//      - 拖拽：dropzone 全套（dragenter/over/leave/drop）+ 视觉高亮
//
//   3. 解码后必须二次确认（防钓鱼）：把识别到的 issuer/account/algorithm/
//      period 等全部展示出来，让用户判断这是不是自己想要的二维码，再点
//      "使用此密钥" 才真正写入字段。
//
//   4. 安全 / 隐私：
//      - 图像 base64 经 Wails IPC 传入 Go 后端解码 (qrservice.go)
//      - 图像字节在 Go 进程中用完即被 GC，不进入任何持久化层
//      - 前端关闭面板时 setState(null) 让 React 把 secret 字符串 GC
//      - 不打 console / 不上报
//
//   5. 填充策略：
//      - totp 字段写入完整 otpauth:// URI（不是裸 secret），让后端能拿到所有
//        元信息（algorithm / digits / period / counter / Steam 标记）
//      - 如果当前条目类型是 "totp"（独立验证器），且 issuer / account 字段
//        为空，则一并自动填充；非空时不覆盖（尊重用户输入）
//
// 失败态 UI 映射：
//   - 后端返回错误（图不可读 / 没找到 QR） → "未识别到二维码"
//   - 找到 QR 但不是 otpauth → "这不是身份验证器二维码"，显示前 80 字符
//   - 文件不是图片         → toast 红条 + 不进入解码
//   - 大文件 (>10MB)       → toast 红条 + 拒绝

import { Camera, Clipboard, FileImage, ShieldCheck, X } from "lucide-react";
import {
	type ChangeEvent,
	type DragEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import type { OtpauthMeta, OtpauthParseError } from "@/lib/parse-otpauth";
import { formatBase32Groups, parseOtpauth } from "@/lib/parse-otpauth";
import { vaultApi } from "@/lib/vault-api";
import { useUIStore } from "@/stores/ui";

// 文件大小上限：10 MB
// 截图通常 <2 MB；超过 10 MB 大概率是误拖（视频 / 高分原图），直接拒绝
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * 内部状态机
 *
 *   idle    : 等待输入（粘贴 / 选文件 / 拖拽）
 *   decoding: 正在解码（loading spinner）
 *   ok      : 解码成功，展示元信息预览
 *   bad     : 解码失败 / 内容不是 otpauth；展示错误提示与重试入口
 */
type PanelState =
	| { kind: "idle" }
	| { kind: "decoding" }
	| { kind: "ok"; meta: OtpauthMeta; raw: string }
	| { kind: "bad"; error: OtpauthParseError | "no-qr"; rawText?: string };

export interface QrScannerPanelProps {
	/** 关闭面板（父组件控制可见性）。点 × / 取消 / 应用成功后都会调一次 */
	onClose: () => void;
	/**
	 * 应用识别结果。父组件按以下顺序处理：
	 *   1. setField("totp", uri)
	 *   2. 若当前是独立 totp 条目，且 issuer 字段为空 → setField("issuer", meta.issuer)
	 *   3. 同上，account 字段为空 → setField("account", meta.account)
	 *
	 * 这里只把数据交出去，父组件根据 type 决定填哪些字段。
	 */
	onApply: (uri: string, meta: OtpauthMeta) => void;
}

export function QrScannerPanel({ onClose, onApply }: QrScannerPanelProps) {
	const { t } = useTranslation();
	const pushToast = useUIStore((s) => s.pushToast);
	const fileInputId = useId();
	const fileInputRef = useRef<HTMLInputElement>(null);

	const [state, setState] = useState<PanelState>({ kind: "idle" });
	const [dragOver, setDragOver] = useState(false);
	const [revealSecret, setRevealSecret] = useState(false);

	// ---------------------------------------------------------------------------
	// 解码核心
	// ---------------------------------------------------------------------------
	//
	// 解码走 Go 后端 QRService.DecodeQR (gozxing) —— 跨平台一致、识别率超越
	// 前端 jsQR，对带中心 logo / 轻度倾斜的 QR 都能识出。后端任何错误
	// （图像不可读 / 未识别到 QR）都招出，UI 统一按 no-qr 提示。

	const decodeBlob = useCallback(async (blob: Blob) => {
		setState({ kind: "decoding" });
		try {
			const data = await vaultApi.decodeQR(blob);
			const parsed = parseOtpauth(data);
			if (parsed.ok && parsed.meta) {
				setState({ kind: "ok", meta: parsed.meta, raw: parsed.raw });
			} else {
				setState({
					kind: "bad",
					error: parsed.error ?? "not-otpauth",
					rawText: data.slice(0, 80),
				});
			}
		} catch {
			// 后端报错 = 图像不可读 / 未识别到 QR —— 统一按 no-qr
			setState({ kind: "bad", error: "no-qr" });
		}
	}, []);

	// ---------------------------------------------------------------------------
	// 输入入口 1：文件选择
	// ---------------------------------------------------------------------------

	const handleFile = useCallback(
		(file: File) => {
			if (!file.type.startsWith("image/")) {
				pushToast({ text: t("qr_err_not_image"), icon: "alert-triangle" });
				return;
			}
			if (file.size > MAX_FILE_BYTES) {
				pushToast({ text: t("qr_err_too_large"), icon: "alert-triangle" });
				return;
			}
			void decodeBlob(file);
		},
		[decodeBlob, pushToast, t],
	);

	const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0];
		if (f) handleFile(f);
		// 允许同一文件二次选择 —— 清空 input value
		e.target.value = "";
	};

	// ---------------------------------------------------------------------------
	// 输入入口 2：粘贴（全局 paste 事件，仅在面板可见时挂载）
	// ---------------------------------------------------------------------------

	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			// 已经在解码 / 已有结果时忽略，避免重复处理
			if (state.kind === "decoding") return;
			const items = e.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.kind === "file" && item.type.startsWith("image/")) {
					const blob = item.getAsFile();
					if (blob) {
						e.preventDefault();
						handleFile(blob);
						return;
					}
				}
			}
			// 剪贴板里没图像 —— 不抢用户输入框焦点，只在面板 idle 时给个轻提示
			if (state.kind === "idle") {
				pushToast({ text: t("qr_err_no_image_in_clipboard"), icon: "info" });
			}
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	}, [state.kind, handleFile, pushToast, t]);

	// ---------------------------------------------------------------------------
	// 输入入口 3：拖拽
	// ---------------------------------------------------------------------------

	const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setDragOver(true);
	};
	const onDragOver = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		// 让浏览器显示"复制"光标而非"禁止"
		e.dataTransfer.dropEffect = "copy";
	};
	const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setDragOver(false);
	};
	const onDrop = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setDragOver(false);
		const f = e.dataTransfer.files?.[0];
		if (f) handleFile(f);
	};

	// ---------------------------------------------------------------------------
	// 应用结果
	// ---------------------------------------------------------------------------

	const onConfirm = () => {
		if (state.kind !== "ok" || !state.meta) return;
		onApply(state.raw, state.meta);
		// 主动 reset state，让后续重开面板时回到 idle
		setState({ kind: "idle" });
		setRevealSecret(false);
		onClose();
	};

	const onCancel = () => {
		setState({ kind: "idle" });
		setRevealSecret(false);
		onClose();
	};

	const onRetry = () => {
		setState({ kind: "idle" });
		setRevealSecret(false);
	};

	// ---------------------------------------------------------------------------
	// 渲染
	// ---------------------------------------------------------------------------

	return (
		<section
			className="flex flex-col gap-3 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) p-4"
			aria-label={t("qr_panel_title")}
		>
			{/* 顶部标题 + 关闭 */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-1.5 text-[12.5px] font-medium text-(--text)">
					<Camera size={13} strokeWidth={1.6} />
					{t("qr_panel_title")}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onCancel}
					aria-label={t("common_close")}
				>
					<X size={13} strokeWidth={1.5} />
				</Button>
			</div>

			{/* 主体：根据 state 分支 */}
			{state.kind === "idle" && (
				<IdleZone
					dragOver={dragOver}
					onDragEnter={onDragEnter}
					onDragOver={onDragOver}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
					onPickFile={() => fileInputRef.current?.click()}
				/>
			)}

			{state.kind === "decoding" && (
				<div className="flex h-32 flex-col items-center justify-center gap-2 text-(--text-3)">
					<div className="h-4 w-4 animate-spin rounded-full border-2 border-(--line) border-t-(--text)" />
					<div className="text-[12px]">{t("qr_decoding")}</div>
				</div>
			)}

			{state.kind === "ok" && state.meta && (
				<ResultOk
					meta={state.meta}
					revealSecret={revealSecret}
					onToggleReveal={() => setRevealSecret((v) => !v)}
					onConfirm={onConfirm}
					onCancel={onCancel}
				/>
			)}

			{state.kind === "bad" && (
				<ResultBad error={state.error} rawText={state.rawText} onRetry={onRetry} />
			)}

			{/* 隐藏 file input —— 始终挂在 DOM 里以便从任意状态点击触发 */}
			<input
				ref={fileInputRef}
				id={fileInputId}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
				className="sr-only"
				onChange={onFileChange}
			/>
		</section>
	);
}

// ---------------------------------------------------------------------------
// 子组件：idle 状态的 dropzone
// ---------------------------------------------------------------------------

function IdleZone({
	dragOver,
	onDragEnter,
	onDragOver,
	onDragLeave,
	onDrop,
	onPickFile,
}: {
	dragOver: boolean;
	onDragEnter: (e: DragEvent<HTMLDivElement>) => void;
	onDragOver: (e: DragEvent<HTMLDivElement>) => void;
	onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
	onDrop: (e: DragEvent<HTMLDivElement>) => void;
	onPickFile: () => void;
}) {
	const { t } = useTranslation();
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop dropzone has no keyboard equivalent; the two buttons inside cover the keyboard path */}
			<div
				onDragEnter={onDragEnter}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
				className={
					"flex flex-col items-center justify-center gap-3 rounded-(--radius) border-2 border-dashed px-4 py-6 transition-colors " +
					(dragOver ? "border-(--text-2) bg-(--bg-hover)" : "border-(--line) bg-(--bg-elev)")
				}
			>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="secondary"
						size="sm"
						leftIcon={<Clipboard size={11} strokeWidth={1.5} />}
						title={t("qr_paste_hint")}
						// 粘贴入口仅作引导 —— 真正的粘贴由全局 paste 事件接管
						// 点击聚焦到自身让用户可以按 Ctrl+V
						onClick={(e) => {
							(e.currentTarget as HTMLButtonElement).focus();
						}}
					>
						{t("qr_paste_btn")}
					</Button>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						leftIcon={<FileImage size={11} strokeWidth={1.5} />}
						onClick={onPickFile}
					>
						{t("qr_pick_file")}
					</Button>
				</div>
				<div className="text-center text-[11.5px] text-(--text-3)">{t("qr_drag_hint")}</div>
			</div>
			<div className="text-[11px] leading-relaxed text-(--text-4)">{t("qr_supported_hint")}</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// 子组件：解码成功 —— 元信息预览 + 二次确认
// ---------------------------------------------------------------------------

function ResultOk({
	meta,
	revealSecret,
	onToggleReveal,
	onConfirm,
	onCancel,
}: {
	meta: OtpauthMeta;
	revealSecret: boolean;
	onToggleReveal: () => void;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();

	const typeLabel =
		meta.type === "steam"
			? t("totp_badge_steam")
			: meta.type === "hotp"
				? t("totp_badge_hotp")
				: t("totp_badge_totp");

	const algoLine =
		meta.type === "hotp"
			? `${meta.algorithm} · ${meta.digits} ${t("qr_meta_digits_short")} · ${t("totp_label_counter")} ${meta.counter}`
			: `${meta.algorithm} · ${meta.digits} ${t("qr_meta_digits_short")} · ${meta.period}s`;

	const maskedSecret = revealSecret
		? formatBase32Groups(meta.secret)
		: "•".repeat(Math.min(meta.secret.length, 20));

	return (
		<div className="flex flex-col gap-3">
			{/* 状态徽标 */}
			<div className="flex items-center gap-1.5 text-[12px] text-(--ok, var(--text))">
				<ShieldCheck size={12} strokeWidth={1.8} />
				<span>{t("qr_result_ok")}</span>
			</div>

			{/* 元信息表格 —— 紧凑两列 */}
			<dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
				<MetaRow label={t("qr_meta_type")} value={typeLabel} />
				{meta.issuer && <MetaRow label={t("field_totp_issuer")} value={meta.issuer} />}
				{meta.account && <MetaRow label={t("field_totp_account")} value={meta.account} />}
				<MetaRow label={t("qr_meta_params")} value={algoLine} />
				<dt className="text-(--text-3)">{t("qr_meta_secret")}</dt>
				<dd className="flex items-center gap-1.5">
					<span className="truncate font-mono text-(--text)">{maskedSecret}</span>
					<button
						type="button"
						onClick={onToggleReveal}
						className="shrink-0 text-(--text-3) hover:text-(--text) focus:outline-none"
					>
						<span className="text-[11px] underline-offset-2 hover:underline">
							{revealSecret ? t("detail_hide") : t("detail_reveal")}
						</span>
					</button>
				</dd>
			</dl>

			{/* 警告条 */}
			<div className="rounded-sm border border-(--line) bg-(--bg-elev) px-3 py-2 text-[11px] leading-relaxed text-(--text-3)">
				{t("qr_trust_warning")}
			</div>

			{/* 操作区 */}
			<div className="flex items-center justify-end gap-2 pt-1">
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					{t("common_cancel")}
				</Button>
				<Button type="button" variant="default" size="sm" onClick={onConfirm}>
					{t("qr_apply")}
				</Button>
			</div>
		</div>
	);
}

function MetaRow({ label, value }: { label: string; value: string }) {
	return (
		<>
			<dt className="text-(--text-3)">{label}</dt>
			<dd className="truncate text-(--text)">{value}</dd>
		</>
	);
}

// ---------------------------------------------------------------------------
// 子组件：解码失败 / 非 otpauth
// ---------------------------------------------------------------------------

function ResultBad({
	error,
	rawText,
	onRetry,
}: {
	error: OtpauthParseError | "no-qr";
	rawText?: string;
	onRetry: () => void;
}) {
	const { t } = useTranslation();

	const titleKey =
		error === "no-qr"
			? "qr_err_no_qr_title"
			: error === "not-otpauth"
				? "qr_err_not_otpauth_title"
				: error === "missing-secret"
					? "qr_err_missing_secret_title"
					: error === "invalid-type"
						? "qr_err_invalid_type_title"
						: "qr_err_invalid_uri_title";

	const hintKey =
		error === "no-qr"
			? "qr_err_no_qr_hint"
			: error === "not-otpauth"
				? "qr_err_not_otpauth_hint"
				: error === "missing-secret"
					? "qr_err_missing_secret_hint"
					: error === "invalid-type"
						? "qr_err_invalid_type_hint"
						: "qr_err_invalid_uri_hint";

	return (
		<div className="flex flex-col gap-3">
			<div className="text-[12px] font-medium text-(--danger)">{t(titleKey as never)}</div>
			<div className="text-[11.5px] leading-relaxed text-(--text-3)">{t(hintKey as never)}</div>
			{/* 识别到的非 otpauth 内容 —— 让用户判断是不是扫错图 */}
			{rawText && (
				<div className="rounded-sm border border-(--line) bg-(--bg-elev) px-3 py-2">
					<div className="mb-1 text-[10.5px] tracking-wider text-(--text-4) uppercase">
						{t("qr_err_detected_content")}
					</div>
					<div className="break-all font-mono text-[11px] text-(--text-2)">
						{rawText}
						{rawText.length >= 80 && "…"}
					</div>
				</div>
			)}
			<div className="flex items-center justify-end pt-1">
				<Button type="button" variant="secondary" size="sm" onClick={onRetry}>
					{t("qr_retry")}
				</Button>
			</div>
		</div>
	);
}

export default QrScannerPanel;
