import React, { useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useVault } from "@/contexts/vault-context";
import type { Breach, BreachSeverity, LoginItem } from "@/data/vault";

const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

/* 30 天未轮换视为「超时」 */
const STALE_MS = 90 * 24 * 3600 * 1000;

function severityColor(s: BreachSeverity, c: typeof Colors.dark): string {
  if (s === "crit") return c.danger;
  if (s === "high") return c.warn;
  return c.text3;
}

/* ── 子组件 ─────────────────────────────────────────────────── */

function ScoreRing({ score, c }: { score: number; c: typeof Colors.dark }) {
  const ringColor = score >= 80 ? c.ok : score >= 50 ? c.warn : c.danger;
  return (
    <View style={[styles.ringOuter, { borderColor: ringColor }]}>
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

function IssueCard({
  label,
  count,
  accentColor,
  c,
}: {
  label: string;
  count: number;
  accentColor: string;
  c: typeof Colors.dark;
}) {
  return (
    <View style={[styles.issueCard, { borderColor: c.line, backgroundColor: c.bgElev }]}>
      <Text style={[styles.issueLabel, { color: c.text3, fontFamily: MONO }]}>
        {label}
      </Text>
      <Text style={[styles.issueCount, { color: count > 0 ? accentColor : c.text3, fontFamily: MONO }]}>
        {count}
      </Text>
    </View>
  );
}

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
      <Text style={[styles.sectionHeaderText, { color: c.text3, fontFamily: MONO }]}>
        {title}
      </Text>
      {sub ? (
        <Text style={[styles.sectionHeaderSub, { color: c.text3, fontFamily: MONO }]}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

function StatusBadge({
  status,
  c,
}: {
  status: Breach["status"];
  c: typeof Colors.dark;
}) {
  if (status === "new") {
    return (
      <View style={[styles.statusBadge, { backgroundColor: c.danger }]}>
        <Text style={[styles.statusText, { color: "#fff", fontFamily: MONO }]}>NEW</Text>
      </View>
    );
  }
  if (status === "open") {
    return (
      <View style={[styles.statusBadge, styles.statusBadgeOutline, { borderColor: c.warn }]}>
        <Text style={[styles.statusText, { color: c.warn, fontFamily: MONO }]}>OPEN</Text>
      </View>
    );
  }
  const label = status === "resolved" ? "RESOLVED" : "CLEAR";
  return (
    <View style={[styles.statusBadge, styles.statusBadgeOutline, { borderColor: c.text3 }]}>
      <Text style={[styles.statusText, { color: c.text3, fontFamily: MONO }]}>{label}</Text>
    </View>
  );
}

function BreachRow({
  item,
  c,
  onPress,
}: {
  item: Breach;
  c: typeof Colors.dark;
  onPress: () => void;
}) {
  const isCritical = item.severity === "crit";
  const cardBg = isCritical ? c.danger + "14" : c.bgElev;
  const cardBorder = isCritical ? c.danger + "55" : c.line;

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={onPress}
      style={[styles.breachRow, { backgroundColor: cardBg, borderColor: cardBorder }]}
    >
      <View style={[styles.breachLeftBar, { backgroundColor: severityColor(item.severity, c) }]} />
      <View style={styles.breachCenter}>
        <View style={styles.breachNameRow}>
          <Text style={[styles.breachDomain, { color: c.text, fontFamily: MONO }]}>
            {item.name}
          </Text>
          {item.matched > 0 && (
            <View
              style={[
                styles.matchedBadge,
                { backgroundColor: c.danger + "22", borderColor: c.danger + "66" },
              ]}
            >
              <Text style={[styles.matchedText, { color: c.danger, fontFamily: MONO }]}>
                已匹配 {item.matched} 项
              </Text>
            </View>
          )}
        </View>
        <Text style={[styles.breachDate, { color: c.text3, fontFamily: MONO }]}>
          {item.date}
        </Text>
        <Text style={[styles.breachMeta, { color: c.text2 }]}>{item.summary}</Text>
      </View>
      <StatusBadge status={item.status} c={c} />
    </TouchableOpacity>
  );
}

/* ── 主屏 ───────────────────────────────────────────────────── */

export default function SecurityScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const { items, breaches } = useVault();

  // 从真实条目计算安全指标
  const stats = useMemo(() => {
    const logins = items.filter((i): i is LoginItem => i.type === "login");
    const weak = logins.filter(
      (i) => i.weak || (i.strength ?? 100) < 50,
    ).length;
    const reused = logins.filter((i) => i.reused).length;
    const stale = logins.filter((i) => Date.now() - i.modified > STALE_MS).length;
    const no2fa = logins.filter((i) => !i.totp).length;
    const breached = logins.filter((i) => i.breached).length;

    // 评分：满分 100，按问题数量扣分
    let score = 100;
    score -= weak * 8;
    score -= reused * 5;
    score -= stale * 2;
    score -= breached * 10;
    score = Math.max(0, Math.min(100, score));

    return { weak, reused, stale, no2fa, breached, score, total: logins.length };
  }, [items]);

  const activeBreaches = breaches.filter(
    (b) => b.status === "new" || b.status === "open",
  ).length;

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
        <View style={styles.header}>
          <Text style={[styles.pageTitle, { color: c.text }]}>安全中心</Text>
          <Text style={[styles.pageSubtitle, { color: c.text3, fontFamily: MONO }]}>
            已分析 {stats.total} 个登录条目
          </Text>
        </View>

        {/* 安全评分 */}
        <View style={[styles.heroCard, { borderColor: c.line, backgroundColor: c.bgElev }]}>
          <ScoreRing score={stats.score} c={c} />
          <View style={styles.heroTextCol}>
            <Text style={[styles.heroTitle, { color: c.text2 }]}>安全评分</Text>
            <Text
              style={[
                styles.heroScore,
                {
                  color:
                    stats.score >= 80 ? c.ok : stats.score >= 50 ? c.warn : c.danger,
                  fontFamily: MONO,
                },
              ]}
            >
              {stats.score >= 80
                ? "保险库状况良好"
                : stats.score >= 50
                  ? "存在可改进项"
                  : "需要立即处理"}
            </Text>
            <Text style={[styles.heroHint, { color: c.text3 }]}>
              修复弱密码与泄露条目可提升评分
            </Text>
          </View>
        </View>

        {/* 问题统计 */}
        <SectionHeader title="ISSUE SUMMARY · 问题概览" c={c} />
        <View style={styles.issueGrid}>
          <IssueCard label="弱密码" count={stats.weak} accentColor={c.danger} c={c} />
          <IssueCard label="重复使用" count={stats.reused} accentColor={c.warn} c={c} />
          <IssueCard label="超时未换" count={stats.stale} accentColor={c.warn} c={c} />
          <IssueCard label="未启用 2FA" count={stats.no2fa} accentColor={c.text2} c={c} />
        </View>

        {/* 泄露监控 */}
        <SectionHeader
          title="BREACH MONITOR · 泄露监控"
          sub={`${activeBreaches} 个活跃`}
          c={c}
        />
        <View style={styles.breachList}>
          {breaches.map((item) => (
            <BreachRow
              key={item.id}
              item={item}
              c={c}
              onPress={() => {
                if (item.matchedItem) {
                  router.push(`/vault/${item.matchedItem}` as any);
                }
              }}
            />
          ))}
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 4 },

  header: { paddingTop: 16, paddingBottom: 20, gap: 4 },
  pageTitle: { fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  pageSubtitle: { fontSize: 11, marginTop: 2 },

  heroCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
    marginBottom: 24,
  },
  heroTextCol: { flex: 1, gap: 4 },
  heroTitle: { fontSize: 12, fontWeight: "600", letterSpacing: 0.2 },
  heroScore: { fontSize: 13, fontWeight: "700" },
  heroHint: { fontSize: 11, lineHeight: 16, marginTop: 2 },

  ringOuter: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 5,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  ringInner: { alignItems: "center", justifyContent: "center" },
  ringScore: { fontSize: 32, fontWeight: "700", lineHeight: 36 },
  ringDenom: { fontSize: 11, marginTop: -2 },

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
  sectionHeaderSub: { fontSize: 9 },

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
  issueCount: { fontSize: 24, fontWeight: "700" },

  breachList: { gap: 8, marginBottom: 8 },
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
  breachCenter: { flex: 1, paddingVertical: 12, paddingHorizontal: 10, gap: 3 },
  breachNameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  breachDomain: { fontSize: 13, fontWeight: "700" },
  matchedBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  matchedText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.2 },
  breachDate: { fontSize: 10 },
  breachMeta: { fontSize: 11, marginTop: 2, lineHeight: 16 },

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
  statusBadgeOutline: { backgroundColor: "transparent", borderWidth: 1 },
  statusText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
});
