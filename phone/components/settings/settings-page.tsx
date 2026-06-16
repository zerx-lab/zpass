// 设置子页面壳 —— 顶部返回导航 + 滚动容器
//
// 「我的」拆出的二级页（应用保护 / 外观与交互 / 数据管理）统一用这个壳，
// 导航样式与 sync.tsx 对齐。

import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconButton } from "@/components/ui/primitives";

export function SettingsPage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { colors: c } = useTheme();
  const router = useRouter();

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: c.bg }]}
      edges={["top"]}
    >
      <View style={styles.nav}>
        <IconButton
          icon="chevron.left"
          size={36}
          iconSize={20}
          variant="ghost"
          onPress={() => router.back()}
        />
        <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={{ width: 36 }} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {children}
        <View style={{ height: Spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
  },
  navTitle: {
    ...Type.title2,
    flex: 1,
    textAlign: "center",
  },
  scrollContent: { paddingBottom: Spacing.lg, paddingTop: Spacing.sm },
});
