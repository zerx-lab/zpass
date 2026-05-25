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
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Colors, type Palette } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { IconSymbol } from "@/components/ui/icon-symbol";
import {
  formatBase32Groups,
  parseOtpauth,
  type OtpMeta,
  type OtpParseError,
} from "@/lib/totp";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

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
  const scheme = useColorScheme() ?? "dark";
  const c = Colors[scheme];

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
        <View style={[styles.nav, { borderBottomColor: c.lineSoft }]}>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Text style={[styles.navText, { color: c.text2 }]}>取消</Text>
          </TouchableOpacity>
          <Text style={[styles.navTitle, { color: c.text }]}>添加验证码</Text>
          <View style={{ width: 36 }} />
        </View>

        {/* 模式切换 chip */}
        <View style={styles.modeRow}>
          <ModeChip
            label="扫码"
            icon="camera.fill"
            active={mode === "camera"}
            c={c}
            onPress={() => switchMode("camera")}
          />
          <ModeChip
            label="相册"
            icon="photo.fill"
            active={mode === "pick"}
            c={c}
            onPress={() => switchMode("pick")}
          />
          <ModeChip
            label="粘贴"
            icon="doc.on.clipboard"
            active={mode === "paste"}
            c={c}
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
 * 模式切换 chip
 * -------------------------------------------------------------------------- */

function ModeChip({
  label,
  icon,
  active,
  onPress,
  c,
}: {
  label: string;
  icon: React.ComponentProps<typeof IconSymbol>["name"];
  active: boolean;
  onPress: () => void;
  c: Palette;
}) {
  return (
    <TouchableOpacity
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      activeOpacity={0.75}
      style={[
        styles.modeChip,
        active
          ? { backgroundColor: c.text, borderColor: c.text }
          : { backgroundColor: c.bgElev, borderColor: c.line },
      ]}
    >
      <IconSymbol name={icon} size={14} color={active ? c.bg : c.text2} />
      <Text style={[styles.modeChipText, { color: active ? c.bg : c.text2 }]}>
        {label}
      </Text>
    </TouchableOpacity>
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
          <TouchableOpacity
            onPress={onRequest}
            activeOpacity={0.8}
            style={[styles.permBtn, { backgroundColor: c.text }]}
          >
            <Text style={[styles.permBtnText, { color: c.bg }]}>授权相机</Text>
          </TouchableOpacity>
        ) : (
          <Text style={[styles.permHint, { color: c.text3, marginTop: 8 }]}>
            请到系统设置中开启相机权限
          </Text>
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
    <View style={[styles.center, { padding: 24 }]}>
      <View
        style={[
          styles.permIcon,
          { backgroundColor: c.bgElev, borderColor: c.line },
        ]}
      >
        <IconSymbol name="photo.fill" size={26} color={c.text3} />
      </View>
      <Text style={[styles.permTitle, { color: c.text }]}>从相册选择截图</Text>
      <Text style={[styles.permHint, { color: c.text3 }]}>
        选择一张含 otpauth:// 二维码的图片，会在本机解码并展示元信息预览。
      </Text>
      <TouchableOpacity
        onPress={onPick}
        activeOpacity={0.8}
        style={[styles.permBtn, { backgroundColor: c.text }]}
      >
        <Text style={[styles.permBtnText, { color: c.bg }]}>选择图片</Text>
      </TouchableOpacity>
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
      <View
        style={[
          styles.pasteWrap,
          { backgroundColor: c.bgElev, borderColor: c.line },
        ]}
      >
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
      <TouchableOpacity
        onPress={onSubmit}
        activeOpacity={0.8}
        disabled={!value.trim()}
        style={[
          styles.permBtn,
          {
            backgroundColor: value.trim() ? c.text : c.bgElev2,
            marginTop: 16,
            alignSelf: "stretch",
          },
        ]}
      >
        <Text
          style={[
            styles.permBtnText,
            { color: value.trim() ? c.bg : c.text3 },
          ]}
        >
          解析
        </Text>
      </TouchableOpacity>
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
    : "•".repeat(Math.min(meta.secret.length, 20));

  return (
    <ScrollView contentContainerStyle={{ padding: 20 }}>
      <View style={[styles.okBadge, { borderColor: c.line, backgroundColor: c.bgElev }]}>
        <IconSymbol name="checkmark.shield.fill" size={14} color={c.ok} />
        <Text style={{ color: c.text, fontSize: 13, marginLeft: 6 }}>识别成功</Text>
      </View>

      <View style={[styles.metaCard, { backgroundColor: c.bgElev, borderColor: c.line }]}>
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
            <Text
              style={[
                styles.metaValue,
                { color: c.text, fontFamily: MONO, fontSize: 13 },
              ]}
              numberOfLines={2}
            >
              {maskedSecret}
            </Text>
            <TouchableOpacity onPress={onToggleReveal} hitSlop={8}>
              <Text style={{ color: c.text3, fontSize: 11, marginTop: 4 }}>
                {revealSecret ? "隐藏" : "显示"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <Text style={{ color: c.text3, fontSize: 11, lineHeight: 16, marginTop: 12 }}>
        请确认 issuer 与账户与你的预期一致，再选择使用。来源不明的二维码可能是钓鱼。
      </Text>

      <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
        <TouchableOpacity
          onPress={onCancel}
          activeOpacity={0.8}
          style={[
            styles.actionBtn,
            { backgroundColor: c.bgElev, borderColor: c.line, borderWidth: 1 },
          ]}
        >
          <Text style={{ color: c.text2, fontSize: 14, fontWeight: "500" }}>重新扫</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onConfirm}
          activeOpacity={0.8}
          style={[styles.actionBtn, { backgroundColor: c.text }]}
        >
          <Text style={{ color: c.bg, fontSize: 14, fontWeight: "600" }}>
            使用此密钥
          </Text>
        </TouchableOpacity>
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
    <View style={{ padding: 20 }}>
      <View style={[styles.permIcon, { backgroundColor: c.bgElev, borderColor: c.line, alignSelf: "center" }]}>
        <IconSymbol name="exclamationmark.triangle.fill" size={22} color={c.warn} />
      </View>
      <Text style={[styles.permTitle, { color: c.text, marginTop: 14 }]}>{title}</Text>
      <Text style={[styles.permHint, { color: c.text3 }]}>{hint}</Text>
      {rawText ? (
        <View
          style={[
            styles.rawBox,
            { backgroundColor: c.bgElev, borderColor: c.line },
          ]}
        >
          <Text style={[styles.rawLabel, { color: c.text4 }]}>识别到的内容</Text>
          <Text
            style={[styles.rawText, { color: c.text2, fontFamily: MONO }]}
            numberOfLines={4}
          >
            {rawText}
            {rawText.length >= 80 ? "…" : ""}
          </Text>
        </View>
      ) : null}
      <TouchableOpacity
        onPress={onRetry}
        activeOpacity={0.8}
        style={[styles.permBtn, { backgroundColor: c.text, marginTop: 16, alignSelf: "stretch" }]}
      >
        <Text style={[styles.permBtnText, { color: c.bg }]}>重试</Text>
      </TouchableOpacity>
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navText: { fontSize: 15 },
  navTitle: { fontSize: 16, fontWeight: "600" },

  modeRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: "center",
  },
  modeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  modeChipText: { fontSize: 13, fontWeight: "500" },

  body: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  permIcon: {
    width: 60,
    height: 60,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  permTitle: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 6,
  },
  permHint: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 8,
    marginBottom: 16,
  },
  permBtn: {
    borderRadius: 10,
    paddingHorizontal: 22,
    paddingVertical: 12,
    alignItems: "center",
  },
  permBtnText: { fontSize: 14, fontWeight: "600" },

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
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 120,
  },
  pasteInput: {
    fontSize: 13,
    lineHeight: 18,
    textAlignVertical: "top",
    padding: 0,
    minHeight: 100,
  },

  okBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 14,
  },
  metaCard: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
  },
  secretRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: 12,
    gap: 12,
  },
  metaLabel: { fontSize: 13, paddingTop: 1 },
  metaValue: { fontSize: 14, fontWeight: "500", flexShrink: 1, textAlign: "right" },
  divider: { height: StyleSheet.hairlineWidth, width: "100%" },

  actionBtn: {
    flex: 1,
    height: 46,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },

  rawBox: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
  },
  rawLabel: {
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  rawText: { fontSize: 12, lineHeight: 17 },
});

export default QrScanner;
