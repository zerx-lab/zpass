import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
  Clipboard,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { MOCK_ITEMS } from "@/app/(tabs)/vault";
import { IconSymbol } from "@/components/ui/icon-symbol";

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────
const MONO = Platform.select({ ios: "Courier New", default: "monospace" });

const MOCK_PASSWORD = "Zx#9qL2!mPr$vK7w";

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────
function strengthLabel(s: number): string {
  if (s >= 90) return "极强";
  if (s >= 75) return "强";
  if (s >= 50) return "中等";
  if (s >= 25) return "弱";
  return "极弱";
}

function strengthColor(
  s: number,
  danger: string,
  warn: string,
  ok: string,
): string {
  if (s >= 80) return ok;
  if (s >= 50) return warn;
  return danger;
}

function entropyFromStrength(s: number): number {
  return Math.round((s / 100) * 128);
}

function crackTime(s: number): string {
  if (s >= 90) return "数百年";
  if (s >= 75) return "数十年";
  if (s >= 60) return "数月";
  if (s >= 45) return "数天";
  if (s >= 30) return "数小时";
  return "即时";
}

// TOTP 工具
function generateMockTotp(): string {
  const t = Math.floor(Date.now() / 30000);
  const n = (t * 1234567 + 987654) % 1000000;
  return String(n).padStart(6, "0");
}

function totpSecondsLeft(): number {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

// ─────────────────────────────────────────────────────────────
// 子组件：顶栏
// ─────────────────────────────────────────────────────────────
function NavBar({
  title,
  c,
  onBack,
  favorited,
  onFav,
}: {
  title: string;
  c: (typeof Colors)["dark"];
  onBack: () => void;
  favorited: boolean;
  onFav: () => void;
}) {
  return (
    <View style={[navStyles.wrap, { borderBottomColor: c.lineSoft }]}>
      <TouchableOpacity
        style={navStyles.btn}
        onPress={onBack}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <IconSymbol name="chevron.left" size={22} color={c.text} />
      </TouchableOpacity>
      <Text style={[navStyles.title, { color: c.text }]} numberOfLines={1}>
        {title}
      </Text>
      <TouchableOpacity
        style={navStyles.btn}
        onPress={onFav}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <IconSymbol
          name={favorited ? "star.fill" : "star"}
          size={22}
          color={favorited ? "#f5c518" : c.text3}
        />
      </TouchableOpacity>
    </View>
  );
}

const navStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  btn: {
    width: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
});

// ─────────────────────────────────────────────────────────────
// 子组件：Hero
// ─────────────────────────────────────────────────────────────
function Hero({
  initials,
  color,
  name,
  url,
  type,
  c,
}: {
  initials: string;
  color: string;
  name: string;
  url: string;
  type: string;
  c: (typeof Colors)["dark"];
}) {
  const typeLabels: Record<string, string> = {
    login: "登录凭据",
    card: "支付卡",
    note: "安全笔记",
    identity: "身份信息",
    ssh: "SSH 密钥",
  };
  return (
    <View style={heroStyles.wrap}>
      <View style={[heroStyles.icon, { backgroundColor: color }]}>
        <Text style={heroStyles.iconText}>{initials || "?"}</Text>
      </View>
      <Text style={[heroStyles.name, { color: c.text }]}>{name}</Text>
      <Text style={[heroStyles.url, { color: c.text3 }]}>{url}</Text>
      <View style={heroStyles.tagRow}>
        <View style={[heroStyles.tag, { borderColor: c.line }]}>
          <Text style={[heroStyles.tagText, { color: c.text2 }]}>
            {typeLabels[type] ?? type}
          </Text>
        </View>
      </View>
    </View>
  );
}

const heroStyles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    paddingVertical: 24,
    paddingHorizontal: 16,
    gap: 6,
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  iconText: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
  },
  name: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  url: {
    fontSize: 13,
  },
  tagRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 4,
  },
  tag: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: {
    fontSize: 11,
    fontWeight: "500",
  },
});

// ─────────────────────────────────────────────────────────────
// 子组件：快捷操作按钮组
// ─────────────────────────────────────────────────────────────
function QuickActions({
  c,
  onCopyUsername,
  onCopyPassword,
  onShare,
  onEdit,
}: {
  c: (typeof Colors)["dark"];
  onCopyUsername: () => void;
  onCopyPassword: () => void;
  onShare: () => void;
  onEdit: () => void;
}) {
  const actions: {
    label: string;
    icon: React.ComponentProps<typeof IconSymbol>["name"];
    onPress: () => void;
    primary: boolean;
  }[] = [
    {
      label: "复制用户名",
      icon: "person.crop.circle.fill",
      onPress: onCopyUsername,
      primary: false,
    },
    {
      label: "复制密码",
      icon: "key.horizontal.fill",
      onPress: onCopyPassword,
      primary: true,
    },
    {
      label: "分享",
      icon: "square.and.arrow.up",
      onPress: onShare,
      primary: false,
    },
    {
      label: "编辑",
      icon: "square.and.pencil",
      onPress: onEdit,
      primary: false,
    },
  ];

  return (
    <View style={qaStyles.wrap}>
      {actions.map((a) => (
        <TouchableOpacity
          key={a.label}
          style={[
            qaStyles.btn,
            a.primary
              ? { backgroundColor: c.text, borderColor: c.text }
              : { backgroundColor: c.bgElev, borderColor: c.line },
          ]}
          activeOpacity={0.7}
          onPress={a.onPress}
        >
          <IconSymbol
            name={a.icon}
            size={18}
            color={a.primary ? c.bg : c.text}
            style={qaStyles.emoji}
          />
          <Text
            style={[qaStyles.label, { color: a.primary ? c.bg : c.text2 }]}
            numberOfLines={1}
          >
            {a.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const qaStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 4,
  },
  btn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  emoji: {
    fontSize: 18,
    lineHeight: 22,
  },
  label: {
    fontSize: 11,
    fontWeight: "500",
    textAlign: "center",
  },
});

// ─────────────────────────────────────────────────────────────
// 子组件：Section 容器
// ─────────────────────────────────────────────────────────────
function Section({
  title,
  children,
  c,
}: {
  title: string;
  children: React.ReactNode;
  c: (typeof Colors)["dark"];
}) {
  return (
    <View style={sectionStyles.wrap}>
      <Text style={[sectionStyles.title, { color: c.text3 }]}>{title}</Text>
      <View
        style={[
          sectionStyles.card,
          { backgroundColor: c.bgElev, borderColor: c.line },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  title: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});

// ─────────────────────────────────────────────────────────────
// 子组件：凭据行
// ─────────────────────────────────────────────────────────────
function CredRow({
  label,
  value,
  masked,
  c,
  isLast,
  onCopy,
  extra,
}: {
  label: string;
  value: string;
  masked?: boolean;
  c: (typeof Colors)["dark"];
  isLast?: boolean;
  onCopy: () => void;
  extra?: React.ReactNode;
}) {
  const [revealed, setReveal] = useState(false);
  const displayValue = masked && !revealed ? "••••••••••••••••••••" : value;

  return (
    <View
      style={[
        credStyles.row,
        { borderBottomColor: isLast ? "transparent" : c.lineSoft },
      ]}
    >
      <View style={credStyles.left}>
        <Text style={[credStyles.label, { color: c.text3 }]}>{label}</Text>
        <Text
          style={[
            credStyles.value,
            { color: c.text, fontFamily: masked ? MONO : undefined },
          ]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {displayValue}
        </Text>
      </View>
      <View style={credStyles.actions}>
        {extra}
        {masked && (
          <TouchableOpacity
            onPress={() => setReveal((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[credStyles.iconBtn, { backgroundColor: c.bgHover }]}
          >
            <IconSymbol
              name={revealed ? "eye.slash.fill" : "eye.fill"}
              size={16}
              color={c.text2}
            />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={onCopy}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[credStyles.iconBtn, { backgroundColor: c.bgHover }]}
        >
          <IconSymbol name="doc.on.doc.fill" size={16} color={c.text2} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const credStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  left: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  label: {
    fontSize: 11,
    fontWeight: "500",
  },
  value: {
    fontSize: 14,
    fontWeight: "400",
  },
  actions: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    flexShrink: 0,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
});

// ─────────────────────────────────────────────────────────────
// 子组件：密码强度 Section
// ─────────────────────────────────────────────────────────────
function StrengthSection({
  strength,
  c,
}: {
  strength: number;
  c: (typeof Colors)["dark"];
}) {
  const color = strengthColor(strength, c.danger, c.warn, c.ok);
  const label = strengthLabel(strength);
  const entropy = entropyFromStrength(strength);
  const crack = crackTime(strength);
  const pwLen = MOCK_PASSWORD.length;

  return (
    <Section title="密码强度" c={c}>
      <View style={strengthStyles.inner}>
        {/* 大数字 */}
        <View style={strengthStyles.scoreRow}>
          <Text style={[strengthStyles.score, { color, fontFamily: MONO }]}>
            {strength}
          </Text>
          <Text style={[strengthStyles.scoreMax, { color: c.text3 }]}>
            /100
          </Text>
          <View style={[strengthStyles.labelBadge, { borderColor: color }]}>
            <Text style={[strengthStyles.labelText, { color }]}>{label}</Text>
          </View>
        </View>

        {/* 进度条 */}
        <View style={[strengthStyles.bar, { backgroundColor: c.lineSoft }]}>
          <View
            style={[
              strengthStyles.fill,
              { width: `${strength}%` as any, backgroundColor: color },
            ]}
          />
        </View>

        {/* 元信息 */}
        <View style={[strengthStyles.meta, { borderTopColor: c.lineSoft }]}>
          <MetaItem label="长度" value={String(pwLen)} c={c} />
          <View
            style={[strengthStyles.divider, { backgroundColor: c.lineSoft }]}
          />
          <MetaItem label="熵值" value={`${entropy} bit`} c={c} />
          <View
            style={[strengthStyles.divider, { backgroundColor: c.lineSoft }]}
          />
          <MetaItem label="破解时间" value={crack} c={c} />
        </View>
      </View>
    </Section>
  );
}

function MetaItem({
  label,
  value,
  c,
}: {
  label: string;
  value: string;
  c: (typeof Colors)["dark"];
}) {
  return (
    <View style={strengthStyles.metaItem}>
      <Text style={[strengthStyles.metaLabel, { color: c.text3 }]}>
        {label}
      </Text>
      <Text
        style={[strengthStyles.metaValue, { color: c.text, fontFamily: MONO }]}
      >
        {value}
      </Text>
    </View>
  );
}

const strengthStyles = StyleSheet.create({
  inner: {
    padding: 14,
    gap: 12,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
  },
  score: {
    fontSize: 40,
    fontWeight: "700",
    lineHeight: 46,
  },
  scoreMax: {
    fontSize: 16,
    fontWeight: "400",
    marginBottom: 2,
  },
  labelBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 4,
    alignSelf: "center",
  },
  labelText: {
    fontSize: 12,
    fontWeight: "600",
  },
  bar: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 3,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    gap: 0,
  },
  metaItem: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  metaLabel: {
    fontSize: 10,
    fontWeight: "500",
  },
  metaValue: {
    fontSize: 13,
    fontWeight: "600",
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
  },
});

// ─────────────────────────────────────────────────────────────
// 子组件：TOTP Section
// ─────────────────────────────────────────────────────────────
function TotpSection({ c }: { c: (typeof Colors)["dark"] }) {
  const [code, setCode] = useState(generateMockTotp());
  const [secsLeft, setSecsLeft] = useState(totpSecondsLeft());

  useEffect(() => {
    const tick = () => {
      const s = totpSecondsLeft();
      setSecsLeft(s);
      if (s === 30) setCode(generateMockTotp());
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const progress = secsLeft / 30;
  const urgent = secsLeft <= 5;

  const ringColor = urgent ? c.danger : c.ok;
  const SIZE = 52;
  const STROKE = 4;
  const R = (SIZE - STROKE) / 2;
  const CIRC = 2 * Math.PI * R;
  const dash = CIRC * progress;
  const gap = CIRC - dash;

  const handleCopy = useCallback(async () => {
    Clipboard.setString(code);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert("已复制", "验证码已复制到剪贴板");
  }, [code]);

  return (
    <Section title="TOTP 验证码" c={c}>
      <View style={totpStyles.inner}>
        {/* 倒计时环 (SVG-free：用 View 模拟圆环) */}
        <View style={[totpStyles.ringWrap, { width: SIZE, height: SIZE }]}>
          {/* 底圈 */}
          <View
            style={[
              totpStyles.ringBg,
              {
                width: SIZE,
                height: SIZE,
                borderRadius: SIZE / 2,
                borderColor: c.lineSoft,
                borderWidth: STROKE,
              },
            ]}
          />
          {/* 进度用旋转裁切模拟 */}
          <View
            style={[totpStyles.ringProgress, { width: SIZE, height: SIZE }]}
          >
            <View
              style={[
                totpStyles.ringFill,
                {
                  width: SIZE,
                  height: SIZE,
                  borderRadius: SIZE / 2,
                  borderColor: ringColor,
                  borderWidth: STROKE,
                  // 用 borderTopColor 模拟缺口（简化方案）
                  borderTopColor: progress < 0.75 ? "transparent" : ringColor,
                  borderRightColor: progress < 0.5 ? "transparent" : ringColor,
                  borderBottomColor:
                    progress < 0.25 ? "transparent" : ringColor,
                  transform: [{ rotate: "-90deg" }],
                },
              ]}
            />
          </View>
          {/* 中心秒数 */}
          <View style={totpStyles.ringCenter}>
            <Text
              style={[
                totpStyles.secs,
                { color: urgent ? c.danger : c.text2, fontFamily: MONO },
              ]}
            >
              {secsLeft}
            </Text>
          </View>
        </View>

        {/* 验证码 */}
        <View style={totpStyles.codeWrap}>
          <Text
            style={[
              totpStyles.code,
              {
                color: urgent ? c.danger : c.text,
                fontFamily: MONO,
                letterSpacing: 6,
              },
            ]}
          >
            {code.slice(0, 3)} {code.slice(3)}
          </Text>
          <Text style={[totpStyles.hint, { color: c.text3 }]}>
            {secsLeft}秒后刷新
          </Text>
        </View>

        {/* 复制按钮 */}
        <TouchableOpacity
          style={[
            totpStyles.copyBtn,
            { backgroundColor: c.bgHover, borderColor: c.line },
          ]}
          onPress={handleCopy}
          activeOpacity={0.7}
        >
          <Text style={[totpStyles.copyText, { color: c.text2 }]}>复制</Text>
        </TouchableOpacity>
      </View>
    </Section>
  );
}

const totpStyles = StyleSheet.create({
  inner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 14,
  },
  ringWrap: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  ringBg: {
    position: "absolute",
  },
  ringProgress: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  ringFill: {
    position: "absolute",
  },
  ringCenter: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  secs: {
    fontSize: 13,
    fontWeight: "700",
  },
  codeWrap: {
    flex: 1,
    gap: 2,
  },
  code: {
    fontSize: 28,
    fontWeight: "700",
  },
  hint: {
    fontSize: 11,
  },
  copyBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  copyText: {
    fontSize: 13,
    fontWeight: "500",
  },
});

// ─────────────────────────────────────────────────────────────
// 主页：详情
// ─────────────────────────────────────────────────────────────
export default function VaultDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];

  const item = MOCK_ITEMS.find((i) => i.id === id);

  const [favorited, setFavorited] = useState(false);

  const copyAndNotify = useCallback(async (label: string, value: string) => {
    Clipboard.setString(value);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert("已复制", `${label} 已复制到剪贴板`);
  }, []);

  if (!item) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: c.bg }]}
        edges={["top"]}
      >
        <NavBar
          title="未找到"
          c={c}
          onBack={() => router.back()}
          favorited={false}
          onFav={() => {}}
        />
        <View style={styles.notFound}>
          <Text style={[styles.notFoundText, { color: c.text3 }]}>
            条目不存在 (id: {id})
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: c.bg }]}
      edges={["top"]}
    >
      <NavBar
        title={item.name}
        c={c}
        onBack={() => router.back()}
        favorited={favorited}
        onFav={() => setFavorited((v) => !v)}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Hero */}
        <Hero
          initials={item.initials}
          color={item.color}
          name={item.name}
          url={item.url}
          type={item.type}
          c={c}
        />

        {/* 快捷操作 */}
        <QuickActions
          c={c}
          onCopyUsername={() => copyAndNotify("用户名", item.username)}
          onCopyPassword={() => copyAndNotify("密码", MOCK_PASSWORD)}
          onShare={() => Alert.alert("分享", "分享功能待实现")}
          onEdit={() => Alert.alert("编辑", "编辑功能待实现")}
        />

        {/* 空白间距 */}
        <View style={{ height: 16 }} />

        {/* 凭据 Section */}
        <Section title="凭据" c={c}>
          <CredRow
            label="用户名"
            value={item.username}
            c={c}
            onCopy={() => copyAndNotify("用户名", item.username)}
          />
          <CredRow
            label="密码"
            value={MOCK_PASSWORD}
            masked
            c={c}
            onCopy={() => copyAndNotify("密码", MOCK_PASSWORD)}
          />
          <CredRow
            label="网址"
            value={item.url}
            c={c}
            isLast
            onCopy={() => copyAndNotify("网址", item.url)}
          />
        </Section>

        {/* 密码强度 */}
        {item.strength !== undefined && (
          <StrengthSection strength={item.strength} c={c} />
        )}

        {/* TOTP */}
        {item.totp && <TotpSection c={c} />}

        {/* 修改时间 footer */}
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: c.text3 }]}>
            最后修改：{item.modified}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────
// 样式
// ─────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    paddingBottom: 40,
  },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  notFoundText: {
    fontSize: 14,
  },
  footer: {
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 16,
  },
  footerText: {
    fontSize: 11,
  },
});
