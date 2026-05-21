/**
 * 平台检测工具
 * ---------------------------------------------------------------------------
 * 背景：ZPass desktop 通过 Wails 3 的 frameless 选项使用自定义标题栏，
 * 但 macOS 下需要保留原生红绿灯（traffic lights）的位置预留，Windows 下需要
 * 渲染自定义的最小化/最大化/关闭按钮。平台差异需要在 React 组件渲染时同步
 * 判断，不能等异步 Promise 解析后才决定布局，否则会出现首帧闪烁。
 *
 * 设计：
 *   1. 启动阶段（`initPlatform`）由 Wails 3 运行时同步读取 `_wails.environment.OS`，
 *      写入 `<html data-platform="macos|windows|linux">`，覆盖默认值。
 *   2. 组件在渲染时通过 `getPlatform()` / `isMacOS()` 同步读取该属性，
 *      没有异步等待。
 *   3. 浏览器/SSR 回退：Wails 运行时不可用时退化到 `navigator.platform` /
 *      `userAgent` 猜测，保证 `vite dev` 纯 Web 调试也能得到合理值。
 *
 * 为什么走 `data-platform` 属性而不是 React Context？
 *   - CSS 也需要访问（如 `[data-platform="macos"] .titlebar { padding-left: ... }`）。
 *   - 非 React 树（如 index.html 内联脚本、第三方 iframe 抓取）同样可读。
 *   - 与既有 `data-theme` / `data-scale` / `data-body` 的做法一致。
 *
 * Wails 3 的 OS 标识：
 *   - `_wails.environment.OS` 取值为 Go 的 GOOS：'darwin' | 'windows' | 'linux'
 *     | 'freebsd' | …。本模块只关心三大桌面平台，其它统一回退到 'linux'
 *     （视觉上与 Windows/Linux 共用同一套自定义 titlebar）。
 *   - 同步导出 `System.IsMac()` / `System.IsWindows()` / `System.IsLinux()`，
 *     但它们底层读的也是 `_wails.environment`，因此我们直接读全局变量也能
 *     得到一致结果，避免对 `@wailsio/runtime` 的运行时环境做深度耦合。
 */

import { System } from "@wailsio/runtime";

export type Platform = "macos" | "windows" | "linux";

/** `<html data-platform="...">` 的属性名，集中定义避免拼写漂移 */
const PLATFORM_ATTR = "data-platform";

/**
 * 纯前端（非 Wails）场景的平台猜测
 * ---------------------------------------------------------------------------
 * 仅用于 `vite dev` 下直接在浏览器打开调试的情况；生产运行时都走 Wails 运行时。
 * `navigator.platform` 已废弃但在桌面浏览器仍然可用；userAgentData 是新标准
 * 但 Safari/Firefox 不支持，因此两者都探测一次。
 */
function guessFromNavigator(): Platform {
	if (typeof navigator === "undefined") return "windows";

	// 优先使用 User-Agent Client Hints（Chromium 专属，最准）
	const uaData = (
		navigator as unknown as {
			userAgentData?: { platform?: string };
		}
	).userAgentData;
	const hint = uaData?.platform?.toLowerCase() ?? "";
	if (hint.includes("mac")) return "macos";
	if (hint.includes("win")) return "windows";
	if (hint.includes("linux")) return "linux";

	// 退化：legacy navigator.platform + userAgent 双保险
	const p = (navigator.platform || "").toLowerCase();
	const ua = (navigator.userAgent || "").toLowerCase();
	if (p.includes("mac") || ua.includes("mac os")) return "macos";
	if (p.includes("win") || ua.includes("windows")) return "windows";
	return "linux";
}

/**
 * 通过 Wails 3 运行时同步读取真实平台
 *
 * Wails 3 在文档加载早期就把 `_wails.environment` 注入到 window，
 * 因此 `System.IsMac()` 等是同步可用的。但在某些非常早的代码路径
 * （比如 index.html 防 FOUC 脚本之后立即执行的 main.tsx），运行时
 * 可能还没就绪 —— 此时 `_wails` 不存在，函数返回 false。
 *
 * 我们额外探测 `_wails.environment` 是否存在，未就绪则返回 null
 * 让调用方回落到 navigator 猜测。
 */
function readFromWailsRuntime(): Platform | null {
	try {
		// _wails 由 @wailsio/runtime 在 import 时挂到 window；如果运行时未注入
		// （纯浏览器开发 / 测试），System.IsXxx() 也会返回 false。
		// 这里显式检查 environment 存在性，避免把"全 false"误判为 linux。
		const env = (window as unknown as { _wails?: { environment?: unknown } })
			._wails?.environment;
		if (!env) return null;

		if (System.IsMac()) return "macos";
		if (System.IsWindows()) return "windows";
		if (System.IsLinux()) return "linux";
	} catch {
		// 极端情况下 System.IsXxx() 抛错（理论上不会，但保留 safety net）
	}
	return null;
}

/**
 * 同步读取当前平台
 * ---------------------------------------------------------------------------
 * 优先顺序：
 *   1. `<html data-platform>` 属性（由 `initPlatform` 写入后的权威值）
 *   2. Wails 运行时 `_wails.environment`（同步读取）
 *   3. `navigator` 猜测（纯浏览器调试 / 运行时尚未注入）
 *   4. 兜底 `windows`（开发时最常见的宿主环境，避免 undefined）
 *
 * 返回值保证始终是 Platform 枚举中的一个，调用方可以安全地直接用作
 * CSS 选择器值或 switch 分支。
 */
export function getPlatform(): Platform {
	if (typeof document !== "undefined") {
		const attr = document.documentElement.getAttribute(PLATFORM_ATTR);
		if (attr === "macos" || attr === "windows" || attr === "linux") {
			return attr;
		}
	}
	const fromWails = readFromWailsRuntime();
	if (fromWails) return fromWails;
	return guessFromNavigator();
}

/** 语义快捷方式 —— macOS 专属分支用得最多，避免到处写字符串字面量 */
export function isMacOS(): boolean {
	return getPlatform() === "macos";
}

/** 语义快捷方式 —— Windows 分支（自定义窗口控件的主要目标平台） */
export function isWindows(): boolean {
	return getPlatform() === "windows";
}

/** 语义快捷方式 —— Linux（当前自定义 titlebar 与 Windows 共用同一套） */
export function isLinux(): boolean {
	return getPlatform() === "linux";
}

/**
 * 启动时调用一次：通过 Wails 3 运行时读取真实平台，写入 `<html data-platform>`
 * ---------------------------------------------------------------------------
 * 放在 `App` 组件挂载前（main.tsx）执行；Wails 运行时不可用时静默回退到
 * `navigator` 猜测，保证 `vite dev` 直开 http://localhost:9245 也能得到
 * 正确的 `data-platform`。
 *
 * 与 Tauri 实现的不同：
 *   - Tauri 的 plugin-os 走 IPC，需要 `await osType()`；
 *   - Wails 3 的 `System.IsXxx()` 同步可用，所以本函数实际上不是必须的
 *     —— 但为了与既有调用方（main.tsx）保持兼容，仍然导出 async 形态。
 */
export async function initPlatform(): Promise<Platform> {
	const resolved: Platform = readFromWailsRuntime() ?? guessFromNavigator();

	if (typeof document !== "undefined") {
		document.documentElement.setAttribute(PLATFORM_ATTR, resolved);
	}

	return resolved;
}
