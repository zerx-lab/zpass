// Vault 主页 —— ZPass 桌面客户端
// ---------------------------------------------------------------------------
// 本次大改动（对照上一版）：
//
//   1. 键盘导航
//        - ↑/↓ 或 j/k：在列表内移动选中条目
//        - Enter：聚焦详情面板
//        - ⌘⇧C / Ctrl+Shift+C：复制选中条目密码
//        - ⌘B / Ctrl+B：复制选中条目用户名
//        - / ：聚焦搜索框
//
//   2. 编辑功能
//        详情面板新增"编辑"按钮，弹出 ItemDialog（mode="edit"）。
//        与新建共用同一个对话框组件，根据 mode 切换标题与提交逻辑。
//
//   3. 安全剪贴板
//        所有"复制密码"动作走 writeClipboardEphemeral —— 30 秒后自动清空，
//        并 push 一条 toast 给用户提示。其它字段（用户名 / URL）走普通
//        writeClipboard，但仍发 toast 反馈。
//
//   4. Topbar / ⌘N 触发新建
//        订阅 useUIStore.newItemRequest 计数器变化，外部召唤即打开对话框。
//
//   5. 多类型新建
//        新建对话框的 type 不再硬编码 login —— 用户可在顶部 segment 切换
//        login / card / note / identity / ssh 五种类型，每种类型
//        渲染对应字段集合。
//
//   6. 内联密码生成器
//        新建/编辑对话框的密码字段右侧多一个"⚡生成"按钮，点击后弹出
//        小型 popover 选择长度，立即生成填入。配合 PasswordStrength 组件
//        实时显示当前密码强度。
//
// ---------------------------------------------------------------------------
// 数据流
//
//   挂载时：useVaultStore.load() —— 从 Go 后端拉解密后的 ItemSummary 列表
//   选中条目变化时：fetchItem(selectedId) —— 拉完整 payload（含 fields）
//   新建：本地表单 → vaultApi.createItem → store.create 自动重 load
//   编辑：本地表单 → vaultApi.updateItem → store.update 清缓存 + 重 load
//   删除：vaultApi.deleteItem → store.remove 自动重 load
//   锁定：vaultApi.lock + useLockStore.lock → LockGuard 重定向到 /unlock
//
// 所有状态写都走 useVaultStore 的 action，不直接调 vaultApi —— 让 store
// 是单一事实来源（真实数据 + UI 临时态都在一处）。

import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import * as RadixDialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { clsx } from "clsx";
import {
	ChevronDown,
	ChevronRight,
	Copy,
	CreditCard,
	Eye,
	EyeOff,
	IdCard,
	KeyRound,
	Link2,
	Lock as LockIcon,
	LogIn as LogInIcon,
	Pencil,
	Plus,
	QrCode,
	Search,
	ShieldCheck,
	Sparkles,
	StickyNote,
	TerminalSquare,
	ToggleRight,
	Trash2,
	Type as TypeIcon,
	X,
} from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { PasswordStrength } from "@/components/PasswordStrength";
import { TotpField } from "@/features/vault/TotpField";
import { QrScannerPanel } from "@/features/vault/QrScannerPanel";
import type { OtpauthMeta } from "@/lib/parse-otpauth";
import {
	SshKeyGeneratorPanel,
	SshKeyModeTabs,
	type GeneratedKeyPair,
} from "@/features/sshagent/SshKeyGenerator";
import { generateSshKeyPair, supportedSshAlgos } from "@/lib/sshagent-api";
import { writeClipboard, writeClipboardEphemeral } from "@/lib/clipboard";
import { formatShortcut, KEY_SYMBOL, SHORTCUTS } from "@/lib/keys";
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from "@/lib/password";
import { vaultApi } from "@/lib/vault-api";
import { useLockStore } from "@/stores/lock";
import { useUIStore } from "@/stores/ui";
import {
	selectCurrentItem,
	useVaultStore,
	type VaultFilter,
	type VaultItemPayload,
	type VaultItemSummary,
	type VaultItemType,
} from "@/stores/vault";

// ---------------------------------------------------------------------------
// 工具：把 unix ms 时间戳格式化为相对/简短文本
// ---------------------------------------------------------------------------

/**
 * 简易相对时间：< 1 分 → "just now"；< 1 时 → "Xm"；< 1 天 → "Xh"；
 * 否则按本地化日期字符串。
 *
 * 不引入 dayjs / date-fns —— 列表里只用一处，自己写比拉一个 80 KB 库划算。
 * 文案直接用英文短缩写，与 1Password 列表的风格一致；中文用户也能看懂
 * "5m / 2h" 这种通用记法（避免再加一组 i18n key 复杂化）。
 */
function relativeTime(ts: number): string {
	if (!ts) return "";
	const diff = Date.now() - ts;
	const min = Math.floor(diff / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d}d`;
	return new Date(ts).toLocaleDateString();
}

/**
 * 从 fields 里安全取字符串字段
 *
 * fields 是 Record<string, unknown>，不能直接当 string 用。这个 helper
 * 做类型守卫 + 缺省回落。
 */
function fieldStr(
	fields: Record<string, unknown> | undefined,
	key: string,
): string {
	if (!fields) return "";
	const v = fields[key];
	return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// 类型相关辅助
// ---------------------------------------------------------------------------

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/** 类型 → 图标 映射；用于列表 / 详情头部 / 新建对话框 segment */
const TYPE_ICONS: Record<VaultItemType, IconComp> = {
	login: LogInIcon,
	card: CreditCard,
	note: StickyNote,
	identity: IdCard,
	ssh: TerminalSquare,
	passkey: KeyRound,
	// totp 条目用盾牌图标，与 Sidebar TOTP 入口保持一致
	totp: ShieldCheck,
};

/** Context menu "New" submenu order. Keep the most common account types first. */
const NEW_ITEM_TYPES: VaultItemType[] = [
	"login",
	"passkey",
	"card",
	"note",
	"identity",
	"ssh",
	"totp",
];

/**
 * 每种类型的字段集合 —— 字段顺序即对话框渲染顺序
 *
 * 字段定义：
 *   - key：写入 fields 的键名
 *   - labelKey：i18n key
 *   - kind：决定渲染样式（"text" 普通输入 / "secret" 带 reveal 的密码框 /
 *     "textarea" 多行 / "url" 普通文本但语义化）
 *   - required：是否必填
 *   - mono：是否用等宽字体（卡号 / 密钥用 mono 更易读）
 */
type FieldKind = "text" | "secret" | "textarea" | "url";

interface FieldDef {
	key: string;
	labelKey: string;
	placeholderKey?: string;
	kind: FieldKind;
	required?: boolean;
	mono?: boolean;
}

const FIELDS_BY_TYPE: Record<VaultItemType, FieldDef[]> = {
	login: [
		{
			key: "username",
			labelKey: "newlogin_username",
			placeholderKey: "newlogin_username_placeholder",
			kind: "text",
		},
		// 密码字段从 required 改为可选 ——
		//
		// 真实场景里 login 条目并不一定都有密码：
		//   - 仅 SSO / 一键扫码登录的账户（GitHub OAuth、微信扫码等）
		//   - 仅 passkey / WebAuthn 登录的账户
		//   - 用户把账户的密码托管在别处、本条目只用来记 username + TOTP
		//
		// 改成可选后，name 是唯一硬性必填字段（在 onSubmit 顶层单独校验），
		// 其它字段都按"有就存、没有就空"对待。Bitwarden / 1Password 也是
		// 这种宽松策略。
		{
			key: "password",
			labelKey: "newlogin_password",
			placeholderKey: "newlogin_password_placeholder",
			kind: "secret",
			mono: true,
		},
		{
			key: "url",
			labelKey: "newlogin_url",
			placeholderKey: "newlogin_url_placeholder",
			kind: "url",
		},
		// TOTP 密钥（base32）—— 可选；填写后该 login 自动出现在 TOTP 聚合页
		// 后端会用 pquerna/otp 生成实时 6 位验证码，密钥不离 Go 进程。
		{
			key: "totp",
			labelKey: "field_totp_secret",
			placeholderKey: "field_totp_secret_placeholder",
			kind: "secret",
			mono: true,
		},
		{
			key: "notes",
			labelKey: "newlogin_notes",
			placeholderKey: "newlogin_notes_placeholder",
			kind: "textarea",
		},
	],
	card: [
		{
			key: "cardholder",
			labelKey: "field_card_holder",
			placeholderKey: "field_card_holder_placeholder",
			kind: "text",
		},
		{
			key: "number",
			labelKey: "field_card_number",
			placeholderKey: "field_card_number_placeholder",
			kind: "text",
			mono: true,
			required: true,
		},
		{
			key: "expiry",
			labelKey: "field_card_expiry",
			placeholderKey: "field_card_expiry_placeholder",
			kind: "text",
			mono: true,
		},
		{
			key: "cvv",
			labelKey: "field_card_cvv",
			placeholderKey: "field_card_cvv_placeholder",
			kind: "secret",
			mono: true,
		},
		{
			key: "notes",
			labelKey: "newlogin_notes",
			placeholderKey: "newlogin_notes_placeholder",
			kind: "textarea",
		},
	],
	note: [
		{
			key: "notes",
			labelKey: "newlogin_notes",
			placeholderKey: "newlogin_notes_placeholder",
			kind: "textarea",
			required: true,
		},
	],
	identity: [
		{
			key: "fullname",
			labelKey: "field_identity_fullname",
			placeholderKey: "field_identity_fullname_placeholder",
			kind: "text",
		},
		{
			key: "email",
			labelKey: "field_identity_email",
			placeholderKey: "field_identity_email_placeholder",
			kind: "text",
		},
		{
			key: "phone",
			labelKey: "field_identity_phone",
			placeholderKey: "field_identity_phone_placeholder",
			kind: "text",
		},
		{
			key: "notes",
			labelKey: "newlogin_notes",
			placeholderKey: "newlogin_notes_placeholder",
			kind: "textarea",
		},
	],
	ssh: [
		// 注意：不再有 username 字段 —— SSH 条目的「用户名」语义与 item.name
		// 完全重叠（与 Bitwarden 一致）。后端 sshItemToEntry / composeComment
		// 仍能读 fields["username"]（老条目兼容），但新条目不再生成该字段。
		{
			key: "private_key",
			labelKey: "field_ssh_private_key",
			placeholderKey: "field_ssh_private_key_placeholder",
			kind: "textarea",
			required: true,
			mono: true,
		},
		{
			key: "passphrase",
			labelKey: "field_ssh_passphrase",
			placeholderKey: "field_ssh_passphrase_placeholder",
			kind: "secret",
			mono: true,
		},
		{
			key: "host",
			labelKey: "field_ssh_host",
			placeholderKey: "field_ssh_host_placeholder",
			kind: "url",
		},
		{
			key: "notes",
			labelKey: "newlogin_notes",
			placeholderKey: "newlogin_notes_placeholder",
			kind: "textarea",
		},
	],
	passkey: [
		{
			key: "rpId",
			labelKey: "field_passkey_rp_id",
			placeholderKey: "field_passkey_rp_id_placeholder",
			kind: "url",
			required: true,
		},
		{
			key: "userName",
			labelKey: "field_passkey_user_name",
			placeholderKey: "field_passkey_user_name_placeholder",
			kind: "text",
		},
		{
			key: "credentialId",
			labelKey: "field_passkey_credential_id",
			placeholderKey: "field_passkey_credential_id_placeholder",
			kind: "secret",
			mono: true,
		},
		{
			key: "notes",
			labelKey: "newlogin_notes",
			placeholderKey: "newlogin_notes_placeholder",
			kind: "textarea",
		},
	],
	// 独立 TOTP 条目：仅密钥 + 可选发行者 / 账户标识
	totp: [
		{
			key: "issuer",
			labelKey: "field_totp_issuer",
			placeholderKey: "field_totp_issuer_placeholder",
			kind: "text",
		},
		{
			key: "account",
			labelKey: "field_totp_account",
			placeholderKey: "field_totp_account_placeholder",
			kind: "text",
		},
		{
			key: "totp",
			labelKey: "field_totp_secret",
			placeholderKey: "field_totp_secret_placeholder",
			kind: "secret",
			required: true,
			mono: true,
		},
		{
			key: "notes",
			labelKey: "newlogin_notes",
			placeholderKey: "newlogin_notes_placeholder",
			kind: "textarea",
		},
	],
};

/** 把 type 转成 i18n 标签 */
function typeLabelKey(type: VaultItemType): string {
	return `newlogin_type_${type}`;
}

// ---------------------------------------------------------------------------
// 自定义字段（参考 Bitwarden）
// ---------------------------------------------------------------------------
//
// 设计要点：
//   - 后端 ItemPayload.Fields 是 map[string]any，不约束 key。我们约定一个
//     保留键 "_customFields" 存自定义字段数组，与原生字段彻底解耦。
//   - 4 种字段类型对齐 Bitwarden：
//       text     纯文本
//       hidden   遮蔽显示，带 reveal 切换 + 复制按钮
//       boolean  开关
//       linked   下拉选择关联到本条目的某个原生字段（仅展示关联键名，
//                目前不做实际自动填充逻辑）
//   - 编辑器对 customFields 做完整的增删改；提交时序列化回数组。
//   - 详情页对未知字段的兜底渲染需排除掉 _customFields 以避免重复显示。

export type CustomFieldType = "text" | "hidden" | "boolean" | "linked";

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = [
	"text",
	"hidden",
	"boolean",
	"linked",
];

export interface CustomField {
	id: string;
	type: CustomFieldType;
	name: string;
	/** text/hidden 为 string；boolean 为 bool；linked 为关联的原生字段 key（string） */
	value: string | boolean;
}

/** 保留在 fields 里专门存自定义字段数组的键名。该键不会被原生字段渲染逻辑使用。 */
export const CUSTOM_FIELDS_KEY = "_customFields";

/** 每种类型可被 linked 字段引用的原生字段 key 集合 */
const LINKABLE_FIELDS_BY_TYPE: Record<VaultItemType, string[]> = {
	login: ["username", "password", "totp"],
	card: ["cardholder", "number", "expiry", "cvv"],
	note: [],
	identity: ["fullname", "email", "phone"],
	ssh: ["private_key", "passphrase", "host"],
	passkey: ["rpId", "userName", "credentialId"],
	totp: ["issuer", "account", "totp"],
};

function newCustomFieldId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `cf-${Math.random().toString(36).slice(2, 10)}`;
}

/** 反序列化：从 fields[_customFields] 解析出 CustomField[]，做一遍格式校验 */
export function parseCustomFields(
	fields: Record<string, unknown> | undefined,
): CustomField[] {
	if (!fields) return [];
	const raw = fields[CUSTOM_FIELDS_KEY];
	if (!Array.isArray(raw)) return [];
	const out: CustomField[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const type = e.type;
		if (
			type !== "text" &&
			type !== "hidden" &&
			type !== "boolean" &&
			type !== "linked"
		) {
			continue;
		}
		const id = typeof e.id === "string" && e.id ? e.id : newCustomFieldId();
		const name = typeof e.name === "string" ? e.name : "";
		let value: string | boolean;
		if (type === "boolean") {
			value = e.value === true;
		} else {
			value = typeof e.value === "string" ? e.value : "";
		}
		out.push({ id, type, name, value });
	}
	return out;
}

/** 序列化：把 CustomField[] 写回 fields，过滤掉空名字段（boolean 例外） */
export function serializeCustomFields(arr: CustomField[]): CustomField[] {
	return arr
		.filter((f) => (f.name ?? "").trim() || f.type === "boolean")
		.map((f) => ({
			id: f.id,
			type: f.type,
			name: f.name,
			value:
				f.type === "boolean"
					? Boolean(f.value)
					: typeof f.value === "string"
						? f.value
						: "",
		}));
}

/**
 * 敏感字段清单 —— 复制时走 writeClipboardEphemeral（30s 自动清空）
 *
 * 提到模块顶层而不是放组件内：
 *   - 该常量是程序静态规则，与 React 渲染生命周期无关
 *   - 放进组件内部会让 useCallback 的依赖项指向"每次渲染都新建的 Set"，
 *     不仅触发 lint 报错，还可能让 useCallback 缓存失效
 *
 * 未来扩展字段类型时只需在此处追加键名。
 */
const SENSITIVE_FIELDS = new Set([
	"password",
	"cvv",
	"seed",
	"private_key",
	"privateKeyPkcs8",
	"passphrase",
	// TOTP 密钥本身（不是 6 位 OTP 数字）—— 编辑表单复制时也要走 30s 自动清空
	"totp",
]);

// ---------------------------------------------------------------------------
// VaultPage 主组件
// ---------------------------------------------------------------------------

export function VaultPage() {
	const { t } = useTranslation();

	// ----- store 订阅 -----
	const status = useVaultStore((s) => s.status);
	const items = useVaultStore((s) => s.items);
	const filter = useVaultStore((s) => s.filter);
	const setFilter = useVaultStore((s) => s.setFilter);

	// ----- URL :itemId → store.selectedId 同步（“真正的”深链支持）-----
	//
	// router 里声明了 `/vault/:itemId` 以支持 LockGuard 提及的“解锁后回到
	// 具体条目”语义，但之前 VaultPage 没有将 :itemId 同步到 store.selectedId，
	// 导致路由声明是“僵尸”。这里补齐该同步：
	//   - 进页 / 浏览器前进后退时，若 URL 是 `/vault/<id>` 则 selectItem(<id>)
	//   - 同时，为了不让 pathname 破坏侧边栏高亮（NavRow exactSearch 要求
	//     pathname === '/vault'），在能查到条目类型后用 replace 跳回
	//     `/vault?filter=<type>` —— 外部深链仍然能进入正确的条目，而内部
	//     跳转则由各个入口（TotpPage / HealthPage / CmdK）直接用 `?filter=` 形式。
	const { itemId: routeItemId } = useParams<{ itemId?: string }>();
	const navigate = useNavigate();
	const selectItem = useVaultStore((s) => s.selectItem);
	// biome-ignore lint/correctness/useExhaustiveDependencies: items/navigate/selectItem 仅供 effect body 读取，触发仅依赖 routeItemId
	useEffect(() => {
		if (!routeItemId) return;
		selectItem(routeItemId);
		const match = items.find((it) => it.id === routeItemId);
		// 若 items 还未加载，match 为 undefined；等下一轮 items 变动后重跑。
		if (match) {
			navigate(`/vault?filter=${match.type}`, { replace: true });
		}
	}, [routeItemId, items]);

	// ----- URL ↔ store filter 双向同步 -----
	// 侧边栏分类项链接形如 `/vault?filter=login|card|note|identity|ssh`，
	// "所有条目"是裸 `/vault`（无 filter 参数即视为 all）。这里把 URL 当作
	// "filter 状态的真源"投射到 store —— 进入页面 / 浏览器前进后退 / 侧边栏
	// 切换分类，全部走 search params；store 仍保留 setFilter 供需要程序化切换
	// 的入口（例如 CmdK 命令面板未来可能直接 set filter）使用。顶部 FilterChip
	// 行已被移除（侧边栏单点切换分类即可），不再需要 changeFilter 入口。
	const [searchParams] = useSearchParams();

	// URL → store：search params 变化时把 store filter 校准到 URL 表示的值。
	// 仅依赖 searchParams —— 这是单向的"URL 推 store"，filter / setFilter
	// 故意不参与依赖，否则 setFilter 触发 effect 重跑形成循环。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 单向同步，filter/setFilter 故意不在依赖里
	useEffect(() => {
		const raw = searchParams.get("filter");
		const allowed: VaultFilter[] = [
			"all",
			"login",
			"card",
			"note",
			"identity",
			"ssh",
			"passkey",
			"totp",
			"fav",
		];
		const next: VaultFilter =
			raw && (allowed as string[]).includes(raw) ? (raw as VaultFilter) : "all";
		if (next !== filter) {
			setFilter(next);
		}
	}, [searchParams]);

	const query = useVaultStore((s) => s.query);
	const setQuery = useVaultStore((s) => s.setQuery);
	const selectedId = useVaultStore((s) => s.selectedId);
	const selectedSummary = useVaultStore(selectCurrentItem);
	const itemDetails = useVaultStore((s) => s.itemDetails);
	const fetchItem = useVaultStore((s) => s.fetchItem);
	const removeItem = useVaultStore((s) => s.remove);
	const loadVault = useVaultStore((s) => s.load);
	const errorMsg = useVaultStore((s) => s.error);
	const lockStore = useLockStore((s) => s.lock);

	const pushToast = useUIStore((s) => s.pushToast);
	const newItemRequest = useUIStore((s) => s.newItemRequest);
	const editItemRequest = useUIStore((s) => s.editItemRequest);

	// ----- 本地 UI 状态 -----
	/** 对话框 mode："new" 新建 / "edit" 编辑当前选中条目 / null 关闭 */
	const [dialogMode, setDialogMode] = useState<null | "new" | "edit">(null);
	/**
	 * 删除确认对话框开合
	 *
	 * 替代原 window.confirm —— 后者在 Wails WebView 浅色主题下强制系统亮色、
	 * macOS 上是阻塞 sheet，与 ZPass 的视觉系统脱节。改用 Radix AlertDialog
	 * 后样式与其它对话框统一，且自带 focus trap / Esc 关闭。
	 */
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
	/**
	 * 新建对话框打开时的预设 type。
	 *
	 * 根据“打开新建对话框时”的当前 filter 推导：
	 *   - filter === "login" / "card" / "note" / "identity" / "ssh"
	 *     → 预设到对应 type，用户在该分类下点新建即默认建该类型条目
	 *   - filter === "all" / "fav" → 预设到 "login"（保持旧默认行为）
	 *
	 * 在打开对话框瞬间快照一次，而不是 dialog 内部直接读 store.filter ——
	 * 避免对话框打开后用户切换 filter 导致表单 type 跳变。
	 */
	const [presetType, setPresetType] = useState<VaultItemType>("login");
	const [contextMenu, setContextMenu] = useState<{
		open: boolean;
		x: number;
		y: number;
		itemId: string | null;
	}>({ open: false, x: 0, y: 0, itemId: null });
	// 选中条目的密码是否当前明文显示。切换条目时自动复位，避免上一条
	// 的"已显示"状态意外延续到新条目。
	const [revealPassword, setRevealPassword] = useState(false);
	// 复制反馈：键 = 字段名（"username" / "password"），值 = 该字段最近
	// 一次复制成功的时间戳。renderCopy() 据此把按钮文案在 1.6s 内切到
	// "Copied"。用 map 而非单个布尔是为了支持同时多字段反馈。
	const [copiedAt, setCopiedAt] = useState<Record<string, number>>({});

	// 搜索输入引用 —— 用于 / 快捷键聚焦
	const searchInputRef = useRef<HTMLInputElement>(null);

	// ----- 列表面板宽度拖拽 -----
	const ASIDE_MIN = 200;
	const ASIDE_MAX = 480;
	const ASIDE_DEFAULT = 280;
	const [asideWidth, setAsideWidth] = useState<number>(() => {
		const stored = localStorage.getItem("zpass-vault-aside-width");
		const n = stored ? parseInt(stored, 10) : NaN;
		return Number.isFinite(n)
			? Math.min(ASIDE_MAX, Math.max(ASIDE_MIN, n))
			: ASIDE_DEFAULT;
	});
	const isDraggingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);

	const resizeHandleRef = useRef<HTMLDivElement>(null);

	const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		isDraggingRef.current = true;
		startXRef.current = e.clientX;
		startWidthRef.current = asideWidth;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		resizeHandleRef.current?.setAttribute("data-dragging", "true");
	};

	const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!isDraggingRef.current) return;
		const delta = e.clientX - startXRef.current;
		const next = Math.min(
			ASIDE_MAX,
			Math.max(ASIDE_MIN, startWidthRef.current + delta),
		);
		setAsideWidth(next);
	};

	const onResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!isDraggingRef.current) return;
		isDraggingRef.current = false;
		const delta = e.clientX - startXRef.current;
		const final = Math.min(
			ASIDE_MAX,
			Math.max(ASIDE_MIN, startWidthRef.current + delta),
		);
		localStorage.setItem("zpass-vault-aside-width", String(final));
		resizeHandleRef.current?.removeAttribute("data-dragging");
	};

	// ----- 副作用 -----

	// 挂载时强制 load 一次 —— 即便 UnlockPage 已经 load 过了，重新进入
	// vault 页（比如刷新 / 路由切换回来）也保证看到最新数据。store 内部
	// 把 loading 状态带给我们，重复 load 不会出问题。
	useEffect(() => {
		loadVault();
	}, [loadVault]);

	// 选中变化时拉完整 payload 进缓存
	useEffect(() => {
		if (!selectedId) return;
		if (itemDetails[selectedId]) return;
		void fetchItem(selectedId);
	}, [selectedId, itemDetails, fetchItem]);

	// 切换条目时复位"明文显示"状态 —— 否则用户切换会看到新条目密码
	// 直接是明文，违反"默认隐藏"的安全直觉
	//
	// biome 误判：它认为 setRevealPassword 是 React stable setter 不需要进 deps，
	// 而 selectedId 在 effect body 里没用到也不该在 deps —— 但 selectedId 正是
	// "触发 effect 重跑"的依据，必须保留。用 ignore 注释抑制 lint。
	// biome-ignore lint/correctness/useExhaustiveDependencies: selectedId 是触发依据，effect body 故意不读它
	useEffect(() => {
		setRevealPassword(false);
	}, [selectedId]);

	// 当前 filter → 新建条目预设 type 的派生函数。仅 6 个真实 type 直透，
	// "all" / "fav" 这种伪 filter 回退到 login（最常用）。
	const filterToPresetType = useCallback((f: VaultFilter): VaultItemType => {
		if (f === "all" || f === "fav") return "login";
		return f;
	}, []);

	// 统一的"打开新建对话框"入口：根据当前 filter 计算 preset type 并打开
	const openNewDialog = useCallback(() => {
		setPresetType(filterToPresetType(filter));
		setDialogMode("new");
	}, [filter, filterToPresetType]);
	const openNewDialogForType = useCallback((type: VaultItemType) => {
		setPresetType(type);
		setDialogMode("new");
	}, []);

	const openEditDialog = useCallback(
		async (id: string | null = selectedId) => {
			if (!id) return;
			if (id !== selectedId) {
				selectItem(id);
			}
			if (!itemDetails[id]) {
				const payload = await fetchItem(id);
				if (!payload) return;
			}
			setDialogMode("edit");
		},
		[selectedId, selectItem, itemDetails, fetchItem],
	);

	// 订阅 Topbar / ⌘N 触发的新建信号 —— 每次计数器递增就打开新建对话框，
	// 同样按当前 filter 推导 preset type。
	// preset 跟随触发瞬间的 filter；不把 filter / filterToPresetType 放进
	// 依赖避免 filter 变化时虚假重开 dialog。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅 newItemRequest 是触发依据
	useEffect(() => {
		if (newItemRequest > 0) {
			setPresetType(filterToPresetType(filter));
			setDialogMode("new");
		}
	}, [newItemRequest]);

	// 订阅 TotpPage / 其他列表页"打开编辑"信号 —— 计数器递增即把对应
	// 条目选中并打开编辑 dialog。openEditDialog 内部会等 fetchItem 完成
	// 再切 dialogMode，所以跨页跳转后 itemDetails 缓存未命中也安全。
	//
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅 editItemRequest.counter 是触发依据
	useEffect(() => {
		if (!editItemRequest) return;
		void openEditDialog(editItemRequest.id);
	}, [editItemRequest?.counter]);

	// ----- 派生数据 -----

	// 过滤 + 搜索后的可见列表
	const visibleItems = useMemo(() => {
		let list = items;
		if (filter !== "all") {
			if (filter === "fav") {
				list = list.filter((i) => {
					const detail = itemDetails[i.id];
					return Boolean(detail?.fields.fav);
				});
			} else {
				list = list.filter((i) => i.type === filter);
			}
		}
		const q = query.trim().toLowerCase();
		if (q) {
			list = list.filter((i) => i.name.toLowerCase().includes(q));
		}
		return list;
	}, [items, filter, query, itemDetails]);

	// 当前选中条目的完整 payload（缓存命中即返回，未命中等 fetchItem 完成）
	const detail = selectedId ? itemDetails[selectedId] : undefined;
	const deleteTargetSummary = deleteTargetId
		? (items.find((i) => i.id === deleteTargetId) ?? null)
		: selectedSummary;
	const contextTargetId = contextMenu.itemId;
	const contextTargetSummary = contextTargetId
		? (items.find((i) => i.id === contextTargetId) ?? null)
		: null;
	const contextTargetDetail = contextTargetId
		? itemDetails[contextTargetId]
		: undefined;

	// ----- 行为 -----

	const onLock = async () => {
		try {
			await vaultApi.lock();
		} finally {
			lockStore();
			pushToast({ text: t("toast_locked"), icon: "lock" });
		}
	};

	/**
	 * 复制单个字段
	 *
	 * password 类敏感字段（见模块顶层 SENSITIVE_FIELDS）走
	 * writeClipboardEphemeral（30s 自动清空），其它字段走普通 writeClipboard。
	 * 两者都 push toast 反馈。
	 */
	const onCopy = useCallback(
		async (field: string, value: string) => {
			if (!value) return;
			const sensitive = SENSITIVE_FIELDS.has(field);
			const ok = sensitive
				? await writeClipboardEphemeral(value)
				: await writeClipboard(value);
			if (ok) {
				setCopiedAt((prev) => ({ ...prev, [field]: Date.now() }));
				const toastTextKey =
					field === "password"
						? "toast_copied_password"
						: field === "username"
							? "toast_copied_username"
							: field === "url"
								? "toast_copied_url"
								: "toast_copied";
				pushToast({ text: t(toastTextKey), icon: "copy" });
			} else {
				pushToast({ text: t("toast_copy_failed"), icon: "x" });
			}
		},
		[pushToast, t],
	);

	const openListContextMenu = useCallback(
		(
			event: React.MouseEvent<HTMLElement>,
			itemId?: string | null,
		) => {
			event.preventDefault();
			event.stopPropagation();
			const targetId = itemId === undefined ? selectedId : itemId;
			if (targetId && targetId !== selectedId) {
				selectItem(targetId);
			}
			if (targetId && !itemDetails[targetId]) {
				void fetchItem(targetId);
			}
			setContextMenu({
				open: true,
				x: event.clientX,
				y: event.clientY,
				itemId: targetId,
			});
		},
		[selectedId, selectItem, itemDetails, fetchItem],
	);

	// 1.6 秒后让 "Copied" 文案自动复位
	useEffect(() => {
		const timeouts: number[] = [];
		Object.entries(copiedAt).forEach(([key, ts]) => {
			const remaining = 1600 - (Date.now() - ts);
			if (remaining <= 0) return;
			const id = window.setTimeout(() => {
				setCopiedAt((prev) => {
					if (prev[key] !== ts) return prev;
					const next = { ...prev };
					delete next[key];
					return next;
				});
			}, remaining);
			timeouts.push(id);
		});
		return () => {
			for (const id of timeouts) window.clearTimeout(id);
		};
	}, [copiedAt]);

	/**
	 * 触发删除确认 —— 不再走 window.confirm
	 *
	 * 仅打开自定义 AlertDialog；真正的删除动作放在 confirmDelete 里，
	 * 在用户点"删除"按钮后才执行。这样能让确认 UI 完全继承应用主题，
	 * 也不会在 macOS 上出现原生阻塞 sheet。
	 */
	const onDelete = (id?: string | null) => {
		const targetId = typeof id === "string" ? id : selectedId;
		if (!targetId) return;
		if (targetId !== selectedId) {
			selectItem(targetId);
		}
		setDeleteTargetId(targetId);
		setDeleteConfirmOpen(true);
	};

	const confirmDelete = async () => {
		const targetId = deleteTargetId ?? selectedId;
		if (!targetId) return;
		try {
			await removeItem(targetId);
			pushToast({ text: t("toast_deleted"), icon: "check" });
		} catch {
			pushToast({ text: errorMsg ?? t("vault_error"), icon: "x" });
		} finally {
			setDeleteConfirmOpen(false);
			setDeleteTargetId(null);
		}
	};

	// ----- 键盘导航 -----
	//
	// 全局 keydown 监听：
	//   - ↑/↓ 或 j/k：在 visibleItems 内移动选中
	//   - /：聚焦搜索框
	//   - ⌘⇧C / Ctrl+Shift+C：复制密码
	//   - ⌘B / Ctrl+B：复制用户名
	//
	// 守卫：当焦点在 input/textarea/contenteditable 时，j/k/方向键不拦截，
	// 让用户在搜索 / 输入时能正常打字。⌘⇧C / ⌘B 含修饰键，不会与文本输入
	// 冲突，无需此守卫。
	useEffect(() => {
		const isTyping = (target: EventTarget | null): boolean => {
			if (!(target instanceof HTMLElement)) return false;
			const tag = target.tagName.toLowerCase();
			if (tag === "input" || tag === "textarea") return true;
			if (target.isContentEditable) return true;
			return false;
		};

		const handler = (e: KeyboardEvent) => {
			// 对话框打开时不响应列表导航
			if (dialogMode !== null) return;

			const mod = e.metaKey || e.ctrlKey;

			// ⌘⇧C / Ctrl+Shift+C —— 复制密码
			if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
				if (!detail) return;
				const pw = fieldStr(detail.fields, "password");
				if (pw) {
					e.preventDefault();
					void onCopy("password", pw);
				}
				return;
			}

			// ⌘B / Ctrl+B —— 复制用户名
			if (mod && !e.shiftKey && (e.key === "B" || e.key === "b")) {
				if (!detail) return;
				const u = fieldStr(detail.fields, "username");
				if (u) {
					e.preventDefault();
					void onCopy("username", u);
				}
				return;
			}

			// 输入态守卫：以下快捷键不在输入框 / textarea 中触发
			if (isTyping(e.target)) return;

			// "/" 聚焦搜索
			if (e.key === "/" && !mod) {
				e.preventDefault();
				searchInputRef.current?.focus();
				searchInputRef.current?.select();
				return;
			}

			// 方向键 / j / k —— 列表移动
			const isDown =
				e.key === "ArrowDown" || (!mod && (e.key === "j" || e.key === "J"));
			const isUp =
				e.key === "ArrowUp" || (!mod && (e.key === "k" || e.key === "K"));
			if (!isDown && !isUp) return;
			if (visibleItems.length === 0) return;
			e.preventDefault();
			const idx = visibleItems.findIndex((i) => i.id === selectedId);
			let next = idx;
			if (isDown)
				next = idx < 0 ? 0 : Math.min(visibleItems.length - 1, idx + 1);
			if (isUp) next = idx <= 0 ? 0 : idx - 1;
			const target = visibleItems[next];
			if (target && target.id !== selectedId) selectItem(target.id);
		};

		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [visibleItems, selectedId, selectItem, detail, onCopy, dialogMode]);

	// ----- 渲染 -----

	return (
		<div className="flex h-full w-full overflow-hidden">
			{/* ========== 左栏：列表 ========== */}
			{/* 列表与右栏详情同处 VaultPage 内部，都用 --bg-elev 作为「主内容
			 * 白纸」。外层（AppShell 的 Sidebar / Topbar 区域）才是 --bg 灰画布。
			 * 这样列表与详情靠 border-r 分割，整体仍然是一张连贯的白纸，避免
			 * "灰列表 + 白详情"切成两半的视觉割裂。 */}
			<aside
				className="flex shrink-0 flex-col bg-(--bg-elev)"
				style={{ width: asideWidth }}
			>
				{/* 顶部：仅搜索框（无内嵌「新建」按钮）
				 *
				 * 历史背景：早期这里和搜索框并排放了一个动态文案的「新建条目 /
				 * 新建银行卡 / 新建身份」按钮。问题是列宽固定 320px (w-80) 扣掉
				 * px-3 (24px) + gap-2 (8px) 后，留给按钮的空间不到 90px，中文
				 * 长文案在多分类下把搜索框挤窄甚至溢出列右缘 —— 肉眼表现为
				 * "搜索条目右边贴脸列边框、看似超出最大宽度"。
				 *
				 * 解法：移除该按钮。Topbar 右上角已有醒目的「+ 新建」CTA、
				 * 列表空态有 inline 新建按钮、⌘N / Ctrl+N 快捷键也始终可用，
				 * 入口完全不缺。aside 头部专心只放搜索，搜索 label 直接 flex-1
				 * 撑到 px-3 右缘 —— 与下方列表 row 右缘 (pr-3) + 底部状态栏右
				 * 缘 (px-3) 对齐到同一条 12px 留白线，三段视觉一气呵成。
				 *
				 * 对标 1Password / Bitwarden web 列表面板：搜索独占一行、新建
				 * 入口在主操作栏（Topbar），无重复 CTA。
				 */}
				<div className="flex min-w-0 shrink-0 items-center border-b border-(--line-soft) px-2.5 py-2">
					{/* 搜索框：不做"聚焦边框变色"的反馈
					 *
					 * 上一版用 focus-within:border-(--text-3) 给 label 边框换色
					 * 作为聚焦提示，但实测在 light 主题下出现"超出 label 一圈
					 * 灰边"的视觉错觉。原因不是 outline 跑出来（DOM 已确认 input
					 * 的 outline 已被三层冗余 + 内联 style 关闭），而是：
					 *   - label 底 --bg-elev-2 (#f7f7f5) 与外侧 aside 底
					 *     --bg-elev (#ffffff) 仅差 8 个亮度，肉眼几乎看不出
					 *     label 的形状边界
					 *   - 焦点态把 1px border 提到 --text-3 (#595960) 中性灰，
					 *     这条灰边因为底色没有视觉锚点，看起来像"凭空浮起"
					 *     的描边，而不是 label 自己的边
					 *
					 * 解法：参考 Linear / Raycast / 1Password 搜索框的惯例 ——
					 * 搜索这种低优先级控件不需要"边框变色"反馈，只靠光标闪烁 +
					 * placeholder 消失就足以传达"已聚焦"。border 全程保持
					 * --line 不变色，视觉立刻干净。
					 *
					 * input 自身的 outline 由 globals.css 统一关闭 + 工具类
					 * 三连 + 内联 style 三层冗余兜底。
					 */}
					<div className="relative min-w-0 flex-1">
						<label
							className="flex h-8 w-full items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) pl-2.5 text-(--text-3) outline-none focus-within:outline-none"
							style={{ paddingRight: query ? "1.75rem" : "0.625rem" }}
							htmlFor="vault-search-input"
						>
							<Search size={13} strokeWidth={1.5} className="shrink-0" />
							<input
								id="vault-search-input"
								ref={searchInputRef}
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={t("vault_search_placeholder")}
								className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-(--text) outline-none focus:outline-none focus-visible:outline-none placeholder:text-(--text-4)"
								style={{ outline: "none", boxShadow: "none" }}
							/>
						</label>
						{query && (
							<button
								type="button"
								onClick={() => setQuery("")}
								aria-label="clear search"
								className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text)"
							>
								<X size={11} strokeWidth={1.5} />
							</button>
						)}
					</div>
				</div>

				{/* 顶部分类筛选 chip 行已移除：分类切换由侧边栏承担，避免重复入口 */}

				{/* 列表本体 */}
				<section
					className="min-h-0 flex-1 overflow-y-auto"
					aria-label={t("vault_title")}
					onContextMenu={(event) => {
						const target = event.target as HTMLElement | null;
						if (target?.closest("[data-vault-item-id]")) return;
						openListContextMenu(event, null);
					}}
				>
					{status === "loading" && items.length === 0 ? (
						<EmptyHint text={t("vault_loading")} />
					) : status === "error" && items.length === 0 ? (
						<EmptyHint text={errorMsg || t("vault_error")} />
					) : visibleItems.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
							<div className="text-sm text-(--text-2)">{t("vault_empty")}</div>
							<div className="text-xs text-(--text-3)">
								{t("vault_empty_hint")}
							</div>
							<Button
								variant="secondary"
								size="sm"
								onClick={openNewDialog}
								className="mt-2"
								leftIcon={<Plus size={12} strokeWidth={2} />}
							>
								{/* 空态按钮文本同样跟随 filter，与上方主按钮保持一致 */}
								{filter === "all" || filter === "fav"
									? t("vault_new_btn")
									: t("newitem_title", {
											type: t(typeLabelKey(filter as VaultItemType)),
										})}
							</Button>
						</div>
					) : (
						/*
						 * pr-3 让列表 row 右缘与上方搜索栏 label 右缘对齐（均距
						 * aside.border-r 12px）。修复"选中态/hover 高亮带贴着
						 * 右侧分割线、与搜索框 12px 留白形成视觉错位"的边距问题。
						 *
						 * 左侧不内缩 —— 保留 selected 行 border-l-2 indicator
						 * 紧贴 aside 左缘的 1Password 风格强调。
						 */
						<ul className="flex flex-col px-2 py-1.5 gap-0.5">
							{visibleItems.map((it) => (
								<VaultListRow
									key={it.id}
									item={it}
									selected={selectedId === it.id}
									onClick={() => selectItem(it.id)}
									onContextMenu={(event) => openListContextMenu(event, it.id)}
								/>
							))}
						</ul>
					)}
				</section>

				{/* 底部状态栏：条目计数 + 锁定按钮
				 * - bg-elev-2 与列表区 bg-elev 拉开层次，形成"主区里的小工具条"
				 * - px-2.5 与上方搜索容器 / 列表 ul 的 pr-3 共享右留白线，
				 *   保证 aside 内三段（搜索 / 列表 / 状态栏）右缘对齐
				 * - py-1：让整行高度（h-7 按钮 + 4×2 = 36px）与 sidebar
				 *   底部账户区（h-5 头像 + py-2 = 36px）完全对齐，
				 *   两栏视觉等高，避免左低右高的不协调感 */}
				<div className="flex shrink-0 items-center justify-between border-t border-(--line-soft) bg-(--bg-elev-2) px-2.5 py-1">
					<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
						{t("vault_count", { count: items.length })}
					</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={onLock}
						leftIcon={<LockIcon size={12} strokeWidth={1.5} />}
					>
						{t("vault_lock_btn")}
					</Button>
				</div>
			</aside>

			{/* ===== 拖拽 resize handle（aside 与 section 之间的兄弟节点）=====
			 * 独立于 aside 内容之外，不影响搜索框/列表/状态栏的右缘对齐。
			 * w-2 (8px) 透明热区，中线对准 border-r；
			 * hover 时分割线变深，data-dragging 时变蓝高亮。
			 * pointer capture 保证鼠标移出 handle 热区后拖拽不中断。 */}
			<div
				ref={resizeHandleRef}
				className="group relative z-20 w-2 shrink-0 cursor-col-resize select-none"
				onPointerDown={onResizePointerDown}
				onPointerMove={onResizePointerMove}
				onPointerUp={onResizePointerUp}
				onPointerCancel={onResizePointerUp}
			>
				{/* 分割线：平时 --line，hover 变 --text-3，data-dragging 变蓝 */}
				<div className="resize-handle-line absolute top-0 left-1 h-full w-px bg-(--line) transition-colors group-hover:bg-(--text-3)" />
			</div>

			{/* ========== 右栏：详情 ========== */}
			{/* 层次约定（自外向内）——
			 *
			 *   外层 Sidebar / Topbar    --bg          灰画布（"工作区底色"）
			 *   VaultPage 列表 / 详情    --bg-elev     主内容白纸（左右连贯一体）
			 *   字段 / 控件 / 状态栏     --bg-elev-2   嵌入式控件（再凹一档）
			 *
			 * 对标 1Password / Bitwarden web / Linear / Raycast：导航灰画布托
			 * 主区白纸，主区内部所有可交互控件统一向里凹一档形成"嵌入感"。
			 * 列表与详情共享 --bg-elev 是关键 —— 它们靠中间 border-r 划分，
			 * 整体仍是一张连贯的白纸，避免"灰列表 + 白详情"切两半的割裂感。
			 */}
			<section className="min-w-0 flex-1 overflow-y-auto bg-(--bg-elev)">
				{!selectedSummary ? (
					<EmptyDetail />
				) : (
					<VaultDetail
						summary={selectedSummary}
						detail={detail}
						revealPassword={revealPassword}
						onToggleReveal={() => setRevealPassword((v) => !v)}
						onCopy={onCopy}
						copiedAt={copiedAt}
						onDelete={onDelete}
						onEdit={() => {
							void openEditDialog(selectedSummary.id);
						}}
					/>
				)}
			</section>

			<VaultListContextMenu
				open={contextMenu.open}
				x={contextMenu.x}
				y={contextMenu.y}
				item={contextTargetSummary}
				detail={contextTargetDetail}
				onOpenChange={(open) =>
					setContextMenu((prev) => ({ ...prev, open }))
				}
				onNewItem={openNewDialogForType}
				onEdit={(id) => {
					void openEditDialog(id);
				}}
				onDelete={onDelete}
				onCopy={onCopy}
			/>

			{/* ========== 新建 / 编辑 弹层 ========== */}
			{dialogMode !== null && (
				<ItemDialog
					mode={dialogMode}
					existing={dialogMode === "edit" ? detail : undefined}
					presetType={dialogMode === "new" ? presetType : undefined}
					onClose={() => setDialogMode(null)}
				/>
			)}

			{/* ========== 删除确认 AlertDialog ========== */}
			<DeleteConfirmDialog
				open={deleteConfirmOpen}
				name={deleteTargetSummary?.name ?? ""}
				onConfirm={confirmDelete}
				onCancel={() => {
					setDeleteConfirmOpen(false);
					setDeleteTargetId(null);
				}}
			/>
		</div>
	);
}

// 注：原 FilterChip 子组件已随顶部分类筛选 chip 行一并删除。分类切换统一
// 由侧边栏承担；如需恢复，可从 git 历史里翻出此组件。
// ---------------------------------------------------------------------------
// 子组件：列表行
// ---------------------------------------------------------------------------

function VaultListRow({
	item,
	selected,
	onClick,
	onContextMenu,
}: {
	item: VaultItemSummary;
	selected: boolean;
	onClick: () => void;
	onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const glyph = (Array.from(item.name)[0] ?? "·").toUpperCase();

	return (
		<li data-vault-item-id={item.id}>
			<button
				type="button"
				onClick={onClick}
				onContextMenu={onContextMenu}
				// 阻止鼠标按下时把 DOM focus 转移到这个 button —— 配合
				// tabIndex={-1} 把列表项整体移出 Tab 序列，让"当前选中项"
				// 完全由 React state (selectedId) 表达（虚拟焦点模式，
				// 与 cmdk / 1Password 列表一致）。
				//
				// 之所以必须这么做：globals.css 里的
				//   :is(button, ...):focus-visible { outline: 1px solid ... }
				// 全局规则因为 :is() 多组合伪类，selector 特异性高于
				// Tailwind 编译出来的 .focus-visible\:outline-none，本地
				// 工具类压不住。鼠标点选后 button 持续持有 focus，方向键
				// 再触发会被浏览器判定为键盘交互 → 命中全局规则 → 第一项
				// 突然冒出一圈黑框。
				//
				// 让 button 永远不获取 focus，:focus-visible 自然永远不命中，
				// 从根上消除该 bug。
				onMouseDown={(e) => e.preventDefault()}
				tabIndex={-1}
				className={
					selected
						? "flex w-full items-center gap-2.5 rounded-md bg-(--bg-active) px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:outline-none"
						: "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-(--bg-hover) focus:outline-none focus-visible:outline-none"
				}
			>
				{/* 缩略字形方块 ——
				 * 此前右下角叠了一个 11px type 图标小方块，与 sublabel 中的
				 * `LOGIN · 2h` 文字信息冗余，且 11px 图标在视觉上是噪点。
				 * 类型信息由 sublabel 文字承担，更克制更高级。
				 */}
				<div
					className={
						selected
							? "flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius) font-mono text-[12px] font-semibold transition-colors bg-(--accent) text-(--accent-ink)"
							: "flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius) font-mono text-[12px] font-semibold transition-colors border border-(--line) bg-(--bg-elev-2) text-(--text-3)"
					}
				>
					{glyph}
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] text-(--text)">{item.name}</div>
					<div className="truncate font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
						{item.type} · {relativeTime(item.updatedAt)}
					</div>
				</div>
			</button>
		</li>
	);
}

function VaultListContextMenu({
	open,
	x,
	y,
	item,
	detail,
	onOpenChange,
	onNewItem,
	onEdit,
	onDelete,
	onCopy,
}: {
	open: boolean;
	x: number;
	y: number;
	item: VaultItemSummary | null;
	detail: VaultItemPayload | undefined;
	onOpenChange: (open: boolean) => void;
	onNewItem: (type: VaultItemType) => void;
	onEdit: (id: string) => void;
	onDelete: (id: string) => void;
	onCopy: (field: string, value: string) => void;
}) {
	const { t } = useTranslation();
	const portalContainer =
		typeof document !== "undefined"
			? document.getElementById("portal-root")
			: null;
	const username =
		fieldStr(detail?.fields, "username") ||
		fieldStr(detail?.fields, "userName") ||
		fieldStr(detail?.fields, "account");
	const password = fieldStr(detail?.fields, "password");
	const url =
		fieldStr(detail?.fields, "url") ||
		fieldStr(detail?.fields, "rpId") ||
		fieldStr(detail?.fields, "host");

	const itemClass =
		"flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-(--text-2) outline-none transition-colors select-none data-highlighted:bg-(--bg-hover) data-highlighted:text-(--text)";
	const disabledClass =
		"flex h-8 cursor-not-allowed items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-(--text-4) opacity-55 outline-none select-none";
	const dangerClass =
		"flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-(--text-2) outline-none transition-colors select-none data-highlighted:bg-(--bg-hover) data-highlighted:text-(--danger)";
	const subContentClass = clsx(
		"z-50 min-w-48 zpass-glass rounded-(--radius) shadow-md p-1",
		"outline-none",
		"origin-(--radix-dropdown-menu-content-transform-origin)",
		"transition-[opacity,transform] duration-100 ease-out",
		"data-[state=open]:scale-100 data-[state=open]:opacity-100",
		"data-[state=closed]:scale-95 data-[state=closed]:opacity-0",
	);

	return (
		<DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					tabIndex={-1}
					aria-hidden="true"
					className="fixed z-50 h-px w-px opacity-0"
					style={{ left: x, top: y }}
				/>
			</DropdownMenu.Trigger>

			<DropdownMenu.Portal container={portalContainer}>
				<DropdownMenu.Content
					side="bottom"
					align="start"
					sideOffset={2}
					loop
					collisionPadding={8}
					className={clsx(
						"z-50 min-w-58 zpass-glass rounded-(--radius) shadow-md p-1",
						"outline-none",
						"origin-(--radix-dropdown-menu-content-transform-origin)",
						"transition-[opacity,transform] duration-100 ease-out",
						"data-[state=open]:scale-100 data-[state=open]:opacity-100",
						"data-[state=closed]:scale-95 data-[state=closed]:opacity-0",
					)}
				>
					{item && (
						<>
							<DropdownMenu.Label className="px-2.5 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-(--text-4)">
								{t(typeLabelKey(item.type))}
							</DropdownMenu.Label>
							<div className="mx-1 mb-1 truncate rounded-sm bg-(--bg-elev-2) px-2 py-1.5 text-[12px] text-(--text)">
								{item.name}
							</div>
						</>
					)}

					<DropdownMenu.Sub>
						<DropdownMenu.SubTrigger className={itemClass}>
							<Plus size={13} strokeWidth={1.6} className="shrink-0 text-(--text-3)" />
							<span className="flex-1">{t("ctx_new_item")}</span>
							<ChevronRight size={12} strokeWidth={1.6} className="shrink-0 text-(--text-4)" />
						</DropdownMenu.SubTrigger>
						<DropdownMenu.Portal container={portalContainer}>
							<DropdownMenu.SubContent
								sideOffset={4}
								alignOffset={-4}
								collisionPadding={8}
								className={subContentClass}
							>
								{NEW_ITEM_TYPES.map((type) => {
									const TypeIcon = TYPE_ICONS[type] ?? LogInIcon;
									return (
										<DropdownMenu.Item
											key={type}
											onSelect={() => onNewItem(type)}
											className={itemClass}
										>
											<TypeIcon
												size={13}
												strokeWidth={1.5}
												className="shrink-0 text-(--text-3)"
											/>
											{t("newitem_title", { type: t(typeLabelKey(type)) })}
										</DropdownMenu.Item>
									);
								})}
							</DropdownMenu.SubContent>
						</DropdownMenu.Portal>
					</DropdownMenu.Sub>

					{item && (
						<>
							<DropdownMenu.Separator className="my-1 h-px bg-(--line-soft)" />

							<DropdownMenu.Item
								onSelect={() => onEdit(item.id)}
								className={itemClass}
							>
								<Pencil size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
								{t("edit_btn")}
							</DropdownMenu.Item>

							<DropdownMenu.Item
								disabled={!username}
								onSelect={() => {
									if (username) onCopy("username", username);
								}}
								className={username ? itemClass : disabledClass}
							>
								<Copy size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
								{t("ctx_copy_username")}
							</DropdownMenu.Item>

							<DropdownMenu.Item
								disabled={!password}
								onSelect={() => {
									if (password) onCopy("password", password);
								}}
								className={password ? itemClass : disabledClass}
							>
								<KeyRound size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
								{t("ctx_copy_password")}
							</DropdownMenu.Item>

							<DropdownMenu.Item
								disabled={!url}
								onSelect={() => {
									if (url) onCopy("url", url);
								}}
								className={url ? itemClass : disabledClass}
							>
								<Link2 size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
								{t("ctx_copy_url")}
							</DropdownMenu.Item>

							<DropdownMenu.Separator className="my-1 h-px bg-(--line-soft)" />

							<DropdownMenu.Item
								onSelect={() => onDelete(item.id)}
								className={dangerClass}
							>
								<Trash2 size={13} strokeWidth={1.5} className="shrink-0 text-(--text-3)" />
								{t("detail_delete")}
							</DropdownMenu.Item>
						</>
					)}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

// ---------------------------------------------------------------------------
// 子组件：空态占位
// ---------------------------------------------------------------------------

function EmptyHint({ text }: { text: string }) {
	return (
		<div className="flex h-full items-center justify-center px-6 text-center text-sm text-(--text-3)">
			{text}
		</div>
	);
}

/**
 * 详情面板的"未选中"占位
 *
 * 比单纯一行文字更有产品感：把键盘提示也铺出来，让用户看到"我可以怎么操作"。
 */
function EmptyDetail() {
	const { t } = useTranslation();
	return (
		<div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
			<div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-(--line) bg-(--bg-elev-2) text-(--text-3)">
				<KeyRound size={20} strokeWidth={1.2} />
			</div>
			<div className="flex flex-col gap-1">
				<p className="text-[13px] text-(--text-2)">{t("detail_empty")}</p>
				<p className="text-[11.5px] text-(--text-4)">
					{t("vault_kbd_navigate")}
				</p>
			</div>
			<div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 pt-2">
				<KbdHint
					keys={formatShortcut(SHORTCUTS.COPY_PASSWORD)}
					label={t("vault_kbd_copy_pw_label")}
				/>
				<KbdSep />
				<KbdHint
					keys={formatShortcut(SHORTCUTS.COPY_USERNAME)}
					label={t("vault_kbd_copy_user_label")}
				/>
				<KbdSep />
				<KbdHint
					keys={formatShortcut(SHORTCUTS.NEW_ITEM)}
					label={t("vault_kbd_new_label")}
				/>
			</div>
		</div>
	);
}

// 底栏式快捷键提示：kbd 小方块 + 标签文字，提示之间用统一的中点分隔
//
// 设计意图：
//   - 之前每条提示是一个胶囊外框（rounded-full + border），三个胶囊横排
//     看起来像三个独立的小按钮；而内部又有 ↑↓ · ⏎ 这种自带分隔符的混排，
//     节奏感凌乱（外框是分隔，内部又是分隔，双重切割）。
//   - 改为底栏惯用语：kbd 块（语义化 + 真按键观感）+ 普通标签文字，
//     条目之间用 `·` 中点分隔。整体读起来是一句"提示语"而不是"按钮组"。
//   - 与底部状态栏（条数 / 锁定）、详情顶部元数据档位一致，全站节奏统一。
function KbdChip({ keys }: { keys: string }) {
	return (
		<kbd className="inline-flex h-4.5 items-center rounded-sm border border-(--line) bg-(--bg-elev-2) px-1.5 font-mono text-[10.5px] leading-none tracking-wider text-(--text-2)">
			{keys}
		</kbd>
	);
}

function KbdHint({ keys, label }: { keys: string; label: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-[11.5px] text-(--text-2)">
			<KbdChip keys={keys} />
			<span>{label}</span>
		</span>
	);
}

function KbdSep() {
	return (
		<span aria-hidden className="text-(--text-4) select-none">
			·
		</span>
	);
}

// ---------------------------------------------------------------------------
// 子组件：详情面板
// ---------------------------------------------------------------------------

function VaultDetail({
	summary,
	detail,
	revealPassword,
	onToggleReveal,
	onCopy,
	copiedAt,
	onDelete,
	onEdit,
}: {
	summary: VaultItemSummary;
	detail: VaultItemPayload | undefined;
	revealPassword: boolean;
	onToggleReveal: () => void;
	onCopy: (field: string, value: string) => void;
	copiedAt: Record<string, number>;
	onDelete: () => void;
	onEdit: () => void;
}) {
	const { t } = useTranslation();

	const username = fieldStr(detail?.fields, "username");
	const password = fieldStr(detail?.fields, "password");
	const url = fieldStr(detail?.fields, "url");
	const notes = fieldStr(detail?.fields, "notes");

	const justCopied = (key: string) => Boolean(copiedAt[key]);
	const glyph = (Array.from(summary.name)[0] ?? "·").toUpperCase();
	const TypeIcon = TYPE_ICONS[summary.type] ?? LogInIcon;

	return (
		<div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-8">
			{/* 头部：glyph + name + 类型 + 编辑/删除按钮 */}
			<div className="flex items-start justify-between gap-4">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-(--radius) border border-(--line) bg-(--bg-elev-2) font-mono text-lg font-semibold text-(--text)">
						{glyph}
						{/* 类型角标：用 --bg-elev 与右栏主区同色，视觉上像"穿透"
						 * 字形卡片露出底层主区，比之前的 --bg 与画布同色更克制。 */}
						<span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-md border border-(--line) bg-(--bg-elev) text-(--text-2)">
							<TypeIcon size={11} strokeWidth={1.5} />
						</span>
					</div>
					<div className="min-w-0 flex-1">
						<div className="truncate text-xl font-semibold tracking-tight text-(--text)">
							{summary.name}
						</div>
						<div className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
							{t(typeLabelKey(summary.type))} ·{" "}
							{relativeTime(summary.updatedAt)}
						</div>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						variant="secondary"
						size="sm"
						onClick={onEdit}
						aria-label={t("edit_btn")}
						title={t("edit_btn")}
						leftIcon={<Pencil size={12} strokeWidth={1.5} />}
					>
						{t("edit_btn")}
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => onDelete()}
						aria-label={t("detail_delete")}
						title={t("detail_delete")}
					>
						<Trash2 size={14} strokeWidth={1.5} />
					</Button>
				</div>
			</div>

			{/* fields 区 —— 详情未加载时显示骨架 */}
			{!detail ? (
				<div className="text-sm text-(--text-3)">{t("vault_loading")}</div>
			) : (
				<div className="flex flex-col gap-3">
					{/* Username */}
					{username && (
						<DetailField
							label={t("detail_username")}
							value={username}
							copyable
							copied={justCopied("username")}
							onCopy={() => onCopy("username", username)}
						/>
					)}

					{/* Password —— 默认隐藏，需点 reveal 才显示明文 */}
					{password && (
						<div className="flex flex-col gap-1.5">
							<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
								{t("detail_password")}
							</span>
							<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5">
								<KeyRound
									size={13}
									strokeWidth={1.5}
									className="shrink-0 text-(--text-3)"
								/>
								<span className="zpass-selectable flex-1 truncate font-mono text-sm text-(--text)">
									{revealPassword
										? password
										: "•".repeat(Math.min(password.length, 16))}
								</span>
								<Button
									variant="ghost"
									size="icon"
									onClick={onToggleReveal}
									aria-label={
										revealPassword ? t("detail_hide") : t("detail_reveal")
									}
									title={revealPassword ? t("detail_hide") : t("detail_reveal")}
								>
									{revealPassword ? (
										<EyeOff size={13} strokeWidth={1.5} />
									) : (
										<Eye size={13} strokeWidth={1.5} />
									)}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onCopy("password", password)}
									title={t("detail_copy")}
									leftIcon={<Copy size={12} strokeWidth={1.5} />}
								>
									{justCopied("password")
										? t("detail_copied")
										: t("detail_copy")}
								</Button>
							</div>
							{/*
								密码强度迷你条 —— 仅在 reveal 时显示，避免暗示
								"未显示密码也能被反推强度"的歧义
							*/}
							{revealPassword && (
								<PasswordStrength password={password} size="sm" />
							)}
						</div>
					)}

					{/* TOTP 一次性验证码 ——
					 *
					 * 触发条件：当前条目存在 fields["totp"]（无论是 login 还是
					 * 独立的 totp 类型）。组件内部每秒更新倒计时、周期切换时
					 * 自动重拉新码，密钥不离后端。复制反馈由 TotpField 内部
					 * 走 useUIStore.pushToast，不依赖外层 onCopy。
					 */}
					{Boolean(fieldStr(detail.fields, "totp")) && (
						<TotpField itemId={summary.id} />
					)}

					{/* URL */}
					{url && (
						<DetailField
							label={t("detail_url")}
							value={url}
							copyable
							copied={justCopied("url")}
							onCopy={() => onCopy("url", url)}
						/>
					)}

					{/* Notes —— 多行展示 */}
					{notes && (
						<div className="flex flex-col gap-1.5">
							<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
								{t("detail_notes")}
							</span>
							<div className="zpass-selectable rounded-(--radius) border border-(--line) bg-(--bg-elev-2) p-3 text-sm whitespace-pre-wrap text-(--text-2)">
								{notes}
							</div>
						</div>
					)}

					{/* 其它非 login 类型的字段 —— 通用渲染
					 *
					 * 排除：
					 *   - 已显式渲染的内置 key（username/password/url/notes/fav）
					 *   - TOTP 密钥（totp）—— 已被 <TotpField> 替换为实时验证码
					 *   - 自定义字段保留键（_customFields，由下方独立 section 渲染）
					 */}
					{summary.type !== "login" &&
						Object.entries(detail.fields)
							.filter(
								([k, v]) =>
									typeof v === "string" &&
									v.length > 0 &&
									![
										"username",
										"password",
										"url",
										"notes",
										"fav",
										"totp",
										"privateKeyPkcs8",
										"publicKeyCose",
										"publicKeySpki",
										"schema",
										"createdBy",
										"coseAlgorithm",
										"transports",
										"userVerification",
										"residentKey",
										"attestationFormat",
									].includes(k) &&
									k !== CUSTOM_FIELDS_KEY,
							)
							.map(([k, v]) => (
								<DetailField
									key={k}
									label={k.toUpperCase()}
									value={String(v)}
									mono
									copyable
									copied={justCopied(k)}
									onCopy={() => onCopy(k, String(v))}
								/>
							))}

					{/* 自定义字段 —— 与 Bitwarden 风格一致，独立成段在最后展示 */}
					<CustomFieldsView
						fields={parseCustomFields(detail.fields)}
						copiedAt={copiedAt}
						onCopy={onCopy}
					/>
				</div>
			)}

			{/* 键盘提示尾栏：底栏式排版，kbd + 标签 + 中点分隔
			 *
			 * 按键文本由 formatShortcut() 按平台渲染：
			 *   - mac:    ⌘⇧C / ⌘B / ↑↓ ⏎
			 *   - win/linux: Ctrl+Shift+C / Ctrl+B / ↑↓ ⏎
			 * "导航 / 打开" 这一组没有修饰键，三个键名直接拼接展示。
			 */}
			<div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-(--line-soft) pt-4">
				<KbdHint
					keys={formatShortcut(SHORTCUTS.COPY_PASSWORD)}
					label={t("vault_kbd_copy_pw_label")}
				/>
				<KbdSep />
				<KbdHint
					keys={formatShortcut(SHORTCUTS.COPY_USERNAME)}
					label={t("vault_kbd_copy_user_label")}
				/>
				<KbdSep />
				<KbdHint
					keys={`${KEY_SYMBOL.up}${KEY_SYMBOL.down} ${KEY_SYMBOL.enter}`}
					label={t("vault_kbd_open_label")}
				/>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 子组件：单值字段（带复制按钮）
// ---------------------------------------------------------------------------

function DetailField({
	label,
	value,
	copyable,
	copied,
	onCopy,
	mono,
}: {
	label: string;
	value: string;
	copyable?: boolean;
	copied?: boolean;
	onCopy?: () => void;
	mono?: boolean;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
				{label}
			</span>
			<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5">
				<span
					className={
						mono
							? "zpass-selectable flex-1 truncate font-mono text-sm text-(--text)"
							: "zpass-selectable flex-1 truncate text-sm text-(--text)"
					}
				>
					{value}
				</span>
				{copyable && onCopy && (
					<Button
						variant="ghost"
						size="sm"
						onClick={onCopy}
						leftIcon={<Copy size={12} strokeWidth={1.5} />}
					>
						{copied ? t("detail_copied") : t("detail_copy")}
					</Button>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 子组件：自定义字段（详情态，只读）
// ---------------------------------------------------------------------------
//
// 4 种类型的展示规则：
//   text     普通字符串 + 复制按钮
//   hidden   默认遮蔽 + reveal 切换 + 复制按钮（与 Password 同款体验）
//   boolean  显示开/关勾选标记，无复制按钮
//   linked   显示 "→ <关联键名>"，无复制按钮，前面带链接图标暗示语义

function CustomFieldsView({
	fields,
	copiedAt,
	onCopy,
}: {
	fields: CustomField[];
	copiedAt: Record<string, number>;
	onCopy: (field: string, value: string) => void;
}) {
	const { t } = useTranslation();
	if (fields.length === 0) return null;
	return (
		<div className="mt-2 flex flex-col gap-3 border-t border-(--line-soft) pt-4">
			<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
				{t("custom_fields_section")}
			</span>
			{fields.map((f) => (
				<CustomFieldRow
					key={f.id}
					field={f}
					copied={Boolean(copiedAt[`cf:${f.id}`])}
					onCopy={(v) => onCopy(`cf:${f.id}`, v)}
				/>
			))}
		</div>
	);
}

function CustomFieldRow({
	field,
	copied,
	onCopy,
}: {
	field: CustomField;
	copied: boolean;
	onCopy: (value: string) => void;
}) {
	const { t } = useTranslation();
	const [reveal, setReveal] = useState(false);
	const label = field.name || t("custom_fields_unnamed");

	if (field.type === "boolean") {
		const on = Boolean(field.value);
		return (
			<div className="flex flex-col gap-1.5">
				<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
					{label}
				</span>
				<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5">
					<span
						className={clsx(
							"inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
							on
								? "border-(--text) bg-(--text) text-(--bg)"
								: "border-(--line) text-(--text-4)",
						)}
						aria-hidden
					>
						{on ? "✓" : ""}
					</span>
					<span className="text-sm text-(--text-2)">
						{on ? t("custom_fields_bool_on") : t("custom_fields_bool_off")}
					</span>
				</div>
			</div>
		);
	}

	if (field.type === "linked") {
		const target =
			typeof field.value === "string" && field.value
				? field.value
				: t("custom_fields_link_none");
		return (
			<div className="flex flex-col gap-1.5">
				<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
					{label}
				</span>
				<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5">
					<KeyRound
						size={13}
						strokeWidth={1.5}
						className="shrink-0 text-(--text-3)"
					/>
					<span className="zpass-selectable font-mono text-sm text-(--text-2)">
						→ {target}
					</span>
				</div>
			</div>
		);
	}

	// text / hidden 都是字符串
	const raw = typeof field.value === "string" ? field.value : "";
	const isHidden = field.type === "hidden";
	const display =
		isHidden && !reveal ? "•".repeat(Math.min(raw.length, 16)) : raw;
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
				{label}
			</span>
			<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5">
				<span className="zpass-selectable flex-1 truncate font-mono text-sm text-(--text)">
					{display}
				</span>
				{isHidden && (
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setReveal((s) => !s)}
						aria-label={reveal ? t("detail_hide") : t("detail_reveal")}
						title={reveal ? t("detail_hide") : t("detail_reveal")}
					>
						{reveal ? (
							<EyeOff size={13} strokeWidth={1.5} />
						) : (
							<Eye size={13} strokeWidth={1.5} />
						)}
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onCopy(raw)}
					title={t("detail_copy")}
					leftIcon={<Copy size={12} strokeWidth={1.5} />}
				>
					{copied ? t("detail_copied") : t("detail_copy")}
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 子组件：新建 / 编辑条目对话框（统一）
// ---------------------------------------------------------------------------
//
// mode = "new"：从空白开始，类型由 presetType prop 决定（来自侧边栏当前
//                分类），用户不可在 dialog 内切换；提交调 store.create
// mode = "edit"：基于 existing payload 填充，类型锁定到 existing.type，提交调 store.update
//
// 字段结构通过 FIELDS_BY_TYPE 表驱动；secret 字段自带 reveal toggle，且
// 在 login.password 上额外显示密码强度条和"⚡ 生成"按钮。
//
// 校验：name + 所有 required 字段必填。
//
// Esc 关闭、外层 backdrop 点击关闭、表单内部 click/keydown 阻止冒泡。

function ItemDialog({
	mode,
	existing,
	presetType,
	onClose,
}: {
	mode: "new" | "edit";
	existing?: VaultItemPayload;
	/**
	 * 新建模式下的预设 type。来自 VaultPage 在打开瞬间根据当前 filter
	 * 推导的快照（filter=card → "card"，filter=all/fav → "login"）。
	 * 仅 mode === "new" 时有意义；edit 模式下 type 始终锁定到 existing.type。
	 */
	presetType?: VaultItemType;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const create = useVaultStore((s) => s.create);
	const update = useVaultStore((s) => s.update);
	const load = useVaultStore((s) => s.load);
	const selectItem = useVaultStore((s) => s.selectItem);
	const pushToast = useUIStore((s) => s.pushToast);

	// 类型决策优先级：edit 模式锁定 existing.type > new 模式 presetType > 兜底 login
	//
	// 这里故意用 const 派生量而非 useState：
	//   - edit 模式：existing.type 在 dialog 生命周期里不会变
	//   - new 模式：VaultPage 在打开 dialog 前才 setPresetType，dialog 关闭后
	//     才会被卸载并重建实例，期间 presetType prop 引用稳定
	//   既然不存在"对话框打开后类型还要变"的合法路径（用户已无切换 UI），
	//   就不应让 useState 引入"初始值快照"的歧义。
	const type: VaultItemType = existing?.type ?? presetType ?? "login";
	// name
	const [name, setName] = useState(existing?.name ?? "");
	// fields —— 用 Record<string, string> 存所有字段值，渲染时按 type 取需要的
	const initialFields = useMemo(() => {
		const obj: Record<string, string> = {};
		if (existing?.fields) {
			for (const [k, v] of Object.entries(existing.fields)) {
				if (typeof v === "string") obj[k] = v;
			}
		}
		return obj;
	}, [existing]);
	const [fields, setFields] = useState<Record<string, string>>(initialFields);

	// 自定义字段（独立于 fields） —— 编辑期内全量在内存维护，提交时序列化到
	// fields[_customFields]
	const initialCustomFields = useMemo<CustomField[]>(
		() => parseCustomFields(existing?.fields),
		[existing],
	);
	const [customFields, setCustomFields] =
		useState<CustomField[]>(initialCustomFields);

	// 每个 secret 字段独立的 reveal 状态
	const [revealMap, setRevealMap] = useState<Record<string, boolean>>({});

	// SSH 专属：生成 / 导入模式切换
	//
	// - "generate"：默认，用 SshKeyGeneratorPanel 生成、自动填 private_key / public_key
	// - "import"：导入模式，仅在这种模式下才展示 private_key / passphrase 字段
	//
	// 编辑 mode 下不启用（已存条目是导入态表现，让用户能看到 / 修改私钥）。
	const [sshKeyMode, setSshKeyMode] = useState<"generate" | "import">(
		mode === "new" && type === "ssh" ? "generate" : "import",
	);

	const [loading, setLoading] = useState(false);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	// QR 扫码面板展开状态 —— 仅在 totp 字段下方展示。
	//
	// 那些可能存在多个 totp 字段的场景（1Password 可以一个条目存多个，
	// 但 ZPass 目前 login / totp 两种类型都只有1 个 totp 字段）现阶段
	// 不需考虑，用 boolean 即可。
	const [qrPanelOpen, setQrPanelOpen] = useState(false);

	const nameRef = useRef<HTMLInputElement>(null);

	// 注：以下两件事现在由 Radix Dialog 自动接管，不再需要手写：
	//   - Esc 关闭：Radix Dialog 内置（onOpenChange 收到 false）
	//   - 焦点初始化：用 onOpenAutoFocus 把焦点指到 name 输入框
	// 移除原 window.addEventListener("keydown") 的 Esc 监听，避免与 Radix
	// 的 DismissableLayer 重复处理。

	const fieldDefs = FIELDS_BY_TYPE[type];

	const setField = useCallback(
		(k: string, v: string) => setFields((p) => ({ ...p, [k]: v })),
		[],
	);

	const toggleReveal = (k: string) =>
		setRevealMap((p) => ({ ...p, [k]: !p[k] }));

	/**
	 * 应用二维码识别结果到当前表单
	 *
	 * 填充策略：
	 *   1. totp 字段 → 写完整 otpauth:// URI（不是裸 secret），让后端
	 *      parseOtpauthURI 能拿到所有元信息（algorithm/digits/period/
	 *      counter/Steam 标记）
	 *   2. 仅独立 totp 条目才填 issuer / account：
	 *        - 字段为空 → 填充
	 *        - 已有值 → 不覆盖（尊重用户输入）
	 *   3. 若条目 name 为空，用 "issuer·account" 拼一个默认名（体验优化：
	 *      扫完码就不用再手输名称）
	 */
	const applyQrResult = useCallback(
		(uri: string, meta: OtpauthMeta) => {
			setField("totp", uri);
			if (type === "totp") {
				if (meta.issuer && !fields.issuer) setField("issuer", meta.issuer);
				if (meta.account && !fields.account) setField("account", meta.account);
			}
			if (!name.trim()) {
				const guess =
					meta.issuer && meta.account
						? `${meta.issuer} · ${meta.account}`
						: meta.issuer || meta.account;
				if (guess) setName(guess);
			}
		},
		[type, name, fields.issuer, fields.account, setField],
	);

	/**
	 * 内联生成密码 —— 仅作用于 login.password 字段
	 *
	 * 用 DEFAULT_PASSWORD_OPTIONS（length=20, 大小写+数字+符号开），生成
	 * 一个高强度密码直接填进字段。生成后默认 reveal=true 让用户看到刚生成
	 * 的内容，提升信任感。
	 */
	const onGeneratePassword = (k: string) => {
		const pw = generatePassword(DEFAULT_PASSWORD_OPTIONS);
		setField(k, pw);
		setRevealMap((p) => ({ ...p, [k]: true }));
		pushToast({ text: t("toast_generated"), icon: "check" });
	};

	// ----- 自定义字段操作 -----
	const linkable = LINKABLE_FIELDS_BY_TYPE[type] ?? [];
	const addCustomField = (cfType: CustomFieldType) => {
		const initial: CustomField =
			cfType === "boolean"
				? { id: newCustomFieldId(), type: "boolean", name: "", value: false }
				: cfType === "linked"
					? {
							id: newCustomFieldId(),
							type: "linked",
							name: "",
							value: linkable[0] ?? "",
						}
					: { id: newCustomFieldId(), type: cfType, name: "", value: "" };
		setCustomFields((arr) => [...arr, initial]);
	};
	const updateCustomField = (id: string, patch: Partial<CustomField>) => {
		setCustomFields((arr) =>
			arr.map((f) => (f.id === id ? ({ ...f, ...patch } as CustomField) : f)),
		);
	};
	const changeCustomFieldType = (id: string, next: CustomFieldType) => {
		setCustomFields((arr) =>
			arr.map((f) => {
				if (f.id !== id) return f;
				if (next === f.type) return f;
				// 切换类型时按目标形态重置 value
				const value: string | boolean =
					next === "boolean"
						? false
						: next === "linked"
							? (linkable[0] ?? "")
							: "";
				return { ...f, type: next, value };
			}),
		);
	};
	const removeCustomField = (id: string) => {
		setCustomFields((arr) => arr.filter((f) => f.id !== id));
	};

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (loading) return;

		const trimmedName = name.trim();
		if (!trimmedName) {
			setErrorMsg(t("newlogin_err_required"));
			return;
		}

		// 必填校验：所有 def.required 的字段都不能为空
		// 密码 / seed 等不 trim（用户可能刻意空格结尾）
		for (const def of fieldDefs) {
			if (!def.required) continue;
			const v = fields[def.key] ?? "";
			if (!v) {
				setErrorMsg(t("newlogin_err_required"));
				return;
			}
		}

		setErrorMsg(null);
		setLoading(true);
		try {
			// 收集字段：
			//   1) 先把 existing.fields 中"非原生 schema 字段、非自定义字段保留键"
			//      的内容原样保留 —— 防止编辑动作丢失外部插入的扩展字段
			//   2) 再用当前 type 的 schema 字段（无值视为清空）覆写
			//   3) 自定义字段序列化到 _customFields 数组里
			const payloadFields: Record<string, unknown> = {};
			const knownNativeKeys = new Set(fieldDefs.map((d) => d.key));
			if (existing?.fields) {
				for (const [k, v] of Object.entries(existing.fields)) {
					if (k === CUSTOM_FIELDS_KEY) continue;
					if (knownNativeKeys.has(k)) continue;
					payloadFields[k] = v;
				}
			}
			for (const def of fieldDefs) {
				const v = fields[def.key] ?? "";
				if (v) payloadFields[def.key] = v;
			}
			const cfList = serializeCustomFields(customFields);
			if (cfList.length > 0) {
				payloadFields[CUSTOM_FIELDS_KEY] = cfList;
			}

			if (mode === "new" && type === "passkey") {
				const passkey = await vaultApi.createPasskey({
					rpId: String(payloadFields.rpId ?? ""),
					userName: String(payloadFields.userName ?? ""),
					name: trimmedName,
				});
				await load();
				selectItem(passkey.itemId);
				pushToast({ text: t("toast_saved"), icon: "check" });
			} else if (mode === "new") {
				await create({ type, name: trimmedName, fields: payloadFields });
				pushToast({ text: t("toast_saved"), icon: "check" });
			} else if (existing) {
				await update({
					id: existing.id,
					type: existing.type,
					name: trimmedName,
					fields: payloadFields,
				});
				pushToast({ text: t("toast_saved"), icon: "check" });
			}
			onClose();
		} catch (err) {
			setErrorMsg(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	// 注：原"类型 segment"（typeOptions 数组 + 顶部分类按钮组）已移除。
	// 新建条目的类型由侧边栏当前分类决定（VaultPage 打开 dialog 时通过
	// presetType prop 传入），用户不再在 dialog 内手动切换。

	/*
	 * 迁移到 Radix Dialog（2026-04 review）：
	 * ---------------------------------------------------------------------
	 * 旧实现是手写的 backdrop button + form：
	 *   - 自建 <button absolute inset-0> 处理"点背景关闭"
	 *   - form 里手写 stopPropagation 阻止冒泡
	 *   - 自挂 keydown 监听处理 Esc
	 *   - 缺 focus trap、缺 aria-modal、缺 body scroll lock
	 *
	 * Radix Dialog 把这堆事一次性接管：
	 *   - DismissableLayer 处理外部点击 / Esc
	 *   - FocusScope 提供 focus trap（onOpenAutoFocus 控制初始焦点）
	 *   - 自动 aria-modal / aria-labelledby（指向 Dialog.Title 的 id）
	 *   - body scroll lock（modal=true 默认）
	 *
	 * Portal 仍挂到 #portal-root（与 Select / DropdownMenu 一致），避开
	 * #root 上的 zoom 子树，避免缩放档位下定位偏移。
	 */

	return (
		<RadixDialog.Root
			open
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
		>
			<RadixDialog.Portal
				container={
					typeof document !== "undefined"
						? document.getElementById("portal-root")
						: null
				}
			>
				<RadixDialog.Overlay
					className={clsx(
						"fixed inset-0 z-50 zpass-backdrop",
						"data-[state=open]:animate-[zpass-overlay-in_140ms_ease-out]",
					)}
				/>
				<RadixDialog.Content
					onOpenAutoFocus={(e) => {
						// 阻止 Radix 默认把焦点放到首个可聚焦元素（关闭按钮）；
						// 让我们自己把焦点指到 name 输入框
						e.preventDefault();
						nameRef.current?.focus();
						nameRef.current?.select();
					}}
					aria-describedby={undefined}
					className={clsx(
						"fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
						// 三段布局：固定头部 + 滚动主体 + 固定底部
						//   - overflow-hidden 确保滚动只发生在内部 scroll 区
						//   - max-h 限制整体不超过视口
						//   - 不再设全局 padding，padding 下放到三段各自维护
						"w-full max-w-lg max-h-[88vh] overflow-hidden",
						"zpass-glass rounded-xl shadow-lg",
						"flex flex-col",
						"data-[state=open]:animate-[zpass-dialog-in_180ms_ease-out]",
						"focus:outline-none",
					)}
				>
					<form onSubmit={onSubmit} className="contents">
						{/* 头部（固定，不随内容滚动）
						 * 紧凑化：
						 *   - 标题字号下调 lg→base，与底部按钮文字大小同级
						 *   - 主副标题 gap 由 1→0.5，减少呼吸
						 *   - 整体内边距由 px-7 pt-7 pb-4 → px-6 pt-5 pb-3.5
						 *   - 关闭按钮微调垂直对齐到副标题中线（-mt-0.5）
						 */}
						<div className="flex shrink-0 items-start justify-between gap-3 border-b border-(--line-soft) px-6 pt-5 pb-3.5">
							<div className="flex flex-col gap-0.5">
								<RadixDialog.Title className="text-[15px] font-semibold tracking-tight text-(--text)">
									{mode === "new"
										? t("newitem_title", { type: t(typeLabelKey(type)) })
										: t("edit_title")}
								</RadixDialog.Title>
								<RadixDialog.Description className="text-[11.5px] leading-snug text-(--text-3)">
									{mode === "new" ? t("newlogin_sub") : t("edit_sub")}
								</RadixDialog.Description>
							</div>
							<RadixDialog.Close asChild>
								<Button
									variant="ghost"
									size="icon"
									aria-label={t("common_close")}
									className="-mt-0.5 -mr-1.5"
								>
									<X size={14} strokeWidth={1.5} />
								</Button>
							</RadixDialog.Close>
						</div>

						{/* 中间：可滚动主体
						 *   - flex-1 + min-h-0 让它在 flex-col 容器里能正确收缩并出现滚动条
						 *   - overflow-y-auto 仅在此区生效，标题/底部不会被一起滚走
						 *   - gap 与内边距与原版一致，避免视觉位移
						 */}
						<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-7 py-5">
							{/* 原"条目类型"选择行已删除：类型由侧边栏分类决定，dialog 内不再可切换 */}

							{/* 字段：name */}
							<DialogField label={t("newlogin_name")}>
								<input
									ref={nameRef}
									type="text"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder={t("newlogin_name_placeholder")}
									maxLength={120}
									className="w-full border-0 bg-transparent text-sm text-(--text) outline-none placeholder:text-(--text-4)"
								/>
							</DialogField>

							{/* SSH 专属：生成 / 导入 mode 切换 + 生成器面板 */}
							{type === "ssh" && mode === "new" && (
								<SshKeyDialogSection
									mode={sshKeyMode}
									onModeChange={setSshKeyMode}
									itemName={name}
									fields={fields}
									setField={setField}
								/>
							)}

							{/* 按 type 渲染所有字段 */}
							{fieldDefs.map((def) => {
								// SSH 生成模式：隐藏 private_key / passphrase 字段
								// （以及 public_key、如果有）—— 这些由生成器对话填入
								if (
									type === "ssh" &&
									mode === "new" &&
									sshKeyMode === "generate" &&
									(def.key === "private_key" ||
										def.key === "passphrase" ||
										def.key === "public_key")
								) {
									return null;
								}

								const value = fields[def.key] ?? "";
								const reveal = revealMap[def.key] ?? false;
								const labelText = `${t(def.labelKey)}${def.required ? "" : ` · ${t("common_optional")}`}`;
								const placeholder = def.placeholderKey
									? t(def.placeholderKey)
									: undefined;

								if (def.kind === "textarea") {
									// SSH 私钥 —— 默认折叠，与生成态体验一致。
									// 防止「肩叔叔偷窥」+ 避免用户误在分享屏幕时裸露。
									const isSshPrivateKey =
										type === "ssh" && def.key === "private_key";
									if (isSshPrivateKey) {
										return (
											<div key={def.key} className="flex flex-col gap-1.5">
												<div className="flex items-center justify-between">
													<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
														{labelText}
													</span>
													<div className="flex items-center gap-1">
														<Button
															type="button"
															variant="ghost"
															size="sm"
															onClick={() => toggleReveal(def.key)}
															aria-label={
																reveal ? t("detail_hide") : t("detail_reveal")
															}
															title={
																reveal ? t("detail_hide") : t("detail_reveal")
															}
														>
															{reveal ? (
																<EyeOff size={11} strokeWidth={1.5} />
															) : (
																<Eye size={11} strokeWidth={1.5} />
															)}
														</Button>
														{value && (
															<Button
																type="button"
																variant="ghost"
																size="sm"
																onClick={() => writeClipboard(value)}
																aria-label={t("detail_copy")}
																title={t("detail_copy")}
															>
																<Copy size={11} strokeWidth={1.5} />
															</Button>
														)}
													</div>
												</div>
												{reveal || !value ? (
													<textarea
														value={value}
														onChange={(e) => setField(def.key, e.target.value)}
														placeholder={placeholder}
														rows={5}
														className="w-full resize-y rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2 font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4) focus:border-(--text-3)"
													/>
												) : (
													<button
														type="button"
														onClick={() => toggleReveal(def.key)}
														className="flex w-full items-center justify-center rounded-(--radius) border border-dashed border-(--line) bg-(--bg-elev-2) px-3 py-4 text-[12px] text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text-2)"
													>
														{t("sshkey_private_hidden_hint")}
													</button>
												)}
											</div>
										);
									}

									return (
										<div key={def.key} className="flex flex-col gap-1.5">
											<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
												{labelText}
											</span>
											<textarea
												value={value}
												onChange={(e) => setField(def.key, e.target.value)}
												placeholder={placeholder}
												rows={
													def.key === "private_key" || def.key === "seed"
														? 5
														: 3
												}
												className={
													def.mono
														? "w-full resize-y rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2 font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4) focus:border-(--text-3)"
														: "w-full resize-y rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2 text-sm text-(--text) outline-none placeholder:text-(--text-4) focus:border-(--text-3)"
												}
											/>
										</div>
									);
								}

								if (def.kind === "secret") {
									const showGenerator =
										type === "login" && def.key === "password";
									// totp 字段允许从二维码导入。login 类型的 totp 字段 +
									// 独立 totp 类型的 totp 字段都走这个分支。不看 type，
									// 只看 key ） 是因为全部 "totp" 语义的字段都可以从QR 导入。
									const showQrImport = def.key === "totp";
									return (
										<div key={def.key} className="flex flex-col gap-1.5">
											<DialogField label={labelText}>
												<input
													type={reveal ? "text" : "password"}
													value={value}
													onChange={(e) => setField(def.key, e.target.value)}
													placeholder={placeholder}
													autoComplete="new-password"
													className={
														def.mono
															? "flex-1 border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
															: "flex-1 border-0 bg-transparent text-sm text-(--text) outline-none placeholder:text-(--text-4)"
													}
												/>
												{showGenerator && (
													<Button
														type="button"
														variant="secondary"
														size="sm"
														onClick={() => onGeneratePassword(def.key)}
														title={t("newlogin_generate_hint")}
														leftIcon={<Sparkles size={10} strokeWidth={1.5} />}
													>
														{t("newlogin_generate")}
													</Button>
												)}
												{showQrImport && (
													<Button
														type="button"
														variant="ghost"
														size="icon"
														onClick={() => setQrPanelOpen((v) => !v)}
														aria-label={t("qr_btn_label")}
														aria-expanded={qrPanelOpen}
														title={t("qr_btn_label")}
													>
														<QrCode size={13} strokeWidth={1.5} />
													</Button>
												)}
												<Button
													type="button"
													variant="ghost"
													size="icon"
													onClick={() => toggleReveal(def.key)}
													aria-label={
														reveal ? t("detail_hide") : t("detail_reveal")
													}
													title={reveal ? t("detail_hide") : t("detail_reveal")}
												>
													{reveal ? (
														<EyeOff size={13} strokeWidth={1.5} />
													) : (
														<Eye size={13} strokeWidth={1.5} />
													)}
												</Button>
											</DialogField>
											{/* 仅 login.password 显示强度条 */}
											{showGenerator && value && (
												<PasswordStrength password={value} size="sm" />
											)}
											{/* totp 字段展开的二维码扫描面板 */}
											{showQrImport && qrPanelOpen && (
												<QrScannerPanel
													onClose={() => setQrPanelOpen(false)}
													onApply={applyQrResult}
												/>
											)}
										</div>
									);
								}

								// "text" 与 "url" 共用普通 input 渲染
								return (
									<DialogField key={def.key} label={labelText}>
										<input
											type="text"
											value={value}
											onChange={(e) => setField(def.key, e.target.value)}
											placeholder={placeholder}
											autoComplete="off"
											className={
												def.mono
													? "w-full border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
													: "w-full border-0 bg-transparent text-sm text-(--text) outline-none placeholder:text-(--text-4)"
											}
										/>
									</DialogField>
								);
							})}

							{/* 自定义字段编辑区 —— 参考 Bitwarden，统一在原生字段下方 */}
							<CustomFieldsEditor
								fields={customFields}
								linkable={linkable}
								onAdd={addCustomField}
								onChangeType={changeCustomFieldType}
								onUpdate={updateCustomField}
								onRemove={removeCustomField}
							/>

							{/* 错误提示 */}
							{errorMsg && (
								<div className="flex items-start gap-1.5 text-xs leading-relaxed text-(--danger)">
									<span>{errorMsg}</span>
								</div>
							)}
						</div>
						{/* /中间可滚动主体结束 */}

						{/* 底部操作按钮（固定，不随内容滚动） */}
						<div className="flex shrink-0 items-center justify-end gap-2 border-t border-(--line-soft) px-7 py-4">
							<RadixDialog.Close asChild>
								<Button variant="secondary" size="md">
									{mode === "new" ? t("newlogin_cancel") : t("edit_cancel")}
								</Button>
							</RadixDialog.Close>
							<Button
								type="submit"
								variant="default"
								size="md"
								loading={loading}
							>
								{loading
									? mode === "new"
										? t("newlogin_saving")
										: t("edit_saving")
									: mode === "new"
										? t("newlogin_save")
										: t("edit_save")}
							</Button>
						</div>
					</form>
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}

// ---------------------------------------------------------------------------
// 子组件：弹层内的字段壳
// ---------------------------------------------------------------------------

function DialogField({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
				{label}
			</span>
			{/* 聚焦色用 --text-3 而不是 --text：light 下 --text 接近纯黑
			 * 会产生"贴脸黑框"，与 VaultPage 搜索框统一为中性灰反馈。 */}
			<div className="flex items-center gap-2 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) px-3 py-2.5 transition-colors focus-within:border-(--text-3)">
				{children}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 子组件：自定义字段编辑器（编辑态，对话框内使用）
// ---------------------------------------------------------------------------
//
// 顶部有 4 个 + 按钮分别新增 4 种类型的字段（与 Bitwarden 一致）。
// 每个字段一行：[类型下拉 | 名称输入 | 值控件 | 删除按钮]。
// 类型切换会重置 value 形态（避免类型不匹配的 stale 值）。

function CustomFieldsEditor({
	fields,
	linkable,
	onAdd,
	onChangeType,
	onUpdate,
	onRemove,
}: {
	fields: CustomField[];
	linkable: string[];
	onAdd: (type: CustomFieldType) => void;
	onChangeType: (id: string, type: CustomFieldType) => void;
	onUpdate: (id: string, patch: Partial<CustomField>) => void;
	onRemove: (id: string) => void;
}) {
	const { t } = useTranslation();

	const linkedDisabled = linkable.length === 0;

	// 下拉菜单中的字段类型选项
	// ---------------------------------------------------------------------
	// 用「场景化」命名替代原来的「文本/隐藏/开关/关联」单字短语 ——
	// 单看短词用户很难知道「隐藏」是什么、「关联」关联什么。
	// 现在每一项都给出更直观的主标签 + 一句话副描述，并配图标，
	// 让用户一眼能看懂用途。底层枚举值（text/hidden/boolean/linked）保持不变。
	const typeOptions: Array<{
		type: CustomFieldType;
		icon: ReactNode;
		disabled?: boolean;
	}> = [
		{ type: "text", icon: <TypeIcon size={13} strokeWidth={1.5} /> },
		{ type: "hidden", icon: <EyeOff size={13} strokeWidth={1.5} /> },
		{ type: "boolean", icon: <ToggleRight size={13} strokeWidth={1.5} /> },
		{
			type: "linked",
			icon: <Link2 size={13} strokeWidth={1.5} />,
			disabled: linkedDisabled,
		},
	];

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-center justify-between gap-2">
				<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
					{t("custom_fields_section")}
				</span>

				<DropdownMenu.Root modal={false}>
					<DropdownMenu.Trigger asChild>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							leftIcon={<Plus size={10} strokeWidth={1.5} />}
							rightIcon={<ChevronDown size={10} strokeWidth={1.5} />}
						>
							{t("custom_fields_add")}
						</Button>
					</DropdownMenu.Trigger>

					<DropdownMenu.Portal
						container={
							typeof document !== "undefined"
								? document.getElementById("portal-root")
								: null
						}
					>
						<DropdownMenu.Content
							align="end"
							sideOffset={6}
							collisionPadding={8}
							className={clsx(
								"z-50 min-w-64 zpass-glass rounded-(--radius) shadow-md p-1",
								"outline-none",
								"origin-(--radix-dropdown-menu-content-transform-origin)",
								"transition-[opacity,transform] duration-100 ease-out",
								"data-[state=open]:scale-100 data-[state=open]:opacity-100",
								"data-[state=closed]:scale-95 data-[state=closed]:opacity-0",
							)}
						>
							{typeOptions.map((opt) => {
								const label = t(`custom_fields_add_${opt.type}_label`);
								const desc = t(`custom_fields_add_${opt.type}_desc`);
								// linked 在不可用时给一句解释作为副文案
								const description = opt.disabled
									? t("custom_fields_link_unavailable")
									: desc;
								return (
									<DropdownMenu.Item
										key={opt.type}
										disabled={opt.disabled}
										onSelect={() => {
											if (!opt.disabled) onAdd(opt.type);
										}}
										className={clsx(
											"flex cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 text-[13px] outline-none transition-colors",
											"text-(--text-2)",
											"hover:bg-(--bg-hover) hover:text-(--text)",
											"focus:bg-(--bg-hover) focus:text-(--text)",
											"data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[disabled]:hover:bg-transparent",
										)}
									>
										<span className="mt-0.5 shrink-0 text-(--text-3)">
											{opt.icon}
										</span>
										<span className="flex min-w-0 flex-col gap-0.5">
											<span className="leading-tight">{label}</span>
											<span className="text-[11px] leading-tight text-(--text-3)">
												{description}
											</span>
										</span>
									</DropdownMenu.Item>
								);
							})}
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
			{fields.length === 0 ? (
				<div className="rounded-(--radius) border border-dashed border-(--line) px-3 py-3 text-center text-xs text-(--text-3)">
					{t("custom_fields_empty")}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{fields.map((f) => (
						<CustomFieldEditorRow
							key={f.id}
							field={f}
							linkable={linkable}
							onChangeType={(type) => onChangeType(f.id, type)}
							onUpdate={(patch) => onUpdate(f.id, patch)}
							onRemove={() => onRemove(f.id)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function CustomFieldEditorRow({
	field,
	linkable,
	onChangeType,
	onUpdate,
	onRemove,
}: {
	field: CustomField;
	linkable: string[];
	onChangeType: (type: CustomFieldType) => void;
	onUpdate: (patch: Partial<CustomField>) => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation();
	const [reveal, setReveal] = useState(false);

	const baseInput =
		"flex-1 border-0 bg-transparent text-sm text-(--text) outline-none placeholder:text-(--text-4)";

	return (
		<div className="flex flex-col gap-1.5 rounded-(--radius) border border-(--line) bg-(--bg-elev-2) p-2.5">
			{/* 顶部：类型选择 + 名称 + 删除 */}
			<div className="flex items-center gap-2">
				<select
					value={field.type}
					onChange={(e) => onChangeType(e.target.value as CustomFieldType)}
					className="rounded-(--radius) border border-(--line) bg-(--bg) px-2 py-1 font-mono text-[11px] text-(--text-2) outline-none focus:border-(--text-3)"
					title={t(`custom_fields_type_${field.type}`)}
				>
					{CUSTOM_FIELD_TYPES.map((tp) => (
						<option key={tp} value={tp}>
							{t(`custom_fields_type_${tp}`)}
						</option>
					))}
				</select>
				<input
					type="text"
					value={field.name}
					onChange={(e) => onUpdate({ name: e.target.value })}
					placeholder={t("custom_fields_name_placeholder")}
					maxLength={120}
					className="flex-1 border-0 bg-transparent text-sm text-(--text) outline-none placeholder:text-(--text-4)"
				/>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onRemove}
					aria-label={t("custom_fields_remove")}
					title={t("custom_fields_remove")}
				>
					<Trash2 size={13} strokeWidth={1.5} />
				</Button>
			</div>
			{/* 底部：按字段类型渲染值控件 */}
			<div className="flex items-center gap-2 border-t border-(--line-soft) pt-2">
				{field.type === "text" && (
					<input
						type="text"
						value={typeof field.value === "string" ? field.value : ""}
						onChange={(e) => onUpdate({ value: e.target.value })}
						placeholder={t("custom_fields_value_placeholder")}
						autoComplete="off"
						className={baseInput}
					/>
				)}
				{field.type === "hidden" && (
					<>
						<input
							type={reveal ? "text" : "password"}
							value={typeof field.value === "string" ? field.value : ""}
							onChange={(e) => onUpdate({ value: e.target.value })}
							placeholder={t("custom_fields_value_placeholder")}
							autoComplete="new-password"
							className={`${baseInput} font-mono`}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={() => setReveal((s) => !s)}
							aria-label={reveal ? t("detail_hide") : t("detail_reveal")}
							title={reveal ? t("detail_hide") : t("detail_reveal")}
						>
							{reveal ? (
								<EyeOff size={13} strokeWidth={1.5} />
							) : (
								<Eye size={13} strokeWidth={1.5} />
							)}
						</Button>
					</>
				)}
				{field.type === "boolean" && (
					<label className="flex cursor-pointer items-center gap-2 text-sm text-(--text-2)">
						<input
							type="checkbox"
							checked={Boolean(field.value)}
							onChange={(e) => onUpdate({ value: e.target.checked })}
							className="h-4 w-4 cursor-pointer accent-(--text)"
						/>
						<span>
							{field.value
								? t("custom_fields_bool_on")
								: t("custom_fields_bool_off")}
						</span>
					</label>
				)}
				{field.type === "linked" &&
					(linkable.length === 0 ? (
						<span className="text-xs text-(--text-3)">
							{t("custom_fields_link_unavailable")}
						</span>
					) : (
						<select
							value={typeof field.value === "string" ? field.value : ""}
							onChange={(e) => onUpdate({ value: e.target.value })}
							className="flex-1 rounded-(--radius) border border-(--line) bg-(--bg) px-2 py-1 font-mono text-[12px] text-(--text-2) outline-none focus:border-(--text-3)"
						>
							{linkable.map((k) => (
								<option key={k} value={k}>
									{k}
								</option>
							))}
						</select>
					))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 子组件：删除条目确认对话框（替换原 window.confirm）
// ---------------------------------------------------------------------------
//
// 用 Radix AlertDialog 而不是普通 Dialog：
//   - AlertDialog 默认聚焦"取消"按钮（更安全，避免误删）
//   - 阻止外部点击关闭（必须显式选择"取消"或"删除"）
//   - 自动 role="alertdialog"，屏幕阅读器明确播报为告警
//
// 视觉与 NewItemDialog 保持一致：zpass-glass + 同款 backdrop + 同款入场动画

function DeleteConfirmDialog({
	open,
	name,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	name: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();

	return (
		<RadixAlertDialog.Root
			open={open}
			onOpenChange={(o) => {
				if (!o) onCancel();
			}}
		>
			<RadixAlertDialog.Portal
				container={
					typeof document !== "undefined"
						? document.getElementById("portal-root")
						: null
				}
			>
				<RadixAlertDialog.Overlay
					className={clsx(
						"fixed inset-0 z-50 zpass-backdrop",
						"data-[state=open]:animate-[zpass-overlay-in_140ms_ease-out]",
					)}
				/>
				<RadixAlertDialog.Content
					className={clsx(
						"fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
						"w-full max-w-sm",
						"zpass-glass rounded-xl shadow-lg p-6",
						"flex flex-col gap-4",
						"data-[state=open]:animate-[zpass-dialog-in_180ms_ease-out]",
						"focus:outline-none",
					)}
				>
					<div className="flex flex-col gap-1.5">
						<RadixAlertDialog.Title className="text-base font-semibold tracking-tight text-(--text)">
							{t("detail_delete_confirm")}
						</RadixAlertDialog.Title>
						{name && (
							<RadixAlertDialog.Description className="font-mono text-[12px] text-(--text-3)">
								{name}
							</RadixAlertDialog.Description>
						)}
					</div>

					<div className="flex items-center justify-end gap-2 border-t border-(--line-soft) pt-4">
						<RadixAlertDialog.Cancel asChild>
							<Button variant="secondary" size="md">
								{t("newlogin_cancel")}
							</Button>
						</RadixAlertDialog.Cancel>
						<RadixAlertDialog.Action asChild>
							<Button variant="danger" size="md" onClick={onConfirm}>
								{t("detail_delete")}
							</Button>
						</RadixAlertDialog.Action>
					</div>
				</RadixAlertDialog.Content>
			</RadixAlertDialog.Portal>
		</RadixAlertDialog.Root>
	);
}

export default VaultPage;

// ---------------------------------------------------------------------------
// SshKeyDialogSection —— SSH item dialog 中的「生成/导入」面板
// ---------------------------------------------------------------------------

/**
 * SshKeyDialogSection - SSH item 新建 dialog 的顶部面板
 *
 * 职责：
 *   - 渲染 mode tabs（生成 / 导入）
 *   - 生成模式下展示 SshKeyGeneratorPanel；调后端生成后把 private_key /
 *     public_key 填进 dialog 的 fields state
 *   - 导入模式下什么也不渲染（原有的 private_key / passphrase 字段会
 *     由 ItemDialog 的 fieldDefs.map 正常渲染）
 *
 * 不直接放进 ItemDialog 避免这个 1700+ 行函数更肿胀；不抽成独立文件
 * 避免转出一堆 dialog 内部状态接口。放在同一文件末尾是好妥协。
 */
function SshKeyDialogSection({
	mode,
	onModeChange,
	itemName,
	fields,
	setField,
}: {
	mode: "generate" | "import";
	onModeChange: (m: "generate" | "import") => void;
	/**
	 * SSH item 的名称（由 ItemDialog 传入）。与 Bitwarden 一致：SSH 条目的
	 * 「用户名」语义完全由 item.name 承担，不再有独立 username 字段。
	 * 该值带入 SshKeyGeneratorPanel 作为默认 comment。
	 */
	itemName: string;
	fields: Record<string, string>;
	setField: (k: string, v: string) => void;
}) {
	const [algos, setAlgos] = useState<string[]>([
		"ed25519",
		"rsa-3072",
		"rsa-4096",
		"ecdsa-p256",
	]);

	// 启动时从后端拉最新支持的算法列表 —— 让未来后端加新算法不需要同步前端
	useEffect(() => {
		let cancelled = false;
		supportedSshAlgos()
			.then((list) => {
				if (!cancelled && list.length > 0) setAlgos(list);
			})
			.catch(() => {
				/* 保留默认 fallback */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// 生成成功 → 填进 fields state
	const handleGenerated = useCallback(
		(kp: GeneratedKeyPair) => {
			setField("private_key", kp.privateKeyPem);
			setField("public_key", kp.publicKeyOpenSsh);
			// 用户没填 passphrase 时留空 —— 生成的私钥本身就是不加密的
			// OpenSSH PEM，vault 加密已够，不需要额外口令
		},
		[setField],
	);

	// 预填 comment：优先 item.name@host，其次 item.name。与后端 composeComment 一致。
	const defaultComment = (() => {
		const n = (itemName || "").trim();
		const h = (fields.host || "").trim();
		if (n && h) return `${n}@${h}`;
		if (n) return n;
		return "";
	})();

	return (
		<div className="flex flex-col gap-3">
			<SshKeyModeTabs mode={mode} onChange={onModeChange} />
			{mode === "generate" && (
				<SshKeyGeneratorPanel
					defaultComment={defaultComment}
					supportedAlgos={algos}
					onGenerate={generateSshKeyPair}
					onGenerated={handleGenerated}
				/>
			)}
		</div>
	);
}
