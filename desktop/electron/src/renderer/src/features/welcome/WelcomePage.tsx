// 欢迎页 —— 首次启动的入口选择屏
// ---------------------------------------------------------------------------
// 产品定位：
//   用户首次打开 desktop 客户端时看到的第一屏。提供两个并列选项：
//     1. 登录云端账户 —— 跳到 /signin 填写邮箱/密码（非开源，无法自托管）
//     2. 跳过 —— 进入访客（本地）模式，不做云端同步
//
//   用户一旦做出选择（useAccountStore.mode 从 "pending" 变为 "guest" 或
//   "signed-in"），OnboardingGuard 会把 /welcome 变成不可达路径 —— 下次
//   启动直接进入主流程（或首启引导），不再反复打扰。
//
// ---------------------------------------------------------------------------
// 视觉基调：对齐 UnlockPage 的严格黑白高级感
//   - 不使用任何 accent 彩色；对比度靠 text / bg / line 三层 token 拉开
//   - 两个按钮共享同一"描边卡片"骨架（圆角 / 底色 / 尺寸一致）
//   - 主次差异通过"边框亮度 + 图标方块强度 + 右侧 affordance"表达，
//     不再用反色实心白底 —— 原方案 bg-(--text) 在暗色主题下过于刺眼，
//     与整体黑白高级基调割裂（用户反馈"看不清 / 跟深色 UI 冲突"）。
//     新方案对齐 Linear / Raycast / 1Password 暗色按钮的克制风格：
//       · 主选项（登录）：border --text-3（亮）+ 图标方块 --bg-active 带亮描边 +
//                        图标色 --text；hover → border --text-2 + bg --bg-active
//       · 次选项（跳过）：border --line（柔和）+ 图标方块 --bg-elev 带柔边 +
//                        图标色 --text-2；hover → border --text-3 + 图标 --text
//     两者 hover 都不改成"白底"，只调整描边与对比度，保持暗色下眼睛舒适。
//   - 产品希望默认引导用户登录以获得云同步，但不强推 —— 所以主选项仅在
//     描边和图标上"稍亮一档"，而非靠反色喊叫。
//   - 不做任何渐变 / 阴影 / 光晕装饰 —— 首屏即建立"本软件严肃克制"的质感
//
// ---------------------------------------------------------------------------
// 结构约束：
//   - 与 UnlockPage 共用一套"mini titlebar + 主内容滚动容器"骨架
//   - mini titlebar：仅拖动区 + 关闭按钮（无最小化/最大化，符合"未完成
//     身份选择时功能克制"的安全直觉）
//   - 平台差异：macOS 左侧预留 --titlebar-traffic-lights-inset，不渲染
//     自定义关闭按钮；Windows / Linux 右侧渲染自定义按钮，hover 对齐
//     Fluent 规范
//   - 根节点 h-full overflow-hidden，内容区独立 flex-1 overflow-y-auto，
//     避免 zoom 子树下 titlebar 被滚走（同 UnlockPage 的经验，详见该文件注释）

import { Cloud, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { MiniTitlebar } from "@/components/MiniTitlebar";
import { useAccountStore } from "@/stores/account";

/**
 * 欢迎页组件
 *
 * 路由：/welcome（由 OnboardingGuard 在 mode === "pending" 时强制重定向到此）
 *
 * 交互：
 *   - 点"登录" → navigate("/signin")：进入账户密码表单；只有 SignInPage
 *     提交成功后才会 accountStore.signIn() 改变 mode，此处仅负责跳转。
 *   - 点"跳过" → accountStore.continueAsGuest()：mode 变为 "guest"，
 *     OnboardingGuard 监听到变化后放行到下一阶段（/onboarding 或 /vault）。
 *     这里不手动 navigate —— 交给守卫统一分流，避免出现"Welcome 自己 navigate
 *     去了 A，守卫又重定向到 B"的双重跳转抖动。
 */
export function WelcomePage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const continueAsGuest = useAccountStore((s) => s.continueAsGuest);

	// 云端登录入口 —— 跳到 /signin 填写邮箱/主密码/Secret Key。只有 SignInPage
	// 提交成功后才会 accountStore.signIn() 改变 mode，此处仅负责跳转。
	const onSignIn = () => {
		navigate("/signin");
	};

	const onSkip = () => {
		// 1. 切 store：mode 从 "pending" 变为 "guest"
		// 2. 显式 navigate 到 /vault —— 必须跳一个"受 OnboardingGuard 守卫"的
		//    路由，才能触发守卫重新分流。
		//
		// ⚠️ 早期实现是"只 setState、不 navigate，交给守卫统一分流"，但那是
		//    错误的：OnboardingGuard 只在**进入受守卫路由**时运行守卫逻辑；
		//    用户停留在 /welcome（守卫外的裸路由）时，store 变化只触发 React
		//    重渲染，URL 没变，守卫根本不会被挂载/重新求值 —— 用户会看到
		//    "点了跳过但页面毫无反应"。
		//
		//    正确姿势：把"动作完成"和"路由切换"合并，跳到 /vault 让守卫接手：
		//      - 已完成 onboarding（有空间）→ 守卫放行到 /vault 主界面
		//      - 未完成 onboarding         → 守卫重定向到 /onboarding 引导页
		//    replace=true 避免 /welcome 留在历史栈，按"后退"不会倒回欢迎页。
		continueAsGuest();
		navigate("/vault", { replace: true });
	};

	return (
		<main className="welcome relative flex h-full flex-col items-stretch overflow-hidden bg-(--bg)">
			{/*
				Mini titlebar —— 与 UnlockPage 保持一致的骨架
				z-10 + relative：确保内容区滚动时 titlebar 底边 border 压在内容之上
			*/}
			<MiniTitlebar />

			{/*
				主内容滚动容器
				- flex-1 min-h-0 overflow-y-auto：独立滚动，titlebar 不受影响
				- py-10 提供滚动态的上下呼吸
				- items-center justify-center 让卡片始终视觉居中
			*/}
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
				<div className="welcome-card flex w-full max-w-md flex-col gap-8">
					{/* Brand —— 纯黑白方块（与 UnlockPage 同款，强化品牌一致性） */}
					<div className="flex items-center gap-3">
						<div className="flex h-10 w-10 items-center justify-center rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) font-mono text-[17px] font-semibold text-(--text)">
							Z
						</div>
						<div className="flex flex-col leading-tight">
							<span className="text-[17px] font-semibold text-(--text)">
								ZPass
							</span>
							<span className="text-xs text-(--text-3)">
								{t("welcome_brand_sub")}
							</span>
						</div>
					</div>

					{/* 主标题 + 副文案 */}
					<div className="flex flex-col gap-2">
						<h1 className="text-xl font-semibold tracking-tight text-(--text)">
							{t("welcome_title")}
						</h1>
						<p className="text-sm leading-relaxed text-(--text-2)">
							{t("welcome_sub")}
						</p>
					</div>

					{/*
						两个选项卡 —— 上下堆叠而非左右并列
						理由：
						  1. 上下堆叠在窄窗口（960px 以下）不需要 responsive fallback
						  2. 主次差异通过"边框亮度 + 图标强度 + 右侧 badge"表达，
						     不再用反色白底（刺眼、与暗色基调割裂）
						  3. 每个卡片可以有自己的描述行，用户一眼能理解两种模式的差异

						视觉设计（对齐 Linear / Raycast / 1Password 暗色主题按钮）：
						  - 两个按钮共享同一骨架：rounded-xl + bg-(--bg-elev-2) + 描边
						  - 主选项：描边用 --text-3（亮）、图标方块底色 --bg-active +
						            描边 --text-3 + 图标色 --text；hover 时边 → --text-2、
						            图标方块边 → --text-2，形成"整张卡向观察者靠近一步"
						            的层级反馈
						  - 次选项：描边用 --line（柔和分隔线）、图标方块底色 --bg-elev-2 +
						            描边 --line + 图标色 --text-2；hover 时边 → --text-3、
						            图标 → --text
						  - 两个 hover 态都不改底色（避免"按下即变白"的刺眼感），只
						    调整描边 + 图标对比度，保持暗色下的克制质感

						为什么用 inline style 而不是纯 Tailwind 短语法：
						  Tailwind v4 的 `bg-(--*)/alpha` 任意变量 + 透明度组合在某些
						  环境下会被静默丢弃（之前 bug 修复记录过）。本次改造完全不
						  依赖 alpha，一律用纯 token 写死，CSS 变量值直接消费，两套
						  主题（dark / light）都能稳定渲染。
					*/}
					<div className="flex flex-col gap-3">
						{/*
							主选项：登录云端账户
							----------------------------------------------------------------
							云同步后端（零知识账户 P2 + 同步引擎 P3）已落地，登录入口
							正式开放。描边 / 图标方块比"跳过"亮一档，表达"前-后"层级与
							"推荐登录以获得云同步"的产品意图，但不靠反色实心白底喊叫
							（暗色下刺眼，与黑白基调割裂——见文件顶部视觉注释）。
						*/}
						<button
							type="button"
							onClick={onSignIn}
							className="group flex items-center gap-4 rounded-xl border border-(--line) bg-(--bg-elev-2) px-5 py-3 text-left transition-colors hover:border-(--text-3) hover:bg-(--bg-active)"
						>
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-(--line) bg-(--bg-active) transition-colors group-hover:border-(--text-3)">
								<Cloud
									size={18}
									strokeWidth={1.5}
									className="text-(--text) transition-colors"
								/>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="text-sm font-semibold text-(--text)">
									{t("welcome_signin_title")}
								</span>
								<span className="text-xs leading-relaxed text-(--text-3)">
									{t("welcome_signin_desc")}
								</span>
							</div>
						</button>

						{/*
							次选项：跳过（访客 / 本地模式）
							描边更柔和、图标色更灰，与主选项形成"前-后"层级关系，
							但 hover 态仍提供清晰的交互反馈。
						*/}
						<button
							type="button"
							onClick={onSkip}
							className="group flex items-center gap-4 rounded-xl border border-(--line-soft) bg-(--bg-elev-2) px-5 py-3 text-left transition-colors hover:bg-(--bg-active)"
						>
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-(--line) bg-(--bg-elev) transition-colors">
								<UserRound
									size={18}
									strokeWidth={1.5}
									className="text-(--text-2) transition-colors group-hover:text-(--text)"
								/>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="text-sm font-semibold text-(--text)">
									{t("welcome_skip_title")}
								</span>
								<span className="text-xs leading-relaxed text-(--text-3)">
									{t("welcome_skip_desc")}
								</span>
							</div>
							<span className="shrink-0 rounded-sm border border-(--line) bg-(--bg-elev) px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-(--text-3) uppercase transition-colors group-hover:text-(--text-2)">
								{t("welcome_skip_badge")}
							</span>
						</button>
					</div>
				</div>
			</div>
		</main>
	);
}

export default WelcomePage;
