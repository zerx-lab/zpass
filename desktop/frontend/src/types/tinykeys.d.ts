// tinykeys 类型补丁
// ---------------------------------------------------------------------------
// tinykeys 包已在 `dist/tinykeys.d.ts` 提供了官方声明文件，但其 package.json
// 的 "exports" 字段没有为 "types" 条件映射该声明，导致 TypeScript 在
// moduleResolution: "bundler" / "node16" 下无法解析到类型，报：
//
//   TS7016: Could not find a declaration file for module 'tinykeys'.
//     There are types at '.../dist/tinykeys.d.ts', but this result could not
//     be resolved when respecting package.json "exports".
//
// 本文件重导出官方声明，作为应用级兜底。待上游修复 exports 后可删除。
// 相关 issue：https://github.com/jamiebuilds/tinykeys —— 若版本升级后已修复
// 本 patch，请一并删除本文件并回归测试 ⌘K / ⌘L 快捷键。

declare module "tinykeys" {
	export type KeyBindingMap = Record<string, (event: KeyboardEvent) => void>;

	export interface KeyBindingOptions {
		/**
		 * 键盘事件名（默认 "keydown"）。某些场景需要在 keyup 触发时可覆盖。
		 */
		event?: "keydown" | "keyup";
		/**
		 * 事件捕获阶段（默认 false，即冒泡阶段）。
		 */
		capture?: boolean;
		/**
		 * 时间窗口（毫秒），用于序列键识别（如 "g i"）。默认 1000。
		 */
		timeout?: number;
	}

	/**
	 * 在指定目标上注册一组键绑定；返回 unbind 闭包，调用后移除所有监听。
	 *
	 * @param target  绑定目标，通常传 `window` 或具体 DOM 元素
	 * @param keyBindingMap  键字符串 → handler 映射，支持 `$mod+KeyK` 等语法
	 * @param options  可选参数（事件阶段、时间窗口等）
	 * @returns  解绑函数，在 React useEffect cleanup 中调用
	 */
	export function tinykeys(
		target: Window | HTMLElement | Document,
		keyBindingMap: KeyBindingMap,
		options?: KeyBindingOptions,
	): () => void;
}
