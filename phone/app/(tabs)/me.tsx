import React from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Switch,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme, type ThemeMode } from "@/contexts/theme-context";

const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

// ─── Types ────────────────────────────────────────────────────────────────────

interface MenuRowConfig {
  key: string;
  label: string;
  value?: string;
  badge?: { text: string; color: "danger" | "warn" | "ok" | "text3" };
  showChevron?: boolean;
  toggle?: boolean;
  toggleValue?: boolean;
  onPress?: () => void;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ title, c }: { title: string; c: typeof Colors.dark }) {
  return (
    <Text style={[styles.sectionLabel, { color: c.text3, fontFamily: MONO }]}>
      {title}
    </Text>
  );
}

function MenuRow({
  config,
  isFirst,
  isLast,
  c,
}: {
  config: MenuRowConfig;
  isFirst: boolean;
  isLast: boolean;
  c: typeof Colors.dark;
}) {
  const handlePress = () => {
    if (config.onPress) {
      config.onPress();
    } else {
      Alert.alert("功能开发中", config.label + " 功能尚未实现");
    }
  };

  const badgeColor = config.badge
    ? config.badge.color === "danger"
      ? c.danger
      : config.badge.color === "warn"
        ? c.warn
        : config.badge.color === "ok"
          ? c.ok
          : c.text3
    : c.text3;

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.65}
        onPress={handlePress}
        style={[
          styles.menuRow,
          {
            borderTopLeftRadius: isFirst ? 10 : 0,
            borderTopRightRadius: isFirst ? 10 : 0,
            borderBottomLeftRadius: isLast ? 10 : 0,
            borderBottomRightRadius: isLast ? 10 : 0,
          },
        ]}
      >
        <Text style={[styles.menuRowLabel, { color: c.text }]}>
          {config.label}
        </Text>

        <View style={styles.menuRowRight}>
          {config.badge ? (
            <View
              style={[
                styles.badgeWrap,
                {
                  backgroundColor: badgeColor + "22",
                  borderColor: badgeColor + "66",
                },
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  { color: badgeColor, fontFamily: MONO },
                ]}
              >
                {config.badge.text}
              </Text>
            </View>
          ) : null}

          {config.value ? (
            <Text
              style={[
                styles.menuRowValue,
                { color: c.text3, fontFamily: MONO },
              ]}
            >
              {config.value}
            </Text>
          ) : null}

          {config.toggle ? (
            <Switch
              value={config.toggleValue ?? false}
              onValueChange={handlePress}
              trackColor={{ false: c.line, true: c.ok }}
              thumbColor={c.bgElev}
              style={styles.toggle}
            />
          ) : config.showChevron ? (
            <Text style={[styles.chevron, { color: c.text3 }]}>{"›"}</Text>
          ) : null}
        </View>
      </TouchableOpacity>

      {!isLast && (
        <View style={[styles.separator, { backgroundColor: c.lineSoft }]} />
      )}
    </>
  );
}

function MenuSection({
  label,
  rows,
  c,
}: {
  label: string;
  rows: MenuRowConfig[];
  c: typeof Colors.dark;
}) {
  return (
    <View style={styles.menuSection}>
      <SectionLabel title={label} c={c} />
      <View
        style={[
          styles.menuCard,
          { backgroundColor: c.bgElev, borderColor: c.line },
        ]}
      >
        {rows.map((row, index) => (
          <MenuRow
            key={row.key}
            config={row}
            isFirst={index === 0}
            isLast={index === rows.length - 1}
            c={c}
          />
        ))}
      </View>
    </View>
  );
}

// ─── User Card ────────────────────────────────────────────────────────────────

function UserCard({ c }: { c: typeof Colors.dark }) {
  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={() => Alert.alert("功能开发中", "账户管理功能尚未实现")}
      style={[
        styles.userCard,
        { backgroundColor: c.bgElev, borderColor: c.line },
      ]}
    >
      {/* 头像 */}
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>Z</Text>
      </View>

      {/* 用户信息 */}
      <View style={styles.userInfo}>
        <Text style={[styles.userName, { color: c.text }]}>zero@zpass.app</Text>
        <Text style={[styles.userPlan, { color: c.text3, fontFamily: MONO }]}>
          ZPass 个人版
        </Text>
      </View>

      {/* 箭头 */}
      <Text style={[styles.userChevron, { color: c.text3 }]}>{"›"}</Text>
    </TouchableOpacity>
  );
}

// ─── Space Switcher ───────────────────────────────────────────────────────────

interface SpaceItem {
  key: string;
  label: string;
  active?: boolean;
  muted?: boolean;
}

const SPACES: SpaceItem[] = [
  { key: "personal", label: "私人空间", active: true },
  { key: "work", label: "工作空间" },
  { key: "new", label: "+ 新建空间", muted: true },
];

function SpaceSwitcher({ c }: { c: typeof Colors.dark }) {
  return (
    <View style={styles.menuSection}>
      <SectionLabel title="SPACES · 空间" c={c} />
      <View
        style={[
          styles.menuCard,
          { backgroundColor: c.bgElev, borderColor: c.line },
        ]}
      >
        {SPACES.map((space, index) => {
          const isFirst = index === 0;
          const isLast = index === SPACES.length - 1;

          return (
            <React.Fragment key={space.key}>
              <TouchableOpacity
                activeOpacity={0.65}
                onPress={() =>
                  Alert.alert(
                    "功能开发中",
                    space.key === "new"
                      ? "新建空间功能尚未实现"
                      : `切换到：${space.label}`,
                  )
                }
                style={[
                  styles.menuRow,
                  {
                    borderTopLeftRadius: isFirst ? 10 : 0,
                    borderTopRightRadius: isFirst ? 10 : 0,
                    borderBottomLeftRadius: isLast ? 10 : 0,
                    borderBottomRightRadius: isLast ? 10 : 0,
                  },
                ]}
              >
                <View style={styles.spaceRowLeft}>
                  {space.active ? (
                    <View
                      style={[styles.spaceIndicator, { backgroundColor: c.ok }]}
                    />
                  ) : (
                    <View
                      style={[
                        styles.spaceIndicator,
                        styles.spaceIndicatorEmpty,
                        { borderColor: c.line },
                      ]}
                    />
                  )}
                  <Text
                    style={[
                      styles.menuRowLabel,
                      {
                        color: space.muted
                          ? c.text3
                          : space.active
                            ? c.text
                            : c.text2,
                      },
                    ]}
                  >
                    {space.label}
                  </Text>
                </View>
              </TouchableOpacity>

              {!isLast && (
                <View
                  style={[styles.separator, { backgroundColor: c.lineSoft }]}
                />
              )}
            </React.Fragment>
          );
        })}
      </View>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function MeScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];

  // 主题切换上下文（system / dark / light）
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  const [bioEnabled, setBioEnabled] = React.useState(false);

  // 当前主题在「主题」行右侧显示的文案
  const themeValueLabel = React.useMemo(() => {
    if (themeMode === "system") {
      return `跟随系统（${scheme === "dark" ? "深色" : "浅色"}）`;
    }
    return themeMode === "dark" ? "深色" : "浅色";
  }, [themeMode, scheme]);

  // 弹出 ActionSheet 让用户选择主题模式
  const handleThemePress = React.useCallback(() => {
    const options: { label: string; value: ThemeMode }[] = [
      { label: "跟随系统", value: "system" },
      { label: "深色", value: "dark" },
      { label: "浅色", value: "light" },
    ];

    Alert.alert(
      "选择主题",
      "切换 ZPass 的外观主题",
      [
        ...options.map((opt) => ({
          text: `${opt.label}${themeMode === opt.value ? "（已选）" : ""}`,
          onPress: () => setThemeMode(opt.value),
        })),
        { text: "取消", style: "cancel" as const },
      ],
      { cancelable: true },
    );
  }, [themeMode, setThemeMode]);

  const securityRows: MenuRowConfig[] = [
    {
      key: "autolock",
      label: "自动锁定",
      value: "5分钟",
      showChevron: true,
    },
    {
      key: "biometric",
      label: "生物识别",
      toggle: true,
      toggleValue: bioEnabled,
      onPress: () => setBioEnabled((v) => !v),
    },
    {
      key: "trust",
      label: "信任此设备",
      showChevron: true,
    },
  ];

  const appearanceRows: MenuRowConfig[] = [
    {
      key: "theme",
      label: "主题",
      value: themeValueLabel,
      showChevron: true,
      onPress: handleThemePress,
    },
    {
      key: "language",
      label: "语言",
      value: "中文",
      showChevron: true,
    },
  ];

  const dataRows: MenuRowConfig[] = [
    {
      key: "import",
      label: "导入密码",
      showChevron: true,
    },
    {
      key: "export",
      label: "导出备份",
      showChevron: true,
    },
    {
      key: "scan",
      label: "扫描泄露",
      showChevron: true,
      badge: { text: "3", color: "danger" },
    },
  ];

  const aboutRows: MenuRowConfig[] = [
    {
      key: "about",
      label: "关于 ZPass",
      showChevron: true,
    },
    {
      key: "version",
      label: "版本",
      value: "1.0.0 (build 42)",
    },
  ];

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: c.bg }]}
      edges={["top", "bottom"]}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Page Header ── */}
        <View style={styles.pageHeader}>
          <Text style={[styles.pageTitle, { color: c.text }]}>我的</Text>
        </View>

        {/* ── 用户卡 ── */}
        <UserCard c={c} />

        {/* ── 空间切换 ── */}
        <SpaceSwitcher c={c} />

        {/* ── 安全与隐私 ── */}
        <MenuSection label="SECURITY · 安全与隐私" rows={securityRows} c={c} />

        {/* ── 外观 ── */}
        <MenuSection label="APPEARANCE · 外观" rows={appearanceRows} c={c} />

        {/* ── 数据 ── */}
        <MenuSection label="DATA · 数据" rows={dataRows} c={c} />

        {/* ── 关于 ── */}
        <MenuSection label="ABOUT · 关于" rows={aboutRows} c={c} />

        {/* ── 锁定按钮 ── */}
        <TouchableOpacity
          activeOpacity={0.75}
          onPress={() =>
            Alert.alert("锁定 ZPass", "确认要锁定 ZPass 吗？", [
              { text: "取消", style: "cancel" },
              {
                text: "锁定",
                style: "destructive",
                onPress: () => Alert.alert("功能开发中", "锁定功能尚未实现"),
              },
            ])
          }
          style={[styles.lockButton, { borderColor: c.danger + "88" }]}
        >
          <Text style={[styles.lockButtonText, { color: c.danger }]}>
            锁定 ZPass
          </Text>
        </TouchableOpacity>

        <View style={{ height: 16 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },

  // Page header
  pageHeader: {
    paddingTop: 16,
    paddingBottom: 16,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.3,
  },

  // User card
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 14,
    padding: 20,
    gap: 14,
    marginBottom: 16,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarText: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 28,
  },
  userInfo: {
    flex: 1,
    gap: 3,
  },
  userName: {
    fontSize: 15,
    fontWeight: "600",
  },
  userPlan: {
    fontSize: 11,
  },
  userChevron: {
    fontSize: 22,
    lineHeight: 26,
    marginLeft: 4,
  },

  // Space switcher
  spaceRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  spaceIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  spaceIndicatorEmpty: {
    backgroundColor: "transparent",
    borderWidth: 1.5,
  },

  // Section
  menuSection: {
    marginBottom: 16,
  },
  sectionLabel: {
    fontSize: 9,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 2,
  },
  menuCard: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },

  // Menu row
  menuRow: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 8,
  },
  menuRowLabel: {
    flex: 1,
    fontSize: 15,
  },
  menuRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  menuRowValue: {
    fontSize: 13,
  },
  chevron: {
    fontSize: 20,
    lineHeight: 24,
    marginLeft: 2,
  },
  toggle: {
    transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }],
  },
  separator: {
    height: 1,
    marginLeft: 16,
  },

  // Badge
  badgeWrap: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    minWidth: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.2,
  },

  // Lock button
  lockButton: {
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  lockButtonText: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
});
