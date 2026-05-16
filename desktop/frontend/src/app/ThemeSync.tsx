import { useEffect } from "react";
import { usePrefsStore } from "@/stores/prefs";
import { setLang as setI18nLang } from "@/i18n";

/**
 * 应用一个用户自选的本地字体到 CSS 变量上
 * ---------------------------------------------------------------------------
 * 为什么必须用 `@font-face { src: local(...) }` 别名，而不是直接把
 * `font-family: "<用户字体名>"` 塞进 CSS 变量？
 *
 * Windows 注册表（见 backend/fonts_windows.go）返回的是字体的
 * **完整子家族名**，例如 `Maple Mono NF CN Medium`、`Arial Bold`、
 * `Calibri Light Italic`。直接把这种名字写到 `font-family` 里时：
 *
 *   1. Chromium 会把它拆成 family="Maple Mono NF CN" + weight=500，
 *      然后**重新按当前元素的 `font-weight` 二次匹配 face**；body 默认
 *      weight 400 → 匹配不到 400 的 face → 回落到 fallback（Geist）。
 *   2. 叠加 globals.css 里 `font-synthesis: none`（禁用合成字重），
 *      表现就是「只有那些恰好是 medium/500 字重的元素才用上了用户字体，
 *      其它 weight 全是 Geist」—— 即用户看到的「部分 UI 没生效」。
 *
 * 用 `@font-face { font-family: "ZPassUserSans"; src: local("<全名>");
 * font-weight: 1 999; }` 把用户选的具体 face 绑定到一个固定别名上，
 * 并用通配 weight 范围让它匹配所有 `font-weight` —— 这样无论元素声明
 * 什么字重，最终都会用上用户挑的那一个具体 face，全界面一致生效。
 *
 * font-style: normal 同理避免 italic 元素被二次解析掉。
 */
function applyUserFont(opts: {
	name: string;
	cssVar: "--font-sans" | "--font-mono";
	alias: string;
	styleId: string;
	fallback: string;
}) {
	const { name, cssVar, alias, styleId, fallback } = opts;
	const root = document.documentElement;
	const existing = document.getElementById(styleId);

	const trimmed = name?.trim();
	if (!trimmed) {
		existing?.remove();
		root.style.removeProperty(cssVar);
		return;
	}

	// 防 CSS 注入 —— 字体名来自系统枚举但仍走转义；双引号在 CSS 里能终止字符串
	const safe = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const face = `@font-face { font-family: "${alias}"; src: local("${safe}"); font-weight: 1 999; font-style: normal; font-display: swap; }`;

	let styleEl = existing as HTMLStyleElement | null;
	if (!styleEl) {
		styleEl = document.createElement("style");
		styleEl.id = styleId;
		document.head.appendChild(styleEl);
	}
	styleEl.textContent = face;

	root.style.setProperty(cssVar, `"${alias}", ${fallback}`);
}

/**
 * 主题 / 缩放 / 字体 / 语言 / 口音色 → DOM 同步器
 *
 * 职责：作为一个"无渲染"组件挂在 <App> 顶层，订阅 usePrefsStore 并把
 * 偏好写入 <html> 的 data-* 属性与根 CSS 变量 / inline style。样式规则
 * 以 `[data-theme="light"]` / `[data-body="mono"]` 等属性选择器生效
 * （见 src/styles/tokens.css）。
 *
 * 对标 ZPassDesign/src/app.jsx 中的 useEffect：
 *   document.documentElement.setAttribute("data-theme", theme);
 *   document.getElementById("root").style.zoom = `${scale}%`;  // 新：界面缩放（写 #root）
 *   document.documentElement.setAttribute("data-body", body);
 *   document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
 *
 * 设计要点：
 *   - 每个偏好字段独立一个 useEffect，依赖数组精确到该字段 → 变更任一字段
 *     只触发对应 DOM 写入，避免一次偏好变更导致整棵树重绘。
 *   - 不渲染任何 DOM（返回 null），不参与布局。
 *   - 语言同步调用 i18n setLang，确保 i18next 与 prefs 不脱节。
 *   - 口音色通过 CSS 变量 --accent 写入 <html>，覆盖 tokens.css 的默认值；
 *     用户清除自定义色（accent === "")时移除变量，回退到 token 默认。
 *   - zoom 用 CSS `zoom` 属性（Chromium / WebKit / WebView2 均支持，已为
 *     CSSOM 标准），而非 `transform: scale`：zoom 会重排布局并影响滚动
 *     区域，transform 只是视觉变换会导致滚动条错位；也不走 `html { font-size }`
 *     方案，因为本项目大量使用 px 硬编码（Tailwind 任意值 `text-[13px]` 等
 *     不跟随 html font-size）。
 *   - zoom 宿主选 `#root`（React 应用挂载点）而非 `<html>` 或 `<body>`：
 *       * 写 `<html>`：AppShell 的 `h-screen/w-screen`（= 100vh/100vw）
 *         在部分 Chromium 版本下仍按**物理视口**解析，叠加 zoom 后内容
 *         会被撑出窗口。
 *       * 写 `<body>`：布局问题解决了，但 Radix UI 的 Portal 默认挂载到
 *         `document.body` 下，也落在 zoom 子树内。Radix popper 定位通过
 *         `getBoundingClientRect()` 读取触发按钮的**物理坐标**（已含 zoom），
 *         再写到 Portal 内容的 `transform: translate(x, y)`；Portal 位于
 *         zoom 子树时这个 translate 值又会被 zoom **二次放大**，表现为
 *         下拉面板向右下偏移，缩放越大偏移越大。
 *       * 写 `#root`：应用内容跟随缩放，而 `<body>` 下与 `#root` 并列的
 *         `#portal-root`（见 index.html）位于 zoom 子树**外**，Radix Portal
 *         挂到那里，translate 值按 1:1 解释，popper 定位精确。
 *   - 前提：`<body>` 不承载任何可视内容，只是 #root 与 #portal-root 的
 *     父节点；AppShell / UnlockPage 用 `h-full w-full` 继承 #root 尺寸，
 *     不依赖 vh/vw 在 zoom 子树下的实现差异。
 */
export function ThemeSync() {
	const theme = usePrefsStore((s) => s.theme);
	const scale = usePrefsStore((s) => s.scale);
	const body = usePrefsStore((s) => s.body);
	const lang = usePrefsStore((s) => s.lang);
	const accent = usePrefsStore((s) => s.accent);
	const fontSans = usePrefsStore((s) => s.fontSans);
	const fontMono = usePrefsStore((s) => s.fontMono);

	// 主题 —— dark / light
	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
	}, [theme]);

	// 缩放 —— 80 / 90 / 100 / 110 / 125 / 150（百分比）
	// zoom 写到 `#root`（React 应用根节点），让 Radix Portal 的挂载点
	// `#portal-root`（#root 的兄弟节点）位于 zoom 子树外，popper 定位不
	// 受 zoom 二次放大影响；同时 AppShell 内的 `h-full/w-full` 继承 #root
	// 的逻辑尺寸，布局正确。100% 时清掉 inline 样式，让 DOM 回到"无任何
	// 缩放覆盖"的干净状态。
	useEffect(() => {
		const root = document.documentElement;
		const appRoot = document.getElementById("root");
		if (appRoot) {
			if (scale === "100") {
				appRoot.style.removeProperty("zoom");
			} else {
				appRoot.style.zoom = `${scale}%`;
			}
		}
		// data-scale 写在 <html> 上，便于 CSS 对特定缩放档做微调
		// （比如 150% 时加粗某些描边），也方便 e2e 测试断言
		root.setAttribute("data-scale", scale);
	}, [scale]);

	// 正文字体 —— sans / mono
	useEffect(() => {
		document.documentElement.setAttribute("data-body", body);
	}, [body]);

	// 界面语言 —— 同步 <html lang> + i18next
	useEffect(() => {
		document.documentElement.setAttribute(
			"lang",
			lang === "zh" ? "zh-CN" : "en",
		);
		setI18nLang(lang);
	}, [lang]);

	// 自定义正文字体 —— 见 applyUserFont 头注释解释为什么必须用 @font-face 别名
	useEffect(() => {
		applyUserFont({
			name: fontSans,
			cssVar: "--font-sans",
			alias: "ZPassUserSans",
			styleId: "zpass-user-font-sans",
			fallback:
				'"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
		});
	}, [fontSans]);

	// 自定义等宽字体 —— 同正文字体策略
	useEffect(() => {
		applyUserFont({
			name: fontMono,
			cssVar: "--font-mono",
			alias: "ZPassUserMono",
			styleId: "zpass-user-font-mono",
			fallback:
				'"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
		});
	}, [fontMono]);

	// 用户启用自定义正文字体时，关掉 Geist 专属的 OpenType 特性 ——
	// `font-feature-settings: "ss01" "cv11" "calt"` 是为 Geist 调优的字形开关，
	// 其他字体（尤其是中文 / 等宽 / 像素字体）要么没有这些 feature tag，
	// 要么映射到完全不同的字形，会让用户字体在 body 文本上出现意料外的字形跳变。
	// 切换回内置字体时再恢复 Geist 的 feature 配置。
	useEffect(() => {
		if (fontSans?.trim()) {
			document.documentElement.setAttribute("data-custom-sans", "true");
		} else {
			document.documentElement.removeAttribute("data-custom-sans");
		}
	}, [fontSans]);

	// 口音色 —— 覆盖 CSS 变量 --accent（用户可在 Tweaks 面板切换）
	useEffect(() => {
		const root = document.documentElement;
		if (accent?.trim()) {
			root.style.setProperty("--accent", accent);
		} else {
			root.style.removeProperty("--accent");
		}
	}, [accent]);

	return null;
}

export default ThemeSync;
