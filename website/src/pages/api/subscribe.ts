// ============================================================================
// /api/subscribe — listmonk 订阅代理 + 双语美化确认邮件
//
// 流程：
//   1. 浏览器 POST { email, name?, lang? } → 本端点（同源，无 CORS 问题）
//   2. 本端点调 listmonk 公开 API /api/public/subscription 注册订阅者
//      （listmonk 自己的 optin 邮件已在后台设置中关闭，见 app.send_optin_confirmation=false）
//   3. 订阅成功后（HTTP 2xx），查询订阅者信息（UUID + 列表订阅状态）：
//      - subscription_status === "confirmed"  → 已完成双重确认，跳过发邮件，
//        向前端返回 { ok: true, alreadyConfirmed: true }
//      - subscription_status === "unconfirmed" 或查不到状态 → 发美化确认邮件
//      确认链接格式：{LISTMONK_ROOT}/subscription/optin/{uuid}?l={LIST_UUID}
//
//   ⚠️ 注意：不能用 listmonk 响应里的 data.has_optin 作为 "是否要发邮件" 的判据。
//      has_optin 语义是 "listmonk 自己是否已发 optin 邮件"。由于我们已全局关闭
//      app.send_optin_confirmation，listmonk 永远返回 has_optin=false，导致旧逻辑
//      `if (hasOptin)` 永远不走，两头都不发邮件。
//
// 语言判定：
//   优先取 payload.lang（由前端 detectLang() 传入：<html lang> → navigator.language）；
//   若缺失则解析 Accept-Language 请求头；其他值一律回落为 "en"。
//
// 渲染模式：
//   全站 output: "static"，本端点单独 prerender = false（Astro Node SSR）。
//
// 协议：
//   入参 (POST JSON):  { email: string, name?: string, lang?: "zh"|"en" }
//   出参 (JSON):       { ok: boolean, hasOptin?: boolean, alreadyConfirmed?: boolean, error?: string }
// ============================================================================

import type { APIRoute } from "astro";

export const prerender = false;

// ---- 配置 ---------------------------------------------------------------

const BASE =
	import.meta.env.LISTMONK_BASE_URL ?? "https://subscription.zerx.dev";

// 公开订阅端点（无需鉴权）
const PUBLIC_SUB_ENDPOINT = `${BASE}/api/public/subscription`;

// 管理 API 鉴权（用于查 subscriber UUID + 发 /api/tx）
// 格式：username:token，存入环境变量 LISTMONK_API_TOKEN
const API_AUTH =
	import.meta.env.LISTMONK_API_TOKEN ??
	"zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC";

// double opt-in 列表
const LIST_UUID =
	import.meta.env.LISTMONK_LIST_UUID ?? "4031ab87-42a9-4710-a8b1-a14514a47c2e";

// 美化确认邮件的 Transactional 模板 ID（listmonk 后台 id=5）
const CONFIRM_TEMPLATE_ID = Number(
	import.meta.env.LISTMONK_CONFIRM_TEMPLATE_ID ?? "5",
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- 工具 ---------------------------------------------------------------

function json(body: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

/** 从 payload.lang 或 Accept-Language 头推断语言，规范化为 "zh" | "en" */
function detectLang(
	payloadLang: unknown,
	acceptLang: string | null,
): "zh" | "en" {
	const raw = (
		typeof payloadLang === "string" ? payloadLang : (acceptLang ?? "")
	).toLowerCase();
	return raw.startsWith("zh") ? "zh" : "en";
}

interface SubscriberInfo {
	uuid: string;
	/** 该订阅者在目标列表中的确认状态："confirmed" | "unconfirmed" | unknown */
	subscriptionStatus: string | null;
}

/**
 * 用 listmonk 管理 API 查询订阅者信息（UUID + 列表订阅状态）。
 *
 * subscriptionStatus 取自 subscriber.lists[n].subscription_status，
 * 其中 n 为 list_uuid 与 LIST_UUID 匹配的那一项。
 * - "confirmed"   → 该邮箱已完成 double opt-in，无需再发确认邮件
 * - "unconfirmed" → 尚未确认，应发（或重发）确认邮件
 * - null          → 查不到信息（API 失败等），保守地当作需要发邮件处理
 */
async function fetchSubscriberInfo(
	email: string,
): Promise<SubscriberInfo | null> {
	try {
		const r = await fetch(
			`${BASE}/api/subscribers?query=${encodeURIComponent(`subscribers.email = '${email.replace(/'/g, "''")}'`)}&per_page=1`,
			{
				headers: {
					Authorization: `token ${API_AUTH}`,
					Accept: "application/json",
				},
			},
		);
		if (!r.ok) return null;
		const body = (await r.json()) as {
			data?: {
				results?: Array<{
					uuid: string;
					lists?: Array<{ uuid: string; subscription_status: string }>;
				}>;
			};
		};
		const sub = body.data?.results?.[0];
		if (!sub) return null;

		// 在该订阅者所属列表里找与 LIST_UUID 匹配的一项，取其 subscription_status
		const matchedList = sub.lists?.find((l) => l.uuid === LIST_UUID);
		return {
			uuid: sub.uuid,
			subscriptionStatus: matchedList?.subscription_status ?? null,
		};
	} catch {
		return null;
	}
}

/** 发送美化版双语确认邮件（via /api/tx）；失败时静默，不影响订阅成功响应 */
async function sendConfirmEmail(
	email: string,
	uuid: string,
	lang: "zh" | "en",
): Promise<void> {
	const optinUrl = `${BASE}/subscription/optin/${uuid}?l=${LIST_UUID}`;
	const subject =
		lang === "zh"
			? "确认订阅 ZPass 早期通知"
			: "Confirm your ZPass subscription";

	try {
		const r = await fetch(`${BASE}/api/tx`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `token ${API_AUTH}`,
			},
			body: JSON.stringify({
				subscriber_emails: [email],
				template_id: CONFIRM_TEMPLATE_ID,
				subject,
				content_type: "html",
				data: { lang, optin_url: optinUrl },
			}),
		});
		if (!r.ok) {
			const b = await r.text();
			console.warn("[subscribe] /api/tx failed:", r.status, b);
		}
	} catch (err) {
		console.warn("[subscribe] /api/tx error:", err);
	}
}

// ---- handler ------------------------------------------------------------

export const POST: APIRoute = async ({ request }) => {
	// 1) 解析入参
	let payload: { email?: unknown; name?: unknown; lang?: unknown } = {};
	try {
		payload = await request.json();
	} catch {
		return json({ ok: false, error: "invalid_json" }, 400);
	}

	const email = typeof payload.email === "string" ? payload.email.trim() : "";
	const name = typeof payload.name === "string" ? payload.name.trim() : "";
	const lang = detectLang(payload.lang, request.headers.get("Accept-Language"));

	if (!EMAIL_RE.test(email)) {
		return json({ ok: false, error: "invalid_email" }, 400);
	}

	// 2) 注册订阅者（公开 API，listmonk 自己的 optin 邮件已在后台关闭）
	let upstream: Response;
	try {
		upstream = await fetch(PUBLIC_SUB_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ email, name, list_uuids: [LIST_UUID] }),
		});
	} catch (err) {
		console.error("[subscribe] upstream fetch failed:", err);
		return json({ ok: false, error: "upstream_unreachable" }, 502);
	}

	let upstreamBody: { data?: { has_optin?: boolean }; message?: string } = {};
	try {
		upstreamBody = await upstream.json();
	} catch {
		/* 非 JSON，按 HTTP 状态判定 */
	}

	if (!upstream.ok) {
		console.warn(
			"[subscribe] listmonk rejected:",
			upstream.status,
			upstreamBody,
		);
		return json(
			{
				ok: false,
				error: upstreamBody.message ?? `upstream_${upstream.status}`,
			},
			upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
		);
	}

	// 3) 订阅成功 → 同步查询列表订阅状态，决定是否发确认邮件，并将结果反映到响应体。
	//    - confirmed   → 已完成 double opt-in，跳过发邮件，返回 alreadyConfirmed: true
	//    - unconfirmed / 查不到 → 发（或重发）美化确认邮件，返回 hasOptin: true
	//    不再依赖 upstreamBody.data.has_optin，原因见文件头注释。
	const info = await fetchSubscriberInfo(email);

	if (!info) {
		// 查不到订阅者信息（异常情况）：保守地不发邮件，仍告知前端请确认邮箱
		console.warn("[subscribe] could not fetch subscriber info for", email);
		return json({ ok: true, hasOptin: true });
	}

	if (info.subscriptionStatus === "confirmed") {
		// 已完成 double opt-in，无需再发确认邮件
		console.info("[subscribe] already confirmed, skip email:", email);
		return json({ ok: true, alreadyConfirmed: true });
	}

	// unconfirmed 或状态未知 → 发（或重发）确认邮件
	await sendConfirmEmail(email, info.uuid, lang);
	return json({ ok: true, hasOptin: true });
};

// 非 POST 请求统一返回 405，便于排错
export const ALL: APIRoute = ({ request }) => {
	if (request.method === "POST") {
		// 不会走到这里；POST 已被上面的导出接管
		return json({ ok: false, error: "internal" }, 500);
	}
	return json({ ok: false, error: "method_not_allowed" }, 405);
};
