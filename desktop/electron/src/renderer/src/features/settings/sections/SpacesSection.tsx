import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { ImagePlus, LayoutGrid, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { SpaceAvatar } from "@/components/SpaceAvatar";
import { resizeImageToDataUrl } from "@/lib/image";
import { useSpacesStore } from "@/stores/spaces";
import {
	ConfirmDialog,
	DIALOG_CONTENT_BASE_CLASS,
	DIALOG_OVERLAY_CLASS,
	dialogPortalContainer,
	Section,
} from "../shared";

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
		<RadixDialog.Root
			open={open}
			onOpenChange={(v) => {
				if (!v && !uploading) onClose();
			}}
		>
			<RadixDialog.Portal container={dialogPortalContainer()}>
				<RadixDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
				<RadixDialog.Content
					aria-describedby={undefined}
					className={clsx(DIALOG_CONTENT_BASE_CLASS, "w-110")}
					onEscapeKeyDown={(e) => {
						if (uploading) e.preventDefault();
					}}
				>
					<RadixDialog.Title className="text-[16px] font-semibold text-(--text)">
						{title}
					</RadixDialog.Title>

					{/* 头像编辑区 —— 预览 + 上传/移除按钮 + 提示 */}
					<div className="flex items-center gap-4">
						<SpaceAvatar
							space={{
								avatarDataUrl: previewAvatarUrl ?? undefined,
								glyph: previewGlyph,
								name: trimmedName || initialName,
							}}
							className="h-12 w-12 rounded-lg text-[20px]"
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
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}

/** 新建空间弹窗 —— 输入空间名称 + 可选副标题 */
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

	// 弹窗关闭时重置表单
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
					className={clsx(DIALOG_CONTENT_BASE_CLASS, "w-100")}
				>
					<RadixDialog.Title className="text-[16px] font-semibold text-(--text)">
						{title}
					</RadixDialog.Title>

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
							}}
							placeholder={namePlaceholder}
							autoFocus
							className="w-full rounded-sm border border-(--line) bg-(--bg) px-3 py-2 text-[14px] text-(--text) outline-none transition-colors focus:border-(--text-3)"
						/>
					</div>

					{/* 副标题（tag）输入 */}
					<input
						type="text"
						value={tag}
						onChange={(e) => setTag(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && name.trim()) handleConfirm();
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
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}

export function SpacesSection() {
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

export default SpacesSection;
