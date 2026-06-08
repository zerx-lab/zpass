import { RouterProvider } from "react-router-dom";
import { AutoLock } from "@/app/AutoLock";
import { CloudAutoRestore } from "@/app/CloudAutoRestore";
import { CloudEventSync } from "@/app/CloudEventSync";
import { LockSync } from "@/app/LockSync";
import { router } from "@/app/router";
import { Shortcuts } from "@/app/Shortcuts";
import { SpaceSync } from "@/app/SpaceSync";
import { ThemeSync } from "@/app/ThemeSync";
import { VaultEventSync } from "@/app/VaultEventSync";
import { ApprovalToast } from "@/features/sshagent/ApprovalToast";

/**
 * 应用根组件
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 挂载 <ThemeSync />  —— 把 usePrefsStore 的偏好同步到 <html data-*>
 *      与 CSS 变量，所有样式规则都走属性选择器（见 src/styles/tokens.css）。
 *   2. 挂载 <Shortcuts />  —— 注册全局快捷键（⌘K 命令面板 / ⌘L 锁定 / Esc）。
 *   3. 挂载 <RouterProvider /> —— 由 router 决定渲染 UnlockPage 还是 AppShell。
 *
 * CmdK 命令面板的挂载位置：
 *   ⚠️ 不在本组件中直接渲染 <CmdK />，而是放在 router.tsx 的 RootLayout 内。
 *   原因：react-router v7 的 createBrowserRouter 采用数据路由模式，Router
 *   上下文只在 <RouterProvider> 的子树内部可用。CmdK 依赖 useNavigate /
 *   useLocation 等 hook，必须挂载在 router 子树中才能拿到上下文，否则
 *   会报 "useNavigate() may be used only in the context of a <Router> component"。
 *
 *   RootLayout（见 src/app/router.tsx）作为所有路由的顶层父节点，负责渲染
 *   <CmdK />，同时通过 <Outlet /> 渲染具体页面。这样 CmdK 仍然是"全局 overlay"
 *   （对 /unlock 和所有已解锁路由均生效），且处于 Router 上下文中。
 *
 * 注意事项：
 *   - <ThemeSync /> 与 <Shortcuts /> 必须在 <RouterProvider /> 之前或同级渲染，
 *     这样它们的 useEffect 早于首个路由视图挂载执行，避免 FOUC 或首次按键失效。
 *   - 两者都不渲染任何 DOM，只订阅 store 并执行副作用，不会影响路由布局。
 *   - i18next 的初始化发生在 src/i18n/index.ts 顶层导入时（见 main.tsx），
 *     ThemeSync 内的 setI18nLang 只负责把 store 的 lang 同步过去，不做二次 init。
 *
 * 对标设计：ZPassDesign/src/app.jsx 中的 App 组件 —— 那里用 useState + useEffect
 * 把 theme/scale/body/lang 写到 documentElement，并监听 keydown 处理 ⌘K/⌘L；
 * 在 React 路由化后这两类副作用拆成独立组件，职责更清晰、更易测试。
 */
export function App() {
	return (
		<>
			<ThemeSync />
			<Shortcuts />
			{/*
			 * 锁定状态启动同步 —— 在挂载时探测后端 vault 真实状态
			 * （Status().Unlocked），若后端仍持有 DEK 则把前端 useLockStore
			 * 翻成解锁态，避免 webview 刷新后被强制重新输入主密码。
			 * 详见 src/app/LockSync.tsx 头部注释。
			 *
			 * 必须在 <RouterProvider /> 之前挂载，让 LockGuard 在首次
			 * 渲染前就能拿到正确的 locked 值，避免一闪解锁屏。
			 */}
			<LockSync />
			<VaultEventSync />
			{/*
			 * 云同步事件桥 —— 订阅 cloud:* 后端事件，驱动 useCloudStore 状态更新
			 * （同步进度 / 认证变化 / 冲突通知）。同时在 mount 时调用 init()
			 * 初始化云端配置并拉取 status，所有路由均生效。
			 */}
			<CloudEventSync />
			{/*
			 * 云会话自动恢复 —— 信任设备免主密码启动时，等「本地已解锁 + 云端已配置
			 * + 尚未登录」条件齐备后用 DEK 包裹凭据重建云会话。详见 CloudAutoRestore.tsx。
			 */}
			<CloudAutoRestore />
			{/*
			 * 空间隔离同步 —— 把前端 activeSpaceId 推给后端 currentSpaceID，
			 * 并在切空间 / 解锁时认领历史数据 + 重载列表。详见 SpaceSync.tsx。
			 */}
			<SpaceSync />
			{/*
			 * 自动锁定触发器 —— 监听窗口失焦（lockOnSwitch）和系统休眠
			 * （lockOnSleep）事件，在偏好开关打开时自动调用 useLockStore.lock()。
			 * 详见 src/app/AutoLock.tsx 头部注释。
			 */}
			<AutoLock />
			<RouterProvider router={router} />
			{/*
			 * SSH agent 签名确认 modal —— 全局事件监听器，仅在有 in-flight
			 * approval 时渲染 fixed overlay，无需 props。详见
			 * src/features/sshagent/ApprovalToast.tsx 头部注释。
			 *
			 * 挂在 RouterProvider 后面：overlay 需要 z-index 高于所有路由页
			 * 面内容，但不依赖 Router 上下文（不调用 useNavigate 等 hook）。
			 */}
			<ApprovalToast />
		</>
	);
}

export default App;
