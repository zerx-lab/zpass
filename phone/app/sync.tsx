// 局域网同步 —— iOS HIG 风格重构
//
// 连接同局域网内已开启同步服务的桌面端：手输 IP/端口/PIN（或粘贴 zpass-sync:// URI 自动填充），
// 点连接后跑 connectAndSync。完成后显示统计；冲突列表只展示数量与提示「请到桌面端解决」。

import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import {
  connectAndSync,
  parseSyncQRPayload,
  type SyncProgress,
  type SyncResult,
} from "@/lib/sync-protocol";
import { toast } from "@/components/ui/dialog";
import { IconSymbol } from "@/components/ui/icon-symbol";
import {
  Button,
  IconButton,
} from "@/components/ui/primitives";

const MONO = Fonts?.mono ?? "monospace";

export default function SyncPage() {
  const { colors: c } = useTheme();
  const router = useRouter();
  const { refresh } = useVault();

  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [pin, setPin] = useState("");
  const [pinFocused, setPinFocused] = useState(false);
  const pinInputRef = useRef<TextInput>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 点击某格 → 从该格开始重输：截断 pin 到 i 长度,光标自然落在第 i 位。
  // 点已填末尾及以后的格只触发聚焦,不改 pin。
  const focusPinAt = (i: number) => {
    if (i < pin.length) setPin(pin.slice(0, i));
    pinInputRef.current?.focus();
  };

  const handlePastedQR = (text: string) => {
    const parsed = parseSyncQRPayload(text);
    if (parsed) {
      const m = parsed.baseUrl.match(/^http:\/\/([^:]+):(\d+)/);
      if (m) {
        setHost(m[1]);
        setPort(m[2]);
      }
      setPin(parsed.pin);
      return true;
    }
    return false;
  };

  const handleConnect = async () => {
    if (!host.trim() || !port.trim() || !pin.trim()) {
      toast.warn("请填写完整", "IP / 端口 / PIN 都不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    setProgress(null);
    setResult(null);
    try {
      const baseUrl = `http://${host.trim()}:${port.trim()}`;
      const r = await connectAndSync(baseUrl, pin.trim(), (p) =>
        setProgress(p),
      );
      setResult(r);
      try {
        await refresh();
      } catch (e) {
        console.warn("[sync] post-sync refresh failed:", e);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]} edges={["top"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={styles.nav}>
          <IconButton
            icon="chevron.left"
            size={36}
            iconSize={20}
            variant="ghost"
            onPress={() => router.back()}
          />
          <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
            局域网同步
          </Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <View style={[styles.heroIcon, { backgroundColor: c.info + "1f" }]}>
              <IconSymbol
                name="antenna.radiowaves.left.and.right"
                size={26}
                color={c.info}
              />
            </View>
            <Text style={[styles.heroTitle, { color: c.text }]}>
              连接桌面端
            </Text>
            <Text style={[styles.heroDesc, { color: c.text3 }]}>
              在桌面端「设置 → 安全 → 局域网同步」启动服务后，把屏幕上的 IP 与 PIN 填入此处
            </Text>
          </View>

          {/* 表单卡 */}
          <View style={[styles.card, { backgroundColor: c.bgElev }]}>
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: c.text3 }]}>对端 IP</Text>
              <TextInput
                value={host}
                onChangeText={(t) => {
                  if (!handlePastedQR(t)) setHost(t);
                }}
                placeholder="192.168.1.42"
                placeholderTextColor={c.text4}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="default"
                style={[styles.input, { color: c.text, backgroundColor: c.bg }]}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: c.text3 }]}>端口</Text>
              <TextInput
                value={port}
                onChangeText={setPort}
                placeholder="55432"
                placeholderTextColor={c.text4}
                keyboardType="number-pad"
                style={[
                  styles.input,
                  { color: c.text, backgroundColor: c.bg, fontFamily: MONO },
                ]}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: c.text3 }]}>
                PIN · 桌面端 6 位数字
              </Text>
              <View style={styles.pinRow}>
                {/* 隐藏 input 渲染在 cells 之下,pointerEvents=none 把点击全交给 cells */}
                <TextInput
                  ref={pinInputRef}
                  value={pin}
                  onChangeText={(t) =>
                    setPin(t.replace(/[^0-9]/g, "").slice(0, 6))
                  }
                  onFocus={() => setPinFocused(true)}
                  onBlur={() => setPinFocused(false)}
                  keyboardType="number-pad"
                  maxLength={6}
                  caretHidden
                  selectionColor="transparent"
                  style={styles.pinHiddenInput}
                  pointerEvents="none"
                />
                <View style={styles.pinCellsRow}>
                  {Array.from({ length: 6 }).map((_, i) => {
                    const ch = pin[i] ?? "";
                    const isCursor = pinFocused && pin.length === i;
                    return (
                      <Pressable
                        key={i}
                        onPress={() => focusPinAt(i)}
                        style={[
                          styles.pinCell,
                          {
                            backgroundColor: ch ? c.accent : c.bg,
                            borderWidth: isCursor ? 2 : 0,
                            borderColor: c.info,
                          },
                        ]}
                      >
                        {ch ? (
                          <Text
                            style={[
                              styles.pinCellText,
                              { color: c.accentInk, fontFamily: MONO },
                            ]}
                          >
                            {ch}
                          </Text>
                        ) : (
                          <View
                            style={[
                              styles.pinDot,
                              { backgroundColor: c.text4 },
                            ]}
                          />
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </View>

            <Button
              label={busy ? "连接中" : "连接并同步"}
              icon={busy ? undefined : "antenna.radiowaves.left.and.right"}
              variant="primary"
              size="lg"
              onPress={handleConnect}
              disabled={busy}
              fullWidth
              style={{ marginTop: Spacing.sm }}
            />
          </View>

          {/* 进度 */}
          {progress && (
            <View style={[styles.card, { backgroundColor: c.bgElev }]}>
              <View style={styles.cardHeader}>
                <ActivityIndicator size="small" color={c.info} />
                <Text style={[styles.cardTitle, { color: c.text }]}>
                  {progressLabel(progress.stage)}
                </Text>
              </View>
              {progress.total > 0 && (
                <View style={[styles.progressTrack, { backgroundColor: c.bgActive }]}>
                  <View
                    style={[
                      styles.progressBar,
                      {
                        backgroundColor: c.info,
                        width: `${Math.min(
                          100,
                          Math.floor((progress.processed / progress.total) * 100),
                        )}%`,
                      },
                    ]}
                  />
                </View>
              )}
              <Text style={[styles.hint, { color: c.text3, fontFamily: MONO }]}>
                {progress.processed} / {progress.total}
                {progress.message ? `  ${progress.message}` : ""}
              </Text>
            </View>
          )}

          {/* 结果 */}
          {result && (
            <View style={[styles.card, { backgroundColor: c.bgElev }]}>
              <View style={styles.cardHeader}>
                <View
                  style={[styles.statusIcon, { backgroundColor: c.ok + "1f" }]}
                >
                  <IconSymbol
                    name="checkmark.shield.fill"
                    size={16}
                    color={c.ok}
                  />
                </View>
                <Text style={[styles.cardTitle, { color: c.text }]}>
                  同步完成
                </Text>
              </View>
              <View style={styles.statRow}>
                <View style={styles.statCell}>
                  <Text style={[styles.statNum, { color: c.text, fontFamily: MONO }]}>
                    {result.applied}
                  </Text>
                  <Text style={[styles.statLabel, { color: c.text3 }]}>拉取</Text>
                </View>
                <View style={[styles.statDiv, { backgroundColor: c.lineSoft }]} />
                <View style={styles.statCell}>
                  <Text style={[styles.statNum, { color: c.text, fontFamily: MONO }]}>
                    {result.pushed}
                  </Text>
                  <Text style={[styles.statLabel, { color: c.text3 }]}>推送</Text>
                </View>
                <View style={[styles.statDiv, { backgroundColor: c.lineSoft }]} />
                <View style={styles.statCell}>
                  <Text
                    style={[
                      styles.statNum,
                      {
                        color: result.conflicts.length > 0 ? c.warn : c.text,
                        fontFamily: MONO,
                      },
                    ]}
                  >
                    {result.conflicts.length}
                  </Text>
                  <Text style={[styles.statLabel, { color: c.text3 }]}>冲突</Text>
                </View>
              </View>
              {result.conflicts.length > 0 && (
                <View
                  style={[
                    styles.warnBox,
                    { backgroundColor: c.warn + "1f" },
                  ]}
                >
                  <IconSymbol
                    name="exclamationmark.triangle.fill"
                    size={14}
                    color={c.warn}
                  />
                  <Text style={[styles.warnText, { color: c.warn }]}>
                    {result.conflicts.length} 项冲突待在桌面端解决
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* 错误 */}
          {error && (
            <View style={[styles.card, { backgroundColor: c.bgElev }]}>
              <View style={styles.cardHeader}>
                <View
                  style={[styles.statusIcon, { backgroundColor: c.danger + "1f" }]}
                >
                  <IconSymbol
                    name="xmark.circle.fill"
                    size={16}
                    color={c.danger}
                  />
                </View>
                <Text style={[styles.cardTitle, { color: c.danger }]}>
                  同步失败
                </Text>
              </View>
              <Text style={[styles.errorText, { color: c.text2 }]}>{error}</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function progressLabel(stage: SyncProgress["stage"]): string {
  switch (stage) {
    case "pairing":
      return "配对中…";
    case "manifest":
      return "拉取目录";
    case "fetch":
      return "拉取条目";
    case "push":
      return "推送条目";
    case "merge":
      return "等待解决冲突";
    case "commit":
      return "提交合并";
    case "done":
      return "完成";
    default:
      return stage;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
  },
  navTitle: { ...Type.title2, flex: 1, textAlign: "center" },

  content: { padding: Spacing.lg, gap: Spacing.md },

  hero: {
    alignItems: "center",
    paddingVertical: Spacing.lg,
    gap: Spacing.sm,
  },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.xl,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.xs,
  },
  heroTitle: { ...Type.title2 },
  heroDesc: {
    ...Type.footnote,
    textAlign: "center",
    paddingHorizontal: Spacing.md,
  },

  card: {
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  cardTitle: { ...Type.headline },
  statusIcon: {
    width: 28,
    height: 28,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
  },

  fieldGroup: { gap: 6 },
  label: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  input: {
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    ...Type.body,
  },

  pinRow: { position: "relative", height: 48 },
  pinCellsRow: {
    flexDirection: "row",
    gap: Spacing.xs,
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  pinCell: {
    flex: 1,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  pinCellText: { fontSize: 22, fontWeight: "700" },
  pinDot: { width: 6, height: 6, borderRadius: 3 },
  pinHiddenInput: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
  },

  hint: { ...Type.footnote },

  progressTrack: { height: 6, borderRadius: 3, overflow: "hidden" },
  progressBar: { height: "100%", borderRadius: 3 },

  statRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: Spacing.sm,
  },
  statCell: { flex: 1, alignItems: "center", gap: 2 },
  statDiv: { width: StyleSheet.hairlineWidth, height: 28 },
  statNum: { fontSize: 22, fontWeight: "700" },
  statLabel: {
    ...Type.caption,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },

  warnBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  warnText: { ...Type.footnote, fontWeight: "600", flex: 1 },

  errorText: { ...Type.footnote, lineHeight: 18 },
});
