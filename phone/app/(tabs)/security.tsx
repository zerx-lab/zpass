import React from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";

const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

// ─── Mock Data ────────────────────────────────────────────────────────────────

type Severity = "critical" | "high" | "medium" | "low";
type Status = "new" | "open" | "clear";

interface BreachItem {
  name: string;
  date: string;
  severity: Severity;
  status: Status;
  affected: string;
  vector: string;
  matched: boolean;
}

const BREACH_ITEMS: BreachItem[] = [
  {
    name: "linear.app",
    date: "2026-04-14",
    severity: "critical",
    status: "new",
    affected: "184k",
    vector: "OAuth token",
    matched: true,
  },
  {
    name: "twitter.com",
    date: "2026-04-02",
    severity: "critical",
    status: "open",
    affected: "209M",
    vector: "API 泄露",
    matched: true,
  },
  {
    name: "notion.so",
    date: "2026-03-28",
    severity: "high",
    status: "open",
    affected: "590k",
    vector: "第三方",
    matched: true,
  },
  {
    name: "duolingo.com",
    date: "2026-02-17",
    severity: "medium",
    status: "clear",
    affected: "2.6M",
    vector: "枚举攻击",
    matched: false,
  },
];

// ─── Score Ring ───────────────────────────────────────────────────────────────

function ScoreRing({ score, c }: { score: number; c: typeof Colors.dark }) {
  return (
    <View style={[styles.ringOuter, { borderColor: c.lineSoft }]}>
      <View style={styles.ringInner}>
        <Text style={[styles.ringScore, { color: c.text, fontFamily: MONO }]}>
          {score}
        </Text>
        <Text style={[styles.ringDenom, { color: c.text3, fontFamily: MONO }]}>
          /100
        </Text>
      </View>
    </View>
  );
}

// ─── Issue Grid Card ──────────────────────────────────────────────────────────

interface IssueCardProps {
  label: string;
  count: number;
  accentColor: string;
  c: typeof Colors.dark;
}

function IssueCard({ label, count, accentColor, c }: IssueCardProps) {
  return (
    <View
      style={[
        styles.issueCard,
        { borderColor: c.line, backgroundColor: c.bgElev },
      ]}
    >
      <Text style={[styles.issueLabel, { color: c.text3, fontFamily: MONO }]}>
        {label}
      </Text>
      <Text
        style={[styles.issueCount, { color: accentColor, fontFamily: MONO }]}
      >
        {count}
      </Text>
    </View>
  );
}

// ─── Breach Row ───────────────────────────────────────────────────────────────

function severityColor(severity: Severity, c: typeof Colors.dark): string {
  switch (severity) {
    case "critical":
      return c.danger;
    case "high":
      return c.warn;
    case "medium":
      return c.text3;
    default:
      return c.text3;
  }
}

function BreachRow({ item, c }: { item: BreachItem; c: typeof Colors.dark }) {
  const isCritical = item.severity === "critical";
  const leftBarColor = severityColor(item.severity, c);

  const cardBg = isCritical
    ? c.danger + "14" // ~8% opacity
    : c.bgElev;
  const cardBorder = isCritical ? c.danger + "55" : c.line;

  const handlePress = () =>
    Alert.alert("泄露详情", item.name + " — 功能开发中");

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={handlePress}
      style={[
        styles.breachRow,
        { backgroundColor: cardBg, borderColor: cardBorder },
      ]}
    >
      {/* 左彩条 */}
      <View style={[styles.breachLeftBar, { backgroundColor: leftBarColor }]} />

      {/* 中间信息 */}
      <View style={styles.breachCenter}>
        <View style={styles.breachNameRow}>
          <Text
            style={[styles.breachDomain, { color: c.text, fontFamily: MONO }]}
          >
            {item.name}
          </Text>
          {item.matched && (
            <View
              style={[
                styles.matchedBadge,
                {
                  backgroundColor: c.danger + "22",
                  borderColor: c.danger + "66",
                },
              ]}
            >
              <Text
                style={[
                  styles.matchedText,
                  { color: c.danger, fontFamily: MONO },
                ]}
              >
                已匹配账户
              </Text>
            </View>
          )}
        </View>

        <Text style={[styles.breachDate, { color: c.text3, fontFamily: MONO }]}>
          {item.date}
        </Text>

        <Text style={[styles.breachMeta, { color: c.text2 }]}>
          <Text style={{ color: c.text3, fontFamily: MONO }}>规模 </Text>
          {item.affected}
          {"  "}
          <Text style={{ color: c.text3, fontFamily: MONO }}>向量 </Text>
          {item.vector}
        </Text>
      </View>

      {/* 右侧状态 badge */}
      <StatusBadge status={item.status} c={c} />
    </TouchableOpacity>
  );
}

function StatusBadge({ status, c }: { status: Status; c: typeof Colors.dark }) {
  if (status === "new") {
    return (
      <View style={[styles.statusBadge, { backgroundColor: c.danger }]}>
        <Text style={[styles.statusText, { color: "#fff", fontFamily: MONO }]}>
          NEW
        </Text>
      </View>
    );
  }
  if (status === "open") {
    return (
      <View
        style={[
          styles.statusBadge,
          styles.statusBadgeOutline,
          { borderColor: c.warn },
        ]}
      >
        <Text style={[styles.statusText, { color: c.warn, fontFamily: MONO }]}>
          OPEN
        </Text>
      </View>
    );
  }
  // clear
  return (
    <View
      style={[
        styles.statusBadge,
        styles.statusBadgeOutline,
        { borderColor: c.text3 },
      ]}
    >
      <Text style={[styles.statusText, { color: c.text3, fontFamily: MONO }]}>
        CLEAR
      </Text>
    </View>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({
  title,
  sub,
  c,
}: {
  title: string;
  sub?: string;
  c: typeof Colors.dark;
}) {
  return (
    <View style={styles.sectionHeaderRow}>
      <Text
        style={[styles.sectionHeaderText, { color: c.text3, fontFamily: MONO }]}
      >
        {title}
      </Text>
      {sub ? (
        <Text
          style={[
            styles.sectionHeaderSub,
            { color: c.text3, fontFamily: MONO },
          ]}
        >
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function SecurityScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];

  const score = 82;

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
        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={[styles.pageTitle, { color: c.text }]}>安全中心</Text>
          <Text
            style={[styles.pageSubtitle, { color: c.text3, fontFamily: MONO }]}
          >
            上次扫描 · 2分钟前
          </Text>
        </View>

        {/* ── 安全评分英雄卡 ── */}
        <View
          style={[
            styles.heroCard,
            { borderColor: c.line, backgroundColor: c.bgElev },
          ]}
        >
          <ScoreRing score={score} c={c} />

          <View style={styles.heroTextCol}>
            <Text style={[styles.heroTitle, { color: c.text2 }]}>安全评分</Text>
            <Text style={[styles.heroScore, { color: c.ok, fontFamily: MONO }]}>
              本周上升 +5 分
            </Text>
            <Text style={[styles.heroHint, { color: c.text3 }]}>
              修复 5 个问题可达到满分
            </Text>
          </View>
        </View>

        {/* ── 问题统计 2×2 网格 ── */}
        <SectionHeader title="ISSUE SUMMARY · 问题概览" c={c} />
        <View style={styles.issueGrid}>
          <IssueCard label="弱密码" count={3} accentColor={c.danger} c={c} />
          <IssueCard label="重复使用" count={2} accentColor={c.warn} c={c} />
          <IssueCard label="超时未换" count={4} accentColor={c.warn} c={c} />
          <IssueCard label="未启用 2FA" count={6} accentColor={c.text2} c={c} />
        </View>

        {/* ── 泄露监控 ── */}
        <SectionHeader
          title="BREACH MONITOR · 泄露监控"
          sub="上次检查 2分钟前"
          c={c}
        />

        <View style={styles.breachList}>
          {BREACH_ITEMS.map((item) => (
            <BreachRow key={item.name} item={item} c={c} />
          ))}
        </View>

        <View style={{ height: 24 }} />
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
    paddingTop: 4,
  },

  // Header
  header: {
    paddingTop: 16,
    paddingBottom: 20,
    gap: 4,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  pageSubtitle: {
    fontSize: 11,
    marginTop: 2,
  },

  // Hero card
  heroCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
    marginBottom: 24,
  },
  heroTextCol: {
    flex: 1,
    gap: 4,
  },
  heroTitle: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  heroScore: {
    fontSize: 13,
    fontWeight: "700",
  },
  heroHint: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },

  // Ring
  ringOuter: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 5,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  ringInner: {
    alignItems: "center",
    justifyContent: "center",
  },
  ringScore: {
    fontSize: 32,
    fontWeight: "700",
    lineHeight: 36,
  },
  ringDenom: {
    fontSize: 11,
    marginTop: -2,
  },

  // Section header
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    marginTop: 2,
  },
  sectionHeaderText: {
    fontSize: 9,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  sectionHeaderSub: {
    fontSize: 9,
  },

  // Issue grid
  issueGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 24,
  },
  issueCard: {
    width: "47.5%",
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  issueLabel: {
    fontSize: 9,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  issueCount: {
    fontSize: 24,
    fontWeight: "700",
  },

  // Breach list
  breachList: {
    gap: 8,
    marginBottom: 8,
  },
  breachRow: {
    flexDirection: "row",
    alignItems: "stretch",
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  breachLeftBar: {
    width: 3,
    borderRadius: 2,
    marginVertical: 12,
    marginLeft: 10,
    marginRight: 2,
    flexShrink: 0,
  },
  breachCenter: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 10,
    gap: 3,
  },
  breachNameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  breachDomain: {
    fontSize: 13,
    fontWeight: "700",
  },
  matchedBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  matchedText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  breachDate: {
    fontSize: 10,
  },
  breachMeta: {
    fontSize: 11,
    marginTop: 2,
  },

  // Status badge
  statusBadge: {
    alignSelf: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 12,
    marginLeft: 4,
    minWidth: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  statusBadgeOutline: {
    backgroundColor: "transparent",
    borderWidth: 1,
  },
  statusText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
