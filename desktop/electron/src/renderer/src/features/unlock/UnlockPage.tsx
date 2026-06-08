// 解锁 / 创建主密码页 —— ZPass 桌面客户端
// ---------------------------------------------------------------------------
// 同一个页面承担两种职责，由 vaultApi.status() 在挂载时探测：
//
//   1. **创建模式**（vault 未初始化，首次启动）
//      - 双输入框：主密码 + 确认主密码
//      - 校验通过后调 vaultApi.initialize(password) → 后端生成 salt / DEK /
//        Verifier 并落盘 vault.db，立即进入解锁态
//      - 顶部文案 / 按钮 / 警告语全部切到"创建"语义
//      - 显式警告"零知识 · 忘记无法找回"，因为这是首次设密的关键决策点
//
//   2. **解锁模式**（vault 已初始化但锁定）
//      - 单输入框：主密码
//      - 校验通过后调 vaultApi.unlock(password) → 后端 Argon2id 派生 + 解
//        wrappedDEK + 验 verifier，进入解锁态
//      - 输入错误后端统一返回 "invalid master password"（vaultErrorKind
//        = "invalid-password"），UI 显示"主密码不正确"
//
// 两种模式共享：
//   - 同一份 MiniTitlebar（unlocked 前页面统一克制的窗口装饰）
//   - 同一份卡片骨架（zpass-glass 玻璃浮层 + radius-xl 圆角 14px）
//   - 同一份品牌头（zpass-glyph + zpass-tint-login）+ 主标题 + 副标题三段式
//   - 同一套黑白对比按钮（dark 白底黑字 / light 黑底白字，附 zpass-btn-primary 凸起）
//
// ---------------------------------------------------------------------------
// 副作用：成功后必须做的两件事
//
//   a) 同步 useLockStore.unlock() —— 让前端"is locked"标志位翻成 false，
//      LockGuard / Sidebar 等订阅这个 store 的组件感知到状态变化
//   b) await useVaultStore.load() —— 立即从后端拉一次条目列表，避免跳到
//      /vault 时列表瞬间显示"空"再异步刷新（视觉抖动 + 用户疑心数据丢了）
//
//   两步**严格按顺序**：先 unlock 再 load，最后 navigate。如果先 navigate
//   守卫会因 useLockStore.locked 仍为 true 把用户踢回 /unlock，循环。
//
// ---------------------------------------------------------------------------
// 错误展示
//
//   错误统一塞进 errorMsg state，渲染在卡片底部（密码框下方、按钮上方）。
//   不用 toast 是为了让错误"贴在表单上下文里"——用户重输密码时一眼能看
//   到上次失败原因，不必去找飞过去的提示条。
//
//   视觉上用 --danger 红色描边 + 红字 + 半透明红底，和黑白基调形成强对比，
//   主密码错误是安全敏感的失败信号，必须让用户立刻识别，不能弱化成中性副文案。
//
//   错误分类来自 vaultErrorKind()：
//     - invalid-password → 显示 unlock_err_invalid
//     - weak-password    → 显示 unlock_create_err_weak（仅创建模式可能触发）
//     - already-initialized → 极罕见的状态机错误（用户在创建中后端已被
//                              别处初始化），重新探测 status 切到解锁模式
//     - 其它 → 通用 unlock_err_unknown
//
// ---------------------------------------------------------------------------
// 关于"忘记主密码"：当前版本**不提供**任何找回入口
//
//   零知识架构下，主密码本身从不离开本机，服务端没有任何能反推 DEK 的材料。
//   一旦丢失，密码学上无法重置 —— 任何"找回"都必须依赖用户预先持有的离线
//   恢复凭据（Emergency Kit 助记短语 / 硬件密钥 / 纸质恢复码）。
//
//   恢复凭据流程尚未设计完成，与其在 UI 上挂一个不可用的"忘记主密码"链接
//   误导用户以为"点了能找回"，不如先彻底隐去 —— 把"无法找回"的预期写在
//   创建模式的警告里（unlock_create_warn），避免给用户错误的安全心智模型。
//
//   等 Emergency Kit 流程落地后再在此处恢复入口。
//
// ---------------------------------------------------------------------------
// 与原占位实现的差异（迁移记录）
//
//   旧版本：固定走解锁模式 + 任意非空密码通过（占位 setTimeout 320ms 模拟）
//   新版本：
//     - 挂载时调 vaultApi.status() 决定模式（未初始化 → 创建；已初始化 → 解锁）
//     - status 探测期间显示 loading 占位，避免短暂渲染错误模式
//     - 真实调用 vaultApi.initialize / unlock，错误按 vaultErrorKind 分支展示
//     - 解锁/创建成功后串联 useLockStore.unlock + useVaultStore.load + navigate

import { Eye, EyeOff, Fingerprint, Lock, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { MiniTitlebar } from "@/components/MiniTitlebar";
import { restoreCloudSession } from "@/lib/cloud-api";
import { vaultApi, vaultErrorKind } from "@/lib/vault-api";
import { useLockStore } from "@/stores/lock";
import { useVaultStore } from "@/stores/vault";

/** LockGuard 重定向时注入的路由 state 形状 */
interface UnlockRouteState {
	from?: string;
}

/**
 * 表单模式
 *
 * - "probing"：刚挂载，正在调 vaultApi.status() 探测；UI 显示 loading 占位
 * - "create"：vault 未初始化，渲染"创建主密码"双输入表单
 * - "unlock"：vault 已初始化，渲染"输入主密码解锁"单输入表单
 *
 * 用 string 联合而不是布尔 (isCreate / isUnlock) 是为了显式覆盖"探测中"
 * 的第三态 —— 否则首屏会先渲染解锁模式（默认 false）再异步切到创建模式，
 * 视觉抖动。
 */
type FormMode = "probing" | "create" | "unlock";

/**
 * 解锁 / 创建主密码页
 *
 * 视觉：保留黑白克制基调，按"全局桌面化设计"挂工具类，与 design/vault-home.html
 *      / globals.css 中沉淀的 zpass-* 配方同源。
 *   - 背景：zpass-bg-gradient 软渐变（顶部 brand 蓝舞台灯），避免大面积纯色底"网页味"
 *   - 卡片：zpass-glass 玻璃浮层（半透明 + 重模糊 + inset 顶高光 + 多层落影）
 *   - 品牌方块：zpass-glyph + zpass-tint-login（brand 蓝渐变，呼应 Sidebar 头部）
 *   - 输入框：zpass-search-focus（macOS NSSearchField 风：brand 蓝描边 + 2px 外环）
 *   - 主按钮：variant="default" 自带 zpass-btn-primary 凸起（inset 高光 + 双层落影）
 *   - 状态点：zpass-status-dot（ok 色 + 微光晕）锚定"加密就绪"语义
 *   - 错误提示：例外允许 --danger 红色 —— 主密码错误是安全敏感失败，必须
 *     强信号识别，与 VaultPage / Health 的 --danger 用法一致
 *   严禁紫色相（feedback: brand_color）—— 所有 brand 锚点都走蓝色相
 *
 * 对标设计：ZPassDesign/src/unlock.jsx
 *
 * 实现要点：
 *   - 用 useRef + useEffect 手动聚焦输入框，规避 biome/a11y `noAutofocus` 规则
 *   - 解锁模式底部仅保留"生物识别"入口；"忘记主密码"已隐去（见文件顶部
 *     注释），等 Emergency Kit 流程落地后再恢复
 *   - 平台差异：MiniTitlebar 内部已经按 isMacOS 分支处理（macOS 隐藏自定义
 *     关闭按钮让位给系统红绿灯），本页无需关心
 */
export function UnlockPage() {
	const { t } = useTranslation();
	const unlockLockStore = useLockStore((s) => s.unlock);
	const loadVault = useVaultStore((s) => s.load);
	const navigate = useNavigate();
	const location = useLocation();

	// LockGuard 重定向时把原始路径塞在 state.from；没有则回落到 /vault
	const from = (location.state as UnlockRouteState | null)?.from ?? "/vault";

	// 订阅 locked；若进入 /unlock 时已解锁（例如用户手动访问 URL 或刷新后
	// 状态被保留），直接跳走，避免卡在解锁页。
	const locked = useLockStore((s) => s.locked);

	const [mode, setMode] = useState<FormMode>("probing");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [reveal, setReveal] = useState(false);
	const [loading, setLoading] = useState(false);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const inputRef = useRef<HTMLInputElement>(null);

	// 已解锁时绕过解锁页，直接回到目标路径
	useEffect(() => {
		if (!locked) {
			navigate(from, { replace: true });
		}
	}, [locked, from, navigate]);

	// 挂载时探测 vault 状态：决定走创建模式还是解锁模式
	//
	// 不在 useEffect 闭包外用顶层 await —— React 19 的 use() hook 虽然
	// 支持，但与 useState 配合时机难控；保留经典 useEffect + IIFE 写法，
	// 心智模型简单。
	//
	// vaultApi.status() 失败兜底：默认进入解锁模式 —— 让用户至少能看到
	// 输入框（如果 vault 真的未初始化，输入会失败并触发 already-initialized
	// 之外的错误，但这种状态本身就异常，给用户一个"试一下"的入口比白屏好）。
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const status = await vaultApi.status();
				if (cancelled) return;
				// 已初始化 → 解锁模式；未初始化 → 创建模式
				setMode(status.initialized ? "unlock" : "create");
			} catch {
				if (cancelled) return;
				// 探测失败兜底解锁模式（更保守的选择 —— 不会误把已存在 vault
				// 当成新 vault 让用户重设密码）
				setMode("unlock");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// 模式确定后把焦点落到主密码输入框
	useEffect(() => {
		if (mode !== "probing") {
			inputRef.current?.focus();
		}
	}, [mode]);

	const isCreate = mode === "create";

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!password.trim()) return;
		if (loading) return;

		setErrorMsg(null);

		// 创建模式额外校验：两次输入一致 + 长度满足后端要求（≥ 8）
		// 长度本身后端也会校验并返回 weak-password 错误，前端先做一遍是
		// 为了避免没必要的 IPC 往返 + 让用户更快看到提示
		if (isCreate) {
			if (password.length < 8) {
				setErrorMsg(t("unlock_create_err_weak"));
				return;
			}
			if (password !== confirm) {
				setErrorMsg(t("unlock_create_err_mismatch"));
				return;
			}
		}

		setLoading(true);
		try {
			if (isCreate) {
				// initialize 后端会自动进入解锁态（持有 DEK），无需再调 unlock
				await vaultApi.initialize(password);
			} else {
				await vaultApi.unlock(password);
			}

			// 后端解锁/初始化成功 —— 串联前端状态：
			//   1. 翻 useLockStore.locked = false（让 LockGuard 放行）
			//   2. await load() 把条目从 vault.db 解密拉到内存（避免 /vault
			//      首屏闪空）
			//   3. navigate 跳到目标路径
			// 三步**必须**按这个顺序，详见文件顶部注释。
			unlockLockStore();
			await loadVault();

			// 静默恢复云会话：本地解锁用的主密码恰好就是云账户主密码（D1 决策），
			// 配合已存进钥匙串的 email + Secret Key，无需再走独立登录页即可重建
			// 云会话并恢复自动同步。fire-and-forget —— 无凭据返回 signedIn:false，
			// 密码不匹配则抛错，两种情况都不应阻塞本地解锁（catch 静默)。后端
			// 成功后会 emit cloud:auth:changed，CloudEventSync 据此刷新云状态。
			void restoreCloudSession(password).catch(() => {
				/* 未配置云端 / 未存凭据 / 云密码不一致 —— 静默,保持本地可用 */
			});

			// 跳回原路径（LockGuard 记录的 from），replace=true 避免 /unlock
			// 留在历史栈，防止"后退"又回到解锁页
			navigate(from, { replace: true });
		} catch (err) {
			// 一定要进 catch —— 这里不能"静默"，否则用户看不到任何反馈。
			// 留 console.error 是为了即便错误分类逻辑漏识别某种新错误，
			// 开发者也能在 webview devtools 看到原始信号定位。
			console.error("[UnlockPage] submit failed:", err);

			// 错误分类映射文案 —— 不直接展示后端 message（可能含技术细节
			// 或英文，对用户不友好）
			const kind = vaultErrorKind(err);
			if (kind === "invalid-password") {
				setErrorMsg(t("unlock_err_invalid"));
			} else if (kind === "weak-password") {
				setErrorMsg(t("unlock_create_err_weak"));
			} else if (kind === "already-initialized") {
				// 极罕见：创建过程中 vault 被别处（另一窗口 / 测试程序）初始化。
				// 重新探测 status 切到解锁模式，让用户用真实主密码进入。
				setMode("unlock");
				setPassword("");
				setConfirm("");
				setErrorMsg(t("unlock_err_unknown"));
			} else {
				// 关键兜底：errorKind="unknown" 时**也必须**显示错误信息，
				// 不能让用户面对"无反应"的提交按钮。
				//
				// 优先级：
				//   1. 真正的 Error 实例 → 用其 message（vault-api 的
				//      callWails() 已经把任意 reject 形态规范化成 Error，
				//      这里能稳定拿到可读 message）
				//   2. 否则用通用文案
				//
				// 直接展示 raw message 在大多数场景下不够 polish（比如
				// "Bound method returned an error: invalid master password"
				// 包含技术前缀），但这种情况下 vaultErrorKind 应该已经把它
				// 归类为 invalid-password 走上面分支了。能落到这里的"未知"
				// 错误通常是网络 / IPC 层异常，原始 message 反而是最好的
				// 诊断线索 —— 让用户截图发开发者比"无法解锁，请重试"有用。
				const rawMsg = err instanceof Error && err.message ? err.message : "";
				setErrorMsg(rawMsg || t("unlock_err_unknown"));
			}
		} finally {
			setLoading(false);
		}
	};

	// 探测期间渲染极简占位 —— 避免短暂渲染错误模式后切换造成视觉抖动
	if (mode === "probing") {
		return (
			<main className="unlock zpass-bg-gradient relative flex h-full flex-col items-stretch overflow-hidden bg-(--bg)">
				<MiniTitlebar brand="ZPass" />
				<div className="flex min-h-0 flex-1 items-center justify-center gap-2">
					<span className="zpass-status-dot" aria-hidden />
					<div className="font-mono text-[11px] tracking-wider text-(--text-4) uppercase">
						{/* 占位文字 —— 不引入新 i18n key，复用品牌副文案 */}
						{t("unlock_brand_sub")}
					</div>
				</div>
			</main>
		);
	}

	// 提交按钮的可点击条件 —— 创建模式还需要确认密码非空
	const canSubmit = (() => {
		if (loading) return false;
		if (!password.trim()) return false;
		if (isCreate && !confirm.trim()) return false;
		return true;
	})();

	return (
		/*
		 * 结构约束：
		 *   - 根节点 h-full overflow-hidden 锁死在父链可视尺寸
		 *   - titlebar shrink-0 永远顶部
		 *   - 内容区 flex-1 + overflow-y-auto 独立滚动
		 *   详见 features/unlock 头部 zoom 兼容性注释
		 */
		<main className="unlock zpass-bg-gradient relative flex h-full flex-col items-stretch overflow-hidden bg-(--bg)">
			<MiniTitlebar brand="ZPass" />

			<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-6">
				<form
					onSubmit={onSubmit}
					className="unlock-card zpass-glass flex w-full max-w-md shrink-0 flex-col gap-6 rounded-(--radius-xl) p-8"
				>
					{/*
					 * Brand —— 唯一保留 brand 蓝渐变的"品牌锚点"色块（zpass-brand-mark）。
					 * 不再复用 zpass-tint-login —— 数据头像系列已统一降饱和,品牌标志
					 * 必须独立保持鲜艳,否则解锁页连最显眼的品牌识别都没了。
					 */}
					<div className="flex items-center gap-3">
						<div className="zpass-glyph zpass-brand-mark h-11 w-11 text-[15px]">
							Z
						</div>
						<div className="flex flex-col leading-tight">
							<span className="text-[15px] font-semibold text-(--text)">
								ZPass
							</span>
							<span className="text-xs text-(--text-3)">
								{t("unlock_brand_sub")}
							</span>
						</div>
					</div>

					{/* 标题 + 副标题 —— 按模式切换文案 */}
					<div className="flex flex-col gap-1">
						<h1 className="text-xl font-semibold tracking-tight text-(--text)">
							{isCreate ? t("unlock_create_greeting") : t("unlock_greeting")}
						</h1>
						<p className="text-sm leading-relaxed text-(--text-2)">
							{isCreate ? t("unlock_create_sub") : t("unlock_sub")}
						</p>
					</div>

					{/*
					 * 主密码输入框 —— 聚焦时切到 macOS NSSearchField 风格
					 *   - idle: 中性 --line 描边 + bg-elev-2 底
					 *   - focus-within: zpass-search-focus 提供 brand 蓝描边 +
					 *     inset 内阴影 + 2px brand-soft 外环（不是 3px web focus
					 *     ring，避免网页味）
					 * 聚焦反馈由 CSS :focus-within 驱动，不再需要 React focused state
					 */}
					<label className="zpass-search-focus flex items-center gap-2 rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) px-2.5 py-2 transition-[box-shadow,border-color] duration-150">
						<Lock size={13} className="text-(--text-3)" />
						<input
							ref={inputRef}
							type={reveal ? "text" : "password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							placeholder={
								isCreate
									? t("unlock_create_placeholder")
									: t("unlock_placeholder")
							}
							autoComplete={isCreate ? "new-password" : "current-password"}
							className="flex-1 border-0 bg-transparent font-mono text-[13px] text-(--text) outline-none placeholder:text-(--text-4)"
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
					 * 创建模式独有：确认密码输入框
					 *
					 * 与主密码框样式完全对称（同样的聚焦描边逻辑），但不带
					 * show/hide 按钮 —— 用户在主密码框已经可以揭示明文，
					 * 确认框再加一个会让卡片太密；如果两次输入不一致，前端
					 * 会在错误区显示提示，用户能理解差异。
					 */}
					{isCreate && (
						<label className="zpass-search-focus flex items-center gap-2 rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) px-2.5 py-2 transition-[box-shadow,border-color] duration-150">
							<Lock size={13} className="text-(--text-3)" />
							<input
								type={reveal ? "text" : "password"}
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								placeholder={t("unlock_create_confirm_placeholder")}
								autoComplete="new-password"
								className="flex-1 border-0 bg-transparent font-mono text-[13px] text-(--text) outline-none placeholder:text-(--text-4)"
							/>
						</label>
					)}

					{/*
					 * 错误展示 —— 紧贴输入框下方，让用户重输时上下文清晰
					 *
					 * 主密码错误属于安全敏感的失败提示，用 --danger 红色描边 +
					 * 半透明红底 + 红字图标，让用户一眼识别"密码错了"，避免和
					 * 普通副文案混淆。--danger 是 token 系统中专为破坏性 / 警告
					 * 语义保留的颜色，与 VaultPage / Health 的错误展示一致。
					 */}
					{errorMsg && (
						<div className="flex items-start gap-2 rounded-(--radius) border border-(--danger) bg-(--danger)/8 px-3 py-2 text-xs text-(--danger)">
							<ShieldAlert
								size={13}
								strokeWidth={1.5}
								className="mt-0.5 shrink-0"
							/>
							<span className="leading-relaxed">{errorMsg}</span>
						</div>
					)}

					{/*
					 * 解锁模式：底部仅保留"生物识别"入口（右对齐）
					 * 创建模式：底部警告（零知识 · 不可恢复）
					 *
					 * "忘记主密码" 已隐去 —— 零知识架构下没有可走的找回路径前，
					 * 不要给用户一个点了无反应（或导致误以为可重置）的入口。
					 * 等 Emergency Kit 流程落地后再恢复，见文件顶部注释。
					 */}
					{isCreate ? (
						<div className="flex items-start gap-2 rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2)/60 p-3 text-[11px] leading-relaxed text-(--text-3)">
							<ShieldAlert
								size={13}
								strokeWidth={1.5}
								className="mt-0.5 shrink-0"
							/>
							<span>{t("unlock_create_warn")}</span>
						</div>
					) : (
						<div className="flex items-center justify-end text-xs">
							<Button
								variant="link"
								size="sm"
								type="button"
								leftIcon={<Fingerprint size={14} />}
							>
								{t("unlock_bio")}
							</Button>
						</div>
					)}

					{/*
					 * 主按钮 —— 中性反差：
					 *   - dark 主题：--text 近白 + --bg 近黑 → 白底黑字
					 *   - light 主题：--text 近黑 + --bg 近白 → 黑底白字
					 * 文案按模式切换。
					 */}
					<Button
						variant="default"
						size="lg"
						type="submit"
						disabled={!canSubmit}
						loading={loading}
						className="w-full"
					>
						{loading
							? isCreate
								? t("unlock_create_loading")
								: t("unlock_loading")
							: isCreate
								? t("unlock_create_btn")
								: t("unlock_btn")}
					</Button>

					{/*
					 * 底部 foot —— 加 zpass-status-dot（ok 色 + 微光晕）作为"加密
					 * 就绪"语义锚点。文案保留 t("unlock_foot")（"你的密码永不离开
					 * 此设备"），但视觉上从单行灰字升级为 dot + 文字组合，
					 * 与 design 系统其它"在线 / 已加密"状态指示同源。
					 */}
					<div className="flex items-center justify-center gap-2 border-t border-(--line-soft) pt-4 text-xs text-(--text-3)">
						<span className="zpass-status-dot" aria-hidden />
						<span>{t("unlock_foot")}</span>
					</div>
				</form>
			</div>
		</main>
	);
}

export default UnlockPage;
