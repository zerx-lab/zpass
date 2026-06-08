// 登录页 —— 云端账户邮箱/密码登录 或 新账户注册
// ---------------------------------------------------------------------------
// 模式（mode state）：
//   "signin"   — 默认。邮箱 + 主密码 + Secret Key → signInCloud() → accountStore.signIn()
//   "register" — 邮箱 + 主密码 + 确认密码 → registerCloud() → 展示 Secret Key 存档步骤
//   "save-key" — 注册后展示 secretKey，用户确认存档后才能 Continue
//
// Server URL 配置：
//   挂载时调 useCloudStore.getState().init()。若 status?.configured=false，则在表单上方
//   内联展示 URL 输入框（折叠型：配置完成后自动隐藏）。
//
// 错误映射：
//   抛出 Error（callCloud 已规范化）→ 读 e.message
//     含 "multi-factor" → cloud_err_mfa
//     认证失败（4xx 系）→ cloud_err_credentials（默认）
//     未配置            → cloud_err_not_configured
//     其他             → cloud_err_generic
//
// 视觉沿用 UnlockPage / WelcomePage 的黑白高级感
// ---------------------------------------------------------------------------

import {
	ArrowLeft,
	Check,
	Copy,
	Eye,
	EyeOff,
	Key,
	Lock,
	Mail,
	ShieldAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { MiniTitlebar } from "@/components/MiniTitlebar";
import { registerCloud, signInCloud } from "@/lib/cloud-api";
import { useAccountStore } from "@/stores/account";
import { CLOUD_BASE_URL_LOCKED, useCloudStore } from "@/stores/cloud";

/* ── 本地工具函数 ──────────────────────────────────────────────────────── */

/**
 * 极简邮箱格式校验
 * 只要求三段式，不做 RFC 5322 全规则匹配。后端以真实校验为准。
 */
function isLikelyEmail(s: string): boolean {
	const trimmed = s.trim();
	if (trimmed.length < 3 || trimmed.length > 254) return false;
	const at = trimmed.indexOf("@");
	if (at <= 0 || at === trimmed.length - 1) return false;
	const local = trimmed.slice(0, at);
	const domain = trimmed.slice(at + 1);
	if (/\s/.test(local) || /\s/.test(domain)) return false;
	if (!domain.includes(".")) return false;
	return true;
}

/** 取邮箱 local part 首字母大写作为 displayName */
function deriveDisplayName(email: string): string {
	const local = email.split("@")[0] ?? "";
	if (!local) return email;
	return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * Secret Key 格式预校验 —— 与 Go cloudcrypto.ValidateSecretKey / 云端 reference
 * client 同一规则：去连字符、大写后,必须是 "Z1" + 84 个 A-Z 字符
 * (6 account id + 78 body)。对连字符分组不敏感(显示 Z1-6-26-26-26),只看规范形。
 * 客户端先拦一道,给即时、具体反馈而非等后端泛化错误。
 */
const SECRET_KEY_CANON_RE = /^[A-Z]{84}$/;

function looksLikeSecretKey(s: string): boolean {
	const canon = s.trim().toUpperCase().replace(/-/g, "");
	if (!canon.startsWith("Z1")) return false;
	return SECRET_KEY_CANON_RE.test(canon.slice(2));
}

/** 将后端抛出的 Error 映射到 i18n 错误 key */
function mapError(e: unknown): string {
	const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
	if (msg.includes("not configured") || msg.includes("no server")) return "cloud_err_not_configured";
	if (msg.includes("multi-factor") || msg.includes("mfa")) return "cloud_err_mfa";
	if (msg.includes("secret key must match") || msg.includes("z1-")) return "cloud_err_secretkey_format";
	// 认证失败常见短语
	if (
		msg.includes("invalid") ||
		msg.includes("credentials") ||
		msg.includes("unauthorized") ||
		msg.includes("incorrect") ||
		msg.includes("wrong password") ||
		msg.includes("401")
	) {
		return "cloud_err_credentials";
	}
	return "cloud_err_generic";
}

/* ── 主组件 ──────────────────────────────────────────────────────────── */

type PageMode = "signin" | "register" | "save-key";

export function SignInPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	// 入口页可能在 state.from 里塞来源路径(如从 设置→云端同步 点"登录"进入)。
	// 登录/注册完成后回到来源页,而不是一律跳首页 —— 与 UnlockPage 同一模式。
	const from = (location.state as { from?: string } | null)?.from ?? "/vault";
	const accountStoreSignIn = useAccountStore((s) => s.signIn);
	const cloudStore = useCloudStore();
	const { status } = cloudStore;

	/* ── 模式 ── */
	const [mode, setMode] = useState<PageMode>("signin");

	/* ── 公共字段 ── */
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [reveal, setReveal] = useState(false);

	/* ── 登录专属：Secret Key ── */
	const [secretKey, setSecretKey] = useState("");
	const [skFocused, setSkFocused] = useState(false);

	/* ── 注册专属：确认密码 ── */
	const [confirmPwd, setConfirmPwd] = useState("");
	const [revealConfirm, setRevealConfirm] = useState(false);

	/* ── save-key 步骤 ── */
	const [registerResult, setRegisterResult] = useState<{
		secretKey: string;
		email: string;
		accountId: string;
	} | null>(null);
	const [keySaved, setKeySaved] = useState(false);
	const [keyCopied, setKeyCopied] = useState(false);

	/* ── 通用状态 ── */
	const [loading, setLoading] = useState(false);
	const [errorKey, setErrorKey] = useState<string | null>(null);

	/* ── 聚焦 track（避免 noAutofocus 规则，与 UnlockPage 一致）── */
	const [emailFocused, setEmailFocused] = useState(false);
	const [pwdFocused, setPwdFocused] = useState(false);
	const [confirmFocused, setConfirmFocused] = useState(false);

	/* ── Server URL 配置（内联，折叠型）── */
	const [urlDraft, setUrlDraft] = useState(cloudStore.baseUrl);
	const [urlBusy, setUrlBusy] = useState(false);
	const configured = status?.configured ?? false;

	const emailRef = useRef<HTMLInputElement>(null);

	/* 挂载时初始化云端状态（拉取 status） */
	useEffect(() => {
		void useCloudStore.getState().init();
	}, []);

	/* 挂载时聚焦邮箱 */
	useEffect(() => {
		emailRef.current?.focus();
	}, []);

	/* ── Server URL 保存 ── */
	const handleSaveUrl = async () => {
		if (!urlDraft.trim()) return;
		setUrlBusy(true);
		try {
			await cloudStore.setBaseUrl(urlDraft.trim());
		} finally {
			setUrlBusy(false);
		}
	};

	/* ── 登录提交 ── */
	const handleSignIn = async (e: React.FormEvent) => {
		e.preventDefault();
		if (loading) return;

		if (!isLikelyEmail(email)) { setErrorKey("signin_err_email"); return; }
		if (password.trim().length === 0) { setErrorKey("signin_err_password"); return; }
		if (!secretKey.trim()) { setErrorKey("cloud_err_secretkey_required"); return; }
		if (!looksLikeSecretKey(secretKey)) { setErrorKey("cloud_err_secretkey_format"); return; }

		setErrorKey(null);
		setLoading(true);
		try {
			// Secret Key 在派生前规范为大写（字母表本就是大写；容忍用户小写粘贴）。
			const result = await signInCloud(email.trim(), password, secretKey.trim().toUpperCase());
			accountStoreSignIn({
				id: result.accountId,
				email: result.email,
				displayName: deriveDisplayName(result.email),
			});
			navigate(from, { replace: true });
		} catch (e) {
			setErrorKey(mapError(e));
		} finally {
			setLoading(false);
		}
	};

	/* ── 注册提交 ── */
	const handleRegister = async (e: React.FormEvent) => {
		e.preventDefault();
		if (loading) return;

		if (!isLikelyEmail(email)) { setErrorKey("signin_err_email"); return; }
		if (password.trim().length === 0) { setErrorKey("signin_err_password"); return; }
		if (password !== confirmPwd) { setErrorKey("cloud_err_pwd_mismatch"); return; }

		setErrorKey(null);
		setLoading(true);
		try {
			const result = await registerCloud(email.trim(), password);
			// 注册成功 → 进入"存档 Secret Key"步骤（不立刻跳转）
			setRegisterResult({
				secretKey: result.secretKey,
				email: result.email,
				accountId: result.accountId,
			});
			setMode("save-key");
		} catch (e) {
			setErrorKey(mapError(e));
		} finally {
			setLoading(false);
		}
	};

	/* ── 注册后 Continue（已确认存档 Secret Key）── */
	const handleContinue = () => {
		if (!registerResult) return;
		accountStoreSignIn({
			id: registerResult.accountId,
			email: registerResult.email,
			displayName: deriveDisplayName(registerResult.email),
		});
		navigate("/vault", { replace: true });
	};

	/* ── 复制 Secret Key ── */
	const handleCopyKey = () => {
		if (!registerResult) return;
		navigator.clipboard.writeText(registerResult.secretKey).then(() => {
			setKeyCopied(true);
			setTimeout(() => setKeyCopied(false), 2000);
		});
	};

	const onBack = () => {
		if (mode === "save-key") {
			// 不允许从 save-key 返回（注册已完成，只能 Continue）
			return;
		}
		navigate("/welcome");
	};

	/* ── 渲染 ── */
	return (
		<main className="signin relative flex h-full flex-col items-stretch overflow-hidden bg-(--bg)">
			{/* Mini titlebar —— 与 WelcomePage / UnlockPage 保持一致 */}
			<MiniTitlebar />

			{/* 主内容滚动容器 */}
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
				<div className="flex w-full max-w-md shrink-0 flex-col gap-5 rounded-xl border border-(--line) bg-(--bg-elev) p-8 shadow-lg">
					{/* 顶部：返回链接 + Brand 标识 */}
					<div className="flex items-center justify-between">
						{mode !== "save-key" ? (
							<Button
								variant="link"
								size="sm"
								type="button"
								onClick={onBack}
								leftIcon={<ArrowLeft size={13} strokeWidth={1.5} />}
							>
								{t("signin_back")}
							</Button>
						) : (
							<div />
						)}
						<div className="flex h-8 w-8 items-center justify-center rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) font-mono text-[13px] font-semibold text-(--text)">
							Z
						</div>
					</div>

					{/* ── Server URL 内联配置（未配置时展示）── */}
					{!configured && !CLOUD_BASE_URL_LOCKED && mode !== "save-key" && (
						<div className="flex flex-col gap-2 rounded-lg border border-(--line-soft) bg-(--bg) px-3 py-3">
							<span className="text-[11px] font-medium text-(--text-3)">
								{t("cloud_server_url_label")}
							</span>
							<div className="flex gap-2">
								<input
									type="url"
									value={urlDraft}
									onChange={(e) => setUrlDraft(e.target.value)}
									placeholder="https://sync.example.com"
									className="flex-1 rounded-(--radius) border border-(--line) bg-(--bg-elev) px-2.5 py-1.5 font-mono text-[12px] text-(--text) placeholder:text-(--text-4) focus:border-(--text) focus:outline-none"
								/>
								<Button
									size="sm"
									onClick={handleSaveUrl}
									disabled={urlBusy || !urlDraft.trim()}
									loading={urlBusy}
								>
									{t("cloud_server_save")}
								</Button>
							</div>
						</div>
					)}

					{/* ══════════ 登录模式 ══════════ */}
					{mode === "signin" && (
						<form onSubmit={handleSignIn} className="flex flex-col gap-4">
							{/* 标题 */}
							<div className="flex flex-col gap-1">
								<h1 className="text-xl font-semibold tracking-tight text-(--text)">
									{t("signin_title")}
								</h1>
								<p className="text-sm text-(--text-2)">{t("signin_sub")}</p>
							</div>

							{/* 邮箱 */}
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
									onChange={(e) => { setEmail(e.target.value); if (errorKey) setErrorKey(null); }}
									onFocus={() => setEmailFocused(true)}
									onBlur={() => setEmailFocused(false)}
									placeholder={t("signin_email_placeholder")}
									className="flex-1 border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
								/>
							</label>

							{/* 主密码 */}
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
									onChange={(e) => { setPassword(e.target.value); if (errorKey) setErrorKey(null); }}
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
								>
									{reveal ? <EyeOff size={13} strokeWidth={1.5} /> : <Eye size={13} strokeWidth={1.5} />}
								</Button>
							</label>

							{/* Secret Key */}
							<label
								className={`flex items-center gap-2 rounded-(--radius) border bg-(--bg-elev-2) px-3 py-2.5 transition-colors ${
									skFocused ? "border-(--text)" : "border-(--line)"
								}`}
							>
								<Key size={14} className="text-(--text-3)" />
								<input
									type="text"
									autoComplete="off"
									spellCheck={false}
									value={secretKey}
									onChange={(e) => { setSecretKey(e.target.value); if (errorKey) setErrorKey(null); }}
									onFocus={() => setSkFocused(true)}
									onBlur={() => setSkFocused(false)}
									placeholder={t("cloud_secretkey_placeholder")}
									className="flex-1 border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
								/>
							</label>

							{/* 错误提示区 */}
							<div className="flex min-h-[18px] items-start gap-2 text-xs leading-relaxed text-(--text-2)">
								{errorKey && (
									<>
										<ShieldAlert size={13} strokeWidth={1.5} className="mt-0.5 shrink-0 text-(--text-3)" />
										<span>{t(errorKey)}</span>
									</>
								)}
							</div>

							{/* 提交按钮 */}
							<Button
								variant="default"
								size="lg"
								type="submit"
								disabled={loading || !email.trim() || !password || !secretKey.trim()}
								loading={loading}
								className="w-full"
							>
								{loading ? t("signin_loading") : t("signin_submit")}
							</Button>

							{/* 底部：切换到注册 */}
							<div className="flex items-center justify-center border-t border-(--line-soft) pt-4 text-xs">
								<Button
									variant="link"
									size="sm"
									type="button"
									onClick={() => { setMode("register"); setErrorKey(null); }}
								>
									{t("cloud_register_tab")}
								</Button>
							</div>
						</form>
					)}

					{/* ══════════ 注册模式 ══════════ */}
					{mode === "register" && (
						<form onSubmit={handleRegister} className="flex flex-col gap-4">
							{/* 标题 */}
							<div className="flex flex-col gap-1">
								<h1 className="text-xl font-semibold tracking-tight text-(--text)">
									{t("cloud_register_title")}
								</h1>
								<p className="text-sm text-(--text-2)">{t("cloud_register_sub")}</p>
							</div>

							{/* 邮箱 */}
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
									onChange={(e) => { setEmail(e.target.value); if (errorKey) setErrorKey(null); }}
									onFocus={() => setEmailFocused(true)}
									onBlur={() => setEmailFocused(false)}
									placeholder={t("signin_email_placeholder")}
									className="flex-1 border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
								/>
							</label>

							{/* 主密码 */}
							<label
								className={`flex items-center gap-2 rounded-(--radius) border bg-(--bg-elev-2) px-3 py-2.5 transition-colors ${
									pwdFocused ? "border-(--text)" : "border-(--line)"
								}`}
							>
								<Lock size={14} className="text-(--text-3)" />
								<input
									type={reveal ? "text" : "password"}
									autoComplete="new-password"
									value={password}
									onChange={(e) => { setPassword(e.target.value); if (errorKey) setErrorKey(null); }}
									onFocus={() => setPwdFocused(true)}
									onBlur={() => setPwdFocused(false)}
									placeholder={t("cloud_new_password_placeholder")}
									className="flex-1 border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
								/>
								<Button
									variant="ghost"
									size="icon"
									type="button"
									onClick={() => setReveal((v) => !v)}
									aria-label={reveal ? t("detail_hide") : t("detail_reveal")}
								>
									{reveal ? <EyeOff size={13} strokeWidth={1.5} /> : <Eye size={13} strokeWidth={1.5} />}
								</Button>
							</label>

							{/* 确认密码 */}
							<label
								className={`flex items-center gap-2 rounded-(--radius) border bg-(--bg-elev-2) px-3 py-2.5 transition-colors ${
									confirmFocused ? "border-(--text)" : "border-(--line)"
								}`}
							>
								<Lock size={14} className="text-(--text-3)" />
								<input
									type={revealConfirm ? "text" : "password"}
									autoComplete="new-password"
									value={confirmPwd}
									onChange={(e) => { setConfirmPwd(e.target.value); if (errorKey) setErrorKey(null); }}
									onFocus={() => setConfirmFocused(true)}
									onBlur={() => setConfirmFocused(false)}
									placeholder={t("cloud_confirm_password_placeholder")}
									className="flex-1 border-0 bg-transparent font-mono text-sm text-(--text) outline-none placeholder:text-(--text-4)"
								/>
								<Button
									variant="ghost"
									size="icon"
									type="button"
									onClick={() => setRevealConfirm((v) => !v)}
									aria-label={revealConfirm ? t("detail_hide") : t("detail_reveal")}
								>
									{revealConfirm ? <EyeOff size={13} strokeWidth={1.5} /> : <Eye size={13} strokeWidth={1.5} />}
								</Button>
							</label>

							{/* 错误提示区 */}
							<div className="flex min-h-[18px] items-start gap-2 text-xs leading-relaxed text-(--text-2)">
								{errorKey && (
									<>
										<ShieldAlert size={13} strokeWidth={1.5} className="mt-0.5 shrink-0 text-(--text-3)" />
										<span>{t(errorKey)}</span>
									</>
								)}
							</div>

							{/* 提交按钮 */}
							<Button
								variant="default"
								size="lg"
								type="submit"
								disabled={loading || !email.trim() || !password || !confirmPwd}
								loading={loading}
								className="w-full"
							>
								{loading ? t("cloud_register_loading") : t("cloud_register_submit")}
							</Button>

							{/* 底部：切换到登录 */}
							<div className="flex items-center justify-center border-t border-(--line-soft) pt-4 text-xs">
								<Button
									variant="link"
									size="sm"
									type="button"
									onClick={() => { setMode("signin"); setErrorKey(null); }}
								>
									{t("cloud_signin_tab")}
								</Button>
							</div>
						</form>
					)}

					{/* ══════════ 存档 Secret Key 步骤 ══════════ */}
					{mode === "save-key" && registerResult && (
						<div className="flex flex-col gap-5">
							{/* 标题 */}
							<div className="flex flex-col gap-1">
								<h1 className="text-xl font-semibold tracking-tight text-(--text)">
									{t("cloud_secretkey_title")}
								</h1>
								<p className="text-sm text-(--text-2)">{t("cloud_secretkey_sub")}</p>
							</div>

							{/* Secret Key 展示框 */}
							<div className="flex flex-col gap-2 rounded-lg border border-(--line-soft) bg-(--bg) p-4">
								<span className="text-[11px] font-medium uppercase tracking-wide text-(--text-4)">
									{t("cloud_secretkey_label")}
								</span>
								<code className="break-all font-mono text-[15px] font-semibold leading-relaxed tracking-wider text-(--text)">
									{registerResult.secretKey}
								</code>
								<Button
									variant="ghost"
									size="sm"
									type="button"
									onClick={handleCopyKey}
									leftIcon={
										keyCopied ? (
											<Check size={13} strokeWidth={1.5} />
										) : (
											<Copy size={13} strokeWidth={1.5} />
										)
									}
									className="self-start"
								>
									{keyCopied ? t("detail_copied") : t("detail_copy")}
								</Button>
							</div>

							{/* 警告文案 */}
							<div className="flex items-start gap-2 rounded-lg border border-(--line-soft) bg-(--bg) px-3 py-3 text-[12px] leading-relaxed text-(--text-2)">
								<ShieldAlert size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-(--text-3)" />
								<span>{t("cloud_secretkey_save_warning")}</span>
							</div>

							{/* 确认 checkbox */}
							<label className="flex cursor-pointer items-start gap-3">
								<input
									type="checkbox"
									checked={keySaved}
									onChange={(e) => setKeySaved(e.target.checked)}
									className="mt-0.5 accent-(--text)"
								/>
								<span className="text-[13px] leading-snug text-(--text-2)">
									{t("cloud_secretkey_saved_checkbox")}
								</span>
							</label>

							{/* Continue 按钮 */}
							<Button
								variant="default"
								size="lg"
								type="button"
								disabled={!keySaved}
								onClick={handleContinue}
								className="w-full"
							>
								{t("cloud_continue")}
							</Button>
						</div>
					)}
				</div>
			</div>
		</main>
	);
}

export default SignInPage;
