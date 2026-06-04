// 密码生成器页 —— 完整实现
// ---------------------------------------------------------------------------
// 对标 ZPassDesign/src/generator.jsx，三种模式 + 强度分析 + 历史 + 复制：
//
//   ┌──────────────────────────────────────────────────────┬─────────────────┐
//   │ Header                                               │                 │
//   │   ZPass · Generator           [Local · Crypto RNG]   │  Recent (右栏)  │
//   │   sub                                                │   - pwHist[0]   │
//   ├──────────────────────────────────────────────────────┤   - pwHist[1]   │
//   │ Display 区（彩色密码 + 一行 meta）                    │   ...           │
//   ├──────────────────────────────────────────────────────┤                 │
//   │ [Regenerate]  [Copy]              [Save to vault]    │  Tips           │
//   ├──────────────────────────────────────────────────────┤   // tip 1      │
//   │ Mode segment: Password / Passphrase / PIN            │   // tip 2      │
//   ├──────────────────────────────────────────────────────┤   // tip 3      │
//   │ Options（按 mode 切换）                               │                 │
//   │   - 长度滑块 / 字符集开关 / 避免歧义 / 不重复 etc     │                 │
//   ├──────────────────────────────────────────────────────┤                 │
//   │ Strength bar（lg）—— 实时反映当前 pw 的强度          │                 │
//   └──────────────────────────────────────────────────────┴─────────────────┘
//
// ---------------------------------------------------------------------------
// 设计要点
//
// 1. 真实 RNG —— 全部走 lib/password.ts 的 secureRandomInt（基于 crypto.getRandomValues
//    + 拒绝采样）。任何场景下都不用 Math.random。
//
// 2. 密码自动重生
//    任何选项变化都会触发 regen()。用户切换模式 / 调长度 / 切字符集时立刻看到
//    新结果，无需手动点"重新生成"。这是 1Password / Bitwarden generator 的
//    既定 UX 约定。
//
// 3. 字符着色显示
//    密码 display 区每个字符按类别（lower/upper/number/symbol）染色，提升
//    扫读速度。色板：
//      - lower：--text-2 中性
//      - upper：--text   高对比
//      - number：--info  冷蓝
//      - symbol：--warn  暖橙
//    严格沿用 token，不引入额外色板。
//
// 4. 历史栈
//    最近 8 次生成结果保留在组件 state 中（重启即丢失，符合"不持久化敏感
//    数据"的安全原则）。每条带"复制"按钮，方便回退。
//
// 5. 集成 Toast + 安全剪贴板
//    复制走 writeClipboardEphemeral（30s 自动清空）+ pushToast 反馈。
//
// 6. "保存到保险库"
//    点击后用 useVaultStore.create({ type: "login", name: "Generated · Mar 12 10:42",
//    fields: { password } }) 直接落库。条目名带时间戳，避免一堆同名条目。
//    用户进 vault 后可以重命名 / 补 username / url。
//
// ---------------------------------------------------------------------------
// 与 NewItemDialog 的复用
//
// 本页的"options + display"逻辑也会被 NewItemDialog 的"内联生成器"子组件
// 复用 —— 但为了避免组件嵌套过深，本次先在 GeneratorPage 内实现完整版，
// NewItemDialog 通过一个简化的 "GeneratePopover" 调一次 generatePassword
// 即可，不重复整套 UI。

import {
	Check,
	ChevronDown,
	Copy,
	KeyRound,
	RefreshCw,
	Save,
	Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PasswordStrength } from "@/components/PasswordStrength";
import { writeClipboardEphemeral } from "@/lib/clipboard";
import {
	categorize,
	DEFAULT_PASSPHRASE_OPTIONS,
	DEFAULT_PASSWORD_OPTIONS,
	generatePassphrase,
	generatePassword,
	generatePin,
	generateUniqueBatch,
	type PassphraseOptions,
	type PasswordOptions,
} from "@/lib/password";
import { useUIStore } from "@/stores/ui";
import { useVaultStore } from "@/stores/vault";

// ---------------------------------------------------------------------------
// 类型 & 常量
// ---------------------------------------------------------------------------

type GenMode = "password" | "passphrase" | "pin";

interface HistoryEntry {
	value: string;
	mode: GenMode;
	at: number;
}

const HISTORY_LIMIT = 8;

// 批量数量的拖拽软上限 —— 滑块拖拽落在 1..50；更大数量通过输入框直接键入，
// 不设硬上限（generateUniqueBatch 用连续未命中探测兜底候选空间耗尽）。
const BATCH_MAX = 50;

// ---------------------------------------------------------------------------
// 字符着色显示组件
// ---------------------------------------------------------------------------

/**
 * 把密码字符串按 char 类别染色逐字符渲染
 *
 * 不用 dangerouslySetInnerHTML，每个 span 单独渲染：保证字符级 selection
 * 不会被 HTML 注入风险污染（虽然密码本来就是受信内容，但养成习惯）。
 *
 * 字号用 inline style 而不是 Tailwind 工具类，是因为父容器宽度变化时我们
 * 希望字号有响应式压缩空间（letterSpacing 也微调），写 style 更灵活。
 */
function ColorizedPassword({ value }: { value: string }) {
	if (!value) {
		return <span className="font-mono text-(--text-4) text-base">—</span>;
	}

	return (
		<span className="font-mono break-all leading-relaxed">
			{Array.from(value).map((ch, i) => {
				const cat = categorize(ch);
				let color = "var(--text-2)";
				if (cat === "upper") color = "var(--text)";
				else if (cat === "number") color = "var(--info)";
				else if (cat === "symbol") color = "var(--warn)";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: 字符顺序即唯一标识
					<span key={i} style={{ color }}>
						{ch}
					</span>
				);
			})}
		</span>
	);
}

// ---------------------------------------------------------------------------
// 选项原子：滑块 / 开关
// ---------------------------------------------------------------------------

/**
 * 带数值显示的滑块
 *
 * 不用原生 <input type="range"> 的全部默认样式 —— 那个在跨浏览器下视觉
 * 不可控（webkit / moz 各自一套），改成"轨道 + 滑块都自己画"。
 *
 * 实现细节：
 *   - <input type="range"> 透明覆盖在自定义可视层之上，保留键盘可达性
 *     与 a11y（ArrowLeft/Right 步进、Home/End 跳到端点）
 *   - 自定义层用 absolute 绝对定位，根据 value 计算 thumb 位置
 *   - thumb 用 box-shadow 制造"凸出感"，避免硬阴影
 */
function Slider({
	label,
	value,
	min,
	max,
	step = 1,
	onChange,
	editable = false,
	inputMax,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	onChange: (next: number) => void;
	/** 数值改为可直接输入的 number input（拖拽仍在 min..max 软范围内） */
	editable?: boolean;
	/** 输入框的夹取上限；缺省 = 无上限（仅约束 >= min）。仅在 editable 时生效 */
	inputMax?: number;
}) {
	// 拖拽落在 min..max；输入可超出，pct 超界时夹到 100% 不溢出
	const pct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

	// 直接输入用本地草稿态，允许中途清空 / 多位输入而不被受控值打断
	const [draft, setDraft] = useState<string | null>(null);
	const clampInput = (n: number) =>
		Math.max(min, inputMax != null ? Math.min(inputMax, n) : n);
	const commitDraft = () => {
		if (draft == null) return;
		const n = Number.parseInt(draft, 10);
		if (!Number.isNaN(n)) onChange(clampInput(n));
		setDraft(null);
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between">
				<span className="text-[12px] text-(--text-2)">{label}</span>
				{editable ? (
					<input
						type="number"
						min={min}
						value={draft ?? value}
						onChange={(e) => {
							setDraft(e.target.value);
							const n = Number.parseInt(e.target.value, 10);
							if (!Number.isNaN(n)) onChange(clampInput(n));
						}}
						onBlur={commitDraft}
						className="w-20 rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) px-2 py-0.5 text-right font-mono text-[14px] tabular-nums text-(--text) outline-none focus:border-(--text-3)"
						aria-label={label}
					/>
				) : (
					<span className="font-mono text-[14px] tabular-nums text-(--text)">
						{value}
					</span>
				)}
			</div>

			<div className="relative h-6">
				{/* 轨道（背景） */}
				<div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-(--bg-elev-2)" />

				{/* 已填充段 */}
				<div
					className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-(--text)"
					style={{ width: `${pct}%`, transition: "width 120ms ease-out" }}
				/>

				{/* Thumb */}
				<div
					className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-(--text) bg-(--bg)"
					style={{
						left: `${pct}%`,
						boxShadow: "0 0 0 3px var(--bg-elev-2), 0 1px 4px rgba(0,0,0,0.3)",
						transition: "left 120ms ease-out",
					}}
				/>

				{/* 透明 input 覆盖层（保留 a11y / 键盘）；value 夹到 max 避免越界告警 */}
				<input
					type="range"
					min={min}
					max={max}
					step={step}
					value={Math.min(value, max)}
					onChange={(e) => {
						setDraft(null);
						onChange(Number(e.target.value));
					}}
					className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
					aria-label={label}
				/>
			</div>
		</div>
	);
}

/**
 * 开关 toggle —— 黑白克制版
 *
 * 单击切换，整行可点（不仅限于 switch 本身），扩大命中区。
 * 视觉：
 *   - off：bg-(--bg-elev-2) + border-(--line)
 *   - on：bg-(--text) + 圆点 bg-(--bg)，整体反色
 * 不用 accent 色，与全局严格黑白基调一致。
 */
function Toggle({
	label,
	sub,
	on,
	onChange,
}: {
	label: string;
	sub?: string;
	on: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onChange(!on)}
			className="
				group flex w-full items-center justify-between gap-3
				rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2)
				px-3 py-2.5 text-left transition-colors
				hover:bg-(--bg-hover)
			"
			role="switch"
			aria-checked={on}
		>
			<div className="flex min-w-0 flex-col leading-tight">
				<span className="text-[13px] text-(--text)">{label}</span>
				{sub && (
					<span className="font-mono text-[10.5px] text-(--text-3)">{sub}</span>
				)}
			</div>

			{/* Switch 圆角胶囊 */}
			<span
				className={
					on
						? "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-(--text) transition-colors"
						: "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-(--bg-hover) transition-colors"
				}
			>
				<span
					className={
						on
							? "absolute left-3.5 h-3 w-3 rounded-full bg-(--bg) transition-[left,background-color] duration-150"
							: "absolute left-0.5 h-3 w-3 rounded-full bg-(--text-3) transition-[left,background-color] duration-150"
					}
				/>
			</span>
		</button>
	);
}

// ---------------------------------------------------------------------------
// 模式分段控件
// ---------------------------------------------------------------------------

function ModeSegment({
	value,
	onChange,
}: {
	value: GenMode;
	onChange: (next: GenMode) => void;
}) {
	const { t } = useTranslation();

	const modes: Array<{ key: GenMode; label: string }> = [
		{ key: "password", label: t("gen_mode_password") },
		{ key: "passphrase", label: t("gen_mode_passphrase") },
		{ key: "pin", label: t("gen_mode_pin") },
	];

	// 用一组带 aria-pressed 的 toggle button 表达"分段控件"语义。
	// 不用 role="radiogroup" + role="radio"：lint 严格规则期望真实的
	// <input type="radio">，而 button 上的 role 重写在 a11y 树里效果
	// 等价但被工具链视为反模式。aria-pressed 是 button 的官方支持属性，
	// 屏幕阅读器会朗读"按下/未按下"，对"分段切换"语义已足够准确。
	return (
		<div
			className="
				inline-flex items-center gap-1
				rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) p-1
			"
		>
			{modes.map((m) => {
				const active = value === m.key;
				return (
					<button
						key={m.key}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(m.key)}
						className={
							active
								? "rounded-sm bg-(--text) px-3 py-1 text-[12px] font-medium text-(--bg) transition-colors"
								: "rounded-sm px-3 py-1 text-[12px] text-(--text-2) transition-colors hover:bg-(--bg-hover) hover:text-(--text)"
						}
					>
						{m.label}
					</button>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------

export function GeneratorPage() {
	const { t } = useTranslation();
	const pushToast = useUIStore((s) => s.pushToast);
	const createItem = useVaultStore((s) => s.create);

	// 模式与各模式选项
	const [mode, setMode] = useState<GenMode>("password");
	const [pwOpts, setPwOpts] = useState<PasswordOptions>(
		DEFAULT_PASSWORD_OPTIONS,
	);
	const [phOpts, setPhOpts] = useState<PassphraseOptions>(
		DEFAULT_PASSPHRASE_OPTIONS,
	);
	const [pinLen, setPinLen] = useState(6);

	// 批量生成数量（1 = 单条，沿用原单密码路径；> 1 = 批量多行）
	const [count, setCount] = useState(1);

	// 当前生成结果（count > 1 时为 batch[0]，仅供 meta / 复用，不直接展示）
	const [pw, setPw] = useState("");

	// 批量结果列表（count === 1 时即 [pw]）
	const [batch, setBatch] = useState<string[]>([]);

	// 历史栈（最近 8 条）
	const [history, setHistory] = useState<HistoryEntry[]>([]);

	// 复制反馈：高亮 "Copy" 按钮 1.6s
	const [justCopied, setJustCopied] = useState(false);

	/**
	 * 重生密码
	 *
	 * 抽出独立函数而不是把生成逻辑写在 useEffect 内联：
	 *   - 让"用户主动点 Regenerate"也能复用
	 *   - 测试时可以 mock state 后直接 call regen()
	 */
	const regen = () => {
		// 按当前模式 + 选项构造单条生成器；批量与单条共用，保证两条路径的
		// 复杂度 / 长度约束完全一致。
		const genOne = (): string => {
			try {
				if (mode === "password") return generatePassword(pwOpts);
				if (mode === "passphrase") return generatePassphrase(phOpts);
				return generatePin(pinLen);
			} catch {
				// generatePassword 在 avoidRepeats 不可满足时会抛错；fallback 关掉重试
				return generatePassword({ ...pwOpts, avoidRepeats: false });
			}
		};

		// count === 1：完全沿用原单密码路径（含历史栈），零行为改动
		if (count <= 1) {
			const next = genOne();
			setPw(next);
			setBatch([next]);
			setHistory((h) =>
				[{ value: next, mode, at: Date.now() }, ...h].slice(0, HISTORY_LIMIT),
			);
			return;
		}

		// count > 1：批量去重，不写历史（避免 8 格历史被一次批量刷爆）
		const list = generateUniqueBatch(count, genOne);
		setBatch(list);
		setPw(list[0] ?? "");
	};

	/**
	 * 选项 / 模式变化时自动重生
	 *
	 * 依赖列表用 JSON.stringify 简化对比 —— 选项对象内部字段较多，挨个列
	 * 进 deps 容易漏；选项体积小（< 100 字节），stringify 成本可忽略。
	 *
	 * regen 不放 deps —— 它每次渲染都是新引用（闭包捕获 setState），放进去
	 * 会无限循环。严格 react/exhaustive-deps 会报警，但这个场景下手动控制
	 * 依赖才是正确选择。
	 */
	// biome-ignore lint/correctness/useExhaustiveDependencies: regen 内部读取的状态都已显式列出
	useEffect(() => {
		regen();
	}, [mode, JSON.stringify(pwOpts), JSON.stringify(phOpts), pinLen, count]);

	/**
	 * 复制当前密码
	 *
	 * 走 writeClipboardEphemeral：30 秒后自动清空剪贴板。复制成功后：
	 *   1. 切 justCopied=true 让按钮文案瞬时变成 "Copied"
	 *   2. push 一条 toast 给用户更明确反馈
	 *   3. 1.6s 后复位 justCopied
	 */
	const onCopy = async () => {
		// 批量时复制全部（换行分隔）；单条时复制当前密码
		const text = count > 1 ? batch.join("\n") : pw;
		if (!text) return;
		const ok = await writeClipboardEphemeral(text);
		if (ok) {
			setJustCopied(true);
			pushToast({ text: t("toast_copied_password"), icon: "copy" });
			window.setTimeout(() => setJustCopied(false), 1600);
		} else {
			pushToast({ text: t("toast_copy_failed"), icon: "x" });
		}
	};

	/**
	 * 保存当前生成结果到 vault
	 *
	 * 默认走 type=login，name 用"Generated · 月日 时:分"。用户后续可在
	 * vault 详情里改名 / 补 username / url。
	 *
	 * 失败时通过 toast 反馈，不阻塞用户继续生成。
	 */
	const onSaveToVault = async () => {
		if (!pw) return;
		const now = new Date();
		const stamp = `${now.getMonth() + 1}/${now.getDate()} ${String(
			now.getHours(),
		).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
		try {
			await createItem({
				type: "login",
				name: `Generated · ${stamp}`,
				fields: { password: pw, username: "", url: "", notes: "" },
			});
			pushToast({ text: t("gen_saved"), icon: "check" });
		} catch (err) {
			pushToast({
				text: err instanceof Error ? err.message : String(err),
				icon: "x",
			});
		}
	};

	/**
	 * 复制历史项
	 *
	 * 与主复制按钮共享 writeClipboardEphemeral —— 同样 30s 自动清空。
	 */
	const onCopyHistory = async (entry: HistoryEntry) => {
		const ok = await writeClipboardEphemeral(entry.value);
		if (ok) {
			pushToast({ text: t("toast_copied_password"), icon: "copy" });
		} else {
			pushToast({ text: t("toast_copy_failed"), icon: "x" });
		}
	};

	// meta 行：当前模式的关键参数 + 字符数概要；批量时前缀 "N × ..."
	const metaText = useMemo(() => {
		let base: string;
		if (mode === "password") {
			const parts = [`${pw.length} ${t("gen_chars")}`];
			const sets: string[] = [];
			if (pwOpts.lower) sets.push("a-z");
			if (pwOpts.upper) sets.push("A-Z");
			if (pwOpts.numbers) sets.push("0-9");
			if (pwOpts.symbols) sets.push("!#$");
			parts.push(sets.join(" · "));
			base = parts.join(" · ");
		} else if (mode === "passphrase") {
			base = `${phOpts.words} ${t("gen_words").toLowerCase()} · "${phOpts.separator ?? "-"}"`;
		} else {
			base = `${pinLen} ${t("gen_chars")} · 0-9`;
		}
		return count > 1 ? `${batch.length} × ${base}` : base;
	}, [mode, pw, pwOpts, phOpts, pinLen, count, batch.length, t]);

	return (
		<div className="h-full w-full overflow-y-auto">
			<div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-6 px-8 py-8 lg:grid-cols-[1fr_320px]">
				{/* ===================== 左栏：主区 ===================== */}
				<div className="flex flex-col gap-6">
					{/* Header */}
					<header className="flex flex-col gap-1.5">
						<div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.14em] text-(--text-4)">
							<KeyRound size={12} strokeWidth={1.5} />
							<span>{t("topbar_generator")}</span>
						</div>
						<div className="flex flex-wrap items-center gap-3">
							<h1 className="text-[22px] font-semibold tracking-tight text-(--text)">
								{t("gen_title")}
							</h1>
							<span className="inline-flex items-center gap-1.5 rounded-full border border-(--line-soft) bg-(--bg-elev-2) px-2.5 py-0.5 font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
								<Sparkles size={10} strokeWidth={1.5} />
								{t("gen_badge")}
							</span>
						</div>
						<p className="text-[13px] text-(--text-2)">{t("gen_sub")}</p>
					</header>

					{/* Display 区 —— 大字密码 + meta 行 */}
					<div className="relative flex min-h-32 flex-col gap-3 rounded-xl border border-(--line) bg-(--bg-elev) p-5">
						<div className="flex items-center justify-between gap-3 text-[10.5px] font-mono uppercase tracking-[0.1em] text-(--text-3)">
							<span>{metaText}</span>
							<button
								type="button"
								onClick={regen}
								className="flex items-center gap-1.5 rounded-(--radius) px-2 py-0.5 text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text)"
								title={t("gen_regen")}
							>
								<RefreshCw size={12} strokeWidth={1.5} />
								<span>{t("gen_regen")}</span>
							</button>
						</div>
						{count > 1 ? (
							// 批量：多行只读文本，每行一条，可选中复制
							<textarea
								readOnly
								value={batch.join("\n")}
								rows={Math.min(Math.max(batch.length, 3), 14)}
								spellCheck={false}
								className="w-full resize-y rounded-(--radius) border border-(--line) bg-(--bg) p-3 font-mono text-[13px] leading-relaxed break-all text-(--text-2) outline-none"
							/>
						) : (
							<div className="text-[18px]">
								<ColorizedPassword value={pw} />
							</div>
						)}
					</div>

					{/* 操作行 —— Regenerate / Copy / Save */}
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={regen}
							className="inline-flex items-center gap-1.5 rounded-(--radius) border border-(--line) bg-(--bg-elev) px-3 py-2 text-[12.5px] text-(--text-2) transition-colors hover:bg-(--bg-hover) hover:text-(--text)"
						>
							<RefreshCw size={13} strokeWidth={1.5} />
							<span>{t("gen_regen")}</span>
						</button>

						<button
							type="button"
							onClick={onCopy}
							className="inline-flex items-center gap-1.5 rounded-(--radius) bg-(--text) px-3.5 py-2 text-[12.5px] font-medium text-(--bg) transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97]"
						>
							{justCopied ? (
								<Check size={13} strokeWidth={2} />
							) : (
								<Copy size={13} strokeWidth={1.5} />
							)}
							<span>
								{justCopied
									? t("detail_copied")
									: count > 1
										? t("gen_copy_all")
										: t("gen_copy")}
							</span>
						</button>

						<div className="flex-1" />

						{/* 保存到保险库仅在单条模式下可用 —— 批量是"生成+复制"流程，
							一次性把 N 条灌进 vault 不是这里的目的 */}
						{count <= 1 && (
							<button
								type="button"
								onClick={onSaveToVault}
								className="inline-flex items-center gap-1.5 rounded-(--radius) border border-(--line) bg-(--bg-elev) px-3 py-2 text-[12.5px] text-(--text-2) transition-colors hover:bg-(--bg-hover) hover:text-(--text)"
							>
								<Save size={13} strokeWidth={1.5} />
								<span>{t("gen_save")}</span>
							</button>
						)}
					</div>

					{/* 强度条（lg 含熵 + 破解时间）—— 单条概念，批量时隐藏 */}
					{count <= 1 && (
						<div className="rounded-xl border border-(--line) bg-(--bg-elev) p-4">
							<PasswordStrength password={pw} size="lg" />
						</div>
					)}

					{/* 模式 + 选项 */}
					<div className="flex flex-col gap-4 rounded-xl border border-(--line) bg-(--bg-elev) p-5">
						<div className="flex items-center justify-between gap-3">
							<ModeSegment value={mode} onChange={setMode} />
							<span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-(--text-4)">
								{t("gen_section_options")}
							</span>
						</div>

						{/* 批量数量 —— 对三种模式通用，调到 > 1 即进入多行批量展示。
							拖拽落在 1..BATCH_MAX 软范围，需要更大数量可直接在输入框键入 */}
						<Slider
							label={t("gen_count")}
							value={count}
							min={1}
							max={BATCH_MAX}
							editable
							onChange={setCount}
						/>

						{/* Password 模式选项 */}
						{mode === "password" && (
							<div className="flex flex-col gap-5">
								<Slider
									label={t("gen_length")}
									value={pwOpts.length}
									min={8}
									max={64}
									onChange={(v) => setPwOpts((o) => ({ ...o, length: v }))}
								/>
								<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
									<Toggle
										label={t("gen_lower")}
										sub={t("gen_lower_sub")}
										on={pwOpts.lower ?? true}
										onChange={(v) => setPwOpts((o) => ({ ...o, lower: v }))}
									/>
									<Toggle
										label={t("gen_upper")}
										sub={t("gen_upper_sub")}
										on={pwOpts.upper ?? true}
										onChange={(v) => setPwOpts((o) => ({ ...o, upper: v }))}
									/>
									<Toggle
										label={t("gen_numbers")}
										sub={t("gen_numbers_sub")}
										on={pwOpts.numbers ?? true}
										onChange={(v) => setPwOpts((o) => ({ ...o, numbers: v }))}
									/>
									<Toggle
										label={t("gen_symbols")}
										sub={t("gen_symbols_sub")}
										on={pwOpts.symbols ?? false}
										onChange={(v) => setPwOpts((o) => ({ ...o, symbols: v }))}
									/>
									<Toggle
										label={t("gen_avoid_amb")}
										sub={t("gen_avoid_amb_sub")}
										on={pwOpts.avoidAmbiguous ?? false}
										onChange={(v) =>
											setPwOpts((o) => ({ ...o, avoidAmbiguous: v }))
										}
									/>
									<Toggle
										label={t("gen_avoid_rep")}
										sub={t("gen_avoid_rep_sub")}
										on={pwOpts.avoidRepeats ?? false}
										onChange={(v) =>
											setPwOpts((o) => ({ ...o, avoidRepeats: v }))
										}
									/>
								</div>
							</div>
						)}

						{/* Passphrase 模式选项 */}
						{mode === "passphrase" && (
							<div className="flex flex-col gap-5">
								<Slider
									label={t("gen_words")}
									value={phOpts.words}
									min={3}
									max={10}
									onChange={(v) => setPhOpts((o) => ({ ...o, words: v }))}
								/>

								{/* 分隔符 —— 用 chip 列表选择，常用 5 个 */}
								<div className="flex flex-col gap-2">
									<span className="text-[12px] text-(--text-2)">
										{t("gen_separator")}
									</span>
									<div className="flex flex-wrap gap-1.5">
										{["-", "_", ".", " ", ""].map((sep) => {
											const active = (phOpts.separator ?? "-") === sep;
											const label = sep === "" ? "∅" : sep === " " ? "␣" : sep;
											return (
												<button
													key={sep || "none"}
													type="button"
													onClick={() =>
														setPhOpts((o) => ({ ...o, separator: sep }))
													}
													className={
														active
															? "h-7 w-9 rounded-(--radius) border border-(--text) bg-(--text) font-mono text-[12px] text-(--bg)"
															: "h-7 w-9 rounded-(--radius) border border-(--line-soft) bg-(--bg-elev-2) font-mono text-[12px] text-(--text-2) transition-colors hover:bg-(--bg-hover) hover:text-(--text)"
													}
												>
													{label}
												</button>
											);
										})}
									</div>
								</div>

								<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
									<Toggle
										label={t("gen_capitalize")}
										sub={t("gen_capitalize_sub")}
										on={phOpts.capitalize ?? false}
										onChange={(v) =>
											setPhOpts((o) => ({ ...o, capitalize: v }))
										}
									/>
									<Toggle
										label={t("gen_include_number")}
										sub={t("gen_include_number_sub")}
										on={phOpts.includeNumber ?? false}
										onChange={(v) =>
											setPhOpts((o) => ({ ...o, includeNumber: v }))
										}
									/>
								</div>
							</div>
						)}

						{/* PIN 模式选项 */}
						{mode === "pin" && (
							<div className="flex flex-col gap-5">
								<Slider
									label={t("gen_length")}
									value={pinLen}
									min={4}
									max={12}
									onChange={setPinLen}
								/>
								<p className="text-[11.5px] leading-relaxed text-(--text-3)">
									{/*
										PIN 模式不显示选项 toggle —— 数字 PIN 唯一可调的就是
										长度。提示用户"PIN 强度依赖于服务方的尝试限制"，避免
										生成 4 位 PIN 时用户对底部强度条感到困惑。
									*/}
									{t("gen_tip_3")}
								</p>
							</div>
						)}
					</div>
				</div>

				{/* ===================== 右栏：历史 + 提示 ===================== */}
				<aside className="flex flex-col gap-6">
					{/* 最近生成 */}
					<section className="flex flex-col gap-2">
						<h3 className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-(--text-4)">
							{t("gen_recent")}
						</h3>
						<div className="flex flex-col rounded-xl border border-(--line) bg-(--bg-elev)">
							{history.length === 0 ? (
								<div className="flex h-24 items-center justify-center px-4 text-center text-[12px] text-(--text-3)">
									{t("gen_recent_empty")}
								</div>
							) : (
								<ul className="flex flex-col divide-y divide-(--line-soft)">
									{history.map((h) => (
										<li
											key={`${h.at}-${h.value}`}
											className="flex items-center gap-2 px-3 py-2.5"
										>
											<span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-(--text-2)">
												{h.value}
											</span>
											<span className="font-mono text-[9.5px] uppercase tracking-wider text-(--text-4)">
												{h.mode === "password"
													? "PW"
													: h.mode === "passphrase"
														? "PH"
														: "PIN"}
											</span>
											<button
												type="button"
												onClick={() => onCopyHistory(h)}
												className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius) text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text)"
												title={t("gen_copy")}
											>
												<Copy size={11} strokeWidth={1.5} />
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
					</section>

					{/* Tips */}
					<section className="flex flex-col gap-2">
						<h3 className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-(--text-4)">
							{t("gen_tips")}
						</h3>
						<ul className="flex flex-col gap-2 rounded-xl border border-(--line) bg-(--bg-elev) p-4 font-mono text-[11.5px] leading-relaxed text-(--text-2)">
							<li className="flex items-start gap-2">
								<ChevronDown
									size={11}
									strokeWidth={1.5}
									className="mt-1 shrink-0 -rotate-90 text-(--text-4)"
								/>
								<span>{t("gen_tip_1")}</span>
							</li>
							<li className="flex items-start gap-2">
								<ChevronDown
									size={11}
									strokeWidth={1.5}
									className="mt-1 shrink-0 -rotate-90 text-(--text-4)"
								/>
								<span>{t("gen_tip_2")}</span>
							</li>
							<li className="flex items-start gap-2">
								<ChevronDown
									size={11}
									strokeWidth={1.5}
									className="mt-1 shrink-0 -rotate-90 text-(--text-4)"
								/>
								<span>{t("gen_tip_3")}</span>
							</li>
						</ul>
					</section>
				</aside>
			</div>
		</div>
	);
}

export default GeneratorPage;
