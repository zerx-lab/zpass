/**
 * Bitwarden → ZPass 导入器（纯函数）
 *
 * 设计原则：
 * 1. 以 Bitwarden 官方 JSON 导出格式（unencrypted）为主导入源；尽量完整保留语义。
 * 2. ZPass 内部模型与 FIDO Alliance Credential Exchange Format (CXF) 1.0
 *    概念对齐：string-tag type / 字段袋 fields / 多类型 _customFields。
 * 3. 找不到一一对应的字段（reprompt / passwordHistory / fido2Credentials /
 *    uri match 等）以 _customFields 形式保留，避免信息丢失，方便日后导出
 *    CXF 时再升级。
 * 4. importer 永远纯函数：输入 JSON 文本，输出 VaultItemInput[] + 统计 / 警告。
 *
 * 字段命名约定（与 VaultPage 中 FIELD_DEFS 对齐，**字段名错位会导致详情页
 * 不显示**）：
 *
 *   - 自定义字段保留键：`_customFields`（CUSTOM_FIELDS_KEY）。**注意带下划线**，
 *     不是 `customFields`。详情页 parseCustomFields() 只识别这个键。
 *   - login:    username / password / url / totp / notes
 *   - card:     cardholder / number / expiry / cvv / notes
 *               （brand / pin 不存在 → 进 _customFields）
 *   - note:     notes（必填）
 *   - identity: fullname / email / phone / notes
 *               （title / first / last / address / passport / ssn 等 → _customFields）
 *   - ssh:      username / private_key / passphrase / host / notes
 *               （publicKey / fingerprint / keyAlgorithm 等 → _customFields）
 *
 * 不依赖任何 React / DOM API，可独立单测。
 */

import type { VaultItemInput, VaultItemType } from "@/lib/vault-api";

/** ZPass 约定保留键 —— 与 VaultPage CUSTOM_FIELDS_KEY 同步，不要改 */
const CUSTOM_FIELDS_KEY = "_customFields";

// ── Bitwarden 枚举 ──────────────────────────────────────────────

/** Bitwarden CipherType 整数枚举 → ZPass string-tag */
const BW_TYPE: Record<number, VaultItemType> = {
	1: "login",
	2: "note",
	3: "card",
	4: "identity",
	5: "ssh", // Bitwarden 2024+ 引入的 SshKey
};

/** fields[].type: 0=Text, 1=Hidden, 2=Boolean, 3=Linked */
const BW_FIELD_TYPE: Record<number, "text" | "hidden" | "boolean" | "linked"> =
	{
		0: "text",
		1: "hidden",
		2: "boolean",
		3: "linked",
	};

/** uris[].match 0..5（Bitwarden URI Match Detection） */
const BW_URI_MATCH: Record<number, string> = {
	0: "domain",
	1: "host",
	2: "starts-with",
	3: "exact",
	4: "regex",
	5: "never",
};

// ── 类型定义 ────────────────────────────────────────────────────

/** Bitwarden 导出文件顶层结构（部分字段，按需读取） */
interface BitwardenExport {
	encrypted?: boolean;
	folders?: Array<{ id: string; name: string }>;
	items?: BitwardenItem[];
}

interface BitwardenItem {
	id?: string;
	type?: number;
	name?: string;
	notes?: string | null;
	favorite?: boolean;
	reprompt?: number;
	folderId?: string | null;
	revisionDate?: string;
	creationDate?: string;
	fields?: Array<{ name?: string; value?: unknown; type?: number }>;
	passwordHistory?: Array<{ lastUsedDate?: string; password?: string }>;
	login?: BitwardenLogin;
	secureNote?: { type?: number };
	card?: BitwardenCard;
	identity?: BitwardenIdentity;
	sshKey?: BitwardenSshKey;
}

interface BitwardenLogin {
	uris?: Array<{ uri?: string; match?: number | null }>;
	username?: string | null;
	password?: string | null;
	totp?: string | null;
	fido2Credentials?: BitwardenFido2[];
	passwordRevisionDate?: string;
}

interface BitwardenFido2 {
	credentialId?: string;
	keyType?: string;
	keyAlgorithm?: string;
	keyCurve?: string;
	keyValue?: string;
	rpId?: string;
	rpName?: string;
	userHandle?: string;
	userName?: string;
	userDisplayName?: string;
	counter?: string;
	discoverable?: string;
	creationDate?: string;
}

interface BitwardenCard {
	cardholderName?: string | null;
	brand?: string | null;
	number?: string | null;
	expMonth?: string | null;
	expYear?: string | null;
	code?: string | null;
}

interface BitwardenIdentity {
	title?: string | null;
	firstName?: string | null;
	middleName?: string | null;
	lastName?: string | null;
	address1?: string | null;
	address2?: string | null;
	address3?: string | null;
	city?: string | null;
	state?: string | null;
	postalCode?: string | null;
	country?: string | null;
	company?: string | null;
	email?: string | null;
	phone?: string | null;
	ssn?: string | null;
	username?: string | null;
	passportNumber?: string | null;
	licenseNumber?: string | null;
}

interface BitwardenSshKey {
	keyAlgorithm?: string;
	keyType?: string;
	publicKey?: string;
	privateKey?: string;
	keyFingerprint?: string;
}

/** Bitwarden 自定义字段（落入 ZPass fields.customFields[] 中） */
export interface CustomField {
	id: string;
	type: "text" | "hidden" | "boolean" | "linked";
	name: string;
	value: string | boolean;
}

/** 导入结果 */
export interface ImportResult {
	ok: true;
	format: "bitwarden";
	/** 已转换为 ZPass VaultItemInput 的条目 */
	items: VaultItemInput[];
	/** 类型分布统计 */
	stats: Record<VaultItemType, number>;
	/** 被跳过的条目（带原因） */
	skipped: Array<{ name: string; reason: string }>;
	/** 原始文件 items 总数 */
	total: number;
}

/** 导入失败原因 */
export type ImportError =
	| { ok: false; reason: "parse_error"; message?: string }
	| { ok: false; reason: "wrong_format" }
	| { ok: false; reason: "encrypted" };

// ── 工具 ────────────────────────────────────────────────────────

function safeStr(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "string") return v;
	try {
		return String(v);
	} catch {
		return "";
	}
}

let _seq = 0;
function newCfId(itemSeed: string): string {
	_seq += 1;
	return `cf-${itemSeed}-${_seq}`;
}

/**
 * 取 uris 数组的第 1 个 URI，**保留完整原始值**（协议 / path / query / 端口）。
 *
 * 为什么不再提取 host：
 *   - 自动填充的来源/origin 匹配在 Go 侧 urlMatchesOrigin() 已统一按 Hostname()
 *     归一，详情页 firstDisplayURL() 显示时也只取 Hostname()，所以存完整 URI 对
 *     匹配/展示零回归。
 *   - 反之提取 host 会丢掉 androidapp:// 这类自定义协议前缀（new URL 对
 *     `androidapp://com.qiyi.video` 能解析出 host=com.qiyi.video，旧实现因此
 *     只剩裸 host、协议语义不可恢复）以及深链 path/query/端口。
 */
function pickPrimaryUri(uris?: BitwardenLogin["uris"]): string {
	if (!Array.isArray(uris) || uris.length === 0) return "";
	return safeStr(uris[0]?.uri).trim();
}

// ── fields[] → customFields ─────────────────────────────────────

function mapBwFields(
	bwFields: BitwardenItem["fields"],
	seed: string,
): CustomField[] {
	if (!Array.isArray(bwFields)) return [];
	return bwFields
		.filter((f) => f && (f.name || f.value != null || f.type === 2))
		.map((f, idx) => {
			const t = BW_FIELD_TYPE[f.type ?? 0] ?? "text";
			let value: string | boolean;
			if (t === "boolean") {
				value = f.value === true || f.value === "true";
			} else {
				value = safeStr(f.value);
			}
			return {
				id: `cf-${seed}-${idx + 1}`,
				type: t,
				name: safeStr(f.name) || `Field ${idx + 1}`,
				value,
			};
		});
}

function mapAdditionalUris(
	uris: BitwardenLogin["uris"],
	seed: string,
): CustomField[] {
	if (!Array.isArray(uris) || uris.length <= 1) return [];
	return uris.slice(1).map((u, i) => ({
		id: `cf-${seed}-uri-${i + 1}`,
		type: "text" as const,
		name: `URI ${i + 2}`,
		value: safeStr(u?.uri),
	}));
}

/** passkey 条目展示名：`<rpName|rpId> (<account>)` */
function passkeyDisplayName(c: BitwardenFido2): string {
	const label = safeStr(c.rpName) || safeStr(c.rpId) || "Passkey";
	const account = safeStr(c.userDisplayName) || safeStr(c.userName);
	return account ? `${label} (${account})` : label;
}

/**
 * 把 Bitwarden login.fido2Credentials[] 转成 ZPass 原生 passkey 条目。
 *
 * 关键点（详见 desktop/internal/services/passkeyservice.go）：
 *   - credentialId 是 Bitwarden 的 GUID 字符串，rawId 是它的 16 原始字节；
 *     这里原样透传，Go 侧 completeImportedPasskey 归一化为 base64url。
 *   - keyValue 是 PKCS#8 私钥（base64url）；Go 侧据此反推 publicKeyCose/Spki。
 *   - userHandle 已是 base64url，作为 userId 透传。
 * 字段名（rpId / credentialId / privateKeyPkcs8 / userId / signCount /
 * residentKey）必须与 passkeyservice 的读取约定一致。
 */
function mapPasskeys(
	login: BitwardenLogin,
	skipped: Array<{ name: string; reason: string }>,
): VaultItemInput[] {
	const creds = login.fido2Credentials;
	if (!Array.isArray(creds) || creds.length === 0) return [];
	const out: VaultItemInput[] = [];
	for (const c of creds) {
		const rpId = safeStr(c.rpId);
		const keyValue = safeStr(c.keyValue);
		const credentialId = safeStr(c.credentialId);
		// 三者缺一不可用：跳过并计入 skipped，不静默丢弃
		if (!rpId || !keyValue || !credentialId) {
			skipped.push({
				name: passkeyDisplayName(c),
				reason: "passkey_incomplete",
			});
			continue;
		}
		const fields: Record<string, unknown> = {
			rpId,
			credentialId, // GUID；Go 侧归一化为 base64url
			privateKeyPkcs8: keyValue, // PKCS#8 base64url；Go 侧派生公钥
			signCount: Number(safeStr(c.counter)) || 0,
			residentKey: safeStr(c.discoverable) === "true",
		};
		setIfNonEmpty(fields, "rpName", safeStr(c.rpName));
		setIfNonEmpty(fields, "userName", safeStr(c.userName));
		setIfNonEmpty(fields, "userDisplayName", safeStr(c.userDisplayName));
		setIfNonEmpty(fields, "userId", safeStr(c.userHandle));
		out.push({
			type: "passkey",
			name: passkeyDisplayName(c),
			fields,
		});
	}
	return out;
}

function mapHistory(
	history: BitwardenItem["passwordHistory"],
	seed: string,
): CustomField[] {
	if (!Array.isArray(history) || history.length === 0) return [];
	const value = history
		.map((h) => `${h.lastUsedDate || ""}\t${safeStr(h.password)}`)
		.join("\n");
	return [
		{
			id: `cf-${seed}-pwhist`,
			type: "hidden",
			name: "Password history",
			value,
		},
	];
}

function mapMetaFlags(it: BitwardenItem, seed: string): CustomField[] {
	const out: CustomField[] = [];
	if (it.reprompt === 1) {
		out.push({
			id: `cf-${seed}-reprompt`,
			type: "boolean",
			name: "Master password reprompt",
			value: true,
		});
	}
	return out;
}

function mapUriMatchHint(
	uris: BitwardenLogin["uris"],
	seed: string,
): CustomField[] {
	if (!Array.isArray(uris)) return [];
	const annotated = uris.filter((u) => u && u.match != null);
	if (annotated.length === 0) return [];
	return [
		{
			id: `cf-${seed}-urimatch`,
			type: "text",
			name: "URI match (Bitwarden)",
			value: annotated
				.map(
					(u) =>
						`${u.uri} → ${BW_URI_MATCH[u.match ?? -1] ?? `match=${u.match}`}`,
				)
				.join("\n"),
		},
	];
}

// ── 各 type 映射 ────────────────────────────────────────────────
//
// 公共原则：
//   - 只写非空原生字段，避免详情页堆出一排空 label
//   - ZPass 没有的语义字段 → 进 _customFields，**不丢任何信息**
//   - login.favorite → fields.fav (boolean)，与 ZPass 收藏过滤器对齐
//   - 自定义字段保留键固定为 "_customFields"（CUSTOM_FIELDS_KEY）

/** 把 (key,value) 写入 fields，仅当 value 非空字符串 */
function setIfNonEmpty(
	fields: Record<string, unknown>,
	key: string,
	value: string,
): void {
	if (value) fields[key] = value;
}

/** 把无法直接落入原生字段的语义键以 customField 形式追加保留 */
function pushExtra(
	cf: CustomField[],
	seed: string,
	name: string,
	value: string | null | undefined,
	type: CustomField["type"] = "text",
): void {
	if (value == null || value === "") return;
	cf.push({
		id: newCfId(`${seed}-${name}`),
		type,
		name,
		value: safeStr(value),
	});
}

function mapLogin(it: BitwardenItem, seed: string): VaultItemInput {
	const login = it.login ?? {};
	// fido2Credentials 不再塞进 _customFields：改由 convertBitwarden 产出
	// 独立的原生 passkey 条目（mapPasskeys），使其可被认证器真正使用。
	const cf: CustomField[] = [
		...mapBwFields(it.fields, seed),
		...mapAdditionalUris(login.uris, seed),
		...mapHistory(it.passwordHistory, seed),
		...mapMetaFlags(it, seed),
		...mapUriMatchHint(login.uris, seed),
	];
	const fields: Record<string, unknown> = {};
	setIfNonEmpty(fields, "username", safeStr(login.username));
	setIfNonEmpty(fields, "password", safeStr(login.password));
	setIfNonEmpty(fields, "url", pickPrimaryUri(login.uris));
	setIfNonEmpty(fields, "totp", safeStr(login.totp));
	setIfNonEmpty(fields, "notes", safeStr(it.notes));
	if (it.favorite) fields.fav = true;
	if (cf.length > 0) fields[CUSTOM_FIELDS_KEY] = cf;
	return {
		type: "login",
		name: safeStr(it.name) || "Untitled",
		fields,
	};
}

function mapNote(it: BitwardenItem, seed: string): VaultItemInput {
	const cf = [...mapBwFields(it.fields, seed), ...mapMetaFlags(it, seed)];
	const fields: Record<string, unknown> = {};
	// ZPass 的 note 类型用 "notes" 作为正文必填字段（参见 VaultPage FIELD_DEFS）
	setIfNonEmpty(fields, "notes", safeStr(it.notes));
	if (it.favorite) {
		pushExtra(cf, seed, "Favorite", "true", "boolean" as const);
	}
	if (cf.length > 0) fields[CUSTOM_FIELDS_KEY] = cf;
	return {
		type: "note",
		name: safeStr(it.name) || "Untitled note",
		fields,
	};
}

function mapCard(it: BitwardenItem, seed: string): VaultItemInput {
	const c = it.card ?? {};
	const cf = [...mapBwFields(it.fields, seed), ...mapMetaFlags(it, seed)];
	const expMonth = safeStr(c.expMonth);
	const expYear = safeStr(c.expYear);
	const expiry =
		expMonth || expYear
			? `${expMonth ? expMonth.padStart(2, "0") : "??"}/${expYear ? expYear.slice(-2) : "??"}`
			: "";
	const fields: Record<string, unknown> = {};
	setIfNonEmpty(fields, "cardholder", safeStr(c.cardholderName));
	setIfNonEmpty(fields, "number", safeStr(c.number));
	setIfNonEmpty(fields, "expiry", expiry); // ZPass 用 "expiry" 不是 "exp"
	setIfNonEmpty(fields, "cvv", safeStr(c.code));
	setIfNonEmpty(fields, "notes", safeStr(it.notes));
	// ZPass 没有 brand 原生字段 → 进 _customFields
	pushExtra(cf, seed, "Brand", c.brand);
	if (it.favorite) {
		pushExtra(cf, seed, "Favorite", "true", "boolean");
	}
	if (cf.length > 0) fields[CUSTOM_FIELDS_KEY] = cf;
	return {
		type: "card",
		name: safeStr(it.name) || "Card",
		fields,
	};
}

function mapIdentity(it: BitwardenItem, seed: string): VaultItemInput {
	const idn = it.identity ?? {};
	const cf = [...mapBwFields(it.fields, seed), ...mapMetaFlags(it, seed)];

	// ZPass identity 仅 4 个原生字段：fullname / email / phone / notes
	// firstName + middleName + lastName 合并成 fullname；其余全进 _customFields
	const fullnameParts = [idn.firstName, idn.middleName, idn.lastName]
		.filter((s) => s && safeStr(s).trim() !== "")
		.map((s) => safeStr(s).trim());
	const fullname = fullnameParts.join(" ");

	const fields: Record<string, unknown> = {};
	setIfNonEmpty(fields, "fullname", fullname);
	setIfNonEmpty(fields, "email", safeStr(idn.email));
	setIfNonEmpty(fields, "phone", safeStr(idn.phone));
	setIfNonEmpty(fields, "notes", safeStr(it.notes));

	// 把 ZPass 不支持的字段全保留为 customField，按 Bitwarden 字段名命名
	pushExtra(cf, seed, "Title", idn.title);
	// firstName/lastName 即使已合并到 fullname，也单独保留一份方便日后导出
	pushExtra(cf, seed, "First name", idn.firstName);
	pushExtra(cf, seed, "Middle name", idn.middleName);
	pushExtra(cf, seed, "Last name", idn.lastName);
	pushExtra(cf, seed, "Username", idn.username);
	pushExtra(cf, seed, "Company", idn.company);
	const addr = [
		idn.address1,
		idn.address2,
		idn.address3,
		idn.city,
		idn.state,
		idn.postalCode,
		idn.country,
	]
		.filter(Boolean)
		.join(", ");
	pushExtra(cf, seed, "Address", addr);
	pushExtra(cf, seed, "SSN", idn.ssn);
	pushExtra(cf, seed, "Passport number", idn.passportNumber);
	pushExtra(cf, seed, "License number", idn.licenseNumber);
	if (it.favorite) {
		pushExtra(cf, seed, "Favorite", "true", "boolean");
	}
	if (cf.length > 0) fields[CUSTOM_FIELDS_KEY] = cf;
	return {
		type: "identity",
		name: safeStr(it.name) || "Identity",
		fields,
	};
}

function mapSshKey(it: BitwardenItem, seed: string): VaultItemInput {
	const ssh = it.sshKey ?? {};
	const cf = [...mapBwFields(it.fields, seed), ...mapMetaFlags(it, seed)];
	const fields: Record<string, unknown> = {};
	// ZPass ssh 原生字段：username / private_key / passphrase / host / notes
	setIfNonEmpty(fields, "private_key", safeStr(ssh.privateKey));
	setIfNonEmpty(fields, "notes", safeStr(it.notes));
	// publicKey / fingerprint / keyAlgorithm 在 ZPass 无对应原生字段
	pushExtra(cf, seed, "Public key", ssh.publicKey);
	pushExtra(cf, seed, "Key fingerprint", ssh.keyFingerprint);
	pushExtra(
		cf,
		seed,
		"Key algorithm",
		safeStr(ssh.keyAlgorithm) || safeStr(ssh.keyType),
	);
	if (it.favorite) {
		pushExtra(cf, seed, "Favorite", "true", "boolean");
	}
	if (cf.length > 0) fields[CUSTOM_FIELDS_KEY] = cf;
	return {
		type: "ssh",
		name: safeStr(it.name) || "SSH key",
		fields,
	};
}

// ── 入口 ────────────────────────────────────────────────────────

export function detectFormat(obj: unknown): "bitwarden" | "cxf" | "unknown" {
	if (!obj || typeof obj !== "object") return "unknown";
	const o = obj as Record<string, unknown>;
	if (Array.isArray(o.items) && ("encrypted" in o || "folders" in o)) {
		return "bitwarden";
	}
	// 预留：CXF 顶层有 header.exporterRpId / accounts
	if (o.accounts || (o.header as { exporterRpId?: unknown })?.exporterRpId) {
		return "cxf";
	}
	return "unknown";
}

/** 把 Bitwarden 文件文本转成 ZPass VaultItemInput[] + 统计 */
export function importBitwardenText(text: string): ImportResult | ImportError {
	let obj: unknown;
	try {
		obj = JSON.parse(text);
	} catch (e) {
		return {
			ok: false,
			reason: "parse_error",
			message: e instanceof Error ? e.message : String(e),
		};
	}
	if (detectFormat(obj) !== "bitwarden") {
		return { ok: false, reason: "wrong_format" };
	}
	const data = obj as BitwardenExport;
	if (data.encrypted === true) {
		return { ok: false, reason: "encrypted" };
	}
	return convertBitwarden(data);
}

function convertBitwarden(obj: BitwardenExport): ImportResult {
	const items = Array.isArray(obj?.items) ? obj.items : [];
	const folders = Array.isArray(obj?.folders) ? obj.folders : [];
	const folderMap = new Map(folders.map((f) => [f.id, safeStr(f.name)]));

	const out: VaultItemInput[] = [];
	const skipped: Array<{ name: string; reason: string }> = [];
	const stats: Record<VaultItemType, number> = {
		login: 0,
		card: 0,
		note: 0,
		identity: 0,
		ssh: 0,
		passkey: 0,
		totp: 0,
	};

	let counter = 0;
	for (const it of items) {
		counter += 1;
		if (!it || typeof it !== "object") continue;
		const ztype = BW_TYPE[it.type ?? 0];
		if (!ztype) {
			skipped.push({
				name: safeStr(it.name) || "(unnamed)",
				reason: "unsupported_type",
			});
			continue;
		}
		const seed = `bw${counter}`;
		let mapped: VaultItemInput | null = null;
		try {
			if (ztype === "login") mapped = mapLogin(it, seed);
			else if (ztype === "note") mapped = mapNote(it, seed);
			else if (ztype === "card") mapped = mapCard(it, seed);
			else if (ztype === "identity") mapped = mapIdentity(it, seed);
			else if (ztype === "ssh") mapped = mapSshKey(it, seed);
		} catch {
			skipped.push({
				name: safeStr(it.name) || "(unnamed)",
				reason: "map_error",
			});
			continue;
		}
		if (!mapped) {
			skipped.push({
				name: safeStr(it.name) || "(unnamed)",
				reason: "map_error",
			});
			continue;
		}
		// folder 名（如果 Bitwarden 个人金库提供 folderId）—— ZPass 当前没有
		// folder 概念，作为 customField 保留方便用户后续整理。
		if (it.folderId && folderMap.has(it.folderId)) {
			const folderName = folderMap.get(it.folderId);
			if (folderName) {
				const fields = mapped.fields as Record<string, unknown>;
				const existing = Array.isArray(fields[CUSTOM_FIELDS_KEY])
					? (fields[CUSTOM_FIELDS_KEY] as CustomField[])
					: [];
				existing.push({
					id: newCfId(`${seed}-folder`),
					type: "text",
					name: "Folder",
					value: folderName,
				});
				fields[CUSTOM_FIELDS_KEY] = existing;
			}
		}
		out.push(mapped);
		stats[ztype] = (stats[ztype] || 0) + 1;

		// login 条目若带 passkey，额外产出独立的原生 passkey 条目。
		// 与 Bitwarden 数据结构一致：login（用户名/网址）+ passkey 并存。
		if (ztype === "login" && it.login) {
			const passkeys = mapPasskeys(it.login, skipped);
			for (const pk of passkeys) out.push(pk);
			stats.passkey += passkeys.length;
		}
	}

	return {
		ok: true,
		format: "bitwarden",
		items: out,
		stats,
		skipped,
		total: items.length,
	};
}

/**
 * 名称去重（用于 skip-duplicates 策略）。
 *
 * 去重键带上 type 维度（`type\0name`），避免跨类型同名误杀 —— 真实数据里
 * 存在 note 与 login 同名（如 "anytype"），它们本是不同条目，按纯 name 去重会
 * 多丢一条。\0 作分隔符是因为它不可能出现在 type/name 文本里，不会拼接歧义。
 * 同类型真实同名（如 2 个 Microsoft passkey）仍按预期保留去重。
 */
export function dedupeByName<
	T extends { name: string; type: string },
	U extends { name: string; type: string },
>(existing: T[], incoming: U[]): { kept: U[]; dropped: U[] } {
	const keyOf = (i: { name?: string; type?: string }) =>
		`${i.type ?? ""}\0${(i.name || "").toLowerCase()}`;
	const have = new Set((existing || []).map(keyOf));
	const kept: U[] = [];
	const dropped: U[] = [];
	for (const it of incoming) {
		const key = keyOf(it);
		if (have.has(key)) {
			dropped.push(it);
		} else {
			kept.push(it);
			have.add(key);
		}
	}
	return { kept, dropped };
}
