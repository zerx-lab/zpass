import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useVault } from "@/contexts/vault-context";
import type { VaultItem } from "@/data/vault";
import {
  faviconColor,
  faviconInitials,
  relativeTime,
  TYPE_LABELS,
} from "@/lib/format";
import { estimateStrength, strengthLabel, crackTime } from "@/lib/password";
import {
  generateTotp,
  formatTotpCode,
  totpRemaining,
  TOTP_PERIOD,
} from "@/lib/totp";
import { copyText, copyEphemeral } from "@/lib/clipboard";
import type { CustomField } from "@/lib/custom-fields";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/* ── NavBar ─────────────────────────────────────────────────── */

function NavBar({
  title,
  c,
  favorited,
  onBack,
  onFav,
  onEdit,
}: {
  title: string;
  c: (typeof Colors)["dark"];
  favorited: boolean;
  onBack: () => void;
  onFav: () => void;
  onEdit: () => void;
}) {
  return (
    <View style={[navStyles.wrap, { borderBottomColor: c.lineSoft }]}>
      <TouchableOpacity
        style={navStyles.btn}
        onPress={onBack}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <IconSymbol name="chevron.left" size={22} color={c.text} />
      </TouchableOpacity>
      <Text style={[navStyles.title, { color: c.text }]} numberOfLines={1}>
        {title}
      </Text>
      <View style={navStyles.right}>
        <TouchableOpacity
          style={navStyles.btn}
          onPress={onFav}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <IconSymbol
            name={favorited ? "star.fill" : "star"}
            size={21}
            color={favorited ? "#f5c518" : c.text3}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={navStyles.btn}
          onPress={onEdit}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <IconSymbol name="square.and.pencil" size={19} color={c.text} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const navStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  btn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  right: { flexDirection: "row" },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
});

/* ── Section ────────────────────────────────────────────────── */

function Section({
  title,
  children,
  c,
}: {
  title: string;
  children: React.ReactNode;
  c: (typeof Colors)["dark"];
}) {
  return (
    <View style={sectionStyles.wrap}>
      <Text style={[sectionStyles.title, { color: c.text3 }]}>{title}</Text>
      <View
        style={[
          sectionStyles.card,
          { backgroundColor: c.bgElev, borderColor: c.line },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, marginBottom: 16 },
  title: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});

/* ── 字段行 ─────────────────────────────────────────────────── */

function FieldRow({
  label,
  value,
  masked,
  mono,
  c,
  isLast,
  multiline,
}: {
  label: string;
  value: string;
  masked?: boolean;
  mono?: boolean;
  c: (typeof Colors)["dark"];
  isLast?: boolean;
  multiline?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  if (!value) return null;
  const display = masked && !revealed ? "•".repeat(Math.min(value.length, 20)) : value;

  return (
    <View
      style={[
        fieldStyles.row,
        { borderBottomColor: isLast ? "transparent" : c.lineSoft },
      ]}
    >
      <View style={fieldStyles.left}>
        <Text style={[fieldStyles.label, { color: c.text3 }]}>{label}</Text>
        <Text
          style={[
            fieldStyles.value,
            { color: c.text, fontFamily: mono || masked ? MONO : undefined },
          ]}
          numberOfLines={multiline ? undefined : 1}
          ellipsizeMode="tail"
        >
          {display}
        </Text>
      </View>
      <View style={fieldStyles.actions}>
        {masked && (
          <TouchableOpacity
            onPress={() => setRevealed((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[fieldStyles.iconBtn, { backgroundColor: c.bgHover }]}
          >
            <IconSymbol
              name={revealed ? "eye.slash.fill" : "eye.fill"}
              size={16}
              color={c.text2}
            />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={async () => {
            if (masked) await copyEphemeral(value);
            else await copyText(value);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[fieldStyles.iconBtn, { backgroundColor: c.bgHover }]}
        >
          <IconSymbol name="doc.on.doc.fill" size={16} color={c.text2} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  left: { flex: 1, gap: 2, minWidth: 0 },
  label: { fontSize: 11, fontWeight: "500" },
  value: { fontSize: 14 },
  actions: { flexDirection: "row", gap: 6, alignItems: "center", flexShrink: 0 },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
});

/* ── 强度 Section ───────────────────────────────────────────── */

function StrengthSection({
  password,
  c,
}: {
  password: string;
  c: (typeof Colors)["dark"];
}) {
  const { score, entropy } = estimateStrength(password);
  const color = score >= 80 ? c.ok : score >= 50 ? c.warn : c.danger;

  return (
    <Section title="密码强度" c={c}>
      <View style={strengthStyles.inner}>
        <View style={strengthStyles.scoreRow}>
          <Text style={[strengthStyles.score, { color, fontFamily: MONO }]}>
            {score}
          </Text>
          <Text style={[strengthStyles.scoreMax, { color: c.text3 }]}>/100</Text>
          <View style={[strengthStyles.labelBadge, { borderColor: color }]}>
            <Text style={[strengthStyles.labelText, { color }]}>
              {strengthLabel(score)}
            </Text>
          </View>
        </View>
        <View style={[strengthStyles.bar, { backgroundColor: c.lineSoft }]}>
          <View
            style={[
              strengthStyles.fill,
              { width: `${score}%` as any, backgroundColor: color },
            ]}
          />
        </View>
        <View style={[strengthStyles.meta, { borderTopColor: c.lineSoft }]}>
          <MetaItem label="长度" value={String(password.length)} c={c} />
          <View style={[strengthStyles.divider, { backgroundColor: c.lineSoft }]} />
          <MetaItem label="熵值" value={`${entropy} bit`} c={c} />
          <View style={[strengthStyles.divider, { backgroundColor: c.lineSoft }]} />
          <MetaItem label="破解时间" value={crackTime(score)} c={c} />
        </View>
      </View>
    </Section>
  );
}

function MetaItem({
  label,
  value,
  c,
}: {
  label: string;
  value: string;
  c: (typeof Colors)["dark"];
}) {
  return (
    <View style={strengthStyles.metaItem}>
      <Text style={[strengthStyles.metaLabel, { color: c.text3 }]}>{label}</Text>
      <Text style={[strengthStyles.metaValue, { color: c.text, fontFamily: MONO }]}>
        {value}
      </Text>
    </View>
  );
}

const strengthStyles = StyleSheet.create({
  inner: { padding: 14, gap: 12 },
  scoreRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  score: { fontSize: 40, fontWeight: "700", lineHeight: 46 },
  scoreMax: { fontSize: 16, marginBottom: 2 },
  labelBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 4,
    alignSelf: "center",
  },
  labelText: { fontSize: 12, fontWeight: "600" },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3 },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
  },
  metaItem: { flex: 1, alignItems: "center", gap: 2 },
  metaLabel: { fontSize: 10, fontWeight: "500" },
  metaValue: { fontSize: 13, fontWeight: "600" },
  divider: { width: StyleSheet.hairlineWidth, height: 28 },
});

/* ── TOTP Section ───────────────────────────────────────────── */

function TotpSection({
  secret,
  c,
}: {
  secret: string;
  c: (typeof Colors)["dark"];
}) {
  const [remaining, setRemaining] = useState(totpRemaining());
  const [periodKey, setPeriodKey] = useState(() =>
    Math.floor(Date.now() / 1000 / TOTP_PERIOD),
  );

  useEffect(() => {
    const t = setInterval(() => {
      setRemaining(totpRemaining());
      setPeriodKey(Math.floor(Date.now() / 1000 / TOTP_PERIOD));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const code = useMemo(
    () => generateTotp(secret),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secret, periodKey],
  );
  const urgent = remaining <= 5;

  return (
    <Section title="TOTP 验证码" c={c}>
      <View style={totpStyles.inner}>
        <View style={totpStyles.codeWrap}>
          <Text
            style={[
              totpStyles.code,
              { color: urgent ? c.danger : c.text, fontFamily: MONO },
            ]}
          >
            {formatTotpCode(code)}
          </Text>
          <Text style={[totpStyles.hint, { color: c.text3 }]}>
            {remaining}秒后刷新
          </Text>
        </View>
        <TouchableOpacity
          style={[totpStyles.copyBtn, { backgroundColor: c.bgHover, borderColor: c.line }]}
          onPress={async () => {
            await copyEphemeral(code);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
          activeOpacity={0.7}
        >
          <Text style={[totpStyles.copyText, { color: c.text2 }]}>复制</Text>
        </TouchableOpacity>
      </View>
    </Section>
  );
}

const totpStyles = StyleSheet.create({
  inner: { flexDirection: "row", alignItems: "center", padding: 14, gap: 14 },
  codeWrap: { flex: 1, gap: 2 },
  code: { fontSize: 28, fontWeight: "700", letterSpacing: 6 },
  hint: { fontSize: 11 },
  copyBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  copyText: { fontSize: 13, fontWeight: "500" },
});

/* ── 详情主屏 ───────────────────────────────────────────────── */

export default function VaultDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];
  const { getItem, toggleFavorite, deleteItem } = useVault();

  const item = getItem(id);

  const handleDelete = useCallback(() => {
    if (!item) return;
    Alert.alert("删除条目", `确认删除「${item.name}」？此操作不可撤销。`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          deleteItem(item.id);
          router.back();
        },
      },
    ]);
  }, [item, deleteItem]);

  if (!item) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]} edges={["top"]}>
        <NavBar
          title="未找到"
          c={c}
          favorited={false}
          onBack={() => router.back()}
          onFav={() => {}}
          onEdit={() => {}}
        />
        <View style={styles.notFound}>
          <Text style={[styles.notFoundText, { color: c.text3 }]}>
            条目不存在 (id: {id})
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]} edges={["top"]}>
      <NavBar
        title={item.name}
        c={c}
        favorited={!!item.favorite}
        onBack={() => router.back()}
        onFav={() => {
          Haptics.selectionAsync();
          toggleFavorite(item.id);
        }}
        onEdit={() => router.push(`/item/${item.id}` as any)}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={heroStyles.wrap}>
          <View style={[heroStyles.icon, { backgroundColor: faviconColor(item.name) }]}>
            <Text style={heroStyles.iconText}>{faviconInitials(item.name)}</Text>
          </View>
          <Text style={[heroStyles.name, { color: c.text }]}>{item.name}</Text>
          <View style={[heroStyles.tag, { borderColor: c.line }]}>
            <Text style={[heroStyles.tagText, { color: c.text2 }]}>
              {TYPE_LABELS[item.type]}
            </Text>
          </View>
        </View>

        <DetailBody item={item} c={c} />

        {/* 自定义字段（与 desktop 一致，渲染在原生字段下方） */}
        {item.customFields && item.customFields.length > 0 ? (
          <CustomFieldsSection fields={item.customFields} c={c} />
        ) : null}

        {/* 标签 */}
        {item.tags && item.tags.length > 0 && (
          <Section title="标签" c={c}>
            <View style={styles.tagRow}>
              {item.tags.map((t) => (
                <View key={t} style={[styles.tagChip, { borderColor: c.line, backgroundColor: c.bgHover }]}>
                  <Text style={[styles.tagChipText, { color: c.text2 }]}>#{t}</Text>
                </View>
              ))}
            </View>
          </Section>
        )}

        {/* 备注 */}
        {"notes" in item && item.notes ? (
          <Section title="备注" c={c}>
            <View style={{ padding: 14 }}>
              <Text style={[styles.noteText, { color: c.text2 }]}>{item.notes}</Text>
            </View>
          </Section>
        ) : null}

        {/* 删除 */}
        <View style={{ paddingHorizontal: 16, marginBottom: 16 }}>
          <TouchableOpacity
            style={[styles.deleteBtn, { borderColor: c.danger + "88" }]}
            onPress={handleDelete}
            activeOpacity={0.75}
          >
            <IconSymbol name="trash.fill" size={16} color={c.danger} />
            <Text style={[styles.deleteText, { color: c.danger }]}>删除条目</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: c.text3 }]}>
            最后修改 · {relativeTime(item.modified)}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ── 按类型渲染字段 ─────────────────────────────────────────── */

function DetailBody({
  item,
  c,
}: {
  item: VaultItem;
  c: (typeof Colors)["dark"];
}) {
  switch (item.type) {
    case "login":
      return (
        <>
          <Section title="凭据" c={c}>
            <FieldRow label="用户名" value={item.username} c={c} />
            <FieldRow label="密码" value={item.password} masked c={c} />
            <FieldRow label="网址" value={item.url ?? ""} c={c} isLast />
          </Section>
          {item.password ? <StrengthSection password={item.password} c={c} /> : null}
          {item.totp ? <TotpSection secret={item.totp} c={c} /> : null}
        </>
      );
    case "card":
      return (
        <Section title="卡片信息" c={c}>
          <FieldRow label="持卡人" value={item.cardholder} c={c} />
          <FieldRow label="卡号" value={item.number} mono masked c={c} />
          <FieldRow label="有效期" value={item.exp} mono c={c} />
          <FieldRow label="安全码" value={item.cvv} mono masked c={c} />
          <FieldRow label="PIN" value={item.pin ?? ""} mono masked c={c} />
          <FieldRow label="卡组织" value={item.brand} c={c} isLast />
        </Section>
      );
    case "note":
      return (
        <Section title="笔记内容" c={c}>
          <View style={{ padding: 14 }}>
            <Text style={[styles.noteText, { color: c.text }]}>{item.note}</Text>
          </View>
        </Section>
      );
    case "identity":
      return (
        <Section title="身份信息" c={c}>
          <FieldRow label="名" value={item.first} c={c} />
          <FieldRow label="姓" value={item.last} c={c} />
          <FieldRow label="邮箱" value={item.email} c={c} />
          <FieldRow label="电话" value={item.phone} c={c} />
          <FieldRow label="地址" value={item.address} c={c} multiline />
          <FieldRow label="出生日期" value={item.dob} mono c={c} />
          <FieldRow label="护照号" value={item.passport} mono masked c={c} isLast />
        </Section>
      );
    case "ssh":
      return (
        <Section title={item.apiKey ? "API Token" : "SSH 密钥"} c={c}>
          {item.apiKey ? (
            <FieldRow label="Token" value={item.apiKey} mono masked c={c} isLast />
          ) : (
            <>
              <FieldRow label="用户" value={item.username ?? ""} c={c} />
              <FieldRow label="算法" value={item.keyType ?? ""} mono c={c} />
              <FieldRow label="指纹" value={item.fingerprint ?? ""} mono c={c} multiline />
              <FieldRow label="公钥" value={item.publicKey ?? ""} mono c={c} multiline isLast />
            </>
          )}
        </Section>
      );
    case "passkey":
      return (
        <Section title="通行密钥" c={c}>
          <FieldRow label="依赖方 (RP)" value={item.rpId} c={c} />
          <FieldRow label="用户名" value={item.userName ?? ""} c={c} />
          <FieldRow label="凭据 ID" value={item.credentialId} mono masked c={c} isLast />
        </Section>
      );
    case "totp":
      return (
        <>
          <Section title="验证器" c={c}>
            <FieldRow label="发行者" value={item.issuer ?? ""} c={c} />
            <FieldRow label="账户" value={item.account ?? ""} c={c} />
            <FieldRow label="TOTP 密钥" value={item.secret} mono masked c={c} isLast />
          </Section>
          {item.secret ? <TotpSection secret={item.secret} c={c} /> : null}
        </>
      );
  }
}

/* ── 自定义字段：详情渲染 ───────────────────────────────────── */
//
// 与 desktop CustomFieldsView 一致：每个字段单独成行；
// text/hidden 支持复制（hidden 走 copyEphemeral 30s 自动清空），
// boolean 渲染为只读 switch 样式，linked 显示关联字段键名。

function CustomFieldsSection({
  fields,
  c,
}: {
  fields: CustomField[];
  c: (typeof Colors)["dark"];
}) {
  return (
    <Section title="自定义字段" c={c}>
      {fields.map((f, idx) => (
        <CustomFieldDetailRow
          key={f.id}
          field={f}
          c={c}
          isLast={idx === fields.length - 1}
        />
      ))}
    </Section>
  );
}

function CustomFieldDetailRow({
  field,
  c,
  isLast,
}: {
  field: CustomField;
  c: (typeof Colors)["dark"];
  isLast: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const label = field.name?.trim() || "(未命名)";

  if (field.type === "boolean") {
    const on = Boolean(field.value);
    return (
      <View
        style={[
          fieldStyles.row,
          { borderBottomColor: isLast ? "transparent" : c.lineSoft },
        ]}
      >
        <View style={fieldStyles.left}>
          <Text style={[fieldStyles.label, { color: c.text3 }]}>{label}</Text>
          <Text style={[fieldStyles.value, { color: c.text }]}>
            {on ? "已开启" : "已关闭"}
          </Text>
        </View>
        <View style={fieldStyles.actions}>
          <View
            style={[
              customDetailStyles.roSwitch,
              { backgroundColor: on ? c.text : c.line },
            ]}
          >
            <View
              style={[
                customDetailStyles.roSwitchThumb,
                {
                  backgroundColor: on ? c.bg : c.text3,
                  transform: [{ translateX: on ? 14 : 0 }],
                },
              ]}
            />
          </View>
        </View>
      </View>
    );
  }

  if (field.type === "linked") {
    const target =
      typeof field.value === "string" && field.value ? field.value : "(未关联)";
    return (
      <View
        style={[
          fieldStyles.row,
          { borderBottomColor: isLast ? "transparent" : c.lineSoft },
        ]}
      >
        <View style={fieldStyles.left}>
          <Text style={[fieldStyles.label, { color: c.text3 }]}>{label}</Text>
          <View style={customDetailStyles.linkRow}>
            <IconSymbol name="link" size={13} color={c.text3} />
            <Text
              style={[
                fieldStyles.value,
                { color: c.text2, fontFamily: MONO },
              ]}
              numberOfLines={1}
            >
              {target}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const raw = typeof field.value === "string" ? field.value : "";
  const masked = field.type === "hidden";
  if (!raw && !masked) {
    // 与原生 FieldRow 行为一致：空文本字段不渲染（boolean / linked 例外）
    return null;
  }
  const display = masked && !revealed ? "•".repeat(Math.min(raw.length, 20)) : raw;
  return (
    <View
      style={[
        fieldStyles.row,
        { borderBottomColor: isLast ? "transparent" : c.lineSoft },
      ]}
    >
      <View style={fieldStyles.left}>
        <Text style={[fieldStyles.label, { color: c.text3 }]}>{label}</Text>
        <Text
          style={[
            fieldStyles.value,
            { color: c.text, fontFamily: masked ? MONO : undefined },
          ]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {display}
        </Text>
      </View>
      <View style={fieldStyles.actions}>
        {masked && (
          <TouchableOpacity
            onPress={() => setRevealed((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[fieldStyles.iconBtn, { backgroundColor: c.bgHover }]}
          >
            <IconSymbol
              name={revealed ? "eye.slash.fill" : "eye.fill"}
              size={16}
              color={c.text2}
            />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={async () => {
            if (masked) await copyEphemeral(raw);
            else await copyText(raw);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[fieldStyles.iconBtn, { backgroundColor: c.bgHover }]}
        >
          <IconSymbol name="doc.on.doc.fill" size={16} color={c.text2} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const customDetailStyles = StyleSheet.create({
  roSwitch: {
    width: 32,
    height: 18,
    borderRadius: 999,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  roSwitchThumb: { width: 14, height: 14, borderRadius: 999 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 5 },
});

const heroStyles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: 24, gap: 8 },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { color: "#fff", fontSize: 22, fontWeight: "700" },
  name: { fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  tag: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: { fontSize: 11, fontWeight: "500" },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingBottom: 40 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 14 },
  noteText: { fontSize: 14, lineHeight: 21 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 14 },
  tagChip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagChipText: { fontSize: 12, fontFamily: MONO },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
  },
  deleteText: { fontSize: 15, fontWeight: "600" },
  footer: { alignItems: "center", paddingTop: 4, paddingBottom: 16 },
  footerText: { fontSize: 11 },
});
