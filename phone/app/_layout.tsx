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

export const unstable_settings = {
  anchor: "(tabs)",
};

/**
 * 内层组件：消费 ThemeContext，把 ZPass 调色板桥接到 react-navigation 的主题系统
 */
function RootLayoutNav() {
  const { scheme } = useTheme();

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
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="vault/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="totp/[id]" options={{ headerShown: false }} />
        <Stack.Screen
          name="modal"
          options={{ presentation: "modal", title: "Modal" }}
        />
      </Stack>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider initialMode="system">
      <RootLayoutNav />
    </ThemeProvider>
  );
}
