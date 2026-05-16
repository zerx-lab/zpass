import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  Clipboard,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
// 主题：useColorScheme 已桥接到 ThemeContext，自动响应「我的 → 主题」的手动切换
import * as Haptics from "expo-haptics";

import { Colors, Fonts } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { IconSymbol } from "@/components/ui/icon-symbol";

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = "password" | "passphrase" | "pin";

interface Options {
  upper: boolean;
  lower: boolean;
  numbers: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
  pronounceable: boolean;
}

// ─── Password Generation Logic ─────────────────────────────────────────────────

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
    () => charset[Math.floor(Math.random() * charset.length)],
  ).join("");
}

const WORDLIST = [
  "apple",
  "brave",
  "cloud",
  "dance",
  "eagle",
  "flame",
  "grace",
  "heart",
  "ivory",
  "jewel",
  "karma",
  "lemon",
  "maple",
  "noble",
  "ocean",
  "pearl",
  "queen",
  "river",
  "solar",
  "tiger",
  "ultra",
  "vivid",
  "water",
  "xenon",
  "youth",
  "zebra",
  "amber",
  "blaze",
  "crisp",
  "delta",
  "ember",
  "frost",
  "glide",
  "haven",
  "index",
  "jolly",
  "knack",
  "lunar",
  "mango",
  "nexus",
  "orbit",
  "prism",
  "quiet",
  "radar",
  "sleek",
  "trove",
  "unity",
  "vault",
  "witch",
  "xerox",
  "yield",
  "zonal",
  "acorn",
  "bloom",
  "coral",
  "drift",
  "elbow",
  "fable",
  "glade",
  "honey",
];

function generatePassphrase(wordCount: number): string {
  const words = Array.from(
    { length: wordCount },
    () => WORDLIST[Math.floor(Math.random() * WORDLIST.length)],
  );
  return words.join("-");
}

function generatePin(len: number): string {
  return Array.from({ length: len }, () =>
    Math.floor(Math.random() * 10).toString(),
  ).join("");
}

// ─── Strength Calculation ───────────────────────────────────────────────────────

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

  // password mode
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

// ─── Colorize Password ─────────────────────────────────────────────────────────

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

// ─── Sub-components ────────────────────────────────────────────────────────────

interface ToggleCardProps {
  label: string;
  sub: string;
  value: boolean;
  onToggle: () => void;
  c: (typeof Colors)["dark"];
}

function ToggleCard({ label, sub, value, onToggle, c }: ToggleCardProps) {
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onToggle();
  };

  return (
    <TouchableOpacity
      style={[
        styles.toggleCard,
        { backgroundColor: c.bgElev, borderColor: c.line },
      ]}
      onPress={handlePress}
      activeOpacity={0.75}
    >
      <View style={styles.toggleCardLeft}>
        <Text style={[styles.toggleLabel, { color: c.text }]}>{label}</Text>
        <Text
          style={[
            styles.toggleSub,
            { color: c.text3, fontFamily: Fonts?.mono ?? "monospace" },
          ]}
        >
          {sub}
        </Text>
      </View>
      {/* Custom toggle switch */}
      <View
        style={[
          styles.switchTrack,
          { backgroundColor: value ? c.text : c.line },
        ]}
      >
        <View
          style={[
            styles.switchThumb,
            {
              backgroundColor: value ? c.bg : c.text3,
              transform: [{ translateX: value ? 14 : 0 }],
            },
          ]}
        />
      </View>
    </TouchableOpacity>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function GeneratorScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];

  const [mode, setMode] = useState<Mode>("password");
  const [len, setLen] = useState(20);
  const [wordCount, setWordCount] = useState(5);
  const [pinLen, setPinLen] = useState(6);
  const [password, setPassword] = useState("");
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
    let pw = "";
    if (mode === "password") {
      pw = generatePassword(len, opts);
    } else if (mode === "passphrase") {
      pw = generatePassphrase(wordCount);
    } else {
      pw = generatePin(pinLen);
    }
    setPassword(pw);
  }, [mode, len, wordCount, pinLen, opts]);

  // Auto-regen when dependencies change
  useEffect(() => {
    regen();
  }, [regen]);

  const handleRegen = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    regen();
  };

  const handleCopy = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Clipboard.setString(password);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const handleSave = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert("保存功能", "保存功能需要解锁密码库");
  };

  const toggleOpt = (key: keyof Options) => {
    setOpts((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const adjustLen = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setLen((v) => Math.min(64, Math.max(8, v + delta)));
  };

  const adjustWordCount = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setWordCount((v) => Math.min(12, Math.max(2, v + delta)));
  };

  const adjustPinLen = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPinLen((v) => Math.min(12, Math.max(4, v + delta)));
  };

  const setMode_ = (m: Mode) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMode(m);
  };

  const strength = calcStrength(password, opts, mode);
  const tokens = tokenize(password);

  // Char color by type
  const charColor = (type: CharSpan["type"]) => {
    switch (type) {
      case "upper":
        return c.text;
      case "lower":
        return c.text2;
      case "number":
        return c.text;
      case "symbol":
        return c.text3;
    }
  };

  // Strength bar color
  const barColor =
    strength.score < 40 ? c.danger : strength.score < 70 ? c.warn : c.ok;

  const monoFamily = Fonts?.mono ?? "monospace";

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: c.bg }]}
      edges={["top"]}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.scrollContent,
          { backgroundColor: c.bg },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ─────────────────────────────────── */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: c.text }]}>生成器</Text>
          <Text
            style={[
              styles.subtitle,
              {
                color: c.text3,
                fontFamily: monoFamily,
              },
            ]}
          >
            零知识 · 本地生成
          </Text>
        </View>

        {/* ── Password Display Card ───────────────────── */}
        <View
          style={[
            styles.displayCard,
            { backgroundColor: c.bgElev, borderColor: c.line },
          ]}
        >
          <View style={styles.displayCardBadge}>
            <Text
              style={[
                styles.charCountBadge,
                { color: c.text3, fontFamily: monoFamily },
              ]}
            >
              {password.length} 字符
            </Text>
          </View>

          <Text style={[styles.passwordText, { fontFamily: monoFamily }]}>
            {tokens.map((tok, i) => (
              <Text key={i} style={{ color: charColor(tok.type) }}>
                {tok.char}
              </Text>
            ))}
          </Text>
        </View>

        {/* ── Strength Indicator ──────────────────────── */}
        <View
          style={[
            styles.strengthCard,
            { backgroundColor: c.bgElev, borderColor: c.line },
          ]}
        >
          <View style={styles.strengthRow}>
            <Text style={[styles.strengthLabel, { color: c.text2 }]}>
              强度：
            </Text>
            <View style={[styles.strengthBarBg, { backgroundColor: c.line }]}>
              <View
                style={[
                  styles.strengthBarFill,
                  {
                    backgroundColor: barColor,
                    width: `${strength.score}%` as any,
                  },
                ]}
              />
            </View>
            <Text
              style={[
                styles.strengthInfo,
                { color: barColor, fontFamily: monoFamily },
              ]}
            >
              {strength.label}
            </Text>
          </View>
          <Text
            style={[
              styles.strengthEntropy,
              { color: c.text3, fontFamily: monoFamily },
            ]}
          >
            约 {strength.entropy} 位熵值
          </Text>
        </View>

        {/* ── Action Buttons ──────────────────────────── */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[
              styles.actionBtn,
              styles.actionBtnLeft,
              { backgroundColor: c.bgElev, borderColor: c.line },
            ]}
            onPress={handleRegen}
            activeOpacity={0.75}
          >
            <IconSymbol
              name="arrow.counterclockwise"
              size={18}
              color={c.text}
            />
            <Text style={[styles.actionBtnText, { color: c.text }]}>
              重新生成
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.actionBtn,
              styles.actionBtnRight,
              { backgroundColor: c.text, borderColor: c.text },
            ]}
            onPress={handleCopy}
            activeOpacity={0.75}
          >
            <IconSymbol name="doc.on.doc.fill" size={18} color={c.bg} />
            <Text style={[styles.actionBtnText, { color: c.bg }]}>
              {copied ? "已复制！" : "复制"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Mode Segmented Control ──────────────────── */}
        <View
          style={[
            styles.segmented,
            { borderColor: c.line, backgroundColor: c.bgElev },
          ]}
        >
          {(
            [
              { key: "password", label: "密码" },
              { key: "passphrase", label: "词组" },
              { key: "pin", label: "PIN" },
            ] as const
          ).map((seg) => (
            <TouchableOpacity
              key={seg.key}
              style={[
                styles.segmentItem,
                mode === seg.key && {
                  backgroundColor: c.text,
                },
              ]}
              onPress={() => setMode_(seg.key)}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.segmentText,
                  {
                    color: mode === seg.key ? c.bg : c.text2,
                    fontWeight: mode === seg.key ? "600" : "400",
                  },
                ]}
              >
                {seg.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Password Mode Controls ──────────────────── */}
        {mode === "password" && (
          <>
            {/* Length stepper */}
            <View
              style={[
                styles.section,
                { backgroundColor: c.bgElev, borderColor: c.line },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: c.text2 }]}>
                密码长度
              </Text>
              <View style={styles.stepper}>
                <TouchableOpacity
                  style={[styles.stepperBtn, { borderColor: c.line }]}
                  onPress={() => adjustLen(-1)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.stepperBtnText, { color: c.text }]}>
                    −
                  </Text>
                </TouchableOpacity>

                <View style={styles.stepperTrack}>
                  <View
                    style={[
                      styles.stepperTrackFill,
                      {
                        backgroundColor: c.text,
                        width: `${((len - 8) / (64 - 8)) * 100}%` as any,
                      },
                    ]}
                  />
                </View>

                <TouchableOpacity
                  style={[styles.stepperBtn, { borderColor: c.line }]}
                  onPress={() => adjustLen(1)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.stepperBtnText, { color: c.text }]}>
                    ＋
                  </Text>
                </TouchableOpacity>
              </View>
              <Text
                style={[
                  styles.stepperValue,
                  { color: c.text, fontFamily: monoFamily },
                ]}
              >
                {len}
              </Text>
            </View>

            {/* Toggle options 2-col grid */}
            <View style={styles.toggleGrid}>
              <ToggleCard
                label="大写字母"
                sub="A B C D E F"
                value={opts.upper}
                onToggle={() => toggleOpt("upper")}
                c={c}
              />
              <ToggleCard
                label="小写字母"
                sub="a b c d e f"
                value={opts.lower}
                onToggle={() => toggleOpt("lower")}
                c={c}
              />
              <ToggleCard
                label="数字"
                sub="0 1 2 3 4 5"
                value={opts.numbers}
                onToggle={() => toggleOpt("numbers")}
                c={c}
              />
              <ToggleCard
                label="特殊符号"
                sub="! @ # $ % ^"
                value={opts.symbols}
                onToggle={() => toggleOpt("symbols")}
                c={c}
              />
              <ToggleCard
                label="避免混淆"
                sub="Il1O0"
                value={opts.avoidAmbiguous}
                onToggle={() => toggleOpt("avoidAmbiguous")}
                c={c}
              />
              <ToggleCard
                label="易读模式"
                sub="pronounceable"
                value={opts.pronounceable}
                onToggle={() => toggleOpt("pronounceable")}
                c={c}
              />
            </View>
          </>
        )}

        {/* ── Passphrase Mode Controls ────────────────── */}
        {mode === "passphrase" && (
          <View
            style={[
              styles.section,
              { backgroundColor: c.bgElev, borderColor: c.line },
            ]}
          >
            <Text style={[styles.sectionTitle, { color: c.text2 }]}>
              单词数量
            </Text>
            <View style={styles.stepper}>
              <TouchableOpacity
                style={[styles.stepperBtn, { borderColor: c.line }]}
                onPress={() => adjustWordCount(-1)}
                activeOpacity={0.7}
              >
                <Text style={[styles.stepperBtnText, { color: c.text }]}>
                  −
                </Text>
              </TouchableOpacity>

              <View style={styles.stepperTrack}>
                <View
                  style={[
                    styles.stepperTrackFill,
                    {
                      backgroundColor: c.text,
                      width: `${((wordCount - 2) / (12 - 2)) * 100}%` as any,
                    },
                  ]}
                />
              </View>

              <TouchableOpacity
                style={[styles.stepperBtn, { borderColor: c.line }]}
                onPress={() => adjustWordCount(1)}
                activeOpacity={0.7}
              >
                <Text style={[styles.stepperBtnText, { color: c.text }]}>
                  ＋
                </Text>
              </TouchableOpacity>
            </View>
            <Text
              style={[
                styles.stepperValue,
                { color: c.text, fontFamily: monoFamily },
              ]}
            >
              {wordCount}
            </Text>
            <Text
              style={[
                styles.passphraseHint,
                { color: c.text3, fontFamily: monoFamily },
              ]}
            >
              单词以 - 分隔，例如：apple-brave-cloud
            </Text>
          </View>
        )}

        {/* ── PIN Mode Controls ───────────────────────── */}
        {mode === "pin" && (
          <View
            style={[
              styles.section,
              { backgroundColor: c.bgElev, borderColor: c.line },
            ]}
          >
            <Text style={[styles.sectionTitle, { color: c.text2 }]}>
              PIN 位数
            </Text>
            <View style={styles.stepper}>
              <TouchableOpacity
                style={[styles.stepperBtn, { borderColor: c.line }]}
                onPress={() => adjustPinLen(-1)}
                activeOpacity={0.7}
              >
                <Text style={[styles.stepperBtnText, { color: c.text }]}>
                  −
                </Text>
              </TouchableOpacity>

              <View style={styles.stepperTrack}>
                <View
                  style={[
                    styles.stepperTrackFill,
                    {
                      backgroundColor: c.text,
                      width: `${((pinLen - 4) / (12 - 4)) * 100}%` as any,
                    },
                  ]}
                />
              </View>

              <TouchableOpacity
                style={[styles.stepperBtn, { borderColor: c.line }]}
                onPress={() => adjustPinLen(1)}
                activeOpacity={0.7}
              >
                <Text style={[styles.stepperBtnText, { color: c.text }]}>
                  ＋
                </Text>
              </TouchableOpacity>
            </View>
            <Text
              style={[
                styles.stepperValue,
                { color: c.text, fontFamily: monoFamily },
              ]}
            >
              {pinLen}
            </Text>
            <Text
              style={[
                styles.passphraseHint,
                { color: c.text3, fontFamily: monoFamily },
              ]}
            >
              范围 4 ~ 12 位，仅含数字 0-9
            </Text>
          </View>
        )}

        {/* ── Save Button ─────────────────────────────── */}
        <TouchableOpacity
          style={[
            styles.saveBtn,
            { backgroundColor: c.bgElev, borderColor: c.line },
          ]}
          onPress={handleSave}
          activeOpacity={0.75}
        >
          <Text style={[styles.saveBtnText, { color: c.text2 }]}>
            + 保存到密码库
          </Text>
        </TouchableOpacity>

        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },

  // Header
  header: {
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 10,
  },

  // Password Display Card
  displayCard: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 22,
    paddingHorizontal: 18,
    marginBottom: 10,
    position: "relative",
    minHeight: 90,
  },
  displayCardBadge: {
    position: "absolute",
    top: 10,
    right: 14,
  },
  charCountBadge: {
    fontSize: 10,
  },
  passwordText: {
    fontSize: 22,
    lineHeight: 32,
    flexWrap: "wrap",
    marginTop: 4,
  },

  // Strength
  strengthCard: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  strengthRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  strengthLabel: {
    fontSize: 12,
  },
  strengthBarBg: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  strengthBarFill: {
    height: "100%",
    borderRadius: 3,
  },
  strengthInfo: {
    fontSize: 12,
    minWidth: 24,
    textAlign: "right",
  },
  strengthEntropy: {
    fontSize: 10,
    marginTop: 4,
  },

  // Action buttons
  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    borderWidth: 1,
    borderRadius: 10,
  },
  actionBtnLeft: {},
  actionBtnRight: {},
  actionBtnIcon: {
    fontSize: 17,
    lineHeight: 20,
  },
  actionBtnText: {
    fontSize: 14,
    fontWeight: "500",
  },

  // Segmented Control
  segmented: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
    marginBottom: 16,
    padding: 3,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 6,
  },
  segmentText: {
    fontSize: 13,
  },

  // Section card (length/word count stepper)
  section: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 12,
    marginBottom: 12,
    fontWeight: "500",
  },

  // Stepper
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  stepperBtn: {
    width: 34,
    height: 34,
    borderWidth: 1,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperBtnText: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "300",
  },
  stepperTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: "transparent",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.2)",
  },
  stepperTrackFill: {
    height: "100%",
    borderRadius: 2,
  },
  stepperValue: {
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
  passphraseHint: {
    fontSize: 10,
    marginTop: 8,
    textAlign: "center",
  },

  // Toggle grid
  toggleGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
  },
  toggleCard: {
    width: "47.5%",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleCardLeft: {
    flex: 1,
    marginRight: 8,
  },
  toggleLabel: {
    fontSize: 12,
    fontWeight: "500",
    marginBottom: 2,
  },
  toggleSub: {
    fontSize: 9,
  },

  // Switch
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

  // Save button
  saveBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 8,
  },
  saveBtnText: {
    fontSize: 14,
    fontWeight: "500",
  },

  bottomPad: {
    height: 24,
  },
});
