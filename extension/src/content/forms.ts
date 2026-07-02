import type { LoginSecret } from "../shared/messages";
import { isTotpField } from "./totp-fields";

export interface LoginForm {
  username: HTMLInputElement | null;
  // password 为 null 表示 identifier-first 登录页的第一页(如 Google):该页只有
  // email/账号框、没有可见 password 框,本轮只填 username,下一页再填密码。
  password: HTMLInputElement | null;
}

const USERNAME_TYPES = new Set(["", "text", "email", "tel", "url"]);

export function findLoginForms(root: ParentNode): LoginForm[] {
  let passwords = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  );
  if (passwords.length === 0) {
    // 光 DOM 没有密码框才做 open shadow root 深度遍历(成本控制:常规页面
    // 走快路径;Lit/Stencil 等 web-component SPA 的登录框在 shadow 内)。
    passwords = queryInputsDeep(root).filter(
      (input) => input.type === "password",
    );
  }
  return passwords
    .filter((input) => !input.disabled && !input.readOnly && isVisible(input))
    .map((password) => ({ password, username: findUsernameInput(password) }));
}

export function fillLoginForm(form: LoginForm, secret: LoginSecret): void {
  if (form.username && secret.username) {
    simulateUserFill(form.username, secret.username);
  }
  // password 与 username 一样都要「有框且有值」才填:
  //   - form.password 为 null = identifier-first 第一页,本轮只填 username;
  //   - secret.password 为空串(只存了 username 的 login / 独立 TOTP 条目)时
  //     不应去填空,否则会用空串覆盖用户/上一页已经输入的密码。
  // 这同时修复了「空密码覆盖已有输入」的隐患。
  if (form.password && secret.password) {
    simulateUserFill(form.password, secret.password);
  }
}

/**
 * 填充 TOTP 输入框。复用与 password 同一套 simulateUserFill,保证 React/Vue
 * 受控组件能正确收到 onChange(详 forms.ts 里 valueTracker 注释)。
 *
 * 为什么不走 fillLoginForm:TOTP 填充不涉及 username/password,也不变动
 * 表单结构检查,另起一个函数表达意图更清晰。
 */
export function fillTotpInput(input: HTMLInputElement, code: string): void {
  simulateUserFill(input, code);
}

/** 单独填充用户名框(passkey 选择账户后的提示性回填等)。 */
export function fillUsernameInput(
  input: HTMLInputElement,
  value: string,
): void {
  simulateUserFill(input, value);
}

/**
 * document.activeElement 穿透 open shadow root:焦点在 shadow 内部时
 * activeElement 停在 host 上,逐层下钻拿真实焦点元素。
 */
export function deepActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

export function findLoginFormForInput(
  input: HTMLInputElement,
): LoginForm | null {
  const forms = findLoginForms(document);
  for (const form of forms) {
    if (form.password === input || form.username === input) {
      return form;
    }
  }
  const password = findPasswordNear(input);
  if (!password) {
    // 标准路径(同 form / 邻近作用域里有可见 password 框)全失败。
    // 最后再判一次 identifier-first 第一页:Google 这类登录页第一步只有
    // email/账号框、没有 password 框,此时把 input 当作 username 槽位单独返回,
    // 让内联菜单与填充链路得以放行(password=null,fillLoginForm 不会去碰密码)。
    if (isUsernameOnlyCandidate(input)) {
      return { username: input, password: null };
    }
    return null;
  }
  return {
    username: input === password ? findUsernameInput(password) : input,
    password,
  };
}

/**
 * 判定 input 是否是 identifier-first 登录页(如 Google)第一页里「只填用户名」
 * 的候选框 —— 该页第一步没有可见 password 框,只有 email/账号框。
 *
 * 思路对齐 Bitwarden inline-menu-field-qualification.service.ts 的
 * isUsernameFieldForLoginForm:先排除明显不是 username 的场景(密码框、页内
 * 存在可见密码框 → 走标准带密码路径),再用 autocomplete 与字段名词法正向识别。
 */
export function isUsernameOnlyCandidate(input: HTMLInputElement): boolean {
  // 先复用既有 login 候选门槛(可见、未禁用、非 TOTP、type 合法等)。
  if (!isLoginCandidate(input)) return false;
  // password 框本身永远走标准路径,不是「只填用户名」的第一页候选。
  if ((input.getAttribute("type") ?? "").toLowerCase() === "password")
    return false;
  // 整个 document(含 open shadow root)存在可见 password 框 → 不是
  // identifier-first 第一页,一律走标准带密码路径。旧实现只查最近容器,
  // formless SPA(每个字段被独立 div 包装)会被误判成 identifier-first,
  // 导致「只填用户名、密码框留空」。
  if (visiblePasswordIn(input.ownerDocument)) return false;
  return looksLikeUsername(input);
}

/**
 * 词法判定 input 是否「像用户名框」。
 *
 * autocomplete 是空格分隔的 token 列表(如 Google 的 "username webauthn"),
 * 必须按 token 判而非整串等号比较;词法兜底前先否决搜索框
 * (Bitwarden 同样先排搜索)。
 */
function looksLikeUsername(input: HTMLInputElement): boolean {
  const tokens = (input.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (
    tokens.includes("username") ||
    tokens.includes("email") ||
    tokens.includes("webauthn")
  ) {
    return true;
  }

  // 否则退到字段名词法判定。拼 name/id/placeholder/aria-label 统一小写。
  const haystack = [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute("aria-label"),
  ]
    .filter((value): value is string => !!value)
    .join(" ")
    .toLowerCase();

  if (/search|q\b|搜索|query/.test(haystack)) return false;
  return /user|email|account|login|identifier|账号|邮箱|手机|phone|tel/.test(
    haystack,
  );
}

export function isLoginCandidate(
  input: EventTarget | null,
): input is HTMLInputElement {
  if (!(input instanceof HTMLInputElement)) return false;
  if (input.disabled || input.readOnly || !isVisible(input)) return false;
  const type = (input.getAttribute("type") ?? "").toLowerCase();
  if (type !== "password" && !USERNAME_TYPES.has(type)) return false;
  // TOTP / one-time-code 输入框不能被当成 login candidate。
  // 典型场景：OpenAI 等站点的验证码页只有一个 `<input type="text"
  // autocomplete="one-time-code" name="code">`，没有 password 字段。不排除的话
  // `isLoginCandidate` 会返 true → handleFocusin 走 login 分支 → belongsToLoginForm
  // 找不到 password input → scheduleHide → 按钮永远不出。
  // 与 Bitwarden inline-menu-field-qualification.service.ts 中
  // isUsernameField/isPasswordField 里都先调 this.isTotpField(field) 一致。
  if (isTotpField(input)) return false;
  return true;
}

function findUsernameInput(
  password: HTMLInputElement,
): HTMLInputElement | null {
  // 作用域链由内向外,取第一层有候选的 scope。document 级属「远距配对」,
  // 要求候选通过 looksLikeUsername 词法门槛,防止把搜索框等误配成用户名。
  for (const { scope, distant } of scopeChain(password)) {
    const candidates = inputsIn(scope).filter((input) => {
      const type = (input.getAttribute("type") ?? "").toLowerCase();
      return (
        input !== password &&
        USERNAME_TYPES.has(type) &&
        !input.disabled &&
        !input.readOnly &&
        isVisible(input) &&
        (!distant || looksLikeUsername(input))
      );
    });
    if (candidates.length === 0) continue;
    const beforePassword = candidates.filter(
      (input) =>
        input.compareDocumentPosition(password) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return beforePassword.at(-1) ?? candidates[0] ?? null;
  }
  return null;
}

function findPasswordNear(input: HTMLInputElement): HTMLInputElement | null {
  if ((input.getAttribute("type") ?? "").toLowerCase() === "password")
    return input;
  for (const { scope, distant } of scopeChain(input)) {
    const password = visiblePasswordIn(scope);
    if (!password) continue;
    // 远距配对(document 级)要求 input 本身词法上像用户名,否则宁可不配:
    // 页面角落的登录表单不该把页头搜索框吸成 username 槽位。
    if (distant && !looksLikeUsername(input)) return null;
    return password;
  }
  return null;
}

interface ScopeCandidate {
  scope: ParentNode;
  /** document 级远距配对 —— 调用方需对候选加词法门槛。 */
  distant: boolean;
}

/**
 * input 的配对作用域链,由内向外:
 *   1. 所属 <form>(含 form 属性关联);
 *   2. 最近的通用容器(含 div,保持旧行为的最小作用域);
 *   3. 最近的语义分区(跳过逐层 div —— formless SPA 里每个字段常被独立
 *      div 包装,旧实现停在 div 一层导致账密永远配不上);
 *   4. 整个 document(distant,兜住跨大区块布局与跨 shadow root)。
 * closest 不穿 shadow boundary,逐级用 root.host 续走。
 */
function scopeChain(input: HTMLInputElement): ScopeCandidate[] {
  const chain: ScopeCandidate[] = [];
  const push = (scope: ParentNode | null, distant: boolean): void => {
    if (scope && !chain.some((entry) => entry.scope === scope)) {
      chain.push({ scope, distant });
    }
  };
  push(input.form, false);
  push(
    closestThroughShadow(input, "form, [role='form'], main, section, div"),
    false,
  );
  push(
    closestThroughShadow(
      input,
      "form, [role='form'], fieldset, article, section, main",
    ),
    false,
  );
  push(input.ownerDocument, true);
  return chain;
}

function closestThroughShadow(
  start: Element,
  selector: string,
): Element | null {
  let element: Element | null = start;
  while (element) {
    const hit = element.closest(selector);
    if (hit) return hit;
    const root = element.getRootNode();
    element = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function inputsIn(scope: ParentNode): HTMLInputElement[] {
  // 同一 shadow tree 内部的 scope 查询就是普通 DOM;跨 root 的深度遍历
  // 只在 document 级兜底做。
  if (scope instanceof Document) return queryInputsDeep(scope);
  return Array.from(scope.querySelectorAll<HTMLInputElement>("input"));
}

function visiblePasswordIn(scope: ParentNode): HTMLInputElement | null {
  const usable = (input: HTMLInputElement): boolean =>
    !input.disabled && !input.readOnly && isVisible(input);
  const light = Array.from(
    scope.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ).find(usable);
  if (light) return light;
  if (!(scope instanceof Document)) return null;
  return (
    queryInputsDeep(scope).find(
      (input) => input.type === "password" && usable(input),
    ) ?? null
  );
}

/** open shadow root 递归收集 input。深度上限防御病态嵌套。 */
const MAX_SHADOW_DEPTH = 4;

function queryInputsDeep(root: ParentNode, depth = 0): HTMLInputElement[] {
  const out = Array.from(root.querySelectorAll<HTMLInputElement>("input"));
  if (depth >= MAX_SHADOW_DEPTH) return out;
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (element.shadowRoot) {
      out.push(...queryInputsDeep(element.shadowRoot, depth + 1));
    }
  }
  return out;
}

function simulateUserFill(input: HTMLInputElement, value: string): void {
  input.scrollIntoView({ block: "center", inline: "nearest" });
  dispatchMouse(input, "mousedown");
  input.click();
  input.focus({ preventScroll: true });
  setNativeValue(input, value);
  dispatchInputEvents(input, value);
}

// React / Preact 在 input 挂载时会装一个 `_valueTracker`，记录 "框架已知的 value"。
// 类型仅描述我们要用的那部分接口，避免裸 any 赋值。
interface ReactValueTrackedInput extends HTMLInputElement {
  _valueTracker?: {
    getValue?(): string;
    setValue?(value: string): void;
  };
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  // 记住旧值，稍后反复复位 valueTracker 用
  const previous = input.value;

  const view = input.ownerDocument.defaultView ?? window;
  const prototype = view.HTMLInputElement.prototype;
  const prototypeSetter = Object.getOwnPropertyDescriptor(
    prototype,
    "value",
  )?.set;
  const ownSetter = Object.getOwnPropertyDescriptor(input, "value")?.set;

  // 使用 input 所在 realm 的 setter，防止 "Illegal invocation"
  // （cross-realm setter 是常见的 framework-controlled input 坌）
  if (prototypeSetter && ownSetter !== prototypeSetter) {
    prototypeSetter.call(input, value);
  } else if (ownSetter) {
    ownSetter.call(input, value);
  } else {
    input.value = value;
  }

  // ============================================================================
  // React/Vue valueTracker 重置——修复「第二次填充换账号不生效」
  // ----------------------------------------------------------------------------
  // React 16+ 在 input 挂载时装一个 `_valueTracker`，记录「框架已知的 value」。
  // 当我们 dispatch `input` 事件时，React 内部会对比：
  //     tracker.getValue() ·vs· node.value
  // 两者相等 → React 认为这是框架自己 re-render 余波，跳过 onChange。
  //
  // 事发场景：用户第 1 次选 mazhiwei 填充 → React onChange 同步 tracker.lastValue="mazhiwei"
  // 第 2 次切换选 dch → 我们设 node.value="dch" + dispatch input
  //   → 受控组件会被隐藏的 tracker 逻辑误认为「没变化」→ onChange 被吞
  //   → DOM value 看起来变了，但下一帧 React 扊 React state 又把 value 写回旧值
  //
  // 解决方法（react-trigger-change / Bitwarden / 1Password 同一思路）：
  // 在改完 value 后、dispatch event 之前，把 tracker.lastValue 反复位为 previous
  // value。这样 React 收到 input event 时比较：
  //     tracker.getValue() = previous ("mazhiwei") ≠ node.value ("dch")
  // 必然不等 → React 必走 onChange 路径 → setState 生效。
  // ============================================================================
  const tracker = (input as ReactValueTrackedInput)._valueTracker;
  if (tracker?.setValue) {
    tracker.setValue(previous);
  }
}

function dispatchInputEvents(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView ?? window;
  input.dispatchEvent(
    new view.InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertReplacementText",
      data: value,
    }),
  );
  input.dispatchEvent(
    new view.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertReplacementText",
      data: value,
    }),
  );
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
  // 末尾补一对合成 keydown/keyup(bubbles，不带具体 key 值)。部分
  // identifier-first 登录页(如 Google)的「下一步」按钮靠 keyup 监听才会从
  // disabled 点亮 —— 仅 input/change 事件不足以触发其内部校验。不带 key 值是为了
  // 避免被站点当成真实击键(如回车提交)误触发额外行为。Bitwarden 自动填充同样
  // 在填值后派发 keydown/keyup 模拟「用户敲过键」。
  input.dispatchEvent(new view.KeyboardEvent("keydown", { bubbles: true }));
  input.dispatchEvent(new view.KeyboardEvent("keyup", { bubbles: true }));
  // 不再 dispatch blur：部分受控表单会在 blur 时重置 dirty/touched 状态，
  // 导致「填了又被重置」。保留 focus 足以让验证逻辑 trigger。
  input.focus({ preventScroll: true });
}

function dispatchMouse(input: HTMLInputElement, type: string): void {
  const view = input.ownerDocument.defaultView ?? window;
  input.dispatchEvent(
    new view.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view,
    }),
  );
}

function isVisible(input: HTMLInputElement): boolean {
  const rect = input.getBoundingClientRect();
  const style = window.getComputedStyle(input);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}
