// Bitwarden → ZPass importer
//
// 设计原则：
// 1. 以 Bitwarden 官方 JSON 格式（unencrypted）为主导入源；尽量完整保留语义。
// 2. ZPass 内部模型与 FIDO Alliance Credential Exchange Format (CXF) 1.0 概念对齐：
//      - Bitwarden type 整数枚举 → ZPass string-tag type
//      - Bitwarden fields[].type 整数枚举 → ZPass customFields[].type 字符串
// 3. 找不到一一对应的字段（reprompt / passwordHistory / fido2Credentials / uri match
//    等）以 customFields 形式保留，避免信息丢失，方便日后导出 CXF 时再升级。
// 4. importer 永远纯函数：输入 JSON 字符串/对象，输出 ZPass items 数组 + 统计 / 警告。

const BW_TYPE = {
	1: "login",
	2: "note",
	3: "card",
	4: "identity",
	5: "ssh", // Bitwarden 2024+ 引入的 SshKey
};

// fields[].type 0=Text 1=Hidden 2=Boolean 3=Linked
const BW_FIELD_TYPE = {
	0: "text",
	1: "hidden",
	2: "boolean",
	3: "linked",
};

// uris[].match 0..5（Bitwarden URI Match Detection）
const BW_URI_MATCH = {
	0: "domain",
	1: "host",
	2: "starts-with",
	3: "exact",
	4: "regex",
	5: "never",
};

function safeStr(v) {
	if (v == null) return "";
	if (typeof v === "string") return v;
	try {
		return String(v);
	} catch {
		return "";
	}
}

function toMs(iso) {
	if (!iso) return Date.now();
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : Date.now();
}

// 简易 id：与 edit.jsx 的 cfid 同风格
let _seq = 0;
function newId(prefix) {
	_seq += 1;
	return `${prefix}-${Date.now().toString(36)}-${_seq}`;
}

// 提取 host 作为 url 字段显示
function pickPrimaryUri(uris) {
	if (!Array.isArray(uris) || uris.length === 0) return "";
	const u = uris[0]?.uri || "";
	try {
		const parsed = new URL(u);
		return parsed.host || u;
	} catch {
		// 非完整 URL（如 "www.x.com" 或 "androidapp://com.x"），原样返回
		return u;
	}
}

// 把 Bitwarden fields[] 转换为 ZPass customFields[]
function mapBwFields(bwFields, itemId) {
	if (!Array.isArray(bwFields)) return [];
	return bwFields
		.filter((f) => f && (f.name || f.value != null || f.type === 2))
		.map((f, idx) => {
			const t = BW_FIELD_TYPE[f.type] || "text";
			let value = f.value;
			if (t === "boolean") {
				value = value === true || value === "true";
			} else {
				value = safeStr(value);
			}
			return {
				id: `cf-${itemId}-${idx + 1}`,
				type: t,
				name: safeStr(f.name) || `Field ${idx + 1}`,
				value,
			};
		});
}

// 把 Bitwarden 的 uris 数组 → 1 条主 url + 其它作为 customFields(text) 保留
function mapAdditionalUris(uris, itemId, startIdx) {
	if (!Array.isArray(uris) || uris.length <= 1) return [];
	return uris.slice(1).map((u, i) => ({
		id: `cf-${itemId}-uri-${i + 1}`,
		type: "text",
		name: `URI ${i + 2}`,
		value: safeStr(u?.uri),
	}));
}

// 把 fido2Credentials 数组打包成 customFields，保留 passkey 关键信息
function mapFido2(fido2, itemId) {
	if (!Array.isArray(fido2) || fido2.length === 0) return [];
	return fido2.map((c, i) => ({
		id: `cf-${itemId}-passkey-${i + 1}`,
		type: "hidden",
		name: `Passkey · ${safeStr(c.rpName) || safeStr(c.rpId) || `#${i + 1}`}`,
		value: JSON.stringify(c, null, 2),
	}));
}

// 把 passwordHistory 摊平为单个 customField（按行）
function mapHistory(history, itemId) {
	if (!Array.isArray(history) || history.length === 0) return [];
	const value = history
		.map((h) => `${h.lastUsedDate || ""}\t${safeStr(h.password)}`)
		.join("\n");
	return [
		{
			id: `cf-${itemId}-pwhist`,
			type: "hidden",
			name: "Password history",
			value,
		},
	];
}

// 把 reprompt / favorite 等元信息也保留为 customField（boolean），可见
function mapMetaFlags(it, itemId) {
	const out = [];
	if (it.reprompt === 1) {
		out.push({
			id: `cf-${itemId}-reprompt`,
			type: "boolean",
			name: "Master password reprompt",
			value: true,
		});
	}
	return out;
}

function mapUriMatchHint(uris, itemId) {
	if (!Array.isArray(uris)) return [];
	const annotated = uris.filter((u) => u?.match != null && u.match !== undefined);
	if (annotated.length === 0) return [];
	return [
		{
			id: `cf-${itemId}-urimatch`,
			type: "text",
			name: "URI match (Bitwarden)",
			value: annotated
				.map((u) => `${u.uri} → ${BW_URI_MATCH[u.match] || `match=${u.match}`}`)
				.join("\n"),
		},
	];
}

// ── 各 type 的具体映射 ────────────────────────────────────────────────

function mapLogin(it, id) {
	const login = it.login || {};
	const cf = [
		...mapBwFields(it.fields, id),
		...mapAdditionalUris(login.uris, id),
		...mapFido2(login.fido2Credentials, id),
		...mapHistory(it.passwordHistory, id),
		...mapMetaFlags(it, id),
		...mapUriMatchHint(login.uris, id),
	];
	return {
		id,
		type: "login",
		name: safeStr(it.name) || "Untitled",
		username: safeStr(login.username),
		password: safeStr(login.password),
		url: pickPrimaryUri(login.uris),
		totp: safeStr(login.totp),
		notes: safeStr(it.notes),
		modified: toMs(it.revisionDate || it.creationDate),
		folder: it.favorite ? "Favorites" : "Imported",
		tags: ["bitwarden"],
		customFields: cf,
		travel: "safe",
	};
}

function mapNote(it, id) {
	const cf = [
		...mapBwFields(it.fields, id),
		...mapMetaFlags(it, id),
	];
	return {
		id,
		type: "note",
		name: safeStr(it.name) || "Untitled note",
		note: safeStr(it.notes),
		notes: "",
		modified: toMs(it.revisionDate || it.creationDate),
		folder: "Imported",
		tags: ["bitwarden"],
		customFields: cf,
		travel: "safe",
	};
}

function mapCard(it, id) {
	const c = it.card || {};
	const cf = [
		...mapBwFields(it.fields, id),
		...mapMetaFlags(it, id),
	];
	const exp =
		c.expMonth || c.expYear
			? `${safeStr(c.expMonth).padStart(2, "0") || "??"}/${(safeStr(c.expYear) || "").slice(-2) || "??"}`
			: "";
	return {
		id,
		type: "card",
		name: safeStr(it.name) || "Card",
		cardholder: safeStr(c.cardholderName),
		brand: safeStr(c.brand),
		number: safeStr(c.number),
		exp,
		cvv: safeStr(c.code),
		pin: "",
		notes: safeStr(it.notes),
		modified: toMs(it.revisionDate || it.creationDate),
		folder: "Imported",
		tags: ["bitwarden"],
		customFields: cf,
		travel: "safe",
	};
}

function mapIdentity(it, id) {
	const idn = it.identity || {};
	const addr = [idn.address1, idn.address2, idn.address3, idn.city, idn.state, idn.postalCode, idn.country]
		.filter(Boolean)
		.join(", ");
	const cf = [
		...mapBwFields(it.fields, id),
		...mapMetaFlags(it, id),
	];
	// CXF 把 identity 拆成 person-name + address，这里先合并落库，未支持的字段塞 customFields
	const extras = [
		["title", idn.title],
		["middleName", idn.middleName],
		["company", idn.company],
		["ssn", idn.ssn],
		["username", idn.username],
		["licenseNumber", idn.licenseNumber],
	];
	for (const [k, v] of extras) {
		if (v) {
			cf.push({
				id: `cf-${id}-${k}`,
				type: "text",
				name: k,
				value: safeStr(v),
			});
		}
	}
	return {
		id,
		type: "identity",
		name: safeStr(it.name) || "Identity",
		first: safeStr(idn.firstName),
		last: safeStr(idn.lastName),
		email: safeStr(idn.email),
		phone: safeStr(idn.phone),
		address: addr,
		dob: "",
		passport: safeStr(idn.passportNumber),
		notes: safeStr(it.notes),
		modified: toMs(it.revisionDate || it.creationDate),
		folder: "Imported",
		tags: ["bitwarden"],
		customFields: cf,
		travel: "safe",
	};
}

function mapSshKey(it, id) {
	const ssh = it.sshKey || {};
	const cf = [
		...mapBwFields(it.fields, id),
		...mapMetaFlags(it, id),
	];
	return {
		id,
		type: "ssh",
		name: safeStr(it.name) || "SSH key",
		username: "",
		keyType: safeStr(ssh.keyAlgorithm) || safeStr(ssh.keyType),
		fingerprint: safeStr(ssh.keyFingerprint),
		publicKey: safeStr(ssh.publicKey),
		apiKey: safeStr(ssh.privateKey),
		notes: safeStr(it.notes),
		modified: toMs(it.revisionDate || it.creationDate),
		folder: "Imported",
		tags: ["bitwarden"],
		customFields: cf,
		travel: "safe",
	};
}

// ── 入口 ─────────────────────────────────────────────────────────────

function detectFormat(obj) {
	if (!obj || typeof obj !== "object") return "unknown";
	if (Array.isArray(obj.items) && ("encrypted" in obj || "folders" in obj)) {
		return "bitwarden";
	}
	// 预留：CXF 顶层可能有 header.exporterRpId / accounts
	if (obj.accounts || obj.header?.exporterRpId) return "cxf";
	return "unknown";
}

function parseBitwardenText(text) {
	let obj;
	try {
		obj = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "parse_error", message: e.message };
	}
	if (detectFormat(obj) !== "bitwarden") {
		return { ok: false, reason: "wrong_format" };
	}
	if (obj.encrypted === true) {
		return { ok: false, reason: "encrypted" };
	}
	return { ok: true, data: obj };
}

function convertBitwarden(obj) {
	const items = Array.isArray(obj?.items) ? obj.items : [];
	const folders = Array.isArray(obj?.folders) ? obj.folders : [];
	const folderMap = new Map(folders.map((f) => [f.id, safeStr(f.name)]));

	const out = [];
	const skipped = [];
	const stats = { login: 0, note: 0, card: 0, identity: 0, ssh: 0 };

	for (const it of items) {
		if (!it || typeof it !== "object") continue;
		const ztype = BW_TYPE[it.type];
		if (!ztype) {
			skipped.push({ name: it.name || "(unnamed)", reason: "unsupported_type" });
			continue;
		}
		const id = newId("bw");
		let mapped;
		try {
			if (ztype === "login") mapped = mapLogin(it, id);
			else if (ztype === "note") mapped = mapNote(it, id);
			else if (ztype === "card") mapped = mapCard(it, id);
			else if (ztype === "identity") mapped = mapIdentity(it, id);
			else if (ztype === "ssh") mapped = mapSshKey(it, id);
		} catch (e) {
			skipped.push({ name: it.name || "(unnamed)", reason: "map_error" });
			continue;
		}
		if (!mapped) {
			skipped.push({ name: it.name || "(unnamed)", reason: "map_error" });
			continue;
		}
		// folder 名覆盖（如果 Bitwarden 个人金库提供了 folderId）
		if (it.folderId && folderMap.has(it.folderId)) {
			mapped.folder = folderMap.get(it.folderId);
		}
		// 收藏旗标用 tags 标识
		if (it.favorite && Array.isArray(mapped.tags)) {
			mapped.tags.push("favorite");
		}
		out.push(mapped);
		stats[ztype] = (stats[ztype] || 0) + 1;
	}

	return { items: out, stats, skipped };
}

// 顶层调用：传 file text，返回结果
function importBitwardenText(text) {
	const parsed = parseBitwardenText(text);
	if (!parsed.ok) return parsed;
	const { items, stats, skipped } = convertBitwarden(parsed.data);
	return {
		ok: true,
		format: "bitwarden",
		raw: parsed.data,
		items,
		stats,
		skipped,
		total: (parsed.data.items || []).length,
	};
}

// 名称去重（用于 skip-duplicates 策略）
function dedupeByName(existing, incoming) {
	const have = new Set((existing || []).map((i) => (i.name || "").toLowerCase()));
	const kept = [];
	const dropped = [];
	for (const it of incoming) {
		const key = (it.name || "").toLowerCase();
		if (have.has(key)) {
			dropped.push(it);
		} else {
			kept.push(it);
			have.add(key);
		}
	}
	return { kept, dropped };
}

window.ZPASS_IMPORTER = {
	importBitwardenText,
	detectFormat,
	dedupeByName,
	BW_TYPE,
	BW_FIELD_TYPE,
	BW_URI_MATCH,
};
