// 我的 —— 账户 / 偏好 / 数据 / 关于
//
// 与 desktop SettingsPage 对齐：所有偏好均在本地，云端模式占位。
// 主密码修改、清空保险库、明文导入导出都直接走加密 vault。

import React, { useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Platform,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme, type ThemeMode } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import type { VaultItem, VaultItemType } from "@/data/vault";
import { exportVault, pickAndParseImport } from "@/lib/transfer";
import { sortSpaces, type Space } from "@/lib/spaces";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SpaceAvatar } from "@/components/space-avatar";
import { actionSheet, dialog, toast } from "@/components/ui/dialog";

const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

interface MenuRowConfig {
  key: string;
  label: string;
  value?: string;
  badge?: { text: string; color: "danger" | "warn" | "ok" | "text3" };
  showChevron?: boolean;
  onPress?: () => void;
}

/* ----- 子组件 ----- */

function SectionLabel({ title, c }: { title: string; c: typeof Colors.dark }) {
  return (
    <Text style={[styles.sectionLabel, { color: c.text3, fontFamily: MONO }]}>
      {title}
    </Text>
  );
}

function MenuRow({
  config,
  isFirst,
  isLast,
  c,
}: {
  config: MenuRowConfig;
  isFirst: boolean;
  isLast: boolean;
  c: typeof Colors.dark;
}) {
  const handlePress = () => {
    if (config.onPress) config.onPress();
    else toast.info("功能开发中", config.label + " 暂未实现");
  };

  const badgeColor = config.badge
    ? config.badge.color === "danger"
      ? c.danger
      : config.badge.color === "warn"
        ? c.warn
        : config.badge.color === "ok"
          ? c.ok
          : c.text3
    : c.text3;

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.65}
        onPress={handlePress}
        style={[
          styles.menuRow,
          {
            borderTopLeftRadius: isFirst ? 10 : 0,
            borderTopRightRadius: isFirst ? 10 : 0,
            borderBottomLeftRadius: isLast ? 10 : 0,
            borderBottomRightRadius: isLast ? 10 : 0,
          },
        ]}
      >
        <Text style={[styles.menuRowLabel, { color: c.text }]}>{config.label}</Text>
        <View style={styles.menuRowRight}>
          {config.badge ? (
            <View
              style={[
                styles.badgeWrap,
                {
                  backgroundColor: badgeColor + "22",
                  borderColor: badgeColor + "66",
                },
              ]}
            >
              <Text
                style={[styles.badgeText, { color: badgeColor, fontFamily: MONO }]}
              >
                {config.badge.text}
              </Text>
            </View>
          ) : null}
          {config.value ? (
            <Text
              style={[styles.menuRowValue, { color: c.text3, fontFamily: MONO }]}
            >
              {config.value}
            </Text>
          ) : null}
          {config.showChevron ? (
            <Text style={[styles.chevron, { color: c.text3 }]}>{"›"}</Text>
          ) : null}
        </View>
      </TouchableOpacity>
      {!isLast && (
        <View style={[styles.separator, { backgroundColor: c.lineSoft }]} />
      )}
    </>
  );
}

function MenuSection({
  label,
  rows,
  c,
}: {
  label: string;
  rows: MenuRowConfig[];
  c: typeof Colors.dark;
}) {
  return (
    <View style={styles.menuSection}>
      <SectionLabel title={label} c={c} />
      <View
        style={[
          styles.menuCard,
          { backgroundColor: c.bgElev, borderColor: c.line },
        ]}
      >
        {rows.map((row, index) => (
          <MenuRow
            key={row.key}
            config={row}
            isFirst={index === 0}
            isLast={index === rows.length - 1}
            c={c}
          />
        ))}
      </View>
    </View>
  );
}

function UserCard({
  c,
  count,
  space,
  onPress,
}: {
  c: typeof Colors.dark;
  count: number;
  space: Space | null;
  onPress?: () => void;
}) {
  // 头像与标题都跟随当前空间；点击整个卡片打开空间管理面板。
  // 用 TouchableOpacity 包裹整张卡：用户感知"头像可以改" → 进入空间管理
  // 后通过长按行做重命名（保留原有交互入口，避免新增二级 modal）。
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[
        styles.userCard,
        { backgroundColor: c.bgElev, borderColor: c.line },
      ]}
    >
      <SpaceAvatar
        space={space}
        size={56}
        background={c.text}
        foreground={c.bg}
        fontSize={22}
        borderRadius={28}
      />
      <View style={styles.userInfo}>
        <Text style={[styles.userName, { color: c.text }]} numberOfLines={1}>
          {space?.name ?? "本地保险库"}
        </Text>
        <Text style={[styles.userPlan, { color: c.text3, fontFamily: MONO }]}>
          {count} 条加密条目 · 零知识
        </Text>
      </View>
      <Text style={[styles.chevron, { color: c.text3 }]}>{"›"}</Text>
    </TouchableOpacity>
  );
}

/* ----- 主屏 ----- */

export default function MeScreen() {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];

  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const {
    lock,
    items,
    importItems,
    clearAll,
    reset,
    changeMasterPassword,
    spaces,
    activeSpaceId,
    activeSpace,
    setActiveSpace,
    createSpace,
    renameSpace,
    deleteSpace,
  } = useVault();

  const [pwModal, setPwModal] = useState(false);
  const [spacesModal, setSpacesModal] = useState(false);

  const activeSpaceName = React.useMemo(() => {
    const sp = spaces.find((s) => s.id === activeSpaceId);
    return sp?.name ?? "—";
  }, [spaces, activeSpaceId]);

  /* ── 导出：明文备份 ── */
  const handleExport = React.useCallback(async () => {
    if (items.length === 0) {
      toast.warn("保险库为空", "暂无可导出的条目");
      return;
    }
    const ok = await dialog.confirm(
      "导出明文备份",
      `备份文件将包含全部 ${items.length} 个条目的明文内容（含密码、密钥、TOTP 等）。请妥善保管，切勿上传到不可信的位置。`,
      { okLabel: "继续导出", destructive: true },
    );
    if (!ok) return;
    try {
      const r = await exportVault(items);
      if (!r.shared) toast.ok("已生成备份", r.path);
    } catch (e) {
      toast.danger("导出失败", e instanceof Error ? e.message : String(e));
    }
  }, [items]);

  /* ── 导入：选择 JSON ── */
  const handleImport = React.useCallback(async () => {
    const res = await pickAndParseImport();
    if (!res.ok) {
      if (res.reason === "cancelled") return;
      await dialog.alert(
        "导入失败",
        res.reason === "empty"
          ? "文件中没有可识别的条目"
          : "无法解析文件，请选择有效的 ZPass 导出 JSON",
      );
      return;
    }
    const ok = await dialog.confirm(
      "确认导入",
      `已从「${res.fileName}」解析到 ${res.items.length} 个条目，全部追加到加密保险库？`,
      { okLabel: "导入" },
    );
    if (!ok) return;
    const n = await importItems(res.items as VaultItem[]);
    toast.ok("导入完成", `已导入 ${n} 个条目`);
  }, [importItems]);

  /* ── 清空 ── */
  const handleClearAll = React.useCallback(async () => {
    if (items.length === 0) {
      toast.info("保险库已为空");
      return;
    }
    const ok = await dialog.confirm(
      "清空保险库",
      `将永久删除全部 ${items.length} 个条目，主密码与加密元数据保留，此操作不可撤销。建议先导出备份。`,
      { okLabel: "清空", destructive: true },
    );
    if (ok) clearAll();
  }, [items.length, clearAll]);

  /* ── 完全重置 ── */
  const handleReset = React.useCallback(async () => {
    const ok = await dialog.confirm(
      "重置 ZPass",
      "将永久删除主密码与所有条目，应用回到初始状态。此操作不可撤销。",
      { okLabel: "重置", destructive: true },
    );
    if (ok) await reset();
  }, [reset]);

  /* ── 主题切换 ── */
  const themeValueLabel = React.useMemo(() => {
    if (themeMode === "system")
      return `跟随系统（${scheme === "dark" ? "深色" : "浅色"}）`;
    return themeMode === "dark" ? "深色" : "浅色";
  }, [themeMode, scheme]);

  const handleThemePress = React.useCallback(async () => {
    const options: { label: string; value: ThemeMode }[] = [
      { label: "跟随系统", value: "system" },
      { label: "深色", value: "dark" },
      { label: "浅色", value: "light" },
    ];
    const key = await actionSheet.show({
      title: "选择主题",
      message: "切换 ZPass 的外观主题",
      actions: options.map((opt) => ({
        key: opt.value,
        label: `${opt.label}${themeMode === opt.value ? " · 已选" : ""}`,
        variant: themeMode === opt.value ? "primary" : "default",
      })),
    });
    if (key) setThemeMode(key as ThemeMode);
  }, [themeMode, setThemeMode]);

  const typeCounts = React.useMemo(() => countByType(items), [items]);

  const spacesRows: MenuRowConfig[] = [
    {
      key: "current-space",
      label: "当前空间",
      value: activeSpaceName,
      showChevron: true,
      onPress: () => setSpacesModal(true),
    },
  ];

  const securityRows: MenuRowConfig[] = [
    {
      key: "change-pwd",
      label: "修改主密码",
      showChevron: true,
      onPress: () => setPwModal(true),
    },
    {
      key: "lock-now",
      label: "立即锁定",
      showChevron: true,
      onPress: async () => {
        const ok = await dialog.confirm("锁定 ZPass", "确认要锁定保险库吗？", {
          okLabel: "锁定",
          destructive: true,
        });
        if (ok) lock();
      },
    },
  ];

  const appearanceRows: MenuRowConfig[] = [
    {
      key: "theme",
      label: "主题",
      value: themeValueLabel,
      showChevron: true,
      onPress: handleThemePress,
    },
    { key: "language", label: "语言", value: "中文" },
  ];

  const dataRows: MenuRowConfig[] = [
    {
      key: "import",
      label: "导入数据",
      value: "ZPass JSON",
      showChevron: true,
      onPress: handleImport,
    },
    {
      key: "export",
      label: "导出明文备份",
      value: `${items.length} 项`,
      showChevron: true,
      onPress: handleExport,
    },
    {
      key: "clear",
      label: "清空所有条目",
      showChevron: true,
      onPress: handleClearAll,
    },
    {
      key: "reset",
      label: "重置 ZPass",
      showChevron: true,
      onPress: handleReset,
    },
  ];

  const statsRows: MenuRowConfig[] = (
    [
      ["登录凭据", "login"],
      ["验证码", "totp"],
      ["支付卡", "card"],
      ["安全笔记", "note"],
      ["身份信息", "identity"],
      ["SSH 密钥", "ssh"],
      ["通行密钥", "passkey"],
    ] as [string, VaultItemType][]
  ).map(([label, t]) => ({
    key: `stat-${t}`,
    label,
    value: `${typeCounts[t] ?? 0} 项`,
  }));

  const aboutRows: MenuRowConfig[] = [
    {
      key: "about",
      label: "关于 ZPass",
      value: "零知识本地密码管理器",
    },
    { key: "version", label: "版本", value: "1.0.0" },
  ];

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: c.bg }]}
      edges={["top", "bottom"]}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageHeader}>
          <Text style={[styles.pageTitle, { color: c.text }]}>我的</Text>
        </View>

        <UserCard
          c={c}
          count={items.length}
          space={activeSpace}
          onPress={() => setSpacesModal(true)}
        />

        <MenuSection label="SPACES · 空间" rows={spacesRows} c={c} />
        <MenuSection label="STATS · 条目统计" rows={statsRows} c={c} />
        <MenuSection label="SECURITY · 安全与隐私" rows={securityRows} c={c} />
        <MenuSection label="APPEARANCE · 外观" rows={appearanceRows} c={c} />
        <MenuSection label="DATA · 数据" rows={dataRows} c={c} />
        <MenuSection label="ABOUT · 关于" rows={aboutRows} c={c} />

        <View style={{ height: 16 }} />
      </ScrollView>

      <ChangePasswordModal
        visible={pwModal}
        onClose={() => setPwModal(false)}
        onSubmit={changeMasterPassword}
      />

      <SpacesModal
        visible={spacesModal}
        onClose={() => setSpacesModal(false)}
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onSelect={async (id) => {
          await setActiveSpace(id);
          setSpacesModal(false);
        }}
        onCreate={createSpace}
        onRename={renameSpace}
        onDelete={deleteSpace}
        c={c}
      />
    </SafeAreaView>
  );
}

function countByType(items: VaultItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.type] = (out[i.type] ?? 0) + 1;
  return out;
}

/* ----- 修改主密码 modal ----- */

function ChangePasswordModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (
    oldPwd: string,
    newPwd: string,
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}) {
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];

  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOldPwd("");
    setNewPwd("");
    setConfirmPwd("");
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);
    if (newPwd.length < 8) {
      setError("新密码至少 8 位");
      return;
    }
    if (newPwd !== confirmPwd) {
      setError("两次输入不一致");
      return;
    }
    setBusy(true);
    const r = await onSubmit(oldPwd, newPwd);
    setBusy(false);
    if (r.ok) {
      reset();
      onClose();
      toast.ok("已更新", "主密码已修改");
    } else {
      setError(r.message);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={modalStyles.backdrop}
      >
        <View style={[modalStyles.card, { backgroundColor: c.bgElev, borderColor: c.line }]}>
          <Text style={[modalStyles.title, { color: c.text }]}>修改主密码</Text>

          <ModalField label="当前主密码" value={oldPwd} onChange={setOldPwd} c={c} />
          <ModalField label="新主密码（≥ 8 位）" value={newPwd} onChange={setNewPwd} c={c} />
          <ModalField label="确认新主密码" value={confirmPwd} onChange={setConfirmPwd} c={c} />

          {error ? (
            <Text style={[modalStyles.error, { color: c.danger }]}>{error}</Text>
          ) : null}

          <View style={modalStyles.actions}>
            <TouchableOpacity
              onPress={close}
              style={[modalStyles.btn, modalStyles.btnGhost, { borderColor: c.line }]}
              disabled={busy}
            >
              <Text style={[modalStyles.btnGhostText, { color: c.text2 }]}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              style={[modalStyles.btn, { backgroundColor: c.text }]}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={c.bg} />
              ) : (
                <Text style={[modalStyles.btnText, { color: c.bg }]}>确认</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ModalField({
  label,
  value,
  onChange,
  c,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  c: typeof Colors.dark;
}) {
  return (
    <View style={modalStyles.field}>
      <Text style={[modalStyles.fieldLabel, { color: c.text3 }]}>{label}</Text>
      <TextInput
        style={[
          modalStyles.fieldInput,
          { color: c.text, backgroundColor: c.bg, borderColor: c.line },
        ]}
        value={value}
        onChangeText={onChange}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

/* ----- 空间 modal ----- */
//
// 视觉对齐用户给的截图：
//   标题 "空间"
//   每行 [编号 | 名称 | 选中态]
//   底部 "+ 新建空间"
// 长按行 → ActionSheet（重命名 / 删除）。

function SpacesModal({
  visible,
  onClose,
  spaces,
  activeSpaceId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  c,
}: {
  visible: boolean;
  onClose: () => void;
  spaces: Space[];
  activeSpaceId: string | null;
  onSelect: (id: string) => void | Promise<void>;
  onCreate: (name: string) => Promise<Space | null>;
  onRename: (
    id: string,
    name: string,
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  onDelete: (
    id: string,
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  c: typeof Colors.dark;
}) {
  const ordered = React.useMemo(() => sortSpaces(spaces), [spaces]);

  const handleCreate = async () => {
    const name = await dialog.prompt("新建空间", {
      placeholder: "空间名",
      maxLength: 32,
      okLabel: "新建",
    });
    if (!name) return;
    const sp = await onCreate(name);
    if (!sp) await dialog.alert("创建失败", "请稍后重试");
  };

  const handleRename = async (sp: Space) => {
    const name = await dialog.prompt("重命名空间", {
      placeholder: "新名称",
      initial: sp.name,
      maxLength: 32,
    });
    if (!name) return;
    const r = await onRename(sp.id, name);
    if (!r.ok) await dialog.alert("重命名失败", r.message);
  };

  const handleDelete = async (sp: Space) => {
    if (spaces.length <= 1) {
      await dialog.alert("无法删除", "至少需要保留一个空间");
      return;
    }
    const ok = await dialog.confirm(
      "删除空间",
      `确认删除「${sp.name}」？该空间下的所有条目会迁移到其它空间。`,
      { okLabel: "删除", destructive: true },
    );
    if (!ok) return;
    const r = await onDelete(sp.id);
    if (!r.ok) await dialog.alert("删除失败", r.message);
  };

  const handleRow = async (sp: Space) => {
    const key = await actionSheet.show({
      title: sp.name,
      actions: [
        { key: "select", label: "切换到此空间" },
        { key: "rename", label: "重命名" },
        { key: "delete", label: "删除", variant: "danger" },
      ],
    });
    if (key === "select") onSelect(sp.id);
    else if (key === "rename") handleRename(sp);
    else if (key === "delete") handleDelete(sp);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        style={spacesModalStyles.backdrop}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={[
            spacesModalStyles.card,
            { backgroundColor: c.bgElev, borderColor: c.line },
          ]}
        >
          <Text
            style={[
              spacesModalStyles.title,
              { color: c.text3, fontFamily: MONO },
            ]}
          >
            空间
          </Text>

          {ordered.length === 0 ? (
            <Text
              style={[
                spacesModalStyles.empty,
                { color: c.text3 },
              ]}
            >
              没有空间
            </Text>
          ) : (
            ordered.map((sp, idx) => {
              const active = sp.id === activeSpaceId;
              return (
                <TouchableOpacity
                  key={sp.id}
                  activeOpacity={0.7}
                  onPress={() => onSelect(sp.id)}
                  onLongPress={() => handleRow(sp)}
                  style={[
                    spacesModalStyles.row,
                    {
                      backgroundColor: active ? c.bgHover : "transparent",
                      borderColor: c.line,
                      borderTopWidth: idx === 0 ? StyleSheet.hairlineWidth : 0,
                    },
                  ]}
                >
                  <View
                    style={[
                      spacesModalStyles.numChip,
                      {
                        backgroundColor: active ? c.text : c.bg,
                        borderColor: active ? c.text : c.line,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        spacesModalStyles.numText,
                        {
                          color: active ? c.bg : c.text2,
                          fontFamily: MONO,
                        },
                      ]}
                    >
                      {sp.order}
                    </Text>
                  </View>
                  <Text
                    style={[spacesModalStyles.rowName, { color: c.text }]}
                    numberOfLines={1}
                  >
                    {sp.name}
                  </Text>
                  {active ? (
                    <IconSymbol name="checkmark" size={16} color={c.text2} />
                  ) : null}
                </TouchableOpacity>
              );
            })
          )}

          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleCreate}
            style={[
              spacesModalStyles.addRow,
              { borderTopColor: c.line },
            ]}
          >
            <Text style={[spacesModalStyles.addText, { color: c.text2 }]}>
              + 新建空间
            </Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const spacesModalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  card: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
  },
  title: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  empty: {
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 16,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  numChip: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  numText: { fontSize: 11, fontWeight: "700" },
  rowName: { flex: 1, fontSize: 14, fontWeight: "500" },
  addRow: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  addText: { fontSize: 14, fontWeight: "500" },
});

/* ----- styles ----- */

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 16 },

  pageHeader: { paddingTop: 16, paddingBottom: 16 },
  pageTitle: { fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },

  userCard: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 14,
    padding: 20,
    gap: 14,
    marginBottom: 16,
  },
  userInfo: { flex: 1, gap: 3 },
  userName: { fontSize: 15, fontWeight: "600" },
  userPlan: { fontSize: 11 },

  menuSection: { marginBottom: 16 },
  sectionLabel: {
    fontSize: 9,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 2,
  },
  menuCard: { borderWidth: 1, borderRadius: 10, overflow: "hidden" },

  menuRow: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 8,
  },
  menuRowLabel: { flex: 1, fontSize: 15 },
  menuRowRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  menuRowValue: { fontSize: 13 },
  chevron: { fontSize: 20, lineHeight: 24, marginLeft: 2 },

  separator: { height: 1, marginLeft: 16 },

  badgeWrap: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    minWidth: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.2 },
});

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 18,
  },
  title: { fontSize: 17, fontWeight: "700", marginBottom: 14 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 11, fontWeight: "600", marginBottom: 5 },
  fieldInput: {
    height: 42,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  error: { fontSize: 12, marginTop: 4, marginBottom: 4 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 6 },
  btn: {
    minWidth: 80,
    height: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  btnText: { fontSize: 14, fontWeight: "700" },
  btnGhost: { borderWidth: 1, backgroundColor: "transparent" },
  btnGhostText: { fontSize: 14, fontWeight: "500" },
});
