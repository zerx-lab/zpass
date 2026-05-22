// SSH agent API 适配层 —— Wails SshAgentService 的前端类型化包装
// ---------------------------------------------------------------------------
// 与 vault-api.ts 同样的「类型化 IPC + 非 Wails 环境 fallback」模式。
//
// 后端方法（见 sshagentservice.go）：
//   - Status()                     → SshAgentStatus
//   - Enable() / Disable()         → error
//   - GetSocketPath()              → string
//   - PushVaultKeys()              → error
//   - ApproveSignRequest(id, opts) → error
//   - DeclineSignRequest(id)       → error
//   - ListPendingApprovals()       → ApprovalRequest[]
//   - ClearTrustCache()            → error
//   - GetAuditLog()                → AuditEntry[]
//   - ClearAuditLog()              → error
//   - LocateAgentBinary()          → string
//
// 前端事件（由后端 emit）：
//   - "ssh-agent:approval-request"   payload: ApprovalRequest
//   - "ssh-agent:approval-cancelled" payload: { id, reason }
//
// ---------------------------------------------------------------------------
// 设计原则与 vault-api 一致：
//   1. 单一入口 —— 组件不直接 Call.ByName
//   2. 类型贴合后端 JSON tag
//   3. 错误透传为 Error 对象，调用方 try/catch
//   4. 非 Wails 环境 fallback —— 内存状态 + 假数据，让 vite preview 不崩

import { Call as $WailsCall } from "@wailsio/runtime";

// ---------------------------------------------------------------------------
// 类型定义 —— 与 Go SshAgentStatus / ApprovalRequest / AuditEntry 一一对应
// ---------------------------------------------------------------------------

export interface SshAgentStatus {
	enabled: boolean;
	agentConnected: boolean;
	agentSupervised: boolean;
	agentManagedBySystem: boolean;
	socketPath: string;
	controlPath: string;
	keyCount: number;
	agentBinaryPath: string;
}

export interface ApprovalRequest {
	id: string;
	fingerprint: string;
	fingerprintShort: string;
	itemId: string;
	itemName: string;
	clientPid: number;
	clientExe: string;
	clientExeShort: string;
	clientExeHashShort: string;
	createdAtMs: number;
}

export interface ApprovalDecisionOptions {
	trustDurationSeconds: number;
}

export interface AuditEntry {
	timestampMs: number;
	itemId: string;
	itemName: string;
	fingerprint: string;
	clientExe: string;
	clientPid: number;
	outcome: string;
	approved: boolean;
}

// ---------------------------------------------------------------------------
// 运行时检测
// ---------------------------------------------------------------------------

function isWailsRuntime(): boolean {
	if (typeof window === "undefined") return false;
	return Boolean((window as unknown as { _wails?: unknown })._wails);
}

// 非 Wails 环境下的内存 fallback —— 让前端开发在脱离桌面壳时仍能渲染
const memoryStub = {
	status: {
		enabled: false,
		agentConnected: false,
		agentSupervised: false,
		agentManagedBySystem: false,
		socketPath: "/tmp/zpass/agent.sock (mock)",
		controlPath: "/tmp/zpass/control.sock (mock)",
		keyCount: 0,
		agentBinaryPath: "",
	} as SshAgentStatus,
	pending: [] as ApprovalRequest[],
	audit: [] as AuditEntry[],
};

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
	if (!isWailsRuntime()) {
		// fallback 模拟值在调用方各自处理；这里抛错让上层显式 catch
		throw new Error(`Wails runtime unavailable: cannot call ${method}`);
	}
	return await ($WailsCall.ByName(
		`main.SshAgentService.${method}`,
		...args,
	) as Promise<T>);
}

/**
 * 获取 SSH agent 服务状态。
 *
 * 非 Wails 环境下返回 mock 状态（enabled=false）以便 UI 仍能渲染。
 */
export async function getStatus(): Promise<SshAgentStatus> {
	if (!isWailsRuntime()) return { ...memoryStub.status };
	return call<SshAgentStatus>("Status");
}

/** 启用 SSH agent 服务（监听控制通道 + 启动 agent 子进程） */
export async function enable(): Promise<void> {
	if (!isWailsRuntime()) {
		memoryStub.status.enabled = true;
		return;
	}
	await call<void>("Enable");
}

/** 停用 SSH agent 服务（停 listener + 关 agent 子进程） */
export async function disable(): Promise<void> {
	if (!isWailsRuntime()) {
		memoryStub.status.enabled = false;
		memoryStub.status.agentSupervised = false;
		memoryStub.status.agentConnected = false;
		return;
	}
	await call<void>("Disable");
}

/** 拿 SSH 客户端要 connect 的 agent socket 路径（即便服务未启用也能查） */
export async function getSocketPath(): Promise<string> {
	if (!isWailsRuntime()) return memoryStub.status.socketPath;
	return call<string>("GetSocketPath");
}

/** 主动触发一次「重新读 vault SSH 条目 → 推送给 agent」 */
export async function pushVaultKeys(): Promise<void> {
	if (!isWailsRuntime()) return;
	await call<void>("PushVaultKeys");
}

/**
 * 用户在确认窗点「批准」时调。
 *
 * @param approvalId  从 ssh-agent:approval-request 事件拿到的 id
 * @param trustDurationSeconds 0 = 仅本次；> 0 = 信任 N 秒（上限 8 小时）
 */
export async function approveSignRequest(
	approvalId: string,
	trustDurationSeconds = 0,
): Promise<void> {
	if (!isWailsRuntime()) return;
	const opts: ApprovalDecisionOptions = { trustDurationSeconds };
	await call<void>("ApproveSignRequest", approvalId, opts);
}

/** 用户在确认窗点「拒绝」时调 */
export async function declineSignRequest(approvalId: string): Promise<void> {
	if (!isWailsRuntime()) return;
	await call<void>("DeclineSignRequest", approvalId);
}

/** 拉当前所有 in-flight approval（启动确认窗后调一次充填）*/
export async function listPendingApprovals(): Promise<ApprovalRequest[]> {
	if (!isWailsRuntime()) return [...memoryStub.pending];
	const out = await call<ApprovalRequest[]>("ListPendingApprovals");
	return out ?? [];
}

/** 清空信任 cache */
export async function clearTrustCache(): Promise<void> {
	if (!isWailsRuntime()) return;
	await call<void>("ClearTrustCache");
}

/** 拿审计日志（最新的在前）*/
export async function getAuditLog(): Promise<AuditEntry[]> {
	if (!isWailsRuntime()) return [...memoryStub.audit];
	const out = await call<AuditEntry[]>("GetAuditLog");
	return out ?? [];
}

/** 清空审计日志 */
export async function clearAuditLog(): Promise<void> {
	if (!isWailsRuntime()) return;
	await call<void>("ClearAuditLog");
}

/** 查 zpass-agent binary 位置（设置页调试信息用） */
export async function locateAgentBinary(): Promise<string> {
	if (!isWailsRuntime()) return "";
	return call<string>("LocateAgentBinary");
}

// ---------------------------------------------------------------------------
// SSH 密钥生成
// ---------------------------------------------------------------------------

export interface GeneratedKeyPair {
	algo: string;
	privateKeyPem: string;
	publicKeyOpenSsh: string;
	fingerprint: string;
}

/**
 * 在后端生成一对 SSH 密钥。
 *
 * @param algo  算法标识（"ed25519" / "rsa-3072" / "rsa-4096" / "ecdsa-p256"）。空 = ed25519
 * @param comment  公钥尾部注释，空 = "zpass"
 *
 * 返回的私钥 PEM 是明文 —— 上层需要在保存 vault item 后立即从 state 中
 * 清除引用，避免长期驻留。
 */
export async function generateSshKeyPair(
	algo: string,
	comment: string,
): Promise<GeneratedKeyPair> {
	if (!isWailsRuntime()) {
		// fallback：给一个假数据让 UI 仍能走流程（仅预览 / 测试用）
		return {
			algo: algo || "ed25519",
			privateKeyPem:
				"-----BEGIN OPENSSH PRIVATE KEY-----\n(mock - vite preview mode)\n-----END OPENSSH PRIVATE KEY-----\n",
			publicKeyOpenSsh: `ssh-ed25519 AAAAC3MOCK ${comment || "zpass"}`,
			fingerprint: "SHA256:MOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCK",
		};
	}
	return call<GeneratedKeyPair>("GenerateKeyPair", algo, comment);
}

/** 查后端支持的算法列表 */
export async function supportedSshAlgos(): Promise<string[]> {
	if (!isWailsRuntime())
		return ["ed25519", "rsa-3072", "rsa-4096", "ecdsa-p256"];
	const out = await call<string[]>("SupportedSSHAlgos");
	return out ?? [];
}

// ---------------------------------------------------------------------------
// 系统服务安装
// ---------------------------------------------------------------------------

export interface SystemServiceStatus {
	supported: boolean;
	installed: boolean;
	enabled: boolean;
	platformLabel: string;
}

/** 查系统服务状态（Linux systemd / Windows Scheduled Task / 其他不支持） */
export async function getSystemServiceStatus(): Promise<SystemServiceStatus> {
	if (!isWailsRuntime()) {
		return {
			supported: false,
			installed: false,
			enabled: false,
			platformLabel: "not running in Wails",
		};
	}
	return call<SystemServiceStatus>("GetSystemServiceStatus");
}

/** 手动安装系统服务（设置页「安装为系统服务」按钮） */
export async function installSystemService(): Promise<void> {
	if (!isWailsRuntime()) return;
	await call<void>("InstallSystemService");
}

/** 卸载系统服务 */
export async function uninstallSystemService(): Promise<void> {
	if (!isWailsRuntime()) return;
	await call<void>("UninstallSystemService");
}

// ---------------------------------------------------------------------------
// 事件订阅
// ---------------------------------------------------------------------------

type ApprovalCancelledPayload = { id: string; reason: string };
type EventUnsubscribe = () => void;

/**
 * 订阅 approval-request 事件（每次有新签名请求等待用户决定时触发）。
 *
 * 返回 unsubscribe 函数。组件 unmount 时务必调用避免泄露 listener。
 */
export function onApprovalRequest(
	handler: (req: ApprovalRequest) => void,
): EventUnsubscribe {
	return subscribeWailsEvent<ApprovalRequest>(
		"ssh-agent:approval-request",
		handler,
	);
}

/**
 * 订阅 approval-cancelled 事件（超时 / ctx 取消时触发）。
 *
 * 前端确认窗收到此事件应当关闭对应 modal。
 */
export function onApprovalCancelled(
	handler: (payload: ApprovalCancelledPayload) => void,
): EventUnsubscribe {
	return subscribeWailsEvent<ApprovalCancelledPayload>(
		"ssh-agent:approval-cancelled",
		handler,
	);
}

/**
 * 内部：用 @wailsio/runtime 的 Events 订阅 event。
 *
 * 用 dynamic import 是因为 @wailsio/runtime 的 Events API 可能在不同
 * Wails 3 alpha 版本里有形态差异。我们用 window._wails 上的 Events 对象
 * 兜底，让代码兼容性更宽。
 */
function subscribeWailsEvent<T>(
	event: string,
	handler: (payload: T) => void,
): EventUnsubscribe {
	if (!isWailsRuntime()) {
		// 非 Wails 环境：返回 no-op unsubscribe，避免组件崩溃
		return () => {
			/* no-op */
		};
	}
	// Wails 3 的 @wailsio/runtime 暴露 Events.On(eventName, callback) → 返回
	// cancel 函数。具体类型在 generated bindings 之外可能没声明，所以这里
	// 用动态查询 + any 兼容。
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const events =
		(window as any)?.wails?.Events ?? (window as any)?._wails?.Events;
	if (!events || typeof events.On !== "function") {
		console.warn(
			`Wails Events API not available; cannot subscribe to ${event}`,
		);
		return () => {
			/* no-op */
		};
	}
	const cancel = events.On(event, (data: { data?: T } | T) => {
		// Wails 3 event 可能把 payload 包在 .data 里；也可能直接传。两边兼容。
		const payload = (data as { data?: T })?.data ?? (data as T);
		handler(payload);
	});
	return typeof cancel === "function" ? (cancel as EventUnsubscribe) : () => {};
}
