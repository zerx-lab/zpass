import { useEffect } from "react";
import { tinykeys } from "tinykeys";
import { useLockStore } from "@/stores/lock";
import { useUIStore } from "@/stores/ui";

/**
 * 全局快捷键映射（仅 Wails / 桌面 webview 生效）
 *
 *   $mod+K   切换 ⌘K 命令面板（Cmd on mac / Ctrl on win/linux）
 *   $mod+L   立即锁定保险库
 *   $mod+N   触发"新建条目"信号 —— 由 VaultPage 订阅 useUIStore.newItemRequest
 *            打开 NewItemDialog；不在 /vault 时由 Topbar 自身的 New 按钮处理跳转，
 *            这里只负责发信号
 *   Escape   关闭命令面板
 *
 * 设计说明：
 *   - $mod+N 不做"如果当前不在 /vault 就先 navigate"的逻辑 —— Shortcuts
 *     组件是无渲染副作用层，不持有路由能力。VaultPage 订阅 newItemRequest
 *     时若自身已挂载会立刻打开对话框；若用户在 /generator / /health 按
 *     ⌘N，理想行为应该是仍能新建（毕竟用户期待"任何地方按 ⌘N 都能新建"）。
 *     但这要求新建对话框跟随路由跳转 —— 当前简化策略是：仅在 /vault 路由
 *     下 ⌘N 真正生效；其它路由按 ⌘N 等价于"啥也没发生"，避免在 Generator
 *     页突然弹出与上下文无关的 vault 对话框造成困惑。
 *
 *     未来要做"全局 ⌘N"，正确姿势是把 ⌘N 处理移到 Topbar.tsx 内（或一个
 *     位于 RouterProvider 子树的 Shortcuts 组件），那里能调 useNavigate。
 *     当前 Shortcuts 在 RouterProvider 之外（见 App.tsx 的挂载顺序），
 *     不能用 navigate。
 */

/**
 * 全局快捷键注册组件
 * ---------------------------------------------------------------------------
 * 对标 ZPassDesign/src/app.jsx 中的 useEffect(onKey) 块：
 *   - $mod+K  → 切换 ⌘K 命令面板（Cmd on mac / Ctrl on win/linux）
 *   - $mod+L  → 立即锁定保险库
 *
 * 选用 `tinykeys` 而非手写 `window.addEventListener("keydown")`：
 *   1. 原生支持 `$mod` 跨平台修饰符（自动映射 mac ⌘ / 其它 Ctrl）
 *   2. 组合键解析稳定，避免 IME 合成中 key 乱码的坑
 *   3. 返回 unbind 闭包便于组件卸载时清理，防内存泄漏
 *
 * 设计上本组件不渲染任何 DOM，只负责副作用注册。挂在 <App /> 顶层即可，
 * 解锁态 / 未解锁态都生效（⌘L 在未解锁时是 no-op，⌘K 由 UI 层决定是否响应）。
 */
export function Shortcuts() {
	const toggleCmdk = useUIStore((s) => s.toggleCmdk);
	const closeCmdk = useUIStore((s) => s.closeCmdk);
	const requestNewItem = useUIStore((s) => s.requestNewItem);
	const lock = useLockStore((s) => s.lock);

	useEffect(() => {
		const unbind = tinykeys(window, {
			// ⌘K / Ctrl+K —— 切换命令面板
			"$mod+KeyK": (e: KeyboardEvent) => {
				e.preventDefault();
				toggleCmdk();
			},
			// ⌘L / Ctrl+L —— 一键锁定（同时关闭命令面板避免残留）
			"$mod+KeyL": (e: KeyboardEvent) => {
				e.preventDefault();
				closeCmdk();
				lock();
			},
			// ⌘N / Ctrl+N —— 触发"新建条目"信号（由 VaultPage 订阅）
			//
			// 关掉命令面板再发信号：用户在 cmdk 打开时按 ⌘N 也能进入新建流程
			// （cmdk 自身不消费 ⌘N，所以信号会同时触发 cmdk close + dialog open）
			"$mod+KeyN": (e: KeyboardEvent) => {
				e.preventDefault();
				closeCmdk();
				requestNewItem();
			},
			// Esc —— 关闭命令面板（tinykeys 原生 key 名）
			Escape: () => {
				closeCmdk();
			},
		});

		return () => {
			unbind();
		};
	}, [toggleCmdk, closeCmdk, lock, requestNewItem]);

	return null;
}

export default Shortcuts;
