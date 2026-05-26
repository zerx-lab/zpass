// 锁定遮罩 —— 用户已设置主密码但 vault 处于锁定态时显示
//
// 走真实 Argon2id KDF + XChaCha20-Poly1305 校验：解锁失败时统一报"主密码错误"，
// 不区分 KDF 失败 / verifier 不匹配等内部原因（与 desktop 一致，防止侧信道）。

import React, { useEffect, useRef, useState } from "react";
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
import { SpaceAvatar } from "@/components/space-avatar";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

export function LockOverlay() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const {
    unlock,
    activeSpace,
    trustedDeviceSupported,
    trustedDeviceEnabled,
    trustedDeviceTrying,
    tryUnlockWithTrustedDevice,
  } = useVault();

  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 是否显示"使用设备解锁"按钮 —— 平台支持 + 当前 vault 启用
  const showTrustedButton = trustedDeviceSupported && trustedDeviceEnabled;

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

  const handleTrustedUnlock = async () => {
    if (!showTrustedButton || trustedDeviceTrying) return;
    setError(null);
    const ok = await tryUnlockWithTrustedDevice();
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPw("");
    } else {
      // 失败不弹错误 —— context 已把 enabled 翻成 false（OS 凭据失效），
      // 用户自然看到按钮消失，回落主密码输入即可（desktop 同行为）。
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  };

  // 首次挂载时自动尝试一次信任设备解锁 —— 与 desktop LockSync 行为对齐。
  // useRef 防 StrictMode 双调用。
  const autoTriedRef = useRef(false);
  useEffect(() => {
    if (autoTriedRef.current) return;
    if (!showTrustedButton) return;
    autoTriedRef.current = true;
    void tryUnlockWithTrustedDevice();
  }, [showTrustedButton, tryUnlockWithTrustedDevice]);

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={styles.logoWrap}>
        <SpaceAvatar
          space={activeSpace}
          size={56}
          background={c.text}
          foreground={c.bg}
          fontSize={28}
          borderRadius={14}
        />
      </View>
      <Text style={[styles.title, { color: c.text }]}>
        {activeSpace ? `「${activeSpace.name}」已锁定` : "ZPass 已锁定"}
      </Text>
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

      {showTrustedButton ? (
        <TouchableOpacity
          style={[
            styles.trustedBtn,
            {
              borderColor: c.line,
              opacity: trustedDeviceTrying || busy ? 0.6 : 1,
            },
          ]}
          onPress={handleTrustedUnlock}
          activeOpacity={0.8}
          disabled={trustedDeviceTrying || busy}
        >
          {trustedDeviceTrying ? (
            <ActivityIndicator color={c.text} />
          ) : (
            <>
              <IconSymbol name="faceid" size={16} color={c.text} />
              <Text style={[styles.trustedBtnText, { color: c.text }]}>
                使用设备解锁
              </Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}

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
  logoWrap: { marginBottom: 20 },
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
  trustedBtn: {
    width: "100%",
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 10,
  },
  trustedBtnText: { fontSize: 14, fontWeight: "500" },
  hint: { fontSize: 11, marginTop: 24, textAlign: "center" },
});
