import {
	AlertTriangle,
	Globe,
	ImagePlus,
	Info,
	LayoutGrid,
	Monitor,
	Moon,
	Pencil,
	Plus,
	Shield,
	ShieldCheck,
	SlidersHorizontal,
	Sun,
	Trash2,
	Type,
	X,
} from "lucide-react";
import { Button } from "@/components/Button";
import type { ComponentType, SVGProps } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "@/components/Select";
import { FontSelect } from "@/components/FontSelect";
import { SpaceAvatar } from "@/components/SpaceAvatar";
import { resizeImageToDataUrl } from "@/lib/image";
import { SshAgentSection } from "@/features/sshagent/SshAgentSection";
import { vaultApi, vaultErrorKind } from "@/lib/vault-api";
import {
	type Body,
	detectSystemLang,
	type Lang,
	type LockTimeout,
	type Theme,
	type UiScale,
	usePrefsStore,
} from "@/stores/prefs";
import { useSpacesStore } from "@/stores/spaces";

/**
 * 设置�?—�?用户偏好集中入口
 * ---------------------------------------------------------------------------
 * 本次改造（对标上一版）�? *   �?Segmented Control 全部替换为自定义 Select 下拉。理由：
 *   - 桌面端用户对 Select 更熟悉（macOS System Settings、Windows 设置�? *     VS Code Preferences UI 都以 Select 为主�? *   - Segmented 占横向空间大，在 Settings 这种"标签 + 控件"两列布局里，
 *     右侧控件宽度不稳定，视觉对齐�? *   - Select 可扩展性更好：后续加自动锁时长、默认生成器长度等，选项多时不挤
 *
 * 语言行特别处理：
 *   原本�?[跟随系统] + [Segmented EN/中文]"两组并排控件。改造后合并成一�? *   Select，三项选项�? *     1. 跟随系统（Follow system）—�?对应 prefs.lang === detectSystemLang()
 *     2. English
 *     3. 中文（简体）
 *   选中"跟随系统"时调�?resetLangToSystem()；选中具体语言时调�?setLang()�? *   三选一逻辑在一个控件里闭合，避免用户对"并排两组控件"的协同关系产生疑问�? *
 * 页面结构保持不变�? *   ┌──────────────────────────────────────────────�? *   �?Appearance                                   �? *   �?  Theme      [Dark ▾]                        �? *   �?  Scale      [100% ▾]                        �? *   �?  Body font  [Sans ▾]                        �? *   ├──────────────────────────────────────────────�? *   �?Language & region                            �? *   �?  Interface  [Follow system ▾]               �? *   ├──────────────────────────────────────────────�? *   �?About · 版本 / 构建 / 源码                   �? *   └──────────────────────────────────────────────�? *
 * 视觉约束（AGENTS.md + 之前决策）：
 *   - 严格黑白：Select 选中态靠 --bg-hover 背景 + �?标记区分，不�?accent
 *   - 圆角只用 5/7/10/14 —�?Select 内部已对�?token
 *   - 控件宽度通过 Select �?className 统一�?min-w-[160px]，保证右列对�? *
 * 数据源：usePrefsStore（zustand + persist）是偏好唯一真源�? * ThemeSync 订阅 store 变化并把值写�?<html data-*> �?i18next，本页无需手动同步�? */

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/* ─────────────────────────────────────────────────────────────
 * 通用原子组件
 * ───────────────────────────────────────────────────────────── */

/** 设置 section 外壳 —�?标题 + 描述 + 内容 */
function Section({
	icon: Icon,
	title,
	description,
	action,
	children,
}: {
	icon: IconComp;
	title: string;
	description?: string;
	/** 可选的右上角操作区域（如新增按钮） */
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="flex flex-col rounded-xl border border-(--line) bg-(--bg-elev)">
			<header className="flex items-center gap-2.5 border-b border-(--line-soft) px-5 py-4">
				<Icon size={15} strokeWidth={1.5} className="text-(--text-2)" />
				<div className="flex min-w-0 flex-1 flex-col leading-tight">
					<h2 className="text-[14px] font-semibold text-(--text)">{title}</h2>
					{description && (
						<p className="text-[12px] text-(--text-3)">{description}</p>
					)}
				</div>
				{action && <div className="shrink-0">{action}</div>}
			</header>
			<div className="flex flex-col divide-y divide-(--line-soft)">
				{children}
			</div>
		</section>
	);
}

/** 单条设置�?—�?左侧 label + 右侧控件 */
function Row({
	label,
	description,
	control,
}: {
	label: string;
	description?: string;
	control: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-6 px-5 py-4">
			<div className="flex min-w-0 flex-col leading-tight">
				<span className="text-[13px] font-medium text-(--text)">{label}</span>
				{description && (
					<span className="mt-0.5 text-[11.5px] text-(--text-3)">
						{description}
					</span>
				)}
			</div>
			<div className="shrink-0">{control}</div>
		</div>
	);
}

/* ─────────────────────────────────────────────────────────────
 * 通用弹窗 —�?确认 / 重命�? * ───────────────────────────────────────────────────────────── */

/** 通用确认弹窗 —�?用于删除空间 / 禁用自动锁定等需二次确认的操�?*/
function ConfirmDialog({
	open,
	onClose,
	title,
	message,
	confirmLabel,
	cancelLabel,
	onConfirm,
	variant = "danger",
	warning,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	message: string;
	confirmLabel: string;
	cancelLabel: string;
	onConfirm: () => void;
	variant?: "danger" | "warn";
	warning?: string;
}) {
	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-500 flex items-center justify-center bg-black/50 animate-in fade-in-0 duration-150"
			onClick={onClose}
		>
			<div
				className="flex w-100 flex-col gap-4 rounded-lg border border-(--line) bg-(--bg-elev-2) p-6 shadow-lg animate-in slide-in-from-bottom-2 fade-in-0 duration-200"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="text-[16px] font-semibold text-(--text)">{title}</h3>
				<p className="text-[13px] leading-relaxed text-(--text-2)">{message}</p>
				{warning && (
					<div className="flex items-start gap-2.5 rounded-sm border border-(--warn) bg-(--warn)/6 px-3 py-2.5 text-[12px] leading-relaxed text-(--warn)">
						<AlertTriangle
							size={14}
							strokeWidth={1.5}
							className="mt-0.5 shrink-0"
						/>
						<span>{warning}</span>
					</div>
				)}
				<div className="flex justify-end gap-3 pt-1">
					<Button variant="secondary" size="md" onClick={onClose}>
						{cancelLabel}
					</Button>
					<Button
						variant={variant === "danger" ? "danger" : "warn"}
						size="md"
						onClick={() => {
							onConfirm();
							onClose();
						}}
					>
						{confirmLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}

/**
 * 编辑空间弹窗 —— 改名 + 自定义头像图片
 * ---------------------------------------------------------------------------
 * 替代了原 RenameDialog（仅改名）。新增能力：
 *   1. 上传图片做头像 —— 点击预览方块或"上传"按钮触发隐藏 <input type="file">
 *      → 前端 Canvas 缩放压缩到 256px / JPEG 0.85 → base64 写入 patch
 *   2. 移除自定义头像 —— 回落到名字首字母派生的 glyph
 *   3. 名字与头像在同一对话框里编辑 —— 一次"编辑空间"操作覆盖两个属性，
 *      避免用户在主面板上"先点改名 → 关掉再点改头像"的多步操作
 *
 * 提交语义：
 *   - 用户改了名字 / 头像后点"保存"，把 (name, avatarDataUrl | null) 一起
 *     交给 onConfirm
 *   - avatar 用 `null` 显式表达"清除自定义头像"，`undefined` 表示"不动"，
 *     调用方据此决定是否传 avatarDataUrl 字段（参见 store 注释）
 *
 * 视觉约束：
 *   - 头像预览方块 64px，与图片上传 / 移除按钮并列
 *   - 名称输入框沿用原 RenameDialog 样式，最小破坏
 */
function SpaceEditDialog({
	open,
	onClose,
	title,
	initialName,
	initialAvatarDataUrl,
	initialGlyph,
	placeholder,
	confirmLabel,
	cancelLabel,
	uploadLabel,
	removeLabel,
	uploadHint,
	uploadErrorLabel,
	onConfirm,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	initialName: string;
	initialAvatarDataUrl: string | undefined;
	/** 当前 glyph，用于无头像时的预览回退 */
	initialGlyph: string;
	placeholder: string;
	confirmLabel: string;
	cancelLabel: string;
	uploadLabel: string;
	removeLabel: string;
	uploadHint: string;
	uploadErrorLabel: string;
	/**
	 * 提交回调
	 * @param name 新名字（已 trim）
	 * @param avatarDataUrl `string` = 新自定义头像 / `null` = 清除自定义头像 /
	 *                      `undefined` = 不修改头像（用户没动头像区）
	 */
	onConfirm: (name: string, avatarDataUrl: string | null | undefined) => void;
}) {
	const [name, setName] = useState(initialName);
	// avatar 状态机：
	//   undefined → 未改动（保留原值）
	//   string    → 用户上传了新图片
	//   null      → 用户主动移除了原自定义头像
	const [avatarPatch, setAvatarPatch] = useState<string | null | undefined>(
		undefined,
	);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// open 切换时重置内部状态 —— 复用同一个组件实例编辑不同空间时
	// 必须清空上一次的 avatarPatch / 错误，避免污染
	useEffect(() => {
		if (open) {
			setName(initialName);
			setAvatarPatch(undefined);
			setUploadError(null);
			setUploading(false);
		}
	}, [open, initialName]);

	if (!open) return null;

	// 当前用于预览的头像值（patch 优先于 initial）
	const previewAvatarUrl =
		avatarPatch !== undefined ? avatarPatch : initialAvatarDataUrl;
	// 名字首字母实时预览 —— 用于"无图时" SpaceAvatar 的文字回退
	const trimmedName = name.trim();
	const previewGlyph = trimmedName
		? (Array.from(trimmedName)[0] ?? "·").toUpperCase()
		: initialGlyph || "·";

	const handleUploadClick = () => {
		setUploadError(null);
		fileInputRef.current?.click();
	};

	const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		// 立即清空 input.value，让用户可以重选同一个文件触发再次 onChange
		e.target.value = "";
		if (!file) return;
		setUploading(true);
		setUploadError(null);
		try {
			const dataUrl = await resizeImageToDataUrl(file);
			setAvatarPatch(dataUrl);
		} catch (err) {
			console.error("[SpaceEditDialog] upload failed:", err);
			setUploadError(uploadErrorLabel);
		} finally {
			setUploading(false);
		}
	};

	const handleRemoveAvatar = () => {
		setAvatarPatch(null);
		setUploadError(null);
	};

	const handleSubmit = () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		onConfirm(trimmed, avatarPatch);
		onClose();
	};

	return (
		<div
			className="fixed inset-0 z-500 flex items-center justify-center bg-black/50 animate-in fade-in-0 duration-150"
			onClick={onClose}
		>
			<div
				className="flex w-110 flex-col gap-4 rounded-lg border border-(--line) bg-(--bg-elev-2) p-6 shadow-lg animate-in slide-in-from-bottom-2 fade-in-0 duration-200"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="text-[16px] font-semibold text-(--text)">{title}</h3>

				{/* 头像编辑区 —— 预览 + 上传/移除按钮 + 提示 */}
				<div className="flex items-center gap-4">
					<SpaceAvatar
						space={{
							avatarDataUrl: previewAvatarUrl ?? undefined,
							glyph: previewGlyph,
							name: trimmedName || initialName,
						}}
						className="h-16 w-16 rounded-lg text-[24px]"
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<div className="flex flex-wrap gap-2">
							<Button
								variant="secondary"
								size="sm"
								type="button"
								onClick={handleUploadClick}
								disabled={uploading}
								leftIcon={<ImagePlus size={12} strokeWidth={1.75} />}
							>
								{uploading ? `${uploadLabel}…` : uploadLabel}
							</Button>
							{previewAvatarUrl && (
								<Button
									variant="ghost"
									size="sm"
									type="button"
									onClick={handleRemoveAvatar}
									leftIcon={<X size={12} strokeWidth={1.75} />}
								>
									{removeLabel}
								</Button>
							)}
						</div>
						<p className="text-[11px] leading-relaxed text-(--text-4)">
							{uploadHint}
						</p>
						{uploadError && (
							<p className="text-[11px] leading-relaxed text-(--warn)">
								{uploadError}
							</p>
						)}
					</div>
					{/*
					 * 隐藏的文件 input —— 用 ref 触发，accept 限制图片
					 * 选 image/* 而不是逐个枚举（image/png,image/jpeg）：让浏览器
					 * 系统选择器自动过滤所有图片格式，含 webp / avif 等未来格式
					 */}
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						onChange={handleFileChange}
						className="hidden"
					/>
				</div>

				{/* 名称输入 */}
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && name.trim()) handleSubmit();
						if (e.key === "Escape") onClose();
					}}
					placeholder={placeholder}
					maxLength={32}
					autoFocus
					className="w-full rounded-sm border border-(--line) bg-(--bg) px-3 py-2 text-[14px] text-(--text) outline-none transition-colors focus:border-(--text-3)"
				/>

				<div className="flex justify-end gap-3 pt-1">
					<Button
						variant="secondary"
						size="md"
						onClick={onClose}
						disabled={uploading}
					>
						{cancelLabel}
					</Button>
					<Button
						variant="default"
						size="md"
						disabled={uploading || !name.trim()}
						onClick={handleSubmit}
					>
						{confirmLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}

/** 新建空间弹窗 —�?输入空间名称 + 可选副标题 */
function CreateSpaceDialog({
	open,
	onClose,
	title,
	namePlaceholder,
	tagPlaceholder,
	confirmLabel,
	cancelLabel,
	onConfirm,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	namePlaceholder: string;
	tagPlaceholder: string;
	confirmLabel: string;
	cancelLabel: string;
	onConfirm: (name: string, tag: string) => void;
}) {
	const [name, setName] = useState("");
	const [tag, setTag] = useState("");

	// 弹窗关闭时重置表�?
	const handleClose = () => {
		setName("");
		setTag("");
		onClose();
	};

	const handleConfirm = () => {
		const trimmedName = name.trim();
		if (!trimmedName) return;
		onConfirm(trimmedName, tag.trim());
		setName("");
		setTag("");
		onClose();
	};

	// 派生 glyph 预览（与 spaces store 逻辑一致）
	const glyphPreview = (() => {
		const trimmed = name.trim();
		if (!trimmed) return "·";
		const first = Array.from(trimmed)[0] ?? "·";
		return first.toUpperCase();
	})();

	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-500 flex items-center justify-center bg-black/50 animate-in fade-in-0 duration-150"
			onClick={handleClose}
		>
			<div
				className="flex w-100 flex-col gap-4 rounded-lg border border-(--line) bg-(--bg-elev-2) p-6 shadow-lg animate-in slide-in-from-bottom-2 fade-in-0 duration-200"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="text-[16px] font-semibold text-(--text)">{title}</h3>

				{/* glyph 预览 + 名称输入 */}
				<div className="flex items-center gap-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-(--line) bg-(--bg-elev) font-mono text-[16px] font-semibold text-(--text)">
						{glyphPreview}
					</div>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && name.trim()) handleConfirm();
							if (e.key === "Escape") handleClose();
						}}
						placeholder={namePlaceholder}
						autoFocus
						className="w-full rounded-sm border border-(--line) bg-(--bg) px-3 py-2 text-[14px] text-(--text) outline-none transition-colors focus:border-(--text-3)"
					/>
				</div>

				{/* 副标题（tag）输�?*/}
				<input
					type="text"
					value={tag}
					onChange={(e) => setTag(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && name.trim()) handleConfirm();
						if (e.key === "Escape") handleClose();
					}}
					placeholder={tagPlaceholder}
					className="w-full rounded-sm border border-(--line) bg-(--bg) px-3 py-2 text-[14px] text-(--text) outline-none transition-colors focus:border-(--text-3)"
				/>

				<div className="flex justify-end gap-3 pt-1">
					<Button variant="secondary" size="md" onClick={handleClose}>
						{cancelLabel}
					</Button>
					<Button
						variant="default"
						size="md"
						disabled={!name.trim()}
						onClick={handleConfirm}
					>
						{confirmLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}

/* ─────────────────────────────────────────────────────────────
 * 具体 section 实现
 * ───────────────────────────────────────────────────────────── */

function AppearanceSection() {
	const { t } = useTranslation();
	const theme = usePrefsStore((s) => s.theme);
	const setTheme = usePrefsStore((s) => s.setTheme);
	const scale = usePrefsStore((s) => s.scale);
	const setScale = usePrefsStore((s) => s.setScale);
	const body = usePrefsStore((s) => s.body);
	const setBody = usePrefsStore((s) => s.setBody);
	const fontSans = usePrefsStore((s) => s.fontSans);
	const setFontSans = usePrefsStore((s) => s.setFontSans);
	const fontMono = usePrefsStore((s) => s.fontMono);
	const setFontMono = usePrefsStore((s) => s.setFontMono);
	const [systemFonts, setSystemFonts] = useState<string[]>([]);
	const [fontsLoading, setFontsLoading] = useState(true);

	useEffect(() => {
		vaultApi
			.getSystemFonts()
			.then((fonts) => {
				setSystemFonts(fonts);
				setFontsLoading(false);
			})
			.catch(() => {
				setSystemFonts(["Geist", "Geist Mono"]);
				setFontsLoading(false);
			});
	}, []);

	return (
		<Section
			icon={SlidersHorizontal}
			title={t("settings_section_appearance")}
			description={t("settings_section_appearance_desc")}
		>
			<Row
				label={t("settings_theme")}
				description={t("settings_theme_desc")}
				control={
					<Select<Theme>
						ariaLabel={t("settings_theme")}
						value={theme}
						onChange={setTheme}
						className="min-w-40"
						options={[
							{
								value: "dark",
								label: t("settings_theme_dark"),
								icon: Moon,
							},
							{
								value: "light",
								label: t("settings_theme_light"),
								icon: Sun,
							},
						]}
					/>
				}
			/>

			{/*
			 * 缩放（Scale）—�?对应 <html style="zoom: <pct>%">�?			 * 选项档位对标 VS Code / Slack �?Zoom 菜单，覆盖从"高分屏压�?
			 * �?可访问性放�?的实用区间；默认 100% 无覆盖�?			 * label �?标签 + 百分�?双语义：比如"标准 100%" —�?既给�?			 * 具体数值方便用户精确对齐，又用文字概括该档的定位�?			 */}
			<Row
				label={t("settings_scale")}
				description={t("settings_scale_desc")}
				control={
					<Select<UiScale>
						ariaLabel={t("settings_scale")}
						value={scale}
						onChange={setScale}
						className="min-w-40"
						options={[
							{ value: "80", label: t("settings_scale_80") },
							{ value: "90", label: t("settings_scale_90") },
							{ value: "100", label: t("settings_scale_100") },
							{ value: "110", label: t("settings_scale_110") },
							{ value: "125", label: t("settings_scale_125") },
							{ value: "150", label: t("settings_scale_150") },
						]}
					/>
				}
			/>

			<Row
				label={t("settings_body_font")}
				description={t("settings_body_font_desc")}
				control={
					<Select<Body>
						ariaLabel={t("settings_body_font")}
						value={body}
						onChange={setBody}
						className="min-w-40"
						options={[
							{ value: "sans", label: t("settings_body_sans"), icon: Type },
							{ value: "mono", label: t("settings_body_mono"), icon: Type },
						]}
					/>
				}
			/>

			<Row
				label={t("settings_font_sans")}
				description={t("settings_font_sans_desc")}
				control={
					<FontSelect
						value={fontSans}
						onChange={setFontSans}
						fonts={systemFonts}
						defaultLabel={t("settings_font_default")}
						ariaLabel={t("settings_font_sans")}
						loading={fontsLoading}
						noResultsLabel={t("settings_font_no_results")}
					/>
				}
			/>

			<Row
				label={t("settings_font_mono")}
				description={t("settings_font_mono_desc")}
				control={
					<FontSelect
						value={fontMono}
						onChange={setFontMono}
						fonts={systemFonts}
						defaultLabel={t("settings_font_default_mono")}
						ariaLabel={t("settings_font_mono")}
						loading={fontsLoading}
						noResultsLabel={t("settings_font_no_results")}
					/>
				}
			/>
		</Section>
	);
}

/**
 * 语言�?—�?合并"跟随系统"与显式语言为单一 Select
 * ---------------------------------------------------------------------------
 * 内部用一个合�?value 类型 `LangChoice = "system" | Lang`�? *   - UI 态：控件里选什么就显示什�? *   - 持久化态：prefs �?`lang`（当前生效语言�? `langFollowSystem`（是否跟随系统）
 *     两个字段�?跟随系统"是独立的第一类状态，不靠等值推断�? *
 * 读：`langFollowSystem === true` �?显示 "system"，否则显�?`lang` 本身
 * 写：�?"system" �?�?resetLangToSystem()；选具体语言 �?�?setLang()
 *
 * 为什么不沿用旧的 `lang === detectSystemLang()` 推断�? *   - 当用户主动选择的语言恰好等于系统语言时，两者相等，UI 会错误地
 *     �?锁定该语言"显示�?跟随系统"�? *   - 更严重：`resetLangToSystem` �?`setLang(systemLang)` 在存储层无法区分�? *     系统语言日后变更会让"锁定"意图悄悄失效�? *   - 引入独立标志 `langFollowSystem` 后，意图被显式记录，下次启动即使
 *     系统语言变了，用�?锁定中文"的选择也会保持�? */
type LangChoice = "system" | Lang;

function LanguageSection() {
	const { t } = useTranslation();
	const lang = usePrefsStore((s) => s.lang);
	const langFollowSystem = usePrefsStore((s) => s.langFollowSystem);
	const setLang = usePrefsStore((s) => s.setLang);
	const resetLangToSystem = usePrefsStore((s) => s.resetLangToSystem);

	// 系统语言 —�?useMemo 避免每次渲染重算（detectSystemLang 会读 navigator�?
	const systemLang = useMemo(() => detectSystemLang(), []);
	const current: LangChoice = langFollowSystem ? "system" : lang;

	const handleChange = (next: LangChoice) => {
		if (next === "system") {
			resetLangToSystem();
		} else {
			setLang(next);
		}
	};

	// hint：在 "Follow system" 选项右侧显示当前系统语言�?BCP-47 标签�?	// 让用户清�?跟随系统"当前会落到哪种语言
	const systemHint = systemLang === "zh" ? "zh-CN" : "en";

	return (
		<Section
			icon={Globe}
			title={t("settings_section_language")}
			description={t("settings_section_language_desc")}
		>
			<Row
				label={t("settings_language")}
				description={t("settings_language_desc")}
				control={
					<Select<LangChoice>
						ariaLabel={t("settings_language")}
						value={current}
						onChange={handleChange}
						className="min-w-50"
						options={[
							{
								value: "system",
								label: t("settings_language_system"),
								icon: Monitor,
								hint: systemHint,
							},
							{
								value: "en",
								label: t("settings_language_en"),
							},
							{
								value: "zh",
								label: t("settings_language_zh"),
							},
						]}
					/>
				}
			/>
		</Section>
	);
}

/* ─────────────────────────────────────────────────────────────
 * 空间管理 section
 * ───────────────────────────────────────────────────────────── */

function SpacesSection() {
	const { t } = useTranslation();
	const spaces = useSpacesStore((s) => s.spaces);
	const activeSpaceId = useSpacesStore((s) => s.activeSpaceId);
	const updateSpace = useSpacesStore((s) => s.updateSpace);
	const removeSpace = useSpacesStore((s) => s.removeSpace);
	const createSpace = useSpacesStore((s) => s.createSpace);

	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const [renameTarget, setRenameTarget] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);

	const renameSpace = spaces.find((s) => s.id === renameTarget);

	return (
		<>
			<Section
				icon={LayoutGrid}
				title={t("settings_section_spaces")}
				description={t("settings_section_spaces_desc")}
				action={
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setCreateOpen(true)}
						leftIcon={<Plus size={12} strokeWidth={2} />}
						className="text-[12px] whitespace-nowrap"
					>
						{t("settings_space_create")}
					</Button>
				}
			>
				{spaces.map((sp) => {
					const isActive = sp.id === activeSpaceId;
					const itemCount: number = 0; // TODO: 后续接入 vault store 读取真实数量
					return (
						<div
							key={sp.id}
							className="group flex items-center gap-3 px-5 py-3.5"
						>
							{/* 头像方块（图片或字形）*/}
							<SpaceAvatar
								space={sp}
								className="h-8 w-8 rounded-sm text-[13px]"
							/>
							{/* 名称 + meta */}
							<div className="flex min-w-0 flex-1 flex-col leading-tight">
								<span className="truncate text-[14px] font-medium text-(--text)">
									{sp.name}
								</span>
								<span className="font-mono text-[11.5px] text-(--text-3)">
									{itemCount === 1
										? t("settings_space_items_one")
										: t("settings_space_items_other", { count: itemCount })}
								</span>
							</div>
							{/* 当前空间标记 */}
							{isActive && (
								<span className="rounded border border-(--ok) px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-(--ok)">
									{t("settings_space_current")}
								</span>
							)}
							{/* 操作按钮 */}
							<div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
								<Button
									variant="ghost"
									size="icon"
									title={t("settings_space_rename")}
									onClick={() => setRenameTarget(sp.id)}
								>
									<Pencil size={13} strokeWidth={1.5} />
								</Button>
								{!isActive && spaces.length > 1 && (
									<Button
										variant="ghost"
										size="icon"
										title={t("settings_space_delete")}
										onClick={() => setDeleteTarget(sp.id)}
									>
										<Trash2 size={13} strokeWidth={1.5} />
									</Button>
								)}
							</div>
						</div>
					);
				})}
			</Section>

			{/* 删除确认弹窗 */}
			<ConfirmDialog
				open={!!deleteTarget}
				onClose={() => setDeleteTarget(null)}
				title={t("settings_space_delete_title")}
				message={t("settings_space_delete_msg")}
				confirmLabel={t("settings_space_delete_confirm")}
				cancelLabel={t("settings_space_cancel")}
				onConfirm={() => {
					if (deleteTarget) removeSpace(deleteTarget);
				}}
			/>

			{/* 编辑空间弹窗（改名 + 头像）*/}
			<SpaceEditDialog
				open={!!renameTarget}
				onClose={() => setRenameTarget(null)}
				title={t("settings_space_rename_title")}
				initialName={renameSpace?.name ?? ""}
				initialAvatarDataUrl={renameSpace?.avatarDataUrl}
				initialGlyph={renameSpace?.glyph ?? ""}
				placeholder={t("settings_space_rename_placeholder")}
				confirmLabel={t("settings_space_rename_confirm")}
				cancelLabel={t("settings_space_cancel")}
				uploadLabel={t("settings_space_avatar_upload")}
				removeLabel={t("settings_space_avatar_remove")}
				uploadHint={t("settings_space_avatar_hint")}
				uploadErrorLabel={t("settings_space_avatar_error")}
				onConfirm={(name, avatarPatch) => {
					if (!renameTarget) return;
					// avatarPatch 三态：
					//   undefined → 用户没动头像区，不传 avatarDataUrl
					//   string    → 新自定义头像
					//   null      → 显式清除自定义头像
					const patch: {
						name: string;
						avatarDataUrl?: string | undefined;
					} = { name };
					if (avatarPatch === null) {
						patch.avatarDataUrl = undefined;
					} else if (typeof avatarPatch === "string") {
						patch.avatarDataUrl = avatarPatch;
					}
					updateSpace(renameTarget, patch);
				}}
			/>

			{/* 新建空间弹窗 */}
			<CreateSpaceDialog
				open={createOpen}
				onClose={() => setCreateOpen(false)}
				title={t("settings_space_create_title")}
				namePlaceholder={t("settings_space_create_name_placeholder")}
				tagPlaceholder={t("settings_space_create_tag_placeholder")}
				confirmLabel={t("settings_space_create_confirm")}
				cancelLabel={t("settings_space_cancel")}
				onConfirm={(name, tag) => {
					createSpace({ name, tag: tag || undefined });
				}}
			/>
		</>
	);
}

/* ─────────────────────────────────────────────────────────────
 * 安全（自动锁定）section
 * ───────────────────────────────────────────────────────────── */

const LOCK_OPTIONS: { value: LockTimeout; labelKey: string }[] = [
	{ value: "1m", labelKey: "settings_lock_1m" },
	{ value: "5m", labelKey: "settings_lock_5m" },
	{ value: "15m", labelKey: "settings_lock_15m" },
	{ value: "30m", labelKey: "settings_lock_30m" },
	{ value: "1h", labelKey: "settings_lock_1h" },
	{ value: "4h", labelKey: "settings_lock_4h" },
	{ value: "never", labelKey: "settings_lock_never" },
];

function SecuritySection() {
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
				{/* 超时时间 —�?radio group */}
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

				{/* 触发条件 —�?switch toggles */}
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

/* ─────────────────────────────────────────────────────────────
 * 信任设备（重启免主密码）section
 * ─────────────────────────────────────────────────────────────
 *
 * 让用户在指定设备上重�?ZPass 后无需输入主密码即可解锁保险库�? * 实现详见�? *   - desktop/trusteddevice.go            跨平台抽�? *   - desktop/trusteddevice_windows.go    DPAPI 实现
 *   - desktop/frontend/src/lib/vault-api  四个 IPC 方法
 *   - desktop/frontend/src/app/LockSync   启动时自动解锁触�? *
 * 安全模型：DPAPI/Keychain 包装�?DEK，离开当前 OS 用户会话即不可解�? * 拷走 vault.db 到另一台机器无法解�?—�?严格优于 Bitwarden「永不超时�? * 的明文落盘做法。详�?mem://bitwarden-zpass-dpapi 调研记录�? *
 * 交互流程�? *   1. 进入 Settings 时探测平台支�?+ 当前是否已启�? *   2. 用户切换开关：
 *      - �?�?开：弹启用对话框（含安全说�?+ 主密码二次确认）
 *      - 开 �?关：弹简短确认对话框（不需要主密码�? *   3. 平台不支持时整个 section 置灰 + 显示「此平台暂不支持�? */

function TrustedDeviceSection() {
	const { t } = useTranslation();

	// 异步状态：平台支持 + 当前启用 —�?启动时探测一�?	// `null` 表示「正在探测」，区分于明确的 false（避免开关闪烁）
	const [supported, setSupported] = useState<boolean | null>(null);
	const [enabled, setEnabled] = useState<boolean | null>(null);

	// 弹窗状�?
	const [showEnable, setShowEnable] = useState(false);
	const [showDisable, setShowDisable] = useState(false);

	// 启动时探测一次。两个查询都不需�?DEK，可以在锁定状态下安全调用 —�?	// 但实际上 SettingsPage 只在解锁后渲染，所以无关紧要�?
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

	// 启用成功�?callback（由对话框在密码验证通过后调用）
	const handleEnableSuccess = useCallback(() => {
		setEnabled(true);
		setShowEnable(false);
	}, []);

	// 关闭确认 —�?不需要主密码，直接调后端清行
	const handleDisableConfirm = useCallback(async () => {
		try {
			await vaultApi.disableTrustedDevice();
			setEnabled(false);
		} catch (err) {
			// 关闭失败极罕见（�?DB I/O 异常），不阻�?UI
			console.error("[TrustedDeviceSection] disable failed:", err);
		} finally {
			setShowDisable(false);
		}
	}, []);

	// 开�?toggle —�?根据当前状态分流到启用 / 关闭对话�?
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
								"absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform " +
								(enabled ? "translate-x-4" : "translate-x-0.5")
							}
						/>
					</div>
				</div>
			</Section>

			{/* 启用对话框：含安全说�?+ 主密码二次确�?*/}
			<EnableTrustedDeviceDialog
				open={showEnable}
				onClose={() => setShowEnable(false)}
				onSuccess={handleEnableSuccess}
			/>

			{/* 关闭确认 —�?复用通用 ConfirmDialog */}
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
 * 走完�?KDF + AEAD 验证（与 Unlock 等价强度），通过后才�?DEK 包装�? * DPAPI/Keychain blob 落盘�? *
 * 不复�?ConfirmDialog 的原因：
 *   - 需要密码输入框 + 错误提示状态机
 *   - 需要更长的安全说明（适用 / 不适用场景列表�? *   - 提交需�?await + loading + 错误分支处理
 *
 * 关闭对话框时清空 password / errorMsg —�?避免下次打开时残留上次输入�? */
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

	// 关闭时清状�?—�?useEffect 依赖 open 变化做重置，比在 onClose
	// 里手动清更不容易遗漏（任何关闭路径都触发）�?
	useEffect(() => {
		if (!open) {
			setPassword("");
			setErrorMsg(null);
			setLoading(false);
		}
	}, [open]);

	const handleClose = useCallback(() => {
		if (loading) return; // 提交中禁止关闭，避免悬空状�?		onClose();
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
				// 后端在不支持平台直接�?ErrTrustedDeviceUnsupported
				// 正常路径不会触达（UI 已经把开关置灰），这里兜底防�?
				setErrorMsg(t("settings_trusted_device_err_unsupported"));
			} else {
				setErrorMsg(t("settings_trusted_device_err_unknown"));
			}
		} finally {
			setLoading(false);
		}
	}, [password, loading, t, onSuccess]);

	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-500 flex items-center justify-center bg-black/50 animate-in fade-in-0 duration-150"
			onClick={handleClose}
		>
			<div
				className="flex w-110 flex-col gap-4 rounded-lg border border-(--line) bg-(--bg-elev-2) p-6 shadow-lg animate-in slide-in-from-bottom-2 fade-in-0 duration-200"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="text-[16px] font-semibold text-(--text)">
					{t("settings_trusted_device_enable_title")}
				</h3>
				<p className="text-[13px] leading-relaxed text-(--text-2)">
					{t("settings_trusted_device_enable_msg")}
				</p>

				{/* 适用 / 不适用场景说明 —�?帮助用户判断是否真应该启�?*/}
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

				{/* 主密码确认输�?*/}
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
			</div>
		</div>
	);
}

/** 触发条件�?—�?文本 + switch */
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

function AboutSection() {
	const { t } = useTranslation();

	// 版本号与构建标识目前是硬编码，后续可通过 Tauri �?@tauri-apps/api/app
	// �?getVersion() / getName() 读取真实 metadata；当�?UI 先走常量，避�?	// 每次�?Settings 页都发起一�?IPC�?
	const version = "0.1.0";
	const build = "dev";

	// 说明�?	//   "源代�?行已移除 —�?ZPass 并非开源项目，不向用户暴露仓库地址，避�?	//   给出错误的开源软件心智预期。settings_about_source i18n 键保留（其它
	//   场景可能还会用到，且删除会破�?Strings 类型约束）�?
	return (
		<Section icon={Info} title={t("settings_section_about")}>
			<Row
				label={t("settings_about_version")}
				control={
					<span className="font-mono text-[12px] text-(--text-2)">
						{version}
					</span>
				}
			/>
			<Row
				label={t("settings_about_build")}
				control={
					<span className="font-mono text-[12px] text-(--text-2)">{build}</span>
				}
			/>
		</Section>
	);
}

/* ─────────────────────────────────────────────────────────────
 * 设置页侧边导�? * ───────────────────────────────────────────────────────────── */

type NavItem = {
	id: string;
	labelKey: string;
	icon: IconComp;
	group: string;
};

const NAV_GROUPS: { key: string; labelKey: string }[] = [
	{ key: "general", labelKey: "settings_nav_group_general" },
	{ key: "security", labelKey: "settings_nav_group_security" },
	{ key: "about", labelKey: "settings_nav_group_about" },
];

const NAV_ITEMS: NavItem[] = [
	{
		id: "appearance",
		labelKey: "settings_section_appearance",
		icon: SlidersHorizontal,
		group: "general",
	},
	{
		id: "language",
		labelKey: "settings_section_language",
		icon: Globe,
		group: "general",
	},
	{
		id: "spaces",
		labelKey: "settings_section_spaces",
		icon: LayoutGrid,
		group: "general",
	},
	{
		id: "security",
		labelKey: "settings_section_security",
		icon: Shield,
		group: "security",
	},
	{
		id: "trusted-device",
		labelKey: "settings_section_trusted_device",
		icon: ShieldCheck,
		group: "security",
	},
	{
		id: "ssh-agent",
		labelKey: "settings_section_ssh_agent",
		icon: ShieldCheck,
		group: "security",
	},
	{
		id: "about",
		labelKey: "settings_section_about",
		icon: Info,
		group: "about",
	},
];

function SettingsNav({
	activeId,
	onSelect,
}: {
	activeId: string;
	onSelect: (id: string) => void;
}) {
	const { t } = useTranslation();

	return (
		<nav className="flex w-44 shrink-0 flex-col gap-4 py-1">
			{NAV_GROUPS.map((group) => {
				const items = NAV_ITEMS.filter((i) => i.group === group.key);
				return (
					<div key={group.key} className="flex flex-col gap-0.5">
						<div className="mb-1 px-2.5 font-mono text-[10px] uppercase tracking-widest text-(--text-4)">
							{t(group.labelKey)}
						</div>
						{items.map((item) => {
							const isActive = activeId === item.id;
							return (
								<button
									key={item.id}
									type="button"
									onClick={() => onSelect(item.id)}
									className={
										"flex w-full items-center gap-2.5 rounded-(--radius) px-2.5 py-2 text-left text-[13px] transition-colors " +
										(isActive
											? "bg-(--bg-elev) font-medium text-(--text) shadow-sm border border-(--line)"
											: "text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text-2)")
									}
								>
									<item.icon
										size={14}
										strokeWidth={1.5}
										className={isActive ? "text-(--text-2)" : "text-(--text-4)"}
									/>
									<span className="truncate">{t(item.labelKey)}</span>
								</button>
							);
						})}
					</div>
				);
			})}
		</nav>
	);
}

/* ─────────────────────────────────────────────────────────────
 * 页面�? * ───────────────────────────────────────────────────────────── */

export function SettingsPage() {
	const { t } = useTranslation();
	const scrollRef = useRef<HTMLDivElement>(null);
	const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
	const [activeId, setActiveId] = useState("appearance");
	// 标记正在通过点击跳转，避�?observer 误触发覆盖激活�?
	const clickingRef = useRef(false);
	const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// IntersectionObserver —�?仅在用户手动滚动时跟踪激�?section
	useEffect(() => {
		const container = scrollRef.current;
		if (!container) return;

		const observer = new IntersectionObserver(
			(entries) => {
				// 点击跳转期间不响�?
				if (clickingRef.current) return;
				// 找离顶部最近的可见 section
				const visible = entries
					.filter((e) => e.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				if (visible.length > 0) {
					const id = visible[0].target.getAttribute("data-section-id");
					if (id) setActiveId(id);
				}
			},
			{
				root: container,
				rootMargin: "-10% 0px -70% 0px",
				threshold: 0,
			},
		);

		// 观察所有已注册�?section 元素
		Object.values(sectionRefs.current).forEach((el) => {
			if (el) observer.observe(el);
		});

		return () => observer.disconnect();
	}, []);

	// 点击导航项：立即设置激活�?+ 平滑滚动，跳转完成前屏蔽 observer 更新
	const handleNavSelect = (id: string) => {
		setActiveId(id);
		clickingRef.current = true;
		if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
		const el = sectionRefs.current[id];
		if (el && scrollRef.current) {
			el.scrollIntoView({ behavior: "smooth", block: "start" });
		}
		// smooth scroll 通常�?600ms 内完成，�?800ms 余量后解�?observer
		clickTimerRef.current = setTimeout(() => {
			clickingRef.current = false;
		}, 800);
	};

	// 用于给每�?section 包裹 data-section-id 锚点容器
	const sectionRef = (id: string) => (el: HTMLDivElement | null) => {
		sectionRefs.current[id] = el;
	};

	return (
		<div className="flex h-full w-full overflow-hidden bg-(--bg)">
			{/* ── 左侧固定导航 ── */}
			<aside className="flex h-full w-56 shrink-0 flex-col border-r border-(--line-soft) bg-(--bg-elev) px-3 py-6">
				{/* 标题�?*/}
				<div className="mb-5 flex flex-col gap-0.5 px-2.5">
					<h1 className="text-[15px] font-semibold text-(--text)">
						{t("settings_title")}
					</h1>
					<p className="text-[11.5px] text-(--text-4)">
						{t("settings_subtitle")}
					</p>
				</div>
				<SettingsNav activeId={activeId} onSelect={handleNavSelect} />
			</aside>

			{/* ── 右侧可滚动内容区 ── */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto bg-(--bg-elev-2)">
				<div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-8">
					<div ref={sectionRef("appearance")} data-section-id="appearance">
						<AppearanceSection />
					</div>
					<div ref={sectionRef("language")} data-section-id="language">
						<LanguageSection />
					</div>
					<div ref={sectionRef("spaces")} data-section-id="spaces">
						<SpacesSection />
					</div>
					<div ref={sectionRef("security")} data-section-id="security">
						<SecuritySection />
					</div>
					<div
						ref={sectionRef("trusted-device")}
						data-section-id="trusted-device"
					>
						<TrustedDeviceSection />
					</div>
					<div ref={sectionRef("ssh-agent")} data-section-id="ssh-agent">
						<SshAgentSection />
					</div>
					<div
						ref={sectionRef("about")}
						data-section-id="about"
						className="pb-8"
					>
						<AboutSection />
					</div>
				</div>
			</div>
		</div>
	);
}

export default SettingsPage;
