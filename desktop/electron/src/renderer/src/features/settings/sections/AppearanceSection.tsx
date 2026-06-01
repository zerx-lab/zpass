import { Moon, SlidersHorizontal, Sun, Type } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FontSelect } from "@/components/FontSelect";
import { Select } from "@/components/Select";
import { vaultApi } from "@/lib/vault-api";
import { type Body, type Theme, type UiScale, usePrefsStore } from "@/stores/prefs";
import { Row, Section } from "../shared";

export function AppearanceSection() {
	const { t } = useTranslation();
	const theme = usePrefsStore((s) => s.theme);
	const setTheme = usePrefsStore((s) => s.setTheme);
	const scale = usePrefsStore((s) => s.scale);
	const setScale = usePrefsStore((s) => s.setScale);
	const body = usePrefsStore((s) => s.body);
	const setBody = usePrefsStore((s) => s.setBody);
	const fontSans = usePrefsStore((s) => s.fontSans);
	const setFontSans = usePrefsStore((s) => s.setFontSans);
	const fontMono = usePrefsStore((s) => s.fontMono);
	const setFontMono = usePrefsStore((s) => s.setFontMono);
	const [systemFonts, setSystemFonts] = useState<string[]>([]);
	const [fontsLoading, setFontsLoading] = useState(true);

	useEffect(() => {
		vaultApi
			.getSystemFonts()
			.then((fonts) => {
				setSystemFonts(fonts);
				setFontsLoading(false);
			})
			.catch(() => {
				setSystemFonts(["Geist", "Geist Mono"]);
				setFontsLoading(false);
			});
	}, []);

	return (
		<Section
			icon={SlidersHorizontal}
			title={t("settings_section_appearance")}
			description={t("settings_section_appearance_desc")}
		>
			<Row
				label={t("settings_theme")}
				description={t("settings_theme_desc")}
				control={
					<Select<Theme>
						ariaLabel={t("settings_theme")}
						value={theme}
						onChange={setTheme}
						className="min-w-40"
						options={[
							{
								value: "dark",
								label: t("settings_theme_dark"),
								icon: Moon,
							},
							{
								value: "light",
								label: t("settings_theme_light"),
								icon: Sun,
							},
						]}
					/>
				}
			/>

			{/*
			 * 缩放（Scale）—— 对应 <html style="zoom: <pct>%">。
			 * 选项档位对标 VS Code / Slack 的 Zoom 菜单，覆盖从"高分屏压缩"
			 * 到"可访问性放大"的实用区间；默认 100% 无覆盖。
			 * label 用"标签 + 百分比"双语义：比如"标准 100%" —— 既给出
			 * 具体数值方便用户精确对齐，又用文字概括该档的定位。
			 */}
			<Row
				label={t("settings_scale")}
				description={t("settings_scale_desc")}
				control={
					<Select<UiScale>
						ariaLabel={t("settings_scale")}
						value={scale}
						onChange={setScale}
						className="min-w-40"
						options={[
							{ value: "80", label: t("settings_scale_80") },
							{ value: "90", label: t("settings_scale_90") },
							{ value: "100", label: t("settings_scale_100") },
							{ value: "110", label: t("settings_scale_110") },
							{ value: "125", label: t("settings_scale_125") },
							{ value: "150", label: t("settings_scale_150") },
						]}
					/>
				}
			/>

			<Row
				label={t("settings_body_font")}
				description={t("settings_body_font_desc")}
				control={
					<Select<Body>
						ariaLabel={t("settings_body_font")}
						value={body}
						onChange={setBody}
						className="min-w-40"
						options={[
							{ value: "sans", label: t("settings_body_sans"), icon: Type },
							{ value: "mono", label: t("settings_body_mono"), icon: Type },
						]}
					/>
				}
			/>

			<Row
				label={t("settings_font_sans")}
				description={t("settings_font_sans_desc")}
				control={
					<FontSelect
						value={fontSans}
						onChange={setFontSans}
						fonts={systemFonts}
						defaultLabel={t("settings_font_default")}
						ariaLabel={t("settings_font_sans")}
						loading={fontsLoading}
						noResultsLabel={t("settings_font_no_results")}
					/>
				}
			/>

			<Row
				label={t("settings_font_mono")}
				description={t("settings_font_mono_desc")}
				control={
					<FontSelect
						value={fontMono}
						onChange={setFontMono}
						fonts={systemFonts}
						defaultLabel={t("settings_font_default_mono")}
						ariaLabel={t("settings_font_mono")}
						loading={fontsLoading}
						noResultsLabel={t("settings_font_no_results")}
					/>
				}
			/>
		</Section>
	);
}

export default AppearanceSection;
