// 局域网同步 —— 连接 desktop sync server（phone 作为 client）
//
// 功能：手输 IP+端口+PIN（或粘贴 zpass-sync://... URI 自动填充），点连接
// 后跑 connectAndSync。完成后显示统计：拉取 N 条 / 推送 M 条 / 冲突 K 条。
// 冲突列表只展示数量与提示「请到 desktop 端解决」—— 按用户要求，phone 不
// 做冲突 UI。

import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useVault } from "@/contexts/vault-context";
import {
  connectAndSync,
  parseSyncQRPayload,
  type SyncProgress,
  type SyncResult,
} from "@/lib/sync-protocol";
import { toast } from "@/components/ui/dialog";

const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

export default function SyncPage() {
  const scheme = useColorScheme();
  const c = Colors[scheme ?? "light"];
  const router = useRouter();
  const { refresh } = useVault();

  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      // 同步路径绕过 VaultContext 直接改 vault 文件，内存 state 还是同步前
      // 的快照。无论 applied / pushed / conflict resolutions 都可能改了文件，
      // 统一 refresh 一次让 UI 立刻反映新状态，不必让用户重启 app。
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
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()}>
              <Text style={{ color: c.accent, fontSize: 14 }}>返回</Text>
            </TouchableOpacity>
            <Text style={[styles.title, { color: c.text }]}>局域网同步</Text>
            <View style={{ width: 40 }} />
          </View>

          <Text style={[styles.subtitle, { color: c.text3 }]}>
            连接同局域网内已开启同步服务的桌面端 ZPass。
          </Text>

          <View style={[styles.card, { backgroundColor: c.bgElev, borderColor: c.line }]}>
            <Text style={[styles.label, { color: c.text3 }]}>对端地址</Text>
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
              style={[styles.input, { color: c.text, borderColor: c.line }]}
            />
            <Text style={[styles.label, { color: c.text3 }]}>端口</Text>
            <TextInput
              value={port}
              onChangeText={setPort}
              placeholder="55432"
              placeholderTextColor={c.text4}
              keyboardType="number-pad"
              style={[
                styles.input,
                { color: c.text, borderColor: c.line, fontFamily: MONO },
              ]}
            />
            <Text style={[styles.label, { color: c.text3 }]}>
              PIN（对端屏幕上 6 位数字）
            </Text>
            <TextInput
              value={pin}
              onChangeText={setPin}
              placeholder="123456"
              placeholderTextColor={c.text4}
              keyboardType="number-pad"
              maxLength={6}
              style={[
                styles.input,
                styles.pinInput,
                { color: c.text, borderColor: c.line, fontFamily: MONO },
              ]}
            />
            <TouchableOpacity
              onPress={handleConnect}
              disabled={busy}
              style={[
                styles.button,
                { backgroundColor: busy ? c.text4 : c.accent },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>连接并同步</Text>
              )}
            </TouchableOpacity>
            <Text style={[styles.hint, { color: c.text4 }]}>
              提示：在桌面端「设置 → 安全 → 局域网同步」启动服务端后，把屏幕上
              的 PIN 和 IP 填入此处。
            </Text>
          </View>

          {progress && (
            <View
              style={[styles.card, { backgroundColor: c.bgElev, borderColor: c.line }]}
            >
              <Text style={[styles.cardTitle, { color: c.text }]}>
                {progressLabel(progress.stage)}
              </Text>
              {progress.total > 0 && (
                <View style={[styles.progressTrack, { backgroundColor: c.bg }]}>
                  <View
                    style={[
                      styles.progressBar,
                      {
                        backgroundColor: c.accent,
                        width: `${Math.min(
                          100,
                          Math.floor((progress.processed / progress.total) * 100),
                        )}%`,
                      },
                    ]}
                  />
                </View>
              )}
              <Text style={[styles.hint, { color: c.text3 }]}>
                {progress.processed}/{progress.total}
                {progress.message ? `  ${progress.message}` : ""}
              </Text>
            </View>
          )}

          {result && (
            <View
              style={[styles.card, { backgroundColor: c.bgElev, borderColor: c.line }]}
            >
              <Text style={[styles.cardTitle, { color: c.text }]}>同步完成</Text>
              <Text style={[styles.statLine, { color: c.text2 }]}>
                拉取 <Text style={styles.statNum}>{result.applied}</Text> 条
              </Text>
              <Text style={[styles.statLine, { color: c.text2 }]}>
                推送 <Text style={styles.statNum}>{result.pushed}</Text> 条
              </Text>
              {result.conflicts.length > 0 && (
                <Text style={[styles.statLine, { color: c.warn }]}>
                  {result.conflicts.length} 项冲突待在桌面端解决
                </Text>
              )}
            </View>
          )}

          {error && (
            <View
              style={[
                styles.card,
                { backgroundColor: c.bgElev, borderColor: c.danger },
              ]}
            >
              <Text style={[styles.cardTitle, { color: c.danger }]}>
                同步失败
              </Text>
              <Text style={[styles.hint, { color: c.text2 }]}>{error}</Text>
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
  content: { padding: 16, gap: 12 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 8,
  },
  title: { fontSize: 16, fontWeight: "600" },
  subtitle: { fontSize: 13, lineHeight: 18 },
  card: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  cardTitle: { fontSize: 14, fontWeight: "600", marginBottom: 4 },
  label: { fontSize: 11, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  pinInput: { letterSpacing: 6, textAlign: "center", fontSize: 18 },
  button: {
    marginTop: 6,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  hint: { fontSize: 11, lineHeight: 16 },
  progressTrack: { height: 6, borderRadius: 3, overflow: "hidden" },
  progressBar: { height: "100%", borderRadius: 3 },
  statLine: { fontSize: 13, lineHeight: 20 },
  statNum: { fontFamily: MONO, fontWeight: "600" },
});
