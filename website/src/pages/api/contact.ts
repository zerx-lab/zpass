// ============================================================================
// /api/contact — "联系我们"表单代理
//
// 流程：
//   1. 浏览器 POST { name, email, type, message, lang? } → 本端点
//   2. 输入校验（必填字段、邮箱格式、内容长度）
//   3. 调 listmonk /api/tx（subscriber_mode: "external"）发通知邮件到站长
//      external 模式：收件人无需是 listmonk 订阅者，直接投递任意邮箱
//   4. （可选）给用户发一封自动回执邮件（同样用 external 模式）
//
// 渲染模式：
//   全站 output: "static"，本端点单独 prerender = false（Astro Node SSR）
//
// 协议：
//   入参 (POST JSON):  { name: string, email: string, type: string, message: string, lang?: "zh"|"en" }
//   出参 (JSON):       { ok: boolean, error?: string }
// ============================================================================

import type { APIRoute } from "astro";

export const prerender = false;

// ---- 配置 ---------------------------------------------------------------

const BASE =
	import.meta.env.LISTMONK_BASE_URL ?? "https://subscription.zerx.dev";

const API_AUTH =
	import.meta.env.LISTMONK_API_TOKEN ??
	"zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC";

// 站长邮箱（接收联系通知）
const ADMIN_EMAIL = import.meta.env.CONTACT_ADMIN_EMAIL ?? "1603852@qq.com";

// 站长通知模板 ID（ZPass – Contact Notify，listmonk id=7）
// 内容：姓名 / 邮箱 / 类型 / 消息全文 + 直接回复按钮
const CONTACT_NOTIFY_TEMPLATE_ID = Number(
	import.meta.env.LISTMONK_CONTACT_NOTIFY_TEMPLATE_ID ?? "7",
);

// 用户回执模板 ID（ZPass – Contact Ack，listmonk id=8）
// 内容：确认已收到 + 消息摘要
const CONTACT_ACK_TEMPLATE_ID = Number(
	import.meta.env.LISTMONK_CONTACT_ACK_TEMPLATE_ID ?? "8",
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE_LEN = 2000;

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

function detectLang(
	payloadLang: unknown,
	acceptLang: string | null,
): "zh" | "en" {
	const raw = (
		typeof payloadLang === "string" ? payloadLang : (acceptLang ?? "")
	).toLowerCase();
	return raw.startsWith("zh") ? "zh" : "en";
}

/**
 * 发 listmonk transactional 邮件给任意收件人。
 * 失败时 console.warn 并抛出，由调用方决定是否影响响应。
 */
async function sendTx(
	toEmail: string,
	subject: string,
	templateId: number,
	data: Record<string, unknown>,
): Promise<void> {
	const r = await fetch(`${BASE}/api/tx`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `token ${API_AUTH}`,
		},
		body: JSON.stringify({
			subscriber_mode: "external",
			subscriber_emails: [toEmail],
			template_id: templateId,
			subject,
			content_type: "html",
			data,
		}),
	});
	if (!r.ok) {
		const b = await r.text();
		console.warn("[contact] /api/tx failed:", r.status, b);
		throw new Error(`tx_failed_${r.status}`);
	}
}

// ---- handler ------------------------------------------------------------

export const POST: APIRoute = async ({ request }) => {
	// 1) 解析入参
	let payload: {
		name?: unknown;
		email?: unknown;
		type?: unknown;
		message?: unknown;
		lang?: unknown;
	} = {};
	try {
		payload = await request.json();
	} catch {
		return json({ ok: false, error: "invalid_json" }, 400);
	}

	const name = typeof payload.name === "string" ? payload.name.trim() : "";
	const email = typeof payload.email === "string" ? payload.email.trim() : "";
	const type =
		typeof payload.type === "string" ? payload.type.trim() : "general";
	const message =
		typeof payload.message === "string" ? payload.message.trim() : "";
	const lang = detectLang(payload.lang, request.headers.get("Accept-Language"));

	// 2) 校验
	if (!name) return json({ ok: false, error: "name_required" }, 400);
	if (!EMAIL_RE.test(email))
		return json({ ok: false, error: "invalid_email" }, 400);
	if (!message) return json({ ok: false, error: "message_required" }, 400);
	if (message.length > MAX_MESSAGE_LEN)
		return json({ ok: false, error: "message_too_long" }, 400);

	// 3) 通知站长
	const adminSubject =
		lang === "zh"
			? `[ZPass 官网] 来自 ${name} 的新消息（${type}）`
			: `[ZPass Website] New message from ${name} (${type})`;

	try {
		await sendTx(ADMIN_EMAIL, adminSubject, CONTACT_NOTIFY_TEMPLATE_ID, {
			lang,
			sender_name: name,
			sender_email: email,
			contact_type: type,
			contact_message: message,
		});
	} catch (err) {
		console.error("[contact] failed to notify admin:", err);
		return json({ ok: false, error: "notify_failed" }, 502);
	}

	// 4) 给用户发自动回执（失败不影响主流程响应）
	const ackSubject =
		lang === "zh"
			? "我们已收到你的消息 — ZPass"
			: "We received your message — ZPass";
	sendTx(email, ackSubject, CONTACT_ACK_TEMPLATE_ID, {
		lang,
		sender_name: name,
		contact_message: message,
	}).catch((e) => console.warn("[contact] ack email failed:", e));

	return json({ ok: true });
};

export const ALL: APIRoute = ({ request }) => {
	if (request.method === "POST") {
		return json({ ok: false, error: "internal" }, 500);
	}
	return json({ ok: false, error: "method_not_allowed" }, 405);
};
