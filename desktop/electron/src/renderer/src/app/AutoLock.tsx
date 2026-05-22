import { useEffect, useRef } from "react";
import { Events } from "@wailsio/runtime";
import { useLockStore } from "@/stores/lock";
import { usePrefsStore } from "@/stores/prefs";

/**
 * AutoLock —— 自动锁定触发器
 * ---------------------------------------------------------------------------
 * 职责：根据用户在设置页配置的两个偏好，监听对应的系统/窗口事件，
 * 并在触发时调用 `useLockStore.lock()` 锁定保险库。
 *
 * 覆盖的两个偏好字段：
 *   - `lockOnSwitch`  切换到其他应用时锁定
 *   - `lockOnSleep`   系统休眠或屏幕锁定时锁定
 *
 * ---------------------------------------------------------------------------
 * 事件来源
 *
 * ### lockOnSwitch — 切换到其他应用
 *
 * 使用 `common:WindowLostFocus`（Wails v3 跨平台事件）作为主要信号。
 * 该事件由 Wails 运行时在宿主窗口失去焦点时统一触发，覆盖 Windows / macOS /
 * Linux 三端，无需平台分支。
 *
 * 补充 `window blur` DOM 事件作为兜底——在 Wails devserver 热重载模式下
 * Wails 运行时事件总线有时还未就绪，DOM 事件可确保行为一致。
 *
 * 注意：最小化窗口也会导致 WindowLostFocus / window blur 触发。
 * 对于密码管理器而言，最小化时锁定是合理的安全行为，因此不做额外过滤。
 * 如未来需要区分"最小化 vs 切换应用"，可监听 `common:WindowMinimise` 做状态标记。
 *
 * ### lockOnSleep — 系统休眠 / 屏幕锁定
 *
 * 多层信号叠加，任意一层触发即可：
 *
 * 1. `windows:APMSuspend`（Wails Windows 专有）—— WM_POWERBROADCAST + PBT_APMSUSPEND，
 *    覆盖"关盖休眠"、"开始菜单→休眠"、"屏幕保护锁定"等场景。
 *
 * 2. `document visibilitychange` hidden —— Page Visibility API，跨平台通用。
 *    在系统锁屏、切换虚拟桌面（某些 OS 版本）、应用被遮挡等场景会触发。
 *    在 Wails webview 中，屏幕锁定会把 document 置为 hidden。
 *    注意：切换到其他应用不会使 document 变 hidden（webview 仍在前台绘制缓冲），
 *    因此 lockOnSwitch 不能单靠 visibilitychange。
 *
 * 3. `mac:ApplicationWillResignActive`（macOS）—— 应用即将失活（包括系统睡眠前
 *    OS 通知所有应用），与 APMSuspend 在 macOS 侧等价。
 *
 * ---------------------------------------------------------------------------
 * 防重复触发
 *
 * 多个信号可能在同一个"休眠/切换"事件中连续抵达（例如切换应用时同时触发
 * WindowLostFocus 和某个平台事件）。使用一个 `locking` ref 标记"本次已调用
 * lock()"，在 50ms 窗口内忽略重复信号，避免 lock() 被调用多次（当前 lock()
 * 是幂等的，但保持防抖更健壮，也更容易扩展将来的锁定副作用）。
 *
 * ---------------------------------------------------------------------------
 * 不做的事
 *
 * - 不处理 `lockTimeout`（那是 LockTimer 组件的职责，按空闲计时）
 * - 不处理 `lockOnClose`（由 Wails WindowClosing 事件或 beforeunload 处理）
 * - 不在已经 locked=true 时重复执行 lock()（useLockStore.lock() 内部幂等，
 *   这里额外读 locked 状态做短路，减少无意义调用）
 *
 * ---------------------------------------------------------------------------
 * 挂载位置
 *
 * 在 App.tsx 中与 ThemeSync / Shortcuts / LockSync 平级挂载，位于
 * RouterProvider 之外，保证在所有路由（含 /unlock）下均有效。
 */
export function AutoLock() {
	const lockOnSwitch = usePrefsStore((s) => s.lockOnSwitch);
	const lockOnSleep = usePrefsStore((s) => s.lockOnSleep);

	// 用 ref 持有最新 pref 值供事件回调读取，避免闭包陈旧值问题
	const lockOnSwitchRef = useRef(lockOnSwitch);
	const lockOnSleepRef = useRef(lockOnSleep);

	useEffect(() => {
		lockOnSwitchRef.current = lockOnSwitch;
	}, [lockOnSwitch]);

	useEffect(() => {
		lockOnSleepRef.current = lockOnSleep;
	}, [lockOnSleep]);

	useEffect(() => {
		// 防重复触发：50ms 内只执行一次 lock()
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;

		// ── 收进托盘抑制窗口 ────────────────────────────────────────
		//
		// 主进程在 win.hide() 之前会同步 executeJavaScript 到渲染端设
		// `window.__zpassTrayHideAt = Date.now()`（见 main.ts 的 tray-close 处理
		// 逻辑）。这样不管随后 hide 同步派发的 visibilitychange / blur 多快
		// 到达，本闭包能看到一个合法的“刚刚才干的”时间戳；500ms 内一律
		// 当作托盘隐藏导致的副作用，不触发 lock。
		//
		// 为什么不只靠 IPC：
		//   webContents.send 与 renderer 事件循环是异步的 —— win.hide() 映发的
		//   visibilitychange 是同步 dispatch 的，会赶在 IPC 消息之前被本
		//   handler 看到。只靠 IPC 设 flag 太晚、拦不住。executeJavaScript
		//   是唯一能让主进程 "同步" 在 renderer 里跳完一段 JS 的通道。
		//
		// IPC `desktop:hiding-to-tray` 仍保留作为辅助信号：三是给其他渲染端
		// 代码预留一个 hookable 事件，二是抹除 race 竟然逆转的极端场景下多
		// 一道保险（同时 refresh 一下 suppressUntil）。
		const SUPPRESS_AFTER_TRAY_HIDE_MS = 500;
		let suppressUntil = 0;

		function nowSuppressed(): boolean {
			// 主信号：主进程同步植入的时间戳
			const planted = (window as unknown as { __zpassTrayHideAt?: number })
				.__zpassTrayHideAt;
			if (
				typeof planted === "number" &&
				Date.now() - planted < SUPPRESS_AFTER_TRAY_HIDE_MS
			) {
				return true;
			}
			// 辅助信号：IPC 抵达后设的 suppressUntil（依然可能有用 —— 比如
			// executeJavaScript 失败但 IPC 还能走完，只是抵达顺序被动接受）
			if (Date.now() < suppressUntil) return true;
			return false;
		}

		function triggerLock(reason: string) {
			if (nowSuppressed()) {
				console.warn(
					`[AutoLock] suppressed (tray-hide window) — reason: ${reason}`,
				);
				return;
			}

			// 已经锁定，短路
			if (useLockStore.getState().locked) return;

			if (debounceTimer !== null) return;
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
			}, 50);

			console.warn(`[AutoLock] locking vault — reason: ${reason}`);
			useLockStore.getState().lock();
		}

		// 订阅主进程发出的「即将收进托盘」事件
		// onHidingToTray 是 preload 暴露的非 Wails 通道，preload 未就绪时
		// （e.g. dev server 热重启窗口期）`window.desktop` 可能短暂为空，
		// 这里做防御性判空避免主线程崩。
		let offHidingToTray: (() => void) | undefined;
		const subscribe = window.desktop?.window?.onHidingToTray;
		console.warn(
			`[AutoLock] hiding-to-tray subscribe available: ${typeof subscribe === "function"}`,
		);
		try {
			offHidingToTray = subscribe?.(() => {
				suppressUntil = Date.now() + SUPPRESS_AFTER_TRAY_HIDE_MS;
				console.warn(
					`[AutoLock] hiding-to-tray received — suppress until ${suppressUntil}`,
				);
			});
		} catch (err) {
			console.warn("[AutoLock] failed to subscribe hiding-to-tray", err);
		}

		// ── 切换应用信号 ──────────────────────────────────────────────────────

		// Wails 跨平台失焦事件（主信号）
		const offLostFocus = Events.On("common:WindowLostFocus", () => {
			if (lockOnSwitchRef.current) triggerLock("common:WindowLostFocus");
		});

		// DOM blur 兜底（devserver / runtime 未就绪时）
		function onWindowBlur() {
			if (lockOnSwitchRef.current) triggerLock("window.blur");
		}
		window.addEventListener("blur", onWindowBlur);

		// ── 休眠 / 屏幕锁定信号 ─────────────────────────────────────────────

		// Windows APM 休眠（WM_POWERBROADCAST PBT_APMSUSPEND）
		const offAPMSuspend = Events.On("windows:APMSuspend", () => {
			if (lockOnSleepRef.current) triggerLock("windows:APMSuspend");
		});

		// macOS 应用即将失活（含系统睡眠通知）
		const offMacResign = Events.On("mac:ApplicationWillResignActive", () => {
			if (lockOnSleepRef.current)
				triggerLock("mac:ApplicationWillResignActive");
		});

		// Page Visibility API（跨平台通用，屏幕锁定时 document 变 hidden）
		function onVisibilityChange() {
			if (document.visibilityState === "hidden" && lockOnSleepRef.current) {
				triggerLock("visibilitychange:hidden");
			}
		}
		document.addEventListener("visibilitychange", onVisibilityChange);

		// ── 清理 ──────────────────────────────────────────────────────────────
		return () => {
			if (debounceTimer !== null) clearTimeout(debounceTimer);

			window.removeEventListener("blur", onWindowBlur);
			document.removeEventListener("visibilitychange", onVisibilityChange);

			// Events.On 返回注销函数；某些 alpha 版本可能不返回，安全调用
			try {
				offLostFocus?.();
			} catch {
				/* noop */
			}
			try {
				offAPMSuspend?.();
			} catch {
				/* noop */
			}
			try {
				offMacResign?.();
			} catch {
				/* noop */
			}
			try {
				offHidingToTray?.();
			} catch {
				/* noop */
			}
		};
	}, []); // 空依赖：只挂载一次，通过 ref 读取最新 pref

	// 纯副作用组件，不渲染任何 DOM
	return null;
}

export default AutoLock;
