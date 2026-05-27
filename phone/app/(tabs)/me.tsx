// 我的 —— iOS HIG insetGrouped 风格重构
//
// 模块：用户卡片 + 空间 + 统计 + 安全 + 外观 + 数据 + 关于
// 弹窗：修改主密码 / 启用信任设备 / 空间管理（全部走 primitives + Sheet 样式）

import Constants from "expo-constants";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Platform,
  Modal,
  TextInput,
  Keyboard,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme, type ThemeMode } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import type { VaultItem, VaultItemType } from "@/data/vault";
import { exportVault, pickAndParseImport } from "@/lib/transfer";
import type { ItemPayload } from "@/lib/vault-service";
import { sortSpaces, type Space } from "@/lib/spaces";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SpaceAvatar } from "@/components/space-avatar";
import { actionSheet, dialog, toast } from "@/components/ui/dialog";
import {
  Badge,
  Button,
  IconButton,
  ListGroup,
  ListRow,
  PressableScale,
} from "@/components/ui/primitives";
import type { ColorPalette } from "@/constants/theme";

const MONO = Fonts?.mono ?? "monospace";

const APP_VERSION = __DEV__
  ? "dev"
  : (Constants.expoConfig?.version ?? "0.0.0");

type IconName = Parameters<typeof IconSymbol>[0]["name"];

/* ----- 用户卡片 ----- */

function UserCard({
  count,
  space,
  onPress,
}: {
  count: number;
  space: Space | null;
  onPress?: () => void;
}) {
  const { colors: c } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      scale={0.985}
      haptic="selection"
      pressedBg={c.bgHover}
      style={[styles.userCard, { backgroundColor: c.bgElev }]}
    >
      <SpaceAvatar
        space={space}
        size={56}
        background={c.accent}
        foreground={c.accentInk}
        fontSize={22}
        borderRadius={Radius.full}
      />
      <View style={styles.userInfo}>
        <Text style={[styles.userName, { color: c.text }]} numberOfLines={1}>
          {space?.name ?? "本地保险库"}
        </Text>
        <Text style={[styles.userMeta, { color: c.text3 }]}>
          {count} 条加密条目 · 零知识
        </Text>
      </View>
      <IconSymbol name="chevron.right" size={18} color={c.text4} />
    </PressableScale>
  );
}

/* ----- 主屏 ----- */

export default function MeScreen() {
  const { colors: c, mode: themeMode, setMode: setThemeMode, scheme } = useTheme();
  const router = useRouter();

  const {
    lock,
    items,
    importItems,
    listPayloads,
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
    trustedDeviceSupported,
    trustedDeviceEnabled,
    enableTrustedDevice,
    disableTrustedDevice,
  } = useVault();

  const [pwModal, setPwModal] = useState(false);
  const [spacesModal, setSpacesModal] = useState(false);
  const [trustedModal, setTrustedModal] = useState(false);

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
      // 拉原始 ItemPayload[]：envelope 与 desktop exportservice.go 1:1，
      // 不能用 useVault().items（那是平铺的展示态 VaultItem）。
      const payloads: ItemPayload[] = await listPayloads();
      const r = await exportVault(payloads);
      if (!r.shared) toast.ok("已生成备份", r.path);
    } catch (e) {
      toast.danger("导出失败", e instanceof Error ? e.message : String(e));
    }
  }, [items.length, listPayloads]);

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
    const n = await importItems(res.items);
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
      return `跟随系统 · ${scheme === "dark" ? "深色" : "浅色"}`;
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
        label: `${opt.label}${themeMode === opt.value ? " · 当前" : ""}`,
        variant: themeMode === opt.value ? "primary" : "default",
      })),
    });
    if (key) setThemeMode(key as ThemeMode);
  }, [themeMode, setThemeMode]);

  const typeCounts = React.useMemo(() => countByType(items), [items]);

  /* ── 信任设备切换 ── */
  const handleToggleTrustedDevice = React.useCallback(async () => {
    if (!trustedDeviceSupported) {
      toast.info("当前平台不支持设备解锁", "需在 iOS / Android 真机上启用生物识别");
      return;
    }
    if (trustedDeviceEnabled) {
      const ok = await dialog.confirm(
        "关闭设备解锁",
        "下次启动 ZPass 需要重新输入主密码。",
        { okLabel: "关闭", destructive: true },
      );
      if (!ok) return;
      const r = await disableTrustedDevice();
      if (!r.ok) {
        await dialog.alert("关闭失败", r.message);
        return;
      }
      toast.ok("已关闭设备解锁");
      return;
    }
    setTrustedModal(true);
  }, [trustedDeviceSupported, trustedDeviceEnabled, disableTrustedDevice]);

  const trustedValueLabel = !trustedDeviceSupported
    ? "不支持"
    : trustedDeviceEnabled
      ? "已启用"
      : "未启用";

  const itemTypeRows: { label: string; type: VaultItemType; icon: IconName }[] = [
    { label: "登录凭据", type: "login", icon: "key.fill" },
    { label: "验证码", type: "totp", icon: "clock.fill" },
    { label: "支付卡", type: "card", icon: "creditcard.fill" },
    { label: "安全笔记", type: "note", icon: "note.text" },
    { label: "身份信息", type: "identity", icon: "person.crop.circle.fill" },
    { label: "SSH 密钥", type: "ssh", icon: "terminal.fill" },
    { label: "通行密钥", type: "passkey", icon: "key.horizontal.fill" },
  ];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["top"]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageHeader}>
          <Text style={[styles.pageTitle, { color: c.text }]}>我的</Text>
        </View>

        <View style={{ marginHorizontal: Spacing.lg, marginBottom: Spacing.lg }}>
          <UserCard
            count={items.length}
            space={activeSpace}
            onPress={() => setSpacesModal(true)}
          />
        </View>

        <ListGroup header="空间">
          <ListRow
            title="当前空间"
            value={activeSpaceName}
            icon="square.grid.2x2.fill"
            onPress={() => setSpacesModal(true)}
          />
        </ListGroup>

        <ListGroup header="安全与隐私">
          <ListRow
            title="修改主密码"
            icon="lock.fill"
            onPress={() => setPwModal(true)}
          />
          <ListRow
            title="此设备自动解锁"
            value={trustedValueLabel}
            icon="faceid"
            onPress={handleToggleTrustedDevice}
            disabled={!trustedDeviceSupported}
          />
          <ListRow
            title="局域网同步"
            value="连接桌面端"
            icon="antenna.radiowaves.left.and.right"
            onPress={() => router.push("/sync" as never)}
          />
          <ListRow
            title="立即锁定"
            icon="lock.shield.fill"
            iconBg={c.danger + "1f"}
            iconColor={c.danger}
            tone="danger"
            onPress={async () => {
              const ok = await dialog.confirm(
                "锁定 ZPass",
                "确认要锁定保险库吗？",
                { okLabel: "锁定", destructive: true },
              );
              if (ok) lock();
            }}
          />
        </ListGroup>

        <ListGroup header="外观">
          <ListRow
            title="主题"
            value={themeValueLabel}
            icon={scheme === "dark" ? "moon.fill" : "sun.max.fill"}
            onPress={handleThemePress}
          />
          <ListRow title="语言" value="中文" icon="globe" />
        </ListGroup>

        <ListGroup header="数据">
          <ListRow
            title="导入数据"
            value="ZPass JSON"
            icon="arrow.down.doc.fill"
            onPress={handleImport}
          />
          <ListRow
            title="导出明文备份"
            value={`${items.length} 项`}
            icon="arrow.up.doc.fill"
            onPress={handleExport}
          />
          <ListRow
            title="清空所有条目"
            icon="trash"
            iconBg={c.warn + "1f"}
            iconColor={c.warn}
            tone="danger"
            onPress={handleClearAll}
          />
          <ListRow
            title="重置 ZPass"
            icon="trash.fill"
            iconBg={c.danger + "1f"}
            iconColor={c.danger}
            tone="danger"
            onPress={handleReset}
          />
        </ListGroup>

        <ListGroup header="条目统计">
          {itemTypeRows.map(({ label, type, icon }) => (
            <ListRow
              key={type}
              title={label}
              value={`${typeCounts[type] ?? 0} 项`}
              icon={icon}
              accessory="none"
            />
          ))}
        </ListGroup>

        <ListGroup header="关于" footer="零知识本地密码管理器 · 数据永远只在你的设备上加密存储">
          <ListRow title="版本" value={APP_VERSION} icon="info.circle" />
        </ListGroup>

        <View style={{ height: Spacing.xl }} />
      </ScrollView>

      <ChangePasswordModal
        visible={pwModal}
        onClose={() => setPwModal(false)}
        onSubmit={changeMasterPassword}
      />

      <TrustedDeviceEnableModal
        visible={trustedModal}
        onClose={() => setTrustedModal(false)}
        onSubmit={enableTrustedDevice}
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
  const { colors: c } = useTheme();

  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setOldPwd("");
    setNewPwd("");
    setConfirmPwd("");
    setError(null);
  };
  const close = () => {
    if (busy) return;
    resetForm();
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
      resetForm();
      onClose();
      toast.ok("已更新", "主密码已修改");
    } else {
      setError(r.message);
    }
  };

  return (
    <SheetModal
      visible={visible}
      onClose={close}
      title="修改主密码"
      subtitle="主密码用于解锁与加密保险库，请妥善保管"
    >
      <ModalField label="当前主密码" value={oldPwd} onChange={setOldPwd} c={c} />
      <ModalField
        label="新主密码"
        hint="至少 8 位，建议混合大小写 + 数字 + 符号"
        value={newPwd}
        onChange={setNewPwd}
        c={c}
      />
      <ModalField
        label="确认新主密码"
        value={confirmPwd}
        onChange={setConfirmPwd}
        c={c}
      />

      {error ? (
        <View style={[modalStyles.errorBox, { backgroundColor: c.danger + "1f" }]}>
          <IconSymbol
            name="exclamationmark.circle.fill"
            size={14}
            color={c.danger}
          />
          <Text style={[modalStyles.errorText, { color: c.danger }]}>
            {error}
          </Text>
        </View>
      ) : null}

      <View style={modalStyles.actions}>
        <Button
          label="取消"
          variant="ghost"
          onPress={close}
          disabled={busy}
          style={{ flex: 1 }}
          fullWidth
        />
        <Button
          label={busy ? "处理中" : "确认修改"}
          variant="primary"
          onPress={handleSubmit}
          disabled={busy}
          style={{ flex: 1 }}
          fullWidth
        />
      </View>
    </SheetModal>
  );
}

/* ----- 启用信任设备 modal ----- */

function TrustedDeviceEnableModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (
    confirmPassword: string,
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}) {
  const { colors: c } = useTheme();

  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setPwd("");
    setError(null);
  };
  const close = () => {
    if (busy) return;
    resetForm();
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);
    if (!pwd) {
      setError("请输入主密码");
      return;
    }
    setBusy(true);
    const r = await onSubmit(pwd);
    setBusy(false);
    if (r.ok) {
      resetForm();
      onClose();
      toast.ok("已启用设备解锁", "下次启动可使用生物识别");
      return;
    }
    setError(
      r.code === "trusted-unsupported"
        ? "当前平台不支持设备解锁"
        : r.message || "请稍后重试",
    );
  };

  return (
    <SheetModal
      visible={visible}
      onClose={close}
      title="启用设备解锁"
      subtitle="启用后此设备可用生物识别 / 设备凭据解锁。请输入主密码以确认。"
    >
      <ModalField label="主密码" value={pwd} onChange={setPwd} c={c} />

      {error ? (
        <View style={[modalStyles.errorBox, { backgroundColor: c.danger + "1f" }]}>
          <IconSymbol
            name="exclamationmark.circle.fill"
            size={14}
            color={c.danger}
          />
          <Text style={[modalStyles.errorText, { color: c.danger }]}>
            {error}
          </Text>
        </View>
      ) : null}

      <View style={modalStyles.actions}>
        <Button
          label="取消"
          variant="ghost"
          onPress={close}
          disabled={busy}
          style={{ flex: 1 }}
          fullWidth
        />
        <Button
          label={busy ? "启用中" : "启用"}
          variant="primary"
          onPress={handleSubmit}
          disabled={busy}
          style={{ flex: 1 }}
          fullWidth
        />
      </View>
    </SheetModal>
  );
}

function ModalField({
  label,
  hint,
  value,
  onChange,
  c,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  c: ColorPalette;
}) {
  return (
    <View style={modalStyles.field}>
      <Text style={[modalStyles.fieldLabel, { color: c.text3 }]}>{label}</Text>
      <TextInput
        style={[
          modalStyles.fieldInput,
          { color: c.text, backgroundColor: c.bgElev },
        ]}
        value={value}
        onChangeText={onChange}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {hint ? (
        <Text style={[modalStyles.fieldHint, { color: c.text3 }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/* ----- SheetModal 容器 —— iOS HIG bottom sheet 风格 ----- */

function SheetModal({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const { colors: c } = useTheme();
  const [kbInset, setKbInset] = useState(0);

  useEffect(() => {
    if (!visible) {
      setKbInset(0);
      return;
    }
    const showEvt =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const s1 = Keyboard.addListener(showEvt, (e) => {
      setKbInset(e.endCoordinates.height);
    });
    const s2 = Keyboard.addListener(hideEvt, () => {
      setKbInset(0);
    });
    return () => {
      s1.remove();
      s2.remove();
    };
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[modalStyles.kavWrap, { paddingBottom: kbInset }]}>
        <Pressable
          onPress={onClose}
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: c.overlay },
          ]}
        />
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={[modalStyles.card, { backgroundColor: c.bgElev2 }]}
        >
          <View style={modalStyles.cardHandle}>
            <View
              style={[
                modalStyles.handleBar,
                { backgroundColor: c.line },
              ]}
            />
          </View>
          <Text style={[modalStyles.title, { color: c.text }]}>{title}</Text>
          {subtitle ? (
            <Text style={[modalStyles.subtitle, { color: c.text3 }]}>
              {subtitle}
            </Text>
          ) : null}
          <View style={{ height: Spacing.md }} />
          {children}
        </Pressable>
      </View>
    </Modal>
  );
}

/* ----- 空间 modal ----- */

function SpacesModal({
  visible,
  onClose,
  spaces,
  activeSpaceId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
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
}) {
  const { colors: c } = useTheme();
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
      statusBarTranslucent
    >
      <Pressable
        onPress={onClose}
        style={[modalStyles.backdrop, { backgroundColor: c.overlay }]}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={[modalStyles.spacesCard, { backgroundColor: c.bgElev2 }]}
        >
          <View style={modalStyles.cardHandle}>
            <View
              style={[modalStyles.handleBar, { backgroundColor: c.line }]}
            />
          </View>
          <View style={modalStyles.spacesHeader}>
            <Text style={[modalStyles.title, { color: c.text }]}>空间</Text>
            <IconButton
              icon="plus"
              size={36}
              iconSize={16}
              variant="tinted"
              haptic="medium"
              onPress={handleCreate}
            />
          </View>

          <ScrollView style={{ maxHeight: 400 }}>
            <View style={[modalStyles.spacesList, { backgroundColor: c.bgElev }]}>
              {ordered.length === 0 ? (
                <Text style={[modalStyles.emptyText, { color: c.text3 }]}>
                  没有空间
                </Text>
              ) : (
                ordered.map((sp, idx) => {
                  const active = sp.id === activeSpaceId;
                  return (
                    <React.Fragment key={sp.id}>
                      <PressableScale
                        onPress={() => onSelect(sp.id)}
                        onLongPress={() => handleRow(sp)}
                        scale={0.99}
                        haptic="selection"
                        pressedBg={c.bgHover}
                        style={modalStyles.spaceRow}
                      >
                        <SpaceAvatar
                          space={sp}
                          size={32}
                          background={active ? c.accent : c.bgActive}
                          foreground={active ? c.accentInk : c.text}
                          fontSize={14}
                          borderRadius={Radius.md}
                        />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={[
                              modalStyles.spaceName,
                              { color: c.text },
                            ]}
                            numberOfLines={1}
                          >
                            {sp.name}
                          </Text>
                          <Text
                            style={[
                              modalStyles.spaceMeta,
                              { color: c.text3, fontFamily: MONO },
                            ]}
                          >
                            #{sp.order}
                          </Text>
                        </View>
                        {active ? (
                          <Badge label="当前" tone="info" />
                        ) : (
                          <IconSymbol
                            name="chevron.right"
                            size={14}
                            color={c.text4}
                          />
                        )}
                      </PressableScale>
                      {idx !== ordered.length - 1 ? (
                        <View
                          style={{
                            height: StyleSheet.hairlineWidth,
                            backgroundColor: c.lineSoft,
                            marginLeft: Spacing.lg + 32 + Spacing.md,
                          }}
                        />
                      ) : null}
                    </React.Fragment>
                  );
                })
              )}
            </View>
            <Text style={[modalStyles.spacesHint, { color: c.text3 }]}>
              长按一行可重命名或删除
            </Text>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* ----- styles ----- */

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollContent: { paddingBottom: Spacing.lg },

  pageHeader: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
  },
  pageTitle: { ...Type.largeTitle },

  userCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  userInfo: { flex: 1, gap: 3 },
  userName: { ...Type.title2 },
  userMeta: { ...Type.footnote },
});

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
  },
  kavWrap: {
    flex: 1,
    justifyContent: "flex-end",
  },
  card: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxl,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    width: "100%",
  },
  cardHandle: {
    alignItems: "center",
    paddingBottom: Spacing.sm,
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  title: {
    ...Type.title2,
    marginTop: Spacing.xs,
  },
  subtitle: {
    ...Type.footnote,
    marginTop: 4,
  },

  field: { marginBottom: Spacing.sm },
  fieldLabel: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  fieldInput: {
    height: 46,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    ...Type.body,
  },
  fieldHint: { ...Type.footnote, marginTop: 4 },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  errorText: { ...Type.footnote, flex: 1 },

  actions: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },

  /* Spaces */
  spacesCard: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxl,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    width: "100%",
  },
  spacesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Spacing.md,
  },
  spacesList: {
    borderRadius: Radius.xl,
    overflow: "hidden",
  },
  spaceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md - 2,
    minHeight: 56,
  },
  spaceName: { ...Type.body },
  spaceMeta: { ...Type.footnote, marginTop: 1 },
  spacesHint: {
    ...Type.footnote,
    textAlign: "center",
    paddingTop: Spacing.sm,
  },
  emptyText: {
    ...Type.subhead,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    textAlign: "center",
  },
});
