import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  Alert,
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

// ─── Types & Mock Data ──────────────────────────────────────────────────────

export type TotpAccount = {
  id: string;
  name: string;
  username: string;
  initials: string;
  color: string;
  secret: string;
};

/**
 * 导出供详情页使用。
 * 注：`secret` 字段名沿用旧版命名，实际承载的是当前 TOTP 数字（mock）。
 */
export const TOTP_ITEMS: TotpAccount[] = [
  {
    id: "1",
    name: "GitHub",
    username: "zero@example.com",
    initials: "GH",
    color: "#1a1a2e",
    secret: "068508",
  },
  {
    id: "2",
    name: "AWS",
    username: "zero@aws.com",
    initials: "A",
    color: "#ff9900",
    secret: "421908",
  },
  {
    id: "3",
    name: "Linear",
    username: "zero@linear.app",
    initials: "L",
    color: "#5e6ad2",
    secret: "193742",
  },
  {
    id: "4",
    name: "Stripe",
    username: "zero@stripe.com",
    initials: "S",
    color: "#635bff",
    secret: "824651",
  },
  {
    id: "5",
    name: "Cloudflare",
    username: "zero@cf.com",
    initials: "C",
    color: "#f38020",
    secret: "347219",
  },
  {
    id: "6",
    name: "Vercel",
    username: "zero@vercel.com",
    initials: "V",
    color: "#141414",
    secret: "091823",
  },
];

const PERIOD = 30; // TOTP 周期（秒）

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 当前周期内已过秒数（0‥29） */
function getElapsed(): number {
  return Math.floor(Date.now() / 1000) % PERIOD;
}

/** 剩余秒数（1‥30） */
function getRemaining(): number {
  return PERIOD - getElapsed();
}

/** 将 "068508" 格式化为 "068 508" */
export function formatCode(code: string): string {
  return code.slice(0, 3) + " " + code.slice(3);
}

// ─── Row Component ───────────────────────────────────────────────────────────

type RowProps = {
  item: TotpAccount;
  C: (typeof Colors)["dark"];
  isUrgent: boolean;
  remaining: number;
  progressAnim: Animated.Value;
  onPress: (item: TotpAccount) => void;
  onLongPress: (item: TotpAccount) => void;
};

/**
 * 单行：左侧 favicon + 服务名/用户名，右侧大号验证码 + 圆形倒计时刻度。
 *
 * 倒计时进度采用一条共享的全局 Animated.Value（所有 TOTP 同步刷新），
 * 这里仅订阅其插值，避免每行各起一条动画造成的性能浪费。
 */
function TotpRow({
  item,
  C,
  isUrgent,
  remaining,
  progressAnim,
  onPress,
  onLongPress,
}: RowProps) {
  const codeColor = isUrgent ? C.danger : C.text;
  const ringColor = isUrgent ? C.danger : C.info;

  // 圆环进度：用一个旋转的小指针 + 静态外环模拟（无 SVG 依赖）
  // 这里用最简单的方案：圆形数字徽标 + 文字秒数
  return (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: C.lineSoft }]}
      onPress={() => onPress(item)}
      onLongPress={() => onLongPress(item)}
      activeOpacity={0.6}
      delayLongPress={300}
    >
      {/* 左侧 favicon */}
      <View style={[styles.favicon, { backgroundColor: item.color }]}>
        <Text style={styles.faviconText}>{item.initials.slice(0, 2)}</Text>
      </View>

      {/* 中部信息 */}
      <View style={styles.info}>
        <Text style={[styles.name, { color: C.text }]} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={[styles.username, { color: C.text3 }]} numberOfLines={1}>
          {item.username}
        </Text>
      </View>

      {/* 右侧验证码 + 倒计时徽标 */}
      <View style={styles.right}>
        <Text style={[styles.code, { color: codeColor }]} numberOfLines={1}>
          {formatCode(item.secret)}
        </Text>
        <View style={styles.countdownWrap}>
          {/* 进度条（细线，与每行对齐） */}
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

// ─── Component ───────────────────────────────────────────────────────────────

export default function TotpScreen() {
  const scheme = useColorScheme() ?? "dark";
  const C = Colors[scheme];

  const [query, setQuery] = useState<string>("");
  const [remaining, setRemaining] = useState<number>(getRemaining());

  // 全局共享进度（0 = 周期起点，1 = 周期末尾）
  const progressAnim = useRef(
    new Animated.Value(getElapsed() / PERIOD),
  ).current;
  const progressAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  const isUrgent = remaining <= 5;

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

  // ── 过滤 ──
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOTP_ITEMS;
    return TOTP_ITEMS.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.username.toLowerCase().includes(q),
    );
  }, [query]);

  // ── 交互 ──
  const handleOpen = useCallback(async (item: TotpAccount) => {
    await Haptics.selectionAsync();
    router.push(`/totp/${item.id}`);
  }, []);

  const handleCopy = useCallback(async (item: TotpAccount) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      "已复制",
      `${item.name} 的验证码 ${formatCode(item.secret)} 已复制到剪贴板`,
    );
  }, []);

  // ── 顶部全局倒计时进度条宽度 ──
  const headerBarWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]}>
      {/* ── Header ── */}
      <View style={[styles.header, { borderBottomColor: C.lineSoft }]}>
        <Text style={[styles.headerTitle, { color: C.text }]}>验证码</Text>
        <TouchableOpacity
          style={[styles.addBtn, { borderColor: C.line }]}
          onPress={() => Alert.alert("添加 TOTP")}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconSymbol name="plus" size={18} color={C.text} />
        </TouchableOpacity>
      </View>

      {/* ── 全局倒计时进度条 ── */}
      <View style={[styles.globalTrack, { backgroundColor: C.bgElev2 }]}>
        <Animated.View
          style={[
            styles.globalBar,
            {
              width: headerBarWidth,
              backgroundColor: isUrgent ? C.danger : C.info,
            },
          ]}
        />
      </View>

      {/* ── 搜索框 ── */}
      <View style={styles.searchWrap}>
        <View
          style={[
            styles.searchBox,
            { borderColor: C.line, backgroundColor: C.bgElev },
          ]}
        >
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

      {/* ── 列表 ── */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TotpRow
            item={item}
            C={C}
            isUrgent={isUrgent}
            remaining={remaining}
            progressAnim={progressAnim}
            onPress={handleOpen}
            onLongPress={handleCopy}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: C.text3 }]}>
              没有匹配的验证码
            </Text>
          </View>
        }
        ListFooterComponent={
          filtered.length > 0 ? (
            <Text style={[styles.footerHint, { color: C.text3 }]}>
              点击查看大号显示 · 长按直接复制
            </Text>
          ) : null
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  addBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  // 全局倒计时条（紧贴 Header 下方，作为「所有码同步刷新」的视觉锚点）
  globalTrack: {
    height: 2,
    width: "100%",
    overflow: "hidden",
  },
  globalBar: {
    height: "100%",
  },

  // 搜索
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
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

  // 列表
  listContent: {
    paddingTop: 4,
    paddingBottom: 32,
  },

  // 行
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
  info: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  name: {
    fontSize: 14,
    fontWeight: "500",
  },
  username: {
    fontSize: 12,
  },

  // 右侧验证码 + 倒计时
  right: {
    alignItems: "flex-end",
    gap: 4,
    flexShrink: 0,
  },
  code: {
    fontSize: 20,
    fontWeight: "500",
    letterSpacing: 1.5,
    fontVariant: ["tabular-nums"],
    fontFamily: MONO,
    includeFontPadding: false,
  },
  countdownWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  miniTrack: {
    width: 36,
    height: 3,
    borderRadius: 1.5,
    overflow: "hidden",
  },
  miniBar: {
    height: "100%",
    borderRadius: 1.5,
  },
  countdownText: {
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    minWidth: 22,
    textAlign: "right",
    includeFontPadding: false,
  },

  // 空态 & 页脚
  empty: {
    alignItems: "center",
    paddingVertical: 64,
  },
  emptyText: {
    fontSize: 13,
  },
  footerHint: {
    fontSize: 11,
    textAlign: "center",
    paddingVertical: 16,
  },
});
