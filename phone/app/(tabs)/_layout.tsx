import { Tabs } from "expo-router";
import React from "react";
import { Platform } from "react-native";

import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";

export default function TabLayout() {
  const colorScheme = useColorScheme() ?? "dark";
  const c = Colors[colorScheme];

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: c.text,
        tabBarInactiveTintColor: c.text3,
        tabBarStyle: {
          backgroundColor: c.bg,
          borderTopColor: c.line,
          borderTopWidth: 1,
          height: Platform.select({ ios: 82, android: 64, default: 64 }),
          paddingBottom: Platform.select({ ios: 24, default: 8 }),
          ...Platform.select({
            ios: { shadowColor: "transparent" },
            android: { elevation: 0 },
          }),
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: "500",
          marginTop: 2,
        },
      }}
    >
      {/* ── 4 个一级 Tab ── */}
      <Tabs.Screen
        name="vault"
        options={{
          title: "密码库",
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="key.fill" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="generator"
        options={{
          title: "生成器",
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="wand.and.stars" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="security"
        options={{
          title: "安全",
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="shield.fill" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: "我的",
          tabBarIcon: ({ color, size }) => (
            <IconSymbol name="person.fill" size={size ?? 22} color={color} />
          ),
        }}
      />

      {/* ── 隐藏路由（验证码并入密码库分类） ── */}
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="explore" options={{ href: null }} />
      <Tabs.Screen name="totp" options={{ href: null }} />
    </Tabs>
  );
}
