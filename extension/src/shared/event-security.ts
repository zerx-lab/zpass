// 区分用户真实操作与脚本合成事件。
//
// 用于内联菜单的所有交互守卫:focus / click / keyup / mousedown 等如果
// 是页面脚本通过 dispatchEvent 合成的,我们拒绝处理 —— 否则恶意站点可以
// 用 fake focus 把菜单"诱"出来获取 vault 内容。Bitwarden 同样在
// utils/event-security.ts 用 event.isTrusted 守门,这里独立实现。

export function isTrustedEvent(event: Event): boolean {
  // isTrusted 在所有现代浏览器都可用; 浏览器扩展 content script 即使
  // 在 cross-origin iframe 里也能正确读取该属性。
  return event.isTrusted === true;
}
