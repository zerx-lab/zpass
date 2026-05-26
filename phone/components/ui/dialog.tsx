// 统一弹层 / 提示组件 —— 取代 Alert.alert / ToastAndroid / 散落 Modal
//
// 设计目标：
//   - 命令式 API（dialog.alert / dialog.confirm / dialog.prompt /
//     actionSheet.show / toast.show），与既有调用点 1:1 替换 Alert.alert
//   - 视觉与 ZPass 设计 token 对齐：bg / bgElev / line / radius 14
//   - 动画：中央 fade + 轻微 scale；ActionSheet 底部滑入；Toast 顶部下滑
//   - 不依赖 reanimated（用 RN Animated，避免 worklet 调度抖动）
//   - 跨主题：内部消费 useColorScheme，调用方无需传 c
//
// 用法：
//   await dialog.alert("标题", "正文")
//   const ok = await dialog.confirm("删除", "无法撤销", { destructive: true })
//   const r = await dialog.prompt("空间名", { placeholder: "输入名字" })
//   const key = await actionSheet.show({ title: sp.name, actions: [...] })
//   toast.show("已复制", { variant: "ok" })
//
// 全局只挂载一次 <DialogHost />（在 _layout.tsx 的根布局）。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Colors, type Palette } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";

/* ----------------------------------------------------------------------------
 * 类型
 * -------------------------------------------------------------------------- */

export type DialogActionVariant = "primary" | "default" | "danger" | "ghost";

export interface DialogAction {
  key: string;
  label: string;
  variant?: DialogActionVariant;
}

export interface DialogInputConfig {
  placeholder?: string;
  initial?: string;
  secure?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoCorrect?: boolean;
  maxLength?: number;
  /** 输入框上方的提示（小灰字） */
  hint?: string;
}

export interface DialogConfig {
  title?: string;
  message?: string;
  actions?: DialogAction[];
  input?: DialogInputConfig;
  /** 默认 true：点遮罩 / Android 返回键 = 取消（resolve null） */
  dismissOnBackdrop?: boolean;
}

export interface DialogResult {
  /** 用户按下的按钮 key；null 表示从遮罩或返回键取消 */
  actionKey: string | null;
  /** 仅 input 模式：用户输入值（已 trim 前的原值） */
  value?: string;
}

export type ToastVariant = "default" | "ok" | "warn" | "danger" | "info";

export interface ToastConfig {
  message: string;
  description?: string;
  variant?: ToastVariant;
  /** 显示时长 ms，默认 2200 */
  duration?: number;
}

export interface ActionSheetConfig {
  title?: string;
  message?: string;
  actions: DialogAction[];
  /** 是否在底部追加"取消"项（默认 true） */
  withCancel?: boolean;
}

/* ----------------------------------------------------------------------------
 * Dispatcher —— 模块级单例，被 DialogHost 订阅
 * -------------------------------------------------------------------------- */

interface DialogState extends DialogConfig {
  id: number;
  resolve: (r: DialogResult) => void;
}
interface ToastState extends ToastConfig {
  id: number;
}
interface SheetState extends ActionSheetConfig {
  id: number;
  resolve: (key: string | null) => void;
}

interface Snapshot {
  dialogs: DialogState[];
  toasts: ToastState[];
  sheets: SheetState[];
}

type Listener = (snap: Snapshot) => void;

class Dispatcher {
  private dialogs: DialogState[] = [];
  private toasts: ToastState[] = [];
  private sheets: SheetState[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.snapshot());
    return () => {
      this.listeners.delete(l);
    };
  }

  private snapshot(): Snapshot {
    return {
      dialogs: this.dialogs.slice(),
      toasts: this.toasts.slice(),
      sheets: this.sheets.slice(),
    };
  }

  private notify() {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  showDialog(cfg: DialogConfig): Promise<DialogResult> {
    return new Promise((resolve) => {
      this.dialogs.push({ id: ++this.seq, resolve, ...cfg });
      this.notify();
    });
  }

  closeDialog(id: number, r: DialogResult) {
    const idx = this.dialogs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const d = this.dialogs[idx];
    this.dialogs.splice(idx, 1);
    this.notify();
    d.resolve(r);
  }

  showToast(cfg: ToastConfig): number {
    const id = ++this.seq;
    this.toasts.push({ duration: 2200, variant: "default", ...cfg, id });
    this.notify();
    return id;
  }

  dismissToast(id: number) {
    const idx = this.toasts.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.toasts.splice(idx, 1);
    this.notify();
  }

  showSheet(cfg: ActionSheetConfig): Promise<string | null> {
    return new Promise((resolve) => {
      this.sheets.push({ id: ++this.seq, resolve, withCancel: true, ...cfg });
      this.notify();
    });
  }

  closeSheet(id: number, key: string | null) {
    const idx = this.sheets.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const s = this.sheets[idx];
    this.sheets.splice(idx, 1);
    this.notify();
    s.resolve(key);
  }
}

const dispatcher = new Dispatcher();

/* ----------------------------------------------------------------------------
 * 公共 API
 * -------------------------------------------------------------------------- */

export const dialog = {
  show(cfg: DialogConfig): Promise<DialogResult> {
    return dispatcher.showDialog(cfg);
  },

  /** 单按钮提示（默认按钮 "好"） */
  async alert(
    title: string,
    message?: string,
    opts?: { okLabel?: string },
  ): Promise<void> {
    await dispatcher.showDialog({
      title,
      message,
      actions: [
        { key: "ok", label: opts?.okLabel ?? "好", variant: "primary" },
      ],
      dismissOnBackdrop: true,
    });
  },

  /** 二次确认 —— resolve true = 用户点了 OK */
  async confirm(
    title: string,
    message?: string,
    opts?: {
      okLabel?: string;
      cancelLabel?: string;
      destructive?: boolean;
    },
  ): Promise<boolean> {
    const r = await dispatcher.showDialog({
      title,
      message,
      actions: [
        { key: "cancel", label: opts?.cancelLabel ?? "取消", variant: "ghost" },
        {
          key: "ok",
          label: opts?.okLabel ?? "确认",
          variant: opts?.destructive ? "danger" : "primary",
        },
      ],
      dismissOnBackdrop: true,
    });
    return r.actionKey === "ok";
  },

  /** 输入框 —— resolve 字符串（trim 后非空）或 null（取消） */
  async prompt(
    title: string,
    opts?: {
      message?: string;
      placeholder?: string;
      initial?: string;
      secure?: boolean;
      okLabel?: string;
      cancelLabel?: string;
      hint?: string;
      maxLength?: number;
    },
  ): Promise<string | null> {
    const r = await dispatcher.showDialog({
      title,
      message: opts?.message,
      input: {
        placeholder: opts?.placeholder,
        initial: opts?.initial,
        secure: opts?.secure,
        hint: opts?.hint,
        maxLength: opts?.maxLength,
        autoCapitalize: "none",
        autoCorrect: false,
      },
      actions: [
        { key: "cancel", label: opts?.cancelLabel ?? "取消", variant: "ghost" },
        { key: "ok", label: opts?.okLabel ?? "确认", variant: "primary" },
      ],
      dismissOnBackdrop: true,
    });
    if (r.actionKey !== "ok") return null;
    const v = (r.value ?? "").trim();
    return v.length > 0 ? v : null;
  },
};

export const toast = {
  show(message: string, opts?: Omit<ToastConfig, "message">): number {
    return dispatcher.showToast({ message, ...opts });
  },
  ok(message: string, description?: string): number {
    return dispatcher.showToast({ message, description, variant: "ok" });
  },
  warn(message: string, description?: string): number {
    return dispatcher.showToast({ message, description, variant: "warn" });
  },
  danger(message: string, description?: string): number {
    return dispatcher.showToast({ message, description, variant: "danger" });
  },
  info(message: string, description?: string): number {
    return dispatcher.showToast({ message, description, variant: "info" });
  },
  dismiss(id: number) {
    dispatcher.dismissToast(id);
  },
};

export const actionSheet = {
  show(cfg: ActionSheetConfig): Promise<string | null> {
    return dispatcher.showSheet(cfg);
  },
};

/* ----------------------------------------------------------------------------
 * DialogHost —— 全局挂载，订阅 dispatcher
 * -------------------------------------------------------------------------- */

export function DialogHost() {
  const scheme = useColorScheme();
  const c = Colors[scheme];

  const [snap, setSnap] = useState<Snapshot>({
    dialogs: [],
    toasts: [],
    sheets: [],
  });

  useEffect(() => dispatcher.subscribe(setSnap), []);

  return (
    <>
      {snap.dialogs.map((d) => (
        <DialogView key={d.id} state={d} c={c} />
      ))}
      {snap.sheets.map((s) => (
        <SheetView key={s.id} state={s} c={c} />
      ))}
      <ToastStack toasts={snap.toasts} c={c} />
    </>
  );
}

/* ----------------------------------------------------------------------------
 * DialogView —— 中央卡片 fade + scale
 * -------------------------------------------------------------------------- */

function DialogView({ state, c }: { state: DialogState; c: Palette }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.96)).current;
  const [exited, setExited] = useState(false);

  const [value, setValue] = useState(state.input?.initial ?? "");

  const close = useCallback(
    (actionKey: string | null) => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 130,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 0.97,
          duration: 130,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => {
        setExited(true);
        dispatcher.closeDialog(state.id, {
          actionKey,
          value: state.input ? value : undefined,
        });
      });
    },
    [opacity, scale, state.id, state.input, value],
  );

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        speed: 22,
        bounciness: 4,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, scale]);

  const actions =
    state.actions && state.actions.length > 0
      ? state.actions
      : [{ key: "ok", label: "好", variant: "primary" as const }];

  const onBackdrop = () => {
    if (state.dismissOnBackdrop === false) return;
    Haptics.selectionAsync();
    close(null);
  };

  return (
    <Modal
      transparent
      visible={!exited}
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => close(null)}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onBackdrop}>
        <Animated.View
          style={[
            styles.backdrop,
            { backgroundColor: c.overlay, opacity },
          ]}
        />
      </Pressable>

      <KeyboardAvoidingView
        pointerEvents="box-none"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.centerWrap}
      >
        <Animated.View
          style={[
            styles.card,
            {
              backgroundColor: c.bgElev,
              borderColor: c.line,
              opacity,
              transform: [{ scale }],
              shadowColor: "#000",
            },
          ]}
          onStartShouldSetResponder={() => true}
        >
          {state.title ? (
            <Text style={[styles.title, { color: c.text }]}>{state.title}</Text>
          ) : null}
          {state.message ? (
            <Text
              style={[
                styles.message,
                {
                  color: c.text2,
                  marginTop: state.title ? 6 : 0,
                  marginBottom: state.input ? 12 : 16,
                },
              ]}
            >
              {state.message}
            </Text>
          ) : null}

          {state.input ? (
            <DialogInput
              cfg={state.input}
              value={value}
              onChange={setValue}
              c={c}
            />
          ) : null}

          <View style={styles.actionsRow}>
            {actions.map((a) => (
              <DialogButton
                key={a.key}
                action={a}
                c={c}
                onPress={() => close(a.key)}
              />
            ))}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function DialogInput({
  cfg,
  value,
  onChange,
  c,
}: {
  cfg: DialogInputConfig;
  value: string;
  onChange: (v: string) => void;
  c: Palette;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      {cfg.hint ? (
        <Text
          style={{
            fontSize: 11,
            color: c.text3,
            marginBottom: 6,
          }}
        >
          {cfg.hint}
        </Text>
      ) : null}
      <TextInput
        style={[
          styles.input,
          { color: c.text, backgroundColor: c.bg, borderColor: c.line },
        ]}
        value={value}
        onChangeText={onChange}
        placeholder={cfg.placeholder}
        placeholderTextColor={c.text3}
        secureTextEntry={cfg.secure}
        autoCapitalize={cfg.autoCapitalize ?? "none"}
        autoCorrect={cfg.autoCorrect ?? false}
        maxLength={cfg.maxLength}
        autoFocus
      />
    </View>
  );
}

function DialogButton({
  action,
  c,
  onPress,
}: {
  action: DialogAction;
  c: Palette;
  onPress: () => void;
}) {
  const variant = action.variant ?? "default";
  const style: ViewStyle =
    variant === "primary"
      ? { backgroundColor: c.text, borderColor: c.text }
      : variant === "danger"
        ? { backgroundColor: c.danger, borderColor: c.danger }
        : variant === "ghost"
          ? { backgroundColor: "transparent", borderColor: c.line }
          : { backgroundColor: c.bgHover, borderColor: c.line };
  const textColor =
    variant === "primary"
      ? c.bg
      : variant === "danger"
        ? "#fff"
        : variant === "ghost"
          ? c.text2
          : c.text;
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.btn,
        style,
        { opacity: pressed ? 0.82 : 1 },
      ]}
    >
      <Text
        style={[
          styles.btnText,
          { color: textColor, fontWeight: variant === "ghost" ? "500" : "700" },
        ]}
      >
        {action.label}
      </Text>
    </Pressable>
  );
}

/* ----------------------------------------------------------------------------
 * SheetView —— 底部 ActionSheet（滑入 + fade backdrop）
 * -------------------------------------------------------------------------- */

function SheetView({ state, c }: { state: SheetState; c: Palette }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(40)).current;
  const [exited, setExited] = useState(false);

  const close = useCallback(
    (key: string | null) => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 140,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 30,
          duration: 140,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => {
        setExited(true);
        dispatcher.closeSheet(state.id, key);
      });
    },
    [opacity, translateY, state.id],
  );

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        speed: 18,
        bounciness: 3,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  const actions = state.actions;
  const withCancel = state.withCancel !== false;

  return (
    <Modal
      transparent
      visible={!exited}
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => close(null)}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => close(null)}
      >
        <Animated.View
          style={[styles.backdrop, { backgroundColor: c.overlay, opacity }]}
        />
      </Pressable>

      <View style={styles.sheetWrap} pointerEvents="box-none">
        <Animated.View
          style={{
            opacity,
            transform: [{ translateY }],
          }}
          onStartShouldSetResponder={() => true}
        >
          <SafeAreaView edges={["bottom"]}>
            <View style={[styles.sheetGroup, { marginHorizontal: 12 }]}>
              {/* 顶部 title / message */}
              {state.title || state.message ? (
                <View
                  style={[
                    styles.sheetHeader,
                    { backgroundColor: c.bgElev, borderColor: c.line },
                  ]}
                >
                  {state.title ? (
                    <Text
                      style={[styles.sheetTitle, { color: c.text }]}
                      numberOfLines={1}
                    >
                      {state.title}
                    </Text>
                  ) : null}
                  {state.message ? (
                    <Text
                      style={[
                        styles.sheetMessage,
                        { color: c.text3, marginTop: state.title ? 3 : 0 },
                      ]}
                    >
                      {state.message}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {/* 操作组 */}
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: c.bgElev, borderColor: c.line },
                ]}
              >
                {actions.map((a, idx) => (
                  <SheetRow
                    key={a.key}
                    action={a}
                    c={c}
                    isLast={idx === actions.length - 1}
                    onPress={() => close(a.key)}
                  />
                ))}
              </View>

              {/* 取消组 */}
              {withCancel ? (
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync();
                    close(null);
                  }}
                  style={({ pressed }) => [
                    styles.sheetCancel,
                    {
                      backgroundColor: pressed ? c.bgActive : c.bgElev,
                      borderColor: c.line,
                      marginTop: 8,
                    },
                  ]}
                >
                  <Text style={[styles.sheetCancelText, { color: c.text }]}>
                    取消
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function SheetRow({
  action,
  c,
  isLast,
  onPress,
}: {
  action: DialogAction;
  c: Palette;
  isLast: boolean;
  onPress: () => void;
}) {
  const variant = action.variant ?? "default";
  const color =
    variant === "danger"
      ? c.danger
      : variant === "primary"
        ? c.text
        : variant === "ghost"
          ? c.text3
          : c.text;
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => ({
        backgroundColor: pressed ? c.bgActive : "transparent",
        borderBottomColor: isLast ? "transparent" : c.lineSoft,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        height: 52,
        alignItems: "center",
        justifyContent: "center",
      })}
    >
      <Text
        style={{
          fontSize: 15,
          color,
          fontWeight: variant === "danger" ? "600" : "500",
        }}
      >
        {action.label}
      </Text>
    </Pressable>
  );
}

/* ----------------------------------------------------------------------------
 * ToastStack —— 顶部下滑，自动消失
 * -------------------------------------------------------------------------- */

function ToastStack({ toasts, c }: { toasts: ToastState[]; c: Palette }) {
  return (
    <View style={styles.toastStack} pointerEvents="box-none">
      <SafeAreaView edges={["top"]} pointerEvents="box-none">
        <View style={{ alignItems: "center" }} pointerEvents="box-none">
          {toasts.map((t) => (
            <ToastItem key={t.id} state={t} c={c} />
          ))}
        </View>
      </SafeAreaView>
    </View>
  );
}

function ToastItem({ state, c }: { state: ToastState; c: Palette }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        speed: 18,
        bounciness: 4,
        useNativeDriver: true,
      }),
    ]).start();
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: -12,
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => dispatcher.dismissToast(state.id));
    }, state.duration ?? 2200);
    return () => clearTimeout(timer);
  }, [state.id, state.duration, opacity, translateY]);

  const accent =
    state.variant === "ok"
      ? c.ok
      : state.variant === "warn"
        ? c.warn
        : state.variant === "danger"
          ? c.danger
          : state.variant === "info"
            ? c.info
            : c.text2;

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          backgroundColor: c.bgElev,
          borderColor: c.line,
          opacity,
          transform: [{ translateY }],
        },
      ]}
    >
      <View
        style={[styles.toastDot, { backgroundColor: accent }]}
      />
      <View style={{ flex: 1 }}>
        <Text style={[styles.toastMsg, { color: c.text }]} numberOfLines={2}>
          {state.message}
        </Text>
        {state.description ? (
          <Text
            style={[styles.toastDesc, { color: c.text3 }]}
            numberOfLines={2}
          >
            {state.description}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

/* ----------------------------------------------------------------------------
 * styles
 * -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject },

  centerWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderWidth: 1,
    borderRadius: 14,
    padding: 20,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.28,
    shadowRadius: 24,
    elevation: 18,
  },
  title: { fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  message: { fontSize: 13.5, lineHeight: 19 },

  input: {
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
  },

  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  btn: {
    minWidth: 76,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  btnText: { fontSize: 14 },

  /* sheet */
  sheetWrap: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheetGroup: {},
  sheetHeader: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
    marginBottom: 8,
    alignItems: "center",
  },
  sheetTitle: { fontSize: 15, fontWeight: "600" },
  sheetMessage: { fontSize: 12, textAlign: "center" },

  sheetCard: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
  },
  sheetCancel: {
    borderWidth: 1,
    borderRadius: 14,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetCancelText: { fontSize: 15, fontWeight: "700" },

  /* toast */
  toastStack: {
    ...StyleSheet.absoluteFillObject,
    pointerEvents: "box-none",
  },
  toast: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderRadius: 12,
    maxWidth: 340,
    minWidth: 220,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  toastDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 7,
  },
  toastMsg: { fontSize: 14, fontWeight: "600" },
  toastDesc: { fontSize: 12, marginTop: 2 },
});

