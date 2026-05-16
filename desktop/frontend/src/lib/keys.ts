// ----------------------------------------------------------------------------
// 快捷键符号工具（Keyboard Shortcut Glyphs）
// ----------------------------------------------------------------------------
//
// 背景：
//   ZPass 桌面端跨 macOS / Windows / Linux 三平台。同一组 tinykeys "$mod+K"
//   在 mac 上是 ⌘K，在 win/linux 上是 Ctrl+K。UI 层（CmdK 命令面板、Topbar
//   搜索提示、VaultPage 键盘提示尾栏、WorkspaceSwitcher 设置项右侧 hint…）
//   到处需要把组合键渲染给用户看。
//
//   过去的做法是 i18n 字典里硬编码 "⌘⇧C 复制密码"，这有两个根本问题：
//     1. 按键符号是「平台」属性而不是「语言」属性 —— 中文用户在 Windows 上
//        看到 ⌘ 一样困惑；i18n 字典处理这件事是错位。
//     2. 多处硬编码（CmdK 的 ⌘N / ⌘L / ⌃N、Topbar 的 ⌘、WorkspaceSwitcher
//        的 ⌘,、VaultPage 的尾栏…）每处都要 isMacOS() 判断一次，分支散落
//        不一致（mac 用 ⌘ 还是 Cmd？win 用 Ctrl 还是 Ctrl+？shift 用 ⇧
//        还是 Shift？）。
//
// 设计：
//   1. 单一抽象「按键描述符」: KeyDescriptor —— 用语义 token 表达组合键，
//      不含任何具体符号。例如 { mod: true, shift: true, key: "C" } 表示
//      "$mod+Shift+C"。这与 tinykeys 的绑定形式天然对应：业务代码注册
//      绑定时用 "$mod+Shift+KeyC"，渲染时用对应描述符即可。
//   2. 单一渲染入口 formatShortcut(desc) → string：按当前平台拼出最终
//      展示文字。mac 用合写紧凑符号 (⌘⇧C)，win/linux 用 + 号分段
//      (Ctrl+Shift+C)，与各自平台用户的肌肉记忆一致。
//   3. 也导出 KEY_SYMBOL —— 单个键的符号映射，给「只想展示一个键」的
//      场景（如 CmdK 底部 ↑↓ ⏎ Esc 提示）使用，无需走 KeyDescriptor 包装。
//
// 平台差异参考：
//   - macOS HIG: 修饰键合写不带分隔符（⌃⌥⇧⌘C），字母大写。
//   - Microsoft Win11 风格指南: Ctrl+Shift+C，单词全拼，用 + 号。
//   - GNOME / KDE: 多数沿用 Win 风格 (Ctrl+Shift+C)，本工具与 Windows 同处理。
//
// ----------------------------------------------------------------------------

import { isMacOS } from "@/lib/platform";

// ---------------------------------------------------------------------------
// 单键符号映射
// ---------------------------------------------------------------------------
//
// 命名约定与 KeyboardEvent.key / tinykeys "$mod+KeyX" 中 X 部分对齐
// （字母 / 数字 / 方向键 / 控制键），方便绑定声明与渲染两侧语义一致。
//
// 方向键 / 回车 / Esc / Tab 等无关平台的"硬件键"使用 Unicode 箭头与控制符号 ——
// 这些在 mac 与 win 上都是公认的 kbd 渲染惯例（VS Code、Linear、Raycast 等都
// 这么显示），不强行区分平台。
const NAV_SYMBOLS: Record<string, string> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Enter: "⏎",
	Escape: "Esc",
	Tab: "⇥",
	Backspace: "⌫",
	Delete: "⌦",
	Space: "Space",
};

// macOS 修饰键符号（HIG 标准）
const MAC_MOD_SYMBOLS = {
	mod: "⌘", // Command
	ctrl: "⌃", // Control（独立修饰，与 mod 区分）
	alt: "⌥", // Option / Alt
	shift: "⇧",
} as const;

// Windows / Linux 修饰键符号（拼写形式）
const WIN_MOD_SYMBOLS = {
	mod: "Ctrl",
	ctrl: "Ctrl",
	alt: "Alt",
	shift: "Shift",
} as const;

// ---------------------------------------------------------------------------
// 公共类型 / 入口
// ---------------------------------------------------------------------------

/**
 * 按键描述符
 *
 * - `mod` 表示"主修饰键"，与 tinykeys 的 `$mod` 对齐：mac → ⌘，其它 → Ctrl。
 *   绝大多数业务快捷键应该用 `mod` 而不是 `ctrl`，这样跨平台行为一致。
 * - `ctrl` 仅在需要"明确就是 Control，即使在 mac 上也要 Control 而非 Command"
 *   时使用（如 CmdK 中的 ⌃N / ⌃P vim/readline 风格导航键）。
 * - `key` 是要按的"主键"，可以是单个字母（"C" / "K"）、数字、或 NAV_SYMBOLS
 *   中的语义名（"ArrowUp" / "Enter"）。也允许直接传任意已是符号的字符串
 *   （如 ","），按原样输出。
 */
export interface KeyDescriptor {
	mod?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
	key: string;
}

/**
 * 把单个键名转成展示符号
 *
 * - NAV_SYMBOLS 命中则返回对应 Unicode 字符
 * - 单字母统一大写（kbd 视觉惯例）
 * - 其它原样返回（数字 / 标点 / 已经是符号的字符串）
 */
export function formatKey(key: string): string {
	if (key in NAV_SYMBOLS) return NAV_SYMBOLS[key];
	if (key.length === 1) return key.toUpperCase();
	return key;
}

/**
 * 把按键描述符渲染成跨平台展示文本
 *
 * mac 风格（合写、紧凑）:
 *   { mod: true, shift: true, key: "C" }  → "⌘⇧C"
 *   { mod: true, key: "K" }                → "⌘K"
 *   { ctrl: true, key: "N" }               → "⌃N"
 *   { mod: true, key: "," }                → "⌘,"
 *
 * win/linux 风格（+ 号分段、单词拼写）:
 *   { mod: true, shift: true, key: "C" }  → "Ctrl+Shift+C"
 *   { mod: true, key: "K" }                → "Ctrl+K"
 *   { ctrl: true, key: "N" }               → "Ctrl+N"
 *   { mod: true, key: "," }                → "Ctrl+,"
 *
 * 修饰键顺序遵循各平台惯例：
 *   mac: Control → Option → Shift → Command（最外侧到最内侧），与系统
 *        菜单栏快捷键的渲染顺序一致。
 *   win: Ctrl → Alt → Shift → Key，遵循 MS 风格指南。
 *
 * 注意：mac 上 mod 与 ctrl 是不同的修饰键（⌘ vs ⌃），同时设置时会渲染
 * 两个；win/linux 上 mod 与 ctrl 都映射到 Ctrl，同时设置时去重只显示一次
 * 避免出现 "Ctrl+Ctrl+N" 这种重复。
 */
export function formatShortcut(desc: KeyDescriptor): string {
	const mac = isMacOS();
	const keyText = formatKey(desc.key);

	if (mac) {
		// mac HIG 顺序：⌃ ⌥ ⇧ ⌘ Key，无分隔符
		const parts: string[] = [];
		if (desc.ctrl) parts.push(MAC_MOD_SYMBOLS.ctrl);
		if (desc.alt) parts.push(MAC_MOD_SYMBOLS.alt);
		if (desc.shift) parts.push(MAC_MOD_SYMBOLS.shift);
		if (desc.mod) parts.push(MAC_MOD_SYMBOLS.mod);
		parts.push(keyText);
		return parts.join("");
	}

	// win/linux：Ctrl + Alt + Shift + Key，+ 号分段
	const parts: string[] = [];
	// mod 与 ctrl 在非 mac 平台都是 Ctrl，去重只 push 一次
	if (desc.mod || desc.ctrl) parts.push(WIN_MOD_SYMBOLS.mod);
	if (desc.alt) parts.push(WIN_MOD_SYMBOLS.alt);
	if (desc.shift) parts.push(WIN_MOD_SYMBOLS.shift);
	parts.push(keyText);
	return parts.join("+");
}

/**
 * 仅返回当前平台的"主修饰键"展示符号
 *
 * 适合只想在 UI 上显示一个 ⌘ / Ctrl 提示的极简场景（如 Topbar 搜索
 * 触发按钮的右侧 kbd，配合后续的 K 字面量自行拼接）。
 *
 * 注意：如果是完整组合键（mod + 字母），优先使用 formatShortcut() 而不是
 * 自己拼字符串，避免 mac 上漏掉 ⌘ 与字母之间没有 + 号的细节。
 */
export function modKeySymbol(): string {
	return isMacOS() ? MAC_MOD_SYMBOLS.mod : WIN_MOD_SYMBOLS.mod;
}

/**
 * 单个键的"展示符号"快捷查询
 *
 * 给"只想显示一个键"的场景使用（如 CmdK 底部 ↑↓ ⏎ Esc 提示行）。
 * 与 formatKey() 不同的是，这个表面向调用方暴露的是"按键名 → 符号"
 * 的纯映射，方便业务代码以常量形式引用（避免在 JSX 里写魔法字符串）。
 */
export const KEY_SYMBOL = {
	up: NAV_SYMBOLS.ArrowUp,
	down: NAV_SYMBOLS.ArrowDown,
	left: NAV_SYMBOLS.ArrowLeft,
	right: NAV_SYMBOLS.ArrowRight,
	enter: NAV_SYMBOLS.Enter,
	escape: NAV_SYMBOLS.Escape,
	tab: NAV_SYMBOLS.Tab,
	backspace: NAV_SYMBOLS.Backspace,
	delete: NAV_SYMBOLS.Delete,
	space: NAV_SYMBOLS.Space,
} as const;

// ---------------------------------------------------------------------------
// 业务侧常用快捷键描述符（集中声明，避免散落在各组件里重复书写）
// ---------------------------------------------------------------------------
//
// 命名约定：SHORTCUTS.<功能区>_<动作> 全大写下划线
// 对应的 tinykeys 绑定字符串注释在右侧，方便对照：
//
//   SHORTCUTS.CMDK_OPEN            "$mod+KeyK"
//   SHORTCUTS.LOCK                 "$mod+KeyL"
//   SHORTCUTS.NEW_ITEM             "$mod+KeyN"
//   SHORTCUTS.COPY_PASSWORD        "$mod+Shift+KeyC"
//   SHORTCUTS.COPY_USERNAME        "$mod+KeyB"
//   SHORTCUTS.SETTINGS             "$mod+Comma"
//   SHORTCUTS.CMDK_NAV_NEXT        "Control+KeyN"  (vim/readline 风格)
//   SHORTCUTS.CMDK_NAV_PREV        "Control+KeyP"
//
// 调用：formatShortcut(SHORTCUTS.COPY_PASSWORD) → "⌘⇧C" 或 "Ctrl+Shift+C"
export const SHORTCUTS = {
	CMDK_OPEN: { mod: true, key: "K" },
	LOCK: { mod: true, key: "L" },
	NEW_ITEM: { mod: true, key: "N" },
	COPY_PASSWORD: { mod: true, shift: true, key: "C" },
	COPY_USERNAME: { mod: true, key: "B" },
	SETTINGS: { mod: true, key: "," },
	CMDK_NAV_NEXT: { ctrl: true, key: "N" },
	CMDK_NAV_PREV: { ctrl: true, key: "P" },
	SIDEBAR_TOGGLE: { mod: true, key: "B" },
} as const satisfies Record<string, KeyDescriptor>;
