// 安全中心 —— iOS HIG 风格重构
//
// 三大模块：综合分 Hero + Stat Tiles + 泄露监控 + 行动建议 + 分布

import React, { useMemo } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";

import {
  Fonts,
  Radius,
  Spacing,
  Type,
  type ColorPalette,
} from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import type { LoginItem, VaultItem } from "@/data/vault";
import { estimateStrength } from "@/lib/password";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { Badge, Button, PressableScale } from "@/components/ui/primitives";

const MONO = Fonts?.mono ?? "monospace";

/* ── 类型与计算 ─────────────────────────────────────────────── */

type Severity = "breach" | "weak";

interface LoginIssue {
  item: LoginItem;
  password: string;
  strength: number;
  severity: Severity;
  breachCount?: number;
}

interface HealthStats {
  totalLogins: number;
  withPassword: number;
  weak: LoginIssue[];
  score: number;
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

function colorForScore(c: ColorPalette, score: number): string {
  if (score >= 85) return c.ok;
  if (score >= 70) return c.info;
  if (score >= 50) return c.warn;
  return c.danger;
}

/* ── 子组件 ─────────────────────────────────────────────────── */

function StatTile({
  label,
  count,
  iconName,
  c,
  tone,
}: {
  label: string;
  count: number;
  iconName: Parameters<typeof IconSymbol>[0]["name"];
  c: ColorPalette;
  tone: "danger" | "warn" | "neutral";
}) {
  const accent =
    count === 0
      ? c.text2
      : tone === "danger"
        ? c.danger
        : tone === "warn"
          ? c.warn
          : c.text;
  return (
    <View style={[styles.statTile, { backgroundColor: c.bgElev }]}>
      <View style={[styles.statIconBox, { backgroundColor: accent + "1f" }]}>
        <IconSymbol name={iconName} size={16} color={accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.statValue, { color: accent, fontFamily: MONO }]}>
          {count}
        </Text>
        <Text style={[styles.statLabel, { color: c.text3 }]}>{label}</Text>
      </View>
    </View>
  );
}

function SectionCard({
  title,
  iconName,
  trailing,
  children,
  c,
}: {
  title: string;
  iconName?: Parameters<typeof IconSymbol>[0]["name"];
  trailing?: React.ReactNode;
  children?: React.ReactNode;
  c: ColorPalette;
}) {
  return (
    <View style={[styles.sectionCard, { backgroundColor: c.bgElev }]}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderLeft}>
          {iconName ? (
            <IconSymbol name={iconName} size={14} color={c.text3} />
          ) : null}
          <Text style={[styles.sectionTitle, { color: c.text }]}>{title}</Text>
        </View>
        {trailing}
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function IssueRow({
  issue,
  onPress,
  c,
  isLast,
}: {
  issue: LoginIssue;
  onPress: () => void;
  c: ColorPalette;
  isLast: boolean;
}) {
  const glyph = (Array.from(issue.item.name)[0] ?? ".").toUpperCase();
  return (
    <PressableScale
      onPress={onPress}
      scale={0.99}
      haptic="selection"
      pressedBg={c.bgHover}
      style={styles.issueRow}
    >
      <View style={[styles.issueGlyph, { backgroundColor: c.danger + "1f" }]}>
        <Text
          style={[styles.issueGlyphText, { color: c.danger, fontFamily: MONO }]}
        >
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
            : `强度 ${issue.strength}`}
        </Text>
      </View>
      <Badge
        label={issue.severity === "breach" ? "已泄露" : "弱"}
        tone="danger"
      />
      <IconSymbol name="chevron.right" size={14} color={c.text4} />
      {!isLast && (
        <View
          style={[
            styles.rowHairline,
            { backgroundColor: c.lineSoft, left: Spacing.lg + 28 + Spacing.md },
          ]}
        />
      )}
    </PressableScale>
  );
}

function StrengthHistogram({ bins, c }: { bins: number[]; c: ColorPalette }) {
  const max = Math.max(...bins, 1);
  const labels = ["0-20", "20-40", "40-60", "60-80", "80-100"];
  const colors = [c.danger, c.danger, c.warn, c.info, c.ok];
  const BAR_AREA_H = 96;

  return (
    <View style={{ gap: Spacing.md }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: Spacing.sm,
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
                  borderTopLeftRadius: Radius.sm,
                  borderTopRightRadius: Radius.sm,
                  backgroundColor: colors[i],
                  opacity: b === 0 ? 0.2 : 1,
                }}
              />
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", gap: Spacing.sm }}>
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
  const { colors: c } = useTheme();
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

  const breachErrorCount = useMemo(
    () => (breachResults ?? []).filter((r) => r.error).length,
    [breachResults],
  );

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
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: c.bg }]}
      edges={["top"]}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.pageTitle, { color: c.text }]}>安全中心</Text>
          <Text style={[styles.pageLede, { color: c.text3 }]}>
            保险库健康度一览 · 轮换弱密码、清理泄露项
          </Text>
        </View>

        {!hasLogins ? (
          <View style={[styles.emptyState, { backgroundColor: c.bgElev }]}>
            <View style={[styles.emptyIcon, { backgroundColor: c.ok + "1f" }]}>
              <IconSymbol name="checkmark.shield.fill" size={28} color={c.ok} />
            </View>
            <Text style={[styles.emptyTitle, { color: c.text }]}>
              暂无登录条目
            </Text>
            <Text style={[styles.emptyDesc, { color: c.text3 }]}>
              添加一条登录开始追踪保险库健康度
            </Text>
          </View>
        ) : (
          <>
            {/* Hero */}
            <View style={[styles.heroCard, { backgroundColor: c.bgElev }]}>
              <View style={styles.heroTop}>
                <View>
                  <Text style={[styles.heroKicker, { color: c.text3 }]}>
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

                <View style={{ alignItems: "center", gap: 6 }}>
                  <View
                    style={[
                      styles.gradeRing,
                      { backgroundColor: scoreColor + "1f" },
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
                  <Text style={[styles.gradeLabel, { color: c.text3 }]}>
                    {gradeLabel(grade)}
                  </Text>
                </View>
              </View>

              <View
                style={[styles.heroStatsRow, { borderTopColor: c.lineSoft }]}
              >
                <View style={styles.heroStatCol}>
                  <Text style={[styles.heroStatLabel, { color: c.text3 }]}>
                    登录
                  </Text>
                  <Text
                    style={[
                      styles.heroStatValue,
                      { color: c.text, fontFamily: MONO },
                    ]}
                  >
                    {stats.totalLogins}
                  </Text>
                </View>
                <View
                  style={[styles.heroStatDiv, { backgroundColor: c.lineSoft }]}
                />
                <View style={styles.heroStatCol}>
                  <Text style={[styles.heroStatLabel, { color: c.text3 }]}>
                    已泄露
                  </Text>
                  <Text
                    style={[
                      styles.heroStatValue,
                      {
                        color: breachedItems.length > 0 ? c.danger : c.text,
                        fontFamily: MONO,
                      },
                    ]}
                  >
                    {breachResults === null ? "—" : breachedItems.length}
                  </Text>
                </View>
                <View
                  style={[styles.heroStatDiv, { backgroundColor: c.lineSoft }]}
                />
                <View style={styles.heroStatCol}>
                  <Text style={[styles.heroStatLabel, { color: c.text3 }]}>
                    待修复
                  </Text>
                  <Text
                    style={[
                      styles.heroStatValue,
                      { color: c.text, fontFamily: MONO },
                    ]}
                  >
                    {actionItems.length}
                  </Text>
                </View>
              </View>
            </View>

            {/* Stat tiles */}
            <View style={styles.statRow}>
              <StatTile
                label="已泄露"
                count={breachedItems.length}
                iconName="shield.slash.fill"
                tone="danger"
                c={c}
              />
              <StatTile
                label="弱密码"
                count={stats.weak.length}
                iconName="exclamationmark.triangle.fill"
                tone="warn"
                c={c}
              />
            </View>

            {/* 泄露监控 */}
            <SectionCard
              title="泄露监控"
              iconName="magnifyingglass.circle"
              c={c}
              trailing={
                <View style={styles.scanHeaderRight}>
                  {breachLastScanAt != null ? (
                    <Text
                      style={[
                        styles.scanLastAt,
                        { color: c.text3, fontFamily: MONO },
                      ]}
                    >
                      {formatTime(breachLastScanAt)}
                    </Text>
                  ) : null}
                  <Button
                    label={
                      breachScanning
                        ? "扫描中"
                        : breachResults !== null
                          ? "重新扫描"
                          : "扫描"
                    }
                    icon={breachScanning ? undefined : "magnifyingglass"}
                    variant="secondary"
                    size="sm"
                    onPress={() => void runBreachScan(true)}
                    disabled={breachScanning}
                  />
                </View>
              }
            >
              {breachResults === null && !breachScanning ? (
                <View style={styles.scanEmpty}>
                  <IconSymbol
                    name="lock.shield.fill"
                    size={28}
                    color={c.text3}
                  />
                  <Text style={[styles.scanEmptyText, { color: c.text3 }]}>
                    仅发送密码 SHA-1 哈希的前 5 位
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
                  <View
                    style={[
                      styles.scanClearIcon,
                      { backgroundColor: c.ok + "1f" },
                    ]}
                  >
                    <IconSymbol
                      name="checkmark.shield.fill"
                      size={24}
                      color={c.ok}
                    />
                  </View>
                  <Text style={[styles.scanClearText, { color: c.text }]}>
                    未发现泄露
                  </Text>
                  <Text style={[styles.scanClearSub, { color: c.text3 }]}>
                    所有密码均未出现在已知泄露数据中
                  </Text>
                </View>
              ) : breachedItems.length === 0 && breachErrorCount > 0 ? (
                <View style={styles.scanClear}>
                  <View
                    style={[
                      styles.scanClearIcon,
                      { backgroundColor: c.warn + "1f" },
                    ]}
                  >
                    <IconSymbol
                      name="exclamationmark.triangle.fill"
                      size={24}
                      color={c.warn}
                    />
                  </View>
                  <Text style={[styles.scanClearText, { color: c.text }]}>
                    {breachErrorCount} 条扫描失败
                  </Text>
                  <Text style={[styles.scanClearSub, { color: c.text3 }]}>
                    请检查网络后重试
                  </Text>
                </View>
              ) : (
                <View style={{ gap: Spacing.md }}>
                  <View style={styles.scanFoundHeader}>
                    <IconSymbol
                      name="shield.slash.fill"
                      size={16}
                      color={c.danger}
                    />
                    <Text style={[styles.scanFoundText, { color: c.danger }]}>
                      发现 {breachedItems.length} 个密码已泄露
                    </Text>
                  </View>
                  {breachErrorCount > 0 ? (
                    <Text
                      style={[styles.scanPartialErrorText, { color: c.warn }]}
                    >
                      另有 {breachErrorCount} 条扫描失败，建议重试
                    </Text>
                  ) : null}
                  <View
                    style={[styles.innerList, { backgroundColor: c.bgElev2 }]}
                  >
                    {breachedItems.map((r, idx) => {
                      const item = allItems.find((i) => i.id === r.itemId);
                      const name = item?.name ?? r.itemName;
                      const glyph = (Array.from(name)[0] ?? ".").toUpperCase();
                      return (
                        <PressableScale
                          key={r.itemId}
                          onPress={() => onOpenItem(r.itemId)}
                          scale={0.99}
                          haptic="selection"
                          pressedBg={c.bgHover}
                          style={styles.issueRow}
                        >
                          <View
                            style={[
                              styles.issueGlyph,
                              { backgroundColor: c.danger + "1f" },
                            ]}
                          >
                            <Text
                              style={[
                                styles.issueGlyphText,
                                { color: c.danger, fontFamily: MONO },
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
                          <Badge label="已泄露" tone="danger" />
                          <IconSymbol
                            name="chevron.right"
                            size={14}
                            color={c.text4}
                          />
                          {idx !== breachedItems.length - 1 && (
                            <View
                              style={[
                                styles.rowHairline,
                                {
                                  backgroundColor: c.lineSoft,
                                  left: Spacing.lg + 28 + Spacing.md,
                                },
                              ]}
                            />
                          )}
                        </PressableScale>
                      );
                    })}
                  </View>
                </View>
              )}
              <Text
                style={[styles.poweredBy, { color: c.text4, fontFamily: MONO }]}
              >
                由 Have I Been Pwned 提供支持
              </Text>
            </SectionCard>

            {/* 行动建议 */}
            <SectionCard
              title="行动建议"
              c={c}
              iconName="bolt.fill"
              trailing={
                actionItems.length > 0 ? (
                  <Badge
                    label={String(actionItems.length)}
                    tone={actionItems.length > 5 ? "danger" : "warn"}
                  />
                ) : null
              }
            >
              {actionItems.length === 0 ? (
                <View style={styles.actionEmpty}>
                  <View
                    style={[
                      styles.scanClearIcon,
                      { backgroundColor: c.ok + "1f" },
                    ]}
                  >
                    <IconSymbol
                      name="checkmark.shield.fill"
                      size={24}
                      color={c.ok}
                    />
                  </View>
                  <Text style={[styles.actionEmptyText, { color: c.text }]}>
                    全部清理
                  </Text>
                  <Text style={[styles.scanClearSub, { color: c.text3 }]}>
                    暂无紧急问题
                  </Text>
                </View>
              ) : (
                <View
                  style={[styles.innerList, { backgroundColor: c.bgElev2 }]}
                >
                  {actionItems.map((issue, idx) => (
                    <IssueRow
                      key={`${issue.item.id}-${issue.severity}`}
                      issue={issue}
                      onPress={() => onOpenItem(issue.item.id)}
                      c={c}
                      isLast={idx === actionItems.length - 1}
                    />
                  ))}
                </View>
              )}
            </SectionCard>

            {/* 分布 */}
            <SectionCard title="强度分布" iconName="chart.bar.fill" c={c}>
              {stats.withPassword === 0 ? (
                <View style={styles.histEmpty}>
                  <Text style={{ color: c.text3, ...Type.footnote }}>
                    暂无登录条目可统计
                  </Text>
                </View>
              ) : (
                <StrengthHistogram bins={stats.histogram} c={c} />
              )}
            </SectionCard>

            <View style={{ height: Spacing.xl }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ── 样式 ───────────────────────────────────────────────────── */

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xl,
  },

  header: {
    paddingBottom: Spacing.lg,
    gap: Spacing.xs,
  },
  pageTitle: { ...Type.title },
  pageLede: { ...Type.footnote },

  /* Empty */
  emptyState: {
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.xxxl,
    alignItems: "center",
    gap: Spacing.sm,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: Radius.xl,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.sm,
  },
  emptyTitle: { ...Type.title2 },
  emptyDesc: { ...Type.footnote },

  /* Hero */
  heroCard: {
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    gap: Spacing.lg,
    marginBottom: Spacing.md,
  },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  heroKicker: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  heroScoreLine: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: Spacing.xs,
    marginTop: 4,
  },
  heroScore: { fontSize: 56, fontWeight: "700", lineHeight: 60 },
  heroScoreDenom: { fontSize: 15, paddingBottom: 8 },
  gradeRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  gradeText: { fontSize: 22, fontWeight: "700" },
  gradeLabel: {
    ...Type.caption,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  heroStatsRow: {
    flexDirection: "row",
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  heroStatCol: { flex: 1, alignItems: "center", gap: 2 },
  heroStatDiv: { width: StyleSheet.hairlineWidth },
  heroStatLabel: {
    ...Type.caption,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  heroStatValue: { fontSize: 22, fontWeight: "600" },

  /* Stat Tiles */
  statRow: { flexDirection: "row", gap: Spacing.sm, marginBottom: Spacing.md },
  statTile: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    borderRadius: Radius.xl,
    padding: Spacing.md,
  },
  statIconBox: {
    width: 38,
    height: 38,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  statValue: { fontSize: 22, fontWeight: "600", lineHeight: 26 },
  statLabel: { ...Type.footnote, marginTop: 1 },

  /* Section Card */
  sectionCard: {
    borderRadius: Radius.xl,
    marginBottom: Spacing.md,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  sectionHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    flexShrink: 1,
  },
  sectionTitle: { ...Type.headline },
  sectionBody: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
    gap: Spacing.md,
  },

  /* Scan controls */
  scanHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  scanLastAt: { ...Type.caption },
  scanEmpty: {
    paddingVertical: Spacing.xl,
    alignItems: "center",
    gap: Spacing.sm,
  },
  scanEmptyText: {
    ...Type.footnote,
    textAlign: "center",
    maxWidth: 280,
  },
  scanRunning: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: Spacing.sm,
    paddingVertical: Spacing.xl,
  },
  scanRunningText: { ...Type.subhead },
  scanClear: {
    paddingVertical: Spacing.lg,
    alignItems: "center",
    gap: Spacing.xs,
  },
  scanClearIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.xl,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.xs,
  },
  scanClearText: { ...Type.headline },
  scanClearSub: { ...Type.footnote },
  scanFoundHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
  },
  scanFoundText: { ...Type.subhead, fontWeight: "600" },
  scanPartialErrorText: { ...Type.footnote },
  poweredBy: {
    ...Type.caption,
    textAlign: "center",
    letterSpacing: 0.8,
    marginTop: Spacing.xs,
  },

  /* Inner list */
  innerList: {
    borderRadius: Radius.lg,
    overflow: "hidden",
  },

  /* Issue row */
  issueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
  },
  rowHairline: {
    position: "absolute",
    bottom: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  issueGlyph: {
    width: 32,
    height: 32,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  issueGlyphText: { fontSize: 13, fontWeight: "700" },
  issueName: { ...Type.bodyEmph },
  issueSub: { ...Type.footnote, marginTop: 2 },

  /* Action empty */
  actionEmpty: {
    paddingVertical: Spacing.lg,
    alignItems: "center",
    gap: Spacing.xs,
  },
  actionEmptyText: { ...Type.headline },
  histEmpty: {
    height: 96,
    alignItems: "center",
    justifyContent: "center",
  },
});
