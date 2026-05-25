// 首次进入：两步引导 —— 创建主密码 + 设置首个空间名
//
// 与 desktop WelcomePage → OnboardingPage 的两步流程对齐：
//   1. 设主密码（派生 KEK / 生成 DEK / 写 vault meta）
//   2. 给"默认空间"取个用户自己的名字（替换写死的"默认"）
//
// 实现要点：
//   - 整个流程都在本组件内部用 step state 控制，**不在第 1 步立刻
//     initialize**。原因：一旦 initialize 成功，外层 `!initialized` 翻转，
//     OnboardingOverlay 会被卸载，第 2 步根本来不及挂上。
//   - 第 1 步只暂存密码到组件内存，等用户在第 2 步点"创建保险库"才一次性
//     执行 initialize(pw) → renameSpace(DEFAULT_SPACE_ID, name)。
//   - 这样 KDF 的等待发生在最后，按钮上有 spinner + 文案提示。
//
// 头像即时预览：第 2 步输入框旁边的方块跟随空间名首字符变化（中文 / emoji
// 通过 Array.from 防截断），让用户在落库前就能感受到"我的空间长这样"。

import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useVault } from "@/contexts/vault-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SpaceAvatar } from "@/components/space-avatar";
import { isNativeKDF, isWasmKDF } from "@/lib/crypto";
import { DEFAULT_SPACE_ID } from "@/lib/spaces";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

type Step = "password" | "space";

export function OnboardingOverlay() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
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
  const canSubmit = trimmedSpace.length > 0 && trimmedSpace.length <= 32 && !busy;

  /* ---------------- step 切换 ---------------- */

  const handleNext = () => {
    if (!canNext) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(
        pw.length < 8 ? "主密码至少 8 位" : pw !== confirm ? "两次输入不一致" : null,
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

  /* ---------------- 最终提交：initialize + 重命名默认空间 ---------------- */

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
    // initialize 内部已自动建默认空间（id=DEFAULT_SPACE_ID, name="默认"）；
    // 把它改成用户填写的名字。改名失败不致命 —— 默认空间已经存在，用户
    // 之后还能在"我的"页面手动重命名；这里只给个提示，不回退 init。
    const rn = await renameSpace(DEFAULT_SPACE_ID, trimmedSpace);
    setBusy(false);
    if (!rn.ok) {
      console.warn("[onboarding] rename default space failed:", rn.message);
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // 组件会随 initialized=true 自动卸载；状态置空作为防御
    setPw("");
    setConfirm("");
    setSpaceName("");
  };

  /* ---------------- 渲染 ---------------- */

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
            {/* Step Header —— 复用一份品牌方块；第 2 步用 SpaceAvatar 预览 */}
            <View style={styles.logoWrap}>
              {isPasswordStep ? (
                <View style={[styles.logo, { backgroundColor: c.text }]}>
                  <Text style={[styles.logoText, { color: c.bg }]}>Z</Text>
                </View>
              ) : (
                <SpaceAvatar
                  space={{ name: trimmedSpace }}
                  size={52}
                  background={c.text}
                  foreground={c.bg}
                  fontSize={26}
                  borderRadius={13}
                />
              )}
            </View>

            <Text style={[styles.title, { color: c.text }]}>
              {isPasswordStep ? "欢迎使用 ZPass" : "为你的空间取个名字"}
            </Text>
            <Text style={[styles.sub, { color: c.text3, fontFamily: MONO }]}>
              {isPasswordStep
                ? "第 1 步 / 共 2 步 · 设置主密码"
                : "第 2 步 / 共 2 步 · 头像首字符会跟随名字"}
            </Text>

            <View
              style={[
                styles.card,
                { backgroundColor: c.bgElev, borderColor: c.line },
              ]}
            >
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

                  <View style={{ height: 12 }} />
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
                    <Text style={[styles.error, { color: c.danger }]}>{error}</Text>
                  ) : null}

                  <View style={[styles.points, { borderTopColor: c.lineSoft }]}>
                    {[
                      "数据仅保存在本设备，零知识端到端",
                      "Argon2id 派生主密码 → XChaCha20-Poly1305 加密",
                      "主密码不会离开设备，丢失无法恢复",
                    ].map((p) => (
                      <View key={p} style={styles.pointRow}>
                        <IconSymbol name="checkmark" size={13} color={c.text2} />
                        <Text style={[styles.pointText, { color: c.text2 }]}>{p}</Text>
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
                  <View
                    style={[
                      styles.inputBox,
                      {
                        backgroundColor: c.bg,
                        borderColor: c.line,
                      },
                    ]}
                  >
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
                    <Text style={[styles.error, { color: c.danger }]}>{error}</Text>
                  ) : null}

                  <View style={[styles.points, { borderTopColor: c.lineSoft }]}>
                    <Text style={[styles.conceptText, { color: c.text2 }]}>
                      空间是 ZPass 里的顶层隔离容器，类似不同账号。每个空间
                      独立存放条目，可以随时新建、切换、重命名。
                    </Text>
                  </View>
                </>
              )}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            {isPasswordStep ? (
              <>
                <TouchableOpacity
                  style={[
                    styles.btn,
                    {
                      backgroundColor: canNext ? c.text : c.line,
                      opacity: canNext ? 1 : 0.7,
                    },
                  ]}
                  onPress={handleNext}
                  activeOpacity={0.85}
                  disabled={!canNext}
                >
                  <Text style={[styles.btnText, { color: c.bg }]}>下一步</Text>
                </TouchableOpacity>
                <Text style={[styles.footerHint, { color: c.text4 }]}>
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
                  <TouchableOpacity
                    style={[
                      styles.btnGhost,
                      { borderColor: c.line, opacity: busy ? 0.5 : 1 },
                    ]}
                    onPress={handleBack}
                    activeOpacity={0.85}
                    disabled={busy}
                  >
                    <Text style={[styles.btnGhostText, { color: c.text2 }]}>
                      返回
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.btn,
                      styles.btnFlex,
                      {
                        backgroundColor: canSubmit ? c.text : c.line,
                        opacity: canSubmit ? 1 : 0.7,
                      },
                    ]}
                    onPress={handleSubmit}
                    activeOpacity={0.85}
                    disabled={!canSubmit}
                  >
                    {busy ? (
                      <ActivityIndicator color={c.bg} />
                    ) : (
                      <Text style={[styles.btnText, { color: c.bg }]}>
                        创建保险库
                      </Text>
                    )}
                  </TouchableOpacity>
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
  c: (typeof Colors)["dark"];
}) {
  return (
    <View style={styles.labelRow}>
      <Text style={[styles.label, { color: c.text2 }]}>{label}</Text>
      {hint ? (
        <Text style={[styles.labelHint, { color: c.text3, fontFamily: MONO }]}>
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
  c: (typeof Colors)["dark"];
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
          borderColor: error ? c.danger : c.line,
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
      <TouchableOpacity
        onPress={() => setRevealed((v) => !v)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <IconSymbol
          name={revealed ? "eye.slash.fill" : "eye.fill"}
          size={16}
          color={c.text3}
        />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 1000 },
  scroll: { paddingHorizontal: 24, paddingTop: 16, alignItems: "center" },

  logoWrap: { marginTop: 16, marginBottom: 16 },
  logo: {
    width: 52,
    height: 52,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontSize: 26, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  sub: { fontSize: 12, marginTop: 6, marginBottom: 24, textAlign: "center" },

  card: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    padding: 18,
    gap: 6,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  label: { fontSize: 12, fontWeight: "600" },
  labelHint: { fontSize: 10 },
  inputBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 46,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  input: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  error: {
    marginTop: 10,
    fontSize: 12,
  },
  points: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 7,
  },
  pointRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pointText: { fontSize: 12.5 },
  conceptText: { fontSize: 12.5, lineHeight: 19 },

  footer: { paddingHorizontal: 24, paddingTop: 12, gap: 10 },
  footerRow: { flexDirection: "row", gap: 10 },
  btn: {
    height: 50,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  btnFlex: { flex: 1 },
  btnText: { fontSize: 15, fontWeight: "700" },
  btnGhost: {
    height: 50,
    minWidth: 96,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  btnGhostText: { fontSize: 14, fontWeight: "600" },
  footerHint: { fontSize: 11, textAlign: "center" },
});
