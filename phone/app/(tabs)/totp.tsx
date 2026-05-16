import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  Animated,
  Easing,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";

import { useColorScheme } from "@/hooks/use-color-scheme";
import { Colors } from "@/constants/theme";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useVault } from "@/contexts/vault-context";
import type { LoginItem } from "@/data/vault";
import { faviconColor, faviconInitials } from "@/lib/format";
import {
  generateTotp,
  formatTotpCode,
  totpElapsed,
  totpRemaining,
  TOTP_PERIOD,
} from "@/lib/totp";

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

/** 一行 TOTP 账户：从带 totp 字段的 login 条目派生 */
interface TotpRow {
  id: string;
  name: string;
  username: string;
  secret: string;
}

function TotpRowView({
  row,
  code,
  C,
  isUrgent,
  remaining,
  progressAnim,
  onPress,
}: {
  row: TotpRow;
  code: string;
  C: (typeof Colors)["dark"];
  isUrgent: boolean;
  remaining: number;
  progressAnim: Animated.Value;
  onPress: (row: TotpRow) => void;
}) {
  const codeColor = isUrgent ? C.danger : C.text;
  const ringColor = isUrgent ? C.danger : C.info;

  return (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: C.lineSoft }]}
      onPress={() => onPress(row)}
      activeOpacity={0.6}
    >
      <View style={[styles.favicon, { backgroundColor: faviconColor(row.name) }]}>
        <Text style={styles.faviconText}>{faviconInitials(row.name)}</Text>
      </View>

      <View style={styles.info}>
        <Text style={[styles.name, { color: C.text }]} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={[styles.username, { color: C.text3 }]} numberOfLines={1}>
          {row.username}
        </Text>
      </View>

      <View style={styles.right}>
        <Text style={[styles.code, { color: codeColor }]} numberOfLines={1}>
          {formatTotpCode(code)}
        </Text>
        <View style={styles.countdownWrap}>
          <View style={[styles.miniTrack, { backgroundColor: C.bgElev2 }]}>
            <Animated.View
              style={[
                styles.miniBar,
                {
                  backgroundColor: ringColor,
                  width: progressAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["100%", "0%"],
                  }),
                },
              ]}
            />
          </View>
          <Text style={[styles.countdownText, { color: C.text3 }]}>
            {remaining}s
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function TotpScreen() {
  const scheme = useColorScheme() ?? "dark";
  const C = Colors[scheme];
  const { items } = useVault();

  const [query, setQuery] = useState("");
  const [remaining, setRemaining] = useState(totpRemaining());
  const [periodKey, setPeriodKey] = useState(() =>
    Math.floor(Date.now() / 1000 / TOTP_PERIOD),
  );

  const progressAnim = useRef(
    new Animated.Value(totpElapsed() / TOTP_PERIOD),
  ).current;
  const progressAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  const isUrgent = remaining <= 5;

  // 倒计时 + 周期翻转检测
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
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
      progressAnimRef.current?.stop();
    };
  }, [progressAnim]);

  // 从保险库派生 TOTP 行
  const rows = useMemo<TotpRow[]>(() => {
    return items
      .filter((i): i is LoginItem => i.type === "login" && !!i.totp)
      .map((i) => ({
        id: i.id,
        name: i.name,
        username: i.username,
        secret: i.totp as string,
      }));
  }, [items]);

  // 当前周期所有验证码（周期翻转时重算）
  const codes = useMemo(() => {
    const map: Record<string, string> = {};
    for (const r of rows) map[r.id] = generateTotp(r.secret);
    return map;
    // periodKey 变化即周期翻转，触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, periodKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.username.toLowerCase().includes(q),
    );
  }, [query, rows]);

  const handleOpen = useCallback((row: TotpRow) => {
    Haptics.selectionAsync();
    router.push(`/totp/${row.id}` as any);
  }, []);

  const headerBarWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]}>
      <View style={[styles.header, { borderBottomColor: C.lineSoft }]}>
        <Text style={[styles.headerTitle, { color: C.text }]}>验证码</Text>
        <TouchableOpacity
          style={[styles.addBtn, { borderColor: C.line }]}
          onPress={() => router.push("/item/new?type=login" as any)}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconSymbol name="plus" size={18} color={C.text} />
        </TouchableOpacity>
      </View>

      <View style={[styles.globalTrack, { backgroundColor: C.bgElev2 }]}>
        <Animated.View
          style={[
            styles.globalBar,
            { width: headerBarWidth, backgroundColor: isUrgent ? C.danger : C.info },
          ]}
        />
      </View>

      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, { borderColor: C.line, backgroundColor: C.bgElev }]}>
          <IconSymbol name="magnifyingglass" size={16} color={C.text3} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索验证码"
            placeholderTextColor={C.text3}
            style={[styles.searchInput, { color: C.text }]}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TotpRowView
            row={item}
            code={codes[item.id] ?? "------"}
            C={C}
            isUrgent={isUrgent}
            remaining={remaining}
            progressAnim={progressAnim}
            onPress={handleOpen}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: C.text3 }]}>
              {query.trim()
                ? "没有匹配的验证码"
                : "暂无验证码 · 为登录条目添加 TOTP 密钥"}
            </Text>
          </View>
        }
        ListFooterComponent={
          filtered.length > 0 ? (
            <Text style={[styles.footerHint, { color: C.text3 }]}>
              点击查看大号显示与复制
            </Text>
          ) : null
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { fontSize: 22, fontWeight: "600", letterSpacing: -0.3 },
  addBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  globalTrack: { height: 2, width: "100%", overflow: "hidden" },
  globalBar: { height: "100%" },

  searchWrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 36,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    padding: 0,
    includeFontPadding: false,
  },

  listContent: { paddingTop: 4, paddingBottom: 32 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  favicon: {
    width: 38,
    height: 38,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  faviconText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#ffffff",
    includeFontPadding: false,
  },
  info: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 14, fontWeight: "500" },
  username: { fontSize: 12 },

  right: { alignItems: "flex-end", gap: 4, flexShrink: 0 },
  code: {
    fontSize: 20,
    fontWeight: "500",
    letterSpacing: 1.5,
    fontVariant: ["tabular-nums"],
    fontFamily: MONO,
    includeFontPadding: false,
  },
  countdownWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  miniTrack: {
    width: 36,
    height: 3,
    borderRadius: 1.5,
    overflow: "hidden",
  },
  miniBar: { height: "100%", borderRadius: 1.5 },
  countdownText: {
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    minWidth: 22,
    textAlign: "right",
    includeFontPadding: false,
  },

  empty: { alignItems: "center", paddingVertical: 64, paddingHorizontal: 32 },
  emptyText: { fontSize: 13, textAlign: "center" },
  footerHint: { fontSize: 11, textAlign: "center", paddingVertical: 16 },
});
