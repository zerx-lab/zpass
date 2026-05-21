// parse-otpauth.ts —— 前端轻量 otpauth:// URI 解析器
// ---------------------------------------------------------------------------
// 用途：仅在 QR 扫码面板的「识别结果预览」上展示元信息（issuer / account /
// algorithm / digits / period 等）。不做密钥的实际规范化与码生成——那是
// Go 后端 parseOtpauthURI + GenerateTOTP 的职责。
//
// 为什么不直接用 URL：
//   1. otpauth:// label 段可能含未编码的冒号（"issuer:account"），WHATWG URL
//      在某些边界情况下会把 label 切到 pathname / hash 不同段落，需要自己再做
//      宽容处理
//   2. 需要把 issuer 查询参数与 label 头部前缀做合并（标准里两处都可能出现 issuer）
//
// 与后端 parseOtpauthURI 的解析顺序保持等价：
//   - URI scheme 是 totp/hotp/steam
//   - 显式 issuer=Steam（或 path=steam）→ 类型为 steam
//   - secret 必填，缺失视为无效

/** 解析得到的 OTP 元信息快照 —— 仅用于 UI 预览，不参与码生成 */
export interface OtpauthMeta {
	/** 算法类型：totp / hotp / steam */
	type: "totp" | "hotp" | "steam";
	/** 规范化后的 base32 密钥（已去空格 / 转大写 / 去 padding） */
	secret: string;
	/** 发行者，如 GitHub / Google / Steam */
	issuer: string;
	/** 账户标识，如 alex@example.com */
	account: string;
	/** 哈希算法：SHA1 / SHA256 / SHA512 */
	algorithm: string;
	/** OTP 位数；TOTP 默认 6，Steam 5 */
	digits: number;
	/** TOTP 周期秒；HOTP 为 0 */
	period: number;
	/** HOTP 计数器；TOTP/Steam 为 0 */
	counter: number;
}

/** 解析错误类型 —— 让调用方据此映射不同的 UI 文案 */
export type OtpauthParseError =
	| "not-otpauth" // 整段不是 otpauth:// 开头
	| "invalid-uri" // otpauth:// 但 URL 解析失败
	| "missing-secret" // 缺 secret 参数
	| "invalid-type"; // type 段不是 totp/hotp/steam

export interface OtpauthParseResult {
	ok: boolean;
	meta?: OtpauthMeta;
	error?: OtpauthParseError;
	/** 原始字符串（成功时是规范化的 otpauth URI，失败时是原始扫码内容） */
	raw: string;
}

/**
 * 规范化裸 base32：去空白 + 转大写 + 去尾部 padding
 *
 * 与后端 normalizeBase32 行为一致。仅用于把 URI 内的 secret 参数清理成
 * UI 友好的展示形式。
 */
function normalizeBase32(s: string): string {
	return s
		.replace(/[\s\t\n\r]+/g, "")
		.toUpperCase()
		.replace(/=+$/, "");
}

/**
 * 从 otpauth:// 字符串里抽出 type 段（host）—— 兼容 net/url 在某些 webview
 * 下把 type 解析到 path 而不是 host 的边界情况。
 */
function extractType(raw: string, parsedHost: string): string {
	if (parsedHost) return parsedHost.toLowerCase();
	const rest = raw.slice("otpauth://".length);
	const slash = rest.indexOf("/");
	const q = rest.indexOf("?");
	const end = slash > 0 && (q < 0 || slash < q) ? slash : q > 0 ? q : rest.length;
	return rest.slice(0, end).toLowerCase();
}

/**
 * 从 label 里拆出 issuer/account
 *
 * label 标准形态：
 *   - "Issuer:Account"
 *   - "Issuer%3AAccount"（已 URL 编码）
 *   - "Account"（无 issuer 前缀）
 *
 * 注意 pathname 可能带前导斜杠，需先 trim 掉。
 */
function splitLabel(pathname: string): { issuer: string; account: string } {
	const label = decodeURIComponent(pathname.replace(/^\/+/, "")).trim();
	// 有些客户端会把 label 写成 issuer:account（冒号分隔）
	const colonIdx = label.indexOf(":");
	if (colonIdx > 0) {
		const issuer = label.slice(0, colonIdx).trim();
		const account = label.slice(colonIdx + 1).trim();
		return { issuer, account };
	}
	return { issuer: "", account: label };
}

/**
 * 解析 otpauth:// URI 并返回结构化元信息
 *
 * 入参可以是：
 *   - 完整 otpauth:// URI
 *   - 任意其它字符串（返回 ok=false, error="not-otpauth"）
 *
 * 行为：
 *   1. 非 otpauth:// 开头 → not-otpauth
 *   2. URL 解析失败 → invalid-uri
 *   3. type 段不在 {totp, hotp, steam} 内 → invalid-type
 *   4. 缺 secret 参数 → missing-secret
 *   5. 其它情况返回 ok=true + 完整 meta
 *
 * Steam 推断：path=steam 或 issuer 查询参数（或 label issuer）=Steam（不区分大小写）
 */
export function parseOtpauth(raw: string): OtpauthParseResult {
	const trimmed = raw.trim();
	if (!/^otpauth:\/\//i.test(trimmed)) {
		return { ok: false, error: "not-otpauth", raw };
	}

	let u: URL;
	try {
		u = new URL(trimmed);
	} catch {
		return { ok: false, error: "invalid-uri", raw };
	}

	const typePath = extractType(trimmed, u.host);
	if (typePath !== "totp" && typePath !== "hotp" && typePath !== "steam") {
		return { ok: false, error: "invalid-type", raw };
	}

	const params = u.searchParams;
	const rawSecret = params.get("secret") ?? "";
	const secret = normalizeBase32(rawSecret);
	if (!secret) {
		return { ok: false, error: "missing-secret", raw };
	}

	// 从 label 里拆 issuer / account，与查询参数 issuer 合并（查询参数优先）
	const { issuer: labelIssuer, account } = splitLabel(u.pathname);
	const qIssuer = (params.get("issuer") ?? "").trim();
	const issuer = qIssuer || labelIssuer;

	// 类型最终判断：path=steam，或 path=totp 但 issuer=Steam
	let type: OtpauthMeta["type"] = typePath as OtpauthMeta["type"];
	if (typePath === "totp" && issuer.toLowerCase() === "steam") {
		type = "steam";
	}

	// 算法 / 位数 / 周期 / 计数器 —— 全部宽容解析，缺失走默认
	const algorithm = (params.get("algorithm") ?? "SHA1").toUpperCase();
	const digitsRaw = Number.parseInt(params.get("digits") ?? "", 10);
	const periodRaw = Number.parseInt(params.get("period") ?? "", 10);
	const counterRaw = Number.parseInt(params.get("counter") ?? "", 10);

	// Steam 强制 5 位；其它默认 6 位
	const digits = Number.isFinite(digitsRaw) ? digitsRaw : type === "steam" ? 5 : 6;
	// HOTP 没有 period 概念，置 0；TOTP/Steam 默认 30
	const period = type === "hotp" ? 0 : Number.isFinite(periodRaw) ? periodRaw : 30;
	const counter = type === "hotp" ? (Number.isFinite(counterRaw) ? counterRaw : 0) : 0;

	return {
		ok: true,
		raw: trimmed,
		meta: {
			type,
			secret,
			issuer,
			account,
			algorithm,
			digits,
			period,
			counter,
		},
	};
}

/**
 * 把 base32 密钥按 4 字符分组重排成可读形式：JBSWY3DPEHPK3PXP → JBSW Y3DP EHPK 3PXP
 *
 * 仅用于显示，不影响存储。
 */
export function formatBase32Groups(secret: string): string {
	return secret.replace(/(.{4})(?!$)/g, "$1 ");
}
