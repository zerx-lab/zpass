// QrScanner —— phone 端「TOTP 二维码扫描 / 导入」面板
//
// 设计目标：
//   1. 三种输入并存（用户自由选择，不强迫一种）：
//      - 相机实时扫码：expo-camera CameraView + onBarCodeScanned
//      - 从相册选图  ：expo-image-picker 选图 → CameraView.scanFromURLAsync
//                       静态方法在 Go 之外做 QR 解码
//      - 粘贴 otpauth:// URL：纯文本输入框
//   2. 解码后必须二次确认（防钓鱼）：把 issuer / account / 算法 / 周期
//      等元信息全部展示出来，让用户判断这是不是自己想要的二维码，
//      再点「使用此密钥」才真正回填字段。
//   3. 安全 / 隐私：
//      - 扫码过程不联网、不上报；解码结果只走 onApply 回调
//      - 关闭面板时主动 setState 让 secret 字符串尽快被 GC
//
// 与 desktop QrScannerPanel.tsx 行为基本对齐 —— 同一份 parseOtpauth
// 解析逻辑，同样的失败态分支。
//
// 失败态：
//   - 相机权限未授予            → 提示 + 跳系统设置入口
//   - 选图为非图片              → toast 警告
//   - 图片中没有 QR             → "未识别到二维码"
//   - 找到 QR 但不是 otpauth    → "这不是身份验证器二维码" + 显示前 80 字符
//   - 文本非 otpauth://         → 提示用户检查

import {
  CameraView,
  scanFromURLAsync,
  useCameraPermissions,
  type BarcodeScanningResult,
} from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Fonts, Radius, Spacing, Type, type Palette } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";
import {
  Badge,
  Button,
  Chip,
  PressableScale,
} from "@/components/ui/primitives";
import {
  formatBase32Groups,
  parseOtpauth,
  type OtpMeta,
  type OtpParseError,
} from "@/lib/totp";

const MONO = Fonts?.mono ?? "monospace";

/* ----------------------------------------------------------------------------
 * 状态机
 * -------------------------------------------------------------------------- */

type Mode = "camera" | "pick" | "paste";

type PanelState =
  | { kind: "idle" }
  | { kind: "decoding" }
  | { kind: "ok"; meta: OtpMeta; raw: string }
  | { kind: "bad"; error: OtpParseError | "no-qr"; rawText?: string };

export interface QrScannerProps {
  visible: boolean;
  onClose: () => void;
  /** 用户在结果预览页点「使用此密钥」后回调；uri 是规范化的 otpauth:// URI */
  onApply: (uri: string, meta: OtpMeta) => void;
}

/* ----------------------------------------------------------------------------
 * 主组件
 * -------------------------------------------------------------------------- */

export function QrScanner({ visible, onClose, onApply }: QrScannerProps) {
  const { colors: c } = useTheme();

  const [mode, setMode] = useState<Mode>("camera");
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [pasted, setPasted] = useState("");
  const [revealSecret, setRevealSecret] = useState(false);

  const [permission, requestPermission] = useCameraPermissions();
  const scannedOnceRef = useRef(false);

  // 关闭面板时彻底重置内部状态，避免下次打开残留上次结果
  useEffect(() => {
    if (!visible) {
      setState({ kind: "idle" });
      setPasted("");
      setRevealSecret(false);
      scannedOnceRef.current = false;
    }
  }, [visible]);

  // 切换 mode 时也回到 idle（避免在结果页切换模式后状态混乱）
  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    setState({ kind: "idle" });
    setRevealSecret(false);
    scannedOnceRef.current = false;
  }, []);

  /* ── 解码：把任意"识别得到的字符串"统一过 parseOtpauth ───────── */
  const acceptScanned = useCallback((text: string) => {
    if (scannedOnceRef.current) return;
    scannedOnceRef.current = true;
    const parsed = parseOtpauth(text);
    if (parsed.ok && parsed.meta) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setState({ kind: "ok", meta: parsed.meta, raw: parsed.raw });
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setState({
        kind: "bad",
        error: parsed.error ?? "not-otpauth",
        rawText: text.slice(0, 80),
      });
    }
  }, []);

  /* ── 入口 1：相机实时扫码 ────────────────────────────────────── */
  const handleBarcode = useCallback(
    (result: BarcodeScanningResult) => {
      if (!result?.data) return;
      acceptScanned(result.data);
    },
    [acceptScanned],
  );

  /* ── 入口 2：从相册选图 → scanFromURLAsync 解码 ─────────────── */
  const handlePickImage = useCallback(async () => {
    try {
      const granted = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!granted.granted) {
        setState({ kind: "bad", error: "no-qr" });
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        // expo-image-picker v17：MediaTypeOptions 已弃用，使用字符串数组
        mediaTypes: ["images"],
        quality: 1,
        allowsMultipleSelection: false,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      setState({ kind: "decoding" });
      try {
        const found = await scanFromURLAsync(res.assets[0].uri, ["qr"]);
        const text = found?.[0]?.data ?? "";
        if (!text) {
          setState({ kind: "bad", error: "no-qr" });
          return;
        }
        scannedOnceRef.current = false; // 走主解析流程
        acceptScanned(text);
      } catch {
        setState({ kind: "bad", error: "no-qr" });
      }
    } catch {
      setState({ kind: "bad", error: "no-qr" });
    }
  }, [acceptScanned]);

  /* ── 入口 3：粘贴 otpauth:// URI ────────────────────────────── */
  const handlePasteSubmit = useCallback(() => {
    const text = pasted.trim();
    if (!text) return;
    scannedOnceRef.current = false;
    acceptScanned(text);
  }, [pasted, acceptScanned]);

  /* ── 应用 / 取消 / 重试 ─────────────────────────────────────── */
  const handleConfirm = useCallback(() => {
    if (state.kind !== "ok" || !state.meta) return;
    onApply(state.raw, state.meta);
    onClose();
  }, [state, onApply, onClose]);

  const handleRetry = useCallback(() => {
    setState({ kind: "idle" });
    setRevealSecret(false);
    scannedOnceRef.current = false;
  }, []);

  /* ── 渲染 ───────────────────────────────────────────────────── */
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["top"]}>
        {/* NavBar */}
        <View style={styles.nav}>
          <PressableScale
            onPress={onClose}
            haptic="light"
            scale={0.96}
            style={styles.navBtn}
          >
            <Text style={[styles.navText, { color: c.text2 }]}>取消</Text>
          </PressableScale>
          <Text style={[styles.navTitle, { color: c.text }]}>添加验证码</Text>
          <View style={{ width: 56 }} />
        </View>

        {/* 模式切换 chip */}
        <View style={styles.modeRow}>
          <Chip
            label="扫码"
            icon="camera.fill"
            active={mode === "camera"}
            onPress={() => switchMode("camera")}
          />
          <Chip
            label="相册"
            icon="photo.fill"
            active={mode === "pick"}
            onPress={() => switchMode("pick")}
          />
          <Chip
            label="粘贴"
            icon="doc.on.clipboard"
            active={mode === "paste"}
            onPress={() => switchMode("paste")}
          />
        </View>

        {/* 主区按状态分支 */}
        <View style={styles.body}>
          {state.kind === "ok" && state.meta ? (
            <ResultOk
              meta={state.meta}
              revealSecret={revealSecret}
              onToggleReveal={() => setRevealSecret((v) => !v)}
              onConfirm={handleConfirm}
              onCancel={handleRetry}
              c={c}
            />
          ) : state.kind === "bad" ? (
            <ResultBad error={state.error} rawText={state.rawText} onRetry={handleRetry} c={c} />
          ) : state.kind === "decoding" ? (
            <Decoding c={c} />
          ) : mode === "camera" ? (
            <CameraScene
              permission={permission?.granted ?? false}
              canAskAgain={permission?.canAskAgain ?? true}
              onRequest={requestPermission}
              onScanned={handleBarcode}
              c={c}
            />
          ) : mode === "pick" ? (
            <PickScene onPick={handlePickImage} c={c} />
          ) : (
            <PasteScene
              value={pasted}
              onChange={setPasted}
              onSubmit={handlePasteSubmit}
              c={c}
            />
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

/* ----------------------------------------------------------------------------
 * 相机扫码
 * -------------------------------------------------------------------------- */

function CameraScene({
  permission,
  canAskAgain,
  onRequest,
  onScanned,
  c,
}: {
  permission: boolean;
  canAskAgain: boolean;
  onRequest: () => void;
  onScanned: (r: BarcodeScanningResult) => void;
  c: Palette;
}) {
  // 取景框扫描线动画 —— 纯装饰，让用户感受到"正在扫"
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1,
          duration: 1800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(sweep, {
          toValue: 0,
          duration: 1800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep]);

  if (!permission) {
    return (
      <View style={[styles.center, { padding: 24 }]}>
        <View
          style={[
            styles.permIcon,
            { backgroundColor: c.bgElev, borderColor: c.line },
          ]}
        >
          <IconSymbol name="camera.fill" size={26} color={c.text3} />
        </View>
        <Text style={[styles.permTitle, { color: c.text }]}>需要相机权限</Text>
        <Text style={[styles.permHint, { color: c.text3 }]}>
          扫描身份验证器二维码需要使用相机。图像不会离开本机，不上传任何服务器。
        </Text>
        {canAskAgain ? (
          <Button
            label="授权相机"
            icon="camera.fill"
            variant="primary"
            size="lg"
            onPress={onRequest}
            style={{ marginTop: Spacing.md, alignSelf: "center" }}
          />
        ) : (
          <>
            <Text style={[styles.permHint, { color: c.text3, marginTop: 8 }]}>
              请到系统设置中开启相机权限
            </Text>
            <Button
              label="打开系统设置"
              icon="gearshape.fill"
              variant="primary"
              size="lg"
              onPress={() => Linking.openSettings()}
              style={{ marginTop: Spacing.md, alignSelf: "center" }}
            />
          </>
        )}
      </View>
    );
  }

  const sweepY = sweep.interpolate({ inputRange: [0, 1], outputRange: [0, 220] });

  return (
    <View style={styles.cameraWrap}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={onScanned}
      />
      {/* 取景框遮罩 + 扫描线 */}
      <View pointerEvents="none" style={styles.viewfinderOverlay}>
        <View style={styles.viewfinderBox}>
          <View style={[styles.corner, styles.cornerTL]} />
          <View style={[styles.corner, styles.cornerTR]} />
          <View style={[styles.corner, styles.cornerBL]} />
          <View style={[styles.corner, styles.cornerBR]} />
          <Animated.View
            style={[
              styles.sweepLine,
              { transform: [{ translateY: sweepY }] },
            ]}
          />
        </View>
        <Text style={styles.viewfinderHint}>把二维码对准框内</Text>
      </View>
    </View>
  );
}

/* ----------------------------------------------------------------------------
 * 相册选图
 * -------------------------------------------------------------------------- */

function PickScene({ onPick, c }: { onPick: () => void; c: Palette }) {
  return (
    <View style={[styles.center, { padding: Spacing.xl + 4 }]}>
      <View style={[styles.permIcon, { backgroundColor: c.bgElev }]}>
        <IconSymbol name="photo.fill" size={26} color={c.text3} />
      </View>
      <Text style={[styles.permTitle, { color: c.text }]}>从相册选择截图</Text>
      <Text style={[styles.permHint, { color: c.text3 }]}>
        选择一张含 otpauth:// 二维码的图片，会在本机解码并展示元信息预览
      </Text>
      <Button
        label="选择图片"
        icon="photo.fill"
        variant="primary"
        size="lg"
        onPress={onPick}
        style={{ marginTop: Spacing.md, alignSelf: "center" }}
      />
    </View>
  );
}

/* ----------------------------------------------------------------------------
 * 粘贴 URI
 * -------------------------------------------------------------------------- */

function PasteScene({
  value,
  onChange,
  onSubmit,
  c,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  c: Palette;
}) {
  return (
    <ScrollView
      contentContainerStyle={{ padding: 20 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.permTitle, { color: c.text, textAlign: "left", marginTop: 4 }]}>
        粘贴 otpauth:// URI
      </Text>
      <Text
        style={[
          styles.permHint,
          { color: c.text3, textAlign: "left", marginBottom: 12 },
        ]}
      >
        支持 totp / hotp / steam 三种协议，可指定 SHA1/256/512 与位数 / 周期等参数。
      </Text>
      <View style={[styles.pasteWrap, { backgroundColor: c.bgElev }]}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="otpauth://totp/Issuer:account?secret=…&algorithm=SHA1&digits=6&period=30"
          placeholderTextColor={c.text3}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          style={[
            styles.pasteInput,
            { color: c.text, fontFamily: MONO },
          ]}
        />
      </View>
      <Button
        label="解析"
        icon="arrow.right"
        variant="primary"
        size="lg"
        onPress={onSubmit}
        disabled={!value.trim()}
        fullWidth
        style={{ marginTop: Spacing.lg }}
      />
    </ScrollView>
  );
}

/* ----------------------------------------------------------------------------
 * 解码中 / 结果 / 失败
 * -------------------------------------------------------------------------- */

function Decoding({ c }: { c: Palette }) {
  return (
    <View style={styles.center}>
      <View
        style={[
          styles.spinner,
          { borderColor: c.line, borderTopColor: c.text },
        ]}
      />
      <Text style={{ color: c.text3, marginTop: 12, fontSize: 13 }}>
        正在识别…
      </Text>
    </View>
  );
}

function ResultOk({
  meta,
  revealSecret,
  onToggleReveal,
  onConfirm,
  onCancel,
  c,
}: {
  meta: OtpMeta;
  revealSecret: boolean;
  onToggleReveal: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  c: Palette;
}) {
  const typeLabel =
    meta.type === "steam"
      ? "Steam Guard"
      : meta.type === "hotp"
        ? "HOTP"
        : "TOTP";

  const paramLine =
    meta.type === "hotp"
      ? `${meta.algorithm} · ${meta.digits} 位 · 计数器 ${meta.counter}`
      : `${meta.algorithm} · ${meta.digits} 位 · ${meta.period}s`;

  const maskedSecret = revealSecret
    ? formatBase32Groups(meta.secret)
    : null;

  return (
    <ScrollView contentContainerStyle={{ padding: Spacing.xl }}>
      <View style={styles.okBadge}>
        <Badge label="识别成功" tone="ok" icon="checkmark.seal.fill" />
      </View>

      <View style={[styles.metaCard, { backgroundColor: c.bgElev }]}>
        <MetaRow label="协议" value={typeLabel} c={c} />
        {meta.issuer ? (
          <>
            <Divider c={c} />
            <MetaRow label="发行者" value={meta.issuer} c={c} />
          </>
        ) : null}
        {meta.account ? (
          <>
            <Divider c={c} />
            <MetaRow label="账户" value={meta.account} c={c} />
          </>
        ) : null}
        <Divider c={c} />
        <MetaRow label="参数" value={paramLine} c={c} mono />
        <Divider c={c} />
        <View style={styles.secretRow}>
          <Text style={[styles.metaLabel, { color: c.text3 }]}>密钥</Text>
          <View style={{ flex: 1, alignItems: "flex-end" }}>
            {maskedSecret ? (
              <Text
                style={[
                  styles.metaValue,
                  { color: c.text, fontFamily: MONO },
                ]}
                numberOfLines={2}
              >
                {maskedSecret}
              </Text>
            ) : (
              <View style={styles.maskRow}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <View
                    key={i}
                    style={[styles.maskDot, { backgroundColor: c.text3 }]}
                  />
                ))}
              </View>
            )}
            <PressableScale
              onPress={onToggleReveal}
              haptic="selection"
              scale={0.96}
              style={{ paddingVertical: 4 }}
            >
              <Text style={{ color: c.info, ...Type.footnote, marginTop: 4 }}>
                {revealSecret ? "隐藏" : "显示"}
              </Text>
            </PressableScale>
          </View>
        </View>
      </View>

      <Text style={{ color: c.text3, ...Type.footnote, marginTop: Spacing.md }}>
        请确认 issuer 与账户与你的预期一致再使用。来源不明的二维码可能是钓鱼。
      </Text>

      <View style={{ flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.lg }}>
        <Button
          label="重新扫"
          variant="secondary"
          size="lg"
          onPress={onCancel}
          style={{ flex: 1 }}
          fullWidth
        />
        <Button
          label="使用此密钥"
          icon="checkmark"
          variant="primary"
          size="lg"
          onPress={onConfirm}
          style={{ flex: 1 }}
          fullWidth
        />
      </View>
    </ScrollView>
  );
}

function ResultBad({
  error,
  rawText,
  onRetry,
  c,
}: {
  error: OtpParseError | "no-qr";
  rawText?: string;
  onRetry: () => void;
  c: Palette;
}) {
  const title =
    error === "no-qr"
      ? "未识别到二维码"
      : error === "not-otpauth"
        ? "不是身份验证器二维码"
        : error === "missing-secret"
          ? "二维码缺少密钥参数"
          : error === "invalid-type"
            ? "不支持的 OTP 类型"
            : "URI 格式无法解析";

  const hint =
    error === "no-qr"
      ? "请确保图片中二维码清晰、不被遮挡。"
      : error === "not-otpauth"
        ? "扫到的内容不是 otpauth:// 协议链接。"
        : error === "missing-secret"
          ? "otpauth:// URI 中必须包含 secret 参数。"
          : error === "invalid-type"
            ? "仅支持 totp / hotp / steam 三种协议。"
            : "请检查 URI 拼写是否正确。";

  return (
    <View style={{ padding: Spacing.xl }}>
      <View
        style={[
          styles.permIcon,
          { backgroundColor: c.warn + "1f", alignSelf: "center" },
        ]}
      >
        <IconSymbol
          name="exclamationmark.triangle.fill"
          size={24}
          color={c.warn}
        />
      </View>
      <Text style={[styles.permTitle, { color: c.text, marginTop: Spacing.md }]}>
        {title}
      </Text>
      <Text style={[styles.permHint, { color: c.text3 }]}>{hint}</Text>
      {rawText ? (
        <View style={[styles.rawBox, { backgroundColor: c.bgElev }]}>
          <Text style={[styles.rawLabel, { color: c.text3 }]}>识别到的内容</Text>
          <Text
            style={[styles.rawText, { color: c.text2, fontFamily: MONO }]}
            numberOfLines={4}
          >
            {rawText}
            {rawText.length >= 80 ? "…" : ""}
          </Text>
        </View>
      ) : null}
      <Button
        label="重试"
        icon="arrow.clockwise"
        variant="primary"
        size="lg"
        onPress={onRetry}
        fullWidth
        style={{ marginTop: Spacing.lg }}
      />
    </View>
  );
}

function MetaRow({
  label,
  value,
  c,
  mono,
}: {
  label: string;
  value: string;
  c: Palette;
  mono?: boolean;
}) {
  return (
    <View style={styles.secretRow}>
      <Text style={[styles.metaLabel, { color: c.text3 }]}>{label}</Text>
      <Text
        style={[
          styles.metaValue,
          { color: c.text },
          mono ? { fontFamily: MONO, fontSize: 13 } : null,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function Divider({ c }: { c: Palette }) {
  return <View style={[styles.divider, { backgroundColor: c.lineSoft }]} />;
}

/* ----------------------------------------------------------------------------
 * 样式
 * -------------------------------------------------------------------------- */

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
  navText: { ...Type.body },
  navTitle: { ...Type.title2 },

  modeRow: {
    flexDirection: "row",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
    justifyContent: "center",
  },

  body: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  permIcon: {
    width: 64,
    height: 64,
    borderRadius: Radius.xl,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.md,
  },
  permTitle: {
    ...Type.title2,
    textAlign: "center",
    marginBottom: 6,
  },
  permHint: {
    ...Type.footnote,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 8,
    marginBottom: Spacing.md,
  },

  cameraWrap: { flex: 1, backgroundColor: "#000" },
  viewfinderOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  viewfinderBox: {
    width: 240,
    height: 240,
    borderRadius: 14,
    overflow: "hidden",
  },
  corner: {
    position: "absolute",
    width: 22,
    height: 22,
    borderColor: "#fff",
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 14 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 14 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 14 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 14 },
  sweepLine: {
    position: "absolute",
    left: 8,
    right: 8,
    height: 2,
    borderRadius: 1,
    backgroundColor: "#fff",
    shadowColor: "#fff",
    shadowOpacity: 0.6,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 6,
  },
  viewfinderHint: {
    color: "#fff",
    fontSize: 12,
    marginTop: 18,
    opacity: 0.85,
  },

  spinner: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2.5,
  },

  pasteWrap: {
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    minHeight: 140,
  },
  pasteInput: {
    ...Type.subhead,
    lineHeight: 18,
    textAlignVertical: "top",
    padding: 0,
    minHeight: 110,
  },

  okBadge: {
    alignItems: "flex-start",
    marginBottom: Spacing.md,
  },
  metaCard: {
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.lg,
  },
  secretRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: Spacing.md,
    gap: Spacing.md,
  },
  metaLabel: { ...Type.subhead, paddingTop: 1 },
  metaValue: { ...Type.body, fontWeight: "500", flexShrink: 1, textAlign: "right" },
  divider: { height: StyleSheet.hairlineWidth, width: "100%" },
  maskRow: { flexDirection: "row", gap: 5, paddingVertical: 4 },
  maskDot: { width: 6, height: 6, borderRadius: 3 },

  rawBox: {
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.xs,
  },
  rawLabel: {
    ...Type.caption,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  rawText: { ...Type.footnote, lineHeight: 17 },
});

export default QrScanner;
