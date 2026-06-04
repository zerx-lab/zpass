// 安全中心页 —— Health / Security Center
// ---------------------------------------------------------------------------
// 对标 ZPassDesign/src/health.jsx，但数据全部来自真实 vault store，
// 不再展示 "—" 占位。
//
// 核心思路：
//
//   1. 解锁后，本页挂载时调 store.fetchItem 把所有 login 条目的完整
//      payload 拉到内存 itemDetails 缓存里 —— 因为强度评估 / 重复检测
//      必须看到加密的 password 字段。
//
//   2. 基于 itemDetails 计算：
//        - score（综合健康评分 0..100）
//        - weak / reused / old / no2fa 四类问题集合
//        - 强度直方图（0-20 / 20-40 / 40-60 / 60-80 / 80-100 五桶）
//
//   3. 渲染三块：
//        - 顶部 Hero：大数字综合分 + 等级 + 关键统计行
//        - 行动建议：按严重度排序的"待处理"条目，点击可跳到详情
//        - 强度分布直方图：只画 login 条目，给用户"我的密码强度全景"
//
// ---------------------------------------------------------------------------
// 性能 & 安全
//
// 本页**会触发解密所有 login 条目**到内存（itemDetails 缓存）。这是
// 必要代价 —— 离开了密码明文就无法做强度评估。一旦用户离开本页，
// 缓存仍然驻留（store 不主动清），下次进 Health 不需要重复解密。
// Lock 时 store.clear() 会一并抹掉，符合"锁定即清空内存视图"约定。
//
// 实现上避免每帧都跑一遍统计：用 useMemo 把昂贵计算缓存到 itemDetails
// 引用变化时。条目数量在 < 10k 范围内，遍历计算耗时 < 5ms，可接受。

import {
	AlertTriangle,
	BarChart3,
	Loader2,
	ScanSearch,
	ShieldCheck,
	ShieldX,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { estimateStrength } from "@/lib/password";
import {
	type VaultItemPayload,
	type VaultItemSummary,
	useVaultStore,
} from "@/stores/vault";

// ---------------------------------------------------------------------------
// 计算工具：从 itemDetails 派生健康统计
// ---------------------------------------------------------------------------

interface LoginIssue {
	item: VaultItemSummary;
	password: string;
	strength: number;
	severity: "weak" | "breach";
}

interface HealthStats {
	totalLogins: number;
	withPassword: number;
	weak: LoginIssue[];
	score: number;
	histogram: number[]; // 5 个桶：0-20, 20-40, 40-60, 60-80, 80-100
}

/**
 * 把 password 字段值安全转字符串
 *
 * fields 是 Record<string, unknown>，只有真的是 string 才参与统计。
 * 不是 string（缺失 / null / 数组等异常情况）一律视为"无密码"，跳过。
 */
function pwString(payload: VaultItemPayload | undefined): string {
	if (!payload) return "";
	const v = payload.fields.password;
	return typeof v === "string" ? v : "";
}

/**
 * 主统计函数 —— 从 items + itemDetails 算出整套 HealthStats
 *
 * 流程：
 *   1. 筛 login 条目
 *   2. 对每个 login 拿出 password、strength、totp 字段
 *   3. 用 Map 统计 password → 出现次数，> 1 即为"重复"
 *   4. 综合分 = 平均强度 - weak*2 - reused*3 - 缺2FA*1，再 clamp 到 0..100
 *
 * 没有 login 条目时返回零值结构，让渲染层只显示"暂无数据"占位。
 */
function computeStats(
	items: VaultItemSummary[],
	itemDetails: Record<string, VaultItemPayload>,
): HealthStats {
	const logins = items.filter((i) => i.type === "login");
	const totalLogins = logins.length;

	const enriched = logins.map((it) => {
		const payload = itemDetails[it.id];
		const password = pwString(payload);
		const strength = password ? estimateStrength(password) : 0;
		return { item: it, payload, password, strength };
	});

	const withPassword = enriched.filter((e) => e.password.length > 0).length;

	// ---- 弱密码：strength < 60 且有密码 ----
	const weakIssues: LoginIssue[] = enriched
		.filter((e) => e.password.length > 0 && e.strength < 60)
		.map((e) => ({
			item: e.item,
			password: e.password,
			strength: e.strength,
			severity: "weak",
		}));

	// ---- 强度直方图（仅有密码的 login）----
	const histogram = [0, 0, 0, 0, 0];
	for (const e of enriched) {
		if (!e.password) continue;
		const bin = Math.min(4, Math.floor(e.strength / 20));
		histogram[bin]++;
	}

	// ---- 综合分 ----
	// 简化模型：只看密码复杂度（平均强度）。HIBP 泄露在 UI 层叠加扣分，
	// 不在 computeStats 里耦合（HIBP 检测异步、可能未扫描，应视为可选维度）。
	let score = 0;
	if (withPassword > 0) {
		const avgStrength =
			enriched
				.filter((e) => e.password.length > 0)
				.reduce((sum, e) => sum + e.strength, 0) / withPassword;
		score = Math.max(0, Math.min(100, Math.round(avgStrength)));
	}

	return {
		totalLogins,
		withPassword,
		weak: weakIssues,
		score,
		histogram,
	};
}

/**
 * 综合分 → 等级 (A/B/C/D)
 *
 *   A: 85..100  优秀
 *   B: 70..84   良好
 *   C: 50..69   需关注
 *   D: 0..49    存在风险
 */
function gradeForScore(score: number): "A" | "B" | "C" | "D" {
	if (score >= 85) return "A";
	if (score >= 70) return "B";
	if (score >= 50) return "C";
	return "D";
}

function colorForScore(score: number): string {
	if (score >= 85) return "var(--text)";
	if (score >= 70) return "var(--ok)";
	if (score >= 50) return "var(--warn)";
	return "var(--danger)";
}

// ---------------------------------------------------------------------------
// 子组件：四格 Tile（弱 / 重复 / 陈旧 / 缺2FA）
// ---------------------------------------------------------------------------

function StatTile({
	label,
	count,
	severity,
	icon: Icon,
}: {
	label: string;
	count: number;
	severity: "high" | "med" | "low";
	icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}) {
	// severity 决定数字色：
	//   - high + count > 0 → --danger
	//   - med  + count > 0 → --warn
	//   - count === 0      → --text-3（淡化，无问题不需要警示）
	let valueColor = "var(--text-3)";
	if (count > 0) {
		valueColor =
			severity === "high"
				? "var(--danger)"
				: severity === "med"
					? "var(--warn)"
					: "var(--text)";
	}

	return (
		<div className="flex items-center gap-3 rounded-xl border border-(--line) bg-(--bg-elev) p-4">
			<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-(--line-soft) bg-(--bg-elev-2) text-(--text-2)">
				<Icon size={15} strokeWidth={1.5} />
			</div>
			<div className="flex min-w-0 flex-1 flex-col leading-tight">
				<span
					className="font-mono text-[22px] font-semibold tabular-nums"
					style={{ color: valueColor }}
				>
					{count}
				</span>
				<span className="text-[11px] text-(--text-3)">{label}</span>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 子组件：行动建议行
// ---------------------------------------------------------------------------

function IssueRow({
	issue,
	onOpen,
}: {
	issue: LoginIssue;
	onOpen: () => void;
}) {
	const { t } = useTranslation();
	const glyph = (Array.from(issue.item.name)[0] ?? "·").toUpperCase();

	const sevLabelKey =
		issue.severity === "breach" ? "health_sev_breach" : "health_sev_weak";

	// 泄露 + 弱都是高危红色
	const sevColor = "var(--danger)";

	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-(--bg-hover)"
			>
				<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) font-mono text-[11px] font-semibold text-(--text)">
					{glyph}
				</div>

				<div className="min-w-0 flex-1">
					<div className="truncate text-[13px] text-(--text)">
						{issue.item.name}
					</div>
					<div className="truncate font-mono text-[10.5px] text-(--text-3)">
						{issue.password ? `score ${issue.strength}` : "—"}
					</div>
				</div>

				<span
					className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
					style={{
						color: sevColor,
						borderColor: sevColor,
					}}
				>
					{t(sevLabelKey)}
				</span>

				<span className="shrink-0 font-mono text-[10.5px] text-(--text-4)">
					→
				</span>
			</button>
		</li>
	);
}

// ---------------------------------------------------------------------------
// 子组件：强度直方图
// ---------------------------------------------------------------------------

function StrengthHistogram({ bins }: { bins: number[] }) {
	const max = Math.max(...bins, 1);
	const labels = ["0-20", "20-40", "40-60", "60-80", "80-100"];
	const colors = [
		"var(--danger)",
		"var(--danger)",
		"var(--warn)",
		"var(--text-2)",
		"var(--text)",
	];
	// 柱区固定高度 px，用绝对像素计算柱高，避免 flex-1 父容器百分比失效
	const BAR_AREA_H = 96; // px

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-end gap-2" style={{ height: BAR_AREA_H }}>
				{bins.map((b, i) => {
					const barH = Math.max(3, Math.round((b / max) * BAR_AREA_H));
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: 固定5个桶
							key={i}
							className="relative flex flex-1 flex-col items-center justify-end"
							style={{ height: BAR_AREA_H }}
						>
							{/* 数量标签 —— 悬于柱顶 */}
							<span
								className="absolute font-mono text-[10px] tabular-nums text-(--text-2)"
								style={{ bottom: barH + 4 }}
							>
								{b}
							</span>
							{/* 柱体 */}
							<div
								className="w-full rounded-t-[3px]"
								style={{
									height: barH,
									backgroundColor: colors[i],
									transition: "height 300ms ease-out",
									opacity: b === 0 ? 0.25 : 1,
								}}
							/>
						</div>
					);
				})}
			</div>

			{/* X 轴分隔线 */}
			<div className="h-px w-full bg-(--line)" />

			{/* X 轴标签 */}
			<div className="flex items-start gap-2">
				{labels.map((lbl, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: 固定5个桶
						key={i}
						className="flex flex-1 flex-col items-center gap-0.5"
					>
						<span className="font-mono text-[9px] tracking-wide text-(--text-4)">
							{lbl}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------

export function HealthPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const items = useVaultStore((s) => s.items);
	const itemDetails = useVaultStore((s) => s.itemDetails);
	const fetchItem = useVaultStore((s) => s.fetchItem);
	const selectItem = useVaultStore((s) => s.selectItem);
	const setHealthIssueCount = useVaultStore((s) => s.setHealthIssueCount);

	// ---- 泄露检测状态（从 vault store 读取）----
	const breachResults = useVaultStore((s) => s.breachResults) ?? [];
	const breachScanning = useVaultStore((s) => s.breachScanning);
	const breachLastScanAt = useVaultStore((s) => s.breachLastScanAt);
	const runBreachScan = useVaultStore((s) => s.runBreachScan);

	const breachedItems = useMemo(
		() => breachResults.filter((r) => r.pwned && r.count > 0),
		[breachResults],
	);

	/**
	 * 进入 Health 页时，把所有还没缓存详情的 login 条目都拉一下
	 *
	 * 没有缓存就无法做强度 / 重复 / 2FA 评估。这一波解密在条目数 < 数百
	 * 时几秒内完成，UI 在数据陆续到达时增量更新（itemDetails 引用变化
	 * 触发本组件 useMemo 重新计算）。
	 *
	 * 用 Promise.allSettled 而不是 Promise.all：单条解密失败不应中断
	 * 整批，让其它条目继续填充缓存。
	 */
	useEffect(() => {
		// 用 useVaultStore.getState() 读取快照，避免把 itemDetails 加入 deps
		// 导致每拉回一条 detail 就重跑整个 effect
		const { itemDetails: cached } = useVaultStore.getState();
		const need = items.filter((i) => i.type === "login" && !cached[i.id]);
		if (need.length === 0) return;
		void Promise.allSettled(need.map((i) => fetchItem(i.id)));
	}, [items, fetchItem]);

	// itemDetails 增量更新时 useMemo 重算；条目数 < 10k 耗时 < 5ms，可接受
	const stats = useMemo(
		() => computeStats(items, itemDetails),
		[items, itemDetails],
	);

	// 行动建议：把所有问题合并去重，按严重度排序（weak/reused → high；old/no2fa → med）
	// 同一条目可能命中多类（比如既弱又重复），按"严重度优先级 + id"去重，
	// 让用户先处理最值得修的。
	// 把泄露结果转为 LoginIssue 以便合并到行动建议中
	const breachIssues: LoginIssue[] = useMemo(() => {
		return breachedItems.map((r) => {
			const item = items.find((i) => i.id === r.itemId);
			const payload = itemDetails[r.itemId];
			const password =
				typeof payload?.fields.password === "string"
					? payload.fields.password
					: "";
			const strength = password ? estimateStrength(password) : 0;
			return {
				item: item ?? {
					id: r.itemId,
					type: "login" as const,
					name: r.itemName,
					createdAt: 0,
					updatedAt: 0,
					hasTOTP: false,
				},
				password,
				strength,
				severity: "breach" as const,
			};
		});
	}, [breachedItems, items, itemDetails]);

	const actionItems = useMemo(() => {
		const seen = new Set<string>();
		const ranked: LoginIssue[] = [];
		// 优先级：breach > weak（已简化，只评估密码复杂度 + HIBP 泄露两个维度）
		for (const issue of breachIssues) {
			if (seen.has(issue.item.id)) continue;
			seen.add(issue.item.id);
			ranked.push(issue);
		}
		for (const issue of stats.weak) {
			if (seen.has(issue.item.id)) continue;
			seen.add(issue.item.id);
			ranked.push(issue);
		}
		return ranked.slice(0, 12);
	}, [breachIssues, stats.weak]);

	// 同步问题总数到 vault store，供侧边栏 badge 读取
	useEffect(() => {
		setHealthIssueCount(actionItems.length);
	}, [actionItems.length, setHealthIssueCount]);

	// 泄露条目拉低综合分（每个泄露扣 5 分，上限扣 30）
	const adjustedScore = useMemo(() => {
		if (breachedItems.length === 0) return stats.score;
		const penalty = Math.min(30, breachedItems.length * 5);
		return Math.max(0, stats.score - penalty);
	}, [stats.score, breachedItems.length]);

	const grade = gradeForScore(adjustedScore);
	const scoreColor = colorForScore(adjustedScore);
	const gradeLabel = t(`health_score_grade_${grade.toLowerCase()}` as never);

	const onOpenItem = (id: string) => {
		// HealthPage 仅处理 login 类条目（强度检查 / 泄露扫描），跳转时走
		// `/vault?filter=login` 而不用 `/vault/:id`，是为了让 Sidebar.NavRow 能
		// 在跳转后继续高亮“登录”。NavRow 的 exactSearch 要求
		// pathname === '/vault' 且 ?filter 匹配；`/vault/:id` 会让 pathname
		// 变成 `/vault/xxx`，导致侧边栏全不高亮。VaultPage 也不从 URL 同步
		// :itemId，所以 selectItem(id) 才是设定详情聚焦的唯一手段。
		selectItem(id);
		navigate(`/vault?filter=login`);
	};

	const hasLogins = stats.totalLogins > 0;

	return (
		<div className="h-full w-full overflow-y-auto">
			<div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-8 py-8">
				{/* Header */}
				<header className="flex flex-col gap-1.5">
					<div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-(--text-4)">
						<ShieldCheck size={12} strokeWidth={1.5} />
						<span>{t("topbar_security")}</span>
					</div>
					<h1 className="text-[22px] font-semibold tracking-tight text-(--text)">
						{t("health_title")}
					</h1>
					<p className="max-w-2xl text-[13px] leading-relaxed text-(--text-2)">
						{t("health_lede_prefix")}{" "}
						<span className="text-(--text)">{t("health_lede_mid")}</span>
					</p>
				</header>

				{!hasLogins ? (
					/* 空态：完全没有 login 条目 */
					<div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-(--line) bg-(--bg-elev) px-6 py-16 text-center">
						<ShieldCheck
							size={28}
							strokeWidth={1.2}
							className="text-(--text-3)"
						/>
						<p className="text-[13px] text-(--text-2)">
							{t("health_no_logins")}
						</p>
					</div>
				) : (
					<>
						{/* ===================== Hero：综合分 ===================== */}
						<section className="rounded-xl border border-(--line) bg-(--bg-elev) p-6">
							<div className="flex flex-wrap items-center gap-8">
								{/* 大数字分 + 等级 */}
								<div className="flex items-center gap-5">
									<div className="flex flex-col leading-none">
										<span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-(--text-4)">
											{t("health_score_k")}
										</span>
										<div className="mt-1 flex items-baseline gap-1">
											<span
												className="font-mono text-[56px] font-semibold tabular-nums leading-none"
												style={{ color: scoreColor }}
											>
												{adjustedScore}
											</span>
											<span className="font-mono text-[16px] text-(--text-3)">
												/100
											</span>
										</div>
									</div>

									{/* 等级标记 */}
									<div className="flex flex-col items-center gap-1">
										<div
											className="flex h-12 w-12 items-center justify-center rounded-full border-2 font-mono text-[20px] font-bold"
											style={{ borderColor: scoreColor, color: scoreColor }}
										>
											{grade}
										</div>
										<span className="font-mono text-[10px] uppercase tracking-wider text-(--text-3)">
											{gradeLabel}
										</span>
									</div>
								</div>

								<div className="flex-1 min-w-[180px]" />

								{/* 关键统计行 */}
								<div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
									<div className="flex flex-col leading-tight">
										<span className="font-mono text-[10.5px] uppercase tracking-wider text-(--text-4)">
											{t("nav_logins")}
										</span>
										<span className="font-mono text-[20px] tabular-nums text-(--text)">
											{stats.totalLogins}
										</span>
									</div>
									<div className="flex flex-col leading-tight">
										<span className="font-mono text-[10.5px] uppercase tracking-wider text-(--text-4)">
											{t("health_breached_k")}
										</span>
										<span
											className="font-mono text-[20px] tabular-nums"
											style={{
												color:
													breachedItems.length > 0
														? "var(--danger)"
														: "var(--text)",
											}}
										>
											{useVaultStore.getState().breachResults === null
												? "—"
												: breachedItems.length}
										</span>
									</div>
									<div className="flex flex-col leading-tight">
										<span className="font-mono text-[10.5px] uppercase tracking-wider text-(--text-4)">
											{t("health_score_fix")}
										</span>
										<span className="font-mono text-[20px] tabular-nums text-(--text)">
											{actionItems.length}
										</span>
									</div>
								</div>
							</div>

							<p className="mt-4 text-[12px] leading-relaxed text-(--text-3)">
								{t("health_score_desc")}
							</p>
						</section>

						{/* ===================== 二格统计（已泄露 + 弱密码） ===================== */}
						<section className="grid grid-cols-2 gap-3">
							<StatTile
								label={t("health_breached_k")}
								count={breachedItems.length}
								severity="high"
								icon={ShieldX}
							/>
							<StatTile
								label={t("health_tile_weak")}
								count={stats.weak.length}
								severity="high"
								icon={AlertTriangle}
							/>
						</section>

						{/* ===================== 泄露检测 ===================== */}
						<section className="rounded-xl border border-(--line) bg-(--bg-elev)">
							<header className="flex items-center justify-between gap-2 border-b border-(--line-soft) px-5 py-3">
								<div className="flex items-center gap-2">
									<ScanSearch
										size={13}
										strokeWidth={1.5}
										className="text-(--text-3)"
									/>
									<h3 className="text-[13px] font-medium text-(--text)">
										{t("health_breach_monitor")}
									</h3>
									<span className="rounded-full bg-(--bg-elev-2) px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-(--text-4)">
										{t("health_breach_src")}
									</span>
								</div>
								<div className="flex items-center gap-3">
									{breachLastScanAt != null && (
										<span className="font-mono text-[10.5px] text-(--text-4)">
											{t("health_breach_last_scan")}:{" "}
											{new Date(breachLastScanAt).toLocaleTimeString()}
										</span>
									)}
									<Button
										variant="secondary"
										size="sm"
										disabled={breachScanning}
										onClick={() => void runBreachScan(true)}
										leftIcon={
											breachScanning ? (
												<Loader2
													size={12}
													strokeWidth={1.5}
													className="animate-spin"
												/>
											) : (
												<ScanSearch size={12} strokeWidth={1.5} />
											)
										}
									>
										{breachScanning
											? t("health_breach_scanning")
											: useVaultStore.getState().breachResults !== null
												? t("health_breach_rescan")
												: t("health_breach_scan")}
									</Button>
								</div>
							</header>

							<div className="px-5 py-4">
								{useVaultStore.getState().breachResults === null &&
								!breachScanning ? (
									/* 从未扫描过 */
									<div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
										<ScanSearch
											size={24}
											strokeWidth={1.2}
											className="text-(--text-3)"
										/>
										<p className="max-w-sm text-[12px] leading-relaxed text-(--text-3)">
											{t("health_breach_privacy")}
										</p>
									</div>
								) : breachScanning ? (
									/* 扫描中 */
									<div className="flex items-center justify-center gap-3 py-8">
										<Loader2
											size={18}
											strokeWidth={1.5}
											className="animate-spin text-(--text-3)"
										/>
										<span className="font-mono text-[12px] text-(--text-3)">
											{t("health_breach_scanning")}
										</span>
									</div>
								) : breachedItems.length === 0 ? (
									/* 扫描完成，无泄露 */
									<div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
										<ShieldCheck
											size={22}
											strokeWidth={1.2}
											className="text-(--ok)"
										/>
										<span className="text-[12px] text-(--text-2)">
											{t("health_breach_clear")}
										</span>
									</div>
								) : (
									/* 扫描完成，有泄露 */
									<div className="flex flex-col gap-3">
										<div className="flex items-center gap-2">
											<ShieldX
												size={14}
												strokeWidth={1.5}
												className="text-(--danger)"
											/>
											<span className="text-[12px] font-medium text-(--danger)">
												{t("health_breach_found", {
													count: breachedItems.length,
												})}
											</span>
										</div>
										{/*
										 * 列表配色与圆角：
										 *   - ul 用 bg-(--bg-elev) 与外卡片同色，避免出现"卡片→列表→hover"
										 *     三层灰阶糊在一起的视觉
										 *   - px-2 py-1.5 让 row 离卡片边框留呼吸空间（修复贴边问题）
										 *   - row 圆角由内部 button 自身的 rounded-lg 负责，gap-0.5 替代
										 *     divide-y 分隔线（圆角 row 上叠 divide 会出现鼠耳怪状）
										 *   - 行内字形方块改 bg-(--bg-elev-2)，与新的 ul 背景形成对比"凸起"
										 */}
										<ul className="flex flex-col gap-0.5 rounded-lg border border-(--line) bg-(--bg-elev) px-2 py-1.5">
											{breachedItems.map((r) => (
												<li key={r.itemId}>
													<button
														type="button"
														onClick={() => {
															// 同 onOpenItem：走 ?filter=login 以保留侧边栏“登录”高亮
															selectItem(r.itemId);
															navigate(`/vault?filter=login`);
														}}
														className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-(--bg-hover)"
													>
														<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) font-mono text-[11px] font-semibold text-(--text)">
															{(Array.from(r.itemName)[0] ?? "·").toUpperCase()}
														</div>
														<div className="min-w-0 flex-1">
															<div className="truncate text-[13px] text-(--text)">
																{r.itemName}
															</div>
															<div className="truncate font-mono text-[10.5px] text-(--text-3)">
																{t("health_breach_count", {
																	count: r.count,
																})}
															</div>
														</div>
														<span className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--danger) border-(--danger)">
															{t("health_sev_breach")}
														</span>
														<span className="shrink-0 font-mono text-[10.5px] text-(--text-4)">
															→
														</span>
													</button>
												</li>
											))}
										</ul>
									</div>
								)}
								{/* HIBP 隐私提示 & 归属 */}
								<p className="mt-3 text-center font-mono text-[10px] tracking-wider text-(--text-4)">
									{t("health_breach_powered")}
								</p>
							</div>
						</section>

						{/* ===================== 行动 + 分布两栏 ===================== */}
						<section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
							{/* 行动建议 */}
							<div className="flex flex-col rounded-xl border border-(--line) bg-(--bg-elev)">
								<header className="flex items-center justify-between gap-2 border-b border-(--line-soft) px-5 py-3">
									<h3 className="text-[13px] font-medium text-(--text)">
										{t("health_actions")}
									</h3>
									<span className="font-mono text-[10.5px] uppercase tracking-wider text-(--text-3)">
										{actionItems.length}
									</span>
								</header>
								{actionItems.length === 0 ? (
									<div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-[13px] text-(--text-3)">
										<div className="flex flex-col items-center gap-2">
											<ShieldCheck
												size={22}
												strokeWidth={1.2}
												className="text-(--ok)"
											/>
											<span>{t("health_action_empty")}</span>
										</div>
									</div>
								) : (
									// px-2 py-1.5 让每行 IssueRow 离卡片左右/上下边都留出呼吸空间，
									// 行内圆角由 IssueRow 的 button 自身负责（rounded-lg）
									<ul className="flex flex-col gap-0.5 px-2 py-1.5">
										{actionItems.map((issue) => (
											<IssueRow
												key={`${issue.item.id}-${issue.severity}`}
												issue={issue}
												onOpen={() => onOpenItem(issue.item.id)}
											/>
										))}
									</ul>
								)}
							</div>

							{/* 强度分布 */}
							<div className="flex flex-col rounded-xl border border-(--line) bg-(--bg-elev) self-start sticky top-0">
								<header className="flex items-center justify-between gap-2 border-b border-(--line-soft) px-5 py-3">
									<div className="flex items-center gap-2">
										<BarChart3
											size={13}
											strokeWidth={1.5}
											className="text-(--text-3)"
										/>
										<h3 className="text-[13px] font-medium text-(--text)">
											{t("health_dist")}
										</h3>
									</div>
								</header>
								<div className="flex flex-col gap-4 px-5 pb-5 pt-4">
									{stats.withPassword === 0 ? (
										<div className="flex h-32 items-center justify-center text-[12px] text-(--text-3)">
											{t("health_dist_empty")}
										</div>
									) : (
										<StrengthHistogram bins={stats.histogram} />
									)}
								</div>
							</div>
						</section>
					</>
				)}
			</div>
		</div>
	);
}

export default HealthPage;
