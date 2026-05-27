// 统一弹层 / 提示组件 —— iOS HIG 风格重构
//
// 设计目标：
//   - 命令式 API（dialog.alert / dialog.confirm / dialog.prompt /
//     actionSheet.show / toast.show），保持原签名，无破坏性变更
//   - 视觉对齐：iOS HIG sheet + dialog 风格
//       Alert/Confirm/Prompt：居中卡片，圆角 22，无 border，shadow 强对比
//       ActionSheet：底部 sheet，圆角顶 22，hairline 分组，无 border
//       Toast：顶部胶囊，圆角 999，pill 风格
//   - 按下态：scale + 背景色变化 + Haptics
//   - 动画：进入用 spring，退出用 in cubic
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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { Elevation, Radius, Spacing, Type, type Palette } from "@/constants/theme";
import { useTheme } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";

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
  hint?: string;
}

export interface DialogConfig {
  title?: string;
  message?: string;
  actions?: DialogAction[];
  input?: DialogInputConfig;
  dismissOnBackdrop?: boolean;
}

export interface DialogResult {
  actionKey: string | null;
  value?: string;
}

export type ToastVariant = "default" | "ok" | "warn" | "danger" | "info";

export interface ToastConfig {
  message: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

export interface ActionSheetConfig {
  title?: string;
  message?: string;
  actions: DialogAction[];
  withCancel?: boolean;
}

/* ----------------------------------------------------------------------------
 * Dispatcher
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
 * DialogHost
 * -------------------------------------------------------------------------- */

export function DialogHost() {
  const { colors: c } = useTheme();

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
 * DialogView —— 中央卡片
 * -------------------------------------------------------------------------- */

function DialogView({ state, c }: { state: DialogState; c: Palette }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.94)).current;
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
          toValue: 0.96,
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
        bounciness: 6,
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
          style={[styles.backdrop, { backgroundColor: c.overlay, opacity }]}
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
              backgroundColor: c.bgElev2,
              opacity,
              transform: [{ scale }],
              ...Elevation.xl,
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
                  marginBottom: state.input ? 14 : 18,
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
                stacked={actions.length > 2}
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
    <View style={{ marginBottom: Spacing.md + 2 }}>
      {cfg.hint ? (
        <Text
          style={{
            ...Type.footnote,
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
          { color: c.text, backgroundColor: c.bgElev },
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
  stacked,
}: {
  action: DialogAction;
  c: Palette;
  onPress: () => void;
  stacked: boolean;
}) {
  const variant = action.variant ?? "default";
  const bg =
    variant === "primary"
      ? c.accent
      : variant === "danger"
        ? c.danger
        : variant === "ghost"
          ? "transparent"
          : c.bgElev;
  const textColor =
    variant === "primary"
      ? c.accentInk
      : variant === "danger"
        ? "#fff"
        : variant === "ghost"
          ? c.text2
          : c.text;
  const pressedBg =
    variant === "primary"
      ? c.text2
      : variant === "danger"
        ? c.danger
        : c.bgHover;

  const scaleAnim = useRef(new Animated.Value(1)).current;
  const onPressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.97,
      speed: 28,
      bounciness: 2,
      useNativeDriver: true,
    }).start();
  };
  const onPressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      speed: 28,
      bounciness: 2,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={({ pressed }) => [
        stacked ? styles.btnStacked : styles.btn,
        { backgroundColor: pressed ? pressedBg : bg },
      ]}
    >
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        <Text
          style={[
            styles.btnText,
            {
              color: textColor,
              fontWeight: variant === "ghost" ? "500" : "700",
            },
          ]}
        >
          {action.label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/* ----------------------------------------------------------------------------
 * SheetView —— 底部 ActionSheet
 * -------------------------------------------------------------------------- */

function SheetView({ state, c }: { state: SheetState; c: Palette }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(60)).current;
  const [exited, setExited] = useState(false);

  const close = useCallback(
    (key: string | null) => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 160,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 40,
          duration: 160,
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
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        speed: 16,
        bounciness: 4,
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
            ...Elevation.lg,
          }}
          onStartShouldSetResponder={() => true}
        >
          <SafeAreaView edges={["bottom"]}>
            <View style={{ marginHorizontal: Spacing.sm }}>
              {/* 顶部 title / message */}
              {state.title || state.message ? (
                <View style={[styles.sheetHeader, { backgroundColor: c.bgElev2 }]}>
                  <View style={[styles.sheetHandle, { backgroundColor: c.line }]} />
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
                        { color: c.text3, marginTop: state.title ? 4 : 0 },
                      ]}
                    >
                      {state.message}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {/* 操作组 */}
              <View style={[styles.sheetCard, { backgroundColor: c.bgElev2 }]}>
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
                      backgroundColor: pressed ? c.bgActive : c.bgElev2,
                      marginTop: Spacing.sm,
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
        ? c.info
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
        height: 56,
        alignItems: "center",
        justifyContent: "center",
      })}
    >
      <Text
        style={{
          ...Type.body,
          fontSize: 17,
          color,
          fontWeight:
            variant === "danger" || variant === "primary" ? "600" : "400",
        }}
      >
        {action.label}
      </Text>
      {!isLast ? (
        <View
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: c.lineSoft,
          }}
        />
      ) : null}
    </Pressable>
  );
}

/* ----------------------------------------------------------------------------
 * ToastStack —— 顶部胶囊
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
  const translateY = useRef(new Animated.Value(-16)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        speed: 18,
        bounciness: 6,
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
          toValue: -16,
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

  const iconName =
    state.variant === "ok"
      ? "checkmark.circle.fill"
      : state.variant === "warn"
        ? "exclamationmark.triangle.fill"
        : state.variant === "danger"
          ? "xmark.circle.fill"
          : state.variant === "info"
            ? "info.circle"
            : undefined;

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          backgroundColor: c.bgElev2,
          opacity,
          transform: [{ translateY }],
          ...Elevation.lg,
        },
      ]}
    >
      {iconName ? (
        <View
          style={[
            styles.toastIcon,
            { backgroundColor: accent + "26" },
          ]}
        >
          <IconSymbol name={iconName as any} size={14} color={accent} />
        </View>
      ) : (
        <View style={[styles.toastDot, { backgroundColor: accent }]} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
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

  /* Dialog */
  centerWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.xxl + 4,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 22,
    padding: Spacing.xl,
  },
  title: { ...Type.title2 },
  message: { ...Type.callout },

  input: {
    height: 46,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    ...Type.body,
  },

  actionsRow: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  btn: {
    flex: 1,
    height: 46,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.md,
  },
  btnStacked: {
    height: 48,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.md,
    marginBottom: 6,
  },
  btnText: { ...Type.body, fontSize: 15 },

  /* Sheet */
  sheetWrap: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheetHeader: {
    borderRadius: 18,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
    marginBottom: Spacing.sm,
    alignItems: "center",
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: Spacing.sm,
  },
  sheetTitle: { ...Type.subhead, fontWeight: "600" },
  sheetMessage: { ...Type.footnote, textAlign: "center" },

  sheetCard: {
    borderRadius: 18,
    overflow: "hidden",
  },
  sheetCancel: {
    borderRadius: 18,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetCancelText: { ...Type.body, fontSize: 17, fontWeight: "700" },

  /* Toast */
  toastStack: {
    ...StyleSheet.absoluteFillObject,
    pointerEvents: "box-none",
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    borderRadius: 999,
    maxWidth: 340,
    minWidth: 220,
  },
  toastIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  toastDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  toastMsg: { ...Type.subhead, fontWeight: "600" },
  toastDesc: { ...Type.footnote, marginTop: 2 },
});
