// 首次引导页 —— 创建第一个空间（Workspace / Space）
// ---------------------------------------------------------------------------
// 产品定位：
//   用户在 WelcomePage 做出选择（登录或跳过）后，如果 useSpacesStore 中
//   还没有任何空间（首次安装），OnboardingGuard 会把用户送到这里。
//
//   本页强制用户创建第一个空间，不可跳过 —— 因为空间是 vault 的容器，
//   没有空间就没有地方存账户。创建完成后 createSpace 会自动：
//     1. 把新空间加入 spaces 列表
//     2. 把 activeSpaceId 切到新空间
//     3. 把 hasCompletedOnboarding 置 true
//   随后 OnboardingGuard 感知到 hasCompletedOnboarding 变化，放行到 /vault。
//
//   已登录用户与访客用户走同一个 onboarding 流程，共享这一份 UI
//   —— 区别仅在于顶部问候语（通过 account.mode 区分文案）。
//
// ---------------------------------------------------------------------------
// 空间概念解释（首屏教育）：
//   用户第一次看到"空间"这个词会疑惑——不同于传统密码管理器的"文件夹"，
//   空间是顶层隔离容器（类似 1Password Accounts / Notion Workspaces）。
//   因此本页专门留一段说明文字，用"个人 / 工作 / 家庭"举例帮助用户建立
//   心智模型，再给出名称输入框。
//
// ---------------------------------------------------------------------------
// 视觉基调：
//   严格沿用 WelcomePage / SignInPage / UnlockPage 的黑白高级感：
//     - mini titlebar + 主内容滚动容器（zoom 子树下 titlebar 不被滚走）
//     - 卡片：rounded-xl + border-(--line) + bg-(--bg-elev)
//     - 输入框聚焦用 text 色描边（中性），不出现 accent 彩色
//     - 提交按钮白底黑字（dark）/ 黑底白字（light）
//     - 预设示例（Personal / Work / Family）做成可点击的 chip，点击后
//       自动把名字塞进输入框——既是文案示例，也是一键填充的快捷方式
//
// ---------------------------------------------------------------------------
// 实现要点：
//   - 用 useRef + useEffect 手动聚焦名称输入框（规避 biome/a11y
//     noAutofocus 规则，与 UnlockPage / SignInPage 一致）
//   - 只要求名字一个字段；glyph 由 name 首字符派生（与 spaces store 的
//     deriveGlyph 行为一致），降低首跑认知负担。后续用户可在 Sidebar
//     WorkspaceSwitcher 的"编辑"入口修改 glyph
//   - 提交后显式 navigate 到 /vault —— 必须跳一个"受 OnboardingGuard 守卫"
//     的路由才能触发守卫重新分流。仅 setState 不 navigate 的话，守卫根本
//     不会被挂载/求值（因为 /onboarding 本身在守卫外），用户会看到"点了
//     创建按钮但页面毫无反应"。详见 onSubmit 内部注释。
//   - 未登录（guest）模式下不渲染"切换账户"链接，只有 signed-in 时才显示

import { ArrowLeft, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { MiniTitlebar } from "@/components/MiniTitlebar";
import { useAccountStore } from "@/stores/account";
import { useSpacesStore } from "@/stores/spaces";

/**
 * 预设空间示例 —— 点击后把名字填入输入框
 *
 * 设计为"软引导"而非"必须从示例选一个"：用户完全可以自己打字，
 * 示例只是降低空白页面的决策成本（面对空白输入框时的选择瘫痪）。
 *
 * 用 i18n key 而不是写死中英文：切换语言时示例名会跟着翻译，保持一致性。
 * 这里 key 复用现有 Sidebar 用过的 nav_personal / nav_work，再加家庭一项。
 */
const PRESET_KEYS = [
	"onboarding_preset_personal",
	"onboarding_preset_work",
	"onboarding_preset_family",
] as const;

export function OnboardingPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const createSpace = useSpacesStore((s) => s.createSpace);
	const accountMode = useAccountStore((s) => s.mode);
	const user = useAccountStore((s) => s.user);
	const resetToPending = useAccountStore((s) => s.resetToPending);

	const [name, setName] = useState("");
	const [focused, setFocused] = useState(false);
	const [loading, setLoading] = useState(false);

	const inputRef = useRef<HTMLInputElement>(null);

	// 首屏挂载后把焦点放到名称输入框
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const trimmed = name.trim();
	// 名称长度限制：1..=32 —— 与 Sidebar WorkspaceSwitcher 的编辑态保持一致。
	// 超过 32 字符在 glyph 方块右侧的截断文本里会显得杂乱。
	const canSubmit = !loading && trimmed.length > 0 && trimmed.length <= 32;

	const onPresetClick = (key: string) => {
		// 把预设名塞进输入框并聚焦，让用户可以继续编辑（比如加个后缀）
		setName(t(key));
		inputRef.current?.focus();
	};

	/**
	 * 返回欢迎页 —— 让用户有机会改变主意（guest ↔ signed-in）
	 *
	 * 为什么**必须**先 resetToPending 再 navigate：
	 *   OnboardingGuard 的分流规则是：`mode !== "pending"` 且
	 *   `!hasCompletedOnboarding` → 强制重定向到 /onboarding。也就是说，
	 *   如果此时 mode 是 guest 或 signed-in（都是进入 onboarding 的前置
	 *   条件），直接 navigate 回 /welcome 只是短暂停留 —— 守卫下一轮求值
	 *   会立刻把用户又踢回 /onboarding，表现为"点返回无反应 / 闪一下"。
	 *
	 *   把 mode 重置为 pending 后，守卫的第一道分流条件（mode === pending
	 *   → /welcome）会主动把用户送到欢迎页，用户真正回到"选登录还是跳过"
	 *   的决策点。
	 *
	 *   副作用：如果此前是 signed-in，登录态会被清空。这是正确行为 ——
	 *   用户改主意要重选时，登录态留着没有意义，下次他选"跳过"反而会
	 *   让 Welcome 与 store 不一致。真正"我就是登录好的不想重选"的用户
	 *   根本不会点返回。
	 */
	const onBack = () => {
		resetToPending();
		navigate("/welcome", { replace: true });
	};

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSubmit) return;

		setLoading(true);

		// 短暂延迟模拟"正在创建"的反馈 —— 纯 UI 感受，避免点完按钮瞬间
		// 跳转让用户怀疑自己有没有点到。未来接入 vault 初始化（生成空间
		// 根加密 key 等）后这里是真实等待。
		await new Promise((r) => setTimeout(r, 240));

		// glyph 留空，让 createSpace 的默认派生逻辑（deriveGlyph）取首字符
		// tag 留空：首次引导不强制填 tag，空间卡片上的 tag 行可以为空
		createSpace({ name: trimmed });

		setLoading(false);

		// 显式 navigate 到 /vault —— 必须跳一个"受 OnboardingGuard 守卫"的
		// 路由，才能触发守卫重新分流。
		//
		// ⚠️ 早期实现是"只 createSpace、不 navigate，交给守卫统一分流"，
		//    但那是错误的：OnboardingGuard 只在**进入受守卫路由**时运行
		//    守卫逻辑；用户停留在 /onboarding（守卫外的裸路由）时，store
		//    变化只触发 React 重渲染，URL 没变，守卫根本不会被挂载/重新
		//    求值 —— 用户会看到"点了创建按钮但页面毫无反应"。
		//
		//    正确姿势：显式跳到 /vault，守卫检测到 hasCompletedOnboarding
		//    已为 true、mode 非 pending，直接放行到主界面。
		//    replace=true 避免 /onboarding 留在历史栈，防止进入主界面后
		//    按"后退"又倒回引导页。
		navigate("/vault", { replace: true });
	};

	// 顶部问候语 —— 根据账户模式区分文案
	//   - signed-in：使用 displayName 做个性化打招呼
	//   - guest：通用欢迎语，不暗示用户身份
	const greeting =
		accountMode === "signed-in" && user?.displayName
			? t("onboarding_greeting_named", { name: user.displayName })
			: t("onboarding_greeting");

	return (
		<main className="onboarding relative flex h-full flex-col items-stretch overflow-hidden bg-(--bg)">
			{/* Mini titlebar —— 与 WelcomePage / SignInPage / UnlockPage 保持一致 */}
			<MiniTitlebar brand="ZPass" />

			{/* 主内容滚动容器 */}
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
				<form
					onSubmit={onSubmit}
					className="onboarding-card flex w-full max-w-md shrink-0 flex-col gap-6 rounded-xl border border-(--line) bg-(--bg-elev) p-8 shadow-lg"
				>
					{/* 顶部：返回按钮 + Brand + 进度指示
					 *
					 * 左侧 Back 对齐 SignInPage 顶部的返回样式，语义一致：点击回
					 * 欢迎页重新选择登录/跳过。详见 onBack() 注释（必须先 reset
					 * mode 到 pending，否则守卫会把用户踢回 onboarding）。
					 *
					 * Back 按钮与 Step 标签共享左列（gap-2.5）；Brand 方块移到
					 * 中列以平衡视觉重心；Sparkles 仍在右侧作为装饰。
					 */}
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<Button
								variant="link"
								size="sm"
								type="button"
								onClick={onBack}
								leftIcon={<ArrowLeft size={13} strokeWidth={1.5} />}
							>
								{t("onboarding_back")}
							</Button>
							<span className="h-4 w-px bg-(--line-soft)" aria-hidden />
							<span className="font-mono text-[11px] tracking-[0.12em] text-(--text-3) uppercase">
								{t("onboarding_step")}
							</span>
						</div>
						<div className="flex items-center gap-2.5">
							<Sparkles
								size={14}
								strokeWidth={1.5}
								className="text-(--text-4)"
							/>
							<div className="flex h-8 w-8 items-center justify-center rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) font-mono text-[13px] font-semibold text-(--text)">
								Z
							</div>
						</div>
					</div>

					{/* 标题 + 副文案 */}
					<div className="flex flex-col gap-2">
						<span className="text-xs text-(--text-3)">{greeting}</span>
						<h1 className="text-xl font-semibold tracking-tight text-(--text)">
							{t("onboarding_title")}
						</h1>
						<p className="text-sm leading-relaxed text-(--text-2)">
							{t("onboarding_sub")}
						</p>
					</div>

					{/*
						空间概念说明卡
						- 浅色描边内框 + 更暗 bg，与外层卡片形成嵌套层次
						- 用于首次用户理解"空间 ≠ 文件夹"的关键差异
						- 折叠式 <details> 在此不合适（用户还不知道要展开什么）
					*/}
					<div className="rounded-lg border border-(--line-soft) bg-(--bg-elev-2)/60 p-4">
						<p className="text-xs leading-relaxed text-(--text-3)">
							{t("onboarding_concept")}
						</p>
					</div>

					{/*
						名称输入 —— 聚焦用 text 色描边（与 UnlockPage 一致）
						左侧用一个 glyph 预览框代替图标：输入内容时实时显示首字符
						作为未来侧边栏 glyph 的预览，帮助用户理解这个字段的视觉落地
					*/}
					<div className="flex flex-col gap-2">
						<label
							htmlFor="onboarding-space-name"
							className="text-xs font-medium text-(--text-2)"
						>
							{t("onboarding_name_label")}
						</label>
						<div
							className={`flex items-center gap-2 rounded-(--radius) border bg-(--bg-elev-2) px-3 py-2.5 transition-colors ${
								focused ? "border-(--text)" : "border-(--line)"
							}`}
						>
							{/*
								Glyph 实时预览方块
								- 空串时显示 "·" 作为占位
								- 取输入首字符大写（与 spaces store 的 deriveGlyph 行为一致）
								- 用 Array.from 防止 emoji / 组合字符被截断
							*/}
							<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-(--line) bg-(--bg-elev) font-mono text-[11px] font-semibold text-(--text)">
								{trimmed ? (Array.from(trimmed)[0] ?? "·").toUpperCase() : "·"}
							</span>
							<input
								id="onboarding-space-name"
								ref={inputRef}
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								onFocus={() => setFocused(true)}
								onBlur={() => setFocused(false)}
								maxLength={32}
								placeholder={t("onboarding_name_placeholder")}
								className="flex-1 border-0 bg-transparent text-sm text-(--text) outline-none placeholder:text-(--text-4)"
							/>
							{/*
								字符计数 —— 仅在输入时显示，避免空闲时的视觉噪声
								用 font-mono + tabular-nums 保证数字不抖动
							*/}
							{trimmed.length > 0 && (
								<span className="shrink-0 font-mono text-[10.5px] tabular-nums text-(--text-4)">
									{trimmed.length}/32
								</span>
							)}
						</div>
					</div>

					{/*
						预设示例 chips —— 点击自动填充到输入框
						- 横向排布，窄窗口下自动换行（flex-wrap）
						- chip 风格对齐 Select 的触发按钮 hover 态
					*/}
					<div className="flex flex-col gap-2">
						<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
							{t("onboarding_presets_label")}
						</span>
						<div className="flex flex-wrap gap-2">
							{PRESET_KEYS.map((key) => (
								<Button
									key={key}
									variant="secondary"
									size="sm"
									type="button"
									onClick={() => onPresetClick(key)}
								>
									{t(key)}
								</Button>
							))}
						</div>
					</div>

					{/*
						提交按钮 —— 与 UnlockPage / SignInPage 一致
						dark 白底黑字 / light 黑底白字，无 accent 彩色
						右侧 ArrowRight 暗示"继续进入主界面"
					*/}
					<Button
						variant="default"
						size="lg"
						type="submit"
						loading={loading}
						disabled={!canSubmit}
						className="w-full"
					>
						{loading ? t("onboarding_creating") : t("onboarding_submit")}
					</Button>

					{/*
						底部脚注：
						  - signed-in 模式显示当前账户邮箱（让用户确认身份无误）
						  - guest 模式显示"本地模式 · 仅此设备"提示
						这行文案不是操作链接，仅为状态提示，用 text-4 低调处理
					*/}
					<div className="border-t border-(--line-soft) pt-4 text-center font-mono text-[10.5px] tracking-wider text-(--text-4) uppercase">
						{accountMode === "signed-in" && user?.email
							? t("onboarding_foot_signed_in", { email: user.email })
							: t("onboarding_foot_guest")}
					</div>
				</form>
			</div>
		</main>
	);
}

export default OnboardingPage;
