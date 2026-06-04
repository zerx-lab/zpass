import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { AlertTriangle } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { Button } from "@/components/Button";

/**
 * 设置页共享原子层
 * ---------------------------------------------------------------------------
 * 把跨多个 section 复用的基础件抽到此处，让每个 section 文件只关心自身内容：
 *   - 视觉外壳：Section（标题卡片）、Row（标签 + 控件行）
 *   - 弹层基建：dialogPortalContainer + 两个统一 className 常量
 *   - 通用确认弹窗：ConfirmDialog（被 Spaces / Security / TrustedDevice 共用）
 *
 * 依赖方向严格单向：sections/* → shared，shared 不反向 import 任何 section。
 */

export type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/**
 * 共享：取 Radix Dialog 的 Portal 容器
 * ---------------------------------------------------------------------------
 * 与 ExportDialog / ImportDialog / CmdK / VaultPage 等已 Radix 化的弹层一致，
 * 统一挂到 #portal-root（位于 #root 之外），避免 #root 的 zoom stacking
 * context 把 Overlay 锁死、被 Titlebar 盖住等老 bug。
 */
export const dialogPortalContainer = () =>
	typeof document !== "undefined"
		? document.getElementById("portal-root")
		: null;

/** Radix Dialog 通用 Overlay / Content className（统一 backdrop + glass） */
export const DIALOG_OVERLAY_CLASS = clsx(
	"fixed inset-0 z-50 zpass-backdrop",
	"data-[state=open]:animate-[zpass-overlay-in_140ms_ease-out]",
);
export const DIALOG_CONTENT_BASE_CLASS = clsx(
	"fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
	// 阴影/边框/玻璃底全由 .zpass-glass 提供（多层 token 阴影）；不要再叠 shadow-lg ——
	// .zpass-glass 在 unlayered 区会覆盖 Tailwind shadow-lg，那只是死样式。
	"flex flex-col gap-4 rounded-xl p-6",
	"zpass-glass focus:outline-none",
	"data-[state=open]:animate-[zpass-dialog-in_180ms_ease-out]",
);

/** 设置 section 外壳 —— 标题 + 描述 + 内容 */
export function Section({
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

/** 单条设置行 —— 左侧 label + 右侧控件 */
export function Row({
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

/** 通用确认弹窗 —— 用于删除空间 / 禁用自动锁定等需二次确认的操作 */
export function ConfirmDialog({
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
	return (
		<RadixDialog.Root
			open={open}
			onOpenChange={(v) => {
				if (!v) onClose();
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
					<p className="text-[13px] leading-relaxed text-(--text-2)">
						{message}
					</p>
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
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}
