import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Animated,
  Easing,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import * as Haptics from "expo-haptics";

import { useColorScheme } from "@/hooks/use-color-scheme";
import { Colors } from "@/constants/theme";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { TOTP_ITEMS, formatCode } from "@/app/(tabs)/totp";

// ─── 常量 ────────────────────────────────────────────────────────────────────

const PERIOD = 30; // TOTP 周期（秒）

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getElapsed(): number {
  return Math.floor(Date.now() / 1000) % PERIOD;
}

function getRemaining(): number {
  return PERIOD - getElapsed();
}

// ─── 组件 ────────────────────────────────────────────────────────────────────

export default function TotpDetailScreen() {
  const scheme = useColorScheme() ?? "dark";
  const C = Colors[scheme];

  const { id } = useLocalSearchParams<{ id: string }>();

  // 找到对应账户；找不到则 fallback 到第一个，避免崩溃
  const account = useMemo(
    () => TOTP_ITEMS.find((t) => t.id === id) ?? TOTP_ITEMS[0],
    [id],
  );

  const [remaining, setRemaining] = useState<number>(getRemaining());
  const isUrgent = remaining <= 5;

  // 进度动画（0 = 周期起点，1 = 周期末尾）
  const progressAnim = useRef(
    new Animated.Value(getElapsed() / PERIOD),
  ).current;
  const progressAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  // ── 倒计时 ──
  useEffect(() => {
    function tick() {
      const rem = getRemaining();
      const elapsed = getElapsed();
      setRemaining(rem);

      progressAnimRef.current?.stop();

      if (elapsed === 0) {
        progressAnim.setValue(0);
      } else {
        progressAnim.setValue(elapsed / PERIOD);
      }

      const anim = Animated.timing(progressAnim, {
        toValue: 1,
        duration: rem * 1000,
        easing: Easing.linear,
        useNativeDriver: false,
      });
      progressAnimRef.current = anim;
      anim.start();
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
      progressAnimRef.current?.stop();
    };
  }, [progressAnim]);

  // ── 复制 ──
  const handleCopy = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      "已复制",
      `${account.name} 的验证码 ${formatCode(account.secret)} 已复制到剪贴板`,
    );
  }, [account]);

  const handleBack = useCallback(() => {
    router.back();
  }, []);

  // ── 动态颜色 ──
  const codeColor = isUrgent ? C.danger : C.text;
  const barColor = isUrgent ? C.danger : C.info;

  // ── 进度条宽度（百分比） ──
  const barWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top", "left", "right"]}>
      {/* ── NavBar ── */}
      <View style={[styles.navBar, { borderBottomColor: C.lineSoft }]}>
        <TouchableOpacity
          style={styles.navBtn}
          onPress={handleBack}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.6}
        >
          <IconSymbol name="chevron.left" size={22} color={C.text} />
        </TouchableOpacity>
        <Text style={[styles.navTitle, { color: C.text }]} numberOfLines={1}>
          验证码
        </Text>
        <TouchableOpacity
          style={styles.navBtn}
          onPress={() => Alert.alert("更多操作", "编辑 / 删除 / 导出")}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.6}
        >
          <IconSymbol name="ellipsis" size={20} color={C.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── 账户 Chip ── */}
        <View
          style={[
            styles.chip,
            { borderColor: C.line, backgroundColor: C.bgElev },
          ]}
        >
          <View style={[styles.chipFavicon, { backgroundColor: account.color }]}>
            <Text style={styles.chipFaviconText}>
              {account.initials.slice(0, 1)}
            </Text>
          </View>
          <Text style={[styles.chipName, { color: C.text }]}>
            {account.name}
          </Text>
          <Text style={[styles.chipDot, { color: C.text3 }]}> · </Text>
          <Text
            style={[styles.chipUsername, { color: C.text3 }]}
            numberOfLines={1}
          >
            {account.username}
          </Text>
        </View>

        {/* ── 大号验证码 ── */}
        <Text style={[styles.codeText, { color: codeColor }]}>
          {formatCode(account.secret)}
        </Text>

        {/* ── 倒计时说明 ── */}
        <Text style={[styles.expiresText, { color: C.text3 }]}>
          {isUrgent ? "即将刷新 · " : "有效期 · "}
          {remaining}s
        </Text>

        {/* ── 进度条 ── */}
        <View style={styles.progressOuter}>
          <View style={[styles.progressTrack, { backgroundColor: C.bgElev2 }]}>
            <Animated.View
              style={[
                styles.progressBar,
                { width: barWidth, backgroundColor: barColor },
              ]}
            />
          </View>
        </View>

        {/* ── 复制按钮 ── */}
        <TouchableOpacity
          style={[
            styles.copyBtn,
            { borderColor: C.line, backgroundColor: C.bgElev },
          ]}
          onPress={handleCopy}
          activeOpacity={0.7}
        >
          <IconSymbol name="doc.on.doc.fill" size={16} color={C.text} />
          <Text style={[styles.copyBtnText, { color: C.text }]}>
            复制验证码
          </Text>
        </TouchableOpacity>

        {/* ── 元信息卡 ── */}
        <View
          style={[
            styles.metaCard,
            { borderColor: C.line, backgroundColor: C.bgElev },
          ]}
        >
          <MetaRow label="服务" value={account.name} c={C} />
          <View style={[styles.metaDivider, { backgroundColor: C.lineSoft }]} />
          <MetaRow label="账号" value={account.username} c={C} />
          <View style={[styles.metaDivider, { backgroundColor: C.lineSoft }]} />
          <MetaRow label="算法" value="SHA-1 · 6 位 · 30s" c={C} mono />
        </View>

        {/* ── 提示 ── */}
        <Text style={[styles.hint, { color: C.text3 }]}>
          验证码每 30 秒自动刷新 · 请在剩余时间内使用
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── 子组件：元信息行 ───────────────────────────────────────────────────────

function MetaRow({
  label,
  value,
  c,
  mono,
}: {
  label: string;
  value: string;
  c: (typeof Colors)["dark"];
  mono?: boolean;
}) {
  return (
    <View style={styles.metaRow}>
      <Text style={[styles.metaLabel, { color: c.text3 }]}>{label}</Text>
      <Text
        style={[
          styles.metaValue,
          { color: c.text },
          mono && { fontFamily: MONO, fontSize: 13 },
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },

  // NavBar
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  navTitle: {
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
    textAlign: "center",
  },

  // Scroll
  scrollContent: {
    paddingHorizontal: 28,
    paddingTop: 32,
    paddingBottom: 48,
    alignItems: "center",
  },

  // Chip
  chip: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: "100%",
    marginBottom: 36,
  },
  chipFavicon: {
    width: 22,
    height: 22,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 7,
  },
  chipFaviconText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#ffffff",
    includeFontPadding: false,
  },
  chipName: {
    fontSize: 13,
    fontWeight: "500",
  },
  chipDot: {
    fontSize: 13,
  },
  chipUsername: {
    fontSize: 12,
    flexShrink: 1,
  },

  // 大验证码
  codeText: {
    fontSize: 56,
    fontWeight: "300",
    letterSpacing: 4,
    fontVariant: ["tabular-nums"],
    fontFamily: MONO,
    includeFontPadding: false,
    marginBottom: 10,
    textAlign: "center",
  },
  expiresText: {
    fontSize: 13,
    marginBottom: 20,
  },

  // 进度条
  progressOuter: {
    width: "100%",
    marginBottom: 32,
  },
  progressTrack: {
    width: "100%",
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressBar: {
    height: "100%",
    borderRadius: 2,
  },

  // 复制按钮
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
    marginBottom: 32,
  },
  copyBtnText: {
    fontSize: 15,
    fontWeight: "500",
  },

  // 元信息卡
  metaCard: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    gap: 12,
  },
  metaLabel: {
    fontSize: 13,
  },
  metaValue: {
    fontSize: 14,
    fontWeight: "500",
    flexShrink: 1,
    textAlign: "right",
  },
  metaDivider: {
    height: StyleSheet.hairlineWidth,
    width: "100%",
  },

  // 提示
  hint: {
    fontSize: 11,
    textAlign: "center",
    paddingHorizontal: 16,
  },
});
