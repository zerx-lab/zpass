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
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { IconSymbol } from "@/components/ui/icon-symbol";

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────
type ItemType = "login" | "card" | "note" | "identity" | "ssh";
type FilterKey = "all" | ItemType;

type VaultItem = {
  id: string;
  name: string;
  username: string;
  url: string;
  type: ItemType;
  strength?: number;
  totp?: boolean;
  breached?: boolean;
  tags?: string[];
  initials: string;
  color: string;
  modified: string;
};

// ─────────────────────────────────────────────────────────────
// Mock 数据
// ─────────────────────────────────────────────────────────────
export const MOCK_ITEMS: VaultItem[] = [
  {
    id: "1",
    name: "GitHub",
    username: "zero@example.com",
    url: "github.com",
    type: "login",
    strength: 94,
    totp: true,
    initials: "GH",
    color: "#1a1a2e",
    modified: "1h ago",
  },
  {
    id: "2",
    name: "Notion",
    username: "zero@notion.so",
    url: "notion.so",
    type: "login",
    strength: 67,
    breached: true,
    initials: "N",
    color: "#2c2c2c",
    modified: "3h ago",
  },
  {
    id: "3",
    name: "Linear",
    username: "zero@linear.app",
    url: "linear.app",
    type: "login",
    strength: 88,
    breached: true,
    totp: true,
    initials: "L",
    color: "#5e6ad2",
    modified: "1d ago",
  },
  {
    id: "4",
    name: "Figma",
    username: "zero@figma.com",
    url: "figma.com",
    type: "login",
    strength: 72,
    initials: "F",
    color: "#ff7262",
    modified: "2d ago",
  },
  {
    id: "5",
    name: "Vercel",
    username: "zero@vercel.com",
    url: "vercel.com",
    type: "login",
    strength: 85,
    initials: "V",
    color: "#141414",
    modified: "3d ago",
  },
  {
    id: "6",
    name: "AWS",
    username: "zero@aws.com",
    url: "aws.amazon.com",
    type: "login",
    strength: 91,
    totp: true,
    initials: "A",
    color: "#ff9900",
    modified: "5d ago",
  },
  {
    id: "7",
    name: "Cloudflare",
    username: "zero@cf.com",
    url: "cloudflare.com",
    type: "login",
    strength: 89,
    initials: "C",
    color: "#f38020",
    modified: "1w ago",
  },
  {
    id: "8",
    name: "Stripe",
    username: "zero@stripe.com",
    url: "stripe.com",
    type: "login",
    strength: 96,
    initials: "S",
    color: "#635bff",
    modified: "1w ago",
  },
  {
    id: "9",
    name: "招商银行",
    username: "6217****8801",
    url: "cmbchina.com",
    type: "card",
    initials: "招",
    color: "#c8292b",
    modified: "2w ago",
  },
  {
    id: "10",
    name: "Server SSH",
    username: "root",
    url: "192.168.1.1",
    type: "ssh",
    initials: "SSH",
    color: "#1e4d2b",
    modified: "1mo ago",
  },
];

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "login", label: "登录" },
  { key: "card", label: "卡片" },
  { key: "note", label: "笔记" },
  { key: "ssh", label: "SSH" },
];

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

// ─────────────────────────────────────────────────────────────
// 强度颜色
// ─────────────────────────────────────────────────────────────
function strengthColor(s: number, c: (typeof Colors)["dark"]) {
  if (s >= 80) return c.ok;
  if (s >= 50) return c.warn;
  return c.danger;
}

// ─────────────────────────────────────────────────────────────
// Favicon 占位
// ─────────────────────────────────────────────────────────────
function Favicon({ item }: { item: VaultItem }) {
  return (
    <View style={[styles.favicon, { backgroundColor: item.color }]}>
      <Text style={styles.faviconText} numberOfLines={1}>
        {item.initials}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// 单行条目
// ─────────────────────────────────────────────────────────────
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

  return (
    <TouchableOpacity
      activeOpacity={0.6}
      onPress={onPress}
      style={[
        styles.row,
        {
          backgroundColor: c.bg,
          borderBottomColor: isLast ? "transparent" : c.lineSoft,
        },
      ]}
    >
      {/* favicon */}
      <Favicon item={item} />

      {/* 中间信息 */}
      <View style={styles.rowMid}>
        {/* 名称行 */}
        <View style={styles.rowNameLine}>
          <Text
            style={[styles.rowName, { color: c.text }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {item.name}
          </Text>
          {item.totp && (
            <View
              style={[
                styles.pill,
                { borderColor: c.info, backgroundColor: c.info + "18" },
              ]}
            >
              <Text
                style={[styles.pillText, { color: c.info, fontFamily: MONO }]}
              >
                2FA
              </Text>
            </View>
          )}
          {item.breached && (
            <View
              style={[
                styles.pill,
                { borderColor: c.danger, backgroundColor: c.danger + "18" },
              ]}
            >
              <IconSymbol
                name="exclamationmark.triangle.fill"
                size={12}
                color={c.danger}
              />
            </View>
          )}
        </View>
        {/* username */}
        <Text
          style={[styles.rowSub, { color: c.text3, fontFamily: MONO }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {item.username}
        </Text>
      </View>

      {/* 右侧 */}
      <View style={styles.rowRight}>
        <Text style={[styles.rowTime, { color: c.text3, fontFamily: MONO }]}>
          {item.modified}
        </Text>
        {item.strength !== undefined && (
          <View style={styles.barWrap}>
            <View style={[styles.barTrack, { backgroundColor: c.lineSoft }]}>
              <View
                style={[
                  styles.barFill,
                  {
                    width: `${item.strength}%` as any,
                    backgroundColor: strengthColor(item.strength, c),
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

// ─────────────────────────────────────────────────────────────
// 主屏
// ─────────────────────────────────────────────────────────────
export default function VaultScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];

  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");

  const filtered = useMemo(() => {
    let list = MOCK_ITEMS;
    if (activeFilter !== "all")
      list = list.filter((i) => i.type === activeFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.username.toLowerCase().includes(q) ||
          i.url.toLowerCase().includes(q),
      );
    }
    return list;
  }, [search, activeFilter]);

  const counts = useMemo(() => {
    const by = (t: ItemType) => MOCK_ITEMS.filter((i) => i.type === t).length;
    return {
      all: MOCK_ITEMS.length,
      login: by("login"),
      card: by("card"),
      note: by("note"),
      identity: by("identity"),
      ssh: by("ssh"),
    };
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: VaultItem; index: number }) => (
      <VaultRow item={item} c={c} isLast={index === filtered.length - 1} />
    ),
    [c, filtered.length],
  );

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: c.bg }]}
      edges={["top"]}
    >
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />

      {/* ── Header ── */}
      <View style={[styles.header, { borderBottomColor: c.lineSoft }]}>
        <View style={styles.headerLeft}>
          <View style={[styles.logo, { backgroundColor: c.text }]}>
            <Text style={[styles.logoText, { color: c.bg }]}>Z</Text>
          </View>
          <Text style={[styles.appName, { color: c.text }]}>ZPass</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.countBadge, { borderColor: c.line }]}>
            <Text
              style={[styles.countText, { color: c.text3, fontFamily: MONO }]}
            >
              {filtered.length}/{MOCK_ITEMS.length}
            </Text>
          </View>
          <TouchableOpacity
            style={[
              styles.moreBtn,
              { borderColor: c.line, backgroundColor: c.bgElev },
            ]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => Alert.alert("更多操作", "功能开发中")}
          >
            <Text style={[styles.moreDots, { color: c.text2 }]}>···</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── 搜索栏 + chips（固定高度区，不参与 flex 伸展）── */}
      <View style={{ flexShrink: 0, flexGrow: 0 }}>
        <View style={[styles.searchRow, { backgroundColor: c.bg }]}>
          <View
            style={[
              styles.searchBox,
              { backgroundColor: c.bgElev, borderColor: c.line },
            ]}
          >
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
            {/* 手机端无键盘快捷键，移除桌面端的快捷键提示 */}
          </View>
        </View>

        {/* ── 筛选 chips ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={{ backgroundColor: c.bg, flexGrow: 0, flexShrink: 0 }}
        >
          {FILTER_CHIPS.map((chip) => {
            const active = activeFilter === chip.key;
            const cnt = counts[chip.key as keyof typeof counts] ?? 0;
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
                <Text
                  style={[styles.chipLabel, { color: active ? c.bg : c.text2 }]}
                >
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

        {/* ── 分隔线 ── */}
        <View style={[styles.divider, { backgroundColor: c.lineSoft }]} />
      </View>

      {/* ── 列表（全屏铺满，无圆角卡）── */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        style={[styles.list, { backgroundColor: c.bg }]}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: c.text3 }]}>无匹配项</Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />

      {/* ── FAB ── */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: c.text }]}
        activeOpacity={0.8}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          Alert.alert("新建条目", "功能开发中");
        }}
      >
        <Text style={[styles.fabPlus, { color: c.bg }]}>＋</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────
// 样式
// ─────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  logo: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 16,
  },
  appName: {
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  countBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  countText: {
    fontSize: 11,
  },
  moreBtn: {
    width: 30,
    height: 30,
    borderRadius: 7,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  moreDots: {
    fontSize: 14,
    letterSpacing: 1,
    lineHeight: 18,
  },

  // 搜索
  searchRow: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
  },
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

  // Chips
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
  chipLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  chipCount: {
    fontSize: 11,
  },

  // 分隔
  divider: {
    height: StyleSheet.hairlineWidth,
  },

  // 列表
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 100,
  },

  // 行
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
  faviconText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  rowMid: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  rowNameLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 1,
  },
  rowName: {
    fontSize: 14,
    fontWeight: "500",
    flexShrink: 1,
  },
  pill: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    flexShrink: 0,
  },
  pillText: {
    fontSize: 9,
    fontWeight: "600",
    lineHeight: 13,
  },
  rowSub: {
    fontSize: 11,
  },
  rowRight: {
    alignItems: "flex-end",
    gap: 5,
    flexShrink: 0,
    minWidth: 52,
  },
  rowTime: {
    fontSize: 10,
  },
  barWrap: {
    width: 36,
  },
  barTrack: {
    height: 3,
    borderRadius: 2,
    overflow: "hidden",
  },
  barFill: {
    height: 3,
    borderRadius: 2,
  },

  // FAB
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
  fabPlus: {
    fontSize: 26,
    lineHeight: 30,
    marginTop: -1,
  },

  // Empty
  empty: {
    paddingVertical: 48,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
  },
});
