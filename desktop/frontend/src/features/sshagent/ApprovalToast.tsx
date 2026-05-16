// SSH agent 签名确认 modal —— 全局事件监听器
// ---------------------------------------------------------------------------
// 挂到 <App /> 顶层，无 UI 占位（fixed overlay）。订阅
// "ssh-agent:approval-request" / "ssh-agent:approval-cancelled" 事件，
// 在窗口中央弹出 modal 让用户决定批准 / 拒绝。
//
// ---------------------------------------------------------------------------
// 安全 UX 关键设计
//
// 1. **默认拒绝**：30 秒无操作自动拒绝（后端兜底，前端也有倒计时显示）
// 2. **不绑回车批准**：避免用户在其它窗口按 Enter 误触
// 3. **信任时长选项**：1 / 5 / 30 分钟 / 1 / 8 小时 / 仅本次
// 4. **多 approval 并发**：用栈展示，最新的在顶
// 5. **超时后 banner 提示**：让用户知道签名被默认拒绝了，可以重试 ssh

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AlertTriangle,
	Check,
	Clock,
	Fingerprint,
	X as XIcon,
} from "lucide-react";
import { Button } from "@/components/Button";
import {
	approveSignRequest,
	declineSignRequest,
	listPendingApprovals,
	onApprovalCancelled,
	onApprovalRequest,
	type ApprovalRequest,
} from "@/lib/sshagent-api";

const APPROVAL_TIMEOUT_MS = 30_000;

/**
 * ApprovalToast - 全局确认 modal
 *
 * 在 <App /> 顶层只需挂一次：
 *
 *     <ApprovalToast />
 *
 * 它会监听 Wails 事件并自渲染 modal。无 props 即用。
 */
export function ApprovalToast() {
	const [requests, setRequests] = useState<ApprovalRequest[]>([]);

	// 启动时拉一次「漏掉的 approval」—— 防止事件订阅前 GUI 已经有 in-flight
	useEffect(() => {
		listPendingApprovals()
			.then((list) => {
				if (list && list.length > 0) setRequests(list);
			})
			.catch(() => {
				/* 非 Wails 环境或服务未启用，忽略 */
			});
	}, []);

	// 订阅新 approval
	useEffect(() => {
		const unsub = onApprovalRequest((req) => {
			setRequests((prev) => {
				// 防止重复（refresh 拉到 + event 推到同时发生）
				if (prev.some((r) => r.id === req.id)) return prev;
				return [req, ...prev];
			});
		});
		return unsub;
	}, []);

	// 订阅 cancellation（超时 / 后端主动取消）
	useEffect(() => {
		const unsub = onApprovalCancelled((payload) => {
			setRequests((prev) => prev.filter((r) => r.id !== payload.id));
		});
		return unsub;
	}, []);

	const onResolve = useCallback((id: string) => {
		setRequests((prev) => prev.filter((r) => r.id !== id));
	}, []);

	if (requests.length === 0) return null;

	return (
		<div className="pointer-events-none fixed inset-0 z-[9999] flex items-end justify-center p-6">
			<div className="pointer-events-auto flex w-full max-w-md flex-col gap-2">
				{requests.map((req) => (
					<ApprovalCard
						key={req.id}
						request={req}
						onResolve={() => onResolve(req.id)}
					/>
				))}
			</div>
		</div>
	);
}

/**
 * 单个 approval 卡片 —— 展示请求细节 + 批准/拒绝按钮 + 倒计时
 */
function ApprovalCard({
	request,
	onResolve,
}: {
	request: ApprovalRequest;
	onResolve: () => void;
}) {
	const { t } = useTranslation();
	const [trustSeconds, setTrustSeconds] = useState(0);
	const [busy, setBusy] = useState(false);
	const [remaining, setRemaining] = useState(APPROVAL_TIMEOUT_MS);

	// 倒计时
	useEffect(() => {
		const start = request.createdAtMs || Date.now();
		const tick = () => {
			const elapsed = Date.now() - start;
			const left = Math.max(0, APPROVAL_TIMEOUT_MS - elapsed);
			setRemaining(left);
			if (left <= 0) onResolve(); // UI 端兜底（后端也会发 cancelled）
		};
		tick();
		const id = setInterval(tick, 500);
		return () => clearInterval(id);
	}, [request.createdAtMs, onResolve]);

	const onApprove = useCallback(async () => {
		setBusy(true);
		try {
			await approveSignRequest(request.id, trustSeconds);
			onResolve();
		} finally {
			setBusy(false);
		}
	}, [request.id, trustSeconds, onResolve]);

	const onDecline = useCallback(async () => {
		setBusy(true);
		try {
			await declineSignRequest(request.id);
			onResolve();
		} finally {
			setBusy(false);
		}
	}, [request.id, onResolve]);

	const remainingSec = Math.ceil(remaining / 1000);

	const trustOptions = useMemo(
		() => [
			{ label: t("approval_trust_once"), value: 0 },
			{ label: t("approval_trust_1min"), value: 60 },
			{ label: t("approval_trust_5min"), value: 5 * 60 },
			{ label: t("approval_trust_30min"), value: 30 * 60 },
			{ label: t("approval_trust_1h"), value: 60 * 60 },
			{ label: t("approval_trust_8h"), value: 8 * 60 * 60 },
		],
		[t],
	);

	return (
		<div className="overflow-hidden rounded-xl border border-(--line) bg-(--bg-elev) shadow-2xl">
			<div className="flex items-center gap-2 border-b border-(--line-soft) px-4 py-2.5">
				<AlertTriangle
					size={14}
					strokeWidth={1.5}
					className="text-(--text-2)"
				/>
				<span className="text-[13px] font-semibold text-(--text)">
					{t("approval_title")}
				</span>
				<span className="ml-auto flex items-center gap-1 font-mono text-[11px] text-(--text-4)">
					<Clock size={11} strokeWidth={1.5} />
					{remainingSec}s
				</span>
			</div>

			<div className="flex flex-col gap-3 px-4 py-3">
				{/* Key 信息 */}
				<div className="flex items-center gap-2.5 rounded-lg border border-(--line-soft) bg-(--bg) px-3 py-2">
					<Fingerprint
						size={14}
						strokeWidth={1.5}
						className="text-(--text-2)"
					/>
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="truncate text-[13px] font-medium text-(--text)">
							{request.itemName || t("approval_unknown_key")}
						</span>
						<span className="truncate font-mono text-[11px] text-(--text-4)">
							{request.fingerprint}
						</span>
					</div>
				</div>

				{/* Client 信息 */}
				<div className="flex flex-col gap-1 text-[12px]">
					<div className="flex items-baseline gap-2">
						<span className="shrink-0 text-(--text-4)">
							{t("approval_client_label")}
						</span>
						<span className="truncate font-mono text-(--text-2)">
							{request.clientExeShort ||
								request.clientExe ||
								t("approval_unknown_client")}
						</span>
					</div>
					{request.clientPid > 0 && (
						<div className="flex items-baseline gap-2">
							<span className="shrink-0 text-(--text-4)">
								{t("approval_pid_label")}
							</span>
							<span className="font-mono text-(--text-3)">
								{request.clientPid}
							</span>
						</div>
					)}
					{request.clientExeHashShort && (
						<div className="flex items-baseline gap-2">
							<span className="shrink-0 text-(--text-4)">
								{t("approval_exe_hash_label")}
							</span>
							<span className="font-mono text-(--text-3)">
								{request.clientExeHashShort}…
							</span>
						</div>
					)}
				</div>

				{/* 信任选项 */}
				<div className="flex flex-col gap-1.5">
					<label
						htmlFor={`trust-${request.id}`}
						className="text-[11.5px] text-(--text-3)"
					>
						{t("approval_trust_label")}
					</label>
					<select
						id={`trust-${request.id}`}
						value={trustSeconds}
						onChange={(e) => setTrustSeconds(Number(e.target.value))}
						className="rounded-md border border-(--line) bg-(--bg) px-2.5 py-1.5 text-[12px] text-(--text) focus:outline-none focus:ring-1 focus:ring-(--text-2)"
					>
						{trustOptions.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</div>

				{/* 按钮 */}
				<div className="flex items-center justify-end gap-2 pt-1">
					<Button onClick={onDecline} disabled={busy}>
						<XIcon size={13} strokeWidth={1.5} />
						{t("approval_decline")}
					</Button>
					<Button onClick={onApprove} disabled={busy}>
						<Check size={13} strokeWidth={1.5} />
						{t("approval_approve")}
					</Button>
				</div>
			</div>
		</div>
	);
}

export default ApprovalToast;
