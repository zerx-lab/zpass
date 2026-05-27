import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Animated,
  Easing,
} from "react-native";
import { dialog } from "@/components/ui/dialog";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import * as Haptics from "expo-haptics";

import { Fonts, Radius, Spacing, Type, type ColorPalette } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import {
  Badge,
  Button,
  IconButton,
} from "@/components/ui/primitives";
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

const MONO = Fonts?.mono ?? "monospace";

/** 用 6 个圆点表示已遮罩，统一视觉宽度（不再用 `•` 字符乱长） */
function maskDots(c: ColorPalette) {
  return (
    <View style={maskStyles.row}>
      {Array.from({ length: 6 }).map((_, i) => (
        <View
          key={i}
          style={[maskStyles.dot, { backgroundColor: c.text3 }]}
        />
      ))}
    </View>
  );
}

const maskStyles = StyleSheet.create({
  row: { flexDirection: "row", gap: 4, paddingVertical: 3 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});

/* ── NavBar ─────────────────────────────────────────────────── */

function NavBar({
  title,
  favorited,
  onBack,
  onFav,
  onEdit,
}: {
  title: string;
  favorited: boolean;
  onBack: () => void;
  onFav: () => void;
  onEdit: () => void;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={navStyles.wrap}>
      <IconButton
        icon="chevron.left"
        size={36}
        iconSize={20}
        variant="ghost"
        onPress={onBack}
      />
      <Text style={[navStyles.title, { color: c.text }]} numberOfLines={1}>
        {title}
      </Text>
      <View style={navStyles.right}>
        <IconButton
          icon={favorited ? "star.fill" : "star"}
          color={favorited ? c.warn : c.text3}
          size={36}
          iconSize={19}
          variant="ghost"
          haptic="selection"
          onPress={onFav}
        />
        <IconButton
          icon="square.and.pencil"
          size={36}
          iconSize={18}
          variant="ghost"
          onPress={onEdit}
        />
      </View>
    </View>
  );
}

const navStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
  },
  right: { flexDirection: "row", alignItems: "center" },
  title: {
    flex: 1,
    textAlign: "center",
    ...Type.title2,
  },
});

/* ── Section ────────────────────────────────────────────────── */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={sectionStyles.wrap}>
      <Text style={[sectionStyles.title, { color: c.text3 }]}>{title}</Text>
      <View style={[sectionStyles.card, { backgroundColor: c.bgElev }]}>
        {children}
      </View>
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.lg, marginBottom: Spacing.lg },
  title: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.xs,
  },
  card: {
    borderRadius: Radius.xl,
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
  c: ColorPalette;
  isLast?: boolean;
  multiline?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  if (!value) return null;
  const showMask = masked && !revealed;

  return (
    <View style={fieldStyles.row}>
      <View style={fieldStyles.left}>
        <Text style={[fieldStyles.label, { color: c.text3 }]}>{label}</Text>
        {showMask ? (
          maskDots(c)
        ) : (
          <Text
            style={[
              fieldStyles.value,
              {
                color: c.text,
                fontFamily: mono || masked ? MONO : undefined,
              },
            ]}
            numberOfLines={multiline ? undefined : 1}
            ellipsizeMode="tail"
          >
            {value}
          </Text>
        )}
      </View>
      <View style={fieldStyles.actions}>
        {masked && (
          <IconButton
            icon={revealed ? "eye.slash.fill" : "eye.fill"}
            size={34}
            iconSize={16}
            variant="tinted"
            haptic="selection"
            onPress={() => setRevealed((v) => !v)}
          />
        )}
        <IconButton
          icon="doc.on.doc.fill"
          size={34}
          iconSize={16}
          variant="tinted"
          haptic="light"
          onPress={async () => {
            if (masked) await copyEphemeral(value);
            else await copyText(value);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
        />
      </View>
      {!isLast && (
        <View
          style={[
            fieldStyles.hairline,
            { backgroundColor: c.lineSoft },
          ]}
        />
      )}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  hairline: {
    position: "absolute",
    bottom: 0,
    left: Spacing.lg,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  left: { flex: 1, gap: 4, minWidth: 0 },
  label: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  value: { ...Type.body },
  actions: {
    flexDirection: "row",
    gap: Spacing.xs,
    alignItems: "center",
    flexShrink: 0,
  },
});

/* ── 强度 Section ───────────────────────────────────────────── */

function StrengthSection({ password }: { password: string }) {
  const { colors: c } = useTheme();
  const { score, entropy } = estimateStrength(password);
  const color = score >= 80 ? c.ok : score >= 50 ? c.warn : c.danger;

  return (
    <Section title="密码强度">
      <View style={strengthStyles.inner}>
        <View style={strengthStyles.scoreRow}>
          <Text style={[strengthStyles.score, { color, fontFamily: MONO }]}>
            {score}
          </Text>
          <Text style={[strengthStyles.scoreMax, { color: c.text3 }]}>/100</Text>
          <View
            style={[
              strengthStyles.labelBadge,
              { backgroundColor: color + "1f" },
            ]}
          >
            <Text style={[strengthStyles.labelText, { color }]}>
              {strengthLabel(score)}
            </Text>
          </View>
        </View>
        <View style={[strengthStyles.bar, { backgroundColor: c.bgActive }]}>
          <View
            style={[
              strengthStyles.fill,
              { width: `${score}%` as any, backgroundColor: color },
            ]}
          />
        </View>
        <View style={[strengthStyles.meta, { borderTopColor: c.lineSoft }]}>
          <MetaItem label="长度" value={String(password.length)} />
          <View style={[strengthStyles.divider, { backgroundColor: c.lineSoft }]} />
          <MetaItem label="熵值" value={`${entropy}b`} />
          <View style={[strengthStyles.divider, { backgroundColor: c.lineSoft }]} />
          <MetaItem label="破解时间" value={crackTime(score)} />
        </View>
      </View>
    </Section>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={strengthStyles.metaItem}>
      <Text style={[strengthStyles.metaLabel, { color: c.text3 }]}>{label}</Text>
      <Text
        style={[strengthStyles.metaValue, { color: c.text, fontFamily: MONO }]}
      >
        {value}
      </Text>
    </View>
  );
}

const strengthStyles = StyleSheet.create({
  inner: { padding: Spacing.lg, gap: Spacing.md },
  scoreRow: { flexDirection: "row", alignItems: "baseline", gap: Spacing.xs },
  score: { fontSize: 44, fontWeight: "700", lineHeight: 50 },
  scoreMax: { fontSize: 16, marginBottom: 4 },
  labelBadge: {
    borderRadius: Radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: Spacing.xs,
    alignSelf: "center",
  },
  labelText: { ...Type.footnote, fontWeight: "700" },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3 },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.sm,
  },
  metaItem: { flex: 1, alignItems: "center", gap: 2 },
  metaLabel: {
    ...Type.caption,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  metaValue: { ...Type.subhead, fontWeight: "700" },
  divider: { width: StyleSheet.hairlineWidth, height: 28 },
});

/* ── TOTP Section ───────────────────────────────────────────── */

function TotpSection({ secret }: { secret: string }) {
  const { colors: c } = useTheme();
  const [remaining, setRemaining] = useState(totpRemaining());
  const [periodKey, setPeriodKey] = useState(() =>
    Math.floor(Date.now() / 1000 / TOTP_PERIOD),
  );
  // 进度环初始值只用挂载时的 remaining，之后由 tick 主动驱动 —— 不需要响应 remaining 变化
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ringAnim = useMemo(() => new Animated.Value(remaining / TOTP_PERIOD), []);

  useEffect(() => {
    const t = setInterval(() => {
      const r = totpRemaining();
      setRemaining(r);
      setPeriodKey(Math.floor(Date.now() / 1000 / TOTP_PERIOD));
      Animated.timing(ringAnim, {
        toValue: r / TOTP_PERIOD,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: false,
      }).start();
    }, 1000);
    return () => clearInterval(t);
  }, [ringAnim]);

  const code = useMemo(
    () => generateTotp(secret),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secret, periodKey],
  );
  const urgent = remaining <= 5;

  return (
    <Section title="TOTP 验证码">
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
          <View style={[totpStyles.bar, { backgroundColor: c.bgActive }]}>
            <Animated.View
              style={[
                totpStyles.barFill,
                {
                  backgroundColor: urgent ? c.danger : c.info,
                  width: ringAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["0%", "100%"],
                  }),
                },
              ]}
            />
          </View>
          <Text style={[totpStyles.hint, { color: c.text3 }]}>
            {remaining} 秒后刷新
          </Text>
        </View>
        <IconButton
          icon="doc.on.doc.fill"
          size={44}
          iconSize={18}
          variant="tinted"
          haptic="medium"
          onPress={async () => {
            await copyEphemeral(code);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
        />
      </View>
    </Section>
  );
}

const totpStyles = StyleSheet.create({
  inner: {
    flexDirection: "row",
    alignItems: "center",
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  codeWrap: { flex: 1, gap: 6 },
  code: { fontSize: 32, fontWeight: "700", letterSpacing: 6 },
  bar: { height: 4, borderRadius: 2, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 2 },
  hint: { ...Type.footnote },
});

/* ── 详情主屏 ───────────────────────────────────────────────── */

export default function VaultDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors: c } = useTheme();
  const { getItem, toggleFavorite, deleteItem } = useVault();

  const item = getItem(id);

  const handleDelete = useCallback(async () => {
    if (!item) return;
    const ok = await dialog.confirm(
      "删除条目",
      `确认删除「${item.name}」？此操作不可撤销。`,
      { okLabel: "删除", destructive: true },
    );
    if (!ok) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    deleteItem(item.id);
    router.back();
  }, [item, deleteItem]);

  if (!item) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]} edges={["top"]}>
        <NavBar
          title="未找到"
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
        favorited={!!item.favorite}
        onBack={() => router.back()}
        onFav={() => {
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
          <View
            style={[heroStyles.icon, { backgroundColor: faviconColor(item.name) }]}
          >
            <Text style={heroStyles.iconText}>{faviconInitials(item.name)}</Text>
          </View>
          <Text style={[heroStyles.name, { color: c.text }]}>{item.name}</Text>
          <Badge label={TYPE_LABELS[item.type]} tone="neutral" />
        </View>

        <DetailBody item={item} c={c} />

        {item.customFields && item.customFields.length > 0 ? (
          <CustomFieldsSection fields={item.customFields} />
        ) : null}

        {item.tags && item.tags.length > 0 && (
          <Section title="标签">
            <View style={styles.tagRow}>
              {item.tags.map((t) => (
                <View
                  key={t}
                  style={[styles.tagChip, { backgroundColor: c.bgActive }]}
                >
                  <Text
                    style={[
                      styles.tagChipText,
                      { color: c.text2, fontFamily: MONO },
                    ]}
                  >
                    #{t}
                  </Text>
                </View>
              ))}
            </View>
          </Section>
        )}

        {"notes" in item && item.notes ? (
          <Section title="备注">
            <View style={{ padding: Spacing.lg }}>
              <Text style={[styles.noteText, { color: c.text }]}>
                {item.notes}
              </Text>
            </View>
          </Section>
        ) : null}

        {/* 删除 */}
        <View
          style={{
            paddingHorizontal: Spacing.lg,
            marginBottom: Spacing.md,
          }}
        >
          <Button
            label="删除条目"
            icon="trash.fill"
            variant="danger"
            size="lg"
            onPress={handleDelete}
            fullWidth
          />
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
  c: ColorPalette;
}) {
  switch (item.type) {
    case "login":
      return (
        <>
          <Section title="凭据">
            <FieldRow label="用户名" value={item.username} c={c} />
            <FieldRow label="密码" value={item.password} masked c={c} />
            <FieldRow label="网址" value={item.url ?? ""} c={c} isLast />
          </Section>
          {item.password ? <StrengthSection password={item.password} /> : null}
          {item.totp ? <TotpSection secret={item.totp} /> : null}
        </>
      );
    case "card":
      return (
        <Section title="卡片信息">
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
        <Section title="笔记内容">
          <View style={{ padding: Spacing.lg }}>
            <Text style={[styles.noteText, { color: c.text }]}>{item.note}</Text>
          </View>
        </Section>
      );
    case "identity":
      return (
        <Section title="身份信息">
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
        <Section title={item.apiKey ? "API Token" : "SSH 密钥"}>
          {item.apiKey ? (
            <FieldRow label="Token" value={item.apiKey} mono masked c={c} isLast />
          ) : (
            <>
              <FieldRow label="用户" value={item.username ?? ""} c={c} />
              <FieldRow label="算法" value={item.keyType ?? ""} mono c={c} />
              <FieldRow
                label="指纹"
                value={item.fingerprint ?? ""}
                mono
                c={c}
                multiline
              />
              <FieldRow
                label="公钥"
                value={item.publicKey ?? ""}
                mono
                c={c}
                multiline
                isLast
              />
            </>
          )}
        </Section>
      );
    case "passkey":
      return (
        <Section title="通行密钥">
          <FieldRow label="依赖方 (RP)" value={item.rpId} c={c} />
          <FieldRow label="用户名" value={item.userName ?? ""} c={c} />
          <FieldRow
            label="凭据 ID"
            value={item.credentialId}
            mono
            masked
            c={c}
            isLast
          />
        </Section>
      );
    case "totp":
      return (
        <>
          <Section title="验证器">
            <FieldRow label="发行者" value={item.issuer ?? ""} c={c} />
            <FieldRow label="账户" value={item.account ?? ""} c={c} />
            <FieldRow
              label="TOTP 密钥"
              value={item.secret}
              mono
              masked
              c={c}
              isLast
            />
          </Section>
          {item.secret ? <TotpSection secret={item.secret} /> : null}
        </>
      );
  }
}

/* ── 自定义字段：详情渲染 ───────────────────────────────────── */

function CustomFieldsSection({ fields }: { fields: CustomField[] }) {
  return (
    <Section title="自定义字段">
      {fields.map((f, idx) => (
        <CustomFieldDetailRow
          key={f.id}
          field={f}
          isLast={idx === fields.length - 1}
        />
      ))}
    </Section>
  );
}

function CustomFieldDetailRow({
  field,
  isLast,
}: {
  field: CustomField;
  isLast: boolean;
}) {
  const { colors: c } = useTheme();
  const [revealed, setRevealed] = useState(false);
  const label = field.name?.trim() || "(未命名)";

  if (field.type === "boolean") {
    const on = Boolean(field.value);
    return (
      <View style={fieldStyles.row}>
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
              { backgroundColor: on ? c.accent : c.bgActive },
            ]}
          >
            <View
              style={[
                customDetailStyles.roSwitchThumb,
                {
                  backgroundColor: on ? c.accentInk : c.text3,
                  transform: [{ translateX: on ? 14 : 0 }],
                },
              ]}
            />
          </View>
        </View>
        {!isLast && (
          <View
            style={[fieldStyles.hairline, { backgroundColor: c.lineSoft }]}
          />
        )}
      </View>
    );
  }

  if (field.type === "linked") {
    const target =
      typeof field.value === "string" && field.value ? field.value : "(未关联)";
    return (
      <View style={fieldStyles.row}>
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
        {!isLast && (
          <View
            style={[fieldStyles.hairline, { backgroundColor: c.lineSoft }]}
          />
        )}
      </View>
    );
  }

  const raw = typeof field.value === "string" ? field.value : "";
  const masked = field.type === "hidden";
  if (!raw && !masked) return null;
  const showMask = masked && !revealed;

  return (
    <View style={fieldStyles.row}>
      <View style={fieldStyles.left}>
        <Text style={[fieldStyles.label, { color: c.text3 }]}>{label}</Text>
        {showMask ? (
          maskDots(c)
        ) : (
          <Text
            style={[
              fieldStyles.value,
              { color: c.text, fontFamily: masked ? MONO : undefined },
            ]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {raw}
          </Text>
        )}
      </View>
      <View style={fieldStyles.actions}>
        {masked && (
          <IconButton
            icon={revealed ? "eye.slash.fill" : "eye.fill"}
            size={34}
            iconSize={16}
            variant="tinted"
            haptic="selection"
            onPress={() => setRevealed((v) => !v)}
          />
        )}
        <IconButton
          icon="doc.on.doc.fill"
          size={34}
          iconSize={16}
          variant="tinted"
          haptic="light"
          onPress={async () => {
            if (masked) await copyEphemeral(raw);
            else await copyText(raw);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
        />
      </View>
      {!isLast && (
        <View
          style={[fieldStyles.hairline, { backgroundColor: c.lineSoft }]}
        />
      )}
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
  wrap: {
    alignItems: "center",
    paddingVertical: Spacing.xxl,
    gap: Spacing.sm,
  },
  icon: {
    width: 64,
    height: 64,
    borderRadius: Radius.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { color: "#fff", fontSize: 24, fontWeight: "700" },
  name: { ...Type.title, marginTop: 4 },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingBottom: Spacing.xxl },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { ...Type.body },
  noteText: { ...Type.body, lineHeight: 22 },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    padding: Spacing.lg,
  },
  tagChip: {
    borderRadius: Radius.md,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagChipText: { ...Type.subhead },
  footer: { alignItems: "center", paddingTop: Spacing.xs, paddingBottom: Spacing.lg },
  footerText: { ...Type.caption },
});
