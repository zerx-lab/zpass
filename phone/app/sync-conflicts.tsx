// 解决冲突（server 模式）—— 全屏单条流
//
// 连入端把它检测到的冲突上报到本机后，本机用户在此逐条决策：用本机 / 用对端 /
// 两者都留 / 跳过。应用全部后写本机 vault 并把 action 列表交给连入端轮询取走。
// UI 词汇与 app/sync.tsx 一致；敏感字段走 MaskedValue 遮罩。

import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import {
  useSyncServer,
  type ConflictChoice,
  type ServerConflict,
} from "@/lib/sync-server";
import type { ItemPayload } from "@/lib/vault-service";
import { toast } from "@/components/ui/dialog";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { Badge, IconButton, MaskedValue } from "@/components/ui/primitives";

const MONO = Fonts?.mono ?? "monospace";

const KIND_LABELS: Record<string, string> = {
  concurrent_edit: "并发编辑",
  divergent_content: "内容分叉",
  delete_vs_edit: "一方删除一方修改",
};

const FIELD_LABELS: Record<string, string> = {
  username: "用户名",
  password: "密码",
  url: "网址",
  notes: "备注",
  totp: "TOTP",
  number: "卡号",
  cvv: "安全码",
  pin: "PIN",
  expiry: "有效期",
  cardholder: "持卡人",
  email: "邮箱",
  phone: "电话",
  apiKey: "Token",
  secret: "密钥",
  privateKey: "私钥",
  publicKey: "公钥",
  host: "主机",
  passport: "护照号",
};

const HIDDEN_KEYS = new Set(["spaceId"]);

function fieldLabel(k: string): string {
  return FIELD_LABELS[k] ?? k;
}

function isSensitive(k: string): boolean {
  return /password|secret|cvv|pin|token|apikey|seed|private|key/i.test(k);
}

function fmtTime(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fieldMap(p: ItemPayload | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!p) return m;
  for (const [k, v] of Object.entries(p.fields ?? {})) {
    if (HIDDEN_KEYS.has(k)) continue;
    if (v == null || v === "") continue;
    m.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  return m;
}

export default function SyncConflictsPage() {
  const { colors: c } = useTheme();
  const router = useRouter();
  const { refresh } = useVault();
  const server = useSyncServer();

  const conflicts = server.pendingConflicts;
  const [index, setIndex] = useState(0);
  const [applying, setApplying] = useState(false);

  // 进场按 suggestedRemote 预选默认决策（建议→对端，否则本机），与桌面端一致
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || conflicts.length === 0) return;
    seededRef.current = true;
    for (const conf of conflicts) {
      if (!conf.resolution) {
        server.resolveConflict(
          conf.id,
          conf.suggestedRemote ? "remote" : "local",
        );
      }
    }
  }, [conflicts, server]);

  const safeIndex = Math.min(index, Math.max(0, conflicts.length - 1));
  const current: ServerConflict | undefined = conflicts[safeIndex];
  const allResolved =
    conflicts.length > 0 && conflicts.every((x) => !!x.resolution);

  const localFields = useMemo(() => fieldMap(current?.local ?? null), [current]);
  const remoteFields = useMemo(
    () => fieldMap(current?.remote ?? null),
    [current],
  );

  const handleChoose = (choice: ConflictChoice) => {
    if (!current) return;
    server.resolveConflict(current.id, choice);
    // 自动跳到下一条未决（若有），否则停在本条
    const nextUnresolved = conflicts.findIndex(
      (x, i) => i > safeIndex && !x.resolution,
    );
    if (nextUnresolved >= 0) setIndex(nextUnresolved);
  };

  const handleBulkRemote = () => {
    for (const conf of conflicts) server.resolveConflict(conf.id, "remote");
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const n = await server.applyMerge();
      try {
        await refresh();
      } catch {
        /* UI 刷新失败不影响合并结果 */
      }
      toast.ok("已解决", `${n} 项已应用，对端将自动收到`);
      router.back();
    } catch (e) {
      toast.warn("无法应用", e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  };

  // 空态（host 清空了冲突 / 直接进入）
  if (!current) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]} edges={["top"]}>
        <Nav title="解决冲突" onBack={() => router.back()} c={c} />
        <View style={styles.empty}>
          <IconSymbol name="checkmark.circle.fill" size={40} color={c.ok} />
          <Text style={[styles.emptyText, { color: c.text3 }]}>
            没有待解决的冲突
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const localNewer =
    (current.localManifest?.updatedAt ?? 0) >=
    (current.remoteManifest?.updatedAt ?? 0);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]} edges={["top"]}>
      <Nav
        title={`解决冲突  ${safeIndex + 1} / ${conflicts.length}`}
        onBack={() => router.back()}
        c={c}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleBlock}>
          <Text style={[styles.itemName, { color: c.text }]} numberOfLines={1}>
            {current.local?.name ?? current.remote?.name ?? current.id}
          </Text>
          <Text style={[styles.kind, { color: c.text3 }]}>
            {KIND_LABELS[current.kind] ?? current.kind}
          </Text>
        </View>

        {/* 本机 */}
        <SideCard
          c={c}
          label="本机（此设备）"
          payload={current.local}
          fields={localFields}
          otherFields={remoteFields}
          updatedAt={current.localManifest?.updatedAt}
          newer={localNewer}
        />

        {/* 对端 */}
        <SideCard
          c={c}
          label="对端（连入设备）"
          payload={current.remote}
          fields={remoteFields}
          otherFields={localFields}
          updatedAt={current.remoteManifest?.updatedAt}
          newer={!localNewer}
          suggested={current.suggestedRemote}
        />

        {/* 决策按钮 */}
        <View style={styles.choiceGrid}>
          <ChoiceButton
            c={c}
            label="用本机"
            icon="checkmark"
            active={current.resolution === "local"}
            onPress={() => handleChoose("local")}
          />
          <ChoiceButton
            c={c}
            label={current.suggestedRemote ? "用对端 · 建议" : "用对端"}
            icon="checkmark"
            active={current.resolution === "remote"}
            onPress={() => handleChoose("remote")}
          />
          <ChoiceButton
            c={c}
            label="两者都留"
            icon="plus"
            active={current.resolution === "duplicate"}
            onPress={() => handleChoose("duplicate")}
          />
          <ChoiceButton
            c={c}
            label="跳过"
            icon="minus"
            active={current.resolution === "skip"}
            onPress={() => handleChoose("skip")}
          />
        </View>
      </ScrollView>

      {/* 底部操作栏 */}
      <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.lineSoft }]}>
        <View style={styles.footerNav}>
          <Pressable onPress={handleBulkRemote} hitSlop={8}>
            <Text style={[styles.bulkText, { color: c.info }]}>全部用对端</Text>
          </Pressable>
          <View style={styles.pager}>
            <IconButton
              icon="chevron.left"
              size={32}
              iconSize={16}
              variant="tinted"
              disabled={safeIndex === 0}
              onPress={() => setIndex((i) => Math.max(0, i - 1))}
            />
            <Text style={[styles.pagerText, { color: c.text3, fontFamily: MONO }]}>
              {safeIndex + 1}/{conflicts.length}
            </Text>
            <IconButton
              icon="chevron.right"
              size={32}
              iconSize={16}
              variant="tinted"
              disabled={safeIndex >= conflicts.length - 1}
              onPress={() =>
                setIndex((i) => Math.min(conflicts.length - 1, i + 1))
              }
            />
          </View>
        </View>
        <Pressable
          onPress={handleApply}
          disabled={!allResolved || applying}
          style={[
            styles.applyBtn,
            {
              backgroundColor: c.accent,
              opacity: !allResolved || applying ? 0.4 : 1,
            },
          ]}
        >
          <Text style={[styles.applyText, { color: c.accentInk }]}>
            {applying ? "应用中…" : "应用全部"}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/* ── 子组件 ──────────────────────────────────────────────────── */

function Nav({
  title,
  onBack,
  c,
}: {
  title: string;
  onBack: () => void;
  c: ReturnType<typeof useTheme>["colors"];
}) {
  return (
    <View style={styles.nav}>
      <IconButton
        icon="chevron.left"
        size={36}
        iconSize={20}
        variant="ghost"
        onPress={onBack}
      />
      <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
        {title}
      </Text>
      <View style={{ width: 36 }} />
    </View>
  );
}

function SideCard({
  c,
  label,
  payload,
  fields,
  otherFields,
  updatedAt,
  newer,
  suggested,
}: {
  c: ReturnType<typeof useTheme>["colors"];
  label: string;
  payload: ItemPayload | null;
  fields: Map<string, string>;
  otherFields: Map<string, string>;
  updatedAt?: number;
  newer?: boolean;
  suggested?: boolean;
}) {
  return (
    <View style={[styles.sideCard, { backgroundColor: c.bgElev }]}>
      <View style={styles.sideHeader}>
        <Text style={[styles.sideLabel, { color: c.text2 }]}>{label}</Text>
        <View style={styles.sideBadges}>
          {suggested ? <Badge label="建议" tone="info" /> : null}
          {newer ? <Badge label="较新" tone="ok" icon="arrow.up.right" /> : null}
        </View>
      </View>
      <Text style={[styles.sideTime, { color: c.text3, fontFamily: MONO }]}>
        更新于 {fmtTime(updatedAt)}
      </Text>

      {!payload ? (
        <Text style={[styles.deleted, { color: c.danger }]}>（已删除）</Text>
      ) : fields.size === 0 ? (
        <Text style={[styles.deleted, { color: c.text3 }]}>（无可显示字段）</Text>
      ) : (
        <View style={{ gap: Spacing.sm, marginTop: Spacing.xs }}>
          {Array.from(fields.entries()).map(([k, v]) => {
            const differs = otherFields.get(k) !== v;
            return (
              <View key={k} style={styles.fieldRow}>
                <Text
                  style={[
                    styles.fieldKey,
                    { color: differs ? c.warn : c.text3 },
                  ]}
                >
                  {fieldLabel(k)}
                  {differs ? " ·" : ""}
                </Text>
                <View style={{ flex: 1 }}>
                  <MaskedValue value={v} masked={isSensitive(k)} mono={isSensitive(k)} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function ChoiceButton({
  c,
  label,
  icon,
  active,
  onPress,
}: {
  c: ReturnType<typeof useTheme>["colors"];
  label: string;
  icon: "checkmark" | "plus" | "minus";
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.choiceBtn,
        {
          backgroundColor: active ? c.accent : c.bgElev,
        },
      ]}
    >
      {active ? (
        <IconSymbol name={icon} size={15} color={c.accentInk} />
      ) : null}
      <Text
        style={[
          styles.choiceText,
          { color: active ? c.accentInk : c.text },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
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

  content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },

  titleBlock: { gap: 2, marginBottom: Spacing.xs },
  itemName: { ...Type.title2 },
  kind: { ...Type.footnote },

  sideCard: { borderRadius: Radius.xl, padding: Spacing.lg, gap: 4 },
  sideHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sideLabel: { ...Type.headline },
  sideBadges: { flexDirection: "row", gap: Spacing.xs },
  sideTime: { ...Type.caption },
  deleted: { ...Type.body, marginTop: Spacing.xs, fontWeight: "600" },

  fieldRow: { flexDirection: "row", gap: Spacing.sm, alignItems: "flex-start" },
  fieldKey: {
    ...Type.footnote,
    width: 64,
    paddingTop: 3,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },

  choiceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  choiceBtn: {
    flexGrow: 1,
    flexBasis: "47%",
    height: 48,
    borderRadius: Radius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
  },
  choiceText: { ...Type.bodyEmph },

  footer: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
    gap: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bulkText: { ...Type.subhead, fontWeight: "600" },
  pager: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  pagerText: { ...Type.footnote },

  applyBtn: {
    height: 52,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  applyText: { ...Type.headline },

  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.md },
  emptyText: { ...Type.body },
});
