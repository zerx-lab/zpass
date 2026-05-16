// 首次进入引导 —— 选择运行模式（本地 / 云端）。
//
// 对齐 desktop 的 WelcomePage/OnboardingPage：进入 app 前先做一次
// 模式选择。本地模式当前完整可用；云端模式同步能力规划中。

import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useVault, type VaultMode } from "@/contexts/vault-context";
import { IconSymbol } from "@/components/ui/icon-symbol";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

interface ModeOption {
  key: VaultMode;
  icon: string;
  title: string;
  badge?: string;
  desc: string;
  points: string[];
}

const OPTIONS: ModeOption[] = [
  {
    key: "local",
    icon: "lock.fill",
    title: "本地模式",
    badge: "推荐",
    desc: "数据仅保存在本设备，零知识、完全离线。",
    points: ["无需账户，立即可用", "条目加密存储于本机", "支持文件导入 / 导出备份"],
  },
  {
    key: "cloud",
    icon: "globe",
    title: "云端模式",
    badge: "同步即将推出",
    desc: "跨设备端到端加密同步。当前先以本地存储运行。",
    points: ["多设备自动同步（开发中）", "端到端加密，服务端不可见", "可随时在设置中切换"],
  },
];

export function OnboardingOverlay() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const { setMode } = useVault();

  const [selected, setSelected] = useState<VaultMode>("local");

  const handleContinue = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setMode(selected);
  };

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.logo, { backgroundColor: c.text }]}>
            <Text style={[styles.logoText, { color: c.bg }]}>Z</Text>
          </View>
          <Text style={[styles.title, { color: c.text }]}>选择存储模式</Text>
          <Text style={[styles.sub, { color: c.text3, fontFamily: MONO }]}>
            决定 ZPass 如何保管你的保险库
          </Text>

          <View style={styles.cards}>
            {OPTIONS.map((opt) => {
              const active = selected === opt.key;
              return (
                <TouchableOpacity
                  key={opt.key}
                  activeOpacity={0.85}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSelected(opt.key);
                  }}
                  style={[
                    styles.card,
                    {
                      backgroundColor: c.bgElev,
                      borderColor: active ? c.text : c.line,
                      borderWidth: active ? 2 : 1,
                    },
                  ]}
                >
                  <View style={styles.cardHead}>
                    <View
                      style={[
                        styles.cardIcon,
                        { backgroundColor: active ? c.text : c.bgHover },
                      ]}
                    >
                      <IconSymbol
                        name={opt.icon as any}
                        size={18}
                        color={active ? c.bg : c.text2}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.cardTitleRow}>
                        <Text style={[styles.cardTitle, { color: c.text }]}>
                          {opt.title}
                        </Text>
                        {opt.badge && (
                          <View
                            style={[
                              styles.badge,
                              {
                                borderColor:
                                  opt.key === "local" ? c.ok : c.info,
                                backgroundColor:
                                  (opt.key === "local" ? c.ok : c.info) + "1a",
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.badgeText,
                                {
                                  color: opt.key === "local" ? c.ok : c.info,
                                  fontFamily: MONO,
                                },
                              ]}
                            >
                              {opt.badge}
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text style={[styles.cardDesc, { color: c.text3 }]}>
                        {opt.desc}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.radio,
                        { borderColor: active ? c.text : c.line },
                      ]}
                    >
                      {active && (
                        <View style={[styles.radioDot, { backgroundColor: c.text }]} />
                      )}
                    </View>
                  </View>

                  <View style={[styles.points, { borderTopColor: c.lineSoft }]}>
                    {opt.points.map((p) => (
                      <View key={p} style={styles.pointRow}>
                        <IconSymbol
                          name="checkmark"
                          size={13}
                          color={active ? c.text2 : c.text3}
                        />
                        <Text style={[styles.pointText, { color: c.text2 }]}>
                          {p}
                        </Text>
                      </View>
                    ))}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: c.text }]}
            onPress={handleContinue}
            activeOpacity={0.85}
          >
            <Text style={[styles.btnText, { color: c.bg }]}>
              进入 ZPass
            </Text>
          </TouchableOpacity>
          <Text style={[styles.footerHint, { color: c.text4 }]}>
            可随时在「我的 → 数据」中切换模式
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 1000 },
  scroll: { paddingHorizontal: 24, paddingTop: 24, alignItems: "center" },

  logo: {
    width: 52,
    height: 52,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  logoText: { fontSize: 26, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  sub: { fontSize: 12, marginTop: 6, marginBottom: 24 },

  cards: { width: "100%", gap: 12 },
  card: { borderRadius: 14, padding: 16 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: "600" },
  badge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeText: { fontSize: 9, fontWeight: "600" },
  cardDesc: { fontSize: 12, marginTop: 3, lineHeight: 17 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },

  points: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 7,
  },
  pointRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pointText: { fontSize: 12.5 },

  footer: { paddingHorizontal: 24, paddingTop: 12, gap: 10 },
  btn: {
    height: 50,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { fontSize: 15, fontWeight: "700" },
  footerHint: { fontSize: 11, textAlign: "center" },
});
