// 首次进入：创建主密码 —— 真实加密 vault 的入口
//
// 对齐 desktop WelcomePage/OnboardingPage：用户在这里设置主密码，
// 派生 KEK / 生成 DEK / 写入 vault meta。完成后直接进入已解锁态。

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
import { isWasmKDF } from "@/lib/crypto";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

export function OnboardingOverlay() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const { initialize } = useVault();

  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canSubmit = pw.length >= 8 && pw === confirm && !busy;

  const handleSubmit = async () => {
    if (!canSubmit) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(
        pw.length < 8 ? "主密码至少 8 位" : pw !== confirm ? "两次输入不一致" : null,
      );
      return;
    }
    setBusy(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const res = await initialize(pw);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPw("");
      setConfirm("");
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(res.message || "初始化失败");
    }
  };

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
            <View style={[styles.logo, { backgroundColor: c.text }]}>
              <Text style={[styles.logoText, { color: c.bg }]}>Z</Text>
            </View>
            <Text style={[styles.title, { color: c.text }]}>欢迎使用 ZPass</Text>
            <Text style={[styles.sub, { color: c.text3, fontFamily: MONO }]}>
              设置主密码以创建本地加密保险库
            </Text>

            <View
              style={[
                styles.card,
                { backgroundColor: c.bgElev, borderColor: c.line },
              ]}
            >
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
                onSubmitEditing={handleSubmit}
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
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[
                styles.btn,
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
                <Text style={[styles.btnText, { color: c.bg }]}>创建保险库</Text>
              )}
            </TouchableOpacity>
            <Text style={[styles.footerHint, { color: c.text4 }]}>
              {isWasmKDF()
                ? "WASM 加速 · 派生大约 0.5 秒"
                : "纯 JS 派生 · 约 3-6 秒"}
            </Text>
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

  logo: {
    width: 52,
    height: 52,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
    marginTop: 16,
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

  footer: { paddingHorizontal: 24, paddingTop: 12, gap: 10 },
  btn: {
    height: 50,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { fontSize: 15, fontWeight: "700" },
  footerHint: { fontSize: 11, textAlign: "center" },
});
