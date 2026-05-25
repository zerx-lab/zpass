// TotpField —— 实时 OTP 验证码显示组件（支持 TOTP / HOTP / Steam）
// ---------------------------------------------------------------------------
// 用法：
//
//   <TotpField itemId={item.id} onCopied={(v) => onCopy("totp_code", v)} />
//
// 行为：
//   1. 挂载后立即调 vaultApi.generateTOTP(itemId) 拿初始码
//   2. 根据返回 code.type 分流渲染：
//        - "totp"  ：显示倒计时圆环，自动每秒重渲染，归零时拉新码
//        - "hotp"  ：显示静态码 + "下一个码"按钮（点击调
//                    advanceHOTPCounter，把后端计数器 +1 并重取）
//        - "steam" ：与 totp 形态一致，但 5 位字母数字 + 锁定字母数字字体
//   3. 错误状态：渲染占位（"未配置 OTP" / "密钥非法" / "条目不存在"）
//
// 设计要点：
//   - **后端权威**：每次都向后端 API 取 OTP，从不在前端用上次的 code 自己计算；
//     桌面端时钟漂移 / NTP 跳跃时也能保证显示与服务一致。
//   - **节流**：TOTP/Steam 默认每 1s 重渲染"剩余倒计时"，但只有 setState
//     不发 IPC；周期归零时才发一次 IPC 拉新码。HOTP 完全不轮询，仅在
//     用户主动点按钮时发 IPC。
//   - **可点击复制**：整段验证码都点击复制，右侧也单独有显式复制按钮。
//   - **倒计时进度**：用 SVG circle stroke-dashoffset 实现，颜色随剩余秒变化；
//     <= 5s 进入"紧急"红色提示，其它时间用 --accent。

import { Copy, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { writeClipboardEphemeral } from "@/lib/clipboard";
import { type TOTPCode, vaultApi, vaultErrorKind } from "@/lib/vault-api";
import { useUIStore } from "@/stores/ui";

export type TotpFieldVariant = "row" | "card";

interface TotpFieldProps {
	/** 要生成 OTP 的条目 ID */
	itemId: string;
	/**
	 * 渲染形态：
	 *   - "row" ：详情面板内的一行字段（与 username/password 同样式）
	 *   - "card"：聚合页右侧详情的大片，验证码大字号 + 进度环
	 */
	variant?: TotpFieldVariant;
	/** 可选：父组件接管复制反馈时传入；不传则组件内部默认 toast */
	onCopied?: (code: string) => void;
}

/**
 * 把 6 位数字按 "123 456" 分组展示，便于阅读
 *
 * 不能用 Intl.NumberFormat —— 会把前导 0 丢失（6 位数字独立片段）。
 *
 * Steam 5 位与 7+ 位非常规情况不分组，原样返回。
 */
function formatGroups(code: string): string {
	if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
	if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
	return code;
}

export function TotpField({ itemId, variant = "row", onCopied }: TotpFieldProps) {
	const { t } = useTranslation();
	const pushToast = useUIStore((s) => s.pushToast);

	const [snapshot, setSnapshot] = useState<TOTPCode | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [remaining, setRemaining] = useState<number>(0);
	// HOTP 推进按钮防抖：避免用户连点产生多次 IPC + 计数器跳号
	const [advancing, setAdvancing] = useState<boolean>(false);

	// 用 ref 保存最新的 itemId，避免 setInterval 闭包陈旧
	const itemIdRef = useRef(itemId);
	itemIdRef.current = itemId;

	const mapErrorKey = useCallback((err: unknown): string => {
		const kind = vaultErrorKind(err);
		switch (kind) {
			case "totp-secret-missing":
				return "totp_err_secret_missing";
			case "totp-secret-invalid":
				return "totp_err_secret_invalid";
			case "locked":
				return "totp_err_locked";
			case "not-found":
				return "totp_err_not_found";
			case "otp-type-mismatch":
				return "totp_err_type_mismatch";
			default:
				return "totp_err_unknown";
		}
	}, []);

	const fetchCode = useCallback(async () => {
		try {
			const code = await vaultApi.generateTOTP(itemIdRef.current);
			setSnapshot(code);
			setRemaining(code.remaining);
			setError(null);
		} catch (err) {
			setError(t(mapErrorKey(err)));
			setSnapshot(null);
		}
	}, [t, mapErrorKey]);

	// 用户点击「下一个码」按钮：HOTP 计数器 +1 并取新码
	const advanceHOTP = useCallback(async () => {
		if (advancing) return;
		setAdvancing(true);
		try {
			const code = await vaultApi.advanceHOTPCounter(itemIdRef.current);
			setSnapshot(code);
			setRemaining(0);
			setError(null);
		} catch (err) {
			setError(t(mapErrorKey(err)));
		} finally {
			setAdvancing(false);
		}
	}, [advancing, t, mapErrorKey]);

	// 挂载 + itemId 变化时拉一次
	// biome-ignore lint/correctness/useExhaustiveDependencies: itemId 是触发依据，effect body 用 ref 读取
	useEffect(() => {
		void fetchCode();
	}, [fetchCode, itemId]);

	// 每秒倒计时 —— 仅 TOTP/Steam 类型需要。HOTP 没有时间窗口概念，停掉 interval。
	useEffect(() => {
		if (!snapshot) return;
		if (snapshot.type === "hotp") return;
		const id = window.setInterval(() => {
			setRemaining((prev) => {
				if (prev <= 1) {
					// 周期切换：拉下一周期码（异步）
					void fetchCode();
					return snapshot.period; // 暂时回填周期值，下次刷新覆盖
				}
				return prev - 1;
			});
		}, 1000);
		return () => window.clearInterval(id);
	}, [snapshot, fetchCode]);

	const onCopyClick = useCallback(async () => {
		if (!snapshot) return;
		const ok = await writeClipboardEphemeral(snapshot.code);
		if (ok) {
			onCopied?.(snapshot.code);
			pushToast({ text: t("toast_copied_totp"), icon: "copy" });
		} else {
			pushToast({ text: t("toast_copy_failed"), icon: "x" });
		}
	}, [snapshot, onCopied, pushToast, t]);

	// ---- 错误占位 ----
	if (error) {
		return (
			<div className="flex flex-col gap-1.5">
				<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
					{t("field_totp_code")}
				</span>
				<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5 text-[12.5px] text-(--text-3)">
					<ShieldAlert size={13} strokeWidth={1.5} className="shrink-0 text-(--text-4)" />
					<span className="flex-1">{error}</span>
				</div>
			</div>
		);
	}

	// ---- 加载占位 ----
	if (!snapshot) {
		return (
			<div className="flex flex-col gap-1.5">
				<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
					{t("field_totp_code")}
				</span>
				<div className="rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5 text-[12.5px] text-(--text-3)">
					{t("vault_loading")}
				</div>
			</div>
		);
	}

	const isHOTP = snapshot.type === "hotp";
	const isSteam = snapshot.type === "steam";

	// 用类型徽标区分 OTP 类型，让用户一眼看出"这是哪种验证码"
	const typeBadge = isHOTP
		? t("totp_badge_hotp")
		: isSteam
			? t("totp_badge_steam")
			: t("totp_badge_totp");

	// 进度比例（仅 TOTP/Steam 用），紧急色 <= 5s
	const ratio = isHOTP ? 0 : Math.max(0, Math.min(1, remaining / Math.max(1, snapshot.period)));
	const isUrgent = !isHOTP && remaining <= 5;

	if (variant === "card") {
		// 聚合页右侧大片：大字号 + 类型徽标 + 倒计时/计数器
		return (
			<div className="flex flex-col items-center gap-3 rounded-lg border border-(--line) bg-(--bg-elev-2) px-6 py-5">
				<div className="flex items-center gap-2 text-[10.5px] font-mono uppercase tracking-wider text-(--text-3)">
					<span>{typeBadge}</span>
					{isHOTP && (
						<span className="text-(--text-4)">
							{t("totp_label_counter")}: {snapshot.counter}
						</span>
					)}
				</div>
				<button
					type="button"
					onClick={onCopyClick}
					title={t("detail_copy")}
					className="zpass-selectable cursor-pointer font-mono text-[34px] font-semibold tracking-[0.18em] tabular-nums text-(--text) hover:text-(--accent) transition-colors"
				>
					{formatGroups(snapshot.code)}
				</button>
				<div className="flex items-center gap-3 text-[11.5px] text-(--text-3)">
					{isHOTP ? (
						<Button
							variant="secondary"
							size="sm"
							onClick={advanceHOTP}
							disabled={advancing}
							leftIcon={<RefreshCw size={12} strokeWidth={1.5} />}
						>
							{t("totp_btn_next")}
						</Button>
					) : (
						<TotpProgressRing ratio={ratio} urgent={isUrgent} label={`${remaining}s`} size={28} />
					)}
					<Button
						variant="secondary"
						size="sm"
						onClick={onCopyClick}
						leftIcon={<Copy size={12} strokeWidth={1.5} />}
					>
						{t("detail_copy")}
					</Button>
				</div>
			</div>
		);
	}

	// 行内形态：与其它详情字段对齐
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase flex items-center gap-2">
				<span>{t("field_totp_code")}</span>
				<span className="text-(--text-4) normal-case tracking-normal">· {typeBadge}</span>
				{isHOTP && (
					<span className="text-(--text-4) normal-case tracking-normal">· #{snapshot.counter}</span>
				)}
			</span>
			<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5">
				<ShieldCheck size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
				<button
					type="button"
					onClick={onCopyClick}
					title={t("detail_copy")}
					className="zpass-selectable flex-1 truncate text-left font-mono text-base font-medium tabular-nums tracking-[0.12em] text-(--text) hover:text-(--accent) transition-colors"
				>
					{formatGroups(snapshot.code)}
				</button>
				{isHOTP ? (
					<Button
						variant="ghost"
						size="sm"
						onClick={advanceHOTP}
						disabled={advancing}
						title={t("totp_btn_next")}
						leftIcon={<RefreshCw size={12} strokeWidth={1.5} />}
					>
						{t("totp_btn_next")}
					</Button>
				) : (
					<TotpProgressRing ratio={ratio} urgent={isUrgent} label={`${remaining}`} size={22} />
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={onCopyClick}
					title={t("detail_copy")}
					leftIcon={<Copy size={12} strokeWidth={1.5} />}
				>
					{t("detail_copy")}
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 进度环子组件
// ---------------------------------------------------------------------------

/**
 * 圆形倒计时进度环
 *
 * - ratio：0~1 之间，1 = 整圈（周期开始），0 = 空（周期末尾）
 * - urgent：true 时颜色变红，提示用户即将刷新
 * - label：环中心文字（通常是剩余秒数）
 * - size：外圆直径（px）
 *
 * 用 SVG 而非 div + CSS conic-gradient：跨平台 webview 对 conic-gradient
 * 的渲染一致性较差；SVG stroke-dashoffset 是 1995 年起就稳定的方案。
 */
function TotpProgressRing({
	ratio,
	urgent,
	label,
	size,
}: {
	ratio: number;
	urgent: boolean;
	label: string;
	size: number;
}) {
	const stroke = size >= 28 ? 2.5 : 2;
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const dashOffset = circumference * (1 - ratio);
	const color = urgent ? "var(--danger, #ef4444)" : "var(--accent)";

	return (
		<div
			className="relative inline-flex shrink-0 items-center justify-center"
			style={{ width: size, height: size }}
		>
			<svg width={size} height={size} className="-rotate-90" aria-hidden="true">
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					stroke="var(--line)"
					strokeWidth={stroke}
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeDasharray={circumference}
					strokeDashoffset={dashOffset}
					strokeLinecap="round"
					style={{ transition: "stroke-dashoffset 0.5s linear" }}
				/>
			</svg>
			<span
				className="absolute font-mono tabular-nums leading-none"
				style={{
					fontSize: size >= 28 ? 10 : 8.5,
					color: urgent ? "var(--danger, #ef4444)" : "var(--text-3)",
				}}
			>
				{label}
			</span>
		</div>
	);
}

export default TotpField;
