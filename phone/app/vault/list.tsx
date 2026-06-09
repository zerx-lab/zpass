// 通用筛选条目列表页
//
// 看板首页（(tabs)/vault）各入口跳转到此，按 scope 展示对应条目集合。
// 路由参数：{ scope, value?, title, focus? }
//   scope='all'   全部条目
//   scope='fav'   收藏
//   scope='totp'  验证器（含 TOTP 的条目）
//   scope='type'  指定类型（value=VaultItemType）
//   focus='1'     进入即聚焦搜索框（来自首页搜索 FAB）
//
// 列表内容 = 当前激活空间 items 经 scope + 搜索过滤，与首页卡片计数同口径。

import React, { useState, useMemo, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";

import { Radius, Spacing, Type, type ColorPalette } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { Badge, IconButton, PressableScale } from "@/components/ui/primitives";
import {
  SwipeableRow,
  type SwipeableRowHandle,
} from "@/components/ui/swipeable-row";
import { dialog } from "@/components/ui/dialog";
import { useVault } from "@/contexts/vault-context";
import { itemHasTotp, type VaultItem, type VaultItemType } from "@/data/vault";
import {
  faviconColor,
  faviconInitials,
  itemSubtitle,
  itemSearchText,
  relativeTime,
} from "@/lib/format";

type Scope = "all" | "fav" | "totp" | "type";

const ALL_TYPES: VaultItemType[] = [
  "login",
  "card",
  "note",
  "identity",
  "ssh",
  "passkey",
  "totp",
];

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

function strengthColor(s: number, c: ColorPalette) {
  if (s >= 80) return c.ok;
  if (s >= 50) return c.warn;
  return c.danger;
}

function Favicon({ item }: { item: VaultItem }) {
  return (
    <View
      style={[styles.favicon, { backgroundColor: faviconColor(item.name) }]}
    >
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
  c: ColorPalette;
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
    <PressableScale
      onPress={onPress}
      scale={0.985}
      haptic="none"
      pressedBg={c.bgHover}
      style={styles.row}
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
            <IconSymbol name="star.fill" size={11} color={c.warn} />
          )}
          {hasTotp && <Badge label="2FA" tone="info" />}
          {breached && (
            <Badge icon="exclamationmark.triangle.fill" tone="danger" />
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

      {!isLast && (
        <View
          style={[
            styles.hairline,
            { backgroundColor: c.lineSoft, left: Spacing.lg + 38 + Spacing.md },
          ]}
        />
      )}
    </PressableScale>
  );
}

/* ── 左滑动作 ──────────────────────────────────────────────────── */

const SWIPE_ACTION_WIDTH = 76;

function SwipeableVaultRow({
  item,
  c,
  isLast,
}: {
  item: VaultItem;
  c: ColorPalette;
  isLast: boolean;
}) {
  const { deleteItem, toggleFavorite } = useVault();
  const swipeRef = useRef<SwipeableRowHandle>(null);

  const handleEdit = useCallback(() => {
    swipeRef.current?.close();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/item/${item.id}` as any);
  }, [item.id]);

  const handleFavorite = useCallback(async () => {
    swipeRef.current?.close();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await toggleFavorite(item.id);
  }, [item.id, toggleFavorite]);

  const handleDelete = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const ok = await dialog.confirm(
      "删除条目",
      `确定要删除"${item.name}"吗？此操作无法撤销。`,
      { okLabel: "删除", destructive: true },
    );
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await deleteItem(item.id);
    } else {
      swipeRef.current?.close();
    }
  }, [item.id, item.name, deleteItem]);

  const rightActions = useMemo(
    () => [
      {
        key: "edit",
        icon: "square.and.pencil" as const,
        label: "编辑",
        color: c.info,
        onPress: handleEdit,
      },
      {
        key: "favorite",
        icon: (item.favorite ? "star" : "star.fill") as "star" | "star.fill",
        label: item.favorite ? "取消" : "收藏",
        color: c.warn,
        onPress: handleFavorite,
      },
      {
        key: "delete",
        icon: "trash.fill" as const,
        label: "删除",
        color: c.danger,
        onPress: handleDelete,
      },
    ],
    [
      c.info,
      c.warn,
      c.danger,
      item.favorite,
      handleEdit,
      handleFavorite,
      handleDelete,
    ],
  );

  return (
    <SwipeableRow
      ref={swipeRef}
      rightActions={rightActions}
      actionWidth={SWIPE_ACTION_WIDTH}
    >
      <VaultRow item={item} c={c} isLast={isLast} />
    </SwipeableRow>
  );
}

/* ── 列表页 ───────────────────────────────────────────────────── */

export default function VaultListScreen() {
  const { scheme, colors: c } = useTheme();
  const { items } = useVault();

  const params = useLocalSearchParams<{
    scope?: string;
    value?: string;
    title?: string;
    focus?: string;
  }>();

  const scope = (params.scope ?? "all") as Scope;
  const value = params.value ?? "";
  const title = params.title ?? "全部项目";
  const autoFocus = params.focus === "1";

  const [search, setSearch] = useState("");

  const sorted = useMemo(
    () => [...items].sort((a, b) => b.modified - a.modified),
    [items],
  );

  const filtered = useMemo(() => {
    let list = sorted;
    if (scope === "fav") list = list.filter((i) => i.favorite);
    else if (scope === "totp") list = list.filter(itemHasTotp);
    else if (scope === "type")
      list = list.filter((i) => i.type === (value as VaultItemType));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((i) => itemSearchText(i).includes(q));
    }
    return list;
  }, [sorted, scope, value, search]);

  // 类型作用域下新建预设类型，其它作用域走通用新建
  const onTapNew = useCallback(() => {
    if (scope === "type" && ALL_TYPES.includes(value as VaultItemType)) {
      router.push(`/item/new?type=${value}` as any);
    } else {
      router.push("/item/new" as any);
    }
  }, [scope, value]);

  const renderItem = useCallback(
    ({ item, index }: { item: VaultItem; index: number }) => {
      const isFirst = index === 0;
      const isLast = index === filtered.length - 1;
      return (
        <View
          style={[
            styles.rowCard,
            { backgroundColor: c.bgElev },
            isFirst && styles.rowCardFirst,
            isLast && styles.rowCardLast,
          ]}
        >
          <SwipeableVaultRow item={item} c={c} isLast={isLast} />
        </View>
      );
    },
    [c, filtered.length],
  );

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: c.bg }]}
      edges={["top"]}
    >
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />

      {/* 顶栏：返回 + 标题 + 新建 */}
      <View style={styles.nav}>
        <IconButton
          icon="chevron.left"
          size={36}
          iconSize={22}
          variant="ghost"
          onPress={() => router.back()}
        />
        <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
          {title}
        </Text>
        <IconButton
          icon="plus"
          size={36}
          iconSize={20}
          variant="ghost"
          onPress={onTapNew}
        />
      </View>

      {/* 搜索框 */}
      <View style={styles.searchRow}>
        <View style={[styles.searchBox, { backgroundColor: c.bgElev }]}>
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
            autoFocus={autoFocus}
          />
        </View>
      </View>

      {/* 列表 */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: c.bgElev }]}>
              <IconSymbol name="key.fill" size={28} color={c.text3} />
            </View>
            <Text style={[styles.emptyTitle, { color: c.text }]}>
              {search.trim() ? "无匹配项" : "这里还没有条目"}
            </Text>
            <Text style={[styles.emptyDesc, { color: c.text3 }]}>
              {search.trim() ? "调整搜索条件" : "点击右下角按钮新建条目"}
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />

      {/* FAB */}
      <View style={styles.fabWrap} pointerEvents="box-none">
        <IconButton
          icon="plus"
          size={56}
          iconSize={22}
          variant="solid"
          haptic="medium"
          onPress={onTapNew}
          style={styles.fab}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  /* Nav */
  nav: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.sm,
    gap: Spacing.xs,
  },
  navTitle: {
    ...Type.title,
    flex: 1,
    marginLeft: Spacing.xs,
  },

  /* Search */
  searchRow: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    height: 38,
    gap: Spacing.sm,
  },
  searchInput: {
    flex: 1,
    ...Type.body,
    paddingVertical: 0,
    includeFontPadding: false,
  },

  /* List */
  list: { flex: 1 },
  listContent: { paddingBottom: 120 },
  rowCard: {
    marginHorizontal: Spacing.lg,
    overflow: "hidden",
  },
  rowCardFirst: {
    marginTop: Spacing.sm,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  rowCardLast: {
    borderBottomLeftRadius: Radius.xl,
    borderBottomRightRadius: Radius.xl,
  },

  /* Row */
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    gap: Spacing.md,
  },
  hairline: {
    position: "absolute",
    bottom: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  favicon: {
    width: 38,
    height: 38,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  faviconText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  rowMid: { flex: 1, gap: 2, minWidth: 0 },
  rowNameLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs + 1,
    flexShrink: 1,
  },
  rowName: { ...Type.bodyEmph, flexShrink: 1 },
  rowSub: { ...Type.footnote },
  rowRight: {
    alignItems: "flex-end",
    gap: 5,
    flexShrink: 0,
    minWidth: 52,
  },
  rowTime: { ...Type.caption, fontSize: 10 },
  barWrap: { width: 36 },
  barTrack: { height: 3, borderRadius: 2, overflow: "hidden" },
  barFill: { height: 3, borderRadius: 2 },

  /* Swipe actions → 见 components/ui/swipeable-row.tsx */

  /* FAB */
  fabWrap: {
    position: "absolute",
    right: Spacing.xl,
    bottom: Spacing.xl + 8,
  },
  fab: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
    elevation: 8,
  },

  /* Empty */
  empty: {
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
  emptyDesc: { ...Type.footnote },
});
