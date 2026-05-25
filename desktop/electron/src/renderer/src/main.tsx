// 应用入口
// ---------------------------------------------------------------------------
// 职责：
//   1. 加载全局样式（globals.css 内联加载 Geist 字体 / tokens.css / Tailwind）
//   2. 初始化 i18next（en / zh 双语）
//   3. 挂载路由根 <App />
//
// 不在这里做的事：
//   - DOM data-* 同步（交给 <ThemeSync />，见 src/app/ThemeSync.tsx）
//   - 全局快捷键注册（交给 <Shortcuts />，见 src/app/Shortcuts.tsx）
//   - 解锁守卫（交给 <LockGuard />，见 src/app/LockGuard.tsx）

import ReactDOM from "react-dom/client";
import App from "./App";
import { initPlatform } from "@/lib/platform";

// 样式：必须在 App 之前导入，保证 Tailwind / tokens / 字体先于组件挂载
import "./styles/globals.css";

// i18n：导入即初始化（见 src/i18n/index.ts 的 i18n.init() 副作用）
import "./i18n";

// 平台检测：把真实 OS 写入 <html data-platform="macos|windows|linux">，
// 供 Titlebar 等组件在渲染时同步判断（红绿灯预留 / 自定义窗口按钮）。
// 不 await —— initPlatform 内部已经用 navigator 做了同步回退，
// Tauri 真实平台解析完成后会再覆写一次，避免首帧阻塞。
void initPlatform();

// 生产模式下全局禁用右键菜单，防止暴露 webview 调试入口。
// ---------------------------------------------------------------------------
// 例外（三端原生交互期望）：input / textarea / [contenteditable] 内右键应
// 走系统原生菜单，让 macOS 用户能用"拼写检查 / 撤销"、Windows 用户能用
// "粘贴 / 删除"。Electron 本身会把这些原生菜单交给操作系统，我们只需要
// **不拦截** contextmenu 事件即可。
//
// 业务自定义右键（Sidebar 空间项 / VaultPage 列表行 / 详情）走 React 的
// onContextMenu —— 它们在 PROD 全局拦截**之前**触发并自行 stopPropagation /
// preventDefault，因此不会被这里挡住。capture 阶段拦截只是兜底拦那些没人
// 处理的纯背景区，避免暴露 webview 的"检查元素 / 重载"调试菜单。
//
// 开发模式（import.meta.env.DEV）保留全部右键，方便调试。
if (import.meta.env.PROD) {
	document.addEventListener(
		"contextmenu",
		(e) => {
			const target = e.target as Element | null;
			if (!target) {
				e.preventDefault();
				return;
			}
			// closest 同时覆盖 e.target 自身与祖先节点 —— 当用户右击 input
			// 内部的占位 placeholder span 之类合成节点时仍能命中外层 input。
			const editable = target.closest(
				'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]),textarea,[contenteditable=""],[contenteditable="true"]',
			);
			if (editable) return; // 让原生菜单弹出
			e.preventDefault();
		},
		{ capture: true },
	);
}

// ---------------------------------------------------------------------------
// 窗口焦点态同步 —— 主进程的 BrowserWindow blur/focus 事件 → <html data-window-blurred>
// 用于 globals.css 的 "[data-window-blurred] .titlebar { opacity: ... }" 类
// 视觉降级，对齐 macOS / Win11 / GNOME 原生窗口"失活窗口标题栏调淡"惯例。
// 设置在挂载前是为了首屏就能有正确状态；初始默认聚焦（document.hasFocus()）。
// ---------------------------------------------------------------------------
if (typeof window !== "undefined" && window.desktop?.window?.onFocusChange) {
	const root = document.documentElement;
	if (!document.hasFocus()) root.setAttribute("data-window-blurred", "");
	window.desktop.window.onFocusChange((focused) => {
		if (focused) root.removeAttribute("data-window-blurred");
		else root.setAttribute("data-window-blurred", "");
	});
}

const rootEl = document.getElementById("root");
if (!rootEl) {
	throw new Error(
		"ZPass: #root element not found. Check index.html mount point.",
	);
}

ReactDOM.createRoot(rootEl).render(<App />);
