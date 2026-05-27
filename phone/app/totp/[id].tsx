import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Animated,
  Easing,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/contexts/theme-context";
import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import {
  Button,
  IconButton,
} from "@/components/ui/primitives";
import { useVault } from "@/contexts/vault-context";
import { faviconColor, faviconInitials } from "@/lib/format";
import {
  computeOtp,
  formatTotpCode,
  otpElapsed,
  otpRemaining,
  resolveOtpMeta,
  type OtpMeta,
} from "@/lib/totp";
import { copyEphemeral } from "@/lib/clipboard";
import type { ColorPalette } from "@/constants/theme";

const MONO = Fonts?.mono ?? "monospace";

export default function TotpDetailScreen() {
  const { colors: C } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getItem } = useVault();

  const item = getItem(id);
  const secret =
    item?.type === "login"
      ? item.totp
      : item?.type === "totp"
        ? item.secret
        : undefined;

  const meta: OtpMeta | null = useMemo(
    () => (secret ? resolveOtpMeta(secret) : null),
    [secret],
  );

  const usernameDisplay =
    item?.type === "login"
      ? item.username
      : item?.type === "totp"
        ? meta?.account ||
          item.account ||
          meta?.issuer ||
          item.issuer ||
          ""
        : "";

  const period = meta?.period && meta.type !== "hotp" ? meta.period : 30;
  const digits = meta?.digits ?? 6;

  const [remaining, setRemaining] = useState(() =>
    meta && meta.type !== "hotp" ? otpRemaining(meta) : period,
  );
  const [periodKey, setPeriodKey] = useState(() =>
    meta && meta.type !== "hotp"
      ? Math.floor(Date.now() / 1000 / period)
      : 0,
  );
  const isUrgent = meta?.type !== "hotp" && remaining <= 5;

  const progressAnim = useRef(
    new Animated.Value(
      meta && meta.type !== "hotp" ? otpElapsed(meta) / period : 0,
    ),
  ).current;
  const progressAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (!meta || meta.type === "hotp") return;
    function tick() {
      const rem = otpRemaining(meta!);
      const elapsed = otpElapsed(meta!);
      setRemaining(rem);
      setPeriodKey(Math.floor(Date.now() / 1000 / period));

      progressAnimRef.current?.stop();
      progressAnim.setValue(elapsed === 0 ? 0 : elapsed / period);
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
  }, [progressAnim, meta, period]);

  const code = useMemo(
    () => (meta ? computeOtp(meta) : "-".repeat(digits)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, periodKey],
  );

  const algoLine = meta
    ? meta.type === "hotp"
      ? `${meta.algorithm} · ${meta.digits} 位 · 计数器 ${meta.counter}`
      : meta.type === "steam"
        ? `Steam Guard · ${meta.algorithm} · ${meta.digits} 位 · ${meta.period}s`
        : `${meta.algorithm} · ${meta.digits} 位 · ${meta.period}s`
    : "SHA-1 · 6 位 · 30s";

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
        <NavBar c={C} title="验证码" onBack={() => router.back()} />
        <View style={styles.notFound}>
          <Text style={{ color: C.text3, ...Type.body }}>
            该条目没有 TOTP 验证码
          </Text>
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
      <NavBar
        c={C}
        title="验证码"
        onBack={() => router.back()}
        onEdit={() => router.push(`/item/${item.id}` as any)}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* 服务标签 */}
        <View style={[styles.chip, { backgroundColor: C.bgElev }]}>
          <View
            style={[styles.chipFavicon, { backgroundColor: faviconColor(item.name) }]}
          >
            <Text style={styles.chipFaviconText}>
              {faviconInitials(item.name)}
            </Text>
          </View>
          <Text style={[styles.chipName, { color: C.text }]} numberOfLines={1}>
            {item.name}
          </Text>
          {usernameDisplay ? (
            <Text style={[styles.chipUsername, { color: C.text3 }]} numberOfLines={1}>
              {usernameDisplay}
            </Text>
          ) : null}
        </View>

        {/* 大号代码 */}
        <Text
          style={[styles.codeText, { color: codeColor, fontFamily: MONO }]}
        >
          {formatTotpCode(code)}
        </Text>

        {meta?.type === "hotp" ? (
          <Text style={[styles.expiresText, { color: C.text3 }]}>
            HOTP · 计数器 {meta.counter}
          </Text>
        ) : (
          <>
            <Text style={[styles.expiresText, { color: C.text3 }]}>
              {isUrgent ? "即将刷新 · " : "有效期 · "}
              {remaining}s
            </Text>
            <View style={styles.progressOuter}>
              <View
                style={[styles.progressTrack, { backgroundColor: C.bgActive }]}
              >
                <Animated.View
                  style={[
                    styles.progressBar,
                    { width: barWidth, backgroundColor: barColor },
                  ]}
                />
              </View>
            </View>
          </>
        )}

        <Button
          label="复制验证码"
          icon="doc.on.doc.fill"
          variant="primary"
          size="lg"
          onPress={handleCopy}
          style={{ marginBottom: Spacing.xxl }}
        />

        {/* 元信息卡 */}
        <View style={[styles.metaCard, { backgroundColor: C.bgElev }]}>
          <MetaRow label="服务" value={item.name} c={C} />
          {usernameDisplay ? (
            <>
              <View
                style={[styles.metaDivider, { backgroundColor: C.lineSoft }]}
              />
              <MetaRow label="账号" value={usernameDisplay} c={C} />
            </>
          ) : null}
          <View
            style={[styles.metaDivider, { backgroundColor: C.lineSoft }]}
          />
          <MetaRow label="算法" value={algoLine} c={C} mono />
        </View>

        <Text style={[styles.hint, { color: C.text3 }]}>
          {meta?.type === "hotp"
            ? "HOTP 按计数器递增 · 复制后 30 秒自动清空剪贴板"
            : `验证码每 ${period} 秒自动刷新 · 复制后 30 秒自动清空剪贴板`}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function NavBar({
  c,
  title,
  onBack,
  onEdit,
}: {
  c: ColorPalette;
  title: string;
  onBack: () => void;
  onEdit?: () => void;
}) {
  return (
    <View style={styles.navBar}>
      <IconButton
        icon="chevron.left"
        size={36}
        iconSize={20}
        variant="ghost"
        onPress={onBack}
      />
      <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
        {title}
      </Text>
      {onEdit ? (
        <IconButton
          icon="square.and.pencil"
          size={36}
          iconSize={18}
          variant="ghost"
          onPress={onEdit}
        />
      ) : (
        <View style={{ width: 36 }} />
      )}
    </View>
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
  c: ColorPalette;
  mono?: boolean;
}) {
  return (
    <View style={styles.metaRow}>
      <Text style={[styles.metaLabel, { color: c.text3 }]}>{label}</Text>
      <Text
        style={[
          styles.metaValue,
          { color: c.text },
          mono && { fontFamily: MONO, ...Type.subhead },
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
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
  },
  navTitle: { ...Type.title2, flex: 1, textAlign: "center" },

  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },

  scrollContent: {
    paddingHorizontal: Spacing.xl + 4,
    paddingTop: Spacing.xxxl,
    paddingBottom: Spacing.xxxl + Spacing.lg,
    alignItems: "center",
  },

  chip: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    maxWidth: "100%",
    gap: Spacing.sm,
    marginBottom: Spacing.xxxl,
  },
  chipFavicon: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  chipFaviconText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#ffffff",
    includeFontPadding: false,
  },
  chipName: { ...Type.subhead, fontWeight: "600", flexShrink: 1 },
  chipUsername: { ...Type.footnote, flexShrink: 1 },

  codeText: {
    fontSize: 60,
    fontWeight: "300",
    letterSpacing: 4,
    fontVariant: ["tabular-nums"],
    includeFontPadding: false,
    marginBottom: Spacing.sm,
    textAlign: "center",
  },
  expiresText: { ...Type.subhead, marginBottom: Spacing.lg },

  progressOuter: { width: "100%", marginBottom: Spacing.xxl },
  progressTrack: {
    width: "100%",
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressBar: { height: "100%", borderRadius: 2 },

  metaCard: {
    width: "100%",
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: Spacing.md,
    gap: Spacing.md,
  },
  metaLabel: { ...Type.subhead },
  metaValue: {
    ...Type.body,
    fontWeight: "500",
    flexShrink: 1,
    textAlign: "right",
  },
  metaDivider: { height: StyleSheet.hairlineWidth, width: "100%" },

  hint: { ...Type.footnote, textAlign: "center", paddingHorizontal: Spacing.lg },
});
