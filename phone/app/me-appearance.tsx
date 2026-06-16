// 外观与交互 —— 「我的」二级页（对齐 harmony MeAppearance）
//
// 分组：外观（主题 / 语言 / 安全页开关）

import React from "react";
import { Switch } from "react-native";

import { useTheme, type ThemeMode } from "@/contexts/theme-context";
import { useUiSettings } from "@/contexts/ui-settings-context";
import { actionSheet } from "@/components/ui/dialog";
import { ListGroup, ListRow } from "@/components/ui/primitives";
import { SettingsPage } from "@/components/settings/settings-page";

export default function MeAppearanceScreen() {
  const { colors: c, mode: themeMode, setMode: setThemeMode, scheme } =
    useTheme();
  const { securityTabEnabled, setSecurityTabEnabled } = useUiSettings();

  const themeValueLabel = React.useMemo(() => {
    if (themeMode === "system")
      return `跟随系统 · ${scheme === "dark" ? "深色" : "浅色"}`;
    return themeMode === "dark" ? "深色" : "浅色";
  }, [themeMode, scheme]);

  const handleThemePress = React.useCallback(async () => {
    const options: { label: string; value: ThemeMode }[] = [
      { label: "跟随系统", value: "system" },
      { label: "深色", value: "dark" },
      { label: "浅色", value: "light" },
    ];
    const key = await actionSheet.show({
      title: "选择主题",
      message: "切换 ZPass 的外观主题",
      actions: options.map((opt) => ({
        key: opt.value,
        label: `${opt.label}${themeMode === opt.value ? " · 当前" : ""}`,
        variant: themeMode === opt.value ? "primary" : "default",
      })),
    });
    if (key) setThemeMode(key as ThemeMode);
  }, [themeMode, setThemeMode]);

  return (
    <SettingsPage title="外观与交互">
      <ListGroup header="外观">
        <ListRow
          title="主题"
          value={themeValueLabel}
          icon={scheme === "dark" ? "moon.fill" : "sun.max.fill"}
          onPress={handleThemePress}
        />
        <ListRow title="语言" value="中文" icon="globe" accessory="none" />
        <ListRow
          title="安全页"
          subtitle="在底部标签栏展示安全评分与泄露检测"
          icon="shield.fill"
          onPress={() => setSecurityTabEnabled(!securityTabEnabled)}
          trailing={
            <Switch
              value={securityTabEnabled}
              onValueChange={setSecurityTabEnabled}
              trackColor={{ false: c.bgActive, true: c.accent }}
              thumbColor="#ffffff"
            />
          }
        />
      </ListGroup>
    </SettingsPage>
  );
}
