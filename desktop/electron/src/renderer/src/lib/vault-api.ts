// Vault API 适配层 —— Wails VaultService 的前端类型化包装
// ---------------------------------------------------------------------------
// 把 `wails3 generate bindings` 产物（JSDoc 注释的纯 JS）包成一组 TS
// 强类型函数，再加一层 fallback：在非 Wails 运行时（vite preview /
// vitest / 浏览器直开调试）下走内存模拟，让前端 UI 在脱离桌面壳时也
// 能渲染并跑通流程，不至于直接白屏。
//
// ---------------------------------------------------------------------------
// 设计原则
//
// 1. 单一入口：所有 vault 相关的 IPC 都从本文件导出，组件层不直接 import
//    bindings/* 的产物。bindings 是机器生成的，路径长且会随 Go module
//    路径变动；集中到本文件让后续改 module path / 升级 Wails 时只动一处。
//
// 2. 类型贴合后端：ItemPayload / ItemSummary / VaultStatus 字段名与 Go
//    struct 的 JSON tag 严格对齐（已在 vaultservice_test.go 的
//    TestItemPayload_JSONShape 用例锁住），任何一边改 tag 这边 TS 编译
//    会立刻报错。
//
// 3. 错误映射：后端的 ErrVaultLocked / ErrInvalidPassword / ... 通过 IPC
//    回到前端时只是普通 Error 对象，message 是 Go 端的字符串。本模块导
//    出 VaultErrorKind 枚举与 vaultErrorKind() 辅助，让上层不需要做字
//    符串比较。
//
// 4. 非 Wails 环境 fallback：与 config-storage.ts 同样的策略 —— 内存
//    模拟"诚实表现失败" + 不污染 localStorage。fallback 实现仅供脱离
//    桌面壳的调试，没有真正的加密；标志位明确暴露便于上层在 UI 上提示
//    "当前是模拟模式"。
//
// ---------------------------------------------------------------------------
// 与 config-storage.ts 的关系
//
// 两者都是"前端 → Go 服务"的 IPC 桥，但目标不同：
//   - config-storage：zustand persist 的存储后端，处理 UI 偏好 / 空间
//     列表等明文配置，落到 ~/.config/zpass/<ns>.json
//   - vault-api：vault 加密层的 API，处理主密码 / 条目 CRUD / 锁定状态，
//     落到 ~/.config/zpass/vault.db
//
// 二者完全独立，不共享存储 / 不共享密钥，互不影响。

// FontService binding 由 `wails3 generate` 生成，开发环境下可能不存在。
// 使用 @wailsio/runtime 的 Call.ByName 绕过静态 import，避免构建失败。
import { Call as $WailsCall } from "@wailsio/runtime";
// 由 `wails3 generate bindings` 自动生成；切勿手动编辑。
// 路径反映 Go module 路径 + 包名（同 config-storage.ts 头部注释）。
import * as VaultService from "@/../bindings/github.com/zerx-lab/zpass/zpass-desktop/vaultservice.js";

// ---------------------------------------------------------------------------
// 类型定义 —— 与 Go 后端 ItemPayload / ItemSummary / VaultStatus 一一对应
// ---------------------------------------------------------------------------

/**
 * 条目类型枚举 —— 与 Go ItemType / 设计层 VaultItemType 保持一致
 *
 * 后端会校验取值落在此集合内（见 validItemTypes）。前端在表单层应该
 * 通过 TS 类型系统约束，避免运行时被后端拒绝。
 */
export type VaultItemType =
	| "login"
	| "card"
	| "note"
	| "identity"
	| "ssh"
	// WebAuthn/FIDO2 passkey credential. The private key is generated and used
	// by the Go vault service; frontend callers receive only public metadata and
	// WebAuthn registration/assertion outputs.
	| "passkey"
	// 独立的「身份验证器条目」—— 仅含 TOTP 密钥与可选账户标识，
	// 用于纯 2FA 场景（账户密码托管在别处或本就无密码）。
	// login 条目仍可同时携带 totp 字段；TOTP 聚合视图会同时收纳两类来源。
	| "totp";

/**
 * 单条条目的"完整字段" —— 详情页 / 编辑表单的数据形状
 *
 * Fields 是类型特定的字段袋（username/password/url/notes/totp/cardholder/...）；
 * 后端把它当不透明 JSON 加密，只 vault-api 这一层 + 前端组件在乎具体字段。
 *
 * 时间戳 createdAt / updatedAt 是 unix 毫秒，由后端权威生成，前端只读 ——
 * 即便修改后传回也会被后端忽略（CreatedAt 不可变 / UpdatedAt 由 nowMs() 推进）。
 */
export interface VaultItemPayload {
	id: string;
	type: VaultItemType;
	name: string;
	fields: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

/**
 * 列表展示用的"轻量摘要" —— 不含敏感字段
 *
 * 当前后端 ListItems 必须解密所有 item 才能拿到 name/type，所以摘要
 * 与 payload 的成本差异不大；保留独立类型主要是给前端 UI 留个清晰的
 * "列表项 vs 详情"边界。
 */
export interface VaultItemSummary {
	id: string;
	type: VaultItemType;
	name: string;
	createdAt: number;
	updatedAt: number;
	/** 该条目是否配置了 TOTP 密钥；由后端 ListItems 在解密时顺手填充 */
	hasTOTP: boolean;
}

/**
 * Vault 当前状态 —— 路由守卫据此分流
 *
 * 三态：
 *   - { initialized: false }            → /onboarding 设置主密码
 *   - { initialized: true, unlocked: false } → /unlock 输入主密码
 *   - { initialized: true, unlocked: true  } → /vault 主界面
 */
export interface VaultStatus {
	initialized: boolean;
	unlocked: boolean;
	itemCount: number;
}

/**
 * 创建 / 更新条目时调用方传入的形状
 *
 * 与 VaultItemPayload 的差异：
 *   - id 可选（创建时不传，后端生成；更新时必传）
 *   - createdAt / updatedAt 不传（后端权威生成）
 */
export interface VaultItemInput {
	id?: string;
	type: VaultItemType;
	name: string;
	fields: Record<string, unknown>;
}

/**
 * Passkey 创建请求 —— 对齐 Go PasskeyRegistrationRequest。
 *
 * userId 可传 base64url user handle；留空时后端生成 32 字节随机 handle。
 * 真实浏览器接入应由浏览器扩展 / native messaging bridge 把 WebAuthn
 * PublicKeyCredentialCreationOptions 映射到这个结构。
 */
export interface PasskeyRegistrationRequest {
	rpId: string;
	rpName?: string;
	userId?: string;
	userName?: string;
	userDisplayName?: string;
	name?: string;
}

/** 后端返回的 passkey 公共视图；不包含 privateKeyPkcs8。 */
export interface PasskeyCredential {
	itemId: string;
	name: string;
	rpId: string;
	rpName: string;
	userId: string;
	userName: string;
	userDisplayName: string;
	credentialId: string;
	publicKeyCose: string;
	publicKeySpki: string;
	algorithm: string;
	coseAlgorithm: number;
	signCount: number;
	transports: string[];
	authenticatorData?: string;
	attestationObject?: string;
	createdAt: number;
	updatedAt: number;
}

export interface PasskeyCredentialDescriptor {
	itemId: string;
	name: string;
	rpId: string;
	rpName: string;
	userId: string;
	userName: string;
	userDisplayName: string;
	credentialId: string;
	transports: string[];
	signCount: number;
	createdAt: number;
	updatedAt: number;
}

export interface PasskeyAssertionRequest {
	rpId: string;
	credentialId: string;
	clientDataHash: string;
}

export interface PasskeyAssertionResponse {
	itemId: string;
	credentialId: string;
	userId: string;
	authenticatorData: string;
	signature: string;
	signCount: number;
}

/**
 * TOTP 一次性验证码快照 —— 与 Go 端 TOTPCode 结构对齐
 *
 * 后端权威生成（密钥不离 Go 进程），前端只拿一次性数字 + 倒计时秒数。
 *
 * 字段：
 *   - code      ：当前 OTP 字符串（默认 6 位数字）
 *   - period    ：当前 TOTP 周期总秒数（默认 30）
 *   - remaining ：当前周期剩余秒数；前端据此绘制环形倒计时
 *   - algorithm ："SHA1" / "SHA256" / "SHA512"（目前固定 SHA1）
 *   - digits    ：OTP 位数（目前固定 6）
 */
/**
 * OTP 算法类型 —— 与 Go 后端 OTPType 保持一致
 *
 *   - "totp"  时间型 (RFC 6238)，默认
 *   - "hotp"  计数器型 (RFC 4226)，需用户点击"获取下一个码"按钮推进
 *   - "steam" Steam Guard，5 位字母数字字符表
 */
export type OTPType = "totp" | "hotp" | "steam";

export interface TOTPCode {
	code: string;
	/** OTP 算法类型 —— 决定 UI 渲染形态 */
	type: OTPType;
	/** TOTP/Steam 周期总秒数；HOTP 此字段为 0 */
	period: number;
	/** TOTP/Steam 当前周期剩余秒数；HOTP 此字段为 0 */
	remaining: number;
	/** HOTP 当前计数器；TOTP/Steam 此字段为 0 */
	counter: number;
	algorithm: string;
	digits: number;
}

/**
 * BatchGenerateTOTP 单条结果 —— 与 Go TOTPResult 对齐
 *
 * code 为 null 表示该条目生成失败，err 说明原因；
 * 成功时 err 为空字符串。
 */
export interface BatchTOTPResult {
	itemId: string;
	code: TOTPCode | null;
	err: string;
}

/**
 * 密码泄露检测结果 —— 与 Go 端 BreachResult 结构对齐
 *
 * 每个条目一条结果：
 *   - pwned=true, count>0  → 该密码在 HIBP 数据库中出现过 count 次
 *   - pwned=false, count=0 → 未发现泄露
 *   - error 非空           → 该条目检测失败（网络错误 / 无密码字段等）
 */
export interface BreachResult {
	itemId: string;
	itemName: string;
	pwned: boolean;
	count: number;
	error?: string;
	/**
	 * 该密码哈希被检测的时间（Unix 毫秒）
	 *
	 * 与后端 BreachResult.CheckedAt 对齐。前端可据此显示「上次检测于 X」，
	 * 也可与 item.updatedAt 对比判断结果是否已过期（密码改了之后 hash 变，
	 * 下一轮扫描会自动 miss → 重查 → 写新的 checkedAt）。
	 */
	checkedAt: number;
}

// ---------------------------------------------------------------------------
// 错误分类 —— 后端 errors.go 的字符串映射到 enum
// ---------------------------------------------------------------------------

/**
 * Vault 错误类别
 *
 * 上层通过 vaultErrorKind(err) 判断分支，不应做 message 字符串匹配 ——
 * 后端错误文案可能因 i18n / refactor 调整，enum 是稳定契约。
 */
export type VaultErrorKind =
	| "not-initialized" // ErrVaultNotInitialized
	| "already-initialized" // ErrVaultAlreadyInitialized
	| "locked" // ErrVaultLocked
	| "invalid-password" // ErrInvalidPassword
	| "weak-password" // ErrPasswordTooWeak
	| "not-found" // ErrItemNotFound
	| "totp-secret-missing" // ErrTOTPSecretMissing：条目未配置 TOTP 密钥
	| "totp-secret-invalid" // ErrTOTPSecretInvalid：TOTP 密钥不是合法 base32
	| "otp-type-mismatch" // ErrOTPTypeMismatch：对非 HOTP 条目调用 advanceHOTPCounter
	| "passkey-not-found" // ErrPasskeyNotFound：passkey 凭据不存在或 RP 不匹配
	| "unknown"; // 其它（IO / 解码失败 / 内部错误）

/**
 * 把后端抛出的错误对象映射到 VaultErrorKind
 *
 * 实现：
 *   - 兼容 Error 实例与字符串错误（Wails 在某些版本下 reject 的可能不是
 *     标准 Error 对象，宽松处理）
 *   - message 严格小写后做 includes 匹配 —— 后端的常量字符串不会变（
 *     vault not initialized / vault is locked / invalid master password
 *     / vault item not found / vault already initialized / master
 *     password too weak），即便加新字段也是追加而非替换
 *   - fallback 走 "unknown"，让上层有兜底分支显示通用错误
 */
export function vaultErrorKind(err: unknown): VaultErrorKind {
	const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
	if (msg.includes("not initialized")) return "not-initialized";
	if (msg.includes("already initialized")) return "already-initialized";
	if (msg.includes("locked")) return "locked";
	if (msg.includes("invalid master password")) return "invalid-password";
	if (msg.includes("too weak")) return "weak-password";
	// 注意顺序：先匹配「totp 密钥非法」再匹配「totp 密钥缺失」，
	// 避免 "totp secret is not a valid base32" 被前缀匹配吞掉
	if (msg.includes("totp secret is not")) return "totp-secret-invalid";
	if (msg.includes("totp secret not set")) return "totp-secret-missing";
	if (msg.includes("operation only valid for hotp")) return "otp-type-mismatch";
	if (msg.includes("passkey credential not found")) return "passkey-not-found";
	if (msg.includes("not found")) return "not-found";
	return "unknown";
}

// ---------------------------------------------------------------------------
// 运行时探测 —— 是否在 Wails 桌面壳里
// ---------------------------------------------------------------------------

/**
 * 是否在 Wails 桌面运行时中
 *
 * 与 config-storage.ts 共用同一探测逻辑：检查 `window._wails` 注入对象。
 * 不直接 import config-storage.ts 的探测函数是为了保持本模块的独立性
 * （未来移除 config-storage 不会牵连 vault-api）。
 */
function isWailsRuntime(): boolean {
	if (typeof window === "undefined") return false;
	return Boolean((window as unknown as { _wails?: unknown })._wails);
}

// ---------------------------------------------------------------------------
// 内存 fallback —— 非 Wails 环境的"不真加密"模拟
// ---------------------------------------------------------------------------
//
// 仅用于：
//   - vite preview / vitest（脱离桌面壳的调试）
//   - 设计走查（直接浏览器打开 frontend/dist 看 UI 不接后端）
//
// 真实部署始终走 Wails 桥。fallback 不做任何加密，刷新即丢失，且暴露
// `isMock` 标志让 UI 可以提示用户"当前为模拟模式"。
//
// 实现细节：
//   - 状态机与后端一致：未初始化 / 已初始化未解锁 / 已解锁
//   - "主密码"明文存内存（仅供 mock，真实路径根本不存密码任何形式）
//   - 条目存内存 Map<id, payload>
//   - 时间戳走 Date.now() + 单调水位线（与后端 nowMs() 对齐，防同毫秒
//     连续操作排序错位）
// ---------------------------------------------------------------------------

interface MockState {
	initialized: boolean;
	unlocked: boolean;
	password: string | null; // 明文主密码 —— 仅 mock
	items: Map<string, VaultItemPayload>;
	lastTsMs: number;
	// 「信任设备」自动解锁是否在此 mock vault 上启用 —— 仅 mock 模式用，
	// 真实运行时由后端 vault_trusted_device 表持久化
	trustedDeviceEnabled: boolean;
}

const mockState: MockState = {
	initialized: false,
	unlocked: false,
	password: null,
	items: new Map(),
	lastTsMs: 0,
	trustedDeviceEnabled: false,
};

/** mock 时钟 —— 与后端 nowMs() 同语义，保证严格单调 */
function mockNow(): number {
	const wall = Date.now();
	const next = wall <= mockState.lastTsMs ? mockState.lastTsMs + 1 : wall;
	mockState.lastTsMs = next;
	return next;
}

/** 生成 32 字符 hex item id —— 与后端 newItemID() 输出格式一致 */
function mockItemID(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	// RFC 4122 v4 位标记（与后端一致，不影响功能但保持一致性）
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Wails 调用边界规范化 —— 把任意形态的 reject 转成标准 Error
// ---------------------------------------------------------------------------
//
// 为什么需要这层 wrapper：
//
// Wails 3 alpha 的 `Call.ByID` 返回的是 `CancellablePromise`，后端 Go 方法
// return error 时通过 `result.reject(err)` 传递。理论上 `await` 这个 promise
// 应当抛出异常，调用方 `try/catch` 能正常拦下来。但实际跑下来发现：
//
//   1. 后端 stderr 已经清晰打印 `ERR Binding call failed: Bound method
//      returned an error: invalid master password`（说明 Go 侧确实把 error
//      生成了并交给 IPC 层）
//   2. 前端 UI 却没有任何错误提示 —— 说明 `await VaultService.Unlock(pwd)`
//      要么没抛、要么抛的东西不是 Error 实例 / 不是常规可 catch 的形态
//
// 可能的根因（任一都会产生该现象）：
//   a) CancellablePromise 在某些边界条件下吞掉了 reject
//   b) reject 携带的不是 Error，而是裸字符串 / 对象，被某些中间层 stringify
//      成 `"[object Object]"` 之类丢失原始信息
//   c) Wails dev 模式的 fetch 转换层把后端 error 当成 200 OK 返回（早期
//      alpha 已知 bug），让 await 拿到一个看似正常的值
//
// 与其逐一排查 alpha 版的 IPC 行为，不如在前端边界统一兜底：把每一次
// Wails 调用都包一层显式 try/catch，结合 console.error 留下诊断日志，
// 同时把任意形态的"失败信号"规范化为带 message 的标准 Error 上抛。
// 这样上层组件（UnlockPage 等）的 try/catch + vaultErrorKind() 就一定
// 能拿到可识别的错误，UI 上一定能看到提示。
//
// 失败规范化规则：
//   - Error 实例：原样上抛（保留 message / stack / cause）
//   - 字符串：包装成 new Error(string)
//   - 含 .message 的对象：取 message 字段包装
//   - 其它：JSON.stringify 后包装；stringify 失败则 fallback 到 String(e)
//
// 这层不掩盖错误，只保证错误"能被 catch 到 + message 可读"。

/**
 * 把任意形态的 reject 值规范化成标准 Error
 *
 * 不直接 throw，而是返回，让调用方在自己的位置抛出 —— 保留更精确的
 * 调用栈帧。
 */
function normalizeError(label: string, raw: unknown): Error {
	if (raw instanceof Error) {
		return raw;
	}
	if (typeof raw === "string") {
		return new Error(raw);
	}
	if (raw && typeof raw === "object") {
		// Wails RuntimeError / 后端结构化错误经常带 message 字段；优先取它
		const obj = raw as { message?: unknown };
		if (typeof obj.message === "string" && obj.message) {
			const err = new Error(obj.message);
			(err as Error & { cause?: unknown }).cause = raw;
			return err;
		}
		try {
			return new Error(`${label} failed: ${JSON.stringify(raw)}`);
		} catch {
			return new Error(`${label} failed: ${String(raw)}`);
		}
	}
	return new Error(`${label} failed: ${String(raw ?? "unknown error")}`);
}

/**
 * 包装一次 Wails 调用：执行 → 失败时规范化 + 日志 + 重抛
 *
 * 用法：
 *   const s = await callWails("Unlock", () => VaultService.Unlock(pwd));
 *
 * label 仅用于诊断日志，不会出现在抛给上层的 Error message 里（除非
 * raw 完全没有可用信息）。生产环境的 console.error 在 Wails webview 中
 * 也会回流到 Go 侧 stdout，方便对照后端日志定位时序问题。
 */
async function callWails<T>(label: string, fn: () => PromiseLike<T>): Promise<T> {
	try {
		// 用 Promise.resolve 包一层兜底：万一 fn() 同步抛 / 返回非 PromiseLike
		// 的值，也能走统一的错误路径
		return await Promise.resolve(fn());
	} catch (raw) {
		const err = normalizeError(label, raw);
		console.error(`[vault-api] ${label} failed:`, raw, "→ normalized:", err);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 查询 vault 当前状态
 *
 * 这是路由守卫 / 启动逻辑的第一站，必须在锁定状态下也能安全调用 ——
 * 后端 Status() 不需要 DEK，本模块也保持同样契约。
 */
export async function status(): Promise<VaultStatus> {
	if (!isWailsRuntime()) {
		return {
			initialized: mockState.initialized,
			unlocked: mockState.unlocked,
			itemCount: mockState.unlocked ? mockState.items.size : 0,
		};
	}
	const s = await callWails("Status", () => VaultService.Status());
	return {
		initialized: s.initialized,
		unlocked: s.unlocked,
		itemCount: s.itemCount ?? 0,
	};
}

/**
 * 首次初始化 vault —— 设置主密码并立即解锁
 *
 * 后端约定：Initialize 后无需再调 Unlock，DEK 已经在内存中（与产品流程
 * 对齐：Onboarding 设密 → 立刻进主界面）。
 *
 * 错误映射：
 *   - 弱密码 → vaultErrorKind="weak-password"
 *   - 已经初始化过 → vaultErrorKind="already-initialized"
 *
 * 上层应该用 try/catch + vaultErrorKind 分支，而不是依赖 message 字符串。
 */
export async function initialize(password: string): Promise<void> {
	if (!isWailsRuntime()) {
		if (password.length < 8) {
			throw new Error("master password too weak (minimum 8 characters)");
		}
		if (mockState.initialized) {
			throw new Error("vault already initialized");
		}
		mockState.initialized = true;
		mockState.unlocked = true;
		mockState.password = password;
		return;
	}
	await callWails("Initialize", () => VaultService.Initialize(password));
}

/**
 * 用主密码解锁 vault
 *
 * 后端不区分"密码错"/"DB 损坏"/"参数被改"，统一返回 invalid-password ——
 * 这是反侧信道的刻意设计，前端 UI 应该统一显示"主密码错误"。
 */
export async function unlock(password: string): Promise<void> {
	if (!isWailsRuntime()) {
		if (!mockState.initialized) {
			throw new Error("vault not initialized");
		}
		if (password !== mockState.password) {
			throw new Error("invalid master password");
		}
		mockState.unlocked = true;
		return;
	}
	await callWails("Unlock", () => VaultService.Unlock(password));
}

/**
 * 主动锁定 vault
 *
 * 幂等 —— 未解锁时调用直接返回。调用场景：
 *   - 用户点 Sidebar / TopBar 的"锁定"按钮
 *   - 空闲超时（前端定时器）
 *   - 系统休眠（未来加平台事件订阅）
 */
export async function lock(): Promise<void> {
	if (!isWailsRuntime()) {
		mockState.unlocked = false;
		return;
	}
	await callWails("Lock", () => VaultService.Lock());
}

/**
 * 修改主密码 —— 必须在已解锁状态下调用
 *
 * 后端只重新包装 DEK，不重写所有 item，开销与 Initialize 相当（一次
 * Argon2id 慢哈希）。改完仍处于解锁态，用户不需要重新输入密码。
 */
export async function changeMasterPassword(
	oldPassword: string,
	newPassword: string,
): Promise<void> {
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		if (oldPassword !== mockState.password) {
			throw new Error("invalid master password");
		}
		if (newPassword.length < 8) {
			throw new Error("master password too weak (minimum 8 characters)");
		}
		mockState.password = newPassword;
		return;
	}
	await callWails("ChangeMasterPassword", () =>
		VaultService.ChangeMasterPassword(oldPassword, newPassword),
	);
}

/**
 * 列出所有条目摘要
 *
 * 锁定状态下抛 invalid-password / locked 错误（后端按情况返回）；
 * 上层应在路由守卫层就拦下这种错误，不让用户看到列表加载失败。
 */
export async function listItems(): Promise<VaultItemSummary[]> {
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		// 按 updatedAt desc 排序 —— 与后端 ListItems 一致
		return Array.from(mockState.items.values())
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((p) => ({
				id: p.id,
				type: p.type,
				name: p.name,
				createdAt: p.createdAt,
				updatedAt: p.updatedAt,
				hasTOTP: false,
			}));
	}
	const arr = await callWails("ListItems", () => VaultService.ListItems());
	// 后端模型用 PascalCase Go field name → models.js 的 createFrom 已经
	// 转成 camelCase。这里再做一次防御性映射，确保万一未来生成器变了
	// 上层代码不需要跟着改。
	return (arr ?? []).map((s) => ({
		id: s.id,
		type: s.type as VaultItemType,
		name: s.name,
		createdAt: s.createdAt,
		updatedAt: s.updatedAt,
		hasTOTP: Boolean(s.hasTOTP),
	}));
}

/**
 * 按 id 读取完整条目
 *
 * 找不到返回 null（与后端 GetItem 的 (nil, nil) 契约对齐），不是抛错。
 * 上层据此渲染"条目已被删除"提示，避免误把"不存在"当成"加载失败"。
 */
export async function getItem(id: string): Promise<VaultItemPayload | null> {
	if (!id) throw new Error("item id cannot be empty");
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		return mockState.items.get(id) ?? null;
	}
	const p = await callWails("GetItem", () => VaultService.GetItem(id));
	if (!p) return null;
	return {
		id: p.id,
		type: p.type as VaultItemType,
		name: p.name,
		fields: (p.fields ?? {}) as Record<string, unknown>,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
	};
}

/**
 * 创建新条目；后端生成 id + 时间戳后回传 ItemSummary
 *
 * 前端表单层校验完字段就调本方法。后端会再校验 type / name 非空，
 * 双层防御。
 */
export async function createItem(input: VaultItemInput): Promise<VaultItemSummary> {
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		if (!input.name) throw new Error("item name cannot be empty");
		const id = mockItemID();
		const now = mockNow();
		const payload: VaultItemPayload = {
			id,
			type: input.type,
			name: input.name,
			fields: { ...input.fields },
			createdAt: now,
			updatedAt: now,
		};
		mockState.items.set(id, payload);
		return {
			id,
			type: payload.type,
			name: payload.name,
			createdAt: now,
			updatedAt: now,
			hasTOTP: false,
		};
	}
	// Wails 绑定接受的是后端 ItemPayload 形状；id / createdAt / updatedAt
	// 会被后端忽略，但字段仍需提供以满足结构体反序列化。
	const result = await callWails("CreateItem", () =>
		VaultService.CreateItem({
			id: "",
			type: input.type,
			name: input.name,
			fields: input.fields,
			createdAt: 0,
			updatedAt: 0,
		} as never),
	);
	if (!result) {
		// 后端正常路径不会返回 null；防御性兜底
		throw new Error("create item returned null");
	}
	return {
		id: result.id,
		type: result.type as VaultItemType,
		name: result.name,
		createdAt: result.createdAt,
		updatedAt: result.updatedAt,
		hasTOTP: false,
	};
}

/**
 * 批量创建条目 —— 单次 IPC，Go 侧单事务写入
 *
 * 导入场景：把 N 条 Bitwarden 条目一次性写入，
 * 替代 importMany 里的串行 for 循环（N 次 IPC → 1 次）。
 * 返回 ItemSummary 数组（顺序与输入对应）。
 */
export async function batchCreateItems(inputs: VaultItemInput[]): Promise<VaultItemSummary[]> {
	if (inputs.length === 0) return [];
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		return Promise.all(inputs.map((input) => createItem(input)));
	}
	const payloads = inputs.map((input) => ({
		id: "",
		type: input.type,
		name: input.name,
		fields: input.fields,
		createdAt: 0,
		updatedAt: 0,
	}));
	const results = await callWails("BatchCreateItems", () =>
		VaultService.BatchCreateItems(payloads as never),
	);
	if (!Array.isArray(results)) throw new Error("batch create returned non-array");
	return results.map(
		(r: { id: string; type: string; name: string; createdAt: number; updatedAt: number }) => ({
			id: r.id,
			type: r.type as VaultItemType,
			name: r.name,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			hasTOTP: false,
		}),
	);
}

/**
 * 整体覆盖现有条目；后端按 id 定位，CreatedAt 不变 / UpdatedAt 推进
 *
 * 字段级 patch 由前端组合：先 getItem 拿全量 → 改字段 → 调 updateItem。
 * 后端不做 patch，让"完整对象替换"语义保持简单可审计。
 */
export async function updateItem(
	input: VaultItemInput & { id: string },
): Promise<VaultItemSummary> {
	if (!input.id) throw new Error("item id cannot be empty");
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		const existing = mockState.items.get(input.id);
		if (!existing) throw new Error("vault item not found");
		const now = mockNow();
		const next: VaultItemPayload = {
			id: input.id,
			type: input.type,
			name: input.name,
			fields: { ...input.fields },
			createdAt: existing.createdAt,
			updatedAt: now,
		};
		mockState.items.set(input.id, next);
		return {
			id: next.id,
			type: next.type,
			name: next.name,
			createdAt: next.createdAt,
			updatedAt: next.updatedAt,
			hasTOTP: false,
		};
	}
	const result = await callWails("UpdateItem", () =>
		VaultService.UpdateItem({
			id: input.id,
			type: input.type,
			name: input.name,
			fields: input.fields,
			createdAt: 0,
			updatedAt: 0,
		} as never),
	);
	if (!result) {
		throw new Error("update item returned null");
	}
	return {
		id: result.id,
		type: result.type as VaultItemType,
		name: result.name,
		createdAt: result.createdAt,
		updatedAt: result.updatedAt,
		hasTOTP: false,
	};
}

/**
 * 按 id 删除条目
 *
 * 找不到 id 时后端返回 ErrItemNotFound，本方法原样抛出 ——
 * 上层用 vaultErrorKind 判断 "not-found" 后可以选择吞掉（"已经
 * 不存在了" = 删除目的已达成）或提示用户。
 */
export async function deleteItem(id: string): Promise<void> {
	if (!id) throw new Error("item id cannot be empty");
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		if (!mockState.items.has(id)) throw new Error("vault item not found");
		mockState.items.delete(id);
		return;
	}
	await callWails("DeleteItem", () => VaultService.DeleteItem(id));
}

// ---------------------------------------------------------------------------
// Passkeys / WebAuthn
// ---------------------------------------------------------------------------
//
// Wails 模式：委托 Go 后端生成 ES256 credential、加密保存私钥，并在
// SignPasskeyAssertion 中完成 WebAuthn assertion 签名。前端 / 浏览器桥
// 永远不需要读取 privateKeyPkcs8。
//
// Mock 模式：只创建可展示的假 passkey 元数据，便于 UI 开发；不提供真实
// WebAuthn 密码学保证。

function bytesToBase64URL(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function mockRandomBase64URL(len: number): string {
	const bytes = new Uint8Array(len);
	crypto.getRandomValues(bytes);
	return bytesToBase64URL(bytes);
}

function passkeyFromRaw(raw: unknown): PasskeyCredential {
	const r = raw as Partial<PasskeyCredential>;
	return {
		itemId: String(r.itemId ?? ""),
		name: String(r.name ?? ""),
		rpId: String(r.rpId ?? ""),
		rpName: String(r.rpName ?? ""),
		userId: String(r.userId ?? ""),
		userName: String(r.userName ?? ""),
		userDisplayName: String(r.userDisplayName ?? ""),
		credentialId: String(r.credentialId ?? ""),
		publicKeyCose: String(r.publicKeyCose ?? ""),
		publicKeySpki: String(r.publicKeySpki ?? ""),
		algorithm: String(r.algorithm ?? "ES256"),
		coseAlgorithm: Number(r.coseAlgorithm ?? -7),
		signCount: Number(r.signCount ?? 0),
		transports: Array.isArray(r.transports) ? r.transports.map(String) : ["internal"],
		authenticatorData: typeof r.authenticatorData === "string" ? r.authenticatorData : undefined,
		attestationObject: typeof r.attestationObject === "string" ? r.attestationObject : undefined,
		createdAt: Number(r.createdAt ?? 0),
		updatedAt: Number(r.updatedAt ?? 0),
	};
}

function passkeyDescriptorFromRaw(raw: unknown): PasskeyCredentialDescriptor {
	const r = raw as Partial<PasskeyCredentialDescriptor>;
	return {
		itemId: String(r.itemId ?? ""),
		name: String(r.name ?? ""),
		rpId: String(r.rpId ?? ""),
		rpName: String(r.rpName ?? ""),
		userId: String(r.userId ?? ""),
		userName: String(r.userName ?? ""),
		userDisplayName: String(r.userDisplayName ?? ""),
		credentialId: String(r.credentialId ?? ""),
		transports: Array.isArray(r.transports) ? r.transports.map(String) : ["internal"],
		signCount: Number(r.signCount ?? 0),
		createdAt: Number(r.createdAt ?? 0),
		updatedAt: Number(r.updatedAt ?? 0),
	};
}

/** 创建并加密保存一个 passkey credential。 */
export async function createPasskey(input: PasskeyRegistrationRequest): Promise<PasskeyCredential> {
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		if (!input.rpId?.trim()) throw new Error("rpId cannot be empty");
		const rpId = input.rpId.trim().toLowerCase();
		const name =
			input.name?.trim() ||
			`${input.rpName?.trim() || rpId}${input.userName ? ` (${input.userName})` : ""}`;
		const credentialId = mockRandomBase64URL(32);
		const userId = input.userId?.trim() || mockRandomBase64URL(32);
		const summary = await createItem({
			type: "passkey",
			name,
			fields: {
				schema: "zpass-passkey-v1",
				rpId,
				rpName: input.rpName ?? "",
				userId,
				userName: input.userName ?? "",
				userDisplayName: input.userDisplayName ?? "",
				credentialId,
				publicKeyCose: mockRandomBase64URL(77),
				publicKeySpki: mockRandomBase64URL(91),
				algorithm: "ES256",
				coseAlgorithm: -7,
				signCount: 0,
				transports: ["internal"],
			},
		});
		return {
			itemId: summary.id,
			name,
			rpId,
			rpName: input.rpName ?? "",
			userId,
			userName: input.userName ?? "",
			userDisplayName: input.userDisplayName ?? "",
			credentialId,
			publicKeyCose: String(mockState.items.get(summary.id)?.fields.publicKeyCose ?? ""),
			publicKeySpki: String(mockState.items.get(summary.id)?.fields.publicKeySpki ?? ""),
			algorithm: "ES256",
			coseAlgorithm: -7,
			signCount: 0,
			transports: ["internal"],
			authenticatorData: mockRandomBase64URL(37),
			attestationObject: mockRandomBase64URL(96),
			createdAt: summary.createdAt,
			updatedAt: summary.updatedAt,
		};
	}
	const raw = await callWails(
		"CreatePasskey",
		() =>
			$WailsCall.ByName("main.VaultService.CreatePasskey", {
				rpId: input.rpId,
				rpName: input.rpName ?? "",
				userId: input.userId ?? "",
				userName: input.userName ?? "",
				userDisplayName: input.userDisplayName ?? "",
				name: input.name ?? "",
			}) as Promise<unknown>,
	);
	return passkeyFromRaw(raw);
}

/** 列出指定 RP ID 下可用的 passkey 凭据。 */
export async function listPasskeys(rpId: string): Promise<PasskeyCredentialDescriptor[]> {
	if (!rpId.trim()) throw new Error("rpId cannot be empty");
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		const normalized = rpId.trim().toLowerCase();
		return Array.from(mockState.items.values())
			.filter((p) => p.type === "passkey" && p.fields.rpId === normalized)
			.map((p) =>
				passkeyDescriptorFromRaw({
					itemId: p.id,
					name: p.name,
					rpId: p.fields.rpId,
					rpName: p.fields.rpName,
					userId: p.fields.userId,
					userName: p.fields.userName,
					userDisplayName: p.fields.userDisplayName,
					credentialId: p.fields.credentialId,
					transports: p.fields.transports,
					signCount: p.fields.signCount,
					createdAt: p.createdAt,
					updatedAt: p.updatedAt,
				}),
			);
	}
	const raw = await callWails(
		"ListPasskeys",
		() => $WailsCall.ByName("main.VaultService.ListPasskeys", rpId) as Promise<unknown[]>,
	);
	return Array.isArray(raw) ? raw.map(passkeyDescriptorFromRaw) : [];
}

/** 读取单个 passkey 的公共信息。 */
export async function getPasskey(itemId: string): Promise<PasskeyCredential | null> {
	if (!itemId) throw new Error("item id cannot be empty");
	if (!isWailsRuntime()) {
		const p = mockState.items.get(itemId);
		if (!p || p.type !== "passkey") return null;
		return passkeyFromRaw({
			itemId: p.id,
			name: p.name,
			...p.fields,
			createdAt: p.createdAt,
			updatedAt: p.updatedAt,
		});
	}
	const raw = await callWails(
		"GetPasskey",
		() => $WailsCall.ByName("main.VaultService.GetPasskey", itemId) as Promise<unknown>,
	);
	return raw ? passkeyFromRaw(raw) : null;
}

/** 对 WebAuthn clientDataHash 进行 assertion 签名，并推进 signCount。 */
export async function signPasskeyAssertion(
	input: PasskeyAssertionRequest,
): Promise<PasskeyAssertionResponse> {
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		const normalized = input.rpId.trim().toLowerCase();
		const item = Array.from(mockState.items.values()).find(
			(p) =>
				p.type === "passkey" &&
				p.fields.rpId === normalized &&
				p.fields.credentialId === input.credentialId,
		);
		if (!item) throw new Error("passkey credential not found");
		const nextCount = Number(item.fields.signCount ?? 0) + 1;
		item.fields.signCount = nextCount;
		item.updatedAt = mockNow();
		return {
			itemId: item.id,
			credentialId: String(item.fields.credentialId ?? ""),
			userId: String(item.fields.userId ?? ""),
			authenticatorData: mockRandomBase64URL(37),
			signature: mockRandomBase64URL(70),
			signCount: nextCount,
		};
	}
	const raw = await callWails(
		"SignPasskeyAssertion",
		() =>
			$WailsCall.ByName("main.VaultService.SignPasskeyAssertion", {
				rpId: input.rpId,
				credentialId: input.credentialId,
				clientDataHash: input.clientDataHash,
			}) as Promise<PasskeyAssertionResponse>,
	);
	return raw as PasskeyAssertionResponse;
}

// ---------------------------------------------------------------------------
// TOTP 一次性验证码
// ---------------------------------------------------------------------------
//
// Wails 模式：委托 Go 后端 totpservice.GenerateTOTP（密钥不离后端进程）。
//
// Mock 模式：浏览器纯前端环境无法做 base32 + HMAC-SHA1，且 mock 主要服务
// UI 走查 —— 这里不引入 jssha 等依赖，直接用密钥前 6 位非数字字符的 hash
// 派生一个稳定假码，并按 30 秒周期推进，让 UI 的「码变化 + 倒计时」交互
// 在脱离桌面壳时仍能演示。**生产路径必须走 Wails。**

/**
 * 生成指定条目当前的 TOTP 一次性验证码
 *
 * 仅 `login`（含 fields["totp"]）与 `totp` 类型条目支持。其它类型 / 字段
 * 为空 / secret 非 base32 都会抛错，上层用 vaultErrorKind 分支映射文案：
 *
 *   - "vault is locked"        → 锁定，需要先解锁
 *   - "totp secret not set"    → 该条目没有配置 TOTP 密钥（提示用户去编辑）
 *   - "totp secret is not"     → 密钥格式非法（base32 解码失败）
 *   - "vault item not found"   → 条目已被删除
 *
 * 返回 TOTPCode 快照；前端应每秒重新调用本方法（或在 `remaining === 1` 时
 * 立刻刷新）以保证显示的 OTP 与服务端时钟一致。
 */
export async function generateTOTP(itemId: string): Promise<TOTPCode> {
	if (!itemId) throw new Error("item id cannot be empty");
	if (!isWailsRuntime()) {
		return mockGenerateOTP(itemId, /* advance */ false);
	}
	const raw = await callWails("GenerateTOTP", () => VaultService.GenerateTOTP(itemId));
	if (!raw) {
		throw new Error("totp generation returned null");
	}
	return {
		code: raw.code,
		type: (raw.type || "totp") as OTPType,
		period: raw.period,
		remaining: raw.remaining,
		counter: raw.counter,
		algorithm: raw.algorithm,
		digits: raw.digits,
	};
}

/**
 * 批量生成 TOTP 验证码 —— 单次 IPC 替代逐条 generateTOTP
 *
 * TotpPage 首次进入时调用，把 N 条 TOTP 条目压缩成 1 次 Go IPC。
 * 返回与入参等长的数组；单条失败只填 err 字段，不影响其他条目。
 */
export async function batchGenerateTOTP(itemIds: string[]): Promise<BatchTOTPResult[]> {
	if (itemIds.length === 0) return [];
	if (!isWailsRuntime()) {
		return Promise.all(
			itemIds.map(async (id) => {
				try {
					const code = await mockGenerateOTP(id, false);
					return { itemId: id, code, err: "" };
				} catch (e) {
					return {
						itemId: id,
						code: null,
						err: e instanceof Error ? e.message : String(e),
					};
				}
			}),
		);
	}
	const raw = await callWails("BatchGenerateTOTP", () => VaultService.BatchGenerateTOTP(itemIds));
	if (!Array.isArray(raw)) return [];
	return raw.map((r: { itemId: string; code: unknown; err: string }) => ({
		itemId: r.itemId,
		code: r.code
			? {
					code: (r.code as { code: string }).code,
					type: ((r.code as { type?: string }).type || "totp") as OTPType,
					period: (r.code as { period: number }).period,
					remaining: (r.code as { remaining: number }).remaining,
					counter: (r.code as { counter: number }).counter,
					algorithm: (r.code as { algorithm: string }).algorithm,
					digits: (r.code as { digits: number }).digits,
				}
			: null,
		err: r.err ?? "",
	}));
}

/**
 * 把指定 HOTP 条目的计数器 +1 并返回新生成的验证码
 *
 * 仅适用于 HOTP 条目（`fields["otp_type"]==="hotp"`）。TOTP/Steam 是基于
 * 时间的，调用本方法会得到 ErrOTPTypeMismatch（前端应翻译成"该条目不是
 * HOTP 类型"）。
 *
 * 用户场景：HOTP 不像 TOTP 自动滚动，必须用户主动按下"获取下一个码"按钮
 * 来推进计数器；典型应用是 YubiKey OATH 槽位 / 老式硬件令牌。
 *
 * 副作用：成功后条目的 `fields["hotp_counter"]` 已被持久化 +1。
 */
export async function advanceHOTPCounter(itemId: string): Promise<TOTPCode> {
	if (!itemId) throw new Error("item id cannot be empty");
	if (!isWailsRuntime()) {
		return mockGenerateOTP(itemId, /* advance */ true);
	}
	const raw = await callWails("AdvanceHOTPCounter", () => VaultService.AdvanceHOTPCounter(itemId));
	if (!raw) {
		throw new Error("hotp advance returned null");
	}
	return {
		code: raw.code,
		type: (raw.type || "hotp") as OTPType,
		period: raw.period,
		remaining: raw.remaining,
		counter: raw.counter,
		algorithm: raw.algorithm,
		digits: raw.digits,
	};
}

// ---------------------------------------------------------------------------
// Mock 实现 —— 浏览器调试模式（无 Wails 运行时）
// ---------------------------------------------------------------------------
//
// 注意：本路径仅供 UI 走查，**绝非真实算法**。真实 RFC 4226/6238 / Steam
// 算法由 Go 后端通过 pquerna/otp 库执行。
//
// 共用一份代码处理三种 OTP 类型：
//   - 推断类型：fields["otp_type"] 显式 > otpauth:// URI scheme 推断 > 默认 totp
//   - HOTP：用 fields["hotp_counter"] 作为 counter，advance=true 时持久化 +1
//   - TOTP：counter = floor(epoch / period)
//   - Steam：同 TOTP 但用字符表 "23456789BCDFGHJKMNPQRTVWXY" 输出 5 位

const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

function inferOtpTypeMock(fields: Record<string, unknown>, rawSecret: string): OTPType {
	const explicit = typeof fields.otp_type === "string" ? fields.otp_type.toLowerCase() : "";
	if (explicit === "hotp" || explicit === "steam" || explicit === "totp") {
		return explicit;
	}
	if (/^otpauth:\/\/hotp\//i.test(rawSecret)) return "hotp";
	if (/^otpauth:\/\/steam\//i.test(rawSecret)) return "steam";
	if (/^otpauth:\/\/totp\//i.test(rawSecret)) {
		try {
			const u = new URL(rawSecret);
			if ((u.searchParams.get("issuer") || "").toLowerCase() === "steam") return "steam";
		} catch {
			/* ignore */
		}
	}
	return "totp";
}

function readNumericMock(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number.parseInt(v.trim(), 10);
		if (Number.isFinite(n)) return n;
	}
	return 0;
}

async function mockGenerateOTP(itemId: string, advance: boolean): Promise<TOTPCode> {
	if (!mockState.unlocked) throw new Error("vault is locked");
	const item = mockState.items.get(itemId);
	if (!item) throw new Error("vault item not found");
	if (item.type !== "login" && item.type !== "totp") {
		throw new Error("totp secret not set on this item");
	}
	const rawSecret = typeof item.fields.totp === "string" ? item.fields.totp : "";

	// 复刻 normalizeTOTPSecret 等效语义：识别 otpauth:// URI 取 secret 参数，
	// 否则"去空格 + 转大写 + 去尾部 padding"做 base32 规范化。
	let candidate = rawSecret.trim();
	if (/^otpauth:\/\//i.test(candidate)) {
		try {
			const u = new URL(candidate);
			candidate = u.searchParams.get("secret") ?? "";
		} catch {
			candidate = "";
		}
	}
	const secret = candidate.replace(/\s+/g, "").toUpperCase().replace(/=+$/, "");
	if (!secret) throw new Error("totp secret not set on this item");

	const otpType = inferOtpTypeMock(item.fields, rawSecret);

	if (advance && otpType !== "hotp") {
		throw new Error("operation only valid for hotp items");
	}

	if (otpType === "hotp") {
		// HOTP：从 fields 读 counter；advance=true 时 +1 并持久化
		let counter = readNumericMock(item.fields.hotp_counter);
		if (advance) {
			counter += 1;
			item.fields.hotp_counter = counter;
			item.updatedAt = Date.now();
		}
		// 极简伪 HOTP：与原 mock 一致，绝非真实 HMAC
		let acc = counter;
		for (let i = 0; i < secret.length; i++) {
			acc = (acc * 31 + secret.charCodeAt(i)) >>> 0;
		}
		const code = (acc % 1_000_000).toString().padStart(6, "0");
		return {
			code,
			type: "hotp",
			period: 0,
			remaining: 0,
			counter,
			algorithm: "SHA1",
			digits: 6,
		};
	}

	const period = 30;
	const epoch = Math.floor(Date.now() / 1000);
	const counter = Math.floor(epoch / period);
	let acc = counter;
	for (let i = 0; i < secret.length; i++) {
		acc = (acc * 31 + secret.charCodeAt(i)) >>> 0;
	}

	if (otpType === "steam") {
		// 用 acc 在 Steam 字母表上取 5 个字符
		let value = acc;
		let code = "";
		for (let i = 0; i < 5; i++) {
			code += STEAM_ALPHABET[value % STEAM_ALPHABET.length];
			value = Math.floor(value / STEAM_ALPHABET.length);
		}
		return {
			code,
			type: "steam",
			period,
			remaining: period - (epoch % period),
			counter: 0,
			algorithm: "SHA1",
			digits: 5,
		};
	}

	// TOTP 默认分支
	const code = (acc % 1_000_000).toString().padStart(6, "0");
	return {
		code,
		type: "totp",
		period,
		remaining: period - (epoch % period),
		counter: 0,
		algorithm: "SHA1",
		digits: 6,
	};
}

// ---------------------------------------------------------------------------
// 密码泄露检测 —— HIBP Pwned Passwords (k-Anonymity)
// ---------------------------------------------------------------------------
//
// Wails 模式：委托 Go 后端调用 HIBP API（后端持有明文解密能力且不受
// CORS 限制）。
//
// Mock 模式：前端直接调用 HIBP range API（mock 下密码明文在内存中，且
// HIBP 支持浏览器 CORS）。流程：
//   1. SHA-1(password) → 40 字符 hex
//   2. prefix = hex[0:5], suffix = hex[5:]
//   3. GET https://api.pwnedpasswords.com/range/{prefix}
//   4. 响应逐行 "SUFFIX:COUNT"，匹配 suffix → pwned=true
//   5. 请求间隔 100ms 避免突发并发
// ---------------------------------------------------------------------------

/**
 * 检测所有 login 类型条目的密码是否出现在已知泄露数据库中
 *
 * 返回每个 login 条目的检测结果数组。非 login 类型 / 无 password 字段
 * 的条目不参与检测。
 */
export async function checkBreachedPasswords(): Promise<BreachResult[]> {
	if (!isWailsRuntime()) {
		// HIBP 泄露检测必须走 Go 后端：Wails 后端持有缓存、网络节流和真正的
		// 解密管道。浏览器纯前端环境（无 Wails 壳）不支持此功能。
		throw new Error(
			"breach check requires Wails desktop runtime (not available in browser mock mode)",
		);
	}

	// ---- Wails 模式：委托 Go 后端 ----
	const raw = await callWails("CheckBreachedPasswords", () => VaultService.CheckBreachedPasswords());
	// 后端返回 []BreachResult 的 JSON 映射；防御性兜底空数组
	return (raw as BreachResult[]) ?? [];
}

/**
 * 清空 HIBP 泄露检测缓存
 *
 * 用于「重新扫描」按钮：清缓存 → 再调 checkBreachedPasswords() 即可对所有
 * 密码强制重新发起 HIBP 请求，绕过缓存命中。
 *
 * vault 锁定状态下也允许调用（清空空缓存是 no-op，无副作用）。
 */
export async function clearBreachCache(): Promise<void> {
	if (!isWailsRuntime()) {
		// 与 checkBreachedPasswords 一致：mock 模式下不支持，直接抛错。
		throw new Error(
			"breach cache clear requires Wails desktop runtime (not available in browser mock mode)",
		);
	}
	await callWails("ClearBreachCache", () => VaultService.ClearBreachCache());
}

/**
 * 读取磁盘上持久化的泄露检测快照
 *
 * 文件不存在时返回空数组（首次启动正常）。
 * 配合 SaveBreachSnapshot（Go 侧在全量扫描完成后自动调用）使用。
 */
export async function loadBreachSnapshot(): Promise<BreachResult[]> {
	if (!isWailsRuntime()) {
		return [];
	}
	const raw = await callWails("LoadBreachSnapshot", () => VaultService.LoadBreachSnapshot());
	return (raw as BreachResult[]) ?? [];
}

/**
 * 对单条 login 条目做即时泄露检测
 *
 * 用于 create / update 后的快速刷新，避免全量重扫开销。
 * 非 login 类型 / 无 password 字段时返回 null。
 */
export async function checkItemBreach(itemId: string): Promise<BreachResult | null> {
	if (!itemId) throw new Error("item id cannot be empty");
	if (!isWailsRuntime()) {
		return null;
	}
	const raw = await callWails("CheckItemBreach", () => VaultService.CheckItemBreach(itemId));
	if (!raw) return null;
	return {
		itemId: (raw as { itemId: string }).itemId,
		itemName: (raw as { itemName: string }).itemName,
		pwned: (raw as { pwned: boolean }).pwned,
		count: (raw as { count: number }).count,
		error: (raw as { error?: string }).error,
		checkedAt: (raw as { checkedAt: number }).checkedAt,
	};
}

// ---------------------------------------------------------------------------
// 信任设备 / 自动解锁
// ---------------------------------------------------------------------------
//
// 让用户在指定设备上重启 ZPass 后无需输入主密码即可进入保险库。后端用
// OS 设备绑定密钥（Windows DPAPI / 未来 macOS Keychain / Linux libsecret）
// 把 DEK 包一层落盘。详见 desktop/trusteddevice.go 头部注释。
//
// 安全模型核心：blob 离开当前 OS 用户会话即不可解 —— 拷走 vault.db 到
// 另一台机器无法解密。这是相比 Bitwarden「永不超时」明文落盘 DEK 的严格
// 优势。详见 mem://bitwarden-zpass-dpapi 调研记录。

/**
 * 当前平台是否支持「信任设备」自动解锁
 *
 * Windows 始终返回 true；非 Windows 当前为 false（macOS/Linux 实现规划中）。
 * 前端用此结果决定 SettingsPage 开关是否置灰 —— 不支持时显示「此平台暂不
 * 支持」副标题，开关置 disabled。
 *
 * 锁定状态下也能安全调用，不需要 DEK。
 */
export async function isTrustedDeviceSupported(): Promise<boolean> {
	if (!isWailsRuntime()) {
		// mock 模式无法访问真正的 OS API，统一返回 false
		// —— 让浏览器调试场景下 SettingsPage 自动展示"不支持"状态
		return false;
	}
	return await callWails("IsTrustedDeviceSupported", () => VaultService.IsTrustedDeviceSupported());
}

/**
 * 当前 vault 是否已经在此设备启用了「自动解锁」
 *
 * 注意：返回 true 仅表示后端 vault_trusted_device 表有行，不保证 blob
 * 真的能解开（OS 凭据可能已变化）。真正的可解性由
 * `tryUnlockWithTrustedDevice()` 在启动流程中验证。
 *
 * 锁定状态下也能安全调用 —— SettingsPage 用此结果初始化开关勾选态。
 */
export async function isTrustedDeviceEnabled(): Promise<boolean> {
	if (!isWailsRuntime()) {
		return mockState.trustedDeviceEnabled;
	}
	return await callWails("IsTrustedDeviceEnabled", () => VaultService.IsTrustedDeviceEnabled());
}

/**
 * 启用「在此设备上自动解锁」
 *
 * 后端要求传入主密码做二次确认 —— 防止已被劫持的会话恶意启用此功能。
 * 流程：
 *   1. 后端验证 `confirmPassword` 与当前 vault 主密码一致（走完整 KDF）
 *   2. 通过后用 OS 设备绑定密钥包装内存中的 DEK
 *   3. 写入 vault_trusted_device 表
 *
 * 错误映射：
 *   - 主密码错        → vaultErrorKind === "invalid-password"
 *   - 平台不支持      → 后端返回 ErrTrustedDeviceUnsupported（前端正常路径
 *                       下不应触达，因为 UI 已经把开关置灰）
 *   - vault 锁定      → vaultErrorKind === "locked"（前端不应触达，启用
 *                       入口仅在已解锁的 SettingsPage）
 *
 * 上层应该用 try/catch + vaultErrorKind 映射成 i18n 文案展示。
 */
export async function enableTrustedDevice(confirmPassword: string): Promise<void> {
	if (!isWailsRuntime()) {
		// mock 模式：仅校验密码，不做真实 OS 调用
		if (!mockState.initialized) throw new Error("vault not initialized");
		if (!mockState.unlocked) throw new Error("vault is locked");
		if (confirmPassword !== mockState.password) {
			throw new Error("invalid master password");
		}
		mockState.trustedDeviceEnabled = true;
		return;
	}
	await callWails("EnableTrustedDevice", () => VaultService.EnableTrustedDevice(confirmPassword));
}

/**
 * 关闭「在此设备上自动解锁」
 *
 * 不需要主密码 —— 关闭只是降低安全等级（下次启动需要主密码），不存在
 * 提权风险。幂等：未启用时调用直接成功。
 */
export async function disableTrustedDevice(): Promise<void> {
	if (!isWailsRuntime()) {
		mockState.trustedDeviceEnabled = false;
		return;
	}
	await callWails("DisableTrustedDevice", () => VaultService.DisableTrustedDevice());
}

/**
 * 启动时尝试用「信任设备」自动解锁
 *
 * 返回值语义：
 *   - true  → 已成功还原 DEK，后端进入解锁态。前端应当同步翻
 *             `useLockStore.locked = false` 并 navigate 到主界面。
 *   - false → 未启用 / OS 凭据已变化 / blob 与当前 vault 不匹配 等所有
 *             需要让用户走主密码流程的情况。前端不应展示为错误，让
 *             UnlockPage 正常显示密码输入框即可。
 *
 * 后端在 false 分支已经静默清掉了过期的 blob 行（详见
 * `vaultservice.go` TryUnlockWithTrustedDevice 注释）。
 *
 * 调用时机：webview 挂载时（LockSync 触发），早于 `status()` 探测。
 */
export async function tryUnlockWithTrustedDevice(): Promise<boolean> {
	if (!isWailsRuntime()) {
		// mock 模式：若启用了 trusted device 且未锁定，直接成功
		if (mockState.trustedDeviceEnabled && mockState.initialized) {
			mockState.unlocked = true;
			return true;
		}
		return false;
	}
	return await callWails("TryUnlockWithTrustedDevice", () =>
		VaultService.TryUnlockWithTrustedDevice(),
	);
}

// ---------------------------------------------------------------------------
// 默认导出 —— 便于 import 时一行拿全
// ---------------------------------------------------------------------------

/**
 * 单一聚合对象，组件层可以一行 `import { vaultApi } from "@/lib/vault-api"`
 * 后通过 `vaultApi.status()` 等访问，避免散落多个具名 import。
 *
 * 也保留所有具名导出，让喜欢 tree-shaking 的调用方按需引用。
 */
// ---------------------------------------------------------------------------
// 字体服务
// ---------------------------------------------------------------------------

/**
 * 获取系统已安装的字体名称列表。
 *
 * - 内置字体（Geist、Geist Mono）始终排在最前，其余字体按字母序排列。
 * - 开发模式（非 Wails 壳）返回常见字体 mock 列表，避免构建依赖。
 */
export async function getSystemFonts(): Promise<string[]> {
	if (!isWailsRuntime()) {
		// 开发模式 mock：返回常见字体列表
		return [
			"Geist",
			"Geist Mono",
			"Arial",
			"Georgia",
			"Courier New",
			"Times New Roman",
			"Verdana",
			"Trebuchet MS",
		];
	}
	return callWails(
		"GetSystemFonts",
		() => $WailsCall.ByName("main.FontService.GetSystemFonts") as Promise<string[]>,
	);
}

// ---------------------------------------------------------------------------
// QR 二维码解码 —— 调后端 QRService.DecodeQR (gozxing)
// ---------------------------------------------------------------------------
//
// 为什么走 Go 后端而不是前端解码：Wails3 三平台的 webview 引擎
// 对 BarcodeDetector 支持参差（WebView2 有，WKWebView/WebKitGTK 均无），
// macOS/Linux 用户会掉回到 jsQR 这种识别率偏弱的纯 JS 实现。gozxing 是
// ZXing 的 Go 移植，跨平台一致，对带中心 logo / 轻度倾斜的 QR 识别
// 率明显优于 jsQR。
//
// 传输协议：前端 Blob → base64 → Wails IPC → Go []byte → image.Decode →
// gozxing.QRCodeReader。

/**
 * 把 Blob 转为不带 "data:image/...;base64," 前缀的纯 base64 字符串
 *
 * 为什么用 FileReader 而不是 btoa(String.fromCharCode(...buf)):
 * 后者在大数组（>100KB）会栈溢出。FileReader.readAsDataURL 是浏览器
 * 原生实现，对任意大小都稳定。
 */
async function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("unexpected FileReader result type"));
				return;
			}
			// readAsDataURL 输出形如 "data:image/png;base64,iVBORw0KGgo..."
			// 取逗号后的部分；Go 后端只接受裸 base64，不可带 data URI 头。
			const comma = result.indexOf(",");
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
		reader.readAsDataURL(blob);
	});
}

/**
 * 解码一张二维码图像，返回原始内容字符串。
 *
 * 错误行为：任何失败（图像不可读 / 未识别到 QR）都招 error；UI 层按
 * “未识别到二维码”统一提示，不区分子类。
 *
 * 非 Wails 环境（vite preview / vitest）直接招错 —— 本功能依赖后端服务，
 * 浏览器 mock 模式下没有意义。
 */
export async function decodeQR(blob: Blob): Promise<string> {
	if (!isWailsRuntime()) {
		throw new Error("qr decoding requires the desktop runtime");
	}
	const b64 = await blobToBase64(blob);
	return callWails(
		"DecodeQR",
		() => $WailsCall.ByName("main.QRService.DecodeQR", b64) as Promise<string>,
	);
}

// ---------------------------------------------------------------------------
// 主密码二次确认 与 明文导出
// ---------------------------------------------------------------------------

/**
 * 主密码二次确认 —— 不改变 vault 解锁状态。
 *
 * 后端在 vault 已解锁状态下重跑一次 Argon2id 派生 + Verifier 校验，
 * 仅作为「敏感操作前的用户身份重提交」校验。错误语义与 Unlock 一致。
 *
 * 调用场景：
 *   - 明文导出之前的「输主密码确认」步骤
 *   - 未来如果加「删除所有数据」/「导出审计日志」等高风险动作也可复用
 *
 * 非 Wails 环境走 mockState.password 比较 —— 只为让仪表板完整走一遭流程。
 */
export async function verifyMasterPassword(password: string): Promise<void> {
	if (!isWailsRuntime()) {
		if (!mockState.unlocked) throw new Error("vault is locked");
		if (password !== mockState.password) {
			throw new Error("invalid master password");
		}
		return;
	}
	await callWails(
		"VerifyMasterPassword",
		() => $WailsCall.ByName("main.VaultService.VerifyMasterPassword", password) as Promise<void>,
	);
}

/**
 * 导出结果摘要 —— 与后端 ExportResult 一一对应。
 *
 * 不携带任何 vault 明文：整库已被后端直接写入用户选定的磁盘文件，
 * 前端仅拿到「写到哪 / 带了多少条 / 多大」这类回执信息。
 */
export interface ExportResult {
	path: string;
	cancelled: boolean;
	itemCount: number;
	sizeBytes: number;
}

/**
 * 导出整个 vault 为明文 JSON 文件。
 *
 * 流程：
 *   1. 后端解密所有条目 → 组装 schema="zpass-export-v1" 的 JSON
 *   2. 后端弹出系统 SaveFile dialog 让用户选保存路径
 *   3. 原子写入后返回 ExportResult
 *
 * 用户点「取消」按钮时：resolve 为 { cancelled: true, path: "", ... }，不抑错。
 *
 * 非 Wails 环境不提供导出 —— 模拟模式下本来就没有密文谈得上「备份」，
 * 直接招错让用户意识到处于调试梨。
 */
export async function exportAllToFile(): Promise<ExportResult> {
	if (!isWailsRuntime()) {
		throw new Error("export requires the desktop runtime");
	}
	const raw = await callWails(
		"ExportAllToFile",
		() =>
			$WailsCall.ByName("main.ExportService.ExportAllToFile") as Promise<{
				path?: string;
				cancelled?: boolean;
				itemCount?: number;
				sizeBytes?: number;
			}>,
	);
	return {
		path: raw?.path ?? "",
		cancelled: Boolean(raw?.cancelled),
		itemCount: raw?.itemCount ?? 0,
		sizeBytes: raw?.sizeBytes ?? 0,
	};
}

export const vaultApi = {
	status,
	initialize,
	unlock,
	lock,
	changeMasterPassword,
	verifyMasterPassword,
	listItems,
	getItem,
	createItem,
	batchCreateItems,
	updateItem,
	deleteItem,
	createPasskey,
	listPasskeys,
	getPasskey,
	signPasskeyAssertion,
	generateTOTP,
	batchGenerateTOTP,
	advanceHOTPCounter,
	checkBreachedPasswords,
	clearBreachCache,
	loadBreachSnapshot,
	checkItemBreach,
	isTrustedDeviceSupported,
	isTrustedDeviceEnabled,
	enableTrustedDevice,
	disableTrustedDevice,
	tryUnlockWithTrustedDevice,
	getSystemFonts,
	/** 解码一张二维码图片 (后端 gozxing，跨平台一致) */
	decodeQR,
	/** 导出整个 vault 为明文 JSON 文件 */
	exportAllToFile,
	/** 探测当前是否在 Wails 桌面壳里 —— UI 可据此提示"当前为模拟模式" */
	isWails: isWailsRuntime,
	/** 错误分类辅助 */
	errorKind: vaultErrorKind,
};

export default vaultApi;
