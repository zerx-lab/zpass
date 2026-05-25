import React, { useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
  KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useVault, type ItemDraft, type ItemPatch } from "@/contexts/vault-context";
import type { VaultItem, VaultItemType } from "@/data/vault";
import { TYPE_LABELS } from "@/lib/format";
import { generatePassword } from "@/lib/password";
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

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** 各类型的字段定义 —— 决定表单渲染顺序与控件 */
interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  /** 是否敏感（默认隐藏 + 提供生成按钮可选） */
  secret?: boolean;
  multiline?: boolean;
  mono?: boolean;
  /** 仅 login.password 启用「生成」 */
  generate?: boolean;
  /** 启用「扫描二维码」入口（仅 TOTP 密钥字段） */
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
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const params = useLocalSearchParams<{ id: string; type?: string }>();
  const { getItem, addItem, updateItem } = useVault();

  const isNew = params.id === "new";
  const existing: VaultItem | undefined = isNew ? undefined : getItem(params.id);

  const [type, setType] = useState<VaultItemType>(
    existing?.type ??
      (ALL_TYPES.includes(params.type as VaultItemType)
        ? (params.type as VaultItemType)
        : "login"),
  );

  // 表单值：所有字段统一存字符串
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    if (existing) {
      for (const [k, val] of Object.entries(existing)) {
        if (typeof val === "string") v[k] = val;
      }
      v.tags = (existing.tags ?? []).join(", ");
    }
    return v;
  });
  const [favorite, setFavorite] = useState(existing?.favorite ?? false);

  // 自定义字段 —— 与 desktop 一致：编辑期全量在内存维护，提交时序列化到
  // fields["_customFields"]，与原生字段彻底解耦。
  const [customFields, setCustomFields] = useState<CustomField[]>(
    () => existing?.customFields ?? [],
  );

  const fields = useMemo(() => TYPE_FIELDS[type], [type]);
  const linkable = useMemo(() => LINKABLE_FIELDS_BY_TYPE[type] ?? [], [type]);

  const set = useCallback((k: string, val: string) => {
    setValues((prev) => ({ ...prev, [k]: val }));
  }, []);

  /* ── 自定义字段操作 ──────────────────────────────────────────── */
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
          // 类型切换重置 value 形态，避免类型不匹配的 stale 值
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

  /* ── 扫码：哪个字段触发扫描 / 弹窗是否打开 ──────────────────── */
  const [scanTarget, setScanTarget] = useState<string | null>(null);
  const handleScanResult = useCallback(
    (uri: string, meta: OtpMeta) => {
      if (!scanTarget) return;
      setValues((prev) => {
        const next: Record<string, string> = { ...prev, [scanTarget]: uri };
        // 独立 totp 条目：尊重用户已有输入，仅在 issuer / account 为空时回填
        if (type === "totp") {
          if (!next.issuer && meta.issuer) next.issuer = meta.issuer;
          if (!next.account && meta.account) next.account = meta.account;
          // 名称为空时也用 issuer 兜底，让列表更可读
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
      Alert.alert("缺少名称", "请填写条目名称");
      return;
    }

    // 组装 type 专属字段
    const draftFields: Record<string, unknown> = {};
    for (const f of fields) {
      const val = (values[f.key] ?? "").trim();
      if (val) draftFields[f.key] = val;
    }
    // 必填占位：保证联合类型必需字段存在
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
        Alert.alert("保存失败", "无法写入加密保险库，请重试");
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
      <View style={[styles.nav, { borderBottomColor: c.lineSoft }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={[styles.navCancel, { color: c.text2 }]}>取消</Text>
        </TouchableOpacity>
        <Text style={[styles.navTitle, { color: c.text }]}>
          {isNew ? "新建条目" : "编辑条目"}
        </Text>
        <TouchableOpacity
          onPress={handleSave}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={[styles.navSave, { color: c.text }]}>保存</Text>
        </TouchableOpacity>
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
          {/* 类型选择（仅新建时可改） */}
          {isNew && (
            <>
              <Text style={[styles.sectionLabel, { color: c.text3 }]}>类型</Text>
              <View style={styles.typeGrid}>
                {ALL_TYPES.map((t) => {
                  const active = type === t;
                  return (
                    <TouchableOpacity
                      key={t}
                      onPress={() => {
                        Haptics.selectionAsync();
                        setType(t);
                      }}
                      activeOpacity={0.75}
                      style={[
                        styles.typeChip,
                        active
                          ? { backgroundColor: c.text, borderColor: c.text }
                          : { backgroundColor: c.bgElev, borderColor: c.line },
                      ]}
                    >
                      <Text
                        style={[
                          styles.typeChipText,
                          { color: active ? c.bg : c.text2 },
                        ]}
                      >
                        {TYPE_LABELS[t]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
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

          {/* 自定义字段 —— 参考 Bitwarden / desktop 端，统一在原生字段下方 */}
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
          <TouchableOpacity
            style={[styles.favRow, { backgroundColor: c.bgElev, borderColor: c.line }]}
            onPress={() => {
              Haptics.selectionAsync();
              setFavorite((v) => !v);
            }}
            activeOpacity={0.75}
          >
            <IconSymbol
              name={favorite ? "star.fill" : "star"}
              size={18}
              color={favorite ? "#f5c518" : c.text3}
            />
            <Text style={[styles.favText, { color: c.text }]}>加入收藏</Text>
            <View
              style={[
                styles.switchTrack,
                { backgroundColor: favorite ? c.text : c.line },
              ]}
            >
              <View
                style={[
                  styles.switchThumb,
                  {
                    backgroundColor: favorite ? c.bg : c.text3,
                    transform: [{ translateX: favorite ? 14 : 0 }],
                  },
                ]}
              />
            </View>
          </TouchableOpacity>

          <View style={{ height: 32 }} />
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
  c: (typeof Colors)["dark"];
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
            borderColor: c.line,
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
        {def.secret && (
          <TouchableOpacity
            onPress={() => setRevealed((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.fieldIcon}
          >
            <IconSymbol
              name={revealed ? "eye.slash.fill" : "eye.fill"}
              size={16}
              color={c.text3}
            />
          </TouchableOpacity>
        )}
        {onGenerate && (
          <TouchableOpacity
            onPress={onGenerate}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.fieldIcon}
          >
            <IconSymbol name="arrow.clockwise" size={16} color={c.text3} />
          </TouchableOpacity>
        )}
        {onScan && (
          <TouchableOpacity
            onPress={onScan}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.fieldIcon}
          >
            <IconSymbol name="qrcode.viewfinder" size={18} color={c.text2} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

/* ── 自定义字段：编辑器区块 ─────────────────────────────────── */
//
// 顶部 4 个 + 按钮，分别对应 text / hidden / boolean / linked，与
// desktop 对话框中的下拉菜单等价。新增即追加一行编辑区。

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
  c: (typeof Colors)["dark"];
}) {
  const linkedDisabled = linkable.length === 0;

  return (
    <View style={styles.cfSection}>
      <Text style={[styles.fieldLabel, { color: c.text3 }]}>自定义字段</Text>

      {/* 4 个新增按钮 */}
      <View style={styles.cfAddRow}>
        {CUSTOM_FIELD_TYPES.map((tp) => {
          const disabled = tp === "linked" && linkedDisabled;
          return (
            <TouchableOpacity
              key={tp}
              onPress={() => {
                if (disabled) return;
                onAdd(tp);
              }}
              activeOpacity={0.75}
              style={[
                styles.cfAddChip,
                {
                  backgroundColor: c.bgElev,
                  borderColor: c.line,
                  opacity: disabled ? 0.4 : 1,
                },
              ]}
            >
              <IconSymbol name="plus" size={11} color={c.text3} />
              <Text style={[styles.cfAddChipText, { color: c.text2 }]}>
                {CUSTOM_FIELD_TYPE_LABEL[tp]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {fields.length === 0 ? (
        <View
          style={[
            styles.cfEmpty,
            { borderColor: c.line, backgroundColor: c.bgElev },
          ]}
        >
          <Text style={[styles.cfEmptyText, { color: c.text3 }]}>
            可添加文本、隐藏、开关或关联字段
          </Text>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
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
  c: (typeof Colors)["dark"];
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <View
      style={[
        styles.cfRow,
        { borderColor: c.line, backgroundColor: c.bgElev },
      ]}
    >
      {/* 顶部：类型 segment + 名称 + 删除 */}
      <View style={styles.cfHeader}>
        <View style={styles.cfTypeBar}>
          {CUSTOM_FIELD_TYPES.map((tp) => {
            const active = field.type === tp;
            const disabled = tp === "linked" && linkable.length === 0;
            return (
              <TouchableOpacity
                key={tp}
                onPress={() => {
                  if (disabled) return;
                  onChangeType(tp);
                }}
                activeOpacity={0.7}
                style={[
                  styles.cfTypeChip,
                  active
                    ? { backgroundColor: c.text, borderColor: c.text }
                    : { backgroundColor: c.bg, borderColor: c.line },
                  disabled && !active && { opacity: 0.4 },
                ]}
              >
                <Text
                  style={[
                    styles.cfTypeChipText,
                    { color: active ? c.bg : c.text3 },
                  ]}
                >
                  {CUSTOM_FIELD_TYPE_LABEL[tp]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity
          onPress={onRemove}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.cfRemoveBtn}
        >
          <IconSymbol name="trash.fill" size={15} color={c.text3} />
        </TouchableOpacity>
      </View>

      <TextInput
        style={[
          styles.cfNameInput,
          {
            color: c.text,
            backgroundColor: c.bg,
            borderColor: c.line,
          },
        ]}
        value={field.name}
        onChangeText={(v) => onUpdate({ name: v })}
        placeholder="字段名"
        placeholderTextColor={c.text3}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={120}
      />

      {/* 值控件 */}
      {field.type === "text" && (
        <TextInput
          style={[
            styles.cfValueInput,
            {
              color: c.text,
              backgroundColor: c.bg,
              borderColor: c.line,
            },
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
        <View
          style={[
            styles.cfHiddenWrap,
            { backgroundColor: c.bg, borderColor: c.line },
          ]}
        >
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
          <TouchableOpacity
            onPress={() => setRevealed((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.cfHiddenEye}
          >
            <IconSymbol
              name={revealed ? "eye.slash.fill" : "eye.fill"}
              size={16}
              color={c.text3}
            />
          </TouchableOpacity>
        </View>
      )}

      {field.type === "boolean" && (
        <TouchableOpacity
          onPress={() => onUpdate({ value: !field.value })}
          activeOpacity={0.75}
          style={[
            styles.cfBoolRow,
            { backgroundColor: c.bg, borderColor: c.line },
          ]}
        >
          <Text style={[styles.cfBoolText, { color: c.text2 }]}>
            {field.value ? "已开启" : "已关闭"}
          </Text>
          <View
            style={[
              styles.cfSwitchTrack,
              { backgroundColor: field.value ? c.text : c.line },
            ]}
          >
            <View
              style={[
                styles.cfSwitchThumb,
                {
                  backgroundColor: field.value ? c.bg : c.text3,
                  transform: [{ translateX: field.value ? 14 : 0 }],
                },
              ]}
            />
          </View>
        </TouchableOpacity>
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
                <TouchableOpacity
                  key={k}
                  onPress={() => onUpdate({ value: k })}
                  activeOpacity={0.7}
                  style={[
                    styles.cfLinkChip,
                    active
                      ? { backgroundColor: c.text, borderColor: c.text }
                      : { backgroundColor: c.bg, borderColor: c.line },
                  ]}
                >
                  <Text
                    style={[
                      styles.cfLinkChipText,
                      {
                        color: active ? c.bg : c.text3,
                        fontFamily: MONO,
                      },
                    ]}
                  >
                    {k}
                  </Text>
                </TouchableOpacity>
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navCancel: { fontSize: 15 },
  navTitle: { fontSize: 16, fontWeight: "600" },
  navSave: { fontSize: 15, fontWeight: "700" },

  scroll: { paddingHorizontal: 16, paddingTop: 16 },

  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  typeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 20,
  },
  typeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  typeChipText: { fontSize: 13, fontWeight: "500" },

  field: { marginBottom: 14 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 6,
    marginLeft: 2,
  },
  inputWrap: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 11,
  },
  fieldIcon: {
    width: 28,
    height: 43,
    alignItems: "center",
    justifyContent: "center",
  },

  favRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginTop: 4,
  },
  favText: { flex: 1, fontSize: 14, fontWeight: "500" },
  switchTrack: {
    width: 32,
    height: 18,
    borderRadius: 999,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  switchThumb: { width: 14, height: 14, borderRadius: 999 },

  /* 自定义字段 */
  cfSection: { marginBottom: 16 },
  cfAddRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 10,
  },
  cfAddChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  cfAddChipText: { fontSize: 12, fontWeight: "500" },
  cfEmpty: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  cfEmptyText: { fontSize: 12 },
  cfRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  cfHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cfTypeBar: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  cfTypeChip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cfTypeChipText: { fontSize: 11, fontWeight: "500" },
  cfRemoveBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  cfNameInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
  },
  cfValueInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
  },
  cfHiddenWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    gap: 4,
  },
  cfHiddenInput: { flex: 1, fontSize: 13, paddingVertical: 9 },
  cfHiddenEye: {
    width: 28,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  cfBoolRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  cfBoolText: { fontSize: 13 },
  cfSwitchTrack: {
    width: 32,
    height: 18,
    borderRadius: 999,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  cfSwitchThumb: { width: 14, height: 14, borderRadius: 999 },
  cfLinkNote: { fontSize: 12, fontStyle: "italic" },
  cfLinkBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  cfLinkChip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cfLinkChipText: { fontSize: 11 },
});
