// 作为同步服务端 —— 让别的设备（其它手机 / 鸿蒙 / PC）连到本机同步
//
// 启动后展示 PIN + IP:port + 二维码；对端用 client 模式连接。当连入端上报冲突时，
// 本机弹出 banner → 进入 app/sync-conflicts.tsx 由本机用户决策。
// 仅 Android（监听 socket 由原生 tiny_http 提供）；vault 锁定时自动停服。

import { useEffect } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import { syncServer, useSyncServer, type SyncServerStatus } from "@/lib/sync-server";
import { copyText } from "@/lib/clipboard";
import { dialog, toast } from "@/components/ui/dialog";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { Button, IconButton } from "@/components/ui/primitives";
import { QRCode } from "@/components/ui/qr-code";

const MONO = Fonts?.mono ?? "monospace";

export default function SyncHostPage() {
  const { colors: c } = useTheme();
  const router = useRouter();
  const { locked } = useVault();
  const server = useSyncServer();

  // 锁定即停服（避免已配对对端继续读取已锁 vault → 一连串 500）。
  // 用模块级稳定的 syncServer（非响应式），仅依赖 locked。
  useEffect(() => {
    if (locked && syncServer.isRunning()) {
      void syncServer.stopServer();
    }
  }, [locked]);

  // 离开本屏（pop 回上级）时停服
  useEffect(() => {
    return () => {
      void syncServer.stopServer();
    };
  }, []);

  const handleToggle = async () => {
    if (server.running) {
      const ok = await dialog.confirm(
        "停止同步服务",
        "停止后对端将无法连接。确认停止？",
        { okLabel: "停止", destructive: true },
      );
      if (ok) await server.stopServer();
      return;
    }
    try {
      await server.startServer();
    } catch (e) {
      toast.warn("无法启动", e instanceof Error ? e.message : String(e));
    }
  };

  const copyAddr = async (addr: string) => {
    await copyText(addr);
    toast.ok("已复制", addr);
  };

  const conflictCount = server.pendingConflicts.length;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]} edges={["top"]}>
      <View style={styles.nav}>
        <IconButton
          icon="chevron.left"
          size={36}
          iconSize={20}
          variant="ghost"
          onPress={() => router.back()}
        />
        <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
          同步服务端
        </Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View style={[styles.heroIcon, { backgroundColor: c.info + "1f" }]}>
            <IconSymbol name="person.2.fill" size={26} color={c.info} />
          </View>
          <Text style={[styles.heroTitle, { color: c.text }]}>让别人连我</Text>
          <Text style={[styles.heroDesc, { color: c.text3 }]}>
            在另一台设备的「局域网同步」里扫码或手输下方 IP 与 PIN 即可连接到本机同步
          </Text>
        </View>

        <Button
          label={server.running ? "停止服务" : "启动服务"}
          icon={server.running ? "stop.fill" : "play.fill"}
          variant={server.running ? "danger" : "primary"}
          size="lg"
          onPress={handleToggle}
          fullWidth
        />

        {server.running ? (
          <>
            {/* 状态 */}
            <View style={[styles.statusRow, { backgroundColor: c.bgElev }]}>
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor:
                      conflictCount > 0
                        ? c.warn
                        : server.status === "paired" ||
                            server.status === "applying"
                          ? c.info
                          : c.ok,
                  },
                ]}
              />
              <Text style={[styles.statusText, { color: c.text2 }]}>
                {statusLabel(server.status, conflictCount)}
              </Text>
            </View>

            {/* 冲突 banner */}
            {conflictCount > 0 ? (
              <Pressable
                onPress={() => router.push("/sync-conflicts" as never)}
                style={[styles.conflictBox, { backgroundColor: c.warn + "1f" }]}
              >
                <IconSymbol
                  name="exclamationmark.triangle.fill"
                  size={18}
                  color={c.warn}
                />
                <Text style={[styles.conflictText, { color: c.warn }]}>
                  {conflictCount} 项冲突待解决
                </Text>
                <IconSymbol name="chevron.right" size={16} color={c.warn} />
              </Pressable>
            ) : null}

            {/* PIN */}
            <View style={[styles.card, { backgroundColor: c.bgElev }]}>
              <Text style={[styles.label, { color: c.text3 }]}>配对 PIN</Text>
              <View style={styles.pinRow}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <View
                    key={i}
                    style={[styles.pinCell, { backgroundColor: c.accent }]}
                  >
                    <Text
                      style={[
                        styles.pinCellText,
                        { color: c.accentInk, fontFamily: MONO },
                      ]}
                    >
                      {server.pin[i] ?? ""}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* 地址 */}
            <View style={[styles.card, { backgroundColor: c.bgElev }]}>
              <Text style={[styles.label, { color: c.text3 }]}>
                本机地址 · 端口 {server.port}
              </Text>
              {server.hosts.length === 0 ? (
                <Text style={[styles.addrEmpty, { color: c.text3 }]}>
                  未检测到局域网地址，请确认已连接 Wi-Fi
                </Text>
              ) : (
                server.hosts.map((h) => {
                  const addr = `${h}:${server.port}`;
                  return (
                    <Pressable
                      key={h}
                      onPress={() => copyAddr(addr)}
                      style={[styles.addrRow, { backgroundColor: c.bg }]}
                    >
                      <Text
                        style={[styles.addrText, { color: c.text, fontFamily: MONO }]}
                        numberOfLines={1}
                      >
                        {addr}
                      </Text>
                      <IconSymbol name="doc.on.doc.fill" size={15} color={c.text3} />
                    </Pressable>
                  );
                })
              )}
            </View>

            {/* 二维码 */}
            {server.qrPayload ? (
              <View style={[styles.card, styles.qrCard, { backgroundColor: c.bgElev }]}>
                <Text style={[styles.label, { color: c.text3, alignSelf: "flex-start" }]}>
                  扫码连接
                </Text>
                <QRCode value={server.qrPayload} size={200} />
                <Text style={[styles.qrHint, { color: c.text3 }]}>
                  另一台手机用「局域网同步」扫此码即可自动填充
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <Text style={[styles.idleHint, { color: c.text3 }]}>
            启动后本机会监听局域网连接；保持本页打开，对端连接期间请勿锁屏。
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function statusLabel(status: SyncServerStatus, conflicts: number): string {
  if (conflicts > 0) return "收到冲突，待你解决";
  switch (status) {
    case "listening":
      return "等待设备连接…";
    case "paired":
      return "已配对，正在同步…";
    case "merge":
      return "正在处理冲突…";
    case "applying":
      return "正在应用决策…";
    case "done":
      return "同步完成，可继续等待新连接";
    case "starting":
      return "启动中…";
    default:
      return "服务运行中";
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

  hero: { alignItems: "center", paddingVertical: Spacing.lg, gap: Spacing.sm },
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

  card: { borderRadius: Radius.xl, padding: Spacing.lg, gap: Spacing.sm },
  label: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { ...Type.subhead, flex: 1 },

  conflictBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  conflictText: { ...Type.bodyEmph, flex: 1, fontWeight: "600" },

  pinRow: { flexDirection: "row", gap: Spacing.xs },
  pinCell: {
    flex: 1,
    height: 48,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  pinCellText: { fontSize: 22, fontWeight: "700" },

  addrRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
  },
  addrText: { ...Type.body, flex: 1 },
  addrEmpty: { ...Type.footnote },

  qrCard: { alignItems: "center", gap: Spacing.md },
  qrHint: { ...Type.footnote, textAlign: "center" },

  idleHint: {
    ...Type.footnote,
    textAlign: "center",
    paddingHorizontal: Spacing.lg,
    lineHeight: 18,
  },
});
