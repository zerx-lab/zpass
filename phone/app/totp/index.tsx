// 验证器 —— 实时验证码列表页（参考 harmony Authenticator）
//
// 列出当前激活空间内所有「含 TOTP」的条目（独立 totp + 携带 totp 的 login），
// 每行展示实时验证码 + 倒计时环。点按复制当前码（30s 后自清剪贴板），
// 长按进 totp/[id] 详情大屏。
//
// 实时刷新：单个 setInterval 每秒驱动 tick 状态自增，整页重渲重算行内
// code / remaining；各条 OtpMeta 在 items 变化时解析一次并缓存。

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { View, Text, ScrollView, StyleSheet, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Radius, Spacing, Type, type ColorPalette } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { IconButton, PressableScale } from "@/components/ui/primitives";
import { toast } from "@/components/ui/dialog";
import { useVault } from "@/contexts/vault-context";
import { itemHasTotp, type VaultItem } from "@/data/vault";
import { faviconColor, faviconInitials } from "@/lib/format";
import {
  computeOtp,
  formatTotpCode,
  otpRemaining,
  resolveOtpMeta,
  type OtpMeta,
} from "@/lib/totp";
import { copyEphemeral } from "@/lib/clipboard";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

interface AuthEntry {
  item: VaultItem;
  meta: OtpMeta;
}

function extractSecret(it: VaultItem): string | undefined {
  if (it.type === "login") return it.totp;
  if (it.type === "totp") return it.secret;
  return undefined;
}

function subtitleOf(it: VaultItem, meta: OtpMeta): string {
  if (it.type === "login") return it.username || "登录凭据";
  if (it.type === "totp")
    return it.account || meta.account || it.issuer || meta.issuer || "验证器";
  return "验证器";
}

export default function AuthenticatorScreen() {
  const { scheme, colors: c } = useTheme();
  const { items } = useVault();

  // 每秒 +1，驱动行内实时码 / 倒计时重渲
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // items 变化时解析一次 OtpMeta 并缓存
  const entries = useMemo<AuthEntry[]>(() => {
    const list: AuthEntry[] = [];
    for (const it of items) {
      if (!itemHasTotp(it)) continue;
      const secret = extractSecret(it);
      if (!secret) continue;
      const meta = resolveOtpMeta(secret);
      if (!meta) continue;
      list.push({ item: it, meta });
    }
    return list;
  }, [items]);

  const onCopy = useCallback(async (e: AuthEntry) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await copyEphemeral(computeOtp(e.meta));
    toast.show("验证码已复制");
  }, []);

  const onDetail = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/totp/${id}` as any);
  }, []);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={["top"]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />

      {/* 顶栏：返回 + 标题 */}
      <View style={styles.nav}>
        <IconButton
          icon="chevron.left"
          size={36}
          iconSize={22}
          variant="ghost"
          onPress={() => router.back()}
        />
        <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
          验证器
        </Text>
        <View style={{ width: 36 }} />
      </View>

      {entries.length === 0 ? (
        <View style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: c.bgElev }]}>
            <IconSymbol name="lock.shield.fill" size={28} color={c.text3} />
          </View>
          <Text style={[styles.emptyTitle, { color: c.text }]}>没有验证码</Text>
          <Text style={[styles.emptyDesc, { color: c.text3 }]}>
            在登录条目里添加 TOTP 密钥，或新建验证器条目
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {entries.map((e) => (
            <AuthRow
              key={e.item.id}
              entry={e}
              c={c}
              onPress={() => onCopy(e)}
              onLongPress={() => onDetail(e.item.id)}
            />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function AuthRow({
  entry,
  c,
  onPress,
  onLongPress,
}: {
  entry: AuthEntry;
  c: ColorPalette;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { item, meta } = entry;
  const code = computeOtp(meta);
  const remaining = meta.type === "hotp" ? meta.period : otpRemaining(meta);
  const urgent = meta.type !== "hotp" && remaining <= 5;

  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      scale={0.99}
      haptic="none"
      pressedBg={c.bgHover}
      style={[styles.row, { backgroundColor: c.bgElev }]}
    >
      <View style={[styles.favicon, { backgroundColor: faviconColor(item.name) }]}>
        <Text style={styles.faviconText} numberOfLines={1}>
          {faviconInitials(item.name)}
        </Text>
      </View>

      <View style={styles.rowMid}>
        <Text style={[styles.rowName, { color: c.text }]} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={[styles.rowSub, { color: c.text3 }]} numberOfLines={1}>
          {subtitleOf(item, meta)}
        </Text>
      </View>

      <Text
        style={[
          styles.code,
          { color: urgent ? c.danger : c.text, fontFamily: MONO },
        ]}
      >
        {formatTotpCode(code)}
      </Text>

      {meta.type !== "hotp" && (
        <View
          style={[
            styles.ring,
            { borderColor: urgent ? c.danger : c.info },
          ]}
        >
          <Text
            style={[
              styles.ringText,
              { color: urgent ? c.danger : c.text3, fontFamily: MONO },
            ]}
          >
            {remaining}
          </Text>
        </View>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  /* Nav */
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.sm,
  },
  navTitle: { ...Type.title, flex: 1, marginLeft: Spacing.xs },

  /* List */
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxxl,
    gap: Spacing.md,
  },

  /* Row */
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.xl,
  },
  favicon: {
    width: 40,
    height: 40,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  faviconText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  rowMid: { flex: 1, gap: 2, minWidth: 0 },
  rowName: { ...Type.bodyEmph },
  rowSub: { ...Type.footnote },
  code: {
    ...Type.title,
    fontWeight: "500",
    letterSpacing: 1,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  ring: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  ringText: { ...Type.caption, fontVariant: ["tabular-nums"] },

  /* Empty */
  empty: {
    flex: 1,
    paddingTop: 80,
    paddingHorizontal: Spacing.xl,
    alignItems: "center",
    gap: Spacing.sm,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.xl,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.sm,
  },
  emptyTitle: { ...Type.title2 },
  emptyDesc: { ...Type.footnote, textAlign: "center" },
});
