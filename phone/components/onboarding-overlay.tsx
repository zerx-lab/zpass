// 首次进入：两步引导 —— iOS HIG 风格重构
//
// 1. 设主密码（派生 KEK / 生成 DEK / 写 vault meta）
// 2. 给"默认空间"取个用户自己的名字
//
// 实现要点：整流程在内部用 step state 控制，**不在第 1 步立刻 initialize**。
// 第 1 步只暂存密码到组件内存，等用户在第 2 步点"创建保险库"才一次性
// initialize(pw) → renameSpace(DEFAULT_SPACE_ID, name)，这样 KDF 的等待发生在最后。

import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SpaceAvatar } from "@/components/space-avatar";
import { isNativeKDF, isWasmKDF } from "@/lib/crypto";
import { DEFAULT_SPACE_ID } from "@/lib/spaces";
import { Button, IconButton } from "@/components/ui/primitives";
import type { ColorPalette } from "@/constants/theme";

const MONO = Fonts?.mono ?? "monospace";

type Step = "password" | "space";

export function OnboardingOverlay() {
  const { colors: c } = useTheme();
  const { initialize, renameSpace } = useVault();

  const [step, setStep] = useState<Step>("password");

  // step 1
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");

  // step 2
  const [spaceName, setSpaceName] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canNext = pw.length >= 8 && pw === confirm && !busy;

  const trimmedSpace = spaceName.trim();
  const canSubmit =
    trimmedSpace.length > 0 && trimmedSpace.length <= 32 && !busy;

  const handleNext = () => {
    if (!canNext) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(
        pw.length < 8
          ? "主密码至少 8 位"
          : pw !== confirm
            ? "两次输入不一致"
            : null,
      );
      return;
    }
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStep("space");
  };

  const handleBack = () => {
    setError(null);
    setStep("password");
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError("空间名不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const init = await initialize(pw);
    if (!init.ok) {
      setBusy(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(init.message || "初始化失败");
      return;
    }
    const rn = await renameSpace(DEFAULT_SPACE_ID, trimmedSpace);
    setBusy(false);
    if (!rn.ok) {
      console.warn("[onboarding] rename default space failed:", rn.message);
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setPw("");
    setConfirm("");
    setSpaceName("");
  };

  const isPasswordStep = step === "password";

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* 顶部 logo + 步骤指示器 */}
            <View style={styles.logoWrap}>
              {isPasswordStep ? (
                <View style={[styles.logo, { backgroundColor: c.accent }]}>
                  <Text style={[styles.logoText, { color: c.accentInk }]}>
                    Z
                  </Text>
                </View>
              ) : (
                <SpaceAvatar
                  space={{ name: trimmedSpace }}
                  size={64}
                  background={c.accent}
                  foreground={c.accentInk}
                  fontSize={28}
                  borderRadius={16}
                />
              )}
            </View>

            <Text style={[styles.title, { color: c.text }]}>
              {isPasswordStep ? "欢迎使用 ZPass" : "为空间取个名字"}
            </Text>
            <Text style={[styles.sub, { color: c.text3 }]}>
              {isPasswordStep
                ? "设置主密码以加密你的保险库"
                : "头像首字符会跟随名字"}
            </Text>

            {/* 步骤指示器 */}
            <View style={styles.steps}>
              <View style={[styles.stepDot, { backgroundColor: c.accent }]} />
              <View
                style={[
                  styles.stepLine,
                  {
                    backgroundColor: step === "space" ? c.accent : c.bgActive,
                  },
                ]}
              />
              <View
                style={[
                  styles.stepDot,
                  {
                    backgroundColor: step === "space" ? c.accent : c.bgActive,
                  },
                ]}
              />
            </View>

            <View style={[styles.card, { backgroundColor: c.bgElev }]}>
              {isPasswordStep ? (
                <>
                  <FieldLabel label="主密码" hint="至少 8 位字符" c={c} />
                  <PasswordInput
                    value={pw}
                    onChangeText={(v) => {
                      setPw(v);
                      setError(null);
                    }}
                    placeholder="主密码"
                    error={tooShort}
                    c={c}
                    autoFocus
                  />

                  <View style={{ height: Spacing.md }} />
                  <FieldLabel label="确认主密码" c={c} />
                  <PasswordInput
                    value={confirm}
                    onChangeText={(v) => {
                      setConfirm(v);
                      setError(null);
                    }}
                    placeholder="再次输入"
                    error={mismatch}
                    c={c}
                    onSubmitEditing={handleNext}
                  />

                  {error ? (
                    <View
                      style={[
                        styles.errorBox,
                        { backgroundColor: c.danger + "1f" },
                      ]}
                    >
                      <IconSymbol
                        name="exclamationmark.circle.fill"
                        size={14}
                        color={c.danger}
                      />
                      <Text style={[styles.errorText, { color: c.danger }]}>
                        {error}
                      </Text>
                    </View>
                  ) : null}

                  <View style={[styles.points, { borderTopColor: c.lineSoft }]}>
                    {[
                      "数据仅保存在本设备",
                      "Argon2id 派生主密码 → XChaCha20-Poly1305 加密",
                      "主密码一旦丢失将无法恢复",
                    ].map((p) => (
                      <View key={p} style={styles.pointRow}>
                        <View
                          style={[
                            styles.pointIcon,
                            { backgroundColor: c.ok + "1f" },
                          ]}
                        >
                          <IconSymbol name="checkmark" size={11} color={c.ok} />
                        </View>
                        <Text style={[styles.pointText, { color: c.text2 }]}>
                          {p}
                        </Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : (
                <>
                  <FieldLabel
                    label="空间名"
                    hint="个人 / 工作 / 家庭 …"
                    c={c}
                  />
                  <View style={[styles.inputBox, { backgroundColor: c.bg }]}>
                    <IconSymbol name="tag.fill" size={16} color={c.text3} />
                    <TextInput
                      style={[styles.input, { color: c.text }]}
                      value={spaceName}
                      onChangeText={(v) => {
                        setSpaceName(v);
                        setError(null);
                      }}
                      placeholder="为这个空间取个名字"
                      placeholderTextColor={c.text3}
                      autoFocus
                      autoCorrect={false}
                      autoCapitalize="none"
                      maxLength={32}
                      onSubmitEditing={handleSubmit}
                      returnKeyType="go"
                    />
                  </View>

                  {error ? (
                    <View
                      style={[
                        styles.errorBox,
                        { backgroundColor: c.danger + "1f" },
                      ]}
                    >
                      <IconSymbol
                        name="exclamationmark.circle.fill"
                        size={14}
                        color={c.danger}
                      />
                      <Text style={[styles.errorText, { color: c.danger }]}>
                        {error}
                      </Text>
                    </View>
                  ) : null}

                  <View style={[styles.points, { borderTopColor: c.lineSoft }]}>
                    <Text style={[styles.conceptText, { color: c.text2 }]}>
                      空间是 ZPass 里的顶层隔离容器，类似不同账号。每个空间
                      独立存放条目，可随时新建、切换、重命名。
                    </Text>
                  </View>
                </>
              )}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            {isPasswordStep ? (
              <>
                <Button
                  label="下一步"
                  iconRight="arrow.right"
                  variant="primary"
                  size="lg"
                  onPress={handleNext}
                  disabled={!canNext}
                  fullWidth
                />
                <Text
                  style={[
                    styles.footerHint,
                    { color: c.text4, fontFamily: MONO },
                  ]}
                >
                  {isNativeKDF()
                    ? "原生 Go 加速 · 派生约 0.3 秒"
                    : isWasmKDF()
                      ? "WASM 加速 · 派生大约 0.5 秒"
                      : "纯 JS 派生 · 约 3-6 秒"}
                </Text>
              </>
            ) : (
              <>
                <View style={styles.footerRow}>
                  <Button
                    label="返回"
                    icon="arrow.left"
                    variant="secondary"
                    size="lg"
                    onPress={handleBack}
                    disabled={busy}
                  />
                  <Button
                    label={busy ? "创建中" : "创建保险库"}
                    iconRight={busy ? undefined : "checkmark"}
                    variant="primary"
                    size="lg"
                    onPress={handleSubmit}
                    disabled={!canSubmit}
                    style={{ flex: 1 }}
                    fullWidth
                  />
                </View>
                <Text style={[styles.footerHint, { color: c.text4 }]}>
                  创建后随时可在「我的 → 空间」里重命名
                </Text>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/* ----- 复用控件 ----- */

function FieldLabel({
  label,
  hint,
  c,
}: {
  label: string;
  hint?: string;
  c: ColorPalette;
}) {
  return (
    <View style={styles.labelRow}>
      <Text style={[styles.label, { color: c.text3 }]}>{label}</Text>
      {hint ? (
        <Text style={[styles.labelHint, { color: c.text4, fontFamily: MONO }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function PasswordInput({
  value,
  onChangeText,
  placeholder,
  error,
  c,
  onSubmitEditing,
  autoFocus,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  error?: boolean;
  c: ColorPalette;
  onSubmitEditing?: () => void;
  autoFocus?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <View
      style={[
        styles.inputBox,
        {
          backgroundColor: c.bg,
          borderWidth: error ? 1 : 0,
          borderColor: c.danger,
        },
      ]}
    >
      <IconSymbol name="lock.fill" size={16} color={c.text3} />
      <TextInput
        style={[styles.input, { color: c.text }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.text3}
        secureTextEntry={!revealed}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="go"
      />
      <IconButton
        icon={revealed ? "eye.slash.fill" : "eye.fill"}
        size={30}
        iconSize={14}
        variant="ghost"
        haptic="selection"
        onPress={() => setRevealed((v) => !v)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 1000 },
  scroll: {
    paddingHorizontal: Spacing.xl + 4,
    paddingTop: Spacing.lg,
    alignItems: "center",
  },

  logoWrap: { marginTop: Spacing.lg, marginBottom: Spacing.lg },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontSize: 32, fontWeight: "700" },
  title: { ...Type.title },
  sub: {
    ...Type.footnote,
    marginTop: 4,
    marginBottom: Spacing.lg,
    textAlign: "center",
  },

  steps: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: Spacing.xl,
  },
  stepDot: { width: 8, height: 8, borderRadius: 4 },
  stepLine: { width: 32, height: 2, borderRadius: 1 },

  card: {
    width: "100%",
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    gap: 6,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: Spacing.xs,
  },
  label: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  labelHint: { ...Type.caption },

  inputBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    height: 48,
    borderRadius: Radius.lg,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs,
  },
  input: { flex: 1, ...Type.body, padding: 0 },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    marginTop: Spacing.sm,
  },
  errorText: { ...Type.footnote, flex: 1 },

  points: {
    marginTop: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.sm,
  },
  pointRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  pointIcon: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  pointText: { ...Type.subhead, flex: 1 },
  conceptText: { ...Type.subhead, lineHeight: 20 },

  footer: {
    paddingHorizontal: Spacing.xl + 4,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  footerRow: { flexDirection: "row", gap: Spacing.sm, alignItems: "center" },
  footerHint: { ...Type.caption, textAlign: "center" },
});
