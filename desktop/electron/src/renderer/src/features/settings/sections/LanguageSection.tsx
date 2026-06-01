import { Globe, Monitor } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "@/components/Select";
import { detectSystemLang, type Lang, usePrefsStore } from "@/stores/prefs";
import { Row, Section } from "../shared";

/**
 * 语言行 —— 合并"跟随系统"与显式语言为单一 Select
 * ---------------------------------------------------------------------------
 * 内部用一个合成 value 类型 `LangChoice = "system" | Lang`：
 *   - UI 态：控件里选什么就显示什么
 *   - 持久化态：prefs 的 `lang`（当前生效语言）+ `langFollowSystem`（是否跟随系统）
 *     两个字段。"跟随系统"是独立的第一类状态，不靠等值推断。
 *
 * 读：`langFollowSystem === true` → 显示 "system"，否则显示 `lang` 本身
 * 写：选 "system" → 调 resetLangToSystem()；选具体语言 → 调 setLang()
 *
 * 为什么不沿用旧的 `lang === detectSystemLang()` 推断：
 *   - 当用户主动选择的语言恰好等于系统语言时，两者相等，UI 会错误地把
 *     "锁定该语言"显示成"跟随系统"。
 *   - 更严重：`resetLangToSystem` 与 `setLang(systemLang)` 在存储层无法区分，
 *     系统语言日后变更会让"锁定"意图悄悄失效。
 *   - 引入独立标志 `langFollowSystem` 后，意图被显式记录，下次启动即使
 *     系统语言变了，用户"锁定中文"的选择也会保持。
 */
type LangChoice = "system" | Lang;

export function LanguageSection() {
	const { t } = useTranslation();
	const lang = usePrefsStore((s) => s.lang);
	const langFollowSystem = usePrefsStore((s) => s.langFollowSystem);
	const setLang = usePrefsStore((s) => s.setLang);
	const resetLangToSystem = usePrefsStore((s) => s.resetLangToSystem);

	// 系统语言 —— useMemo 避免每次渲染重算（detectSystemLang 会读 navigator）
	const systemLang = useMemo(() => detectSystemLang(), []);
	const current: LangChoice = langFollowSystem ? "system" : lang;

	const handleChange = (next: LangChoice) => {
		if (next === "system") {
			resetLangToSystem();
		} else {
			setLang(next);
		}
	};

	// hint：在 "Follow system" 选项右侧显示当前系统语言的 BCP-47 标签，
	// 让用户清楚"跟随系统"当前会落到哪种语言
	const systemHint = systemLang === "zh" ? "zh-CN" : "en";

	return (
		<Section
			icon={Globe}
			title={t("settings_section_language")}
			description={t("settings_section_language_desc")}
		>
			<Row
				label={t("settings_language")}
				description={t("settings_language_desc")}
				control={
					<Select<LangChoice>
						ariaLabel={t("settings_language")}
						value={current}
						onChange={handleChange}
						className="min-w-50"
						options={[
							{
								value: "system",
								label: t("settings_language_system"),
								icon: Monitor,
								hint: systemHint,
							},
							{
								value: "en",
								label: t("settings_language_en"),
							},
							{
								value: "zh",
								label: t("settings_language_zh"),
							},
						]}
					/>
				}
			/>
		</Section>
	);
}

export default LanguageSection;
