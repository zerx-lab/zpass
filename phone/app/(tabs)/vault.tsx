import React, {
  useState,
  useMemo,
  useCallback,
  useRef,
  type ComponentProps,
} from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  ScrollView,
  StyleSheet,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";

import { Radius, Spacing, Type, type ColorPalette } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import {
  Badge,
  Chip,
  IconButton,
  PressableScale,
} from "@/components/ui/primitives";
import { dialog } from "@/components/ui/dialog";
import { SpaceAvatar } from "@/components/space-avatar";
import { useVault } from "@/contexts/vault-context";
import { itemHasTotp, type VaultItem, type VaultItemType } from "@/data/vault";
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

function strengthColor(s: number, c: ColorPalette) {
  if (s >= 80) return c.ok;
  if (s >= 50) return c.warn;
  return c.danger;
}

function Favicon({ item }: { item: VaultItem }) {
  return (
    <View
      style={[
        styles.favicon,
        { backgroundColor: faviconColor(item.name) },
      ]}
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
            <Badge
              icon="exclamationmark.triangle.fill"
              tone="danger"
            />
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

/**
 * 全局单例:同一时间只允许一行展开。
 * 新行展开时关闭上一行,符合 iOS 邮件/微信滑动删除的习惯。
 */
const openSwipeableRef: { current: SwipeableMethods | null } = {
  current: null,
};

function SwipeAction({
  icon,
  label,
  bg,
  onPress,
}: {
  icon: ComponentProps<typeof IconSymbol>["name"];
  label: string;
  bg: string;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      scale={0.94}
      haptic="light"
      style={[styles.swipeAction, { backgroundColor: bg }]}
    >
      <IconSymbol name={icon} size={20} color="#fff" />
      <Text style={styles.swipeActionLabel}>{label}</Text>
    </PressableScale>
  );
}

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
  const swipeRef = useRef<SwipeableMethods>(null);

  const handleSwipeableWillOpen = useCallback(() => {
    if (
      openSwipeableRef.current &&
      openSwipeableRef.current !== swipeRef.current
    ) {
      openSwipeableRef.current.close();
    }
    openSwipeableRef.current = swipeRef.current;
  }, []);

  const handleSwipeableClose = useCallback(() => {
    if (openSwipeableRef.current === swipeRef.current) {
      openSwipeableRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      if (openSwipeableRef.current === swipeRef.current) {
        openSwipeableRef.current = null;
      }
    };
  }, []);

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
      `确定要删除"${item.name}"吗?此操作无法撤销。`,
      { okLabel: "删除", destructive: true },
    );
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await deleteItem(item.id);
    } else {
      swipeRef.current?.close();
    }
  }, [item.id, item.name, deleteItem]);

  const renderRightActions = useCallback(
    () => (
      <View style={styles.swipeActionsRow}>
        <SwipeAction
          icon="square.and.pencil"
          label="编辑"
          bg={c.info}
          onPress={handleEdit}
        />
        <SwipeAction
          icon={item.favorite ? "star" : "star.fill"}
          label={item.favorite ? "取消" : "收藏"}
          bg={c.warn}
          onPress={handleFavorite}
        />
        <SwipeAction
          icon="trash.fill"
          label="删除"
          bg={c.danger}
          onPress={handleDelete}
        />
      </View>
    ),
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
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={1}
      rightThreshold={SWIPE_ACTION_WIDTH * 3 * 0.7}
      dragOffsetFromRightEdge={24}
      overshootRight={false}
      enableTrackpadTwoFingerGesture
      renderRightActions={renderRightActions}
      onSwipeableWillOpen={handleSwipeableWillOpen}
      onSwipeableClose={handleSwipeableClose}
    >
      <VaultRow item={item} c={c} isLast={isLast} />
    </ReanimatedSwipeable>
  );
}

export default function VaultScreen() {
  const { scheme, colors: c } = useTheme();
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
    else if (activeFilter === "totp")
      list = list.filter(itemHasTotp);
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
      result[t] =
        t === "totp"
          ? items.filter(itemHasTotp).length
          : items.filter((i) => i.type === t).length;
    }
    return result;
  }, [items]);

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

      {/* 顶部大标题（iOS HIG largeTitle 风格） */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <SpaceAvatar
            space={activeSpace}
            size={30}
            background={c.bgElev}
            foreground={c.text}
            fontSize={14}
            borderRadius={Radius.md}
          />
          <View style={{ minWidth: 0, flexShrink: 1 }}>
            <Text style={[styles.appName, { color: c.text }]} numberOfLines={1}>
              {activeSpace?.name ?? "ZPass"}
            </Text>
            <Text style={[styles.headerSub, { color: c.text3 }]}>
              {filtered.length} / {items.length} 项
            </Text>
          </View>
        </View>
      </View>

      {/* 搜索框（fill 风格，无 border） */}
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
          />
        </View>
      </View>

      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        style={{ flexGrow: 0, flexShrink: 0 }}
      >
        {FILTER_CHIPS.map((chip) => (
          <Chip
            key={chip.key}
            label={chip.label}
            active={activeFilter === chip.key}
            count={counts[chip.key] ?? 0}
            onPress={() => setActiveFilter(chip.key)}
          />
        ))}
      </ScrollView>

      {/* 列表组（insetGrouped 风格：bgElev2 大块 + hairline 分隔） */}
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
              {search.trim() || activeFilter !== "all"
                ? "无匹配项"
                : "保险库为空"}
            </Text>
            <Text style={[styles.emptyDesc, { color: c.text3 }]}>
              {search.trim() || activeFilter !== "all"
                ? "调整搜索或筛选条件"
                : "点击右下角按钮新建条目"}
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />

      {/* FAB —— 用真图标，不是 Unicode */}
      <View style={styles.fabWrap} pointerEvents="box-none">
        <IconButton
          icon="plus"
          size={56}
          iconSize={22}
          variant="solid"
          haptic="medium"
          onPress={() => router.push("/item/new" as any)}
          style={styles.fab}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  /* Header */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.sm,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    flexShrink: 1,
  },
  appName: {
    ...Type.title,
    letterSpacing: -0.4,
  },
  headerSub: {
    ...Type.footnote,
    marginTop: 1,
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

  /* Chips */
  chips: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    flexDirection: "row",
    alignItems: "center",
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

  /* Swipe actions */
  swipeActionsRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  swipeAction: {
    width: SWIPE_ACTION_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: Spacing.sm,
  },
  swipeActionLabel: {
    ...Type.caption,
    fontSize: 11,
    fontWeight: "600",
    color: "#fff",
  },

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
