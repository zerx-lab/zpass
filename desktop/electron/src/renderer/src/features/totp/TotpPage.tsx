// TOTP 聚合页 —— 一屏看完所有验证码（Authy / Google Authenticator 风格）
// ---------------------------------------------------------------------------
// 设计目标：
//   用户进入此页 → 一眼扫到所有 TOTP 条目的当前 6 位码 + 倒计时，
//   不需要"点选条目 → 才看到码"。这是 2FA 验证器 app 的核心 UX：
//   登录某网站时打开验证器，扫一眼对应行的 6 位数字直接抄进去。
//
// 与 VaultPage 的关系：
//   - VaultPage：完整 CRUD 主舞台，按 ItemType 分类筛选，单条详情面板
//   - TotpPage  ：只读聚合页，跨类型展示「能产生 OTP 的东西」
//
// 聚合的两类来源：
//   1. ItemType === "login" 且 fields["totp"] 非空字符串
//   2. ItemType === "totp"  （独立的身份验证器条目）
//
// 数据策略：
//   - 列表来自 useVaultStore.items（摘要）；TOTP 字段是否存在需要 detail
//   - 进入页面时遍历所有 login 摘要，对没有 detail 缓存的条目并行 fetchItem
//     一次（短脉冲 IPC），让筛选结果稳定。totp 类型条目无需 detail 即可入列
//   - 每行内联一个 TotpField（compact 形态）—— 后端权威 OTP 计算每周期
//     刷新一次，每秒纯本地 setState 推动倒计时环
//   - 点击行任意位置 = 复制当前 OTP 到剪贴板（30s 自动清空）
//   - "在保险库中编辑"按钮跳到 /vault/:id 让用户做完整 CRUD
//
// 视觉：
//   - 顶部：标题 + chip 过滤（全部 / 仅登录 / 仅独立验证器）+ 计数
//   - 主区：单列紧凑列表，每行展示
//       [字形方块] [名称 / 副标题] [大字 6 位码] [倒计时环] [复制按钮]
//   - 列表项 hover 整行高亮，点击发出复制 toast 反馈
//   - 不再有"左列表 + 右详情"两栏布局 —— 单列即所有信息

import { Copy, Pencil, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { writeClipboardEphemeral } from "@/lib/clipboard";
import {
	type BatchTOTPResult,
	type TOTPCode,
	vaultApi,
	vaultErrorKind,
} from "@/lib/vault-api";
import { useUIStore } from "@/stores/ui";
import {
	useVaultStore,
	type VaultItemPayload,
	type VaultItemSummary,
} from "@/stores/vault";

// ---------------------------------------------------------------------------
// 过滤维度 —— 与 Topbar.tsx 的 TOTP_SOURCES 保持同源
// ---------------------------------------------------------------------------
//
// 来源筛选的 UI 控件（chip）已上提到 Topbar，本页面只负责读取并应用筛选。
// 状态以 URL search param `?source=` 表达：缺省视为 "all"。这种"内容层
// 不持有 UI 控件、控件层不持有数据"的解耦让 Topbar / TotpPage 各自简单。

type SourceFilter = "all" | "login" | "totp";

function readSourceFilter(raw: string | null): SourceFilter {
	if (raw === "login" || raw === "totp") return raw;
	return "all";
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 判定一个条目是否「拥有可用的 TOTP 字段」
 *
 * 二态（直接用摘要里的 hasTOTP，不再依赖 detail）：
 *   - "yes" : 是 totp 类型 / login 且后端标记了 hasTOTP
 *   - "no"  : 其余情况
 */
function totpAvailability(item: VaultItemSummary): "yes" | "no" {
	if (item.type === "totp") return "yes";
	if (item.type === "login" && item.hasTOTP) return "yes";
	return "no";
}

/** 取条目副标题：login 用 username/url，独立 totp 用 issuer/account */
function itemSubtitle(
	item: VaultItemSummary,
	detail: VaultItemPayload | undefined,
): string {
	if (!detail) return item.type.toUpperCase();
	const f = detail.fields;
	if (item.type === "totp") {
		const issuer = typeof f.issuer === "string" ? f.issuer : "";
		const account = typeof f.account === "string" ? f.account : "";
		if (issuer && account) return `${issuer} · ${account}`;
		if (issuer) return issuer;
		if (account) return account;
		return "TOTP";
	}
	if (item.type === "login") {
		const username = typeof f.username === "string" ? f.username : "";
		const url = typeof f.url === "string" ? f.url : "";
		if (username) return username;
		if (url) return url;
		return "LOGIN";
	}
	return item.type.toUpperCase();
}

// ---------------------------------------------------------------------------
// TotpPage 主组件
// ---------------------------------------------------------------------------

export function TotpPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();

	const items = useVaultStore((s) => s.items);
	const itemDetails = useVaultStore((s) => s.itemDetails); // 仍保留，用于 itemSubtitle
	const status = useVaultStore((s) => s.status);
	const loadVault = useVaultStore((s) => s.load);
	const otpSnapshots = useVaultStore((s) => s.otpSnapshots);
	const setOtpSnapshots = useVaultStore((s) => s.setOtpSnapshots);
	const setOtpSnapshot = useVaultStore((s) => s.setOtpSnapshot);
	const selectItem = useVaultStore((s) => s.selectItem);
	const requestEditItem = useUIStore((s) => s.requestEditItem);

	// 读取 URL 参数，chip 由 Topbar 通过 setSearchParams 写入
	const sourceFilter: SourceFilter = readSourceFilter(
		searchParams.get("source"),
	);

	// 保证 store 已加载
	useEffect(() => {
		if (status === "idle") void loadVault();
	}, [status, loadVault]);

	// 过滤出所有拥有 TOTP 的条目（直接用摘要 hasTOTP，无需预拉 detail）
	const allTotpItems = useMemo(
		() => items.filter((it) => totpAvailability(it) === "yes"),
		[items],
	);

	// 按来源过滤
	const visibleItems = useMemo(() => {
		if (sourceFilter === "all") return allTotpItems;
		return allTotpItems.filter((it) => it.type === sourceFilter);
	}, [allTotpItems, sourceFilter]);

	// ---------------------------------------------------------------------------
	// 页面级 OTP 状态 —— 单次 batchGenerateTOTP IPC 替代每行各自的 generateTOTP
	// ---------------------------------------------------------------------------
	//
	// 设计：
	//   - otpMap：id → BatchTOTPResult，页面所有行共享一份快照
	//   - 进入页面（visibleItems 稳定后）调一次 batchGenerateTOTP 批量拉码
	//   - 全局 setInterval 每秒推进 remaining；任意条目 remaining 归零时
	//     只对该条目单独补一次 generateTOTP（不重拉全批，避免浪费）
	//   - visibleItems 变化（筛选切换 / 新条目载入）时重新批量拉

	// 用 ref 记录「当前是否已经为这组 ids 发过批量请求」，避免 visibleItems
	// 引用变化但 id 集合不变时重复请求
	const lastFetchedIdsRef = useRef<string>("");

	// visibleItems 稳定后批量拉码
	useEffect(() => {
		if (visibleItems.length === 0) return;
		const key = visibleItems.map((i) => i.id).join(",");
		if (key === lastFetchedIdsRef.current) return;
		lastFetchedIdsRef.current = key;

		void (async () => {
			try {
				const results = await vaultApi.batchGenerateTOTP(
					visibleItems.map((i) => i.id),
				);
				setOtpSnapshots(results);
			} catch {
				// 批量接口本身（锁定等）失败时不处理，行渲染靠 null code 显示占位
			}
		})();
	}, [visibleItems, setOtpSnapshots]);

	// 全局 1s 定时器：推进 remaining，归零时单条刷新
	useEffect(() => {
		if (visibleItems.length === 0) return;
		const id = window.setInterval(() => {
			// 遍历当前快照中属于 visibleItems 的条目
			for (const it of visibleItems) {
				const result = otpSnapshots[it.id];
				if (!result?.code) continue;
				const newRemaining = result.code.remaining - 1;
				if (newRemaining <= 0) {
					// 周期切换：先把 remaining 置回 period，避免连续触发多次重拉
					setOtpSnapshot({
						...result,
						code: { ...result.code, remaining: result.code.period },
					});
					// 单条重新拉（异步补值）
					void vaultApi
						.generateTOTP(it.id)
						.then((code) => {
							setOtpSnapshot({ itemId: it.id, code, err: "" });
						})
						.catch(() => {
							// 单条失败：保留原值，等下一周期自然触发
						});
				} else {
					setOtpSnapshot({
						...result,
						code: { ...result.code, remaining: newRemaining },
					});
				}
			}
		}, 1000);
		return () => window.clearInterval(id);
	}, [visibleItems, otpSnapshots, setOtpSnapshot]);

	// ---- 空态：vault 里没有 TOTP 条目 ----
	if (allTotpItems.length === 0) {
		return (
			<div className="flex h-full w-full items-center justify-center bg-(--bg-elev)">
				<div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
					<div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-(--line) bg-(--bg-elev-2) text-(--text-3)">
						<Smartphone size={20} strokeWidth={1.2} />
					</div>
					<p className="text-[14px] text-(--text-2)">{t("totp_empty")}</p>
					<p className="text-[12px] text-(--text-3)">{t("totp_empty_hint")}</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => navigate("/vault")}
					>
						{t("totp_empty_goto_vault")}
					</Button>
				</div>
			</div>
		);
	}

	// 主区：纯紧凑单列列表 ——
	// Topbar 已经承担了"标题 / 计数 / 来源 chip 过滤"等头部信息，这里
	// 不再重复渲染 page-level header，直接进列表，最大化纵向阅读空间。
	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-(--bg-elev)">
			<div className="min-h-0 flex-1 overflow-y-auto">
				{visibleItems.length === 0 ? (
					<div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-(--text-3)">
						{t("totp_filter_empty")}
					</div>
				) : (
					<ul className="mx-auto flex max-w-3xl flex-col gap-1 px-4 py-4">
						{visibleItems.map((it) => (
							<TotpRow
								key={it.id}
								item={it}
								detail={itemDetails[it.id]}
								otpResult={otpSnapshots[it.id] ?? null}
								onEdit={() => {
									// 直接打开编辑 dialog —— 用户期望是"点编辑按钮就编辑这一条"，
									// 而不是"跳到保险库后自己再点一次编辑"。
									//
									// 实现：
									//   1. selectItem(id) —— VaultPage 选中条目，让详情面板与
									//      dialog 内的 existing 都拿到正确的条目
									//   2. requestEditItem(id) —— 全局信号，VaultPage 订阅后调
									//      openEditDialog(id) 真正打开编辑 modal（含 fetchItem 等待）
									//   3. navigate(`/vault?filter=<type>`) —— 保证 URL / 侧边栏
									//      高亮与"当前编辑的条目类型"一致；Sidebar.NavRow 的
									//      exactSearch 要求 pathname='/vault' + ?filter 匹配
									selectItem(it.id);
									requestEditItem(it.id);
									navigate(`/vault?filter=${it.type}`);
								}}
							/>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 子组件：紧凑列表行 —— 内联展示 OTP + 倒计时 + 复制
// ---------------------------------------------------------------------------

function TotpRow({
	item,
	detail,
	otpResult,
	onEdit,
}: {
	item: VaultItemSummary;
	detail: VaultItemPayload | undefined;
	/** 由父级 TotpPage 统一维护的 OTP 快照；null 表示尚未加载 */
	otpResult: BatchTOTPResult | null;
	onEdit: () => void;
}) {
	const { t } = useTranslation();
	const pushToast = useUIStore((s) => s.pushToast);

	// 从父级传入的快照派生显示数据，不再持有独立 state / interval
	const snapshot: TOTPCode | null = otpResult?.code ?? null;
	const remaining: number = snapshot?.remaining ?? 0;

	// 把 BatchTOTPResult.err 映射为 i18n 文案
	const error: string | null = useMemo(() => {
		if (!otpResult || otpResult.code) return null;
		if (!otpResult.err) return null;
		const kind = vaultErrorKind(new Error(otpResult.err));
		if (kind === "totp-secret-missing") return t("totp_err_secret_missing");
		if (kind === "totp-secret-invalid") return t("totp_err_secret_invalid");
		if (kind === "locked") return t("totp_err_locked");
		if (kind === "not-found") return t("totp_err_not_found");
		return t("totp_err_unknown");
	}, [otpResult, t]);

	const copyCurrentCode = useCallback(async () => {
		if (!snapshot) return;
		const ok = await writeClipboardEphemeral(snapshot.code);
		if (ok) {
			pushToast({ text: t("toast_copied_totp"), icon: "copy" });
		} else {
			pushToast({ text: t("toast_copy_failed"), icon: "x" });
		}
	}, [snapshot, pushToast, t]);

	const glyph = (Array.from(item.name)[0] ?? "·").toUpperCase();
	const subtitle = itemSubtitle(item, detail);

	// 错误占位：保持行高一致，显式提示用户去保险库修
	if (error) {
		return (
			<li>
				<div className="flex items-center gap-3 rounded-lg border border-dashed border-(--line) bg-(--bg-elev) px-3 py-2.5">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius) border border-(--line) bg-(--bg-elev-2) font-mono text-[13px] font-semibold text-(--text-3)">
						{glyph}
					</div>
					<div className="min-w-0 flex-1">
						<div className="truncate text-[13px] text-(--text-2)">
							{item.name}
						</div>
						<div className="truncate text-[11px] text-(--text-3)">{error}</div>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={onEdit}
						leftIcon={<Pencil size={11} strokeWidth={1.5} />}
					>
						{t("totp_edit_in_vault")}
					</Button>
				</div>
			</li>
		);
	}

	const ratio = snapshot
		? Math.max(0, Math.min(1, remaining / snapshot.period))
		: 0;
	const urgent = remaining <= 5;

	const rowDisabled = !snapshot;
	return (
		<li>
			{/* 整行点击 = 复制当前 OTP；hover 整体高亮
			 *
			 * 用 div + role="button" 而不是 <button> —— 内部还嵌了"复制 / 编辑"
			 * 两个真正的 <button>，HTML 不允许 button 嵌套 button（会触发 React
			 * 的 hydration 报错与浏览器自动重排）。div 不带语义但通过 role
			 * + aria-disabled + onKeyDown 补回可访问性；tabIndex=-1 与原本
			 * button 实现一致（这一行不进入 Tab 顺序，键盘用户通过内部两个
			 * 真按钮操作）。
			 */}
			<div
				role="button"
				tabIndex={-1}
				aria-disabled={rowDisabled}
				onClick={() => {
					if (rowDisabled) return;
					void copyCurrentCode();
				}}
				onMouseDown={(e) => e.preventDefault()}
				title={t("totp_row_click_to_copy")}
				className={
					rowDisabled
						? "group flex w-full cursor-default items-center gap-3 rounded-lg border border-(--line) bg-(--bg-elev) px-3 py-2.5 text-left opacity-60 transition-colors focus:outline-none focus-visible:outline-none"
						: "group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-(--line) bg-(--bg-elev) px-3 py-2.5 text-left transition-colors hover:bg-(--bg-hover) focus:outline-none focus-visible:outline-none"
				}
			>
				{/* 字形方块 */}
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius) border border-(--line) bg-(--bg-elev-2) font-mono text-[13px] font-semibold text-(--text)">
					{glyph}
				</div>

				{/* 名称 + 副标题 */}
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] font-medium text-(--text)">
						{item.name}
					</div>
					<div className="truncate font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
						{subtitle}
					</div>
				</div>

				{/* 大字 6 位码 —— 紧贴右端 */}
				<div
					className={
						urgent
							? "shrink-0 font-mono text-[20px] font-semibold tracking-[0.18em] tabular-nums text-(--danger) transition-colors"
							: "shrink-0 font-mono text-[20px] font-semibold tracking-[0.18em] tabular-nums text-(--text) transition-colors group-hover:text-(--accent)"
					}
				>
					{snapshot ? formatGroups(snapshot.code) : "······"}
				</div>

				{/* 倒计时环 */}
				{snapshot && (
					<TotpProgressRing
						ratio={ratio}
						urgent={urgent}
						label={`${remaining}`}
						size={26}
					/>
				)}

				{/* 显式复制按钮（点击时阻断冒泡，避免与整行点击重复弹 toast） */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						void copyCurrentCode();
					}}
					onMouseDown={(e) => e.preventDefault()}
					tabIndex={-1}
					disabled={rowDisabled}
					title={t("detail_copy")}
					className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--text-3) opacity-0 transition-all hover:bg-(--bg-active) hover:text-(--text) focus:outline-none focus-visible:outline-none disabled:cursor-default group-hover:opacity-100"
				>
					<Copy size={12} strokeWidth={1.5} />
				</button>

				{/* 编辑按钮（同样阻断冒泡） */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onEdit();
					}}
					onMouseDown={(e) => e.preventDefault()}
					tabIndex={-1}
					title={t("totp_edit_in_vault")}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius) text-(--text-3) opacity-0 transition-all hover:bg-(--bg-active) hover:text-(--text) focus:outline-none focus-visible:outline-none group-hover:opacity-100"
				>
					<Pencil size={12} strokeWidth={1.5} />
				</button>
			</div>
		</li>
	);
}

// ---------------------------------------------------------------------------
// 工具：6 位数字按 "123 456" 分组
// ---------------------------------------------------------------------------

function formatGroups(code: string): string {
	if (code.length !== 6) return code;
	return `${code.slice(0, 3)} ${code.slice(3)}`;
}

// ---------------------------------------------------------------------------
// 子组件：圆形倒计时进度环（与 TotpField 内同款）
// ---------------------------------------------------------------------------
//
// 复制了一份是为了让 TotpPage 不依赖 TotpField 的内部组件实现。两边参数
// 完全一致，未来若环组件有较大改动可以提到 components/ 共享层。

function TotpProgressRing({
	ratio,
	urgent,
	label,
	size,
}: {
	ratio: number;
	urgent: boolean;
	label: string;
	size: number;
}) {
	const stroke = size >= 28 ? 2.5 : 2;
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const dashOffset = circumference * (1 - ratio);
	const color = urgent ? "var(--danger, #ef4444)" : "var(--accent)";

	return (
		<div
			className="relative inline-flex shrink-0 items-center justify-center"
			style={{ width: size, height: size }}
		>
			<svg width={size} height={size} className="-rotate-90" aria-hidden="true">
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					stroke="var(--line)"
					strokeWidth={stroke}
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeDasharray={circumference}
					strokeDashoffset={dashOffset}
					strokeLinecap="round"
					style={{ transition: "stroke-dashoffset 0.5s linear" }}
				/>
			</svg>
			<span
				className="absolute font-mono tabular-nums leading-none"
				style={{
					fontSize: size >= 28 ? 10 : 8.5,
					color: urgent ? "var(--danger, #ef4444)" : "var(--text-3)",
				}}
			>
				{label}
			</span>
		</div>
	);
}

export default TotpPage;
