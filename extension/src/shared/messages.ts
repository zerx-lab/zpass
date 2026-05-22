export const NATIVE_HOST_NAME = "com.zerx_lab.zpass";

export interface ActiveTabInfo {
  id?: number;
  url?: string;
}

export interface ExtensionRequest {
  type:
    | "zpass.ping"
    | "zpass.launchDesktop"
    | "zpass.status"
    | "zpass.queryLogins"
    | "zpass.revealLogin"
    | "zpass.fillActiveTab"
    | "zpass.passkeyList"
    | "zpass.passkeyCreate"
    | "zpass.passkeySign"
    | "zpass.passkeyDelete"
    | "zpass.generateLoginTotp"
    | "zpass.captureLogin"
    | "zpass.saveLogin"
    | "zpass.ignoreSaveOrigin"
    | "zpass.checkSaveQueue";
  itemId?: string;
  payload?: unknown;
}

/**
 * background → content-script 主动推送的「显示保存 toast」消息。
 *
 * 触发场景：
 *   1. captureLogin 时 vault 处于 locked，用户解锁后回放（既有路径）。
 *   2. 表单提交后页面发生导航跳转，新页面 content-script ready 时从队列拉回。
 *   3. background tabs.onUpdated 检测到该 tab 的目标 origin 加载完成，主动 push。
 *
 * 关键：decision + capture 必须由 background 校验过 sender tab + origin 才下发，
 * content-script 这边不再做合法性判断（信任 background 单一裁决点）。
 */
export interface ShowSaveToastMessage {
  type: "zpass.showSaveToast";
  decision: SaveLoginDecision;
  capture: {
    origin: string;
    url: string;
    username: string;
    password: string;
    /** 建议给条目用的名称（多半是触发捕获的页面 title，可空）。 */
    suggestedName?: string;
  };
}

export interface ExtensionResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

export interface NativeRequest<TPayload = unknown> {
  id: string;
  type:
    | "ping"
    | "launchDesktop"
    | "status"
    | "queryLogins"
    | "revealLogin"
    | "passkeyList"
    | "passkeyCreate"
    | "passkeySign"
    | "passkeyDelete"
    | "generateLoginTotp"
    | "captureLogin"
    | "saveLogin"
    | "ignoreSaveOrigin";
  payload?: TPayload;
}

// PingResult —— nativehost 转发给 GUI bridge，仅代表 liveness。
export interface PingResult {
  alive: boolean;
}

// LaunchDesktopResult —— nativehost 拉起 GUI 后立即返回，
export interface LaunchDesktopResult {
  launched: boolean;
}

export interface NativeResponse<TResult = unknown> {
  id: string;
  ok: boolean;
  result?: TResult;
  error?: string;
}

export interface PageContext {
  origin: string;
  url: string;
}

export interface RevealLoginRequest extends PageContext {
  itemId: string;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  itemCount: number;
}

export interface LoginSummary {
  id: string;
  name: string;
  username: string;
  displayUrl: string;
  updatedAt: number;
  /**
   * 该条目是否带 OTP 秘钥。后端判定：fields["totp"] != ""。
   *
   * 与 Bitwarden 不同，我们 **不** 用 hasTotp 过滤 OTP input 的下拉菜单（用
   * 户可能需要看到没 totp 的凭据然后手动手输），但 popup 点击行为依赖该字段
   * 决定是否自动复制 TOTP 到剪贴板。
   */
  hasTotp: boolean;
  /**
   * 该条目是否有密码。后端判定：fields["password"] != ""。
   *
   * popup 点击行为：
   *   - hasPassword + hasTotp → 填账密 + 自动复制 TOTP 到剪贴板（Bitwarden 默认行为）
   *   - hasPassword only      → 填账密
   *   - hasTotp only          → 复制 TOTP 到剪贴板（独立验证器条目、或未存密码的 login）
   *   - 都没有                → 不可点（理论上 queryLogins 不会返这种，但前端谨慎检查）
   */
  hasPassword: boolean;
  /**
   * 条目底层类型。取值："login" / "totp"。前端据此选择图标：
   *   - login: 钥匙图标
   *   - totp:  时钟图标
   * 这与 hasPassword/hasTotp 不冲突：有 ItemTypeLogin + 仅填 totp 字段的条目仍是 login 类型。
   */
  itemType: "login" | "totp";
}

export interface QueryLoginsResult {
  unlocked: boolean;
  origin: string;
  items: LoginSummary[];
}

export interface LoginSecret {
  id: string;
  name: string;
  username: string;
  /**
   * 明文密码。对「独立 TOTP 条目」/「只存了 username 的 login」这种场景会是空串。
   * 调用方需手动判空后决定是否跳过填密码的环节（旧版后端会报错，现软化返空串）。
   */
  password: string;
  /**
   * 对应 desktop revealLogin 返回的 totp 快照。
   * - 未存 totp 秘钥 → undefined
   * - 有秘钥但生成失败 → undefined (不足以阻断账密填充的主流程)
   * - 成功 → 全部字段填齐
   *
   * popup “填账密 + 自动复制 TOTP” 复用同一个 RPC 拿完，减少往返。
   */
  totp?: LoginTotpCode;
}

/**
 * LoginTotpCode — desktop 生成的当前 OTP 快照，与 Go 側 loginTotpCodeNative 严格对齐。
 *
 * 用法：浏览器扩展在用户点击 TOTP 下拉项后拿到 code，仅拿 code 填入
 * input；period/remaining 可选用于未来的「还有 N 秒」提示（本期不一定用）。
 *
 * type 取值："totp" / "hotp" / "steam"。对填充逻辑均表现为“拿 code 填入”，
 * 不需在扩展侧区分。
 */
export interface LoginTotpCode {
  code: string;
  type: string;
  period: number;
  remaining: number;
  counter: number;
  algorithm: string;
  digits: number;
}

/**
 * generateLoginTotp 请求负载——pageContext 由 background 全部根据 sender 补齐，
 * content script 只需传 itemId。
 */
export interface GenerateLoginTotpRequest extends PageContext {
  itemId: string;
}

export interface PasskeyPageRequest extends PageContext {
  rpId: string;
}

export interface PasskeyListRequest extends PasskeyPageRequest {}

export interface PasskeyDescriptor {
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

export interface PasskeyListResult {
  unlocked: boolean;
  rpId: string;
  items: PasskeyDescriptor[];
}

export interface PasskeyCreatePayload {
  rpId: string;
  rpName?: string;
  userId: string;
  userName: string;
  userDisplayName?: string;
  name?: string;
}

export interface PasskeyCreateRequest
  extends PageContext, PasskeyCreatePayload {}

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

export interface PasskeySignPayload {
  rpId: string;
  credentialId: string;
  clientDataHash: string;
}

export interface PasskeySignRequest extends PageContext, PasskeySignPayload {}

export interface PasskeyDeletePayload {
  rpId: string;
  itemId?: string;
  credentialId?: string;
}

export interface PasskeyDeleteRequest
  extends PageContext, PasskeyDeletePayload {}

export interface PasskeyDeleteResult {
  deleted: boolean;
  itemId: string;
}

export interface PasskeyAssertion {
  itemId: string;
  credentialId: string;
  userId: string;
  authenticatorData: string;
  signature: string;
  signCount: number;
}

/* ============================================================================
 * 以下是「登录后提示保存/更新」功能的 wire types。
 * ========================================================================== */

/**
 * captureLogin 请求负载——扩展捕获到提交后发给 background 评估。
 *
 * background 负责注入 origin / url，content-script 不能伪造。
 */
export interface CaptureLoginRequest extends PageContext {
  username: string;
  password: string;
}

/**
 * captureLogin 评估结果。与 desktop saveLoginDecision 严格对齐。
 *
 *  - "none"   —— 不弹任何提示（已存在 / origin 被 ignore / 账密为空 / 越权 等）
 *  - "locked" —— vault 锁定。提示用户解锁，并在 background 里留住 capture。
 *  - "new"    —— 可弹「保存」 toast。
 *  - "update" —— 同 origin + 同 username，密码变了；itemId/itemName 带回。
 */
export interface SaveLoginDecision {
  status: "none" | "locked" | "new" | "update";
  origin: string;
  itemId?: string;
  itemName?: string;
  reason?: string;
}

/** saveLogin 请求负载。itemId 可选：留空 = 创建新条目；带值 = 更新密码。 */
export interface SaveLoginRequest extends PageContext {
  itemId?: string;
  username: string;
  password: string;
  /** 页面 title 或 hostname，作为新建条目的名称；后端用 host 兜底。 */
  name?: string;
}

/** saveLogin 成功后的回执。 */
export interface SaveLoginResult {
  itemId: string;
  created: boolean;
}

/** ignoreSaveOrigin 请求负载——限在 PageContext，不需额外字段。 */
export type IgnoreSaveOriginRequest = PageContext;

export function getHttpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
