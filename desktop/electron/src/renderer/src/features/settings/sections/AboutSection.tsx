import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Row, Section } from "../shared";

export function AboutSection() {
	const { t } = useTranslation();

	// 版本号仍是硬编码（暂无统一 build-stamp）。构建标识由 Vite 在编译期静态
	// 注入的 import.meta.env.PROD 决定：`task dev` 走 vite dev server（DEV=true）
	// 显示 "dev"；`task build`/`task make` 及 CI 的 `pnpm run package/make` 走
	// production 构建（PROD=true）显示 "release"。无运行时 IPC 开销。
	const version = "0.1.0";
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
		</Section>
	);
}

export default AboutSection;
