import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
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
import { useVault } from "@/contexts/vault-context";
import { faviconColor, faviconInitials } from "@/lib/format";
import {
  generateTotp,
  formatTotpCode,
  totpElapsed,
  totpRemaining,
  TOTP_PERIOD,
} from "@/lib/totp";
import { copyEphemeral } from "@/lib/clipboard";

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

export default function TotpDetailScreen() {
  const scheme = useColorScheme() ?? "dark";
  const C = Colors[scheme];
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getItem } = useVault();

  const item = getItem(id);
  // 支持两类来源：login 条目的 totp 字段，或独立 totp 条目的 secret 字段
  const secret =
    item?.type === "login"
      ? item.totp
      : item?.type === "totp"
        ? item.secret
        : undefined;
  const usernameDisplay =
    item?.type === "login"
      ? item.username
      : item?.type === "totp"
        ? item.account ?? item.issuer ?? ""
        : "";

  const [remaining, setRemaining] = useState(totpRemaining());
  const [periodKey, setPeriodKey] = useState(() =>
    Math.floor(Date.now() / 1000 / TOTP_PERIOD),
  );
  const isUrgent = remaining <= 5;

  const progressAnim = useRef(
    new Animated.Value(totpElapsed() / TOTP_PERIOD),
  ).current;
  const progressAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    function tick() {
      const rem = totpRemaining();
      const elapsed = totpElapsed();
      setRemaining(rem);
      setPeriodKey(Math.floor(Date.now() / 1000 / TOTP_PERIOD));

      progressAnimRef.current?.stop();
      progressAnim.setValue(elapsed === 0 ? 0 : elapsed / TOTP_PERIOD);
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
    const t = setInterval(tick, 1000);
    return () => {
      clearInterval(t);
      progressAnimRef.current?.stop();
    };
  }, [progressAnim]);

  const code = useMemo(
    () => (secret ? generateTotp(secret) : "------"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secret, periodKey],
  );

  const handleCopy = useCallback(async () => {
    await copyEphemeral(code);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [code]);

  const barWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  if (!item || !secret) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
        <View style={[styles.navBar, { borderBottomColor: C.lineSoft }]}>
          <TouchableOpacity style={styles.navBtn} onPress={() => router.back()}>
            <IconSymbol name="chevron.left" size={22} color={C.text} />
          </TouchableOpacity>
          <Text style={[styles.navTitle, { color: C.text }]}>验证码</Text>
          <View style={styles.navBtn} />
        </View>
        <View style={styles.notFound}>
          <Text style={{ color: C.text3 }}>该条目没有 TOTP 验证码</Text>
        </View>
      </SafeAreaView>
    );
  }

  const codeColor = isUrgent ? C.danger : C.text;
  const barColor = isUrgent ? C.danger : C.info;

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: C.bg }]}
      edges={["top", "left", "right"]}
    >
      <View style={[styles.navBar, { borderBottomColor: C.lineSoft }]}>
        <TouchableOpacity
          style={styles.navBtn}
          onPress={() => router.back()}
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
          onPress={() => router.push(`/item/${item.id}` as any)}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.6}
        >
          <IconSymbol name="square.and.pencil" size={19} color={C.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.chip, { borderColor: C.line, backgroundColor: C.bgElev }]}>
          <View style={[styles.chipFavicon, { backgroundColor: faviconColor(item.name) }]}>
            <Text style={styles.chipFaviconText}>{faviconInitials(item.name)}</Text>
          </View>
          <Text style={[styles.chipName, { color: C.text }]}>{item.name}</Text>
          {usernameDisplay ? (
            <>
              <Text style={[styles.chipDot, { color: C.text3 }]}> · </Text>
              <Text
                style={[styles.chipUsername, { color: C.text3 }]}
                numberOfLines={1}
              >
                {usernameDisplay}
              </Text>
            </>
          ) : null}
        </View>

        <Text style={[styles.codeText, { color: codeColor }]}>
          {formatTotpCode(code)}
        </Text>

        <Text style={[styles.expiresText, { color: C.text3 }]}>
          {isUrgent ? "即将刷新 · " : "有效期 · "}
          {remaining}s
        </Text>

        <View style={styles.progressOuter}>
          <View style={[styles.progressTrack, { backgroundColor: C.bgElev2 }]}>
            <Animated.View
              style={[styles.progressBar, { width: barWidth, backgroundColor: barColor }]}
            />
          </View>
        </View>

        <TouchableOpacity
          style={[styles.copyBtn, { borderColor: C.line, backgroundColor: C.bgElev }]}
          onPress={handleCopy}
          activeOpacity={0.7}
        >
          <IconSymbol name="doc.on.doc.fill" size={16} color={C.text} />
          <Text style={[styles.copyBtnText, { color: C.text }]}>复制验证码</Text>
        </TouchableOpacity>

        <View style={[styles.metaCard, { borderColor: C.line, backgroundColor: C.bgElev }]}>
          <MetaRow label="服务" value={item.name} c={C} />
          {usernameDisplay ? (
            <>
              <View style={[styles.metaDivider, { backgroundColor: C.lineSoft }]} />
              <MetaRow label="账号" value={usernameDisplay} c={C} />
            </>
          ) : null}
          <View style={[styles.metaDivider, { backgroundColor: C.lineSoft }]} />
          <MetaRow label="算法" value="SHA-1 · 6 位 · 30s" c={C} mono />
        </View>

        <Text style={[styles.hint, { color: C.text3 }]}>
          验证码每 30 秒自动刷新 · 复制后 30 秒自动清空剪贴板
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

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

const styles = StyleSheet.create({
  safe: { flex: 1 },

  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  navTitle: { fontSize: 16, fontWeight: "600", flex: 1, textAlign: "center" },

  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },

  scrollContent: {
    paddingHorizontal: 28,
    paddingTop: 32,
    paddingBottom: 48,
    alignItems: "center",
  },

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
  chipName: { fontSize: 13, fontWeight: "500" },
  chipDot: { fontSize: 13 },
  chipUsername: { fontSize: 12, flexShrink: 1 },

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
  expiresText: { fontSize: 13, marginBottom: 20 },

  progressOuter: { width: "100%", marginBottom: 32 },
  progressTrack: { width: "100%", height: 4, borderRadius: 2, overflow: "hidden" },
  progressBar: { height: "100%", borderRadius: 2 },

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
  copyBtnText: { fontSize: 15, fontWeight: "500" },

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
  metaLabel: { fontSize: 13 },
  metaValue: { fontSize: 14, fontWeight: "500", flexShrink: 1, textAlign: "right" },
  metaDivider: { height: StyleSheet.hairlineWidth, width: "100%" },

  hint: { fontSize: 11, textAlign: "center", paddingHorizontal: 16 },
});
