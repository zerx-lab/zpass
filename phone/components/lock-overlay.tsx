// 锁定遮罩 —— 用户已设置主密码但 vault 处于锁定态时显示
//
// 走真实 Argon2id KDF + XChaCha20-Poly1305 校验：解锁失败时统一报"主密码错误"，
// 不区分 KDF 失败 / verifier 不匹配等内部原因（与 desktop 一致，防止侧信道）。

import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from "react-native";
import * as Haptics from "expo-haptics";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useVault } from "@/contexts/vault-context";
import { IconSymbol } from "@/components/ui/icon-symbol";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

export function LockOverlay() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const { unlock } = useVault();

  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleUnlock = async () => {
    if (!pw) {
      setError("请输入主密码");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await unlock(pw);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPw("");
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(res.message || "主密码错误");
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={[styles.logo, { backgroundColor: c.text }]}>
        <Text style={[styles.logoText, { color: c.bg }]}>Z</Text>
      </View>
      <Text style={[styles.title, { color: c.text }]}>ZPass 已锁定</Text>
      <Text style={[styles.sub, { color: c.text3, fontFamily: MONO }]}>
        输入主密码以解锁保险库
      </Text>

      <View
        style={[
          styles.inputBox,
          {
            backgroundColor: c.bgElev,
            borderColor: error ? c.danger : c.line,
          },
        ]}
      >
        <IconSymbol name="lock.fill" size={16} color={c.text3} />
        <TextInput
          style={[styles.input, { color: c.text }]}
          placeholder="主密码"
          placeholderTextColor={c.text3}
          value={pw}
          onChangeText={(t) => {
            setPw(t);
            setError(null);
          }}
          secureTextEntry
          autoFocus
          onSubmitEditing={handleUnlock}
          returnKeyType="go"
          editable={!busy}
        />
      </View>

      {error ? (
        <Text style={[styles.error, { color: c.danger }]}>{error}</Text>
      ) : null}

      <TouchableOpacity
        style={[styles.btn, { backgroundColor: c.text, opacity: busy ? 0.7 : 1 }]}
        onPress={handleUnlock}
        activeOpacity={0.8}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color={c.bg} />
        ) : (
          <Text style={[styles.btnText, { color: c.bg }]}>解锁</Text>
        )}
      </TouchableOpacity>

      <Text style={[styles.hint, { color: c.text4 }]}>
        零知识加密 · 主密码不会离开此设备
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 36,
    zIndex: 1000,
  },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  logoText: { fontSize: 28, fontWeight: "700" },
  title: { fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  sub: { fontSize: 12, marginTop: 6, marginBottom: 28 },
  inputBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    width: "100%",
    height: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  input: { flex: 1, fontSize: 15, padding: 0 },
  error: { fontSize: 12, alignSelf: "flex-start", marginBottom: 8 },
  btn: {
    width: "100%",
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  btnText: { fontSize: 15, fontWeight: "600" },
  hint: { fontSize: 11, marginTop: 24, textAlign: "center" },
});
