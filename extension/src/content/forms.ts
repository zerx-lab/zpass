import type { LoginSecret } from "../shared/messages";
import { isTotpField } from "./totp-fields";

export interface LoginForm {
  username: HTMLInputElement | null;
  password: HTMLInputElement;
}

const USERNAME_TYPES = new Set(["", "text", "email", "tel", "url"]);

export function findLoginForms(root: ParentNode): LoginForm[] {
  const passwords = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  );
  return passwords
    .filter((input) => !input.disabled && !input.readOnly && isVisible(input))
    .map((password) => ({ password, username: findUsernameInput(password) }));
}

export function fillLoginForm(form: LoginForm, secret: LoginSecret): void {
  if (form.username && secret.username) {
    simulateUserFill(form.username, secret.username);
  }
  simulateUserFill(form.password, secret.password);
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
  if (!password) return null;
  return {
    username: input === password ? findUsernameInput(password) : input,
    password,
  };
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
  const scope = password.form ?? nearestContainer(password) ?? document;
  const candidates = Array.from(
    scope.querySelectorAll<HTMLInputElement>("input"),
  ).filter((input) => {
    const type = (input.getAttribute("type") ?? "").toLowerCase();
    return (
      input !== password &&
      USERNAME_TYPES.has(type) &&
      !input.disabled &&
      !input.readOnly &&
      isVisible(input)
    );
  });
  const beforePassword = candidates.filter(
    (input) =>
      input.compareDocumentPosition(password) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return beforePassword.at(-1) ?? candidates[0] ?? null;
}

function findPasswordNear(input: HTMLInputElement): HTMLInputElement | null {
  if ((input.getAttribute("type") ?? "").toLowerCase() === "password")
    return input;
  const scope = input.form ?? nearestContainer(input) ?? document;
  const passwords = Array.from(
    scope.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ).filter(
    (candidate) =>
      !candidate.disabled && !candidate.readOnly && isVisible(candidate),
  );
  return passwords[0] ?? null;
}

function nearestContainer(input: HTMLInputElement): ParentNode | null {
  return input.closest("form, [role='form'], main, section, div");
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
