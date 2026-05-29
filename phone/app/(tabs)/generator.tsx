import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TextInput,
  PanResponder,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Elevation, Fonts, Radius, Spacing, Type, Hit } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import {
  Button,
  IconButton,
  PressableScale,
} from "@/components/ui/primitives";
import { copyText } from "@/lib/clipboard";
import { randomBytes } from "@/lib/crypto";

/** 安全随机：用 CSPRNG 取均匀分布的 [0, max)，拒绝偏倚区间 */
function secureRandomInt(max: number): number {
  if (max <= 0) return 0;
  const limit = 256 - (256 % max);
  while (true) {
    const b = randomBytes(1)[0];
    if (b < limit) return b % max;
  }
}

type Mode = "password" | "passphrase" | "pin";

interface Options {
  upper: boolean;
  lower: boolean;
  numbers: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
  pronounceable: boolean;
}

function generatePassword(len: number, opts: Options): string {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const nums = "0123456789";
  const syms = "!@#$%^&*()_+-=[]{}|;:,.<>?";

  let charset = "";
  if (opts.upper) charset += upper;
  if (opts.lower) charset += lower;
  if (opts.numbers) charset += nums;
  if (opts.symbols) charset += syms;
  if (!charset) charset = lower + nums;

  if (opts.avoidAmbiguous) {
    const ambiguous = /[Il1O0]/g;
    charset = charset.replace(ambiguous, "");
  }

  return Array.from(
    { length: len },
    () => charset[secureRandomInt(charset.length)],
  ).join("");
}

const WORDLIST = [
  "apple", "brave", "cloud", "dance", "eagle", "flame", "grace", "heart",
  "ivory", "jewel", "karma", "lemon", "maple", "noble", "ocean", "pearl",
  "queen", "river", "solar", "tiger", "ultra", "vivid", "water", "xenon",
  "youth", "zebra", "amber", "blaze", "crisp", "delta", "ember", "frost",
  "glide", "haven", "index", "jolly", "knack", "lunar", "mango", "nexus",
  "orbit", "prism", "quiet", "radar", "sleek", "trove", "unity", "vault",
  "witch", "xerox", "yield", "zonal", "acorn", "bloom", "coral", "drift",
  "elbow", "fable", "glade", "honey",
];

function generatePassphrase(wordCount: number): string {
  return Array.from(
    { length: wordCount },
    () => WORDLIST[secureRandomInt(WORDLIST.length)],
  ).join("-");
}

function generatePin(len: number): string {
  return Array.from({ length: len }, () => secureRandomInt(10).toString()).join(
    "",
  );
}

/**
 * 批量去重生成
 *
 * 反复调用 genOne（按当前模式 + 选项闭包构造）直到收集 count 条互不相同的
 * 结果，用 Set 去重。
 *
 * count 现无上限，因此不能用 count*k 作尝试上限（候选空间小、count 又极大时
 * 会空转上百万次）。改用「连续未命中」探测：连续这么多次都撞到重复，就认定
 * 候选空间已耗尽，返回已收集到的部分（不抛错）。命中即清零计数，所以可填满
 * 的大批量不会被误伤。
 */
const MAX_CONSECUTIVE_MISSES = 50000;

function generateUniqueBatch(count: number, genOne: () => string): string[] {
  if (count < 1) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let misses = 0;
  while (out.length < count && misses < MAX_CONSECUTIVE_MISSES) {
    const candidate = genOne();
    if (!candidate || seen.has(candidate)) {
      misses++;
      continue;
    }
    misses = 0;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

function calcStrength(
  password: string,
  opts: Options,
  mode: Mode,
): { score: number; label: string; entropy: number } {
  if (!password) return { score: 0, label: "无", entropy: 0 };

  let poolSize = 0;
  if (mode === "passphrase") {
    poolSize = WORDLIST.length;
    const wordCount = password.split("-").length;
    const entropy = Math.round(wordCount * Math.log2(poolSize));
    const score = Math.min(100, Math.round((entropy / 128) * 100));
    const label =
      score < 40 ? "较弱" : score < 60 ? "一般" : score < 80 ? "强" : "很强";
    return { score, label, entropy };
  }

  if (mode === "pin") {
    poolSize = 10;
    const entropy = Math.round(password.length * Math.log2(poolSize));
    const score = Math.min(100, Math.round((entropy / 40) * 60));
    return { score, label: score < 50 ? "较弱" : "一般", entropy };
  }

  if (opts.lower) poolSize += 26;
  if (opts.upper) poolSize += 26;
  if (opts.numbers) poolSize += 10;
  if (opts.symbols) poolSize += 30;
  if (poolSize === 0) poolSize = 36;

  const entropy = Math.round(password.length * Math.log2(poolSize));
  const score = Math.min(100, Math.round((entropy / 128) * 100));
  const label =
    score < 30
      ? "很弱"
      : score < 50
        ? "较弱"
        : score < 70
          ? "一般"
          : score < 85
            ? "强"
            : "很强";

  return { score, label, entropy };
}

interface CharSpan {
  char: string;
  type: "upper" | "lower" | "number" | "symbol";
}

function tokenize(password: string): CharSpan[] {
  return password.split("").map((char) => {
    if (/[A-Z]/.test(char)) return { char, type: "upper" };
    if (/[a-z]/.test(char)) return { char, type: "lower" };
    if (/[0-9]/.test(char)) return { char, type: "number" };
    return { char, type: "symbol" };
  });
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function ToggleRow({
  label,
  sub,
  value,
  onToggle,
}: {
  label: string;
  sub: string;
  value: boolean;
  onToggle: () => void;
}) {
  const { colors: c } = useTheme();
  const monoFamily = Fonts?.mono ?? "monospace";
  return (
    <PressableScale
      onPress={onToggle}
      scale={0.97}
      haptic="selection"
      pressedBg={c.bgHover}
      style={[styles.toggleCard, { backgroundColor: c.bgElev }]}
    >
      <View style={{ flex: 1, marginRight: Spacing.sm }}>
        <Text style={[styles.toggleLabel, { color: c.text }]} numberOfLines={1}>
          {label}
        </Text>
        <Text
          style={[styles.toggleSub, { color: c.text3, fontFamily: monoFamily }]}
          numberOfLines={1}
        >
          {sub}
        </Text>
      </View>
      <View
        style={[
          styles.switchTrack,
          { backgroundColor: value ? c.accent : c.bgActive },
        ]}
      >
        <View
          style={[
            styles.switchThumb,
            {
              backgroundColor: value ? c.accentInk : c.text3,
              transform: [{ translateX: value ? 14 : 0 }],
            },
          ]}
        />
      </View>
    </PressableScale>
  );
}

/** 拖拽用软上限：max 缺省（无上限）时，轨道映射到 [min, SOFT_DRAG_MAX]，
 *  更大的值通过点击数值直接输入。 */
const SOFT_DRAG_MAX = 100;

function Stepper({
  value,
  min,
  max,
  onChange,
  hint,
}: {
  value: number;
  min: number;
  /** 缺省即无上限（仅约束 >= min）；拖拽落在软范围内，输入可超出 */
  max?: number;
  /** 绝对值回调：内部已按 [min, max] 夹取 */
  onChange: (next: number) => void;
  hint?: string;
}) {
  const { colors: c } = useTheme();
  const monoFamily = Fonts?.mono ?? "monospace";

  const dragMax = max ?? Math.max(SOFT_DRAG_MAX, value);
  const span = Math.max(1, dragMax - min);
  const progress = Math.min(100, Math.max(0, ((value - min) / span) * 100));

  const clamp = (n: number) =>
    Math.max(min, max != null ? Math.min(max, n) : n);

  // 点击数值 → 直接输入
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const startEdit = () => {
    setDraft(String(value));
    setEditing(true);
  };
  const commitEdit = () => {
    const n = Number.parseInt(draft, 10);
    if (!Number.isNaN(n)) onChange(clamp(n));
    setEditing(false);
  };

  // 拖拽 —— 触摸点 x / 轨道宽度映射到 [min, dragMax]
  const trackWidth = useRef(0);
  const setFromRatio = (ratio: number) => {
    const r = Math.max(0, Math.min(1, ratio));
    onChange(clamp(Math.round(min + r * span)));
  };
  // 用 ref 转发，PanResponder 只创建一次但始终调用最新闭包，避免捕获过期的 onChange/span
  const ratioRef = useRef(setFromRatio);
  ratioRef.current = setFromRatio;
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        Haptics.selectionAsync();
        ratioRef.current(e.nativeEvent.locationX / (trackWidth.current || 1));
      },
      onPanResponderMove: (e) => {
        ratioRef.current(e.nativeEvent.locationX / (trackWidth.current || 1));
      },
    }),
  ).current;

  return (
    <View>
      <View style={styles.stepper}>
        <IconButton
          icon="minus"
          size={Hit.buttonMd}
          variant="tinted"
          haptic="light"
          onPress={() => onChange(clamp(value - 1))}
        />
        <View
          style={styles.trackTouch}
          onLayout={(e) => {
            trackWidth.current = e.nativeEvent.layout.width;
          }}
          {...pan.panHandlers}
        >
          <View
            pointerEvents="none"
            style={[styles.stepperTrack, { backgroundColor: c.bgElev }]}
          >
            <View
              style={[
                styles.stepperTrackFill,
                { backgroundColor: c.accent, width: `${progress}%` as any },
              ]}
            />
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.stepperThumb,
              { backgroundColor: c.accent, left: `${progress}%` as any },
            ]}
          />
        </View>
        <IconButton
          icon="plus"
          size={Hit.buttonMd}
          variant="tinted"
          haptic="light"
          onPress={() => onChange(clamp(value + 1))}
        />
      </View>
      {editing ? (
        <TextInput
          autoFocus
          keyboardType="number-pad"
          value={draft}
          onChangeText={setDraft}
          onBlur={commitEdit}
          onSubmitEditing={commitEdit}
          selectTextOnFocus
          style={[
            styles.stepperValue,
            styles.stepperInput,
            { color: c.text, fontFamily: monoFamily, borderColor: c.accent },
          ]}
        />
      ) : (
        <Text
          onPress={startEdit}
          suppressHighlighting
          style={[styles.stepperValue, { color: c.text, fontFamily: monoFamily }]}
        >
          {value}
        </Text>
      )}
      {hint ? (
        <Text
          style={[styles.stepperHint, { color: c.text3, fontFamily: monoFamily }]}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/* ─── Main Component ─────────────────────────────────────────────────────── */

export default function GeneratorScreen() {
  const { colors: c } = useTheme();

  const [mode, setMode] = useState<Mode>("password");
  const [len, setLen] = useState(20);
  const [wordCount, setWordCount] = useState(5);
  const [pinLen, setPinLen] = useState(6);
  const [count, setCount] = useState(1);
  const [password, setPassword] = useState("");
  const [batch, setBatch] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [opts, setOpts] = useState<Options>({
    upper: true,
    lower: true,
    numbers: true,
    symbols: true,
    avoidAmbiguous: false,
    pronounceable: false,
  });

  const regen = useCallback(() => {
    // 单条生成器，批量与单条共用：保证复杂度 / 长度约束完全一致
    const genOne = (): string => {
      if (mode === "password") return generatePassword(len, opts);
      if (mode === "passphrase") return generatePassphrase(wordCount);
      return generatePin(pinLen);
    };
    if (count <= 1) {
      const pw = genOne();
      setPassword(pw);
      setBatch([pw]);
      return;
    }
    const list = generateUniqueBatch(count, genOne);
    setBatch(list);
    setPassword(list[0] ?? "");
  }, [mode, len, wordCount, pinLen, opts, count]);

  useEffect(() => {
    regen();
  }, [regen]);

  const handleRegen = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    regen();
  };

  const handleCopy = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await copyText(count > 1 ? batch.join("\n") : password);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const handleSave = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push({
      pathname: "/item/[id]",
      params: { id: "new", type: "login", initialPassword: password },
    } as any);
  };

  const toggleOpt = (key: keyof Options) => {
    setOpts((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const strength = calcStrength(password, opts, mode);
  const tokens = tokenize(password);

  const charColor = (type: CharSpan["type"]) => {
    switch (type) {
      case "upper":
        return c.text;
      case "lower":
        return c.text2;
      case "number":
        return c.info;
      case "symbol":
        return c.warn;
    }
  };

  const barColor =
    strength.score < 40 ? c.danger : strength.score < 70 ? c.warn : c.ok;

  const monoFamily = Fonts?.mono ?? "monospace";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["top"]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: c.text }]}>生成器</Text>
          <Text style={[styles.subtitle, { color: c.text3 }]}>
            零知识 · 本地生成
          </Text>
        </View>

        {/* Password Display Card */}
        <View style={[styles.displayCard, { backgroundColor: c.bgElev }]}>
          <View style={styles.displayBadge}>
            <Text
              style={[
                styles.charCount,
                { color: c.text3, fontFamily: monoFamily },
              ]}
            >
              {count > 1 ? `${batch.length} 条` : `${password.length} 字符`}
            </Text>
          </View>
          {count > 1 ? (
            // 批量：多行纯文本，每行一条，可长按选中。限制最大高度并内部滚动，
            // 数量很大时不会把整页撑开。
            <ScrollView
              style={styles.batchScroll}
              contentContainerStyle={styles.batchScrollContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              <Text
                selectable
                style={[
                  styles.batchText,
                  { color: c.text2, fontFamily: monoFamily },
                ]}
              >
                {batch.join("\n")}
              </Text>
            </ScrollView>
          ) : (
            <>
              <Text style={[styles.passwordText, { fontFamily: monoFamily }]}>
                {tokens.map((tok, i) => (
                  <Text key={i} style={{ color: charColor(tok.type) }}>
                    {tok.char}
                  </Text>
                ))}
              </Text>
              <View style={[styles.strengthRow, { borderTopColor: c.lineSoft }]}>
                <View style={[styles.barBg, { backgroundColor: c.bgActive }]}>
                  <View
                    style={[
                      styles.barFill,
                      {
                        backgroundColor: barColor,
                        width: `${strength.score}%` as any,
                      },
                    ]}
                  />
                </View>
                <Text style={[styles.strengthLabel, { color: barColor }]}>
                  {strength.label}
                </Text>
                <Text
                  style={[
                    styles.entropy,
                    { color: c.text3, fontFamily: monoFamily },
                  ]}
                >
                  {strength.entropy}b
                </Text>
              </View>
            </>
          )}
        </View>

        {/* Action Buttons */}
        <View style={styles.actionRow}>
          <Button
            label="重新生成"
            icon="arrow.counterclockwise"
            variant="secondary"
            size="lg"
            onPress={handleRegen}
            style={{ flex: 1 }}
            fullWidth
          />
          <Button
            label={copied ? "已复制" : count > 1 ? "复制全部" : "复制"}
            icon={copied ? "checkmark" : "doc.on.doc.fill"}
            variant="primary"
            size="lg"
            onPress={handleCopy}
            style={{ flex: 1 }}
            fullWidth
          />
        </View>

        {/* Mode Segmented Control */}
        <View style={[styles.segmented, { backgroundColor: c.bgActive }]}>
          {(
            [
              { key: "password", label: "密码" },
              { key: "passphrase", label: "词组" },
              { key: "pin", label: "PIN" },
            ] as const
          ).map((seg) => {
            const active = mode === seg.key;
            return (
              <PressableScale
                key={seg.key}
                onPress={() => {
                  Haptics.selectionAsync();
                  setMode(seg.key);
                }}
                scale={0.97}
                haptic="none"
                style={[
                  styles.segmentItem,
                  active && {
                    backgroundColor: c.bg,
                    ...Elevation.md,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    {
                      color: active ? c.text : c.text2,
                      fontWeight: active ? "600" : "500",
                    },
                  ]}
                >
                  {seg.label}
                </Text>
              </PressableScale>
            );
          })}
        </View>

        {/* 生成数量 —— 对三种模式通用，> 1 时批量多行展示且互不重复 */}
        <View style={[styles.section, { backgroundColor: c.bgElev }]}>
          <Text style={[styles.sectionTitle, { color: c.text3 }]}>
            生成数量
          </Text>
          <Stepper
            value={count}
            min={1}
            onChange={setCount}
            hint="大于 1 时批量生成，结果互不重复（拖拽或点击数字输入，无上限）"
          />
        </View>

        {/* Mode-specific controls */}
        {mode === "password" && (
          <>
            <View style={[styles.section, { backgroundColor: c.bgElev }]}>
              <Text style={[styles.sectionTitle, { color: c.text3 }]}>
                密码长度
              </Text>
              <Stepper value={len} min={8} max={64} onChange={setLen} />
            </View>

            <View style={styles.toggleGrid}>
              <ToggleRow
                label="大写字母"
                sub="A B C D E F"
                value={opts.upper}
                onToggle={() => toggleOpt("upper")}
              />
              <ToggleRow
                label="小写字母"
                sub="a b c d e f"
                value={opts.lower}
                onToggle={() => toggleOpt("lower")}
              />
              <ToggleRow
                label="数字"
                sub="0 1 2 3 4 5"
                value={opts.numbers}
                onToggle={() => toggleOpt("numbers")}
              />
              <ToggleRow
                label="特殊符号"
                sub="! @ # $ % ^"
                value={opts.symbols}
                onToggle={() => toggleOpt("symbols")}
              />
              <ToggleRow
                label="避免混淆"
                sub="Il1O0"
                value={opts.avoidAmbiguous}
                onToggle={() => toggleOpt("avoidAmbiguous")}
              />
              <ToggleRow
                label="易读模式"
                sub="pronounceable"
                value={opts.pronounceable}
                onToggle={() => toggleOpt("pronounceable")}
              />
            </View>
          </>
        )}

        {mode === "passphrase" && (
          <View style={[styles.section, { backgroundColor: c.bgElev }]}>
            <Text style={[styles.sectionTitle, { color: c.text3 }]}>
              单词数量
            </Text>
            <Stepper
              value={wordCount}
              min={2}
              max={12}
              onChange={setWordCount}
              hint="单词以 - 分隔，例如：apple-brave-cloud"
            />
          </View>
        )}

        {mode === "pin" && (
          <View style={[styles.section, { backgroundColor: c.bgElev }]}>
            <Text style={[styles.sectionTitle, { color: c.text3 }]}>
              PIN 位数
            </Text>
            <Stepper
              value={pinLen}
              min={4}
              max={12}
              onChange={setPinLen}
              hint="范围 4 ~ 12 位，仅含数字 0-9"
            />
          </View>
        )}

        {/* 保存仅单条模式可用 —— 批量是"生成+复制全部"流程 */}
        {count <= 1 && (
          <Button
            label="保存到密码库"
            icon="square.and.arrow.down.fill"
            variant="secondary"
            size="lg"
            onPress={handleSave}
            fullWidth
            style={{ marginTop: Spacing.sm }}
          />
        )}

        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxl,
  },

  header: {
    marginBottom: Spacing.lg,
  },
  title: {
    ...Type.title,
  },
  subtitle: {
    ...Type.footnote,
    marginTop: 2,
  },

  /* Display */
  displayCard: {
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    minHeight: 110,
  },
  displayBadge: {
    position: "absolute",
    top: Spacing.md,
    right: Spacing.md,
  },
  charCount: {
    ...Type.caption,
  },
  passwordText: {
    fontSize: 22,
    lineHeight: 32,
    flexWrap: "wrap",
    marginTop: Spacing.sm,
  },
  batchScroll: {
    maxHeight: 260,
    marginTop: Spacing.lg,
  },
  batchScrollContent: {
    paddingRight: Spacing.sm,
  },
  batchText: {
    fontSize: 14,
    lineHeight: 22,
  },
  strengthRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginTop: Spacing.md,
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  barBg: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 2,
  },
  strengthLabel: {
    ...Type.caption,
    minWidth: 28,
    textAlign: "right",
  },
  entropy: {
    ...Type.caption,
    minWidth: 32,
    textAlign: "right",
  },

  actionRow: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },

  segmented: {
    flexDirection: "row",
    borderRadius: Radius.lg,
    padding: 3,
    marginBottom: Spacing.md,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: Spacing.sm,
    alignItems: "center",
    borderRadius: Radius.md,
  },
  segmentText: {
    ...Type.subhead,
  },

  section: {
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: Spacing.md,
  },

  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
  },
  trackTouch: {
    flex: 1,
    height: 28,
    justifyContent: "center",
  },
  stepperTrack: {
    width: "100%",
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  stepperTrackFill: {
    height: "100%",
    borderRadius: 3,
  },
  stepperThumb: {
    position: "absolute",
    top: "50%",
    marginTop: -9,
    marginLeft: -9,
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  stepperValue: {
    ...Type.headline,
    marginTop: Spacing.sm,
    textAlign: "center",
  },
  stepperInput: {
    alignSelf: "center",
    minWidth: 96,
    paddingVertical: 2,
    paddingHorizontal: Spacing.sm,
    borderBottomWidth: 1.5,
  },
  stepperHint: {
    ...Type.footnote,
    marginTop: Spacing.xs,
    textAlign: "center",
  },

  toggleGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  toggleCard: {
    width: "48%",
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 56,
  },
  toggleLabel: {
    ...Type.subhead,
  },
  toggleSub: {
    ...Type.caption,
    marginTop: 2,
  },

  switchTrack: {
    width: 32,
    height: 18,
    borderRadius: 999,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  switchThumb: {
    width: 14,
    height: 14,
    borderRadius: 999,
  },

  bottomPad: {
    height: Spacing.xxl,
  },
});
