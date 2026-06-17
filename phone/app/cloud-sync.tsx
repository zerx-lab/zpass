// 保险库同步 —— 多空间云同步设置页（对齐 harmony pages/CloudSync.ets）
//
// 登录后：状态卡（上次同步 / 套餐用量 / 云端概览 / 立即同步）+ 空间列表（逐空间
// 上传 / 绑定 / 解绑 / 激活 / 重新上云）+ 冲突逐条决策（采用本端 / 采用对端）。
// 「绑定已有」走底部 sheet 选择云保险库。所有动作 try/catch → toast，并以
// busyId 单飞禁用按钮。命令式状态全部来自 cloud-context（useCloud），本页不持有业务逻辑。

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useCloud } from "@/contexts/cloud-context";
import { dialog, toast } from "@/components/ui/dialog";
import { Badge, Button, Surface } from "@/components/ui/primitives";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SettingsPage } from "@/components/settings/settings-page";
import { SheetModal } from "@/components/settings/sheet-modal";
import type { Entitlements } from "@/lib/cloud-client";
import type { RemoteVaultInfo, SpaceCloudStatus } from "@/lib/cloud-service";

type BadgeTone = "info" | "warn" | "danger" | "ok" | "neutral";

/** 状态卡上次同步文案（对齐 harmony formatTime）。 */
function formatLastSync(ms: number): string {
  if (ms <= 0) return "尚未同步";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `上次同步 ${hh}:${mm}`;
}

/** 云保险库用量文案（找 vault 数量维度）；无则返回 ''（对齐 harmony vaultUsage）。 */
function vaultUsage(ent: Entitlements | null): string {
  if (!ent) return "";
  for (const d of ent.dimensions) {
    if (d.dimension === "max_vaults" || d.dimension.includes("vault")) {
      const limit = d.limit === null ? "不限" : String(d.limit);
      return `云保险库 ${d.current}/${limit}`;
    }
  }
  return "";
}

/** 空间云状态 → 展示文案 + 徽标色调（对齐 harmony statusText/statusColor）。 */
function spaceStatus(s: SpaceCloudStatus): { text: string; tone: BadgeTone } {
  if (s.bound) {
    return s.frozen
      ? { text: "已冻结（套餐降级）", tone: "warn" }
      : { text: "已同步", tone: "ok" };
  }
  if (s.overQuota) return { text: "超出套餐", tone: "warn" };
  if (s.detached) return { text: "已解绑（仅本地）", tone: "neutral" };
  return { text: "仅本地", tone: "neutral" };
}

export default function CloudSyncScreen() {
  const { colors: c } = useTheme();
  const router = useRouter();
  const {
    signedIn,
    anyBound,
    syncing,
    lastSyncAt,
    lastError,
    plan,
    email,
    spaceStates,
    conflicts,
    syncNow,
    createCloudVault,
    reuploadSpace,
    unlinkSpace,
    activateRemoteVault,
    bindCloudVault,
    listRemoteVaults,
    entitlements,
    resolveConflict,
  } = useCloud();

  /** 正在操作的空间 / 冲突 id；'' = 空闲，'__sync__' = 立即同步。 */
  const [busyId, setBusyId] = useState("");
  const [ent, setEnt] = useState<Entitlements | null>(null);
  /** 云端 vault 概览：总数 / 未在本地数。-1 = 未拉取。 */
  const [remoteTotal, setRemoteTotal] = useState(-1);
  const [remoteUnbound, setRemoteUnbound] = useState(-1);

  /** 「绑定已有」选择 sheet。 */
  const [pickerVisible, setPickerVisible] = useState(false);
  const [bindTargetSpaceId, setBindTargetSpaceId] = useState("");
  const [bindTargetSpaceName, setBindTargetSpaceName] = useState("");
  const [bindCandidates, setBindCandidates] = useState<RemoteVaultInfo[]>([]);
  const [bindLoading, setBindLoading] = useState(false);

  const loadEntitlements = useCallback(async () => {
    try {
      setEnt(await entitlements());
    } catch {
      // 离线 / 失败 → 不展示用量，不打扰
    }
  }, [entitlements]);

  const loadRemoteSummary = useCallback(async () => {
    try {
      const all = await listRemoteVaults();
      let unbound = 0;
      for (const v of all) {
        if (v.boundSpaceId.length === 0) unbound++;
      }
      setRemoteTotal(all.length);
      setRemoteUnbound(unbound);
    } catch {
      // 离线 / 失败 → 不展示概览
    }
  }, [listRemoteVaults]);

  useEffect(() => {
    if (!signedIn) return;
    void loadEntitlements();
    void loadRemoteSummary();
  }, [signedIn, loadEntitlements, loadRemoteSummary]);

  /** 单飞执行：禁用其它按钮 → 跑动作 → 成功 toast / 失败 toast.danger。 */
  const runAction = async (
    id: string,
    fn: () => Promise<void>,
    okMsg?: string,
  ): Promise<void> => {
    setBusyId(id);
    try {
      await fn();
      if (okMsg) toast.ok(okMsg);
    } catch (e) {
      toast.danger((e as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const onSyncNow = () =>
    void runAction("__sync__", async () => {
      await syncNow();
      await loadEntitlements();
      await loadRemoteSummary();
    });

  const onCreate = (s: SpaceCloudStatus) =>
    void runAction(
      s.spaceId,
      async () => {
        await createCloudVault(s.spaceId, s.spaceName);
        await loadEntitlements();
        await loadRemoteSummary();
      },
      `「${s.spaceName}」已上云并同步`,
    );

  const onReupload = (s: SpaceCloudStatus) =>
    void runAction(
      s.spaceId,
      async () => {
        await reuploadSpace(s.spaceId);
        await loadEntitlements();
        await loadRemoteSummary();
      },
      `「${s.spaceName}」已重新上云`,
    );

  const onActivate = (s: SpaceCloudStatus) =>
    void runAction(
      s.spaceId,
      async () => {
        await activateRemoteVault(s.vaultId);
        await loadEntitlements();
      },
      `「${s.spaceName}」已激活`,
    );

  const onUnlink = async (s: SpaceCloudStatus) => {
    const ok = await dialog.confirm(
      "解绑云保险库",
      `确认解绑空间「${s.spaceName}」？本地数据保留，仅停止该空间的云同步，且不再自动镜像。`,
      { okLabel: "解绑", cancelLabel: "取消", destructive: true },
    );
    if (!ok) return;
    void runAction(s.spaceId, () => unlinkSpace(s.spaceId), `已解绑「${s.spaceName}」`);
  };

  const onBindExisting = async (s: SpaceCloudStatus) => {
    setBindTargetSpaceId(s.spaceId);
    setBindTargetSpaceName(s.spaceName);
    setBindCandidates([]);
    setPickerVisible(true);
    setBindLoading(true);
    try {
      setBindCandidates(await listRemoteVaults());
    } catch (e) {
      toast.danger((e as Error).message);
      setPickerVisible(false);
    } finally {
      setBindLoading(false);
    }
  };

  const onPickBind = (vaultId: string) => {
    const spaceId = bindTargetSpaceId;
    const name = bindTargetSpaceName;
    setPickerVisible(false);
    void runAction(
      spaceId,
      async () => {
        await bindCloudVault(spaceId, vaultId);
        await loadEntitlements();
        await loadRemoteSummary();
      },
      `已绑定到「${name}」`,
    );
  };

  const onResolve = (localId: string, choice: "local" | "remote") =>
    void runAction(localId, () => resolveConflict(localId, choice));

  const busy = busyId.length > 0;
  const usage = vaultUsage(ent);
  const planBase = plan.length > 0 ? `套餐：${plan}` : email;
  const planLine = usage.length > 0 ? `${planBase} · ${usage}` : planBase;

  return (
    <SettingsPage title="保险库同步">
      {!signedIn ? (
        <Surface level="elev" radius="xl" padding="lg" style={styles.card}>
          <Text style={[styles.promptTitle, { color: c.text }]}>尚未登录云账户</Text>
          <Text style={[styles.promptBody, { color: c.text3 }]}>
            前往「云账户」登录后即可自动镜像各空间到云端并同步。
          </Text>
          <Button
            label="前往云账户"
            fullWidth
            onPress={() => router.push("/cloud-account" as never)}
            style={styles.promptBtn}
          />
        </Surface>
      ) : (
        <>
          {/* ── 状态卡 ── */}
          <Surface level="elev" radius="xl" padding="lg" style={styles.card}>
            <View style={styles.statusHead}>
              <View style={[styles.iconBox, { backgroundColor: c.info + "1f" }]}>
                {syncing ? (
                  <ActivityIndicator size="small" color={c.info} />
                ) : (
                  <IconSymbol name="arrow.clockwise" size={20} color={c.text2} />
                )}
              </View>
              <View style={styles.statusText}>
                <Text style={[styles.statusTitle, { color: c.text }]} numberOfLines={1}>
                  {syncing ? "同步中…" : formatLastSync(lastSyncAt)}
                </Text>
                <Text style={[styles.statusSub, { color: c.text3 }]} numberOfLines={1}>
                  {planLine}
                </Text>
              </View>
            </View>

            {lastError.length > 0 ? (
              <View style={styles.noticeRow}>
                <IconSymbol name="exclamationmark.circle.fill" size={14} color={c.danger} />
                <Text style={[styles.noticeText, { color: c.danger }]}>{lastError}</Text>
              </View>
            ) : null}

            {remoteTotal > 0 ? (
              <Text style={[styles.remoteLine, { color: c.text3 }]}>
                {remoteUnbound > 0
                  ? `云端 ${remoteTotal} 个保险库 · ${remoteUnbound} 个未在本地`
                  : `云端 ${remoteTotal} 个保险库 · 均已同步`}
              </Text>
            ) : null}

            <Button
              label={syncing ? "同步中…" : "立即同步"}
              fullWidth
              disabled={syncing || !anyBound || busy}
              onPress={onSyncNow}
              style={styles.syncBtn}
            />
          </Surface>

          {/* ── 空间列表 ── */}
          <Text style={[styles.sectionHeader, { color: c.text3 }]}>空间</Text>
          {spaceStates.map((s) => {
            const status = spaceStatus(s);
            const dotColor =
              status.tone === "ok" ? c.ok : status.tone === "warn" ? c.warn : c.text3;
            const rowBusy = busyId === s.spaceId;
            return (
              <Surface
                key={`${s.spaceId}|${s.bound}|${s.frozen}|${s.detached}|${s.overQuota}|${s.vaultId}`}
                level="elev"
                radius="lg"
                padding="md"
                style={styles.card}
              >
                <View style={styles.spaceHead}>
                  <View style={[styles.dot, { backgroundColor: dotColor }]} />
                  <View style={styles.spaceText}>
                    <Text style={[styles.spaceName, { color: c.text }]} numberOfLines={1}>
                      {s.spaceName}
                    </Text>
                    <Badge label={status.text} tone={status.tone} style={styles.statusBadge} />
                  </View>
                </View>

                {s.overQuota ? (
                  <Text style={[styles.quotaNote, { color: c.warn }]}>
                    已超出当前套餐的云保险库数量，可升级套餐后再上传，或手动上传到云端。
                  </Text>
                ) : null}

                <View style={styles.actionRow}>
                  {rowBusy ? (
                    <Button label="处理中…" size="sm" fullWidth disabled style={styles.flexBtn} />
                  ) : s.bound ? (
                    s.frozen ? (
                      <>
                        <Button
                          label="激活"
                          size="sm"
                          disabled={busy}
                          onPress={() => onActivate(s)}
                          style={styles.flexBtn}
                        />
                        <Button
                          label="解绑"
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onPress={() => onUnlink(s)}
                          style={styles.flexBtn}
                        />
                      </>
                    ) : (
                      <Button
                        label="解绑"
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onPress={() => onUnlink(s)}
                        style={styles.flexBtn}
                      />
                    )
                  ) : (
                    <>
                      <Button
                        label={s.detached ? "重新上云" : "上传到云端"}
                        size="sm"
                        disabled={busy}
                        onPress={() => (s.detached ? onReupload(s) : onCreate(s))}
                        style={styles.flexBtn}
                      />
                      <Button
                        label="绑定已有"
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onPress={() => onBindExisting(s)}
                        style={styles.flexBtn}
                      />
                    </>
                  )}
                </View>
              </Surface>
            );
          })}

          {/* ── 同步冲突 ── */}
          {conflicts.length > 0 ? (
            <>
              <Text style={[styles.sectionHeader, { color: c.warn }]}>
                {`同步冲突 · ${conflicts.length}`}
              </Text>
              {conflicts.map((cf) => {
                const name =
                  cf.localName.length > 0
                    ? cf.localName
                    : cf.remoteName.length > 0
                      ? cf.remoteName
                      : cf.localId;
                const kindText =
                  cf.kind === "delete_vs_edit" ? "删除与编辑冲突" : "两端同时修改";
                return (
                  <Surface
                    key={cf.localId}
                    level="elev"
                    radius="lg"
                    padding="md"
                    style={styles.card}
                  >
                    <Text style={[styles.spaceName, { color: c.text }]} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text style={[styles.conflictKind, { color: c.text3 }]}>{kindText}</Text>
                    <Text style={[styles.conflictHint, { color: c.text3 }]}>
                      {`建议：采用${cf.suggestedRemote ? "对端" : "本端"}`}
                    </Text>
                    <View style={styles.actionRow}>
                      <Button
                        label="采用本端"
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onPress={() => onResolve(cf.localId, "local")}
                        style={styles.flexBtn}
                      />
                      <Button
                        label="采用对端"
                        size="sm"
                        disabled={busy}
                        onPress={() => onResolve(cf.localId, "remote")}
                        style={styles.flexBtn}
                      />
                    </View>
                  </Surface>
                );
              })}
            </>
          ) : null}
        </>
      )}

      {/* ── 「绑定已有」选择 sheet ── */}
      <SheetModal
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        title={`绑定到「${bindTargetSpaceName}」`}
        subtitle="选择一个云保险库绑定到该空间"
      >
        {bindLoading ? (
          <View style={styles.pickerLoading}>
            <ActivityIndicator color={c.accent} />
          </View>
        ) : bindCandidates.length === 0 ? (
          <Text style={[styles.pickerEmpty, { color: c.text3 }]}>没有可绑定的云保险库</Text>
        ) : (
          bindCandidates.map((v) => {
            const boundElsewhere =
              v.boundSpaceId.length > 0 && v.boundSpaceId !== bindTargetSpaceId;
            const nm = v.name.length > 0 ? v.name : "（未命名）";
            const label = `${nm} · ${v.itemCount} 条${v.frozen ? " · 已冻结" : ""}`;
            return (
              <Pressable
                key={v.vaultId}
                disabled={boundElsewhere}
                onPress={() => onPickBind(v.vaultId)}
                style={[
                  styles.pickerRow,
                  { backgroundColor: c.bgElev, opacity: boundElsewhere ? 0.4 : 1 },
                ]}
              >
                <Text style={[styles.pickerLabel, { color: c.text }]} numberOfLines={1}>
                  {label}
                </Text>
                {boundElsewhere ? (
                  <Text style={[styles.pickerTag, { color: c.text3 }]}>已绑定</Text>
                ) : null}
              </Pressable>
            );
          })
        )}
        <Button
          label="取消"
          variant="ghost"
          fullWidth
          onPress={() => setPickerVisible(false)}
          style={styles.cancelBtn}
        />
      </SheetModal>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: Spacing.md },
  statusHead: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  statusText: { flex: 1, minWidth: 0 },
  statusTitle: { ...Type.bodyEmph },
  statusSub: { ...Type.caption, marginTop: 2 },
  noticeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    marginTop: Spacing.sm,
  },
  noticeText: { ...Type.footnote, flex: 1 },
  remoteLine: { ...Type.caption, marginTop: Spacing.sm },
  syncBtn: { marginTop: Spacing.md },
  promptTitle: { ...Type.body },
  promptBody: { ...Type.footnote, marginTop: Spacing.xs, lineHeight: 18 },
  promptBtn: { marginTop: Spacing.md },
  sectionHeader: {
    ...Type.footnote,
    fontWeight: "600",
    marginTop: Spacing.lg,
    marginBottom: Spacing.xs,
  },
  spaceHead: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  spaceText: { flex: 1, minWidth: 0 },
  spaceName: { ...Type.bodyEmph },
  statusBadge: { alignSelf: "flex-start", marginTop: 4 },
  quotaNote: { ...Type.footnote, marginTop: Spacing.sm },
  actionRow: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.md },
  flexBtn: { flex: 1 },
  conflictKind: { ...Type.caption, marginTop: 4 },
  conflictHint: { ...Type.caption, marginTop: 2 },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: Spacing.md,
    borderRadius: Radius.md,
    marginTop: Spacing.sm,
  },
  pickerLabel: { ...Type.subhead, flex: 1 },
  pickerTag: { ...Type.caption, marginLeft: Spacing.sm },
  pickerEmpty: { ...Type.footnote, textAlign: "center", paddingVertical: Spacing.lg },
  pickerLoading: { paddingVertical: Spacing.lg, alignItems: "center" },
  cancelBtn: { marginTop: Spacing.sm },
});
