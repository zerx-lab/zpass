// 安全中心 —— 对齐 desktop/electron HealthPage
//
// 三大模块（与 desktop 完全一致）：
//   1. Hero 综合分：大字分数 + A/B/C/D 等级圈 + 三联统计（登录数 / 已泄露 / 立即修复）
//   2. 二格 Stat Tiles：已泄露 + 弱密码
//   3. 泄露监控（HIBP k-anonymity）：扫描按钮 + 4 态切换 + 结果列表
//   4. 行动建议：breach > weak 合并，最多 12 条
//   5. 强度分布直方图：5 桶
//
// 综合分模型（与 desktop computeStats + adjustedScore 对齐）：
//   score = 平均强度（仅有密码的 login）
//   adjustedScore = max(0, score - min(30, breachedCount * 5))
//
// 弱密码阈值：strength < 60（desktop 标准）

import React, { useMemo } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useVault } from "@/contexts/vault-context";
import type { LoginItem, VaultItem } from "@/data/vault";
import { estimateStrength } from "@/lib/password";
import { IconSymbol } from "@/components/ui/icon-symbol";

const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

/* ── 类型与计算 ─────────────────────────────────────────────── */

type Severity = "breach" | "weak";

interface LoginIssue {
  item: LoginItem;
  password: string;
  strength: number;
  severity: Severity;
  /** breach 严重度专用：泄露次数 */
  breachCount?: number;
}

interface HealthStats {
  totalLogins: number;
  withPassword: number;
  weak: LoginIssue[];
  score: number;
  /** 5 桶：0-20 / 20-40 / 40-60 / 60-80 / 80-100 */
  histogram: number[];
}

function computeStats(items: VaultItem[]): HealthStats {
  const logins = items.filter((i): i is LoginItem => i.type === "login");
  const totalLogins = logins.length;

  const enriched = logins.map((it) => {
    const password = typeof it.password === "string" ? it.password : "";
    const strength = password ? estimateStrength(password).score : 0;
    return { item: it, password, strength };
  });

  const withPassword = enriched.filter((e) => e.password.length > 0).length;

  const weak: LoginIssue[] = enriched
    .filter((e) => e.password.length > 0 && e.strength < 60)
    .map((e) => ({
      item: e.item,
      password: e.password,
      strength: e.strength,
      severity: "weak" as const,
    }));

  const histogram = [0, 0, 0, 0, 0];
  for (const e of enriched) {
    if (!e.password) continue;
    const bin = Math.min(4, Math.floor(e.strength / 20));
    histogram[bin] += 1;
  }

  let score = 0;
  if (withPassword > 0) {
    const avg =
      enriched
        .filter((e) => e.password.length > 0)
        .reduce((sum, e) => sum + e.strength, 0) / withPassword;
    score = Math.max(0, Math.min(100, Math.round(avg)));
  }

  return { totalLogins, withPassword, weak, score, histogram };
}

function gradeForScore(score: number): "A" | "B" | "C" | "D" {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  return "D";
}

function gradeLabel(g: "A" | "B" | "C" | "D"): string {
  return g === "A"
    ? "优秀"
    : g === "B"
      ? "良好"
      : g === "C"
        ? "需关注"
        : "存在风险";
}

function colorForScore(c: typeof Colors.dark, score: number): string {
  if (score >= 85) return c.text;
  if (score >= 70) return c.ok;
  if (score >= 50) return c.warn;
  return c.danger;
}

/* ── 子组件 ─────────────────────────────────────────────────── */

function StatTile({
  label,
  count,
  severity,
  iconName,
  c,
}: {
  label: string;
  count: number;
  severity: "high" | "med" | "low";
  iconName: Parameters<typeof IconSymbol>[0]["name"];
  c: typeof Colors.dark;
}) {
  let valueColor = c.text3;
  if (count > 0) {
    valueColor =
      severity === "high" ? c.danger : severity === "med" ? c.warn : c.text;
  }
  return (
    <View
      style={[
        styles.statTile,
        { borderColor: c.line, backgroundColor: c.bgElev },
      ]}
    >
      <View
        style={[
          styles.statIconBox,
          { borderColor: c.line, backgroundColor: c.bgElev2 },
        ]}
      >
        <IconSymbol name={iconName} size={16} color={c.text2} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={[
            styles.statValue,
            { color: valueColor, fontFamily: MONO },
          ]}
        >
          {count}
        </Text>
        <Text style={[styles.statLabel, { color: c.text3 }]}>{label}</Text>
      </View>
    </View>
  );
}

function SectionCardHeader({
  title,
  trailing,
  c,
  iconName,
}: {
  title: string;
  trailing?: React.ReactNode;
  c: typeof Colors.dark;
  iconName?: Parameters<typeof IconSymbol>[0]["name"];
}) {
  return (
    <View
      style={[
        styles.sectionCardHeader,
        { borderBottomColor: c.lineSoft },
      ]}
    >
      <View style={styles.sectionCardHeaderLeft}>
        {iconName ? (
          <IconSymbol name={iconName} size={13} color={c.text3} />
        ) : null}
        <Text style={[styles.sectionCardHeaderTitle, { color: c.text }]}>
          {title}
        </Text>
      </View>
      {trailing}
    </View>
  );
}

function IssueRow({
  issue,
  onPress,
  c,
}: {
  issue: LoginIssue;
  onPress: () => void;
  c: typeof Colors.dark;
}) {
  const glyph = (Array.from(issue.item.name)[0] ?? "·").toUpperCase();
  const sevLabel = issue.severity === "breach" ? "已泄露" : "弱";
  // breach 与 weak 都是高危红
  const sevColor = c.danger;
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={styles.issueRow}
    >
      <View
        style={[
          styles.issueGlyph,
          { borderColor: c.line, backgroundColor: c.bgElev2 },
        ]}
      >
        <Text style={[styles.issueGlyphText, { color: c.text, fontFamily: MONO }]}>
          {glyph}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.issueName, { color: c.text }]} numberOfLines={1}>
          {issue.item.name}
        </Text>
        <Text
          style={[styles.issueSub, { color: c.text3, fontFamily: MONO }]}
          numberOfLines={1}
        >
          {issue.severity === "breach"
            ? `已暴露 ${issue.breachCount ?? 0} 次`
            : issue.password
              ? `score ${issue.strength}`
              : "—"}
        </Text>
      </View>
      <View
        style={[
          styles.issueBadge,
          { borderColor: sevColor },
        ]}
      >
        <Text style={[styles.issueBadgeText, { color: sevColor, fontFamily: MONO }]}>
          {sevLabel}
        </Text>
      </View>
      <Text style={[styles.issueArrow, { color: c.text4, fontFamily: MONO }]}>
        →
      </Text>
    </TouchableOpacity>
  );
}

function StrengthHistogram({
  bins,
  c,
}: {
  bins: number[];
  c: typeof Colors.dark;
}) {
  const max = Math.max(...bins, 1);
  const labels = ["0-20", "20-40", "40-60", "60-80", "80-100"];
  const colors = [c.danger, c.danger, c.warn, c.text2, c.text];
  const BAR_AREA_H = 96;

  return (
    <View style={{ gap: 12 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 8,
          height: BAR_AREA_H,
        }}
      >
        {bins.map((b, i) => {
          const barH = Math.max(3, Math.round((b / max) * BAR_AREA_H));
          return (
            <View
              key={i}
              style={{
                flex: 1,
                height: BAR_AREA_H,
                justifyContent: "flex-end",
                alignItems: "center",
                position: "relative",
              }}
            >
              <Text
                style={{
                  position: "absolute",
                  bottom: barH + 4,
                  fontFamily: MONO,
                  fontSize: 10,
                  color: c.text2,
                }}
              >
                {b}
              </Text>
              <View
                style={{
                  width: "100%",
                  height: barH,
                  borderTopLeftRadius: 3,
                  borderTopRightRadius: 3,
                  backgroundColor: colors[i],
                  opacity: b === 0 ? 0.25 : 1,
                }}
              />
            </View>
          );
        })}
      </View>
      <View style={{ height: 1, backgroundColor: c.line }} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        {labels.map((lbl) => (
          <View key={lbl} style={{ flex: 1, alignItems: "center" }}>
            <Text
              style={{
                fontFamily: MONO,
                fontSize: 9,
                color: c.text4,
                letterSpacing: 0.4,
              }}
            >
              {lbl}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ── 主屏 ───────────────────────────────────────────────────── */

export default function SecurityScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const {
    allItems,
    breachResults,
    breachScanning,
    breachLastScanAt,
    runBreachScan,
  } = useVault();

  const stats = useMemo(() => computeStats(allItems), [allItems]);

  const breachedItems = useMemo(
    () => (breachResults ?? []).filter((r) => r.pwned && r.count > 0),
    [breachResults],
  );

  // 单条扫描失败（断网 / HIBP 拒绝）的数量。完全失败时绝对不能展示"无泄露"
  // 绿盾，否则用户会误以为安全。
  const breachErrorCount = useMemo(
    () => (breachResults ?? []).filter((r) => r.error).length,
    [breachResults],
  );

  // breach 结果转 LoginIssue（合并到行动建议）
  const breachIssues: LoginIssue[] = useMemo(() => {
    return breachedItems
      .map<LoginIssue | null>((r) => {
        const item = allItems.find(
          (i): i is LoginItem => i.id === r.itemId && i.type === "login",
        );
        if (!item) return null;
        const password = typeof item.password === "string" ? item.password : "";
        const strength = password ? estimateStrength(password).score : 0;
        return {
          item,
          password,
          strength,
          severity: "breach" as const,
          breachCount: r.count,
        };
      })
      .filter((x): x is LoginIssue => x !== null);
  }, [breachedItems, allItems]);

  const actionItems = useMemo(() => {
    const seen = new Set<string>();
    const ranked: LoginIssue[] = [];
    for (const issue of breachIssues) {
      if (seen.has(issue.item.id)) continue;
      seen.add(issue.item.id);
      ranked.push(issue);
    }
    for (const issue of stats.weak) {
      if (seen.has(issue.item.id)) continue;
      seen.add(issue.item.id);
      ranked.push(issue);
    }
    return ranked.slice(0, 12);
  }, [breachIssues, stats.weak]);

  // adjustedScore = 平均强度 - min(30, breached*5)
  const adjustedScore = useMemo(() => {
    if (breachedItems.length === 0) return stats.score;
    const penalty = Math.min(30, breachedItems.length * 5);
    return Math.max(0, stats.score - penalty);
  }, [stats.score, breachedItems.length]);

  const grade = gradeForScore(adjustedScore);
  const scoreColor = colorForScore(c, adjustedScore);
  const hasLogins = stats.totalLogins > 0;

  const onOpenItem = (id: string) => {
    router.push(`/vault/${id}` as any);
  };

  const formatTime = (ts: number) => {
    // 手写 HH:MM 而不依赖 toLocaleTimeString —— Hermes 默认 build 不带完整 Intl，
    // 不同设备 / locale 下行为不一致；自己格式化更可控
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };

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
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerKicker}>
            <IconSymbol name="checkmark.shield.fill" size={12} color={c.text4} />
            <Text style={[styles.headerKickerText, { color: c.text4, fontFamily: MONO }]}>
              安全
            </Text>
          </View>
          <Text style={[styles.pageTitle, { color: c.text }]}>安全中心</Text>
          <Text style={[styles.pageLede, { color: c.text2 }]}>
            保险库健康度一览。
            <Text style={{ color: c.text }}>轮换弱密码、清理泄露项。</Text>
          </Text>
        </View>

        {!hasLogins ? (
          /* 空态：完全没有 login 条目 */
          <View
            style={[
              styles.emptyState,
              { borderColor: c.line, backgroundColor: c.bgElev },
            ]}
          >
            <IconSymbol name="checkmark.shield.fill" size={32} color={c.text3} />
            <Text style={[styles.emptyStateText, { color: c.text2 }]}>
              添加一条登录开始追踪保险库健康度。
            </Text>
          </View>
        ) : (
          <>
            {/* ===================== Hero：综合分 ===================== */}
            <View
              style={[
                styles.heroCard,
                { borderColor: c.line, backgroundColor: c.bgElev },
              ]}
            >
              <View style={styles.heroTopRow}>
                {/* 大数字分 */}
                <View>
                  <Text
                    style={[
                      styles.heroKicker,
                      { color: c.text4, fontFamily: MONO },
                    ]}
                  >
                    综合评分
                  </Text>
                  <View style={styles.heroScoreLine}>
                    <Text
                      style={[
                        styles.heroScore,
                        { color: scoreColor, fontFamily: MONO },
                      ]}
                    >
                      {adjustedScore}
                    </Text>
                    <Text
                      style={[
                        styles.heroScoreDenom,
                        { color: c.text3, fontFamily: MONO },
                      ]}
                    >
                      /100
                    </Text>
                  </View>
                </View>

                {/* 等级圈 */}
                <View style={{ alignItems: "center", gap: 4 }}>
                  <View
                    style={[
                      styles.gradeRing,
                      { borderColor: scoreColor },
                    ]}
                  >
                    <Text
                      style={[
                        styles.gradeText,
                        { color: scoreColor, fontFamily: MONO },
                      ]}
                    >
                      {grade}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.gradeLabel,
                      { color: c.text3, fontFamily: MONO },
                    ]}
                  >
                    {gradeLabel(grade)}
                  </Text>
                </View>
              </View>

              {/* 关键统计行 */}
              <View style={styles.heroStatsRow}>
                <View>
                  <Text style={[styles.heroStatKicker, { color: c.text4, fontFamily: MONO }]}>
                    登录条目
                  </Text>
                  <Text style={[styles.heroStatValue, { color: c.text, fontFamily: MONO }]}>
                    {stats.totalLogins}
                  </Text>
                </View>
                <View>
                  <Text style={[styles.heroStatKicker, { color: c.text4, fontFamily: MONO }]}>
                    已泄露
                  </Text>
                  <Text
                    style={[
                      styles.heroStatValue,
                      {
                        color:
                          breachedItems.length > 0 ? c.danger : c.text,
                        fontFamily: MONO,
                      },
                    ]}
                  >
                    {breachResults === null ? "—" : breachedItems.length}
                  </Text>
                </View>
                <View>
                  <Text style={[styles.heroStatKicker, { color: c.text4, fontFamily: MONO }]}>
                    立即修复
                  </Text>
                  <Text style={[styles.heroStatValue, { color: c.text, fontFamily: MONO }]}>
                    {actionItems.length}
                  </Text>
                </View>
              </View>

              <Text style={[styles.heroDesc, { color: c.text3 }]}>
                基于密码强度与 HIBP 泄露记录计算。
              </Text>
            </View>

            {/* ===================== 二格 Stat Tiles ===================== */}
            <View style={styles.statRow}>
              <StatTile
                label="已泄露"
                count={breachedItems.length}
                severity="high"
                iconName="shield.slash.fill"
                c={c}
              />
              <StatTile
                label="弱密码"
                count={stats.weak.length}
                severity="high"
                iconName="exclamationmark.triangle.fill"
                c={c}
              />
            </View>

            {/* ===================== 泄露监控 ===================== */}
            <View
              style={[
                styles.sectionCard,
                { borderColor: c.line, backgroundColor: c.bgElev },
              ]}
            >
              <SectionCardHeader
                title="泄露监控"
                iconName="magnifyingglass.circle"
                c={c}
                trailing={
                  <View style={styles.scanHeaderRight}>
                    {breachLastScanAt != null ? (
                      <Text
                        style={[
                          styles.scanLastAt,
                          { color: c.text4, fontFamily: MONO },
                        ]}
                      >
                        上次 {formatTime(breachLastScanAt)}
                      </Text>
                    ) : null}
                    <TouchableOpacity
                      disabled={breachScanning}
                      onPress={() => void runBreachScan(true)}
                      activeOpacity={0.7}
                      style={[
                        styles.scanButton,
                        {
                          borderColor: c.line,
                          backgroundColor: c.bgElev2,
                          opacity: breachScanning ? 0.6 : 1,
                        },
                      ]}
                    >
                      {breachScanning ? (
                        <ActivityIndicator size="small" color={c.text2} />
                      ) : (
                        <IconSymbol
                          name="magnifyingglass.circle"
                          size={14}
                          color={c.text2}
                        />
                      )}
                      <Text
                        style={[
                          styles.scanButtonText,
                          { color: c.text2 },
                        ]}
                      >
                        {breachScanning
                          ? "正在扫描…"
                          : breachResults !== null
                            ? "重新扫描"
                            : "扫描密码"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                }
              />
              <View style={styles.sectionCardBody}>
                {breachResults === null && !breachScanning ? (
                  /* 从未扫描过 */
                  <View style={styles.scanEmpty}>
                    <IconSymbol
                      name="magnifyingglass.circle"
                      size={28}
                      color={c.text3}
                    />
                    <Text
                      style={[styles.scanEmptyText, { color: c.text3 }]}
                    >
                      仅发送密码 SHA-1 哈希的前 5 位 — HIBP 无法得知你的真实密码。
                    </Text>
                  </View>
                ) : breachScanning ? (
                  <View style={styles.scanRunning}>
                    <ActivityIndicator size="small" color={c.text3} />
                    <Text
                      style={[
                        styles.scanRunningText,
                        { color: c.text3, fontFamily: MONO },
                      ]}
                    >
                      正在扫描…
                    </Text>
                  </View>
                ) : breachedItems.length === 0 && breachErrorCount === 0 ? (
                  <View style={styles.scanClear}>
                    <IconSymbol
                      name="checkmark.shield.fill"
                      size={24}
                      color={c.ok}
                    />
                    <Text style={[styles.scanClearText, { color: c.text2 }]}>
                      未发现任何密码出现在已知泄露数据中
                    </Text>
                  </View>
                ) : breachedItems.length === 0 && breachErrorCount > 0 ? (
                  /* 全部失败：没有 pwned，但 errorCount>0 —— 绝不能展示绿盾。
                   * 多为断网或 HIBP 5xx；提示用户重试，避免误判为"安全"。 */
                  <View style={styles.scanClear}>
                    <IconSymbol
                      name="exclamationmark.triangle.fill"
                      size={24}
                      color={c.warn}
                    />
                    <Text style={[styles.scanClearText, { color: c.text2 }]}>
                      {breachErrorCount} 条扫描失败 · 请检查网络后重试
                    </Text>
                  </View>
                ) : (
                  <View style={{ gap: 12 }}>
                    <View style={styles.scanFoundHeader}>
                      <IconSymbol
                        name="shield.slash.fill"
                        size={14}
                        color={c.danger}
                      />
                      <Text style={[styles.scanFoundText, { color: c.danger }]}>
                        发现 {breachedItems.length} 个密码出现在已知泄露数据中
                      </Text>
                    </View>
                    {breachErrorCount > 0 ? (
                      <Text
                        style={[
                          styles.scanPartialErrorText,
                          { color: c.warn },
                        ]}
                      >
                        另有 {breachErrorCount} 条扫描失败，建议重试
                      </Text>
                    ) : null}
                    <View
                      style={[
                        styles.innerList,
                        { borderColor: c.line, backgroundColor: c.bgElev },
                      ]}
                    >
                      {breachedItems.map((r) => {
                        const item = allItems.find((i) => i.id === r.itemId);
                        const name = item?.name ?? r.itemName;
                        const glyph = (Array.from(name)[0] ?? "·").toUpperCase();
                        return (
                          <TouchableOpacity
                            key={r.itemId}
                            activeOpacity={0.7}
                            onPress={() => onOpenItem(r.itemId)}
                            style={styles.issueRow}
                          >
                            <View
                              style={[
                                styles.issueGlyph,
                                { borderColor: c.line, backgroundColor: c.bgElev2 },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.issueGlyphText,
                                  { color: c.text, fontFamily: MONO },
                                ]}
                              >
                                {glyph}
                              </Text>
                            </View>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text
                                style={[styles.issueName, { color: c.text }]}
                                numberOfLines={1}
                              >
                                {name}
                              </Text>
                              <Text
                                style={[
                                  styles.issueSub,
                                  { color: c.text3, fontFamily: MONO },
                                ]}
                                numberOfLines={1}
                              >
                                已暴露 {r.count} 次
                              </Text>
                            </View>
                            <View
                              style={[styles.issueBadge, { borderColor: c.danger }]}
                            >
                              <Text
                                style={[
                                  styles.issueBadgeText,
                                  { color: c.danger, fontFamily: MONO },
                                ]}
                              >
                                已泄露
                              </Text>
                            </View>
                            <Text
                              style={[
                                styles.issueArrow,
                                { color: c.text4, fontFamily: MONO },
                              ]}
                            >
                              →
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
                <Text
                  style={[
                    styles.poweredBy,
                    { color: c.text4, fontFamily: MONO },
                  ]}
                >
                  由 Have I Been Pwned 提供支持
                </Text>
              </View>
            </View>

            {/* ===================== 行动建议 ===================== */}
            <View
              style={[
                styles.sectionCard,
                { borderColor: c.line, backgroundColor: c.bgElev },
              ]}
            >
              <SectionCardHeader
                title="行动建议"
                c={c}
                trailing={
                  <Text
                    style={[
                      styles.sectionCardCount,
                      { color: c.text3, fontFamily: MONO },
                    ]}
                  >
                    {actionItems.length}
                  </Text>
                }
              />
              {actionItems.length === 0 ? (
                <View style={styles.actionEmpty}>
                  <IconSymbol
                    name="checkmark.shield.fill"
                    size={22}
                    color={c.ok}
                  />
                  <Text
                    style={[styles.actionEmptyText, { color: c.text3 }]}
                  >
                    全部清理 · 暂无紧急问题
                  </Text>
                </View>
              ) : (
                <View style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
                  {actionItems.map((issue) => (
                    <IssueRow
                      key={`${issue.item.id}-${issue.severity}`}
                      issue={issue}
                      onPress={() => onOpenItem(issue.item.id)}
                      c={c}
                    />
                  ))}
                </View>
              )}
            </View>

            {/* ===================== 强度分布 ===================== */}
            <View
              style={[
                styles.sectionCard,
                { borderColor: c.line, backgroundColor: c.bgElev },
              ]}
            >
              <SectionCardHeader
                title="分布"
                iconName="chart.bar.fill"
                c={c}
              />
              <View style={styles.sectionCardBody}>
                {stats.withPassword === 0 ? (
                  <View style={styles.histEmpty}>
                    <Text style={{ color: c.text3, fontSize: 12 }}>
                      暂无登录条目可统计
                    </Text>
                  </View>
                ) : (
                  <StrengthHistogram bins={stats.histogram} c={c} />
                )}
              </View>
            </View>

            <View style={{ height: 24 }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ── 样式 ───────────────────────────────────────────────────── */

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 },

  /* Header */
  header: { paddingTop: 16, paddingBottom: 18, gap: 6 },
  headerKicker: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerKickerText: {
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  pageLede: { fontSize: 13, lineHeight: 18 },

  /* Empty */
  emptyState: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 48,
    alignItems: "center",
    gap: 12,
  },
  emptyStateText: { fontSize: 13, textAlign: "center" },

  /* Hero */
  heroCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 20,
    gap: 16,
    marginBottom: 14,
  },
  heroTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  heroKicker: {
    fontSize: 10.5,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  heroScoreLine: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
    marginTop: 4,
  },
  heroScore: { fontSize: 52, fontWeight: "700", lineHeight: 56 },
  heroScoreDenom: { fontSize: 14, paddingBottom: 6 },
  gradeRing: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  gradeText: { fontSize: 18, fontWeight: "700" },
  gradeLabel: {
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  heroStatsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 2,
  },
  heroStatKicker: {
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  heroStatValue: { fontSize: 20, fontWeight: "600" },
  heroDesc: { fontSize: 12, lineHeight: 17 },

  /* Stat Tiles */
  statRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  statTile: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  statIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  statValue: { fontSize: 22, fontWeight: "600", lineHeight: 26 },
  statLabel: { fontSize: 11, marginTop: 1 },

  /* Section Card */
  sectionCard: {
    borderWidth: 1,
    borderRadius: 14,
    marginBottom: 14,
    overflow: "hidden",
  },
  sectionCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  sectionCardHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
  },
  sectionCardHeaderTitle: { fontSize: 13, fontWeight: "500" },
  sectionCardCount: {
    fontSize: 10.5,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  sectionCardBody: { paddingHorizontal: 16, paddingVertical: 14, gap: 12 },

  /* Scan controls */
  scanHeaderRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  scanLastAt: { fontSize: 10.5 },
  scanButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 8,
  },
  scanButtonText: { fontSize: 11, fontWeight: "500" },
  scanEmpty: {
    paddingVertical: 24,
    alignItems: "center",
    gap: 10,
  },
  scanEmptyText: {
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
    maxWidth: 280,
  },
  scanRunning: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    paddingVertical: 24,
  },
  scanRunningText: { fontSize: 12 },
  scanClear: {
    paddingVertical: 24,
    alignItems: "center",
    gap: 8,
  },
  scanClearText: { fontSize: 12 },
  scanFoundHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  scanFoundText: { fontSize: 12, fontWeight: "500" },
  scanPartialErrorText: { fontSize: 11, lineHeight: 15 },
  poweredBy: {
    fontSize: 10,
    textAlign: "center",
    letterSpacing: 0.8,
    marginTop: 4,
  },

  /* Inner list (within section card body) */
  innerList: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },

  /* Issue row */
  issueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  issueGlyph: {
    width: 28,
    height: 28,
    borderRadius: 7,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  issueGlyphText: { fontSize: 11, fontWeight: "600" },
  issueName: { fontSize: 13, fontWeight: "500" },
  issueSub: { fontSize: 10.5, marginTop: 2 },
  issueBadge: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  issueBadgeText: {
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontWeight: "700",
  },
  issueArrow: { fontSize: 11 },

  /* Action / histogram empty */
  actionEmpty: {
    paddingVertical: 36,
    alignItems: "center",
    gap: 8,
  },
  actionEmptyText: { fontSize: 13 },
  histEmpty: {
    height: 96,
    alignItems: "center",
    justifyContent: "center",
  },
});
