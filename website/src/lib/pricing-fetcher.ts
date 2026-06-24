// 从 zpass_cloud 公开套餐端点拉取定价数据
// ---------------------------------------------------------------------------
// 官网定价页不再把套餐写死，而是在 SSR 时调用后端 `GET /v1/plans/public`，
// 与 SaaS 运营平台（operator console）共用同一张 `plans` 表：运营在控制台改价、
// 改限额、上下架套餐，官网下次 SSR 取数即同步。
//
// 后端地址按环境区分（开发 vs 生产），通过环境变量 `ZPASS_API_BASE` 注入：
//   - 生产：https://zpass-app.zerx.dev/v1
//   - 开发：本地后端，默认 http://127.0.0.1:8080/v1（zpass_cloud BIND_ADDR=0.0.0.0:8080）
// 公开套餐端点 = `${ZPASS_API_BASE}/plans/public`。
//
// 拉取走模块级内存缓存（10min TTL），失败时降级使用内置 i18n 文案（buildFallback），
// 保证站点永远不会因为后端故障而无法渲染定价页 —— 与 release-fetcher 同一范式。

import type { Locale, SiteStrings, PriceTier } from "../i18n/strings";

// API base：优先环境变量，缺省指向生产网关。开发时设
// ZPASS_API_BASE=http://127.0.0.1:8080/v1 即可指向本地后端。
//
// 解析顺序：运行时 process.env（standalone Node server 部署/dev 的环境变量）
// > 构建期 import.meta.env > 生产默认值。SSR 在 Node 下运行，process.env 才是
// 部署时切换开发/生产后端的真正生效入口（import.meta.env 在 build 时即被静态求值）。
const RUNTIME_ENV: Record<string, string | undefined> =
	(globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env ?? {};
const API_BASE = (
	RUNTIME_ENV.ZPASS_API_BASE ??
	import.meta.env.ZPASS_API_BASE ??
	"https://zpass-app.zerx.dev/v1"
).replace(/\/+$/, "");

const PLANS_URL = `${API_BASE}/plans/public`;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10min：套餐变更后较快可见
const DEGRADED_TTL_MS = 60 * 1000; // 降级态 1min，便于后端恢复后尽快重试
const FETCH_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// 后端 wire 类型（GET /v1/plans/public 的 plans[] 元素）。
// 与 zpass_cloud operator_console 的 Plan 子集一致（仅展示安全字段）。
// ---------------------------------------------------------------------------
export interface PublicPlan {
	name: string;
	display_name: string;
	description: string;
	price_monthly_cents: number;
	price_yearly_cents: number;
	currency: string;
	billing_mode: "per_seat" | "flat";
	max_members: number | null;
	max_vaults: number | null;
	max_items: number | null;
	max_guests: number | null;
	storage_quota_mb: number | null;
	trial_days: number;
	features: Record<string, unknown>;
	is_default: boolean;
	sort_order: number;
}

interface PublicPlansResponse {
	plans: PublicPlan[];
}

/** 映射后产出的定价档：在 PriceTier 基础上补充 featured / contact 渲染标记。 */
export interface PricingTier extends PriceTier {
	/** 套餐机器名（plans.name），用于 data 属性 / 调试。 */
	plan: string;
	/** 高亮卡片（默认套餐之外、价格居中的推荐档）。 */
	featured: boolean;
	/** 联系销售（企业定制：flat 计费且月价为 0）。 */
	contact: boolean;
}

interface CacheEntry {
	tiers: PricingTier[];
	expiresAt: number;
	degraded: boolean;
}

// 按 locale 分别缓存（文案随语言不同）。
const cache = new Map<Locale, CacheEntry>();
let inflight: Promise<PublicPlan[]> | null = null;

// ---------------------------------------------------------------------------
// 文案映射：把后端的限额数字 / 功能标志翻成营销 bullets（中英双语）。
// 后端 features 为布尔功能标志（sso / audit_log / advanced_mfa / scim /
// family_sharing / dedicated_support / custom_contract / ...）。
// ---------------------------------------------------------------------------
type L10n = { en: string; zh: string };

const T = (en: string, zh: string): L10n => ({ en, zh });

const FEATURE_LABELS: Record<string, L10n> = {
	sso: T("SSO (SAML, OIDC)", "SSO（SAML、OIDC）"),
	scim: T("SCIM provisioning", "SCIM 自动配置"),
	audit_log: T("Audit log export", "审计日志导出"),
	advanced_mfa: T("Advanced MFA controls", "高级多因子管控"),
	family_sharing: T("Shared family folders", "家庭共享文件夹"),
	dedicated_support: T("Dedicated support", "专属支持"),
	custom_contract: T("Custom contract & SLA", "定制合同与 SLA"),
};

function pick(l: L10n, locale: Locale): string {
	return locale === "zh" ? l.zh : l.en;
}

// ---------------------------------------------------------------------------
// 运营可编辑的营销文案覆盖（features.marketing）。
//
// 运营在 console「功能特性 (JSON)」里写入 marketing 段即可自由定制定价卡片，
// 无需改前端。任一字段缺失则回退到由限额 / 功能标志派生的默认文案：
//
//   "marketing": {
//     "bullets":  { "zh": ["..."], "en": ["..."] },  // 覆盖整组卖点
//     "unit":     { "zh": "/月 · 托管同步", "en": "/month" },
//     "cta":      { "zh": "了解发布", "en": "Get notified" },
//     "featured": true,   // 强制高亮该档（覆盖自动选档）
//     "contact":  true    // 渲染为「联系我们」商务弹窗按钮
//   }
//
// 双语字段也接受单字符串（视作中英共用），数组 bullets 也接受字符串[]（共用）。
// ---------------------------------------------------------------------------
interface MarketingOverride {
	bullets?: string[];
	unit?: string;
	cta?: string;
	featured?: boolean;
	contact?: boolean;
}

/** 从 bilingual 值（{zh,en} | string）按 locale 取字符串；非法值返回 undefined。 */
function localized(value: unknown, locale: Locale): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const v = (value as Record<string, unknown>)[locale];
		if (typeof v === "string") return v;
	}
	return undefined;
}

/** 从 bilingual 数组值（{zh,en}:string[] | string[]）按 locale 取数组。 */
function localizedArray(value: unknown, locale: Locale): string[] | undefined {
	const arr = Array.isArray(value)
		? value
		: value && typeof value === "object"
			? (value as Record<string, unknown>)[locale]
			: undefined;
	if (Array.isArray(arr)) {
		const strs = arr.filter((x): x is string => typeof x === "string");
		return strs.length > 0 ? strs : undefined;
	}
	return undefined;
}

/** 解析 features.marketing，产出当前 locale 的覆盖项（缺失字段为 undefined）。 */
function parseMarketing(p: PublicPlan, locale: Locale): MarketingOverride {
	const m = p.features?.["marketing"];
	if (!m || typeof m !== "object") return {};
	const obj = m as Record<string, unknown>;
	return {
		bullets: localizedArray(obj["bullets"], locale),
		unit: localized(obj["unit"], locale),
		cta: localized(obj["cta"], locale),
		featured: typeof obj["featured"] === "boolean" ? (obj["featured"] as boolean) : undefined,
		contact: typeof obj["contact"] === "boolean" ? (obj["contact"] as boolean) : undefined,
	};
}

function fmtPrice(cents: number, currency: string): string {
	// 货币符号按 currency 统一映射，不随站点语言变化：套餐价格是单一事实
	// （后端 plans 表只存一份），中英文站点展示同一数字与符号，避免歧义。
	const sym = currency === "CNY" ? "¥" : currency === "EUR" ? "€" : "$";
	if (cents === 0) {
		return `${sym}0`;
	}
	const amount = cents / 100;
	const num = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
	return `${sym}${num}`;
}

function fmtUnit(p: PublicPlan, locale: Locale): string {
	const zh = locale === "zh";
	if (p.price_monthly_cents === 0 && p.billing_mode === "flat") {
		return zh ? "联系销售获取报价" : "contact sales for pricing";
	}
	if (p.price_monthly_cents === 0) {
		return zh ? "面向个人用户" : "for individuals";
	}
	if (p.billing_mode === "per_seat") {
		return zh ? "/用户/月" : "/user/month";
	}
	if (p.max_members && p.max_members > 1) {
		return zh
			? `/月 · 至多 ${p.max_members} 人`
			: `/month · up to ${p.max_members} people`;
	}
	return zh ? "/月" : "/month";
}

function buildBullets(p: PublicPlan, locale: Locale): string[] {
	const zh = locale === "zh";
	const out: string[] = [];

	// 限额维度（null = 不限）。
	if (p.max_members != null) {
		out.push(
			zh
				? `至多 ${p.max_members} 名成员`
				: `Up to ${p.max_members} ${p.max_members === 1 ? "member" : "members"}`,
		);
	} else if (p.billing_mode === "per_seat") {
		out.push(zh ? "成员数量不限" : "Unlimited members");
	}

	if (p.max_items == null) {
		out.push(zh ? "无限条目" : "Unlimited items");
	} else {
		out.push(zh ? `${p.max_items} 条条目` : `${p.max_items} items`);
	}

	if (p.max_vaults == null) {
		out.push(zh ? "无限保险箱" : "Unlimited vaults");
	}

	if (p.storage_quota_mb != null) {
		const gb = p.storage_quota_mb / 1024;
		const label =
			gb >= 1
				? `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
				: `${p.storage_quota_mb} MB`;
		out.push(zh ? `${label} 加密存储` : `${label} encrypted storage`);
	}

	if (p.trial_days > 0) {
		out.push(zh ? `${p.trial_days} 天免费试用` : `${p.trial_days}-day free trial`);
	}

	// 功能标志（仅取布尔 true 的）。
	for (const [key, label] of Object.entries(FEATURE_LABELS)) {
		if (p.features?.[key] === true) {
			out.push(pick(label, locale));
		}
	}

	return out;
}

function ctaFor(p: PublicPlan, locale: Locale): {
	cta: string;
	contact: boolean;
} {
	const zh = locale === "zh";
	// 企业定制（flat + 0 价）走联系销售。
	if (p.billing_mode === "flat" && p.price_monthly_cents === 0) {
		return { cta: zh ? "联系我们" : "Talk to us", contact: true };
	}
	return { cta: zh ? "了解发布" : "Get notified", contact: false };
}

function toTier(p: PublicPlan, locale: Locale): PricingTier {
	const mk = parseMarketing(p, locale);
	const { cta, contact } = ctaFor(p, locale);
	return {
		plan: p.name,
		name: p.display_name,
		price: fmtPrice(p.price_monthly_cents, p.currency),
		// 运营覆盖优先，缺失回退派生文案。
		unit: mk.unit ?? fmtUnit(p, locale),
		bullets: mk.bullets ?? buildBullets(p, locale),
		cta: mk.cta ?? cta,
		featured: mk.featured ?? false, // false/缺失时由 markFeatured 兜底
		contact: mk.contact ?? contact,
	};
}

/**
 * 高亮居中的推荐档：月价 > 0（即付费）的第一档（按 sort_order）。
 * 基于原始 plan 数据（携 price_monthly_cents），避免靠展示字符串猜价格。
 * 运营若在 features.marketing.featured 显式指定，则跳过自动选档。
 * `tiers` 与 `sortedPlans` 按相同顺序一一对应。
 */
function markFeatured(tiers: PricingTier[], sortedPlans: PublicPlan[]): void {
	// 运营已通过 features.marketing.featured 显式指定，则不自动选档。
	if (tiers.some((t) => t.featured)) return;
	const idx = sortedPlans.findIndex((p) => p.price_monthly_cents > 0);
	if (idx >= 0 && tiers[idx]) tiers[idx].featured = true;
}

// ---------------------------------------------------------------------------
// 降级：后端不可达时用内置 i18n 文案，保持页面可渲染。
// ---------------------------------------------------------------------------
function buildFallback(t: SiteStrings): PricingTier[] {
	const tiers: PricingTier[] = [
		{ ...t.pricing_solo, plan: "free", featured: false, contact: false },
		{ ...t.pricing_personal, plan: "personal", featured: true, contact: false },
		{ ...t.pricing_family, plan: "families", featured: false, contact: false },
		{ ...t.pricing_team, plan: "teams", featured: false, contact: true },
	];
	return tiers;
}

async function fetchPlans(): Promise<PublicPlan[]> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(PLANS_URL, {
			signal: ctrl.signal,
			headers: { accept: "application/json" },
		});
		if (!res.ok) {
			throw new Error(`plans endpoint returned ${res.status}`);
		}
		const data = (await res.json()) as PublicPlansResponse;
		if (!Array.isArray(data.plans)) {
			throw new Error("plans endpoint payload missing plans[]");
		}
		return data.plans;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 获取定价档 —— 命中缓存（10min 内）直接返回，否则触发一次拉取并映射成
 * 当前 locale 的 PricingTier[]；拉取失败时降级使用内置 i18n 文案。
 *
 * @param locale 目标语言
 * @param t      当前 locale 的站点文案（降级时使用）
 */
export async function getPricingTiers(
	locale: Locale,
	t: SiteStrings,
): Promise<PricingTier[]> {
	const now = Date.now();
	const cached = cache.get(locale);
	if (cached && cached.expiresAt > now) {
		return cached.tiers;
	}

	let plans: PublicPlan[];
	try {
		if (!inflight) {
			inflight = fetchPlans();
		}
		plans = await inflight;
	} catch (err) {
		console.warn(
			"[pricing-fetcher] failed to fetch public plans, using fallback:",
			err instanceof Error ? err.message : err,
		);
		const tiers = buildFallback(t);
		cache.set(locale, {
			tiers,
			expiresAt: now + DEGRADED_TTL_MS,
			degraded: true,
		});
		return tiers;
	} finally {
		inflight = null;
	}

	const sortedPlans = plans.slice().sort((a, b) => a.sort_order - b.sort_order);
	const tiers = sortedPlans.map((p) => toTier(p, locale));
	markFeatured(tiers, sortedPlans);

	cache.set(locale, { tiers, expiresAt: now + CACHE_TTL_MS, degraded: false });
	return tiers;
}
