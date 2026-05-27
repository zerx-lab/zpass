import React, { useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import {
  Button,
  Chip,
  IconButton,
  PressableScale,
} from "@/components/ui/primitives";
import { useVault, type ItemDraft, type ItemPatch } from "@/contexts/vault-context";
import type { VaultItem, VaultItemType } from "@/data/vault";
import { TYPE_LABELS } from "@/lib/format";
import { generatePassword } from "@/lib/password";
import { toast } from "@/components/ui/dialog";
import { QrScanner } from "@/components/qr-scanner";
import type { OtpMeta } from "@/lib/totp";
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABEL,
  LINKABLE_FIELDS_BY_TYPE,
  newCustomFieldId,
  type CustomField,
  type CustomFieldType,
} from "@/lib/custom-fields";
import type { ColorPalette } from "@/constants/theme";

const MONO = Fonts?.mono ?? "monospace";

/** 各类型的字段定义 —— 决定表单渲染顺序与控件 */
interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  multiline?: boolean;
  mono?: boolean;
  generate?: boolean;
  scan?: boolean;
  keyboard?: "default" | "email-address" | "numeric";
}

const TYPE_FIELDS: Record<VaultItemType, FieldDef[]> = {
  login: [
    { key: "username", label: "用户名", placeholder: "邮箱或账号", keyboard: "email-address" },
    { key: "password", label: "密码", secret: true, mono: true, generate: true },
    { key: "url", label: "网址", placeholder: "example.com" },
    {
      key: "totp",
      label: "TOTP 密钥",
      placeholder: "base32 / otpauth:// 或点扫码",
      mono: true,
      scan: true,
    },
  ],
  totp: [
    { key: "issuer", label: "发行者", placeholder: "GitHub / Google" },
    { key: "account", label: "账户", placeholder: "邮箱 / 用户名" },
    {
      key: "secret",
      label: "TOTP 密钥",
      placeholder: "base32 / otpauth:// 或点扫码",
      mono: true,
      secret: true,
      scan: true,
    },
  ],
  card: [
    { key: "cardholder", label: "持卡人" },
    { key: "number", label: "卡号", mono: true, keyboard: "numeric" },
    { key: "exp", label: "有效期", placeholder: "MM/YY", mono: true },
    { key: "cvv", label: "安全码", secret: true, mono: true, keyboard: "numeric" },
    { key: "pin", label: "PIN", secret: true, mono: true, keyboard: "numeric" },
    { key: "brand", label: "卡组织", placeholder: "Visa / Mastercard" },
  ],
  note: [{ key: "note", label: "笔记内容", multiline: true }],
  identity: [
    { key: "first", label: "名" },
    { key: "last", label: "姓" },
    { key: "email", label: "邮箱", keyboard: "email-address" },
    { key: "phone", label: "电话" },
    { key: "address", label: "地址", multiline: true },
    { key: "dob", label: "出生日期", placeholder: "YYYY-MM-DD", mono: true },
    { key: "passport", label: "护照号", secret: true, mono: true },
  ],
  ssh: [
    { key: "username", label: "用户" },
    { key: "keyType", label: "算法", placeholder: "ed25519 / rsa-4096", mono: true },
    { key: "fingerprint", label: "指纹", mono: true, multiline: true },
    { key: "publicKey", label: "公钥", mono: true, multiline: true },
    { key: "apiKey", label: "API Token", secret: true, mono: true },
  ],
  passkey: [
    { key: "rpId", label: "依赖方 (RP)", placeholder: "github.com" },
    { key: "userName", label: "用户名" },
    { key: "credentialId", label: "凭据 ID", mono: true },
  ],
};

const ALL_TYPES: VaultItemType[] = [
  "login",
  "totp",
  "card",
  "note",
  "identity",
  "ssh",
  "passkey",
];

export default function ItemEditorScreen() {
  const { colors: c } = useTheme();
  const params = useLocalSearchParams<{
    id: string;
    type?: string;
    initialPassword?: string;
  }>();
  const { getItem, addItem, updateItem } = useVault();

  const isNew = params.id === "new";
  const existing: VaultItem | undefined = isNew ? undefined : getItem(params.id);

  const [type, setType] = useState<VaultItemType>(
    existing?.type ??
      (ALL_TYPES.includes(params.type as VaultItemType)
        ? (params.type as VaultItemType)
        : "login"),
  );

  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    if (existing) {
      for (const [k, val] of Object.entries(existing)) {
        if (typeof val === "string") v[k] = val;
      }
      v.tags = (existing.tags ?? []).join(", ");
    } else if (isNew && params.initialPassword) {
      v.password = params.initialPassword;
    }
    return v;
  });
  const [favorite, setFavorite] = useState(existing?.favorite ?? false);

  const [customFields, setCustomFields] = useState<CustomField[]>(
    () => existing?.customFields ?? [],
  );

  const fields = useMemo(() => TYPE_FIELDS[type], [type]);
  const linkable = useMemo(() => LINKABLE_FIELDS_BY_TYPE[type] ?? [], [type]);

  const set = useCallback((k: string, val: string) => {
    setValues((prev) => ({ ...prev, [k]: val }));
  }, []);

  const addCustomField = useCallback(
    (cfType: CustomFieldType) => {
      Haptics.selectionAsync();
      setCustomFields((arr) => {
        const initial: CustomField =
          cfType === "boolean"
            ? { id: newCustomFieldId(), type: "boolean", name: "", value: false }
            : cfType === "linked"
              ? {
                  id: newCustomFieldId(),
                  type: "linked",
                  name: "",
                  value: linkable[0] ?? "",
                }
              : { id: newCustomFieldId(), type: cfType, name: "", value: "" };
        return [...arr, initial];
      });
    },
    [linkable],
  );

  const updateCustomField = useCallback(
    (id: string, patch: Partial<CustomField>) => {
      setCustomFields((arr) =>
        arr.map((f) => (f.id === id ? ({ ...f, ...patch } as CustomField) : f)),
      );
    },
    [],
  );

  const changeCustomFieldType = useCallback(
    (id: string, next: CustomFieldType) => {
      setCustomFields((arr) =>
        arr.map((f) => {
          if (f.id !== id) return f;
          if (next === f.type) return f;
          const value: string | boolean =
            next === "boolean"
              ? false
              : next === "linked"
                ? (linkable[0] ?? "")
                : "";
          return { ...f, type: next, value };
        }),
      );
    },
    [linkable],
  );

  const removeCustomField = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCustomFields((arr) => arr.filter((f) => f.id !== id));
  }, []);

  const [scanTarget, setScanTarget] = useState<string | null>(null);
  const handleScanResult = useCallback(
    (uri: string, meta: OtpMeta) => {
      if (!scanTarget) return;
      setValues((prev) => {
        const next: Record<string, string> = { ...prev, [scanTarget]: uri };
        if (type === "totp") {
          if (!next.issuer && meta.issuer) next.issuer = meta.issuer;
          if (!next.account && meta.account) next.account = meta.account;
          if (!next.name && meta.issuer) next.name = meta.issuer;
        }
        return next;
      });
      setScanTarget(null);
    },
    [scanTarget, type],
  );

  const handleSave = useCallback(async () => {
    const name = (values.name ?? "").trim();
    if (!name) {
      toast.warn("缺少名称", "请填写条目名称");
      return;
    }

    const draftFields: Record<string, unknown> = {};
    for (const f of fields) {
      const val = (values[f.key] ?? "").trim();
      if (val) draftFields[f.key] = val;
    }
    if (type === "login") {
      draftFields.username = (values.username ?? "").trim();
      draftFields.password = (values.password ?? "").trim();
    }
    if (type === "card") {
      for (const k of ["cardholder", "number", "exp", "cvv", "brand"])
        draftFields[k] = (values[k] ?? "").trim();
    }
    if (type === "note") draftFields.note = (values.note ?? "").trim();
    if (type === "identity") {
      for (const k of ["first", "last", "email", "phone", "address", "dob", "passport"])
        draftFields[k] = (values[k] ?? "").trim();
    }
    if (type === "passkey") {
      draftFields.rpId = (values.rpId ?? "").trim();
      draftFields.credentialId = (values.credentialId ?? "").trim();
    }
    if (type === "totp") {
      draftFields.secret = (values.secret ?? "").trim();
    }

    const tags = (values.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const notes = (values.notes ?? "").trim();

    const draft = {
      type,
      name,
      favorite,
      ...(tags.length ? { tags } : {}),
      ...(notes ? { notes } : {}),
      ...(customFields.length ? { customFields } : {}),
      ...draftFields,
    } as unknown as ItemDraft;

    if (isNew) {
      const created = await addItem(draft);
      if (!created) {
        toast.danger("保存失败", "无法写入加密保险库，请重试");
        return;
      }
    } else if (existing) {
      await updateItem(existing.id, draft as unknown as ItemPatch);
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }, [
    values,
    fields,
    type,
    favorite,
    customFields,
    isNew,
    existing,
    addItem,
    updateItem,
  ]);

  const showNotes = type !== "note";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["top"]}>
      {/* NavBar */}
      <View style={styles.nav}>
        <PressableScale
          onPress={() => router.back()}
          haptic="light"
          scale={0.96}
          style={styles.navBtn}
        >
          <Text style={[styles.navCancel, { color: c.text2 }]}>取消</Text>
        </PressableScale>
        <Text style={[styles.navTitle, { color: c.text }]} numberOfLines={1}>
          {isNew ? "新建条目" : "编辑条目"}
        </Text>
        <PressableScale
          onPress={handleSave}
          haptic="medium"
          scale={0.96}
          style={styles.navBtn}
        >
          <Text style={[styles.navSave, { color: c.info }]}>保存</Text>
        </PressableScale>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* 类型选择 */}
          {isNew && (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, { color: c.text3 }]}>类型</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.typeRow}
              >
                {ALL_TYPES.map((t) => (
                  <Chip
                    key={t}
                    label={TYPE_LABELS[t]}
                    active={type === t}
                    onPress={() => setType(t)}
                  />
                ))}
              </ScrollView>
            </View>
          )}

          {/* 名称 */}
          <Field
            def={{ key: "name", label: "名称", placeholder: "条目名称" }}
            value={values.name ?? ""}
            onChange={(v) => set("name", v)}
            c={c}
          />

          {/* 类型专属字段 */}
          {fields.map((f) => (
            <Field
              key={f.key}
              def={f}
              value={values[f.key] ?? ""}
              onChange={(v) => set(f.key, v)}
              c={c}
              onGenerate={
                f.generate
                  ? () => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      set(
                        f.key,
                        generatePassword(20, {
                          upper: true,
                          lower: true,
                          numbers: true,
                          symbols: true,
                          avoidAmbiguous: false,
                        }),
                      );
                    }
                  : undefined
              }
              onScan={
                f.scan
                  ? () => {
                      Haptics.selectionAsync();
                      setScanTarget(f.key);
                    }
                  : undefined
              }
            />
          ))}

          {/* 自定义字段 */}
          <CustomFieldsSection
            fields={customFields}
            linkable={linkable}
            onAdd={addCustomField}
            onChangeType={changeCustomFieldType}
            onUpdate={updateCustomField}
            onRemove={removeCustomField}
            c={c}
          />

          {/* 标签 */}
          <Field
            def={{ key: "tags", label: "标签", placeholder: "用逗号分隔，如 dev, 2fa", mono: true }}
            value={values.tags ?? ""}
            onChange={(v) => set("tags", v)}
            c={c}
          />

          {/* 备注 */}
          {showNotes && (
            <Field
              def={{ key: "notes", label: "备注", multiline: true }}
              value={values.notes ?? ""}
              onChange={(v) => set("notes", v)}
              c={c}
            />
          )}

          {/* 收藏 */}
          <PressableScale
            onPress={() => setFavorite((v) => !v)}
            scale={0.99}
            haptic="selection"
            pressedBg={c.bgHover}
            style={[styles.favRow, { backgroundColor: c.bgElev }]}
          >
            <View
              style={[
                styles.favIcon,
                { backgroundColor: favorite ? c.warn + "1f" : c.bgActive },
              ]}
            >
              <IconSymbol
                name={favorite ? "star.fill" : "star"}
                size={16}
                color={favorite ? c.warn : c.text3}
              />
            </View>
            <Text style={[styles.favText, { color: c.text }]}>加入收藏</Text>
            <View
              style={[
                styles.switchTrack,
                { backgroundColor: favorite ? c.accent : c.bgActive },
              ]}
            >
              <View
                style={[
                  styles.switchThumb,
                  {
                    backgroundColor: favorite ? c.accentInk : c.text3,
                    transform: [{ translateX: favorite ? 14 : 0 }],
                  },
                ]}
              />
            </View>
          </PressableScale>

          <View style={{ height: Spacing.xxl }} />
        </ScrollView>
      </KeyboardAvoidingView>

      <QrScanner
        visible={scanTarget !== null}
        onClose={() => setScanTarget(null)}
        onApply={handleScanResult}
      />
    </SafeAreaView>
  );
}

/* ── 单字段输入 ─────────────────────────────────────────────── */

function Field({
  def,
  value,
  onChange,
  c,
  onGenerate,
  onScan,
}: {
  def: FieldDef;
  value: string;
  onChange: (v: string) => void;
  c: ColorPalette;
  onGenerate?: () => void;
  onScan?: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const hide = def.secret && !revealed;

  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: c.text3 }]}>{def.label}</Text>
      <View
        style={[
          styles.inputWrap,
          {
            backgroundColor: c.bgElev,
            alignItems: def.multiline ? "flex-start" : "center",
          },
        ]}
      >
        <TextInput
          style={[
            styles.input,
            {
              color: c.text,
              fontFamily: def.mono ? MONO : undefined,
              height: def.multiline ? 88 : undefined,
              textAlignVertical: def.multiline ? "top" : "center",
            },
          ]}
          value={value}
          onChangeText={onChange}
          placeholder={def.placeholder ?? def.label}
          placeholderTextColor={c.text3}
          secureTextEntry={hide}
          multiline={def.multiline}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={def.keyboard ?? "default"}
        />
        <View style={styles.fieldIconRow}>
          {def.secret && (
            <IconButton
              icon={revealed ? "eye.slash.fill" : "eye.fill"}
              size={32}
              iconSize={16}
              variant="ghost"
              haptic="selection"
              onPress={() => setRevealed((v) => !v)}
            />
          )}
          {onGenerate && (
            <IconButton
              icon="arrow.clockwise"
              size={32}
              iconSize={16}
              variant="ghost"
              haptic="light"
              onPress={onGenerate}
            />
          )}
          {onScan && (
            <IconButton
              icon="qrcode.viewfinder"
              size={32}
              iconSize={18}
              variant="ghost"
              haptic="selection"
              onPress={onScan}
            />
          )}
        </View>
      </View>
    </View>
  );
}

/* ── 自定义字段：编辑器区块 ─────────────────────────────────── */

function CustomFieldsSection({
  fields,
  linkable,
  onAdd,
  onChangeType,
  onUpdate,
  onRemove,
  c,
}: {
  fields: CustomField[];
  linkable: string[];
  onAdd: (type: CustomFieldType) => void;
  onChangeType: (id: string, type: CustomFieldType) => void;
  onUpdate: (id: string, patch: Partial<CustomField>) => void;
  onRemove: (id: string) => void;
  c: ColorPalette;
}) {
  const linkedDisabled = linkable.length === 0;

  return (
    <View style={styles.cfSection}>
      <Text style={[styles.fieldLabel, { color: c.text3 }]}>自定义字段</Text>

      <View style={styles.cfAddRow}>
        {CUSTOM_FIELD_TYPES.map((tp) => {
          const disabled = tp === "linked" && linkedDisabled;
          return (
            <Button
              key={tp}
              label={CUSTOM_FIELD_TYPE_LABEL[tp]}
              icon="plus"
              variant="secondary"
              size="sm"
              onPress={() => {
                if (disabled) return;
                onAdd(tp);
              }}
              disabled={disabled}
            />
          );
        })}
      </View>

      {fields.length === 0 ? (
        <View style={[styles.cfEmpty, { backgroundColor: c.bgElev }]}>
          <IconSymbol name="text.alignleft" size={20} color={c.text3} />
          <Text style={[styles.cfEmptyText, { color: c.text3 }]}>
            可添加文本、隐藏、开关或关联字段
          </Text>
        </View>
      ) : (
        <View style={{ gap: Spacing.sm }}>
          {fields.map((f) => (
            <CustomFieldEditorRow
              key={f.id}
              field={f}
              linkable={linkable}
              onChangeType={(tp) => onChangeType(f.id, tp)}
              onUpdate={(patch) => onUpdate(f.id, patch)}
              onRemove={() => onRemove(f.id)}
              c={c}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function CustomFieldEditorRow({
  field,
  linkable,
  onChangeType,
  onUpdate,
  onRemove,
  c,
}: {
  field: CustomField;
  linkable: string[];
  onChangeType: (type: CustomFieldType) => void;
  onUpdate: (patch: Partial<CustomField>) => void;
  onRemove: () => void;
  c: ColorPalette;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <View style={[styles.cfRow, { backgroundColor: c.bgElev }]}>
      <View style={styles.cfHeader}>
        <View style={styles.cfTypeBar}>
          {CUSTOM_FIELD_TYPES.map((tp) => {
            const active = field.type === tp;
            const disabled = tp === "linked" && linkable.length === 0;
            return (
              <Chip
                key={tp}
                label={CUSTOM_FIELD_TYPE_LABEL[tp]}
                active={active}
                onPress={() => {
                  if (disabled) return;
                  onChangeType(tp);
                }}
                style={disabled && !active ? { opacity: 0.4 } : undefined}
              />
            );
          })}
        </View>
        <IconButton
          icon="trash"
          size={32}
          iconSize={15}
          variant="ghost"
          haptic="medium"
          onPress={onRemove}
        />
      </View>

      <TextInput
        style={[
          styles.cfNameInput,
          { color: c.text, backgroundColor: c.bg },
        ]}
        value={field.name}
        onChangeText={(v) => onUpdate({ name: v })}
        placeholder="字段名"
        placeholderTextColor={c.text3}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={120}
      />

      {field.type === "text" && (
        <TextInput
          style={[
            styles.cfValueInput,
            { color: c.text, backgroundColor: c.bg },
          ]}
          value={typeof field.value === "string" ? field.value : ""}
          onChangeText={(v) => onUpdate({ value: v })}
          placeholder="字段值"
          placeholderTextColor={c.text3}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}

      {field.type === "hidden" && (
        <View style={[styles.cfHiddenWrap, { backgroundColor: c.bg }]}>
          <TextInput
            style={[styles.cfHiddenInput, { color: c.text, fontFamily: MONO }]}
            value={typeof field.value === "string" ? field.value : ""}
            onChangeText={(v) => onUpdate({ value: v })}
            placeholder="字段值"
            placeholderTextColor={c.text3}
            secureTextEntry={!revealed}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <IconButton
            icon={revealed ? "eye.slash.fill" : "eye.fill"}
            size={32}
            iconSize={16}
            variant="ghost"
            onPress={() => setRevealed((v) => !v)}
          />
        </View>
      )}

      {field.type === "boolean" && (
        <PressableScale
          onPress={() => onUpdate({ value: !field.value })}
          scale={0.99}
          haptic="selection"
          pressedBg={c.bgHover}
          style={[styles.cfBoolRow, { backgroundColor: c.bg }]}
        >
          <Text style={[styles.cfBoolText, { color: c.text }]}>
            {field.value ? "已开启" : "已关闭"}
          </Text>
          <View
            style={[
              styles.switchTrack,
              { backgroundColor: field.value ? c.accent : c.bgActive },
            ]}
          >
            <View
              style={[
                styles.switchThumb,
                {
                  backgroundColor: field.value ? c.accentInk : c.text3,
                  transform: [{ translateX: field.value ? 14 : 0 }],
                },
              ]}
            />
          </View>
        </PressableScale>
      )}

      {field.type === "linked" &&
        (linkable.length === 0 ? (
          <Text style={[styles.cfLinkNote, { color: c.text3 }]}>
            当前条目类型没有可关联字段
          </Text>
        ) : (
          <View style={styles.cfLinkBar}>
            {linkable.map((k) => {
              const active =
                typeof field.value === "string" && field.value === k;
              return (
                <Chip
                  key={k}
                  label={k}
                  active={active}
                  onPress={() => onUpdate({ value: k })}
                />
              );
            })}
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.sm,
  },
  navBtn: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    minWidth: 56,
  },
  navCancel: { ...Type.body },
  navTitle: { ...Type.title2 },
  navSave: { ...Type.bodyEmph, fontWeight: "700" },

  scroll: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },

  section: { marginBottom: Spacing.lg },
  sectionLabel: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: Spacing.sm,
  },
  typeRow: {
    flexDirection: "row",
    gap: Spacing.sm,
    paddingRight: Spacing.lg,
  },

  field: { marginBottom: Spacing.md },
  fieldLabel: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 6,
    marginLeft: 2,
  },
  inputWrap: {
    flexDirection: "row",
    borderRadius: Radius.lg,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs,
    gap: Spacing.xs,
    minHeight: 46,
  },
  input: {
    flex: 1,
    ...Type.body,
    paddingVertical: 11,
  },
  fieldIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },

  favRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    marginTop: Spacing.xs,
  },
  favIcon: {
    width: 32,
    height: 32,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  favText: { flex: 1, ...Type.body },
  switchTrack: {
    width: 32,
    height: 18,
    borderRadius: 999,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  switchThumb: { width: 14, height: 14, borderRadius: 999 },

  /* 自定义字段 */
  cfSection: { marginBottom: Spacing.lg },
  cfAddRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  cfEmpty: {
    borderRadius: Radius.xl,
    paddingVertical: Spacing.lg,
    alignItems: "center",
    gap: Spacing.xs,
  },
  cfEmptyText: { ...Type.footnote },
  cfRow: {
    borderRadius: Radius.xl,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  cfHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.sm,
  },
  cfTypeBar: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  cfNameInput: {
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    ...Type.subhead,
  },
  cfValueInput: {
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    ...Type.subhead,
  },
  cfHiddenWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: Radius.lg,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs,
    gap: 4,
  },
  cfHiddenInput: { flex: 1, ...Type.subhead, paddingVertical: 10 },
  cfBoolRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  cfBoolText: { ...Type.subhead },
  cfLinkNote: { ...Type.footnote, fontStyle: "italic" },
  cfLinkBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.xs,
  },
});
