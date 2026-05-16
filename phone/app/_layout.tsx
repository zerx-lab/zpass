import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
} from "@react-navigation/native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import "react-native-reanimated";

import { Colors } from "@/constants/theme";
import { ThemeProvider, useTheme } from "@/contexts/theme-context";
import { VaultProvider, useVault } from "@/contexts/vault-context";
import { LockOverlay } from "@/components/lock-overlay";

export const unstable_settings = {
  anchor: "(tabs)",
};

/**
 * 内层组件：消费 ThemeContext，把 ZPass 调色板桥接到 react-navigation 的主题系统
 */
function RootLayoutNav() {
  const { scheme } = useTheme();
  const { locked } = useVault();

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
      {locked && <LockOverlay />}
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
