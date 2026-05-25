import React, { useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SpaceAvatar } from "@/components/space-avatar";
import { useVault } from "@/contexts/vault-context";
import type { VaultItem, VaultItemType } from "@/data/vault";
import {
  faviconColor,
  faviconInitials,
  itemSubtitle,
  itemSearchText,
  relativeTime,
} from "@/lib/format";

type FilterKey = "all" | "fav" | VaultItemType;

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "fav", label: "收藏" },
  { key: "login", label: "登录" },
  { key: "totp", label: "验证码" },
  { key: "card", label: "卡片" },
  { key: "note", label: "笔记" },
  { key: "identity", label: "身份" },
  { key: "ssh", label: "SSH" },
  { key: "passkey", label: "密钥" },
];

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

function strengthColor(s: number, c: (typeof Colors)["dark"]) {
  if (s >= 80) return c.ok;
  if (s >= 50) return c.warn;
  return c.danger;
}

function Favicon({ item }: { item: VaultItem }) {
  return (
    <View style={[styles.favicon, { backgroundColor: faviconColor(item.name) }]}>
      <Text style={styles.faviconText} numberOfLines={1}>
        {faviconInitials(item.name)}
      </Text>
    </View>
  );
}

function VaultRow({
  item,
  c,
  isLast,
}: {
  item: VaultItem;
  c: (typeof Colors)["dark"];
  isLast: boolean;
}) {
  const onPress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/vault/${item.id}` as any);
  }, [item.id]);

  const isLogin = item.type === "login";
  const strength = isLogin ? item.strength : undefined;
  const hasTotp = isLogin && !!item.totp;
  const breached = isLogin && !!item.breached;

  return (
    <TouchableOpacity
      activeOpacity={0.6}
      onPress={onPress}
      style={[
        styles.row,
        { backgroundColor: c.bg, borderBottomColor: isLast ? "transparent" : c.lineSoft },
      ]}
    >
      <Favicon item={item} />

      <View style={styles.rowMid}>
        <View style={styles.rowNameLine}>
          <Text
            style={[styles.rowName, { color: c.text }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {item.name}
          </Text>
          {item.favorite && (
            <IconSymbol name="star.fill" size={11} color="#f5c518" />
          )}
          {hasTotp && (
            <View style={[styles.pill, { borderColor: c.info, backgroundColor: c.info + "18" }]}>
              <Text style={[styles.pillText, { color: c.info, fontFamily: MONO }]}>
                2FA
              </Text>
            </View>
          )}
          {breached && (
            <View style={[styles.pill, { borderColor: c.danger, backgroundColor: c.danger + "18" }]}>
              <IconSymbol
                name="exclamationmark.triangle.fill"
                size={11}
                color={c.danger}
              />
            </View>
          )}
        </View>
        <Text
          style={[styles.rowSub, { color: c.text3, fontFamily: MONO }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {itemSubtitle(item)}
        </Text>
      </View>

      <View style={styles.rowRight}>
        <Text style={[styles.rowTime, { color: c.text3, fontFamily: MONO }]}>
          {relativeTime(item.modified)}
        </Text>
        {strength !== undefined && (
          <View style={styles.barWrap}>
            <View style={[styles.barTrack, { backgroundColor: c.lineSoft }]}>
              <View
                style={[
                  styles.barFill,
                  {
                    width: `${strength}%` as any,
                    backgroundColor: strengthColor(strength, c),
                  },
                ]}
              />
            </View>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

export default function VaultScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const { items, activeSpace } = useVault();

  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");

  const sorted = useMemo(
    () => [...items].sort((a, b) => b.modified - a.modified),
    [items],
  );

  const filtered = useMemo(() => {
    let list = sorted;
    if (activeFilter === "fav") list = list.filter((i) => i.favorite);
    else if (activeFilter !== "all")
      list = list.filter((i) => i.type === activeFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((i) => itemSearchText(i).includes(q));
    }
    return list;
  }, [sorted, search, activeFilter]);

  const counts = useMemo(() => {
    const result: Record<string, number> = {
      all: items.length,
      fav: items.filter((i) => i.favorite).length,
    };
    for (const t of [
      "login",
      "totp",
      "card",
      "note",
      "identity",
      "ssh",
      "passkey",
    ]) {
      result[t] = items.filter((i) => i.type === t).length;
    }
    return result;
  }, [items]);

  const renderItem = useCallback(
    ({ item, index }: { item: VaultItem; index: number }) => (
      <VaultRow item={item} c={c} isLast={index === filtered.length - 1} />
    ),
    [c, filtered.length],
  );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={["top"]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />

      <View style={[styles.header, { borderBottomColor: c.lineSoft }]}>
        <View style={styles.headerLeft}>
          <SpaceAvatar
            space={activeSpace}
            size={26}
            background={c.text}
            foreground={c.bg}
            fontSize={13}
            borderRadius={6}
          />
          <Text style={[styles.appName, { color: c.text }]} numberOfLines={1}>
            {activeSpace?.name ?? "ZPass"}
          </Text>
        </View>
        <View style={[styles.countBadge, { borderColor: c.line }]}>
          <Text style={[styles.countText, { color: c.text3, fontFamily: MONO }]}>
            {filtered.length}/{items.length}
          </Text>
        </View>
      </View>

      <View style={{ flexShrink: 0, flexGrow: 0 }}>
        <View style={[styles.searchRow, { backgroundColor: c.bg }]}>
          <View style={[styles.searchBox, { backgroundColor: c.bgElev, borderColor: c.line }]}>
            <IconSymbol name="magnifyingglass" size={16} color={c.text3} />
            <TextInput
              style={[styles.searchInput, { color: c.text }]}
              placeholder="搜索"
              placeholderTextColor={c.text3}
              value={search}
              onChangeText={setSearch}
              returnKeyType="search"
              clearButtonMode="while-editing"
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={{ backgroundColor: c.bg, flexGrow: 0, flexShrink: 0 }}
        >
          {FILTER_CHIPS.map((chip) => {
            const active = activeFilter === chip.key;
            const cnt = counts[chip.key] ?? 0;
            return (
              <TouchableOpacity
                key={chip.key}
                activeOpacity={0.7}
                onPress={() => {
                  Haptics.selectionAsync();
                  setActiveFilter(chip.key);
                }}
                style={[
                  styles.chip,
                  active
                    ? { backgroundColor: c.text, borderColor: c.text }
                    : { backgroundColor: "transparent", borderColor: c.line },
                ]}
              >
                <Text style={[styles.chipLabel, { color: active ? c.bg : c.text2 }]}>
                  {chip.label}
                </Text>
                <Text
                  style={[
                    styles.chipCount,
                    { color: active ? c.bg + "cc" : c.text3, fontFamily: MONO },
                  ]}
                >
                  {cnt}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={[styles.divider, { backgroundColor: c.lineSoft }]} />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        style={[styles.list, { backgroundColor: c.bg }]}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: c.text3 }]}>
              {search.trim() || activeFilter !== "all"
                ? "无匹配项"
                : "保险库为空，点击 ＋ 新建"}
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />

      <TouchableOpacity
        style={[styles.fab, { backgroundColor: c.text }]}
        activeOpacity={0.8}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.push("/item/new" as any);
        }}
      >
        <Text style={[styles.fabPlus, { color: c.bg }]}>＋</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  appName: { fontSize: 16, fontWeight: "600", letterSpacing: -0.3, flexShrink: 1 },
  countBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  countText: { fontSize: 11 },

  searchRow: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 10,
    height: 38,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
    includeFontPadding: false,
  },

  chips: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 6,
    flexDirection: "row",
    alignItems: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 2,
  },
  chipLabel: { fontSize: 12, fontWeight: "500" },
  chipCount: { fontSize: 11 },

  divider: { height: StyleSheet.hairlineWidth },

  list: { flex: 1 },
  listContent: { paddingBottom: 100 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  favicon: {
    width: 38,
    height: 38,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  faviconText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  rowMid: { flex: 1, gap: 3, minWidth: 0 },
  rowNameLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 1,
  },
  rowName: { fontSize: 14, fontWeight: "500", flexShrink: 1 },
  pill: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    flexShrink: 0,
  },
  pillText: { fontSize: 9, fontWeight: "600", lineHeight: 13 },
  rowSub: { fontSize: 11 },
  rowRight: { alignItems: "flex-end", gap: 5, flexShrink: 0, minWidth: 52 },
  rowTime: { fontSize: 10 },
  barWrap: { width: 36 },
  barTrack: { height: 3, borderRadius: 2, overflow: "hidden" },
  barFill: { height: 3, borderRadius: 2 },

  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  fabPlus: { fontSize: 26, lineHeight: 30, marginTop: -1 },

  empty: { paddingVertical: 48, alignItems: "center" },
  emptyText: { fontSize: 14 },
});
