// 应用路由定义
// 基于 react-router-dom v7，使用 createBrowserRouter 数据路由 API
//
// ---------------------------------------------------------------------------
// 路由树结构：
//
//   <RootLayout>                                          ← 根 Layout，挂载全局 overlay
//     ├── /welcome         → <WelcomePage />              ← 账户模式未决（pending）时的入口
//     ├── /signin          → <SignInPage />               ← 云端账户登录表单
//     ├── /onboarding      → <OnboardingPage />           ← 首次创建空间
//     │
//     └── <OnboardingGuard>                               ← 账户模式 + 空间引导双重分流
//           ├── /unlock          → <UnlockPage />
//           │
//           └── <LockGuard>                               ← 路由守卫（locked → 重定向到 /unlock）
//                 └── <AppShell>                          ← 已解锁主界面骨架（Sidebar + Topbar + Outlet）
//                       ├── /        → <Navigate to="/vault" />
//                       ├── /vault           → <VaultPage />
//                       ├── /vault/:itemId   → <VaultPage />（深链选中条目）
//                       ├── /generator       → <GeneratorPage />
//                       ├── /health          → <HealthPage />
//                       └── /settings        → <SettingsLayout />（嵌套子路由，
//                                                每个菜单一个面板，index→appearance）
//
//   *  → <Navigate to="/vault" />                         ← 兜底（由 OnboardingGuard 接管再分流）
//
// ---------------------------------------------------------------------------
// 为什么需要 RootLayout：
//   react-router v7 的 createBrowserRouter + RouterProvider 采用"数据路由"模式，
//   Router 上下文（useNavigate / useLocation / useMatch 等 hook 依赖的 context）
//   **只在 <RouterProvider> 的子树内部**可用。如果把 <CmdK />（或任何需要用
//   Router hook 的全局 overlay）挂在 <RouterProvider> 的兄弟位置，就会报：
//
//     Error: useNavigate() may be used only in the context of a <Router> component.
//
//   解决方案：在 router 配置顶部加一个空的"根 Layout"路由，用 <Outlet /> 渲染
//   真正的页面分支，并在 Layout 内部一并挂载需要 Router 上下文的全局 overlay
//   组件（CmdK、未来可能的 Toast / ContextMenu / Modal 管理器等）。
//
//   这样：
//     - CmdK 仍然是"全局 overlay"（独立于 AppShell / UnlockPage，在任意路由下
//       都可用）
//     - 被 RouterProvider 包裹，可以自由使用 react-router 的所有 hook
//     - <Outlet /> 保证子路由正常渲染，RootLayout 本身不引入视觉节点
//
// ---------------------------------------------------------------------------
// 双重守卫分层（OnboardingGuard + LockGuard）：
//
//   OnboardingGuard 守"身份 + 首次配置"：
//     - account.mode === "pending"           → 重定向到 /welcome
//     - hasCompletedOnboarding === false     → 重定向到 /onboarding
//     - 两者都通过                           → 放行到下层（LockGuard）
//
//   LockGuard 守"保险库锁定态"：
//     - locked === true                      → 重定向到 /unlock
//     - locked === false                     → 放行到 AppShell
//
//   为什么 /welcome、/signin、/onboarding 必须放在 OnboardingGuard **之外**
//   （作为兄弟路由而非子路由）：
//     守卫本身会把 "pending" 用户重定向到 /welcome；如果 /welcome 本身
//     也被守卫包裹，就会形成无限重定向（pending → /welcome → 守卫检查还是
//     pending → /welcome → ...）。把这三个裸路由放在守卫外，是打破循环的
//     必要前提。
//
//   为什么 /unlock 放在 OnboardingGuard **之内**（不像 welcome 那样裸置）：
//     尚未选择账户模式 / 尚未创建空间的用户，看到"解锁保险库"页面是矛盾的
//     —— 他们还没有可以锁定的东西。先完成身份选择 + 空间创建，再进入
//     lock/unlock 语义才自洽。
//
// ---------------------------------------------------------------------------
// 锁定守卫 <LockGuard>：
//   /unlock 之外所有已解锁路由都由 <LockGuard> 守卫 —— locked=true 时强制
//   重定向到 /unlock，解锁后才放行到 AppShell。详见 src/app/LockGuard.tsx。

import { useEffect } from "react";
import {
	createBrowserRouter,
	Navigate,
	Outlet,
	useNavigate,
} from "react-router-dom";
import { AppShell } from "@/app/AppShell";
import { LockGuard } from "@/app/LockGuard";
import { OnboardingGuard } from "@/app/OnboardingGuard";
import { CmdK } from "@/components/CmdK";
import { Toast } from "@/components/Toast";
import { GeneratorPage } from "@/features/generator/GeneratorPage";
import { HealthPage } from "@/features/health/HealthPage";
import { OnboardingPage } from "@/features/onboarding/OnboardingPage";
import { CloudSyncSection } from "@/features/settings/CloudSyncSection";
import { LanSyncSection } from "@/features/settings/LanSyncSection";
import { SettingsLayout } from "@/features/settings/SettingsLayout";
import { AboutSection } from "@/features/settings/sections/AboutSection";
import { AppearanceSection } from "@/features/settings/sections/AppearanceSection";
import { LanguageSection } from "@/features/settings/sections/LanguageSection";
import { SecuritySection } from "@/features/settings/sections/SecuritySection";
import { SpacesSection } from "@/features/settings/sections/SpacesSection";
import { TrustedDeviceSection } from "@/features/settings/sections/TrustedDeviceSection";
import { WindowSection } from "@/features/settings/sections/WindowSection";
import { SignInPage } from "@/features/signin/SignInPage";
import { SshAgentSection } from "@/features/sshagent/SshAgentSection";
import { TotpPage } from "@/features/totp/TotpPage";
import { UnlockPage } from "@/features/unlock/UnlockPage";
import { VaultPage } from "@/features/vault/VaultPage";
import { WelcomePage } from "@/features/welcome/WelcomePage";
import { useLockStore } from "@/stores/lock";

/**
 * 根 Layout —— 所有路由的公共父节点
 *
 * 职责：
 *   1. 作为 <RouterProvider> 上下文边界内的最外层组件，让全局 overlay 可以
 *      放在这里并使用 useNavigate / useLocation / useMatch 等 Router hook。
 *   2. 通过 <Outlet /> 渲染真正的子路由（welcome / signin / onboarding /
 *      OnboardingGuard 分支）。
 *
 * 不做的事：
 *   - 不提供任何视觉布局（AppShell 才是已解锁态的视觉骨架）
 *   - 不处理锁定逻辑（交给 <LockGuard>）
 *   - 不处理账户 / 引导分流（交给 <OnboardingGuard>）
 *   - 不同步主题 / 快捷键（那是 App.tsx 里 <ThemeSync> / <Shortcuts> 的职责）
 *
 * 挂载在这里的全局组件：
 *   - <CmdK />  ⌘K 命令面板。关闭态不进入 DOM，不影响布局；用 <dialog> 原生
 *               top-layer 保证浮在所有其它 UI 之上，不受 overflow:hidden 影响。
 *               注意：在 welcome / signin / onboarding 页面下 CmdK 也会响应
 *               ⌘K，但这些页面 Topbar 没有搜索入口，实际上不会被触发；
 *               保留在此处是为了代码路径单一。
 */
function RootLayout() {
	const navigate = useNavigate();
	const lock = useLockStore((s) => s.lock);

	// ─────────────────────────────────────────────────────────────
	// 原生 App Menu 命令桥接
	// ---------------------------------------------------------------------------
	// macOS 系统菜单栏（main.ts `installAppMenu`）里有 "Preferences…" /
	// "Lock Vault" 两项，点击时主进程通过 webContents.send 把指令推到这里。
	// 渲染进程在 RouterProvider 子树内才能调 useNavigate，所以挂载在
	// RootLayout 而不是 App.tsx 兄弟层的 Shortcuts。
	// 三端一致：Win/Linux 没原生菜单也仍能收到命令（IPC 通道存在），
	// 未来加 tray 菜单"打开偏好"同样复用这条通道。
	// ─────────────────────────────────────────────────────────────
	useEffect(() => {
		const desk = window.desktop?.window;
		if (!desk?.onMenuCommand) return;
		const unsubSettings = desk.onMenuCommand("open-settings", () => {
			navigate("/settings");
		});
		const unsubLock = desk.onMenuCommand("lock", () => {
			lock();
		});
		return () => {
			unsubSettings();
			unsubLock();
		};
	}, [navigate, lock]);

	return (
		<>
			<Outlet />
			<CmdK />
			{/*
			 * 全局 Toast 容器
			 * ---------------------------------------------------------------------------
			 * 与 CmdK 同样挂在 RootLayout：所有路由共享同一个 toast 栈，组件
			 * 内部订阅 useUIStore.toasts。任何业务侧调 useUIStore.pushToast()
			 * 都会在右下角弹出反馈，不需要在每个页面各自渲染。
			 */}
			<Toast />
		</>
	);
}

/**
 * 路由表
 *
 *   /welcome      — 首次启动欢迎页，登录/跳过二选一（OnboardingGuard 外）
 *   /signin       — 云端账户登录表单（OnboardingGuard 外）
 *   /onboarding   — 首次创建空间引导（OnboardingGuard 外）
 *   /unlock       — 解锁屏（OnboardingGuard 内，LockGuard 外）
 *   /             — 默认跳转到 /vault
 *   /vault        — 保险库（列表 + 详情）
 *   /vault/:id    — 保险库，带深链选中条目
 *   /generator    — 密码生成器
 *   /health       — 安全中心
 *   /settings     — 设置
 *
 *   *             — 其余路径跳到 /vault（由 OnboardingGuard / LockGuard 再分流）
 */
export const router = createBrowserRouter([
	{
		// 根节点 —— 不指定 path，意味着匹配所有路径，仅作为 Context 容器
		element: <RootLayout />,
		children: [
			// ─────────────────────────────────────────────────────────────
			// 裸路由区：account.mode === "pending" 或 spaces 为空时的入口
			//
			// 这三条路径不经 OnboardingGuard 守护，避免循环重定向。守卫把
			// pending 用户重定向到 /welcome —— 如果 /welcome 本身也在守卫内，
			// 会形成 pending → /welcome → 守卫检查还是 pending → /welcome …
			// 的死循环。
			//
			// 这些页面自身负责引导用户完成必要动作（点"跳过" / 提交登录表单 /
			// 创建第一个空间），完成后 store 状态变更会让 OnboardingGuard
			// 下次检查时放行。
			// ─────────────────────────────────────────────────────────────
			{
				path: "/welcome",
				element: <WelcomePage />,
			},
			{
				path: "/signin",
				element: <SignInPage />,
			},
			{
				path: "/onboarding",
				element: <OnboardingPage />,
			},

			// ─────────────────────────────────────────────────────────────
			// 受 OnboardingGuard 守护的路由子树
			//
			// 进入此分支的前提：
			//   - account.mode !== "pending"（用户已选择登录或跳过）
			//   - spaces.hasCompletedOnboarding === true（至少创建过一个空间）
			//
			// 任一条件不满足时，OnboardingGuard 会 <Navigate> 到上面对应的
			// 裸路由；满足时渲染 <Outlet /> 放行到下层。
			// ─────────────────────────────────────────────────────────────
			{
				element: <OnboardingGuard />,
				children: [
					{
						path: "/unlock",
						element: <UnlockPage />,
					},
					{
						element: <LockGuard />,
						children: [
							{
								element: <AppShell />,
								children: [
									{
										index: true,
										element: <Navigate to="/vault" replace />,
									},
									{
										path: "vault",
										element: <VaultPage />,
									},
									{
										path: "vault/:itemId",
										element: <VaultPage />,
									},
									{
										path: "generator",
										element: <GeneratorPage />,
									},
									{
										// TOTP 聚合页 ——
										// 工作区级跨类型视图，把所有含 totp 字段的条目
										// 聚到一起，列表 + 详情布局，沿用 VaultPage 视觉。
										path: "totp",
										element: <TotpPage />,
									},
									{
										path: "health",
										element: <HealthPage />,
									},
									{
										// 设置页 —— layout 路由：每个菜单是一个子路由，
										// 只挂载当前面板（性能优先），index 重定向到外观，
										// 覆盖全部 navigate("/settings") 入口。
										path: "settings",
										element: <SettingsLayout />,
										children: [
											{
												index: true,
												element: <Navigate to="appearance" replace />,
											},
											{
												path: "appearance",
												element: <AppearanceSection />,
											},
											{ path: "language", element: <LanguageSection /> },
											{ path: "spaces", element: <SpacesSection /> },
											{ path: "window", element: <WindowSection /> },
											{ path: "security", element: <SecuritySection /> },
											{
												path: "trusted-device",
												element: <TrustedDeviceSection />,
											},
											{
												path: "ssh-agent",
												element: <SshAgentSection />,
											},
											{ path: "lan-sync", element: <LanSyncSection /> },
								{ path: "cloud-sync", element: <CloudSyncSection /> },
											{ path: "about", element: <AboutSection /> },
										],
									},
								],
							},
						],
					},
				],
			},

			// ─────────────────────────────────────────────────────────────
			// 兜底：未知路径 → /vault
			//
			// OnboardingGuard 会再次分流：pending 用户从 /vault 会被再重定向
			// 到 /welcome，已完成引导的用户直接进入 /vault。这里不直接写
			// /welcome 是为了让"正常用户"与"深链回跳"走同一条路径，减少
			// 条件分支。
			// ─────────────────────────────────────────────────────────────
			{
				path: "*",
				element: <Navigate to="/vault" replace />,
			},
		],
	},
]);

export default router;
