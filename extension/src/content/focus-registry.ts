// 「最后聚焦的 login input」注册表(per-frame 模块级单例)。
//
// 为什么需要:内联菜单浮层是顶层 document 里 closed-shadow 自定义元素包
// 扩展 iframe。用户点击列表项瞬间,焦点从页面 input 移入浮层 shell,
// document.activeElement 不再是 input;等 background 广播 zpass.fillLogin
// 到达时,activeElement 路径已找不回目标 input。带密码页还有
// findLoginForms(document)[0] 兜底,identifier-first 页(如 Google 第一步,
// 无 password 框)兜底两手空空 —— 即「选择账户不会填充」的根因。
//
// controller 在 focusin/click 命中 login 候选时写入;填充侧按
// activeElement → 本注册表 → findLoginForms 兜底的优先级消费。
// 不做主动清理:读取方负责校验 isConnected / isLoginCandidate,
// SPA 重渲染换掉节点后自然失效。

let lastFocusedLoginInput: HTMLInputElement | null = null;

export function rememberLoginInput(input: HTMLInputElement): void {
  lastFocusedLoginInput = input;
}

export function recallLoginInput(): HTMLInputElement | null {
  if (lastFocusedLoginInput && !lastFocusedLoginInput.isConnected) {
    lastFocusedLoginInput = null;
  }
  return lastFocusedLoginInput;
}
