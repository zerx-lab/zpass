// TOTP 输入框识别模块
// ---------------------------------------------------------------------------
// 启发式参考自 Bitwarden 开源浏览器扩展（GPL-3.0,bitwarden/clients,
// apps/browser/src/autofill/services/{autofill-constants.ts,
// inline-menu-field-qualification.service.ts}）。
//
// 这里只借鉴算法与公开的字段名常量集（这些关键字属于事实性枚举,行业通用),
// 并按 ZPass 的工程风格独立实现,不复制 Bitwarden 源码片段。
//
// 判定规则（优先级从高到低，与 Bitwarden isTotpField 一致）：
//   1. RecoveryCodeFieldNames 一票否决（备份码 / 恢复码 input 不是 TOTP)
//   2. autocomplete 含 "one-time-code" → 立刻判定为 TOTP（最高可信度信号,
//      由 WHATWG 标准定义,浏览器原生 Password Manager 也按此识别)
//   3. type 是 password / 排除列表（hidden/submit/checkbox/...）→ 否
//   4. name / id / placeholder / aria-label 含 TotpFieldNames 关键字 → 是
//
// 注意：此模块不处理「可见性 / 表单归属 / 重复字段去重」之类的页面级裁决，
// 那些放在 AutofillController 里处理（焦点驱动场景下,可见性已经隐含在
// 「用户已经聚焦」这件事中）。
// ===========================================================================

/**
 * 高可信度 TOTP 字段名关键字（与 Bitwarden TotpFieldNames 对齐）。
 * 命中即判定为 TOTP,不会与 username 字段冲突。
 */
const TOTP_FIELD_NAMES: readonly string[] = [
  "2facode",
  "approvals_code",
  "mfacode",
  "onetimecode",
  "onetimepassword",
  "otc-code",
  "otp-code",
  "otpcode",
  "second-factor",
  "security_code",
  "security code",
  "totp",
  "totpcode",
  "twofa",
  "twofactor",
  "twofactorcode",
  "verificationcode",
  "verification code",
];

/**
 * 备份码 / 恢复码字段关键字。命中即一票否决 TOTP（用户在备份码场景下
 * 不应被填入 6 位时间型 OTP)。
 */
const RECOVERY_CODE_NAMES: readonly string[] = ["backup", "recovery"];

/**
 * 标准 autocomplete 值。WHATWG HTML Living Standard 定义,
 * 浏览器原生 Password Manager 也按此识别 OTP input。
 */
const TOTP_AUTOCOMPLETE_VALUE = "one-time-code";

/**
 * input.type 不能作为 TOTP 填充候选的类型集合。
 * 与 Bitwarden ExcludedAutofillLoginTypes 对齐 + 加 password（password 字段
 * 走 login 填充路径,绝不当 TOTP 处理。Bitwarden premium 流程里也明确排除)。
 */
const EXCLUDED_TYPES = new Set([
  "password",
  "hidden",
  "file",
  "button",
  "image",
  "reset",
  "search",
  "submit",
  "checkbox",
  "radio",
]);

/**
 * 把 input 的多个属性值拼成一份标准化字符串用于关键字匹配。
 * 与 Bitwarden 一样去掉 space / _ / -,统一小写,方便匹配
 * "verification code" / "verification-code" / "verificationCode" 三种写法。
 */
function collectFieldText(input: HTMLInputElement): string {
  const parts: string[] = [
    input.getAttribute("name") ?? "",
    input.id ?? "",
    input.getAttribute("placeholder") ?? "",
    input.getAttribute("aria-label") ?? "",
    input.getAttribute("data-testid") ?? "",
  ];
  // labels 是 HTMLInputElement 的原生属性,但部分场景下可能为 null
  const labels = (input as HTMLInputElement & { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  if (labels && labels.length > 0) {
    labels.forEach((label) => parts.push(label.textContent ?? ""));
  }
  return parts
    .join(" ")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
}

function containsAnyKeyword(text: string, keywords: readonly string[]): boolean {
  for (const kw of keywords) {
    // 关键字本身也按相同规则规范化（去 space/_/-),避免 "security_code"
    // 这种关键字与 text 的规范化结果不匹配。
    const norm = kw.toLowerCase().replace(/[\s_-]/g, "");
    if (norm && text.indexOf(norm) !== -1) return true;
  }
  return false;
}

function autocompleteHasOneTimeCode(input: HTMLInputElement): boolean {
  const value = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  if (!value) return false;
  // autocomplete 可以是 "section-x one-time-code" 这种带 section/billing 等
  // token 的复合值,按空白分词后检查。
  return value
    .split(/\s+/)
    .some((token) => token === TOTP_AUTOCOMPLETE_VALUE);
}

function isExcludedType(input: HTMLInputElement): boolean {
  const type = (input.getAttribute("type") ?? "").toLowerCase();
  return EXCLUDED_TYPES.has(type);
}

function isVisible(input: HTMLInputElement): boolean {
  const rect = input.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(input);
  return style.visibility !== "hidden" && style.display !== "none";
}

/**
 * 判定一个 input 是否是 TOTP 填充候选。
 *
 * 不检查 disabled / readonly / 可见性 —— 调用方按场景自己加（focusin 走焦点驱动,
 * findTotpField 全页扫描时才需要可见性过滤）。
 */
export function isTotpField(input: EventTarget | null): input is HTMLInputElement {
  if (!(input instanceof HTMLInputElement)) return false;
  const text = collectFieldText(input);

  // 优先级 1:备份码 / 恢复码一票否决
  if (containsAnyKeyword(text, RECOVERY_CODE_NAMES)) return false;

  // 优先级 2:autocomplete="one-time-code" 是最高可信度信号
  if (autocompleteHasOneTimeCode(input)) {
    // 但仍然要排除 password 类型（极端站点把 OTP 写成 password input,
    // 这种情况走 password 填充路径,不是 TOTP）。
    return !isExcludedType(input);
  }

  // 优先级 3:排除明确非 TOTP 的 type
  if (isExcludedType(input)) return false;

  // 优先级 4:关键字匹配
  return containsAnyKeyword(text, TOTP_FIELD_NAMES);
}

/**
 * isTotpCandidate —— 焦点驱动场景下的完整判定,叠加 disabled/readonly/可见性。
 *
 * 与 forms.ts 的 isLoginCandidate 风格一致,用于 AutofillController.handleFocusin。
 */
export function isTotpCandidate(input: EventTarget | null): input is HTMLInputElement {
  if (!isTotpField(input)) return false;
  if (input.disabled || input.readOnly) return false;
  if (!isVisible(input)) return false;
  return true;
}

/**
 * 全页扫描第一个 TOTP input（用于「按钮被点击但当前 anchor 不是 TOTP」
 * 的兜底场景；本期不一定用到,但保留 API 便于后续 popup 也接入)。
 */
export function findFirstTotpField(root: ParentNode = document): HTMLInputElement | null {
  const candidates = root.querySelectorAll<HTMLInputElement>("input");
  for (const input of Array.from(candidates)) {
    if (isTotpCandidate(input)) return input;
  }
  return null;
}
