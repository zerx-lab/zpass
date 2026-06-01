import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Row, Section } from "../shared";

export function AboutSection() {
	const { t } = useTranslation();

	// 版本号与构建标识目前是硬编码，后续可通过 Tauri 的 @tauri-apps/api/app
	// 的 getVersion() / getName() 读取真实 metadata；当前 UI 先走常量，避免
	// 每次开 Settings 页都发起一次 IPC。
	const version = "0.1.0";
	const build = "dev";

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
		</Section>
	);
}

export default AboutSection;
