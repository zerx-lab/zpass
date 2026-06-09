// 密码库主屏 —— 看板 / 启动器式首页（参考 harmony VaultTab 布局）
//
// 不再是「搜索框 + chip 筛选 + 平铺列表」，而是分区入口看板，点击各入口
// 跳到 app/vault/list 对应筛选列表：
//
//   顶栏：当前空间头像 + 名称 + 计数；右侧 同步 / 锁定 / 新建 图标按钮
//   全部项目 大卡（总数）
//   验证器 / 收藏 并排卡
//   空间 分区（>1 空间时；点击切换激活空间，与「我的」空间切换同一模型）
//   类型 分区（有数量的类型分组卡）
//   右下角搜索 FAB（跳全部项目列表并聚焦搜索框）
//
// 计数与列表共用同一谓词（itemHasTotp / type / favorite），口径一致。
// 说明：phone 为硬删除、无回收站，故不含「回收站」卡；空间在 phone 中
// 作为全局激活范围，故空间分区做「切换激活空间」而非跨空间导航。

import React, { useMemo, useCallback } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Radius, Spacing, Type, type ColorPalette } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { IconButton, PressableScale } from "@/components/ui/primitives";
import { SpaceAvatar } from "@/components/space-avatar";
import { useVault } from "@/contexts/vault-context";
import { itemHasTotp, type VaultItemType } from "@/data/vault";
import { DEFAULT_SPACE_ID, sortSpaces, type Space } from "@/lib/spaces";

type IconName = React.ComponentProps<typeof IconSymbol>["name"];

interface TypeSpec {
  type: VaultItemType;
  label: string;
  icon: IconName;
}

// 类型分区候选（顺序对齐 harmony）；'totp' 不在此，独立验证器卡承载
const TYPE_SPECS: TypeSpec[] = [
  { type: "login", label: "登录", icon: "key.fill" },
  { type: "card", label: "支付卡", icon: "creditcard.fill" },
  { type: "identity", label: "身份", icon: "person.fill" },
  { type: "note", label: "安全笔记", icon: "note.text" },
  { type: "ssh", label: "SSH Key", icon: "terminal.fill" },
  { type: "passkey", label: "通行密钥", icon: "lock.fill" },
];

function colorForType(t: VaultItemType, c: ColorPalette): string {
  if (t === "identity") return c.ok;
  if (t === "note") return c.warn;
  if (t === "ssh") return c.text2;
  return c.info; // login / card / passkey / totp
}

function go(scope: string, value: string, title: string, focus?: boolean) {
  router.push({
    pathname: "/vault/list",
    params: { scope, value, title, ...(focus ? { focus: "1" } : {}) },
  } as any);
}

export default function VaultScreen() {
  const { scheme, colors: c } = useTheme();
  const {
    items,
    allItems,
    spaces,
    activeSpace,
    activeSpaceId,
    setActiveSpace,
    lock,
  } = useVault();

  // 计数（当前激活空间口径，与 list 页一致）
  const counts = useMemo(() => {
    const byType = new Map<VaultItemType, number>();
    let fav = 0;
    let totp = 0;
    for (const it of items) {
      byType.set(it.type, (byType.get(it.type) ?? 0) + 1);
      if (it.favorite) fav++;
      if (itemHasTotp(it)) totp++;
    }
    return { total: items.length, fav, totp, byType };
  }, [items]);

  // 各空间条目数（跨空间，用 allItems）
  const bySpace = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of allItems) {
      const sid = it.spaceId ?? DEFAULT_SPACE_ID;
      m.set(sid, (m.get(sid) ?? 0) + 1);
    }
    return m;
  }, [allItems]);

  const orderedSpaces = useMemo(() => sortSpaces(spaces), [spaces]);
  const visibleTypes = useMemo(
    () => TYPE_SPECS.filter((s) => (counts.byType.get(s.type) ?? 0) > 0),
    [counts],
  );

  const onLock = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    lock();
  }, [lock]);

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: c.bg }]}
      edges={["top"]}
    >
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />

      {/* 顶栏：空间身份 + 操作按钮 */}
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
              {counts.total} 个项目
            </Text>
          </View>
        </View>

        <View style={styles.headerActions}>
          <IconButton
            icon="arrow.clockwise"
            size={38}
            iconSize={18}
            variant="tinted"
            onPress={() => router.push("/sync" as any)}
          />
          <IconButton
            icon="lock.fill"
            size={38}
            iconSize={18}
            variant="tinted"
            onPress={onLock}
          />
          <IconButton
            icon="plus"
            size={38}
            iconSize={18}
            variant="tinted"
            onPress={() => router.push("/item/new" as any)}
          />
        </View>
      </View>

      {/* 看板内容 */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* 全部项目 大卡 */}
        <BigCard
          icon="square.grid.2x2.fill"
          iconBg={c.info}
          title="全部项目"
          subtitle={`${counts.total} 个项目`}
          c={c}
          onPress={() => go("all", "", "全部项目")}
        />

        {/* 验证器 / 收藏 并排 */}
        <View style={styles.dualRow}>
          <DualCard
            icon="lock.shield.fill"
            iconBg={c.text2}
            title="验证器"
            subtitle={`${counts.totp} 个令牌`}
            c={c}
            onPress={() => router.push("/totp" as any)}
          />
          <DualCard
            icon="star.fill"
            iconBg={c.warn}
            title="收藏"
            subtitle={`${counts.fav} 项`}
            c={c}
            onPress={() => go("fav", "", "收藏")}
          />
        </View>

        {/* 空间 分区 —— 点击切换激活空间 */}
        {orderedSpaces.length > 1 && (
          <>
            <Text style={[styles.sectionTitle, { color: c.text3 }]}>空间</Text>
            <View style={[styles.group, { backgroundColor: c.bgElev }]}>
              {orderedSpaces.map((sp, idx) => (
                <SpaceRow
                  key={sp.id}
                  space={sp}
                  count={bySpace.get(sp.id) ?? 0}
                  active={sp.id === activeSpaceId}
                  withDivider={idx < orderedSpaces.length - 1}
                  c={c}
                  onPress={() => {
                    Haptics.selectionAsync();
                    void setActiveSpace(sp.id);
                  }}
                />
              ))}
            </View>
          </>
        )}

        {/* 类型 分区 */}
        {visibleTypes.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: c.text3 }]}>类型</Text>
            <View style={[styles.group, { backgroundColor: c.bgElev }]}>
              {visibleTypes.map((s, idx) => (
                <TypeRow
                  key={s.type}
                  spec={s}
                  count={counts.byType.get(s.type) ?? 0}
                  withDivider={idx < visibleTypes.length - 1}
                  c={c}
                  onPress={() => go("type", s.type, s.label)}
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>

      {/* 搜索 FAB */}
      <View style={styles.fabWrap} pointerEvents="box-none">
        <IconButton
          icon="magnifyingglass"
          size={56}
          iconSize={22}
          variant="solid"
          haptic="medium"
          onPress={() => go("all", "", "全部项目", true)}
          style={styles.fab}
        />
      </View>
    </SafeAreaView>
  );
}

/* ── 子组件 ───────────────────────────────────────────────────── */

function IconCircle({
  icon,
  bg,
  size,
}: {
  icon: IconName;
  bg: string;
  size: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <IconSymbol name={icon} size={Math.round(size * 0.5)} color="#fff" />
    </View>
  );
}

function BigCard({
  icon,
  iconBg,
  title,
  subtitle,
  c,
  onPress,
}: {
  icon: IconName;
  iconBg: string;
  title: string;
  subtitle: string;
  c: ColorPalette;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      scale={0.985}
      haptic="light"
      pressedBg={c.bgHover}
      style={[styles.bigCard, { backgroundColor: c.bgElev }]}
    >
      <IconCircle icon={icon} bg={iconBg} size={48} />
      <View style={styles.cardMid}>
        <Text style={[styles.cardTitle, { color: c.text }]}>{title}</Text>
        <Text style={[styles.cardSub, { color: c.text3 }]}>{subtitle}</Text>
      </View>
      <IconSymbol name="chevron.right" size={18} color={c.text4} />
    </PressableScale>
  );
}

function DualCard({
  icon,
  iconBg,
  title,
  subtitle,
  c,
  onPress,
}: {
  icon: IconName;
  iconBg: string;
  title: string;
  subtitle: string;
  c: ColorPalette;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      scale={0.97}
      haptic="light"
      pressedBg={c.bgHover}
      style={[styles.dualCard, { backgroundColor: c.bgElev }]}
    >
      <IconCircle icon={icon} bg={iconBg} size={44} />
      <View style={styles.dualText}>
        <Text style={[styles.cardTitle, { color: c.text }]}>{title}</Text>
        <Text style={[styles.cardSub, { color: c.text3 }]}>{subtitle}</Text>
      </View>
    </PressableScale>
  );
}

function SpaceRow({
  space,
  count,
  active,
  withDivider,
  c,
  onPress,
}: {
  space: Space;
  count: number;
  active: boolean;
  withDivider: boolean;
  c: ColorPalette;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      scale={0.99}
      haptic="none"
      pressedBg={c.bgHover}
      style={styles.groupRow}
    >
      <SpaceAvatar
        space={space}
        size={30}
        background={c.info}
        foreground="#fff"
        fontSize={14}
        borderRadius={Radius.md}
      />
      <Text style={[styles.groupRowLabel, { color: c.text }]} numberOfLines={1}>
        {space.name}
      </Text>
      {active && <IconSymbol name="checkmark" size={15} color={c.text2} />}
      <Text style={[styles.groupRowCount, { color: c.text3 }]}>{count}</Text>
      <IconSymbol name="chevron.right" size={16} color={c.text4} />
      {withDivider && (
        <View
          style={[
            styles.divider,
            { backgroundColor: c.lineSoft, left: Spacing.lg + 30 + Spacing.md },
          ]}
        />
      )}
    </PressableScale>
  );
}

function TypeRow({
  spec,
  count,
  withDivider,
  c,
  onPress,
}: {
  spec: TypeSpec;
  count: number;
  withDivider: boolean;
  c: ColorPalette;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      scale={0.99}
      haptic="none"
      pressedBg={c.bgHover}
      style={styles.groupRow}
    >
      <View style={styles.typeIcon}>
        <IconSymbol
          name={spec.icon}
          size={22}
          color={colorForType(spec.type, c)}
        />
      </View>
      <Text style={[styles.groupRowLabel, { color: c.text }]} numberOfLines={1}>
        {spec.label}
      </Text>
      <Text style={[styles.groupRowCount, { color: c.text3 }]}>{count}</Text>
      <IconSymbol name="chevron.right" size={16} color={c.text4} />
      {withDivider && (
        <View
          style={[
            styles.divider,
            { backgroundColor: c.lineSoft, left: Spacing.lg + 22 + Spacing.md },
          ]}
        />
      )}
    </PressableScale>
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
    gap: Spacing.sm,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    flexShrink: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    flexShrink: 0,
  },
  appName: {
    ...Type.title,
    letterSpacing: -0.4,
  },
  headerSub: {
    ...Type.footnote,
    marginTop: 1,
  },

  /* Scroll */
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: 120,
    gap: Spacing.lg,
  },

  /* Cards */
  bigCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
  },
  cardMid: { flex: 1, gap: 3 },
  cardTitle: { ...Type.headline, fontWeight: "700" },
  cardSub: { ...Type.footnote },

  dualRow: {
    flexDirection: "row",
    gap: Spacing.md,
  },
  dualCard: {
    flex: 1,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    gap: Spacing.sm,
  },
  dualText: { gap: 2 },

  /* Section */
  sectionTitle: {
    ...Type.subhead,
    marginTop: -Spacing.xs,
    marginLeft: Spacing.xs,
    marginBottom: -Spacing.sm,
  },
  group: {
    borderRadius: Radius.xl,
    overflow: "hidden",
  },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  groupRowLabel: {
    ...Type.bodyEmph,
    flex: 1,
    minWidth: 0,
  },
  groupRowCount: {
    ...Type.subhead,
    fontVariant: ["tabular-nums"],
  },
  typeIcon: {
    width: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    position: "absolute",
    bottom: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
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
});
