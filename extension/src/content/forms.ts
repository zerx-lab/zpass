import type { LoginSecret } from "../shared/messages";

export interface LoginForm {
  username: HTMLInputElement | null;
  password: HTMLInputElement;
}

const USERNAME_TYPES = new Set(["", "text", "email", "tel", "url"]);

export function findLoginForms(root: ParentNode): LoginForm[] {
  const passwords = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]'));
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

export function findLoginFormForInput(input: HTMLInputElement): LoginForm | null {
  const forms = findLoginForms(document);
  for (const form of forms) {
    if (form.password === input || form.username === input) {
      return form;
    }
  }
  const password = findPasswordNear(input);
  if (!password) return null;
  return { username: input === password ? findUsernameInput(password) : input, password };
}

export function isLoginCandidate(input: EventTarget | null): input is HTMLInputElement {
  if (!(input instanceof HTMLInputElement)) return false;
  if (input.disabled || input.readOnly || !isVisible(input)) return false;
  const type = (input.getAttribute("type") ?? "").toLowerCase();
  return type === "password" || USERNAME_TYPES.has(type);
}

function findUsernameInput(password: HTMLInputElement): HTMLInputElement | null {
  const scope = password.form ?? nearestContainer(password) ?? document;
  const candidates = Array.from(scope.querySelectorAll<HTMLInputElement>("input")).filter((input) => {
    const type = (input.getAttribute("type") ?? "").toLowerCase();
    return input !== password && USERNAME_TYPES.has(type) && !input.disabled && !input.readOnly && isVisible(input);
  });
  const beforePassword = candidates.filter((input) => input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
  return beforePassword.at(-1) ?? candidates[0] ?? null;
}

function findPasswordNear(input: HTMLInputElement): HTMLInputElement | null {
  if ((input.getAttribute("type") ?? "").toLowerCase() === "password") return input;
  const scope = input.form ?? nearestContainer(input) ?? document;
  const passwords = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
    (candidate) => !candidate.disabled && !candidate.readOnly && isVisible(candidate)
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

function setNativeValue(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView ?? window;
  const prototype = view.HTMLInputElement.prototype;
  const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  const ownSetter = Object.getOwnPropertyDescriptor(input, "value")?.set;

  // Use the setter from the input's owning window. Calling a setter from the
  // wrong realm is a common cause of "Illegal invocation" in extension content
  // scripts, especially on pages with framework-controlled inputs.
  if (prototypeSetter && ownSetter !== prototypeSetter) {
    prototypeSetter.call(input, value);
  } else if (ownSetter) {
    ownSetter.call(input, value);
  } else {
    input.value = value;
  }
}

function dispatchInputEvents(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView ?? window;
  input.dispatchEvent(new view.InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertReplacementText",
    data: value
  }));
  input.dispatchEvent(new view.InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertReplacementText",
    data: value
  }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
  input.dispatchEvent(new view.Event("blur", { bubbles: true }));
  input.focus({ preventScroll: true });
}

function dispatchMouse(input: HTMLInputElement, type: string): void {
  const view = input.ownerDocument.defaultView ?? window;
  input.dispatchEvent(new view.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view
  }));
}

function isVisible(input: HTMLInputElement): boolean {
  const rect = input.getBoundingClientRect();
  const style = window.getComputedStyle(input);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}
