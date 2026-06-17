// 首次进入：两步引导 —— iOS HIG 风格重构
//
// 1. 设主密码（派生 KEK / 生成 DEK / 写 vault meta）
// 2. 给"默认空间"取个用户自己的名字
//
// 实现要点：整流程在内部用 step state 控制，**不在第 1 步立刻 initialize**。
// 第 1 步只暂存密码到组件内存，等用户在第 2 步点"创建保险库"才一次性
// initialize(pw) → renameSpace(DEFAULT_SPACE_ID, name)，这样 KDF 的等待发生在最后。

import React, { useState } from "react";
import {
  View,
  Pressable,
  Text,
  TextInput,
  StyleSheet,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Fonts, Radius, Spacing, Type } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { useVault } from "@/contexts/vault-context";
import { useCloud } from "@/contexts/cloud-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SpaceAvatar } from "@/components/space-avatar";
import { isNativeKDF, isWasmKDF } from "@/lib/crypto";
import { DEFAULT_SPACE_ID } from "@/lib/spaces";
import { DEFAULT_CLOUD_BASE_URL, LOCAL_CLOUD_BASE_URL } from "@/lib/cloud-service";
import { Button, IconButton, PressableScale } from "@/components/ui/primitives";
import { copyText } from "@/lib/clipboard";
import type { ColorPalette } from "@/constants/theme";

const MONO = Fonts?.mono ?? "monospace";

type Step = "mode" | "password" | "space" | "cloud";

export function OnboardingOverlay() {
  const { colors: c } = useTheme();
  const { initialize, renameSpace } = useVault();
  const {
    register: cloudRegister,
    signIn: cloudSignIn,
    markFreshLocalVault,
    persistAutoUnlockCredential,
    syncNow,
    configure,
    baseUrl,
  } = useCloud();

  const [step, setStep] = useState<Step>("mode");

  // 本地模式：设主密码 + 命名默认空间
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [spaceName, setSpaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 云账户：登录 / 注册
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [cloudPw, setCloudPw] = useState("");
  const [secretKeyInput, setSecretKeyInput] = useState("");
  const [generatedSk, setGeneratedSk] = useState<string | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canNext = pw.length >= 8 && pw === confirm && !busy;

  const trimmedSpace = spaceName.trim();
  const canSubmit =
    trimmedSpace.length > 0 && trimmedSpace.length <= 32 && !busy;

  const handleNext = () => {
    if (!canNext) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(
        pw.length < 8
          ? "主密码至少 8 位"
          : pw !== confirm
            ? "两次输入不一致"
            : null,
      );
      return;
    }
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStep("space");
  };

  const handleBack = () => {
    setError(null);
    setStep("password");
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError("空间名不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const init = await initialize(pw);
    if (!init.ok) {
      setBusy(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(init.message || "初始化失败");
      return;
    }
    const rn = await renameSpace(DEFAULT_SPACE_ID, trimmedSpace);
    setBusy(false);
    if (!rn.ok) {
      console.warn("[onboarding] rename default space failed:", rn.message);
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setPw("");
    setConfirm("");
    setSpaceName("");
  };

  // 云优先首登：用同一主密码创建本地保险库（占位默认空间，对账下拉云端空间后清除）。
  const ensureLocalVault = async (password: string): Promise<void> => {
    const r = await initialize(password);
    if (!r.ok) throw new Error(r.message || "本地保险库创建失败");
    markFreshLocalVault();
  };

  // 云会话已建立 → 建本地库 + 补封装自动解锁凭据 + 后台对账同步。建库后本组件即卸载。
  const finishCloud = async (password: string): Promise<void> => {
    await ensureLocalVault(password);
    persistAutoUnlockCredential(password);
    void syncNow();
  };

  const handleCloudSubmit = async () => {
    const em = email.trim().toLowerCase();
    if (!em || !em.includes("@")) {
      setCloudError("请输入有效的邮箱地址");
      return;
    }
    if (cloudPw.length < 8) {
      setCloudError("主密码至少 8 位");
      return;
    }
    if (authMode === "login" && !secretKeyInput.trim()) {
      setCloudError("请输入 Secret Key");
      return;
    }
    setCloudBusy(true);
    setCloudError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      if (authMode === "register") {
        const sk = await cloudRegister(em, cloudPw);
        setGeneratedSk(sk); // 进入备份视图：本地库尚未创建，覆盖层保持显示
        setCloudBusy(false);
        return;
      }
      await cloudSignIn(em, cloudPw, secretKeyInput.trim());
      await finishCloud(cloudPw); // 建库后组件卸载，后续不再 setState
    } catch (e) {
      setCloudBusy(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setCloudError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleBackupDone = async () => {
    setCloudBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await finishCloud(cloudPw); // 卸载
    } catch (e) {
      setCloudBusy(false);
      setCloudError(e instanceof Error ? e.message : String(e));
    }
  };

  /* ---------------------- 使用方式选择（默认入口）---------------------- */
  if (step === "mode") {
    return (
      <View style={[styles.root, { backgroundColor: c.bg }]}>
        <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.logoWrap}>
              <View style={[styles.logo, { backgroundColor: c.accent }]}>
                <Text style={[styles.logoText, { color: c.accentInk }]}>Z</Text>
              </View>
            </View>
            <Text style={[styles.title, { color: c.text }]}>欢迎使用 ZPass</Text>
            <Text style={[styles.sub, { color: c.text3 }]}>
              选择使用方式，随时可在「我的」里切换
            </Text>

            <PressableScale
              style={[styles.modeCard, { backgroundColor: c.bgElev }]}
              onPress={() => {
                setCloudError(null);
                setStep("cloud");
              }}
            >
              <View
                style={[styles.modeIcon, { backgroundColor: c.accent + "1f" }]}
              >
                <IconSymbol name="cloud.fill" size={22} color={c.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.modeTitle, { color: c.text }]}>
                  登录云账户
                </Text>
                <Text style={[styles.modeSub, { color: c.text3 }]}>
                  跨设备端到端加密同步，主密码与 Secret Key 永不离开本机
                </Text>
              </View>
              <IconSymbol name="chevron.right" size={16} color={c.text4} />
            </PressableScale>

            <View style={{ height: Spacing.md }} />

            <PressableScale
              style={[styles.modeCard, { backgroundColor: c.bgElev }]}
              onPress={() => {
                setError(null);
                setStep("password");
              }}
            >
              <View style={[styles.modeIcon, { backgroundColor: c.ok + "1f" }]}>
                <IconSymbol name="lock.shield.fill" size={22} color={c.ok} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.modeTitle, { color: c.text }]}>
                  仅本地模式
                </Text>
                <Text style={[styles.modeSub, { color: c.text3 }]}>
                  数据只保存在本设备，不上传云端
                </Text>
              </View>
              <IconSymbol name="chevron.right" size={16} color={c.text4} />
            </PressableScale>
          </ScrollView>
        </SafeAreaView>
      </View>
    );
  }

  /* ---------------------- 云账户：登录 / 注册 / 备份 ---------------------- */
  if (step === "cloud") {
    const showBackup = generatedSk !== null;
    return (
      <View style={[styles.root, { backgroundColor: c.bg }]}>
        <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={{ flex: 1 }}
          >
            <ScrollView
              contentContainerStyle={styles.scroll}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.logoWrap}>
                <View style={[styles.logo, { backgroundColor: c.accent }]}>
                  <IconSymbol name="cloud.fill" size={30} color={c.accentInk} />
                </View>
              </View>
              <Text style={[styles.title, { color: c.text }]}>
                {showBackup ? "请备份 Secret Key" : "云同步账户"}
              </Text>
              <Text style={[styles.sub, { color: c.text3 }]}>
                {showBackup
                  ? "这是恢复账户的唯一凭据，仅显示这一次。请离线保存，丢失将无法在新设备登录。"
                  : "零知识端到端加密：主密码与 Secret Key 永不离开本机"}
              </Text>

              <View style={[styles.card, { backgroundColor: c.bgElev }]}>
                {showBackup ? (
                  <>
                    <View style={[styles.skBox, { backgroundColor: c.bg }]}>
                      <Text
                        style={[styles.skText, { color: c.text }]}
                        selectable
                      >
                        {generatedSk}
                      </Text>
                    </View>
                    <Button
                      label="复制 Secret Key"
                      icon="doc.on.doc.fill"
                      variant="secondary"
                      size="md"
                      fullWidth
                      onPress={() => {
                        void copyText(generatedSk ?? "");
                      }}
                    />
                    <View
                      style={[styles.points, { borderTopColor: c.lineSoft }]}
                    >
                      {[
                        "请离线保存到密码管理器之外的安全位置",
                        "服务器只存密文，无法帮你找回",
                        "新设备登录需要邮箱 + 主密码 + 此 Secret Key",
                      ].map((p) => (
                        <View key={p} style={styles.pointRow}>
                          <View
                            style={[
                              styles.pointIcon,
                              { backgroundColor: c.warn + "1f" },
                            ]}
                          >
                            <IconSymbol
                              name="exclamationmark.circle.fill"
                              size={11}
                              color={c.warn}
                            />
                          </View>
                          <Text style={[styles.pointText, { color: c.text2 }]}>
                            {p}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </>
                ) : (
                  <>
                    {__DEV__ ? (
                      <View style={styles.devBox}>
                        <View style={styles.devRow}>
                          <Text style={[styles.devLabel, { color: c.text3 }]}>
                            服务器（开发）
                          </Text>
                          <Pressable
                            style={[
                              styles.devChip,
                              {
                                backgroundColor:
                                  baseUrl === LOCAL_CLOUD_BASE_URL
                                    ? c.accent
                                    : c.bg,
                              },
                            ]}
                            onPress={() => configure(LOCAL_CLOUD_BASE_URL)}
                          >
                            <Text
                              style={[
                                Type.caption,
                                {
                                  color:
                                    baseUrl === LOCAL_CLOUD_BASE_URL
                                      ? c.accentInk
                                      : c.text3,
                                },
                              ]}
                            >
                              本地
                            </Text>
                          </Pressable>
                          <Pressable
                            style={[
                              styles.devChip,
                              {
                                backgroundColor:
                                  baseUrl === DEFAULT_CLOUD_BASE_URL
                                    ? c.accent
                                    : c.bg,
                              },
                            ]}
                            onPress={() => configure(DEFAULT_CLOUD_BASE_URL)}
                          >
                            <Text
                              style={[
                                Type.caption,
                                {
                                  color:
                                    baseUrl === DEFAULT_CLOUD_BASE_URL
                                      ? c.accentInk
                                      : c.text3,
                                },
                              ]}
                            >
                              线上
                            </Text>
                          </Pressable>
                        </View>
                        <Text
                          style={[styles.devUrl, { color: c.text4 }]}
                          numberOfLines={1}
                        >
                          {baseUrl}
                        </Text>
                      </View>
                    ) : null}
                    <View style={[styles.segment, { backgroundColor: c.bg }]}>
                      <Pressable
                        style={[
                          styles.segmentBtn,
                          authMode === "login" && { backgroundColor: c.bgElev },
                        ]}
                        onPress={() => {
                          setAuthMode("login");
                          setCloudError(null);
                        }}
                      >
                        <Text
                          style={[
                            Type.subhead,
                            {
                              color: authMode === "login" ? c.text : c.text3,
                              fontWeight: "600",
                            },
                          ]}
                        >
                          登录
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[
                          styles.segmentBtn,
                          authMode === "register" && {
                            backgroundColor: c.bgElev,
                          },
                        ]}
                        onPress={() => {
                          setAuthMode("register");
                          setCloudError(null);
                        }}
                      >
                        <Text
                          style={[
                            Type.subhead,
                            {
                              color: authMode === "register" ? c.text : c.text3,
                              fontWeight: "600",
                            },
                          ]}
                        >
                          注册
                        </Text>
                      </Pressable>
                    </View>

                    <FieldLabel label="邮箱" c={c} />
                    <View style={[styles.inputBox, { backgroundColor: c.bg }]}>
                      <IconSymbol
                        name="envelope.fill"
                        size={16}
                        color={c.text3}
                      />
                      <TextInput
                        style={[styles.input, { color: c.text }]}
                        value={email}
                        onChangeText={(v) => {
                          setEmail(v);
                          setCloudError(null);
                        }}
                        placeholder="you@example.com"
                        placeholderTextColor={c.text3}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="email-address"
                        inputMode="email"
                      />
                    </View>

                    <View style={{ height: Spacing.md }} />
                    <FieldLabel label="云账户主密码" hint="至少 8 位字符" c={c} />
                    <PasswordInput
                      value={cloudPw}
                      onChangeText={(v) => {
                        setCloudPw(v);
                        setCloudError(null);
                      }}
                      placeholder="云账户主密码"
                      error={cloudPw.length > 0 && cloudPw.length < 8}
                      c={c}
                    />

                    {authMode === "login" ? (
                      <>
                        <View style={{ height: Spacing.md }} />
                        <FieldLabel label="Secret Key" c={c} />
                        <View
                          style={[styles.inputBox, { backgroundColor: c.bg }]}
                        >
                          <IconSymbol
                            name="key.fill"
                            size={16}
                            color={c.text3}
                          />
                          <TextInput
                            style={[
                              styles.input,
                              { color: c.text, fontFamily: MONO },
                            ]}
                            value={secretKeyInput}
                            onChangeText={(v) => {
                              setSecretKeyInput(v);
                              setCloudError(null);
                            }}
                            placeholder="Z1-XXXXXX-…"
                            placeholderTextColor={c.text3}
                            autoCapitalize="characters"
                            autoCorrect={false}
                          />
                        </View>
                      </>
                    ) : null}

                    {cloudError ? (
                      <View
                        style={[
                          styles.errorBox,
                          { backgroundColor: c.danger + "1f" },
                        ]}
                      >
                        <IconSymbol
                          name="exclamationmark.circle.fill"
                          size={14}
                          color={c.danger}
                        />
                        <Text style={[styles.errorText, { color: c.danger }]}>
                          {cloudError}
                        </Text>
                      </View>
                    ) : null}
                  </>
                )}
              </View>
            </ScrollView>

            <View style={styles.footer}>
              {showBackup ? (
                <Button
                  label={cloudBusy ? "创建中…" : "我已备份，进入"}
                  iconRight={cloudBusy ? undefined : "checkmark"}
                  variant="primary"
                  size="lg"
                  fullWidth
                  disabled={cloudBusy}
                  onPress={handleBackupDone}
                />
              ) : (
                <View style={styles.footerRow}>
                  <Button
                    label="返回"
                    icon="arrow.left"
                    variant="secondary"
                    size="lg"
                    onPress={() => {
                      setCloudError(null);
                      setStep("mode");
                    }}
                    disabled={cloudBusy}
                  />
                  <Button
                    label={
                      cloudBusy
                        ? "处理中…"
                        : authMode === "register"
                          ? "注册并同步"
                          : "登录并同步"
                    }
                    variant="primary"
                    size="lg"
                    onPress={handleCloudSubmit}
                    disabled={cloudBusy}
                    style={{ flex: 1 }}
                    fullWidth
                  />
                </View>
              )}
              <Text style={[styles.footerHint, { color: c.text4 }]}>
                {showBackup
                  ? "进入后可在「我的 → 云同步」再次管理账户"
                  : "也可先用本地模式，之后在「我的 → 云同步」登录"}
              </Text>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </View>
    );
  }

  /* ---------------------- 本地模式：设主密码 + 命名空间 ---------------------- */
  const isPasswordStep = step === "password";

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* 顶部 logo + 步骤指示器 */}
            <View style={styles.logoWrap}>
              {isPasswordStep ? (
                <View style={[styles.logo, { backgroundColor: c.accent }]}>
                  <Text style={[styles.logoText, { color: c.accentInk }]}>
                    Z
                  </Text>
                </View>
              ) : (
                <SpaceAvatar
                  space={{ name: trimmedSpace }}
                  size={64}
                  background={c.accent}
                  foreground={c.accentInk}
                  fontSize={28}
                  borderRadius={16}
                />
              )}
            </View>

            <Text style={[styles.title, { color: c.text }]}>
              {isPasswordStep ? "设置主密码" : "为空间取个名字"}
            </Text>
            <Text style={[styles.sub, { color: c.text3 }]}>
              {isPasswordStep
                ? "设置主密码以加密你的保险库"
                : "头像首字符会跟随名字"}
            </Text>

            {/* 步骤指示器 */}
            <View style={styles.steps}>
              <View style={[styles.stepDot, { backgroundColor: c.accent }]} />
              <View
                style={[
                  styles.stepLine,
                  {
                    backgroundColor: step === "space" ? c.accent : c.bgActive,
                  },
                ]}
              />
              <View
                style={[
                  styles.stepDot,
                  {
                    backgroundColor: step === "space" ? c.accent : c.bgActive,
                  },
                ]}
              />
            </View>

            <View style={[styles.card, { backgroundColor: c.bgElev }]}>
              {isPasswordStep ? (
                <>
                  <FieldLabel label="主密码" hint="至少 8 位字符" c={c} />
                  <PasswordInput
                    value={pw}
                    onChangeText={(v) => {
                      setPw(v);
                      setError(null);
                    }}
                    placeholder="主密码"
                    error={tooShort}
                    c={c}
                    autoFocus
                  />

                  <View style={{ height: Spacing.md }} />
                  <FieldLabel label="确认主密码" c={c} />
                  <PasswordInput
                    value={confirm}
                    onChangeText={(v) => {
                      setConfirm(v);
                      setError(null);
                    }}
                    placeholder="再次输入"
                    error={mismatch}
                    c={c}
                    onSubmitEditing={handleNext}
                  />

                  {error ? (
                    <View
                      style={[
                        styles.errorBox,
                        { backgroundColor: c.danger + "1f" },
                      ]}
                    >
                      <IconSymbol
                        name="exclamationmark.circle.fill"
                        size={14}
                        color={c.danger}
                      />
                      <Text style={[styles.errorText, { color: c.danger }]}>
                        {error}
                      </Text>
                    </View>
                  ) : null}

                  <View style={[styles.points, { borderTopColor: c.lineSoft }]}>
                    {[
                      "数据仅保存在本设备",
                      "Argon2id 派生主密码 → XChaCha20-Poly1305 加密",
                      "主密码一旦丢失将无法恢复",
                    ].map((p) => (
                      <View key={p} style={styles.pointRow}>
                        <View
                          style={[
                            styles.pointIcon,
                            { backgroundColor: c.ok + "1f" },
                          ]}
                        >
                          <IconSymbol name="checkmark" size={11} color={c.ok} />
                        </View>
                        <Text style={[styles.pointText, { color: c.text2 }]}>
                          {p}
                        </Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : (
                <>
                  <FieldLabel
                    label="空间名"
                    hint="个人 / 工作 / 家庭 …"
                    c={c}
                  />
                  <View style={[styles.inputBox, { backgroundColor: c.bg }]}>
                    <IconSymbol name="tag.fill" size={16} color={c.text3} />
                    <TextInput
                      style={[styles.input, { color: c.text }]}
                      value={spaceName}
                      onChangeText={(v) => {
                        setSpaceName(v);
                        setError(null);
                      }}
                      placeholder="为这个空间取个名字"
                      placeholderTextColor={c.text3}
                      autoFocus
                      autoCorrect={false}
                      autoCapitalize="none"
                      maxLength={32}
                      onSubmitEditing={handleSubmit}
                      returnKeyType="go"
                    />
                  </View>

                  {error ? (
                    <View
                      style={[
                        styles.errorBox,
                        { backgroundColor: c.danger + "1f" },
                      ]}
                    >
                      <IconSymbol
                        name="exclamationmark.circle.fill"
                        size={14}
                        color={c.danger}
                      />
                      <Text style={[styles.errorText, { color: c.danger }]}>
                        {error}
                      </Text>
                    </View>
                  ) : null}

                  <View style={[styles.points, { borderTopColor: c.lineSoft }]}>
                    <Text style={[styles.conceptText, { color: c.text2 }]}>
                      空间是 ZPass 里的顶层隔离容器，类似不同账号。每个空间
                      独立存放条目，可随时新建、切换、重命名。
                    </Text>
                  </View>
                </>
              )}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            {isPasswordStep ? (
              <>
                <View style={styles.footerRow}>
                  <Button
                    label="返回"
                    icon="arrow.left"
                    variant="secondary"
                    size="lg"
                    onPress={() => {
                      setError(null);
                      setStep("mode");
                    }}
                    disabled={busy}
                  />
                  <Button
                    label="下一步"
                    iconRight="arrow.right"
                    variant="primary"
                    size="lg"
                    onPress={handleNext}
                    disabled={!canNext}
                    style={{ flex: 1 }}
                    fullWidth
                  />
                </View>
                <Text
                  style={[
                    styles.footerHint,
                    { color: c.text4, fontFamily: MONO },
                  ]}
                >
                  {isNativeKDF()
                    ? "原生 Go 加速 · 派生约 0.3 秒"
                    : isWasmKDF()
                      ? "WASM 加速 · 派生大约 0.5 秒"
                      : "纯 JS 派生 · 约 3-6 秒"}
                </Text>
              </>
            ) : (
              <>
                <View style={styles.footerRow}>
                  <Button
                    label="返回"
                    icon="arrow.left"
                    variant="secondary"
                    size="lg"
                    onPress={handleBack}
                    disabled={busy}
                  />
                  <Button
                    label={busy ? "创建中" : "创建保险库"}
                    iconRight={busy ? undefined : "checkmark"}
                    variant="primary"
                    size="lg"
                    onPress={handleSubmit}
                    disabled={!canSubmit}
                    style={{ flex: 1 }}
                    fullWidth
                  />
                </View>
                <Text style={[styles.footerHint, { color: c.text4 }]}>
                  创建后随时可在「我的 → 空间」里重命名
                </Text>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/* ----- 复用控件 ----- */

function FieldLabel({
  label,
  hint,
  c,
}: {
  label: string;
  hint?: string;
  c: ColorPalette;
}) {
  return (
    <View style={styles.labelRow}>
      <Text style={[styles.label, { color: c.text3 }]}>{label}</Text>
      {hint ? (
        <Text style={[styles.labelHint, { color: c.text4, fontFamily: MONO }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function PasswordInput({
  value,
  onChangeText,
  placeholder,
  error,
  c,
  onSubmitEditing,
  autoFocus,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  error?: boolean;
  c: ColorPalette;
  onSubmitEditing?: () => void;
  autoFocus?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <View
      style={[
        styles.inputBox,
        {
          backgroundColor: c.bg,
          borderWidth: error ? 1 : 0,
          borderColor: c.danger,
        },
      ]}
    >
      <IconSymbol name="lock.fill" size={16} color={c.text3} />
      <TextInput
        style={[styles.input, { color: c.text }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.text3}
        secureTextEntry={!revealed}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="go"
      />
      <IconButton
        icon={revealed ? "eye.slash.fill" : "eye.fill"}
        size={30}
        iconSize={14}
        variant="ghost"
        haptic="selection"
        onPress={() => setRevealed((v) => !v)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 1000 },
  scroll: {
    paddingHorizontal: Spacing.xl + 4,
    paddingTop: Spacing.lg,
    alignItems: "center",
  },

  logoWrap: { marginTop: Spacing.lg, marginBottom: Spacing.lg },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontSize: 32, fontWeight: "700" },
  title: { ...Type.title },
  sub: {
    ...Type.footnote,
    marginTop: 4,
    marginBottom: Spacing.lg,
    textAlign: "center",
  },

  steps: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: Spacing.xl,
  },
  stepDot: { width: 8, height: 8, borderRadius: 4 },
  stepLine: { width: 32, height: 2, borderRadius: 1 },

  card: {
    width: "100%",
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    gap: 6,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: Spacing.xs,
  },
  label: {
    ...Type.footnote,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  labelHint: { ...Type.caption },

  inputBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    height: 48,
    borderRadius: Radius.lg,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs,
  },
  input: { flex: 1, ...Type.body, padding: 0 },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    marginTop: Spacing.sm,
  },
  errorText: { ...Type.footnote, flex: 1 },

  points: {
    marginTop: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.sm,
  },
  pointRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  pointIcon: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  pointText: { ...Type.subhead, flex: 1 },
  conceptText: { ...Type.subhead, lineHeight: 20 },

  footer: {
    paddingHorizontal: Spacing.xl + 4,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  footerRow: { flexDirection: "row", gap: Spacing.sm, alignItems: "center" },
  footerHint: { ...Type.caption, textAlign: "center" },
  modeCard: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
  },
  modeIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modeTitle: { ...Type.body, fontWeight: "600" },
  modeSub: { ...Type.footnote, marginTop: 2 },
  segment: {
    flexDirection: "row",
    borderRadius: Radius.lg,
    padding: 3,
    marginBottom: Spacing.md,
  },
  segmentBtn: {
    flex: 1,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radius.md,
  },
  skBox: {
    width: "100%",
    borderRadius: Radius.lg,
    padding: Spacing.md,
  },
  skText: { ...Type.body, fontFamily: MONO, letterSpacing: 1 },
  devBox: { marginBottom: Spacing.md, gap: 6 },
  devRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
  devLabel: { ...Type.caption, flex: 1 },
  devChip: {
    paddingHorizontal: Spacing.md,
    height: 30,
    minWidth: 56,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  devUrl: { ...Type.caption },
});
