import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { useUpdateStore } from "@/stores/update";
import { Row, Section } from "../shared";

/** 更新行右侧控件 —— 随 useUpdateStore.status 切换按钮/文案。 */
function UpdateControl() {
	const { t } = useTranslation();
	const status = useUpdateStore((s) => s.status);
	const version = useUpdateStore((s) => s.version);
	const percent = useUpdateStore((s) => s.percent);
	const mode = useUpdateStore((s) => s.mode);
	const downloadUrl = useUpdateStore((s) => s.downloadUrl);

	if (status === "checking") {
		return (
			<Button size="sm" variant="secondary" loading disabled>
				{t("update_checking")}
			</Button>
		);
	}
	if (status === "downloading") {
		return (
			<span className="text-[12px] text-(--text-2)">
				{t("update_downloading", { percent })}
			</span>
		);
	}
	if (status === "downloaded") {
		return (
			<Button size="sm" onClick={() => void window.desktop.update.install()}>
				{t("update_restart")}
			</Button>
		);
	}
	if (status === "available" && mode === "manual-open") {
		return (
			<div className="flex items-center gap-2">
				<span className="text-[12px] text-(--text-2)">
					{t("update_new_version", { version })}
				</span>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => {
						if (downloadUrl)
							void window.desktop.update.openDownloadPage(downloadUrl);
					}}
				>
					{t("update_open_page")}
				</Button>
			</div>
		);
	}
	// idle / none / error / available(auto) —— 提供手动检查入口。
	return (
		<div className="flex items-center gap-2">
			{status === "none" && (
				<span className="text-[12px] text-(--text-2)">{t("update_latest")}</span>
			)}
			{status === "error" && (
				<span className="text-[12px] text-(--text-2)">{t("update_failed")}</span>
			)}
			<Button
				size="sm"
				variant="secondary"
				onClick={() => void window.desktop.update.check()}
			>
				{t("update_check")}
			</Button>
		</div>
	);
}

export function AboutSection() {
	const { t } = useTranslation();

	// 版本号由 Vite 在编译期静态注入 __APP_VERSION__（见 vite.renderer.config.ts），
	// 权威来源是 desktop/package.json 的 version 字段。CI 发布时由
	// .github/workflows/desktop-build.yml 把 release tag 回写进 package.json，
	// 因此应用内"关于"展示的版本与安装包、git tag 三者完全一致。构建标识由
	// import.meta.env.PROD 决定：`task dev` 走 vite dev server（DEV=true）显示
	// "dev"；production 构建（PROD=true）显示 "release"。无运行时 IPC 开销。
	const version = __APP_VERSION__;
	const build = import.meta.env.PROD ? "release" : "dev";

	// 说明：
	//   "源代码"行已移除 —— ZPass 并非开源项目，不向用户暴露仓库地址，避免
	//   给出错误的开源软件心智预期。settings_about_source i18n 键保留（其它
	//   场景可能还会用到，且删除会破坏 Strings 类型约束）。
	return (
		<Section icon={Info} title={t("settings_section_about")}>
			<Row
				label={t("settings_about_version")}
				control={
					<span className="font-mono text-[12px] text-(--text-2)">
						{version}
					</span>
				}
			/>
			<Row
				label={t("settings_about_build")}
				control={
					<span className="font-mono text-[12px] text-(--text-2)">{build}</span>
				}
			/>
			<Row label={t("settings_about_update")} control={<UpdateControl />} />
		</Section>
	);
}

export default AboutSection;
