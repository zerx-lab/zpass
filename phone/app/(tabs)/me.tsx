// 我的 —— 轻量主页（对齐 harmony MeTab 的分层导航）
//
// 主页只保留：用户卡片 + 空间 + 设置入口（应用保护/外观与交互/数据管理）+ 同步 + 关于。
// 具体设置项拆到 me-protection / me-appearance / me-data 三个二级页。
// 弹窗：空间管理（其余弹层随设置项迁入各自子页）。

import Constants from "expo-constants";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import { isNativeSyncServerAvailable } from "@/modules/zpass-crypto";
import { sortSpaces, type Space } from "@/lib/spaces";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SpaceAvatar } from "@/components/space-avatar";
import { actionSheet, dialog } from "@/components/ui/dialog";
import {
  Badge,
  IconButton,
  ListGroup,
  ListRow,
  PressableScale,
} from "@/components/ui/primitives";

const MONO = Fonts?.mono ?? "monospace";

const APP_VERSION = __DEV__
  ? "dev"
  : (Constants.expoConfig?.version ?? "0.0.0");

/* ----- 用户卡片 ----- */

const UserCard = React.memo(function UserCard({
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
          {count} 条加密条目
        </Text>
      </View>
      <IconSymbol name="chevron.right" size={18} color={c.text4} />
    </PressableScale>
  );
});

/* ----- 主屏 ----- */

export default function MeScreen() {
  const { colors: c } = useTheme();
  const router = useRouter();
  // 原生是否支持作为同步服务端（仅 Android 编入 tiny_http 监听）
  const syncServerAvailable = isNativeSyncServerAvailable();

  const {
    items,
    spaces,
    activeSpaceId,
    activeSpace,
    setActiveSpace,
    createSpace,
    renameSpace,
    deleteSpace,
  } = useVault();

  const [spacesModal, setSpacesModal] = useState(false);
  const openSpacesModal = React.useCallback(() => setSpacesModal(true), []);

  const activeSpaceName = React.useMemo(() => {
    const sp = spaces.find((s) => s.id === activeSpaceId);
    return sp?.name ?? "—";
  }, [spaces, activeSpaceId]);

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: c.bg }]}
      edges={["top"]}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageHeader}>
          <Text style={[styles.pageTitle, { color: c.text }]}>我的</Text>
        </View>

        <View
          style={{ marginHorizontal: Spacing.lg, marginBottom: Spacing.lg }}
        >
          <UserCard
            count={items.length}
            space={activeSpace}
            onPress={openSpacesModal}
          />
        </View>

        <ListGroup header="空间">
          <ListRow
            title="当前空间"
            value={activeSpaceName}
            icon="square.grid.2x2.fill"
            onPress={openSpacesModal}
          />
        </ListGroup>

        <ListGroup header="设置">
          <ListRow
            title="应用保护"
            icon="lock.shield.fill"
            onPress={() => router.push("/me-protection" as never)}
          />
          <ListRow
            title="外观与交互"
            icon="paintbrush.fill"
            onPress={() => router.push("/me-appearance" as never)}
          />
          <ListRow
            title="数据管理"
            icon="arrow.down.doc.fill"
            onPress={() => router.push("/me-data" as never)}
          />
        </ListGroup>

        <ListGroup header="同步">
          <ListRow
            title="云同步"
            value="账户与设备"
            icon="cloud.fill"
            onPress={() => router.push("/cloud-account" as never)}
          />
          <ListRow
            title="局域网同步"
            value="连接桌面端"
            icon="antenna.radiowaves.left.and.right"
            onPress={() => router.push("/sync" as never)}
          />
          {syncServerAvailable ? (
            <ListRow
              title="作为同步服务端"
              value="让别人连我"
              icon="person.2.fill"
              onPress={() => router.push("/sync-host" as never)}
            />
          ) : null}
        </ListGroup>

        <ListGroup header="关于">
          <ListRow
            title="版本"
            value={APP_VERSION}
            icon="info.circle"
            accessory="none"
          />
        </ListGroup>

        <View style={{ height: Spacing.xl }} />
      </ScrollView>

      {spacesModal ? (
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
      ) : null}
    </SafeAreaView>
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
            <View
              style={[modalStyles.spacesList, { backgroundColor: c.bgElev }]}
            >
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
                            style={[modalStyles.spaceName, { color: c.text }]}
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
