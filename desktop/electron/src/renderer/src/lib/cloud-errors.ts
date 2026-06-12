// 云同步错误文案本地化
// ---------------------------------------------------------------------------
// Go 后端（internal/cloud + internal/services）的错误以英文字符串原样抵达渲染层：
//   - RPC throw 路径：wailscompat 把 err.Error() 序列化为 {"error": "..."}，
//     wails-runtime 原样 throw —— e.message 即 Go 错误原文。
//   - 事件路径：cloud:sync:error 的 payload.message 同样是 err.Error()。
//
// 常见形态（嵌套包装从外到内）：
//   "cloud: http 403: plan_limit_exceeded"
//   "cloud: vault key: cloud: member/self: cloud: http 401: invalid credentials"
//   "cloud: POST /v1/vaults/x/changes: dial tcp 1.2.3.4:443: connection refused"
//   "cloud: server not configured"
//   "cloud: unwrap keyset (wrong master password or Secret Key?): cloudcrypto: aead authentication failed"
//
// translateCloudError(raw, t) 在【渲染时】把这些翻成当前语言的用户文案：
//   1. 优先匹配 "cloud: http <status>: <code>"，<code> 为服务端 error 字段，
//      按精确表 → 状态码分桶兜底（与 zpass_cloud/web_vault errors.ts 对齐）。
//   2. 非 HTTP 错误按本地哨兵串 / 网络层关键词匹配。
//   3. 未识别的保留原文并包一层"发生未知错误"，便于反馈排查。
//
// store（progress.error 等）继续存英文原文，翻译只发生在展示点 ——
// 切换语言后已有错误也会实时切换文案。

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** 匹配最内层的 "cloud: http <status>[: <server error code>]"。 */
const HTTP_RE = /cloud: http (\d+)(?::\s?(.+))?$/;

/** 服务端 error 字段（JSON body 的 "error" 值 / 纯文本 401 body）→ i18n key。 */
const SERVER_CODE_MAP: Record<string, string> = {
	// 认证 / 会话
	"invalid credentials": "cloud_err_credentials",
	"missing Authorization header": "cloud_err_session_expired",
	"expected Bearer scheme": "cloud_err_session_expired",
	"invalid or expired token": "cloud_err_session_expired",
	"session revoked or expired": "cloud_err_session_expired",
	"session revoked": "cloud_err_session_expired",
	"no session token": "cloud_err_session_expired",
	"login attempt expired or already used": "cloud_err_session_expired",
	"account disabled; contact your administrator": "cloud_err_account_disabled",
	"tenant suspended; contact your administrator": "cloud_err_tenant_suspended",
	"email already registered": "cloud_err_email_taken",
	"email already in use": "cloud_err_email_taken",
	"keyset not found": "cloud_err_credentials",
	"no such user or keyset": "cloud_err_credentials",
	// MFA
	"invalid code": "cloud_err_mfa_code",
	"mfa challenge expired; restart login": "cloud_err_mfa",
	// 保险库 / 条目
	"vault not found": "cloud_err_vault_not_found",
	"vault membership not found": "cloud_err_not_member",
	"not a vault member": "cloud_err_not_member",
	"item not found": "cloud_err_item_not_found",
	"cursor below oldest retained seq; resync required": "cloud_err_resync",
	// 附件
	"attachment exceeds 5 MiB limit": "attachment_too_large",
	// 套餐限额（HTTP 串里 dimension 已丢失，给统一文案）
	plan_limit_exceeded: "cloud_err_plan_limit",
	// 系统
	"database error": "cloud_err_server",
	"database unavailable": "cloud_err_server",
	db: "cloud_err_server",
	"service under maintenance; please retry shortly": "cloud_err_maintenance",
};

/** 本地（非 HTTP）错误串的 includes 匹配规则，从上到下取第一个命中。 */
const LOCAL_RULES: Array<[substr: string, key: string]> = [
	["server not configured", "cloud_err_not_configured"],
	["not signed in", "cloud_err_not_signed_in"],
	["multi-factor", "cloud_err_mfa"],
	["server identity proof failed", "cloud_err_server_proof"],
	// 错主密码 / Secret Key（unwrap keyset 上下文，须先于裸 aead 规则）
	["wrong master password or secret key", "cloud_err_credentials"],
	["secret key must be", "cloud_err_secretkey_format"],
	["master password must be at least", "cloud_err_weak_password"],
	// 条目 / 密钥解密失败
	["decrypt item", "cloud_err_decrypt"],
	["aead authentication failed", "cloud_err_decrypt"],
	// 套餐限额（PlanLimitError.Error() 形态，含 dimension）
	["plan limit exceeded: storage_quota_mb", "cloud_err_plan_limit_storage"],
	["plan limit exceeded", "cloud_err_plan_limit"],
	["attachment exceeds", "attachment_too_large"],
	// 绑定关系
	["already linked to a different vault", "cloud_err_space_already_linked"],
	["already linked to another space", "cloud_err_vault_already_linked"],
	["not a member of this vault", "cloud_err_not_member"],
	["not a vault member", "cloud_err_not_member"],
	// 同步状态
	["unresolved conflicts remain", "cloud_err_unresolved_conflicts"],
	["vault is locked", "cloud_err_vault_locked"],
	["vault service unavailable", "cloud_err_vault_unavailable"],
	["session expired", "cloud_err_session_expired"],
];

/** Go net/http 网络层失败的特征片段（离线 / 服务不可达 / 超时）。 */
const NETWORK_HINTS = [
	"dial tcp",
	"connection refused",
	"actively refused",
	"no such host",
	"network is unreachable",
	"context deadline exceeded",
	"i/o timeout",
	"connection reset",
	"tls handshake",
	"wsarecv",
];

function translateHttp(status: number, code: string, t: Translate): string {
	if (code) {
		const key = SERVER_CODE_MAP[code];
		if (key) return t(key);
		// 带动态内容的限流文案："too many login attempts; slow down" 等
		if (code.startsWith("too many") && code.includes("slow down")) {
			return t("cloud_err_rate_limited");
		}
		if (code.includes("invalid base64")) return t("cloud_err_bad_request");
	}
	// 状态码分桶兜底
	if (status === 401) return t("cloud_err_session_expired");
	if (status === 403) return t("cloud_err_forbidden");
	if (status === 413) return t("attachment_too_large");
	if (status === 429) return t("cloud_err_rate_limited");
	if (status >= 500) return t("cloud_err_server");
	return t("cloud_err_unknown", { detail: code || `HTTP ${status}` });
}

/**
 * 把后端云同步错误原文翻译为当前语言的用户文案。
 * 在渲染点调用（传入 useTranslation 的 t），不要在写入 store 时调用。
 */
export function translateCloudError(
	raw: string | null | undefined,
	t: Translate,
): string {
	const msg = (raw ?? "").trim();
	if (!msg) return t("cloud_err_generic");

	// 1. HTTP 错误（取最内层，包装链如 "cloud: vault key: ... cloud: http 401: x"）
	const m = HTTP_RE.exec(msg);
	if (m) return translateHttp(Number(m[1]), (m[2] ?? "").trim(), t);

	const lower = msg.toLowerCase();

	// 2. 本地哨兵错误
	for (const [substr, key] of LOCAL_RULES) {
		if (lower.includes(substr)) return t(key);
	}

	// 3. 网络层失败
	for (const hint of NETWORK_HINTS) {
		if (lower.includes(hint)) return t("cloud_err_network");
	}

	// 4. 未识别 —— 保留原文便于排查
	return t("cloud_err_unknown", { detail: msg });
}
