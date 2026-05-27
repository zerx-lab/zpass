// 锁定遮罩 —— iOS HIG 风格重构
//
// 用户已设置主密码但 vault 处于锁定态时显示。
// 走真实 Argon2id KDF + XChaCha20-Poly1305 校验；失败统一报"主密码错误"，
// 不区分 KDF 失败 / verifier 不匹配等内部原因（与 desktop 一致，防侧信道）。

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import * as Haptics from "expo-haptics";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SpaceAvatar } from "@/components/space-avatar";
import {
  Button,
  PressableScale,
} from "@/components/ui/primitives";

const MONO = Fonts?.mono ?? "monospace";

export function LockOverlay() {
  const { colors: c } = useTheme();
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
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  };

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
          size={72}
          background={c.accent}
          foreground={c.accentInk}
          fontSize={32}
          borderRadius={Radius.xl + 4}
        />
        <View
          style={[
            styles.lockBadge,
            { backgroundColor: c.danger, borderColor: c.bg },
          ]}
        >
          <IconSymbol name="lock.fill" size={11} color="#fff" />
        </View>
      </View>

      <Text style={[styles.title, { color: c.text }]}>
        {activeSpace?.name ?? "ZPass"}
      </Text>
      <Text style={[styles.sub, { color: c.text3 }]}>
        输入主密码以解锁保险库
      </Text>

      <View
        style={[
          styles.inputBox,
          {
            backgroundColor: c.bgElev,
            borderColor: error ? c.danger : "transparent",
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
        <View style={styles.errorRow}>
          <IconSymbol
            name="exclamationmark.circle.fill"
            size={12}
            color={c.danger}
          />
          <Text style={[styles.errorText, { color: c.danger }]}>{error}</Text>
        </View>
      ) : (
        <View style={{ height: 16, marginBottom: Spacing.sm }} />
      )}

      <Button
        label={busy ? "解锁中" : "解锁"}
        icon={busy ? undefined : "lock.shield.fill"}
        variant="primary"
        size="lg"
        onPress={handleUnlock}
        disabled={busy}
        fullWidth
        style={{ width: "100%" }}
      />

      {busy ? (
        <View style={styles.spinnerOverlay} pointerEvents="none">
          <ActivityIndicator color={c.accentInk} />
        </View>
      ) : null}

      {showTrustedButton ? (
        <PressableScale
          onPress={handleTrustedUnlock}
          disabled={trustedDeviceTrying || busy}
          scale={0.97}
          haptic="medium"
          pressedBg={c.bgHover}
          style={[
            styles.trustedBtn,
            {
              opacity: trustedDeviceTrying || busy ? 0.6 : 1,
            },
          ]}
        >
          {trustedDeviceTrying ? (
            <ActivityIndicator color={c.text} size="small" />
          ) : (
            <>
              <IconSymbol name="faceid" size={18} color={c.info} />
              <Text style={[styles.trustedBtnText, { color: c.info }]}>
                使用设备解锁
              </Text>
            </>
          )}
        </PressableScale>
      ) : null}

      <Text style={[styles.hint, { color: c.text4, fontFamily: MONO }]}>
        零知识加密 · 主密码永不离开此设备
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.xxl + Spacing.md,
    zIndex: 1000,
  },
  logoWrap: {
    marginBottom: Spacing.xl,
    position: "relative",
  },
  lockBadge: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { ...Type.title },
  sub: { ...Type.footnote, marginTop: 4, marginBottom: Spacing.xxl },
  inputBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    width: "100%",
    height: 50,
    borderRadius: Radius.lg,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    marginBottom: 4,
  },
  input: { flex: 1, ...Type.body, padding: 0 },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    marginTop: Spacing.xs,
    marginBottom: Spacing.sm,
    height: 16,
  },
  errorText: { ...Type.footnote, fontWeight: "500" },
  spinnerOverlay: {
    position: "absolute",
    width: "100%",
    bottom: 200,
    alignItems: "center",
  },
  trustedBtn: {
    width: "100%",
    height: 48,
    borderRadius: Radius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  trustedBtnText: { ...Type.subhead, fontWeight: "600" },
  hint: {
    ...Type.caption,
    marginTop: Spacing.xxl,
    textAlign: "center",
  },
});
