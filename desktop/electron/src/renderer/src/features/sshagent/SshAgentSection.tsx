// SSH agent 设置 section —— 集成到 SettingsPage
// ---------------------------------------------------------------------------
// 暴露给用户的开关与信息：
//
//   1. 启用 / 停用 SSH agent 服务
//   2. SSH_AUTH_SOCK 路径 + 一键复制
//   3. agent 子进程状态（运行中 / 未连接 / 不可用）
//   4. 当前推送给 agent 的公钥数
//   5. 清空信任 cache 按钮
//   6. 「设置 SSH_AUTH_SOCK」shell 片段（按平台生成 export / setx）
//   7. 调试信息折叠面板：control socket 路径 / agent binary 路径
//
// 设计原则与项目其它 Section 一致（黑白、圆角 5/7/10/14、描边）。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AlertCircle,
	CheckCircle2,
	Copy,
	Eraser,
	HelpCircle,
	Power,
	RefreshCw,
	Terminal,
	Trash2,
} from "lucide-react";
import { Button } from "@/components/Button";
import { writeClipboard } from "@/lib/clipboard";
import {
	clearAuditLog,
	clearTrustCache,
	disable,
	enable,
	getAuditLog,
	getStatus,
	type AuditEntry,
	type SshAgentStatus,
} from "@/lib/sshagent-api";

/**
 * SshAgentSection - 设置页中的 SSH agent 模块入口
 *
 * 由 SettingsPage 引用并放在 security 组下。轮询 status（5s 一次）
 * 让「agent 连接状态」实时更新。
 */
export function SshAgentSection() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<SshAgentStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
	const [showAudit, setShowAudit] = useState(false);
	const [showDebug, setShowDebug] = useState(false);

	// 拉状态
	const refresh = useCallback(async () => {
		try {
			const s = await getStatus();
			setStatus(s);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		refresh();
		// 5 秒轮询 —— agent 连接状态需要近实时反映
		const id = setInterval(refresh, 5000);
		return () => clearInterval(id);
	}, [refresh]);

	// 启用 / 停用
	const onToggle = useCallback(async () => {
		if (!status) return;
		setBusy(true);
		setError(null);
		try {
			if (status.enabled) {
				await disable();
			} else {
				await enable();
			}
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [status, refresh]);

	const onCopySocket = useCallback(async () => {
		if (!status?.socketPath) return;
		await writeClipboard(status.socketPath);
	}, [status]);

	const onCopyEnvSnippet = useCallback(async () => {
		if (!status?.socketPath) return;
		const isWindows = /\\/.test(status.socketPath);
		const snippet = isWindows
			? `setx SSH_AUTH_SOCK "${status.socketPath}"`
			: `export SSH_AUTH_SOCK="${status.socketPath}"`;
		await writeClipboard(snippet);
	}, [status]);

	const onClearTrust = useCallback(async () => {
		setBusy(true);
		try {
			await clearTrustCache();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);

	const onToggleAudit = useCallback(async () => {
		setShowAudit((v) => !v);
		if (!showAudit) {
			try {
				const entries = await getAuditLog();
				setAuditEntries(entries);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		}
	}, [showAudit]);

	const onClearAudit = useCallback(async () => {
		setBusy(true);
		try {
			await clearAuditLog();
			setAuditEntries([]);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);

	if (!status) {
		// 第一次加载未完成 —— 显示骨架
		return (
			<section className="flex flex-col rounded-xl border border-(--line) bg-(--bg-elev)">
				<header className="flex items-center gap-2.5 border-b border-(--line-soft) px-5 py-4">
					<Terminal size={15} strokeWidth={1.5} className="text-(--text-2)" />
					<div className="flex flex-col leading-tight">
						<h2 className="text-[14px] font-semibold text-(--text)">
							{t("settings_section_ssh_agent")}
						</h2>
						<p className="text-[12px] text-(--text-3)">
							{t("settings_ssh_agent_loading")}
						</p>
					</div>
				</header>
			</section>
		);
	}

	// 计算 agent 状态描述
	const agentStatusLabel = status.enabled
		? status.agentConnected
			? t("settings_ssh_agent_status_connected")
			: status.agentSupervised
				? t("settings_ssh_agent_status_starting")
				: t("settings_ssh_agent_status_waiting")
		: t("settings_ssh_agent_status_disabled");

	const StatusIcon =
		status.enabled && status.agentConnected ? CheckCircle2 : AlertCircle;

	return (
		<section className="flex flex-col rounded-xl border border-(--line) bg-(--bg-elev)">
			<header className="flex items-center gap-2.5 border-b border-(--line-soft) px-5 py-4">
				<Terminal size={15} strokeWidth={1.5} className="text-(--text-2)" />
				<div className="flex min-w-0 flex-1 flex-col leading-tight">
					<h2 className="text-[14px] font-semibold text-(--text)">
						{t("settings_section_ssh_agent")}
					</h2>
					<p className="text-[12px] text-(--text-3)">
						{t("settings_section_ssh_agent_desc")}
					</p>
				</div>
				<div className="shrink-0">
					<Button
						onClick={onToggle}
						disabled={busy}
						leftIcon={<Power size={13} strokeWidth={1.5} />}
					>
						{status.enabled
							? t("settings_ssh_agent_btn_disable")
							: t("settings_ssh_agent_btn_enable")}
					</Button>
				</div>
			</header>

			<div className="flex flex-col divide-y divide-(--line-soft)">
				{/* 状态行 */}
				<div className="flex items-center justify-between gap-4 px-5 py-3.5">
					<div className="flex items-center gap-2.5">
						<StatusIcon
							size={14}
							strokeWidth={1.5}
							className={
								status.enabled && status.agentConnected
									? "text-(--text)"
									: "text-(--text-3)"
							}
						/>
						<span className="text-[13px] text-(--text)">
							{agentStatusLabel}
						</span>
					</div>
					<span className="font-mono text-[12px] text-(--text-3)">
						{status.keyCount} {t("settings_ssh_agent_keys")}
					</span>
				</div>

				{/* SSH_AUTH_SOCK 路径 */}
				<div className="flex flex-col gap-2 px-5 py-3.5">
					<div className="text-[12px] text-(--text-3)">
						{t("settings_ssh_agent_socket_label")}
					</div>
					{/* socket 路径 + 复制按钮行
					 *
					 * 布局要点：
					 *   - code 用 min-w-0 + flex-1 让 truncate 在 flex 容器里生效
					 *     （不加 min-w-0 的话，子项默认 min-width=auto 会被内容
					 *     撑到原始宽度 + 把右侧按钮挤出容器，导致上一张截图
					 *     看到的「按钮文本倒贴」样子）
					 *   - flex-wrap 兑 —— 极窄窗口下让按钮可以换行不压坏 code
					 *   - shrink-0 锁住按钮不被压缩
					 *   - icon 复制按钮用 size="icon"，「复制 export」用转用 sm。
					 */}
					<div className="flex flex-wrap items-center gap-2">
						<code className="min-w-0 flex-1 basis-full truncate rounded-md border border-(--line) bg-(--bg) px-2.5 py-1.5 font-mono text-[12px] text-(--text) sm:basis-0">
							{status.socketPath}
						</code>
						<div className="flex shrink-0 items-center gap-1.5">
							<Button
								variant="secondary"
								size="icon"
								onClick={onCopySocket}
								aria-label={t("settings_ssh_agent_copy_path")}
								title={t("settings_ssh_agent_copy_path")}
							>
								<Copy size={13} strokeWidth={1.5} />
							</Button>
							<Button
								variant="secondary"
								size="sm"
								onClick={onCopyEnvSnippet}
								title={t("settings_ssh_agent_copy_env")}
							>
								{t("settings_ssh_agent_copy_env_btn")}
							</Button>
						</div>
					</div>
					<p className="text-[11.5px] text-(--text-4)">
						{t("settings_ssh_agent_env_hint")}
					</p>
				</div>

				{/* 信任 cache 管理 */}
				<div className="flex items-center justify-between gap-4 px-5 py-3.5">
					<div className="flex min-w-0 flex-1 flex-col leading-tight">
						<span className="text-[13px] text-(--text)">
							{t("settings_ssh_agent_trust_label")}
						</span>
						<span className="text-[11.5px] text-(--text-4)">
							{t("settings_ssh_agent_trust_desc")}
						</span>
					</div>
					<div className="shrink-0">
						<Button
							onClick={onClearTrust}
							disabled={busy}
							leftIcon={<Eraser size={13} strokeWidth={1.5} />}
						>
							{t("settings_ssh_agent_trust_clear")}
						</Button>
					</div>
				</div>

				{/* 审计日志开关 */}
				<div className="flex items-center justify-between gap-4 px-5 py-3.5">
					<div className="flex min-w-0 flex-1 flex-col leading-tight">
						<span className="text-[13px] text-(--text)">
							{t("settings_ssh_agent_audit_label")}
						</span>
						<span className="text-[11.5px] text-(--text-4)">
							{t("settings_ssh_agent_audit_desc")}
						</span>
					</div>
					<div className="shrink-0">
						<Button onClick={onToggleAudit}>
							{showAudit
								? t("settings_ssh_agent_audit_hide")
								: t("settings_ssh_agent_audit_show")}
						</Button>
					</div>
				</div>

				{showAudit && (
					<div className="flex flex-col gap-2 px-5 py-3.5">
						{auditEntries.length === 0 ? (
							<p className="py-4 text-center text-[12px] text-(--text-4)">
								{t("settings_ssh_agent_audit_empty")}
							</p>
						) : (
							<div className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-(--line) bg-(--bg)">
								{auditEntries.map((entry, idx) => (
									<AuditRow key={`${entry.timestampMs}-${idx}`} entry={entry} />
								))}
							</div>
						)}
						<div className="flex justify-end">
							<Button
								onClick={onClearAudit}
								disabled={busy}
								leftIcon={<Trash2 size={13} strokeWidth={1.5} />}
							>
								{t("settings_ssh_agent_audit_clear")}
							</Button>
						</div>
					</div>
				)}

				{/* 调试信息折叠面板 */}
				<div className="flex flex-col gap-2 px-5 py-3.5">
					<button
						type="button"
						onClick={() => setShowDebug((v) => !v)}
						className="flex items-center gap-1.5 self-start text-[11.5px] text-(--text-4) hover:text-(--text-2)"
					>
						<HelpCircle size={12} strokeWidth={1.5} />
						{showDebug
							? t("settings_ssh_agent_debug_hide")
							: t("settings_ssh_agent_debug_show")}
					</button>

					{showDebug && (
						<div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
							<span className="text-(--text-4)">
								{t("settings_ssh_agent_debug_control")}
							</span>
							<code className="truncate font-mono text-(--text-3)">
								{status.controlPath}
							</code>
							<span className="text-(--text-4)">
								{t("settings_ssh_agent_debug_binary")}
							</span>
							<code className="truncate font-mono text-(--text-3)">
								{status.agentBinaryPath ||
									t("settings_ssh_agent_debug_no_binary")}
							</code>
							<span className="text-(--text-4)">
								{t("settings_ssh_agent_debug_supervised")}
							</span>
							<span className="text-(--text-3)">
								{status.agentSupervised
									? t("settings_ssh_agent_debug_supervised_yes")
									: t("settings_ssh_agent_debug_supervised_no")}
							</span>
						</div>
					)}
				</div>

				{error && (
					<div className="flex items-center gap-2 px-5 py-3 text-[12px] text-(--text)">
						<AlertCircle
							size={13}
							strokeWidth={1.5}
							className="text-(--text-2)"
						/>
						<span className="font-mono text-(--text-3)">{error}</span>
						<button
							type="button"
							onClick={() => {
								setError(null);
								refresh();
							}}
							className="ml-auto flex items-center gap-1 text-(--text-2) hover:text-(--text)"
						>
							<RefreshCw size={12} strokeWidth={1.5} />
							{t("settings_ssh_agent_retry")}
						</button>
					</div>
				)}
			</div>
		</section>
	);
}

/**
 * 单条审计记录的展示行
 */
function AuditRow({ entry }: { entry: AuditEntry }) {
	const { t } = useTranslation();
	const date = new Date(entry.timestampMs);
	const timeStr = date.toLocaleString();
	const outcomeLabel = translateOutcome(entry.outcome, t);
	return (
		<div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-(--line-soft) px-3 py-2 last:border-b-0">
			<span
				className={`h-2 w-2 rounded-full ${
					entry.approved ? "bg-(--text-2)" : "bg-(--text-4)"
				}`}
			/>
			<div className="flex min-w-0 flex-col">
				<span className="truncate text-[12px] text-(--text)">
					{entry.itemName || entry.fingerprint || "—"}
				</span>
				<span className="truncate font-mono text-[11px] text-(--text-4)">
					{entry.clientExe || `pid ${entry.clientPid}` || "—"}
				</span>
			</div>
			<div className="flex flex-col items-end text-[11px]">
				<span className="text-(--text-3)">{outcomeLabel}</span>
				<span className="font-mono text-(--text-4)">{timeStr}</span>
			</div>
		</div>
	);
}

/**
 * 把后端 outcome 字符串翻译为本地化人类可读
 */
function translateOutcome(outcome: string, t: (k: string) => string): string {
	const map: Record<string, string> = {
		approved: t("settings_ssh_agent_outcome_approved"),
		declined: t("settings_ssh_agent_outcome_declined"),
		timeout: t("settings_ssh_agent_outcome_timeout"),
		"vault-locked": t("settings_ssh_agent_outcome_vault_locked"),
		"key-not-found": t("settings_ssh_agent_outcome_key_not_found"),
		"trusted-cache": t("settings_ssh_agent_outcome_trusted_cache"),
	};
	return map[outcome] ?? outcome;
}

export default SshAgentSection;
