// i18next 初始化 —— en / zh 双语
// ---------------------------------------------------------------------------
// 字典对标 ZPassDesign/src/i18n.jsx，但本文件职责精简：
//
//   1. 注册字典资源（en / zh）
//   2. 根据【系统语言】决定 i18next 首次加载使用的语言（不读 localStorage）
//   3. 暴露 setLang(lang) —— 仅调用 i18next.changeLanguage 与同步 <html lang>
//
// ⚠️ 语言偏好的持久化唯一真源是 `usePrefsStore`（zustand persist 到
// localStorage['zpass.prefs']），**本文件不再写任何 localStorage**。
//
// 启动顺序：
//   index.html 防 FOUC 脚本 —— 从 localStorage['zpass.prefs'] 读 state.lang，
//     同步到 <html lang="zh-CN"|"en">（避免首帧闪烁）
//   ↓
//   main.tsx 导入 './i18n' —— 本文件执行 i18n.init()，此时：
//     · 若 localStorage 有 prefs 持久化，zustand hydrate 后 ThemeSync 会
//       调用 setLang(prefs.lang) 把 i18next 校准到用户选择的语言
//     · 若没有 prefs 持久化（首次启动），prefs 使用 detectSystemLang() 的
//       结果作为默认值（见 src/stores/prefs.ts），ThemeSync 也会同步过来
//   ↓
//   用户在 Settings 页切换语言 → 改 prefs → ThemeSync 订阅 prefs.lang 变化
//     → 调 setLang() → i18next 发出 languageChanged 事件 → 所有 useTranslation
//       消费者重渲染
//
// 关键原则：**setLang 只改运行时状态，不碰存储**。把所有"写 localStorage"
// 的行为集中在 zustand persist 中间件，避免两个源各写一份引起不一致。

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { zh } from "./zh";

export const SUPPORTED_LANGS = ["en", "zh"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

/**
 * 检测当前运行环境的系统语言偏好。
 *
 * 策略：
 *   1. 读取 `navigator.language`（浏览器 / Tauri WebView 都会正确反映系统语言）
 *   2. 只要以 "zh" 开头（zh / zh-CN / zh-TW / zh-HK）即视为中文
 *   3. 其他全部落到 "en"
 *
 * 这是 i18n 首次初始化以及 prefs.lang 的首次默认值共同使用的函数 ——
 * 保持两处默认一致，避免 i18n 说"我显示英文"而 prefs 说"我保存的是中文"。
 *
 * Tauri v2 的 WebView2（Windows）/ WKWebView（macOS）/ WebKitGTK（Linux）
 * 都会正确响应系统地区设置；在 SSR 或无 navigator 的环境下回退到 "en"。
 */
export function detectSystemLang(): Lang {
	if (typeof navigator === "undefined") return "en";
	const nav = navigator.language || "en";
	return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

i18n.use(initReactI18next).init({
	resources: {
		en: { translation: en },
		zh: { translation: zh },
	},
	// 首次初始化使用系统语言；如果用户之前设置过偏好，
	// ThemeSync 会在 zustand hydrate 完成后调用 setLang() 校准。
	lng: detectSystemLang(),
	fallbackLng: "en",
	interpolation: {
		// React 已转义，禁用 i18next 自带转义
		escapeValue: false,
	},
	returnNull: false,
});

/**
 * 切换当前运行时语言。
 *
 * 职责单一：仅通知 i18next + 同步 `<html lang>` 属性。
 * **不写任何 localStorage** —— 持久化由 usePrefsStore 的 persist 中间件统一负责。
 *
 * 使用场景：
 *   - ThemeSync 订阅 prefs.lang 变化后调用（唯一正当的调用方）
 *   - 如需外部命令式切语言，应该改 usePrefsStore.setLang，不要直接调这里
 *
 * 参数：
 *   @param lang - 目标语言（en | zh）
 */
export function setLang(lang: Lang): void {
	// changeLanguage 返回 Promise，但这里不 await —— 字典资源已在 init 时打包
	// 注册，切换本质上是纯内存操作，不存在异步加载失败的可能
	i18n.changeLanguage(lang);
	document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
}

export default i18n;
