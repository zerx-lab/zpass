// 首次引导路由守卫 —— 账户模式 + 空间 onboarding 双重分流
// ---------------------------------------------------------------------------
// 职责：
//   在 LockGuard 之外单独一层路由守卫，负责首次启动 / 未完成配置的用户
//   分流。决策树：
//
//   ┌─────────────────────────────┐
//   │ account.mode === "pending"? │───Yes──► 强制重定向到 /welcome
//   └──────────────┬──────────────┘
//                  │ No（guest / signed-in）
//                  ▼
//   ┌─────────────────────────────────┐
//   │ hasCompletedOnboarding === true? │───No──► 强制重定向到 /onboarding
//   └──────────────┬──────────────────┘
//                  │ Yes
//                  ▼
//             放行（<Outlet />），进入 LockGuard → AppShell
//
// ---------------------------------------------------------------------------
// 为什么要独立一层守卫（而不是在 LockGuard 里一并处理）：
//   1. 职责单一：LockGuard 只关心"保险库是否锁定"，OnboardingGuard 只关心
//      "用户是否完成了身份选择 + 首次空间创建"。两者的触发条件、恢复路径
//      完全独立，合并会让任一条件变更都要改动一个臃肿的守卫组件。
//   2. 路由层级：
//        RootLayout
//          ├─ /welcome                    ← OnboardingGuard 之外
//          ├─ /signin                     ← OnboardingGuard 之外
//          ├─ /onboarding                 ← OnboardingGuard 之外（自己就是目标）
//          └─ OnboardingGuard
//                └─ /unlock               ← 锁定页在身份选择之后才可达
//                └─ LockGuard
//                      └─ AppShell
//                            └─ /vault 等
//      把 OnboardingGuard 放在 /unlock 之前（而非之后）的原因：尚未选择
//      账户模式 / 未创建空间的用户看到锁定页是矛盾的 —— 他们还没有可以
//      "锁定"的东西。必须先完成身份 + 空间配置，再进入锁定/解锁语义。
//
// ---------------------------------------------------------------------------
// Hydration 时序陷阱：
//   zustand persist 的 rehydrate 是异步的（走 Tauri invoke → 文件 IO），
//   组件首次渲染时 store 还是默认值（mode = "pending"，hasCompletedOnboarding
//   = false），此时守卫会错误地把**已经配置完的老用户**也送去 /welcome。
//   用户看到的现象：每次启动先闪一下欢迎页，然后瞬间跳到主界面。
//
//   解决方案：订阅 persist 的 `hasHydrated()` 状态，hydration 完成前本
//   守卫不做任何分流决策，渲染一个占位骨架（就是空的 <main bg-(--bg) />
//   避免白屏）。只有 hasHydrated === true 时才读 mode / hasCompletedOnboarding
//   做判断。
//
//   该模式和 LockGuard 的直接读 locked 不同 —— lock store 不走 persist，
//   默认值（locked=true）即是正确的初始态；而 account / spaces 的默认
//   值是"未决"，必须等持久化数据加载完才能判断。
//
// ---------------------------------------------------------------------------
// 循环重定向防御：
//   如果 OnboardingGuard 守护了 /onboarding 本身，就会造成循环（pending
//   用户进 /onboarding → 守卫又重定向到 /welcome → ...）。因此 /welcome
//   /signin /onboarding 三条路径必须放在守卫的**兄弟位置**（router.tsx
//   中同级 children），守卫只守它们之外的路由。

import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAccountStore } from "@/stores/account";
import { useSpacesStore } from "@/stores/spaces";

/**
 * 订阅 persist hydrate 完成状态
 *
 * zustand persist 在 store 上挂了 `persist.hasHydrated()` / `onHydrate`
 * / `onFinishHydration` API。这里用 useState + useEffect 的组合把"是否
 * 完成 hydrate"变成 React 可响应的状态。
 *
 * 注意：
 *   - account 和 spaces 两个 store 的 hydrate 是独立异步流程，必须**都**
 *     完成后才能做分流判断。二者缺一 → 可能出现 mode 是持久化值但
 *     hasCompletedOnboarding 还是默认 false 的错位状态。
 *   - 即使某个 store 的 Tauri 读取失败（文件损坏 / 权限问题），persist
 *     也会调用 `setHasHydrated(true)` 标记完成（回落到默认值），不会
 *     永远卡在 loading —— 这是 zustand 的保底行为。
 */
function useAllStoresHydrated(): boolean {
	// 读取初始值 —— 如果应用跑到这里时 persist 已经完成（比如 HMR / 组件
	// 卸载重挂），useState 的初始化就直接拿到 true，不必等一轮 effect
	const [hydrated, setHydrated] = useState<boolean>(() => {
		const a = useAccountStore.persist.hasHydrated();
		const s = useSpacesStore.persist.hasHydrated();
		return a && s;
	});

	useEffect(() => {
		if (hydrated) return;

		// 用一个 flag 防止卸载后仍 setState（StrictMode 下首次 effect
		// 会被 double-invoke，需要冪等清理）
		let cancelled = false;

		const check = () => {
			if (cancelled) return;
			const a = useAccountStore.persist.hasHydrated();
			const s = useSpacesStore.persist.hasHydrated();
			if (a && s) setHydrated(true);
		};

		// 注册完成回调：两个 store 任一完成时重新检查一遍联合状态
		// onFinishHydration 返回一个 unsubscribe 函数
		const unsubA = useAccountStore.persist.onFinishHydration(check);
		const unsubS = useSpacesStore.persist.onFinishHydration(check);

		// 注册回调之后再检查一次 —— 避免"注册前刚好完成"的竞态
		check();

		return () => {
			cancelled = true;
			unsubA();
			unsubS();
		};
	}, [hydrated]);

	return hydrated;
}

/**
 * Hydration 进行中的占位视图
 *
 * 不渲染 loading spinner / 文案，避免"闪一下加载中"的体感 —— Tauri 本地
 * 文件 IO 在正常情况下毫秒级就能完成，专门做的 loading 反而成了视觉噪声。
 * 只渲染一个纯背景色 <main>，用户看到的就是"应用刚启动时的深色空屏"，
 * 随后迅速被真正的页面覆盖。
 *
 * 背景色用 bg-(--bg) 而非硬编码：保证遵循用户选择的主题（即便 prefs
 * 还没 hydrate 完，默认值 dark 也与 tauri.conf.json 的窗口 backgroundColor
 * 一致，不会出现闪白边）。
 */
function HydrationPlaceholder() {
	return <main className="h-full w-full bg-(--bg)" />;
}

/**
 * Onboarding 守卫组件
 *
 * 必须挂在 RouterProvider 子树中（使用 useLocation / <Navigate>）。
 * 对应路由配置见 src/app/router.tsx —— 作为 /welcome、/signin、/onboarding
 * 三个"裸"路由的兄弟节点，守护其余所有路由。
 *
 * 守卫行为：
 *   - mode === "pending"             → 重定向到 /welcome
 *   - mode 已决但空间列表为空         → 重定向到 /onboarding
 *   - 上述都通过                      → <Outlet /> 放行到下层（LockGuard）
 *
 * state.from 记录：与 LockGuard 的思路一致，重定向时把当前路径塞进
 * location.state.from。这样 WelcomePage → SignInPage → OnboardingPage
 * 完成配置后，理论上可以回到用户最初想访问的深链（比如用户双击 URL
 * Scheme 直接打开 zpass:///vault/xxx）。当前 welcome/onboarding 流程
 * 没有消费这个字段（完成后统一走 /vault），保留是为未来 deep link 做准备。
 */
export function OnboardingGuard() {
	const hydrated = useAllStoresHydrated();
	const mode = useAccountStore((s) => s.mode);
	const hasCompletedOnboarding = useSpacesStore((s) => s.hasCompletedOnboarding);
	const location = useLocation();

	// 等两个 persist store 都 hydrate 完再做分流判断，避免首帧闪屏
	if (!hydrated) {
		return <HydrationPlaceholder />;
	}

	// 第一层：账户模式未决 → 欢迎页
	if (mode === "pending") {
		return <Navigate to="/welcome" replace state={{ from: location.pathname + location.search }} />;
	}

	// 第二层：账户已决但首次空间未创建 → 引导页
	if (!hasCompletedOnboarding) {
		return (
			<Navigate to="/onboarding" replace state={{ from: location.pathname + location.search }} />
		);
	}

	// 全部通过：交给下层（LockGuard → AppShell）
	return <Outlet />;
}

export default OnboardingGuard;
