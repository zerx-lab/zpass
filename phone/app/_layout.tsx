import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
} from "@react-navigation/native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";

import { Colors } from "@/constants/theme";
import { ThemeProvider, useTheme } from "@/contexts/theme-context";
import { VaultProvider, useVault } from "@/contexts/vault-context";
import { LockOverlay } from "@/components/lock-overlay";
import { OnboardingOverlay } from "@/components/onboarding-overlay";
import { DialogHost } from "@/components/ui/dialog";

export const unstable_settings = {
  anchor: "(tabs)",
};

/**
 * 启动期间的品牌占位：
 *   - splash 退场到 vault 状态探测完成之间会有 1 帧空窗，
 *     这里渲染与 onboarding/lock 一致的 ZPass 方块，避免黑屏闪烁
 *     和"丑陋的纯色 splash 突然消失"的撕裂感。
 *   - 不读 vault context（hydrated 之前 vault 不可用），完全静态。
 */
function BootSplash({ scheme }: { scheme: "dark" | "light" }) {
  const c = Colors[scheme];
  return (
    <View style={[bootStyles.root, { backgroundColor: c.bg }]}>
      <View style={[bootStyles.logo, { backgroundColor: c.text }]}>
        <Text style={[bootStyles.logoText, { color: c.bg }]}>Z</Text>
      </View>
    </View>
  );
}

const bootStyles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontSize: 32, fontWeight: "700", letterSpacing: -0.5 },
});

/**
 * 内层组件：消费 ThemeContext / VaultContext，
 *   - 首次状态探测未完成 → 品牌占位避免闪烁
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
    return <BootSplash scheme={scheme} />;
  }

  return (
    <NavThemeProvider value={navTheme}>
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: Colors[scheme].bg },
          // 全局过渡：通用页面用 default（保留方向感）
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="sync" options={{ headerShown: false }} />
        <Stack.Screen name="sync-host" options={{ headerShown: false }} />
        <Stack.Screen name="sync-conflicts" options={{ headerShown: false }} />
        <Stack.Screen name="vault/list" options={{ headerShown: false }} />
        <Stack.Screen name="vault/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="totp/index" options={{ headerShown: false }} />
        <Stack.Screen name="totp/[id]" options={{ headerShown: false }} />
        <Stack.Screen
          name="item/[id]"
          options={{
            headerShown: false,
            // 新建/编辑过渡：纯 fade，最短可感知动画
            // animation 透传到 react-native-screens；Android/iOS 都支持
            presentation: "transparentModal",
            animation: "fade",
            animationDuration: 180,
            // iOS 上 transparentModal 默认背景透明，强制对齐 bg 避免穿透看到下层
            contentStyle: { backgroundColor: Colors[scheme].bg },
            // 安卓侧滑返回（与 modal presentation 一致）
            gestureEnabled: Platform.OS === "ios",
          }}
        />
      </Stack>
      {!initialized ? <OnboardingOverlay /> : locked ? <LockOverlay /> : null}
      <DialogHost />
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider initialMode="system">
        <VaultProvider>
          <RootLayoutNav />
        </VaultProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
