// ---------------------------------------------------------------------------
// SshKeyDialogSection —— SSH item dialog 中的「生成/导入」面板
// ---------------------------------------------------------------------------
//
// 从 VaultPage.tsx 拆出独立文件,目的:让 ItemDialog 通过 React.lazy 按需加载,
// 把 SshKeyGeneratorPanel / supportedSshAlgos / generateSshKeyPair 这一串
// 仅在新建 SSH 条目时才用到的依赖从 VaultPage 主 chunk 剥离。
//
// 职责保持不变:
//   - 渲染 mode tabs(生成 / 导入)
//   - 生成模式下挂 SshKeyGeneratorPanel; 调后端生成后把 private_key /
//     public_key 写回 dialog 的 fields state(通过 setField)
//   - 导入模式下什么也不渲染(原有的 private_key / passphrase 字段会由
//     ItemDialog 的 fieldDefs.map 正常渲染)
//
// 注意:本模块作为 lazy chunk,必须有 default 导出 —— React.lazy 的协议要求。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import {
	type GeneratedKeyPair,
	SshKeyGeneratorPanel,
	SshKeyModeTabs,
} from "@/features/sshagent/SshKeyGenerator";
import { generateSshKeyPair, supportedSshAlgos } from "@/lib/sshagent-api";

function SshKeyDialogSection({
	mode,
	onModeChange,
	itemName,
	fields,
	setField,
}: {
	mode: "generate" | "import";
	onModeChange: (m: "generate" | "import") => void;
	/**
	 * SSH item 的名称(由 ItemDialog 传入)。与 Bitwarden 一致:SSH 条目的
	 * 「用户名」语义完全由 item.name 承担,不再有独立 username 字段。
	 * 该值带入 SshKeyGeneratorPanel 作为默认 comment。
	 */
	itemName: string;
	fields: Record<string, string>;
	setField: (k: string, v: string) => void;
}) {
	const [algos, setAlgos] = useState<string[]>([
		"ed25519",
		"rsa-3072",
		"rsa-4096",
		"ecdsa-p256",
	]);

	// 启动时从后端拉最新支持的算法列表 —— 让未来后端加新算法不需要同步前端
	useEffect(() => {
		let cancelled = false;
		supportedSshAlgos()
			.then((list) => {
				if (!cancelled && list.length > 0) setAlgos(list);
			})
			.catch(() => {
				/* 保留默认 fallback */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// 生成成功 → 填进 fields state
	const handleGenerated = useCallback(
		(kp: GeneratedKeyPair) => {
			setField("private_key", kp.privateKeyPem);
			setField("public_key", kp.publicKeyOpenSsh);
			// 用户没填 passphrase 时留空 —— 生成的私钥本身就是不加密的
			// OpenSSH PEM,vault 加密已够,不需要额外口令
		},
		[setField],
	);

	// 预填 comment:优先 item.name@host,其次 item.name。与后端 composeComment 一致。
	const defaultComment = (() => {
		const n = (itemName || "").trim();
		const h = (fields.host || "").trim();
		if (n && h) return `${n}@${h}`;
		if (n) return n;
		return "";
	})();

	return (
		<div className="flex flex-col gap-3">
			<SshKeyModeTabs mode={mode} onChange={onModeChange} />
			{mode === "generate" && (
				<SshKeyGeneratorPanel
					defaultComment={defaultComment}
					supportedAlgos={algos}
					onGenerate={generateSshKeyPair}
					onGenerated={handleGenerated}
				/>
			)}
		</div>
	);
}

export default SshKeyDialogSection;
