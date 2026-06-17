// 云账户 —— 注册 / 登录 / 恢复会话 / 登出（对齐 harmony pages/CloudAccount.ets）
//
// 零知识 SRP-6a 登录入口：配好云服务地址后，注册产出一次性 Secret Key（用户须备份）；
// 登录需邮箱 + 主密码 + Secret Key；已保存账户时仅需主密码即可恢复会话（解锁 vault 时也会
// 自动恢复）。会话建立后跳「保险库同步」(/cloud-sync) 完成云 vault 绑定与同步。
//
// 状态机互斥渲染（harmony 优先级）：secretKeyBackup 卡片悬于一切之上；其下依次
// 未配置地址 → 已登录 → 二次验证 → 待恢复 → 注册/登录切换。

import React, { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useRouter } from "expo-router";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useCloud } from "@/contexts/cloud-context";
import {
  cloudService,
  DEFAULT_CLOUD_BASE_URL,
  LOCAL_CLOUD_BASE_URL,
} from "@/lib/cloud-service";
import { vaultService } from "@/lib/vault-service";
import { copyText } from "@/lib/clipboard";
import { dialog, toast } from "@/components/ui/dialog";
import { Button, RawTextInput } from "@/components/ui/primitives";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SettingsPage } from "@/components/settings/settings-page";
import {
  SheetErrorBox,
  SheetModal,
  sheetStyles,
} from "@/components/settings/sheet-modal";

const MONO = Fonts?.mono ?? "monospace";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CloudAccountScreen() {
  const { colors: c } = useTheme();
  const router = useRouter();
  const {
    configured,
    baseUrl,
    hasAccount,
    signedIn,
    mfaRequired,
    email,
    accountId,
    plan,
    secretKeyBackup,
    hydrated,
    configure,
    register,
    signIn,
    restoreSession,
    signOut,
    verifySecretKey,
    clearAllCloudData,
    completeMfa,
    cancelMfa,
    dismissSecretKeyBackup,
    syncNow,
    ensureRestored,
  } = useCloud();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [secretKeyInput, setSecretKeyInput] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState("");

  const [clearVisible, setClearVisible] = useState(false);
  const [clearMp, setClearMp] = useState("");
  const [clearSk, setClearSk] = useState("");
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState("");

  const seededEmail = useRef(false);

  // 兜底冷启动竞态：进入页面时若 vault 已解锁但云会话未恢复，静默重建（幂等）。
  useEffect(() => {
    ensureRestored().catch(() => {});
  }, [ensureRestored]);

  // 水合后用已保存邮箱回填表单（仅一次，避免覆盖用户输入）。
  useEffect(() => {
    if (!seededEmail.current && hydrated && email) {
      setEmailInput(email);
      seededEmail.current = true;
    }
  }, [hydrated, email]);

  // 让开发者地址输入框跟随实际生效地址（保存后回写）。
  useEffect(() => {
    if (baseUrl) setServerUrl(baseUrl);
  }, [baseUrl]);

  /* ---------------------------------------------------------------- 操作 */

  const handleRegister = async () => {
    const em = emailInput.trim();
    if (!EMAIL_RE.test(em)) {
      toast.warn("请输入有效的邮箱地址");
      return;
    }
    if (passwordInput.length < 8) {
      toast.warn("主密码至少 8 位");
      return;
    }
    setBusy(true);
    try {
      await register(em, passwordInput);
      setPasswordInput("");
      if (cloudService.getState().signedIn) await syncNow();
      toast.ok("注册成功，请备份 Secret Key");
    } catch (e) {
      toast.danger((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async () => {
    const em = emailInput.trim();
    if (!EMAIL_RE.test(em)) {
      toast.warn("请输入有效的邮箱地址");
      return;
    }
    if (!passwordInput) {
      toast.warn("请输入主密码");
      return;
    }
    if (!secretKeyInput.trim()) {
      toast.warn("请输入 Secret Key");
      return;
    }
    setBusy(true);
    try {
      await signIn(em, passwordInput, secretKeyInput.trim());
      setPasswordInput("");
      setSecretKeyInput("");
      if (cloudService.getState().signedIn) await syncNow();
      if (!cloudService.getState().mfaRequired) toast.ok("登录成功");
    } catch (e) {
      toast.danger((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!passwordInput) {
      toast.warn("请输入云账户主密码");
      return;
    }
    setBusy(true);
    try {
      await restoreSession(passwordInput);
      setPasswordInput("");
      if (cloudService.getState().mfaRequired) return;
      toast.ok("云会话已恢复");
    } catch (e) {
      toast.danger((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    const ok = await dialog.confirm(
      "退出云账户",
      "将清除本设备保存的云账户与同步绑定（本地保险库不受影响）。",
      { okLabel: "退出", cancelLabel: "取消", destructive: true },
    );
    if (!ok) return;
    try {
      await signOut();
      setPasswordInput("");
      setSecretKeyInput("");
    } catch (e) {
      toast.danger((e as Error).message);
    }
  };

  const handleCompleteMfa = async () => {
    if (!mfaCode.trim()) {
      toast.warn("请输入验证码");
      return;
    }
    setBusy(true);
    try {
      await completeMfa(mfaCode.trim());
      setMfaCode("");
      setPasswordInput("");
      setSecretKeyInput("");
      toast.ok("登录成功");
    } catch (e) {
      toast.danger((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelMfa = () => {
    cancelMfa();
    setMfaCode("");
  };

  const handleCopySecretKey = async () => {
    try {
      await copyText(secretKeyBackup);
      toast.ok("已复制 Secret Key");
    } catch (e) {
      toast.danger((e as Error).message);
    }
  };

  const handleSaveServer = (url?: string) => {
    const target = url ?? serverUrl;
    try {
      configure(target);
      if (url) setServerUrl(url);
      toast.ok("云服务地址已保存");
    } catch (e) {
      toast.danger((e as Error).message);
    }
  };

  const closeClearModal = () => {
    setClearVisible(false);
    setClearMp("");
    setClearSk("");
    setClearError("");
    setClearBusy(false);
  };

  // 云端清空：验证主密码 + Secret Key → 删云端数据（本地保险库不受影响）。
  const handleClearCloud = async () => {
    if (clearBusy) return;
    setClearError("");
    let mpOk = false;
    try {
      mpOk = await vaultService.verifyPassword(clearMp);
    } catch (e) {
      setClearError((e as Error).message ?? "主密码验证失败");
      return;
    }
    if (!mpOk) {
      setClearError("主密码错误");
      return;
    }
    if (!verifySecretKey(clearSk)) {
      setClearError("Secret Key 不匹配");
      return;
    }
    setClearBusy(true);
    try {
      await clearAllCloudData();
      closeClearModal();
      toast.ok("已清空云端数据");
    } catch (e) {
      setClearError((e as Error).message ?? "清空失败");
      setClearBusy(false);
    }
  };

  /* ---------------------------------------------------------------- 卡片 */

  const secretKeyCard = (
    <Card style={{ backgroundColor: c.warn + "1f" }}>
      <View style={styles.cardHeader}>
        <IconSymbol name="key.fill" size={16} color={c.warn} />
        <Text style={[styles.cardTitle, { color: c.warn, flex: 1 }]}>
          请立即备份你的 Secret Key
        </Text>
      </View>
      <Text style={[styles.cardDesc, { color: c.text3 }]}>
        它与主密码共同解密数据；服务器与我们都无法找回。请复制并妥善保存。
      </Text>
      <Text
        selectable
        style={[styles.secretKey, { color: c.text, backgroundColor: c.bg }]}
      >
        {secretKeyBackup}
      </Text>
      <Button
        label="复制 Secret Key"
        icon="doc.on.doc.fill"
        variant="secondary"
        fullWidth
        onPress={handleCopySecretKey}
      />
      <Button label="我已安全备份" fullWidth onPress={dismissSecretKeyBackup} />
    </Card>
  );

  const devServerCard = (
    <Card style={{ borderWidth: 1, borderColor: c.warn }}>
      <View style={styles.cardHeader}>
        <IconSymbol name="globe" size={16} color={c.info} />
        <Text style={[styles.cardTitle, { color: c.text, flex: 1 }]}>
          开发者 · 云服务地址
        </Text>
      </View>
      <RawTextInput
        style={[styles.fieldInput, { color: c.text, backgroundColor: c.bg }]}
        value={serverUrl}
        onChangeText={setServerUrl}
        placeholder="https://..."
        placeholderTextColor={c.text4}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.row}>
        <Button
          label="线上"
          variant="secondary"
          size="sm"
          style={styles.flex1}
          onPress={() => handleSaveServer(DEFAULT_CLOUD_BASE_URL)}
        />
        <Button
          label="本地"
          variant="secondary"
          size="sm"
          style={styles.flex1}
          onPress={() => handleSaveServer(LOCAL_CLOUD_BASE_URL)}
        />
        <Button
          label="保存"
          size="sm"
          style={styles.flex1}
          onPress={() => handleSaveServer()}
        />
      </View>
      <Text
        style={[styles.metaLine, { color: c.text3 }]}
        numberOfLines={1}
      >{`当前：${baseUrl}`}</Text>
    </Card>
  );

  const serverCard = (
    <Card>
      <FormField
        label="云服务地址"
        value={serverUrl}
        onChangeText={setServerUrl}
        placeholder="https://zpass.example.com"
        keyboardType="default"
        editable={!busy}
      />
      <Button label="保存地址" size="lg" fullWidth onPress={() => handleSaveServer()} />
    </Card>
  );

  const accountCard = (
    <Card>
      <View style={styles.accountHeader}>
        <View style={[styles.accountBadge, { backgroundColor: c.ok + "1f" }]}>
          <IconSymbol name="checkmark.circle.fill" size={20} color={c.ok} />
        </View>
        <View style={styles.flexMin}>
          <Text style={[styles.metaCaption, { color: c.text3 }]}>已登录</Text>
          <Text style={[styles.accountEmail, { color: c.text }]} numberOfLines={1}>
            {email}
          </Text>
        </View>
      </View>
      {accountId ? (
        <Text style={[styles.metaLine, { color: c.text3 }]} numberOfLines={1}>
          {`账户 ID：${accountId}`}
        </Text>
      ) : null}
      {plan ? (
        <Text style={[styles.metaLine, { color: c.text3 }]} numberOfLines={1}>
          {`套餐：${plan}`}
        </Text>
      ) : null}
      <Button
        label="保险库同步"
        icon="arrow.clockwise"
        size="lg"
        fullWidth
        onPress={() => router.push("/cloud-sync" as never)}
      />
      <LinkButton
        label="清空云端数据"
        tone="danger"
        onPress={() => setClearVisible(true)}
      />
      <LinkButton label="退出云账户" tone="danger" onPress={handleLogout} />
    </Card>
  );

  const mfaCard = (
    <Card>
      <View style={styles.cardHeader}>
        <IconSymbol name="key.fill" size={18} color={c.info} />
        <Text style={[styles.cardTitle, { color: c.text }]}>二次验证</Text>
      </View>
      <Text style={[styles.cardDesc, { color: c.text3 }]}>
        该账户已开启 TOTP 二次验证，请输入身份验证器中的 6 位验证码。
      </Text>
      <FormField
        label="验证码"
        value={mfaCode}
        onChangeText={setMfaCode}
        placeholder="6 位数字"
        keyboardType="number-pad"
        maxLength={6}
        editable={!busy}
      />
      <Button
        label={busy ? "验证中…" : "验证"}
        size="lg"
        fullWidth
        disabled={busy}
        onPress={handleCompleteMfa}
      />
      <LinkButton label="取消" onPress={handleCancelMfa} />
    </Card>
  );

  const restoreCard = (
    <Card>
      <View style={styles.cardHeader}>
        <IconSymbol name="person.fill" size={18} color={c.text2} />
        <Text style={[styles.accountEmail, { color: c.text, flex: 1 }]} numberOfLines={1}>
          {email}
        </Text>
      </View>
      <Text style={[styles.cardDesc, { color: c.text3 }]}>
        输入云账户主密码恢复云会话（可能与本机解锁密码不同）。首次输入后会安全保存，之后解锁本地保险库（含生物识别）将自动恢复，无需再输入。
      </Text>
      <FormField
        label="云账户主密码"
        value={passwordInput}
        onChangeText={setPasswordInput}
        placeholder="云账户主密码"
        secure
        editable={!busy}
      />
      <Button
        label={busy ? "处理中…" : "恢复云会话"}
        size="lg"
        fullWidth
        disabled={busy}
        onPress={handleRestore}
      />
      <LinkButton label="退出云账户" tone="danger" onPress={handleLogout} />
    </Card>
  );

  const authCard = (
    <Card>
      <View style={[styles.segment, { backgroundColor: c.bg }]}>
        {(["login", "register"] as const).map((m) => {
          const active = mode === m;
          return (
            <Pressable
              key={m}
              disabled={busy}
              onPress={() => setMode(m)}
              style={[styles.segItem, active && { backgroundColor: c.accent }]}
            >
              <Text
                style={[
                  styles.segText,
                  {
                    color: active ? c.accentInk : c.text2,
                    fontWeight: active ? "700" : "400",
                  },
                ]}
              >
                {m === "login" ? "登录" : "注册"}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <FormField
        label="邮箱"
        value={emailInput}
        onChangeText={setEmailInput}
        placeholder="you@example.com"
        keyboardType="email-address"
        editable={!busy}
      />
      <FormField
        label="主密码"
        value={passwordInput}
        onChangeText={setPasswordInput}
        placeholder={mode === "register" ? "至少 8 位" : "主密码"}
        secure
        editable={!busy}
      />
      {mode === "login" ? (
        <FormField
          label="Secret Key"
          value={secretKeyInput}
          onChangeText={setSecretKeyInput}
          placeholder="Z1-XXXXXX-…"
          keyboardType="default"
          editable={!busy}
        />
      ) : null}
      {mode === "register" ? (
        <>
          <Text style={[styles.cardDesc, { color: c.text3 }]}>
            注册将生成你的 Secret Key —— 它与主密码共同保护数据，丢失无法找回，请务必备份。
          </Text>
          <Button
            label={busy ? "处理中…" : "注册新账户"}
            size="lg"
            fullWidth
            disabled={busy}
            onPress={handleRegister}
          />
        </>
      ) : (
        <Button
          label={busy ? "处理中…" : "登录"}
          size="lg"
          fullWidth
          disabled={busy}
          onPress={handleLogin}
        />
      )}
    </Card>
  );

  const exclusiveCard = !configured
    ? serverCard
    : signedIn
      ? accountCard
      : mfaRequired
        ? mfaCard
        : hasAccount
          ? restoreCard
          : authCard;

  return (
    <SettingsPage title="云账户">
      <View style={styles.root}>
        <View style={styles.hero}>
          <View style={[styles.heroIcon, { backgroundColor: c.info + "1f" }]}>
            <IconSymbol name="globe" size={26} color={c.info} />
          </View>
          <Text style={[styles.heroTitle, { color: c.text }]}>云同步账户</Text>
          <Text style={[styles.heroSub, { color: c.text3 }]}>
            零知识端到端加密：主密码与 Secret Key 永不离开本机，服务器只存密文
          </Text>
        </View>

        {__DEV__ ? devServerCard : null}
        {secretKeyBackup ? secretKeyCard : null}
        {exclusiveCard}
      </View>

      <SheetModal
        visible={clearVisible}
        onClose={closeClearModal}
        title="清空云端数据"
        subtitle="将永久删除云端所有保险库数据，无法找回（本地保险库不受影响）。请输入主密码与 Secret Key 确认。"
      >
        <FormField
          label="主密码"
          value={clearMp}
          onChangeText={setClearMp}
          placeholder="主密码"
          secure
          editable={!clearBusy}
        />
        <FormField
          label="Secret Key"
          value={clearSk}
          onChangeText={setClearSk}
          placeholder="Z1-XXXXXX-…"
          keyboardType="default"
          editable={!clearBusy}
        />
        {clearError ? <SheetErrorBox message={clearError} /> : null}
        <View style={sheetStyles.actions}>
          <Button
            label="取消"
            variant="secondary"
            style={styles.flex1}
            disabled={clearBusy}
            onPress={closeClearModal}
          />
          <Button
            label={clearBusy ? "清空中…" : "确认清空"}
            variant="danger"
            style={styles.flex1}
            disabled={clearBusy}
            onPress={handleClearCloud}
          />
        </View>
      </SheetModal>
    </SettingsPage>
  );
}

/* -------------------------------------------------------------------------- */
/* 小组件                                                                      */
/* -------------------------------------------------------------------------- */

function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: c.bgElev }, style]}>
      {children}
    </View>
  );
}

function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  keyboardType,
  maxLength,
  editable = true,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: "default" | "email-address" | "number-pad";
  maxLength?: number;
  editable?: boolean;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: c.text3 }]}>{label}</Text>
      <RawTextInput
        style={[styles.fieldInput, { color: c.text, backgroundColor: c.bg }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.text4}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        maxLength={maxLength}
        editable={editable}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function LinkButton({
  label,
  onPress,
  tone = "default",
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
}) {
  const { colors: c } = useTheme();
  const color = tone === "danger" ? c.danger : c.accent;
  return (
    <Pressable onPress={onPress} disabled={disabled} style={styles.link}>
      <Text style={[styles.linkText, { color, opacity: disabled ? 0.4 : 1 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
  hero: {
    alignItems: "center",
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xs,
    gap: Spacing.xs,
  },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.xl,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.xs,
  },
  heroTitle: { ...Type.title2 },
  heroSub: {
    ...Type.footnote,
    textAlign: "center",
    lineHeight: 18,
    paddingHorizontal: Spacing.md,
  },
  card: { borderRadius: Radius.xl, padding: Spacing.lg, gap: Spacing.md },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
  cardTitle: { ...Type.bodyEmph },
  cardDesc: { ...Type.footnote, lineHeight: 18 },
  field: { gap: 6 },
  fieldLabel: { ...Type.footnote },
  fieldInput: {
    height: 46,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    ...Type.body,
  },
  segment: { flexDirection: "row", borderRadius: Radius.md, padding: 3, gap: 4 },
  segItem: {
    flex: 1,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  segText: { ...Type.subhead },
  secretKey: {
    ...Type.body,
    fontFamily: MONO,
    textAlign: "center",
    borderRadius: Radius.lg,
    padding: Spacing.md,
    letterSpacing: 0.5,
  },
  accountHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  accountBadge: {
    width: 40,
    height: 40,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  accountEmail: { ...Type.bodyEmph },
  metaCaption: { ...Type.footnote },
  metaLine: { ...Type.caption },
  row: { flexDirection: "row", gap: Spacing.sm },
  flex1: { flex: 1 },
  flexMin: { flex: 1, minWidth: 0 },
  link: { alignItems: "center", paddingVertical: Spacing.xs },
  linkText: { ...Type.subhead },
});
