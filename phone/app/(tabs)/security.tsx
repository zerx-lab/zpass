// 安全中心 —— 基于真实保险库数据生成审计指标
//
// 与 desktop 安全 Tab 对齐：弱密码 / 重复使用 / 过期未轮换 / 未启用 2FA。
// 不再展示任何 mock breach feed —— 当用户启用云端漏洞监控（HIBP）后
// 再接入真实数据。当前空态显示"未配置在线泄露监控"。

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
import type { LoginItem } from "@/data/vault";
import { estimateStrength } from "@/lib/password";

const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

/* 90 天未轮换视为「超时」 */
const STALE_MS = 90 * 24 * 3600 * 1000;

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
  onPress,
}: {
  label: string;
  count: number;
  accentColor: string;
  c: typeof Colors.dark;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={onPress ? 0.7 : 1}
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.issueCard,
        { borderColor: c.line, backgroundColor: c.bgElev },
      ]}
    >
      <Text style={[styles.issueLabel, { color: c.text3, fontFamily: MONO }]}>
        {label}
      </Text>
      <Text
        style={[
          styles.issueCount,
          { color: count > 0 ? accentColor : c.text3, fontFamily: MONO },
        ]}
      >
        {count}
      </Text>
    </TouchableOpacity>
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

/* ── 主屏 ───────────────────────────────────────────────────── */

interface Issue {
  id: string;
  name: string;
  kind: "weak" | "reused" | "stale" | "no2fa";
  detail: string;
}

export default function SecurityScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const { items } = useVault();

  const { stats, issues } = useMemo(() => computeAudit(items), [items]);

  const showWeak = issues.weak.length;
  const showReused = issues.reused.length;
  const showStale = issues.stale.length;
  const showNo2fa = issues.no2fa.length;
  const hasAny = showWeak || showReused || showStale || showNo2fa;

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

        {/* 评分卡 */}
        <View
          style={[
            styles.heroCard,
            { borderColor: c.line, backgroundColor: c.bgElev },
          ]}
        >
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
              {stats.total === 0
                ? "暂无登录条目"
                : stats.score >= 80
                  ? "保险库状况良好"
                  : stats.score >= 50
                    ? "存在可改进项"
                    : "需要立即处理"}
            </Text>
            <Text style={[styles.heroHint, { color: c.text3 }]}>
              修复弱密码与启用 2FA 可提升评分
            </Text>
          </View>
        </View>

        {/* 问题统计 */}
        <SectionHeader title="ISSUE SUMMARY · 问题概览" c={c} />
        <View style={styles.issueGrid}>
          <IssueCard label="弱密码" count={showWeak} accentColor={c.danger} c={c} />
          <IssueCard label="重复使用" count={showReused} accentColor={c.warn} c={c} />
          <IssueCard label="超时未换" count={showStale} accentColor={c.warn} c={c} />
          <IssueCard label="未启用 2FA" count={showNo2fa} accentColor={c.text2} c={c} />
        </View>

        {/* 待处理清单 */}
        {hasAny ? (
          <>
            <SectionHeader
              title="ACTION ITEMS · 待处理"
              sub={`${showWeak + showReused + showStale + showNo2fa} 项`}
              c={c}
            />
            <View style={styles.issueList}>
              {issues.weak.slice(0, 5).map((i) => (
                <IssueRow
                  key={`weak-${i.id}`}
                  issue={i}
                  color={c.danger}
                  label="弱密码"
                  c={c}
                />
              ))}
              {issues.reused.slice(0, 5).map((i) => (
                <IssueRow
                  key={`reused-${i.id}`}
                  issue={i}
                  color={c.warn}
                  label="重复使用"
                  c={c}
                />
              ))}
              {issues.stale.slice(0, 5).map((i) => (
                <IssueRow
                  key={`stale-${i.id}`}
                  issue={i}
                  color={c.warn}
                  label="超时未换"
                  c={c}
                />
              ))}
              {issues.no2fa.slice(0, 5).map((i) => (
                <IssueRow
                  key={`no2fa-${i.id}`}
                  issue={i}
                  color={c.text2}
                  label="未启用 2FA"
                  c={c}
                />
              ))}
            </View>
          </>
        ) : null}

        {/* 泄露监控占位（云端模式接入 HIBP 后展示） */}
        <SectionHeader title="BREACH MONITOR · 泄露监控" c={c} />
        <View
          style={[
            styles.emptyCard,
            { borderColor: c.line, backgroundColor: c.bgElev },
          ]}
        >
          <Text style={[styles.emptyTitle, { color: c.text2 }]}>
            本地模式下不进行在线泄露查询
          </Text>
          <Text style={[styles.emptyText, { color: c.text3 }]}>
            云端模式（开发中）将通过 HIBP k-anonymity 协议匿名核对密码哈希前 5 位，
            零知识地查询是否出现在已知泄露事件中。
          </Text>
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function IssueRow({
  issue,
  color,
  label,
  c,
}: {
  issue: Issue;
  color: string;
  label: string;
  c: typeof Colors.dark;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => router.push(`/vault/${issue.id}` as any)}
      style={[
        styles.issueRow,
        { borderColor: c.line, backgroundColor: c.bgElev },
      ]}
    >
      <View style={[styles.issueBar, { backgroundColor: color }]} />
      <View style={styles.issueContent}>
        <Text style={[styles.issueName, { color: c.text }]} numberOfLines={1}>
          {issue.name}
        </Text>
        <Text style={[styles.issueDetail, { color: c.text3 }]} numberOfLines={1}>
          {issue.detail}
        </Text>
      </View>
      <View
        style={[
          styles.issueBadge,
          { borderColor: color + "55", backgroundColor: color + "1a" },
        ]}
      >
        <Text style={[styles.issueBadgeText, { color, fontFamily: MONO }]}>
          {label}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

/* ── 审计计算 ───────────────────────────────────────────────── */

function computeAudit(items: ReturnType<typeof useVault>["items"]) {
  const logins = items.filter((i): i is LoginItem => i.type === "login");

  // 通过密码哈希分组检测重复
  const passwordGroups = new Map<string, LoginItem[]>();
  for (const l of logins) {
    if (!l.password) continue;
    const key = l.password;
    const arr = passwordGroups.get(key) ?? [];
    arr.push(l);
    passwordGroups.set(key, arr);
  }
  const reusedSet = new Set<string>();
  for (const [, arr] of passwordGroups) {
    if (arr.length > 1) for (const it of arr) reusedSet.add(it.id);
  }

  const weak: Issue[] = [];
  const reused: Issue[] = [];
  const stale: Issue[] = [];
  const no2fa: Issue[] = [];

  for (const l of logins) {
    const strength = l.password ? estimateStrength(l.password).score : 0;
    if (l.password && strength < 50) {
      weak.push({
        id: l.id,
        name: l.name,
        kind: "weak",
        detail: l.username || "无用户名",
      });
    }
    if (reusedSet.has(l.id)) {
      reused.push({
        id: l.id,
        name: l.name,
        kind: "reused",
        detail: "密码与其他条目相同",
      });
    }
    if (l.modified && Date.now() - l.modified > STALE_MS) {
      stale.push({
        id: l.id,
        name: l.name,
        kind: "stale",
        detail: "90 天以上未修改",
      });
    }
    if (!l.totp) {
      no2fa.push({
        id: l.id,
        name: l.name,
        kind: "no2fa",
        detail: l.username || "未配置 2FA",
      });
    }
  }

  // 评分：100 - 各类问题占比加权
  let score = 100;
  score -= weak.length * 8;
  score -= reused.length * 5;
  score -= stale.length * 2;
  // 未启用 2FA 不应该让总分降太多（多数账户也不开 2FA），权重轻一些
  score -= Math.min(no2fa.length, 5) * 2;
  if (logins.length === 0) score = 0;
  score = Math.max(0, Math.min(100, score));

  return {
    stats: { score, total: logins.length },
    issues: { weak, reused, stale, no2fa },
  };
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

  issueList: { gap: 8, marginBottom: 24 },
  issueRow: {
    flexDirection: "row",
    alignItems: "stretch",
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  issueBar: {
    width: 3,
    borderRadius: 2,
    marginVertical: 10,
    marginLeft: 10,
    marginRight: 2,
  },
  issueContent: { flex: 1, paddingVertical: 12, paddingHorizontal: 10, gap: 3 },
  issueName: { fontSize: 13, fontWeight: "600" },
  issueDetail: { fontSize: 11 },
  issueBadge: {
    alignSelf: "center",
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 10,
  },
  issueBadgeText: { fontSize: 10, fontWeight: "700" },

  emptyCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 6,
    marginBottom: 8,
  },
  emptyTitle: { fontSize: 13, fontWeight: "600" },
  emptyText: { fontSize: 12, lineHeight: 17 },
});
