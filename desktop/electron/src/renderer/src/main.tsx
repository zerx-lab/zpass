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
// 开发模式（import.meta.env.DEV）保留右键，方便调试。
if (import.meta.env.PROD) {
	document.addEventListener("contextmenu", (e) => e.preventDefault(), {
		capture: true,
	});
}

const rootEl = document.getElementById("root");
if (!rootEl) {
	throw new Error(
		"ZPass: #root element not found. Check index.html mount point.",
	);
}

ReactDOM.createRoot(rootEl).render(<App />);
