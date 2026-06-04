// 登录页 —— 云端账户邮箱/密码登录
// ---------------------------------------------------------------------------
// 产品定位：
//   WelcomePage 点"登录"后进入此页。用户填写邮箱 + 密码，提交后进入
//   OnboardingGuard 的下一分流（/onboarding 或 /vault）。
//
//   当前为占位实现：
//     - 仅校验"邮箱格式合法 + 密码非空"，不走任何真实后端
//     - 提交成功后用表单邮箱派生一个假 user.id（`u_<hash36>`）、把本地
//       part 作为 displayName，填入 accountStore.signIn()
//     - 后续接入真实 API 时，把 fakeSignIn 这段替换为 invoke("auth_signin")
//       之类的 Tauri 命令或 fetch 调用即可，UI 代码零改动
//
//   非开源 / 无自托管：用户填的密码直接提交到 ZPass 官方云，无二次校验。
//
// ---------------------------------------------------------------------------
// 视觉基调：
//   严格沿用 UnlockPage / WelcomePage 的黑白高级感
//     - mini titlebar + 主内容滚动容器（zoom 子树下 titlebar 不被滚走）
//     - 卡片：rounded-xl + border-(--line) + bg-(--bg-elev)
//     - 输入框聚焦用 text 色描边（中性），不出现 accent 彩色
//     - 提交按钮白底黑字（dark）/ 黑底白字（light），与 UnlockPage 一致
//     - 顶部"返回"链接低调（--text-3，hover 到 --text），不做独立按钮态
//
// ---------------------------------------------------------------------------
// 实现要点：
//   - 用 useRef + useEffect 手动聚焦邮箱输入框（规避 biome/a11y
//     noAutofocus 规则，与 UnlockPage 一致）
//   - 表单校验放在组件内本地 state，不引入 react-hook-form / zod 等库
//     —— 两个字段 + 一次校验规模不值得上表单库，保持包体积克制
//   - 错误提示用 <p> 而非 toast：用户此时注意力在表单上，就地提示更直接
//   - submit 时 navigate 交给 OnboardingGuard 处理，不在本页手动 navigate
//     （同 WelcomePage 的"单向依赖守卫"策略，避免双重跳转抖动）

import { ArrowLeft, Eye, EyeOff, Lock, Mail, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { MiniTitlebar } from "@/components/MiniTitlebar";
import { useAccountStore } from "@/stores/account";

/**
 * 极简邮箱格式校验
 *
 * 只要求 `<非空白>@<非空白>.<非空白>` 三段式，不做 RFC 5322 全规则匹配。
 * 理由：
 *   - 真实校验以后端为准，前端层只拦明显错字（少 @、少 .）
 *   - 过严的本地正则反而会把合法邮箱（如含 + 号、UTF-8 域名）误拦
 */
function isLikelyEmail(s: string): boolean {
	const trimmed = s.trim();
	if (trimmed.length < 3 || trimmed.length > 254) return false;
	// 简单三段式：@ 前后都要非空，后段必须含至少一个 .
	const at = trimmed.indexOf("@");
	if (at <= 0 || at === trimmed.length - 1) return false;
	const local = trimmed.slice(0, at);
	const domain = trimmed.slice(at + 1);
	if (/\s/.test(local) || /\s/.test(domain)) return false;
	if (!domain.includes(".")) return false;
	return true;
}

/**
 * 由邮箱派生一个稳定的本地 user.id
 *
 * 当前为占位实现：对邮箱小写化后做 djb2 哈希再 toString(36)，保证同一
 * 邮箱每次登录得到同一 id。真实后端接入后换成服务端返回的真实 id。
 */
function deriveFakeUserId(email: string): string {
	const lower = email.trim().toLowerCase();
	// djb2 哈希 —— 足够短、碰撞不敏感（占位场景）
	let hash = 5381;
	for (let i = 0; i < lower.length; i++) {
		hash = ((hash << 5) + hash + lower.charCodeAt(i)) | 0;
	}
	// | 0 把 hash 转 32bit 有符号，>>> 0 转无符号，再 toString(36) 缩短
	return `u_${(hash >>> 0).toString(36)}`;
}

/**
 * 由邮箱派生一个默认 displayName
 *
 * 取 @ 前的 local part，首字母大写。例如 `alex.rivera@zpass.dev` → `Alex.rivera`。
 * 真实后端返回后会被覆盖。
 */
function deriveDisplayName(email: string): string {
	const local = email.split("@")[0] ?? "";
	if (!local) return email;
	return local.charAt(0).toUpperCase() + local.slice(1);
}

export function SignInPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const signIn = useAccountStore((s) => s.signIn);

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [reveal, setReveal] = useState(false);
	const [emailFocused, setEmailFocused] = useState(false);
	const [pwdFocused, setPwdFocused] = useState(false);
	const [loading, setLoading] = useState(false);
	/**
	 * 表单错误（字符串即 i18n key）
	 *
	 * 为什么保存 i18n key 而不是已翻译的字符串：
	 *   - 用户在错误显示期间切换语言（虽然极少发生），翻译会自动跟进
	 *   - 测试断言可以对 key 做稳定匹配，不受文案改动影响
	 */
	const [errorKey, setErrorKey] = useState<string | null>(null);

	const emailRef = useRef<HTMLInputElement>(null);

	// 首屏挂载后把焦点放到邮箱输入框，方便直接输入
	useEffect(() => {
		emailRef.current?.focus();
	}, []);

	const canSubmit = !loading && email.trim().length > 0 && password.length > 0;

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSubmit) return;

		// 本地预校验：邮箱格式
		if (!isLikelyEmail(email)) {
			setErrorKey("signin_err_email");
			return;
		}
		// 本地预校验：密码非空（避免 trim 后为空的纯空白密码）
		if (password.trim().length === 0) {
			setErrorKey("signin_err_password");
			return;
		}

		setErrorKey(null);
		setLoading(true);

		// TODO: 接入真实后端
		//   - Tauri 命令：invoke("auth_signin", { email, password })
		//   - 或 fetch 到 ZPass 云端 API：POST /v1/auth/signin
		//   - 成功 → 后端返回 { id, email, displayName, avatarUrl, token }
		//   - 失败 → setErrorKey("signin_err_credentials" 等)
		// 当前占位：模拟 400ms 网络延迟，把本地派生的假用户写入 store
		await new Promise((r) => setTimeout(r, 400));

		signIn({
			id: deriveFakeUserId(email),
			email: email.trim(),
			displayName: deriveDisplayName(email),
			// token 字段当前被 store 显式忽略（未来走钥匙串，不落 JSON 配置）
		});

		setLoading(false);

		// 显式 navigate 到 /vault —— 必须跳一个"受 OnboardingGuard 守卫"的
		// 路由，才能触发守卫重新分流。
		//
		// ⚠️ 早期实现是"只 setState、不 navigate，交给守卫统一分流"，但那
		//    是错误的：OnboardingGuard 只在**进入受守卫路由**时运行守卫
		//    逻辑；用户停留在 /signin（守卫外的裸路由）时，store 变化只
		//    触发 React 重渲染，URL 没变，守卫根本不会被挂载/重新求值 ——
		//    用户会看到"点了登录按钮但页面毫无反应"。
		//
		//    正确姿势：把"动作完成"和"路由切换"合并，跳到 /vault 让守卫接手：
		//      - 已完成 onboarding（有空间）→ 守卫放行到 /vault 主界面
		//      - 未完成 onboarding         → 守卫重定向到 /onboarding 引导页
		//    replace=true 避免 /signin 留在历史栈，防止解锁后"后退"倒回登录页。
		navigate("/vault", { replace: true });
	};

	const onBack = () => {
		// 返回欢迎页。不走 navigate(-1) —— 如果用户是直接通过 URL 进入
		// /signin（冷启动带 state），history 栈里没有 /welcome，-1 会退出
		// 应用或进入未定义位置。显式 navigate 更可控。
		navigate("/welcome");
	};

	return (
		<main className="signin relative flex h-full flex-col items-stretch overflow-hidden bg-(--bg)">
			{/* Mini titlebar —— 与 WelcomePage / UnlockPage 保持一致 */}
			<MiniTitlebar />

			{/* 主内容滚动容器 */}
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
				<form
					onSubmit={onSubmit}
					className="signin-card flex w-full max-w-md shrink-0 flex-col gap-5 rounded-xl border border-(--line) bg-(--bg-elev) p-8 shadow-lg"
				>
					{/* 顶部：返回链接 + Brand 标识 */}
					<div className="flex items-center justify-between">
						<Button
							variant="link"
							size="sm"
							type="button"
							onClick={onBack}
							leftIcon={<ArrowLeft size={13} strokeWidth={1.5} />}
						>
							{t("signin_back")}
						</Button>
						<div className="flex h-8 w-8 items-center justify-center rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) font-mono text-[13px] font-semibold text-(--text)">
							Z
						</div>
					</div>

					{/* 标题 + 副文案 */}
					<div className="flex flex-col gap-1">
						<h1 className="text-xl font-semibold tracking-tight text-(--text)">
							{t("signin_title")}
						</h1>
						<p className="text-sm text-(--text-2)">{t("signin_sub")}</p>
					</div>

					{/* 邮箱输入框 */}
					<label
						className={`flex items-center gap-2 rounded-(--radius) border bg-(--bg-elev-2) px-3 py-2.5 transition-colors ${
							emailFocused ? "border-(--text)" : "border-(--line)"
						}`}
					>
						<Mail size={14} className="text-(--text-3)" />
						<input
							ref={emailRef}
							type="email"
							autoComplete="email"
							spellCheck={false}
							value={email}
							onChange={(e) => {
								setEmail(e.target.value);
								// 用户修改输入时自动清除上一次错误提示，避免"改完还挂着红字"
								if (errorKey) setErrorKey(null);
							}}
							onFocus={() => setEmailFocused(true)}
							onBlur={() => setEmailFocused(false)}
							placeholder={t("signin_email_placeholder")}
							className="flex-1 border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
						/>
					</label>

					{/* 密码输入框 —— 右侧 show/hide 切换 */}
					<label
						className={`flex items-center gap-2 rounded-(--radius) border bg-(--bg-elev-2) px-3 py-2.5 transition-colors ${
							pwdFocused ? "border-(--text)" : "border-(--line)"
						}`}
					>
						<Lock size={14} className="text-(--text-3)" />
						<input
							type={reveal ? "text" : "password"}
							autoComplete="current-password"
							value={password}
							onChange={(e) => {
								setPassword(e.target.value);
								if (errorKey) setErrorKey(null);
							}}
							onFocus={() => setPwdFocused(true)}
							onBlur={() => setPwdFocused(false)}
							placeholder={t("signin_password_placeholder")}
							className="flex-1 border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
						/>
						<Button
							variant="ghost"
							size="icon"
							type="button"
							onClick={() => setReveal((v) => !v)}
							aria-label={reveal ? t("detail_hide") : t("detail_reveal")}
							title={reveal ? t("detail_hide") : t("detail_reveal")}
						>
							{reveal ? (
								<EyeOff size={13} strokeWidth={1.5} />
							) : (
								<Eye size={13} strokeWidth={1.5} />
							)}
						</Button>
					</label>

					{/*
						错误提示区 —— 与 UnlockPage / NewItemDialog 视觉一致
						- 固定高度避免"出现/消失时布局抖动"
						- 用 ShieldAlert 图标 + --text-2 文案，整体克制黑白
						  （不用 --danger 红字，与全局严格黑白基调一致）
					*/}
					<div className="flex min-h-[18px] items-start gap-2 text-xs leading-relaxed text-(--text-2)">
						{errorKey && (
							<>
								<ShieldAlert
									size={13}
									strokeWidth={1.5}
									className="mt-0.5 shrink-0 text-(--text-3)"
								/>
								<span>{t(errorKey)}</span>
							</>
						)}
					</div>

					{/*
						提交按钮 —— 与 UnlockPage 解锁按钮视觉一致
						dark 白底黑字 / light 黑底白字，无 accent 彩色
					*/}
					<Button
						variant="default"
						size="lg"
						type="submit"
						disabled={!canSubmit}
						loading={loading}
						className="w-full"
					>
						{loading ? t("signin_loading") : t("signin_submit")}
					</Button>

					{/* 底部辅助链接：忘记密码 / 创建账户（占位，暂不跳转） */}
					<div className="flex items-center justify-between border-t border-(--line-soft) pt-4 text-xs">
						<Button
							variant="link"
							size="sm"
							type="button"
							onClick={() => {
								// TODO: 接入找回密码流程（邮箱发送重置链接）
							}}
						>
							{t("signin_forgot")}
						</Button>
						<Button
							variant="link"
							size="sm"
							type="button"
							onClick={() => {
								// TODO: 接入注册流程（跳到 /signup 或外部浏览器打开注册页）
							}}
						>
							{t("signin_create")}
						</Button>
					</div>
				</form>
			</div>
		</main>
	);
}

export default SignInPage;
