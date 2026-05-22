// 偏好设置 store —— theme / lang / scale / body / accent
// 基于 zustand persist，持久化到 localStorage
// 对标 ZPassDesign/src/app.jsx 中的 TWEAK_DEFAULTS 与 useState 块
//
// 注意：`locked`（锁定状态）不在这里管理，归 stores/lock.ts 专管。
// 原因：锁定属于运行时安全状态，不应持久化到磁盘；且其状态变化频率远高于
// 偏好项，单独切片可避免 prefs 的 persist 被频繁触发写入。
//
// v3 变更（2026-04）：原 `density`（compact/normal/comfy —— 只影响行高）
// 语义升级为 `scale`（界面整体缩放比例），通过 CSS `zoom` 属性对 <html>
// 生效，会等比放大字号/间距/图标/圆角，符合用户对"界面缩放"的直观预期。
// v2 存档中的 `density` 字段在 migrate 中被丢弃（任何档位都回落到 scale=100）。
// v4 变更（2026-04）：移除 `travel`（旅行模式）字段。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createTauriConfigStorage } from "@/lib/config-storage";

export type Theme = "dark" | "light";
/**
 * 界面缩放比例（百分比的字符串形式）
 *
 * 用字符串而非 number 的原因：
 *   - Select 组件的 value 用字符串更自然（option value 本来就是字符串）
 *   - 避免 `80 === "80"` 这类松比较坑
 *   - persist 序列化 / DOM attribute 全是字符串语义
 *
 * 取值范围覆盖常见桌面端缩放档位（对标 VS Code / Slack 的 Zoom 菜单）：
 *   80 / 90 / 100（默认）/ 110 / 125 / 150
 */
export type UiScale = "80" | "90" | "100" | "110" | "125" | "150";
export type Body = "sans" | "mono";
export type Lang = "en" | "zh";
export type LockTimeout = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "never";
/**
 * 关闭窗口按钮的行为
 *
 * - `quit` → 真的退出应用（默认；与 Electron `app.quit()` 等价）
 *           Linux/Windows 用户的传统预期。
 * - `tray` → 最小化到系统托盘（隐藏主窗口，不退出进程）
 *           托盘图标本身永远在；该选项只控制"关闭窗口"按钮的语义。
 *
 * 注意：该偏好不影响 macOS Cmd+Q（永远走真退出），
 * 也不影响 `before-quit` 阶段后端 sidecar 的清理逻辑。
 */
export type CloseBehavior = "quit" | "tray";

export interface PrefsState {
	/** 主题：暗色 / 亮色 */
	theme: Theme;
	/** 口音色（CSS 变量 --accent 的 hex 值） */
	accent: string;
	/**
	 * 界面缩放比例（百分比字符串）
	 *
	 * 由 ThemeSync 把该值写入 `<html style="zoom: <scale>%">`，整个应用的
	 * 字号 / 间距 / 图标 / 布局按比例缩放。默认 "100"。
	 */
	scale: UiScale;
	/** 正文字体：无衬线 / 等宽 */
	body: Body;
	/**
	 * 界面语言（当前实际生效的语言）
	 *
	 * 无论用户是"跟随系统"还是"显式指定"，这里始终保存一个具体语言值，
	 * 作为 ThemeSync / i18next / `<html lang>` / FOUC 脚本的唯一下游数据源。
	 * "是否跟随系统"这个意图由 {@link langFollowSystem} 单独表达。
	 */
	lang: Lang;
	/**
	 * 语言是否跟随系统
	 *
	 * - `true`  → 用户选择了"跟随系统"。此时 `lang` 会在每次启动时用
	 *            `detectSystemLang()` 刷新，使得系统语言变更后应用语言自动跟进。
	 * - `false` → 用户显式锁定了某种语言。即使系统语言改变，`lang` 也保持不变。
	 *
	 * 为什么不用 `lang === detectSystemLang()` 去推断而要单独持久化：
	 *   - 推断丢信息：当用户主动选中文、系统恰好也是中文时，两者相等，
	 *     无法区分"锁定中文"与"跟随系统"两种意图；一旦系统语言日后改为英文，
	 *     用户"锁定中文"的选择会被误当作"跟随系统"从而跟着变英文，违背意图。
	 *   - 显式状态 = 显式意图，避免任何歧义。
	 */
	langFollowSystem: boolean;
	/** 自动锁定超时时间 */
	lockTimeout: LockTimeout;
	/** 系统休眠时锁定 */
	lockOnSleep: boolean;
	/** 切换应用时锁定 */
	lockOnSwitch: boolean;
	/** 关闭窗口时锁定 */
	lockOnClose: boolean;
	/**
	 * 关闭按钮行为：退出应用 / 收进托盘
	 *
	 * 该值由 ThemeSync 在 hydrate 与变化时通过 `window.desktop.window.setCloseBehavior(v)`
	 * 推送给 Electron 主进程；主进程在 BrowserWindow 'close' 事件里据此决定
	 * `event.preventDefault() + win.hide()` 还是放行让窗口关闭。
	 */
	closeBehavior: CloseBehavior;
	/** 自定义正文字体（空串 = 使用内置 Geist） */
	fontSans: string;
	/** 自定义等宽字体（空串 = 使用内置 Geist Mono） */
	fontMono: string;

	setTheme: (theme: Theme) => void;
	setAccent: (accent: string) => void;
	setScale: (scale: UiScale) => void;
	setBody: (body: Body) => void;
	/**
	 * 显式设置语言（锁定到具体语言）
	 *
	 * 副作用：自动把 `langFollowSystem` 置为 `false` —— 用户一旦显式挑选，
	 * 就视为脱离"跟随系统"状态。
	 */
	setLang: (lang: Lang) => void;

	/** 切换主题（dark ↔ light） */
	toggleTheme: () => void;
	/**
	 * 切换到"跟随系统"
	 *
	 * 把 `langFollowSystem` 置 `true`，并把 `lang` 刷新为当前 `detectSystemLang()`，
	 * 这样 ThemeSync 会立即同步到 i18next / `<html lang>`。
	 */
	resetLangToSystem: () => void;
	setLockTimeout: (timeout: LockTimeout) => void;
	setLockOnSleep: (v: boolean) => void;
	setLockOnSwitch: (v: boolean) => void;
	setLockOnClose: (v: boolean) => void;
	setCloseBehavior: (v: CloseBehavior) => void;
	setFontSans: (font: string) => void;
	setFontMono: (font: string) => void;
}

/**
 * 检测系统语言
 * ---------------------------------------------------------------------------
 * 优先级：
 *   1. `navigator.languages[0]`（用户语言偏好顺序第一项，更准）
 *   2. `navigator.language`（回退）
 *   3. 硬回落到 `"en"`（SSR / 极端环境）
 *
 * 判定规则：任何以 `zh` 开头的 BCP-47 标签都视为中文（zh / zh-CN / zh-Hans 等），
 * 其余一律视为英文。这与 src/i18n/index.ts 中的 detectInitialLang 保持一致。
 *
 * 为什么单独放在这里（而不是从 @/i18n 导入）：
 *   - prefs 是"偏好真源"，i18n 只是"渲染运行时"。偏好层不应依赖渲染层。
 *   - 反向依赖（i18n 读 prefs）更合理：已在 ThemeSync 中完成。
 */
export function detectSystemLang(): Lang {
	if (typeof navigator === "undefined") return "en";
	const candidates: string[] = [];
	if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
		candidates.push(...navigator.languages);
	}
	if (navigator.language) candidates.push(navigator.language);
	for (const tag of candidates) {
		if (typeof tag === "string" && tag.toLowerCase().startsWith("zh")) {
			return "zh";
		}
	}
	return "en";
}

/**
 * 默认值
 * ---------------------------------------------------------------------------
 * 与 ZPassDesign 的 TWEAK_DEFAULTS 略有差异：
 *   - `accent` 不再默认为柠檬绿 `#d4ff3a`。ZPass 桌面客户端追求"高级感黑白"，
 *     主色由主题自身的 token 决定（dark → 近白 #ececec，light → 近黑 #141416），
 *     见 src/styles/tokens.css 中的 --accent 定义。
 *   - 这里把 accent 设为空串作为 sentinel：ThemeSync 检测到空串会 `removeProperty`
 *     掉 <html> 上的 --accent 覆盖，让 CSS 回落到 tokens.css 的值。
 *   - `lang` 使用 `detectSystemLang()` lazy 计算 —— 首次启动没有持久化数据时
 *     跟随系统语言，而不是硬编码 "en"。用户在 Settings 页显式选择后，
 *     persist 中间件会把选择写入 localStorage，下次启动从存储读回，
 *     不再调用 detectSystemLang。
 *   - 用户仍可在 Settings 页把语言重置回"跟随系统"，届时调用 resetLangToSystem。
 *
 * 用 `get()` 函数避免在模块首次 evaluation 时就访问 navigator（SSR 友好，
 * 同时允许测试在 create 之前 stub window.navigator）。
 */
export function getPrefsDefaults() {
	return {
		theme: "dark" as Theme,
		accent: "",
		scale: "100" as UiScale,
		body: "sans" as Body,
		lang: detectSystemLang(),
		// 首次启动（无持久化数据）默认跟随系统 —— 与上面 lang 的初值语义一致：
		// lang 取自 detectSystemLang()，langFollowSystem = true 让后续系统语言
		// 变更也能被自动采纳，符合"没做过任何选择"的用户期望。
		langFollowSystem: true,
		lockTimeout: "5m" as LockTimeout,
		lockOnSleep: true,
		lockOnSwitch: false,
		lockOnClose: true,
		// 默认沿用 Linux/Windows 传统：点关闭=真退出。
		// 想后台常驻的用户可在 Settings 里改为 "tray"。
		// macOS 的 Cmd+Q 由系统语义保证总能真退出，与此偏好无关。
		closeBehavior: "quit" as CloseBehavior,
		fontSans: "",
		fontMono: "",
	};
}

/**
 * 向后兼容的常量导出 —— 旧代码可能 `import { PREFS_DEFAULTS }` 直接读默认值。
 * 本常量在模块加载时 eager 计算一次；需要实时重算的地方请用 getPrefsDefaults()。
 */
export const PREFS_DEFAULTS = getPrefsDefaults();

export const usePrefsStore = create<PrefsState>()(
	persist(
		(set) => ({
			...getPrefsDefaults(),

			setTheme: (theme) => set({ theme }),
			setAccent: (accent) => set({ accent }),
			setScale: (scale) => set({ scale }),
			setBody: (body) => set({ body }),
			// 用户显式挑选语言 → 同时脱离"跟随系统"状态
			setLang: (lang) => set({ lang, langFollowSystem: false }),

			toggleTheme: () =>
				set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),

			// 切回"跟随系统"：立刻采用当前系统语言 + 标记意图
			resetLangToSystem: () =>
				set({ lang: detectSystemLang(), langFollowSystem: true }),
			setLockTimeout: (lockTimeout) => set({ lockTimeout }),
			setLockOnSleep: (lockOnSleep) => set({ lockOnSleep }),
			setLockOnSwitch: (lockOnSwitch) => set({ lockOnSwitch }),
			setLockOnClose: (lockOnClose) => set({ lockOnClose }),
			setCloseBehavior: (closeBehavior) => set({ closeBehavior }),
			setFontSans: (fontSans) => set({ fontSans }),
			setFontMono: (fontMono) => set({ fontMono }),
		}),
		{
			// name 同时也是 Rust 侧的 namespace，落盘到
			// ~/.config/zpass/zpass.prefs.json
			// 命名遵守 Rust 端 validate_namespace 白名单（[A-Za-z0-9_.-]）
			name: "zpass.prefs",
			// 走 Tauri 配置文件存储 —— 严禁使用 localStorage / IndexedDB
			// 等浏览器沙盒存储（产品硬性约束，详见 src/lib/config-storage.ts
			// 头部注释）
			storage: createTauriConfigStorage<Partial<PrefsState>>(),
			version: 7,
			// 仅持久化纯数据字段，action 方法不入库
			partialize: (state) => ({
				theme: state.theme,
				accent: state.accent,
				scale: state.scale,
				body: state.body,
				lang: state.lang,
				langFollowSystem: state.langFollowSystem,
				lockTimeout: state.lockTimeout,
				lockOnSleep: state.lockOnSleep,
				lockOnSwitch: state.lockOnSwitch,
				lockOnClose: state.lockOnClose,
				closeBehavior: state.closeBehavior,
				fontSans: state.fontSans,
				fontMono: state.fontMono,
			}),
			/**
			 * 迁移链
			 * ---------------------------------------------------------------
			 * v1 → v2：引入 `langFollowSystem` 字段。
			 *   v1 没有该字段；老用户的 `lang` 一定是通过 Settings 页显式
			 *   选过的（或首次启动时由 detectSystemLang 播种）。保守策略：
			 *   迁移一律置为 `false`（锁定当前语言）。理由：
			 *     - 用户升级前没有"跟随系统"这个概念，当前看到的语言就是
			 *       他们期望看到的；升级后如果系统语言突变而悄悄跟随，反而
			 *       打破信任。
			 *     - 真想跟随系统的用户，打开 Settings 选一下即可，成本极低。
			 *
			 * v2 → v3：`density`（compact/normal/comfy）→ `scale`（缩放百分比）。
			 *   旧 density 语义是"列表行高档位"，新 scale 语义是"界面整体
			 *   缩放比例"，两者不是一一映射关系。迁移一律丢弃 density，
			 *   scale 初始化为 "100"（默认原大小）。理由：
			 *     - compact/comfy 只影响 --dens-row/--dens-pad 两个变量，
			 *       且这两个变量实际未被任何组件消费（历史遗留），丢弃无损。
			 *     - 让所有老用户从"界面 100% 原大小"开始体验新缩放功能，
			 *       比强行映射到 90%/110% 更不打扰。
			 *
			 * v3 → v4：移除 `travel` 字段（旅行模式功能已从 UI 中去除）。
			 *   旧存储中若有 travel 字段，直接丢弃即可，不影响其他偏好。
			 *
			 * v6 → v7：新增 `closeBehavior`（quit / tray）。老用户保留传统
			 *   语义：关闭窗口=退出应用，避免升级后行为静默变化让人困惑。
			 */
			migrate: (persisted, version) => {
				const state = (persisted ?? {}) as Partial<PrefsState> & {
					density?: unknown;
					travel?: unknown;
				};
				let next: Partial<PrefsState> & {
					density?: unknown;
					travel?: unknown;
				} = state;

				if (version < 2) {
					next = { ...next, langFollowSystem: false };
				}
				if (version < 3) {
					// 丢弃旧 density 字段，注入默认 scale
					const { density: _d, ...rest } = next;
					next = { ...rest, scale: "100" as UiScale };
				}
				if (version < 4) {
					// 丢弃旧 travel 字段（旅行模式已移除）
					const { travel: _t, ...rest } = next;
					next = rest;
				}
				if (version < 5) {
					next = {
						...next,
						lockTimeout: "5m" as LockTimeout,
						lockOnSleep: true,
						lockOnSwitch: false,
						lockOnClose: true,
					};
				}
				if (version < 6) {
					next = { ...next, fontSans: "", fontMono: "" };
				}
				if (version < 7) {
					// 新增关闭按钮行为偏好。老用户保留"传统"语义：关闭=退出。
					next = { ...next, closeBehavior: "quit" as CloseBehavior };
				}

				return next as PrefsState;
			},
			/**
			 * rehydrate 钩子：如果用户选了"跟随系统"，启动时用当前系统语言刷新。
			 *
			 * 这里解决的是"昨天系统是 zh，今天系统切成 en"场景下，让跟随系统的
			 * 用户在下一次启动时自动切到新的系统语言 —— 因为 persist 里存的
			 * `lang` 是启动前一刻的快照，不会自动跟进。
			 */
			onRehydrateStorage: () => (state) => {
				if (state?.langFollowSystem) {
					const sys = detectSystemLang();
					if (sys !== state.lang) {
						state.lang = sys;
					}
				}
			},
		},
	),
);
