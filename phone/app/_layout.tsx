import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
} from "@react-navigation/native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import { View } from "react-native";
import "react-native-reanimated";

import { Colors } from "@/constants/theme";
import { ThemeProvider, useTheme } from "@/contexts/theme-context";
import { VaultProvider, useVault } from "@/contexts/vault-context";
import { LockOverlay } from "@/components/lock-overlay";
import { OnboardingOverlay } from "@/components/onboarding-overlay";

export const unstable_settings = {
  anchor: "(tabs)",
};

/**
 * 内层组件：消费 ThemeContext / VaultContext，
 *   - 首次状态探测未完成 → 黑屏占位避免闪烁
 *   - 未初始化 → Onboarding（创建主密码）
 *   - 已初始化未解锁 → LockOverlay
 *   - 已解锁 → 正常路由树
 */
function RootLayoutNav() {
  const { scheme } = useTheme();
  const { locked, initialized, hydrated } = useVault();

  const navTheme = useMemo(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    const c = Colors[scheme];
    return {
      ...base,
      dark: scheme === "dark",
      colors: {
        ...base.colors,
        background: c.bg,
        card: c.bgElev,
        border: c.line,
        text: c.text,
        primary: c.accent,
        notification: c.danger,
      },
    };
  }, [scheme]);

  if (!hydrated) {
    // 探测期间稳定背景；下面的 overlay 在 hydrated 后才挂载
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: Colors[scheme].bg,
        }}
      />
    );
  }

  return (
    <NavThemeProvider value={navTheme}>
      <Stack screenOptions={{ contentStyle: { backgroundColor: Colors[scheme].bg } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="vault/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="totp/[id]" options={{ headerShown: false }} />
        <Stack.Screen
          name="item/[id]"
          options={{ headerShown: false, presentation: "modal" }}
        />
      </Stack>
      {!initialized ? (
        <OnboardingOverlay />
      ) : locked ? (
        <LockOverlay />
      ) : null}
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider initialMode="system">
      <VaultProvider>
        <RootLayoutNav />
      </VaultProvider>
    </ThemeProvider>
  );
}
