// SSH 密钥生成器 —— vault 新建 SSH item 时使用
// ---------------------------------------------------------------------------
// 设计目标
//
// 新建 SSH item 的对话框顶部应当默认显示「生成新密钥」流程，让用户在 5 秒
// 内拿到一个可用密钥对而不是被迫去 `ssh-keygen` + 粘贴。
//
// 两种模式：
//   1. 「生成新密钥」（默认）：选算法 + 点按钮 → 后端生成 → 自动预填字段
//   2. 「导入已有密钥」：保留原表单（私钥 textarea + 口令 + 主机）
//
// 用户可以在两种模式间切换；切换时已填字段保留（导入态填了私钥再切到生成
// 也不会丢，反之亦然）。
//
// ---------------------------------------------------------------------------
// 安全注意
//
// 生成出来的私钥 PEM 在 React 状态里以明文持有 —— 与「用户粘贴」无异。
// 生成成功后立即提示用户「公钥已生成，请添加到 GitHub/服务器」，给一个
// 「复制公钥」按钮让用户不必再翻 vault 详情页。

import {
	Check,
	Copy,
	Eye,
	EyeOff,
	KeyRound,
	ShieldAlert,
	Sparkles,
	Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { Select } from "@/components/Select";
import { writeClipboard } from "@/lib/clipboard";

export type SshKeyMode = "generate" | "import";

/**
 * SshKeyDialogTabs - dialog 顶部的 mode 切换 tab
 *
 * 设计成可重用组件：未来如果其它 item 类型也需要 tab（如「生成强密码」
 * vs「导入」）可以复用相同样式。
 */
export function SshKeyModeTabs({
	mode,
	onChange,
	disabled,
}: {
	mode: SshKeyMode;
	onChange: (m: SshKeyMode) => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex items-center gap-1 rounded-md border border-(--line-soft) bg-(--bg-elev-2) p-1">
			<TabButton
				active={mode === "generate"}
				disabled={disabled}
				onClick={() => onChange("generate")}
				icon={<Sparkles size={12} strokeWidth={1.5} />}
				label={t("sshkey_mode_generate")}
			/>
			<TabButton
				active={mode === "import"}
				disabled={disabled}
				onClick={() => onChange("import")}
				icon={<Upload size={12} strokeWidth={1.5} />}
				label={t("sshkey_mode_import")}
			/>
		</div>
	);
}

function TabButton({
	active,
	disabled,
	onClick,
	icon,
	label,
}: {
	active: boolean;
	disabled?: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={
				active
					? "flex flex-1 items-center justify-center gap-1.5 rounded-md bg-(--bg) px-3 py-1.5 text-[12px] font-medium text-(--text) shadow-sm"
					: "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] text-(--text-3) hover:text-(--text-2)"
			}
		>
			{icon}
			{label}
		</button>
	);
}

// ---------------------------------------------------------------------------
// 后端类型 —— 与 Go GeneratedKeyPair 一一对应
// ---------------------------------------------------------------------------

export interface GeneratedKeyPair {
	algo: string;
	privateKeyPem: string;
	publicKeyOpenSsh: string;
	fingerprint: string;
}

/**
 * 生成模式下展示的卡片：算法 + 生成按钮 + 公钥/指纹回显
 *
 * 不直接耦合 dialog 内部状态 —— 通过 onGenerated 回调把生成结果交给上层，
 * 上层负责把 privateKeyPem 等字段填到 ItemDialog 的 `fields` state。
 *
 * 这样的好处：
 *   - 上层不需要懂「生成」细节，只接收最终的 KeyPair
 *   - 测试容易：mock generateKeyPair 即可单独测试本组件
 */
export function SshKeyGeneratorPanel({
	defaultComment,
	supportedAlgos,
	onGenerate,
	onGenerated,
}: {
	/** 默认 comment（如 "user@host" 形式，会预填到输入框） */
	defaultComment?: string;
	/** 后端返回的算法列表 */
	supportedAlgos: string[];
	/**
	 * 实际生成调用 —— 由上层注入 sshagent-api.generateKeyPair。
	 * 抽出来让本组件无后端依赖，方便单测。
	 */
	onGenerate: (algo: string, comment: string) => Promise<GeneratedKeyPair>;
	/** 生成成功后回调，把结果交给上层（即 ItemDialog）预填字段 */
	onGenerated: (kp: GeneratedKeyPair) => void;
}) {
	const { t } = useTranslation();
	const [algo, setAlgo] = useState<string>(supportedAlgos[0] || "ed25519");
	const [comment, setComment] = useState<string>(defaultComment || "");
	const [generating, setGenerating] = useState(false);
	const [result, setResult] = useState<GeneratedKeyPair | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	// 私钥默认折叠隐藏 —— 避免「人て看到后肩叔叔偷窥」。用户需要另外点「显示」。
	//
	// 每次生成新密钥后重置为隐藏状态（避免「上一个密钥默认显示」让新密钥
	// 刚生成就裸露」的问题）。
	const [showPrivate, setShowPrivate] = useState(false);
	const [privateCopied, setPrivateCopied] = useState(false);

	// 「用户是否亲自动过 comment 输入框」标志位。
	//
	// 设计上 comment 默认跟随上层 defaultComment（itemName / host 拼出来），
	// 一旦用户主动改了 comment 就锁定，不再被外层同步覆盖。
	//
	// 之前的实现用 `!comment` 作为「未被用户编辑」的近似判断，导致两个 bug：
	//   1. defaultComment 从 "" 第一次同步给 comment 后，再变化 ("h" → "he")
	//      不会再同步（`!comment` 已为 false），
	//      表现为「名称输入 hello 但注释只显示 h」。
	//   2. 用户清空 comment（变 ""），又会被 defaultComment 强行回填，
	//      用户没法保留「就是要空 comment」的意图。
	// 改用 ref 显式区分「用户编辑过」vs「跟随默认值」两种状态。
	const userEditedRef = useRef(false);

	// 当 defaultComment 变化（用户在 dialog 改了 name/host）时同步到 comment，
	// 但只在用户尚未主动编辑过 comment 时才同步，避免覆盖用户输入。
	useEffect(() => {
		if (!userEditedRef.current) setComment(defaultComment || "");
	}, [defaultComment]);

	const handleGenerate = useCallback(async () => {
		setGenerating(true);
		setError(null);
		try {
			const kp = await onGenerate(algo, comment);
			setResult(kp);
			setShowPrivate(false); // 重置「隐藏」，避免上一个密钥的可见状态被新密钥继承
			onGenerated(kp);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setGenerating(false);
		}
	}, [algo, comment, onGenerate, onGenerated]);

	const handleCopyPublic = useCallback(async () => {
		if (!result?.publicKeyOpenSsh) return;
		const ok = await writeClipboard(result.publicKeyOpenSsh);
		if (ok) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [result]);

	// 复制私钥：与公钥不同，折叠状态下用户也能复制（「不看置贴」是合理用法）。
	// 复制后 2 秒恢复原按钮文本让用户明确看到反馈。
	const handleCopyPrivate = useCallback(async () => {
		if (!result?.privateKeyPem) return;
		const ok = await writeClipboard(result.privateKeyPem);
		if (ok) {
			setPrivateCopied(true);
			setTimeout(() => setPrivateCopied(false), 2000);
		}
	}, [result]);

	const algoLabel = (a: string): string => {
		// 把后端的 "rsa-3072" 这样的标识翻译为友好显示
		const map: Record<string, string> = {
			ed25519: "Ed25519 (推荐 / Recommended)",
			"rsa-3072": "RSA 3072",
			"rsa-4096": "RSA 4096",
			"ecdsa-p256": "ECDSA P-256",
		};
		return map[a] || a;
	};

	return (
		<div className="flex flex-col gap-3 rounded-md border border-(--line-soft) bg-(--bg-elev-2) p-3.5">
			{/* 提示行 */}
			<div className="flex items-center gap-2 text-[12px] text-(--text-3)">
				<KeyRound size={13} strokeWidth={1.5} />
				<span>{t("sshkey_generate_hint")}</span>
			</div>

			{/* 算法 + comment + 生成按钮 */}
			<div className="grid grid-cols-1 gap-2.5">
				<div className="flex flex-col gap-1.5">
					<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
						{t("sshkey_algo_label")}
					</span>
					<Select
						ariaLabel={t("sshkey_algo_label")}
						value={algo}
						onChange={setAlgo}
						disabled={generating}
						options={supportedAlgos.map((a) => ({
							value: a,
							label: algoLabel(a),
						}))}
						className="min-w-0 w-full"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<label
						htmlFor="ssh-comment"
						className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase"
					>
						{t("sshkey_comment_label")}
					</label>
					<input
						id="ssh-comment"
						type="text"
						value={comment}
						onChange={(e) => {
							userEditedRef.current = true;
							setComment(e.target.value);
						}}
						placeholder={t("sshkey_comment_placeholder")}
						disabled={generating}
						className="rounded-md border border-(--line) bg-(--bg) px-2.5 py-1.5 text-[13px] text-(--text) outline-none placeholder:text-(--text-4) focus:border-(--text-3)"
					/>
				</div>
			</div>

			{/* 生成按钮 */}
			<Button
				type="button"
				variant="default"
				size="md"
				onClick={handleGenerate}
				loading={generating}
				leftIcon={<Sparkles size={12} strokeWidth={1.5} />}
			>
				{generating
					? t("sshkey_generating")
					: result
						? t("sshkey_regenerate")
						: t("sshkey_generate_btn")}
			</Button>

			{/* 错误 */}
			{error && (
				<div className="rounded-md border border-(--danger) bg-(--danger-subtle) px-2.5 py-2 text-[12px] text-(--danger)">
					{error}
				</div>
			)}

			{/* 生成结果回显 */}
			{result && (
				<div className="flex flex-col gap-2 border-t border-(--line-soft) pt-3">
					<div className="flex items-center justify-between">
						<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
							{t("sshkey_public_key_label")}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={handleCopyPublic}
							leftIcon={
								copied ? (
									<Check size={11} strokeWidth={1.5} />
								) : (
									<Copy size={11} strokeWidth={1.5} />
								)
							}
						>
							{copied ? t("sshkey_copied") : t("sshkey_copy_public")}
						</Button>
					</div>
					<code className="block max-h-24 overflow-y-auto rounded-md border border-(--line) bg-(--bg) px-2 py-1.5 break-all font-mono text-[11px] text-(--text)">
						{result.publicKeyOpenSsh}
					</code>

					<div className="flex flex-col gap-0.5 pt-1">
						<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
							{t("sshkey_fingerprint_label")}
						</span>
						<code className="font-mono text-[11px] text-(--text-2)">
							{result.fingerprint}
						</code>
					</div>

					{/* 私钥区域 —— 默认折叠，点「显示」才看到。
					 * 需要让用户能看到 + 复制的原因：
					 *   1. 导出能力：复制到其他机器的 ~/.ssh/id_ed25519
					 *   2. 审计透明度：「私钥被加密」不能只是口头承诺
					 *   3. 故障恢复：万一 ZPass agent 不可用，用户能拿回私钥手动用
					 *
					 * 同时加一个安全警告让用户明白「别发给别人」。
					 */}
					<div className="flex flex-col gap-1.5 pt-1">
						<div className="flex items-center justify-between">
							<span className="font-mono text-[10.5px] tracking-wider text-(--text-3) uppercase">
								{t("sshkey_private_key_label")}
							</span>
							<div className="flex items-center gap-1">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setShowPrivate((v) => !v)}
									leftIcon={
										showPrivate ? (
											<EyeOff size={11} strokeWidth={1.5} />
										) : (
											<Eye size={11} strokeWidth={1.5} />
										)
									}
								>
									{showPrivate
										? t("sshkey_hide_private")
										: t("sshkey_show_private")}
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={handleCopyPrivate}
									leftIcon={
										privateCopied ? (
											<Check size={11} strokeWidth={1.5} />
										) : (
											<Copy size={11} strokeWidth={1.5} />
										)
									}
								>
									{privateCopied
										? t("sshkey_copied")
										: t("sshkey_copy_private")}
								</Button>
							</div>
						</div>
						{showPrivate ? (
							<pre className="max-h-40 overflow-y-auto rounded-md border border-(--line) bg-(--bg) px-2 py-1.5 font-mono text-[11px] leading-snug text-(--text) whitespace-pre">
								{result.privateKeyPem}
							</pre>
						) : (
							<button
								type="button"
								onClick={() => setShowPrivate(true)}
								className="flex w-full items-center justify-center rounded-md border border-dashed border-(--line) bg-(--bg) px-3 py-3 text-[12px] text-(--text-3) hover:bg-(--bg-hover) hover:text-(--text-2)"
							>
								{t("sshkey_private_hidden_hint")}
							</button>
						)}
						<div className="flex items-start gap-1.5 rounded-md border border-(--line-soft) bg-(--bg) px-2.5 py-2 text-[11.5px] text-(--text-3)">
							<ShieldAlert
								size={12}
								strokeWidth={1.5}
								className="mt-0.5 shrink-0 text-(--text-2)"
							/>
							<span>{t("sshkey_private_warning")}</span>
						</div>
					</div>

					<p className="pt-1 text-[11.5px] text-(--text-4)">
						{t("sshkey_after_generate_hint")}
					</p>
				</div>
			)}
		</div>
	);
}
