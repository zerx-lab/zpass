/**
 * ZPass 移动端原生风格 primitives
 *
 * 设计原则（iOS HIG 主导，Android 兼容）：
 *   1. 不用 borderWidth 作为主要分层手段。靠 bgElev / shadow / hairline 表达层级
 *   2. 列表使用 insetGrouped：组背景 bgElev2，组内 hairline 分隔，左右 lg padding
 *   3. 按下态：scale + 背景色变化 + Haptics（Light）；不要单独的 opacity 闪烁
 *   4. 文本统一走 Type token；圆角统一走 Radius token
 *   5. 图标统一走 IconSymbol（禁用 Unicode 字符当图标）
 */

import {
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";

import {
  Colors,
  Elevation,
  Fonts,
  Hit,
  Motion,
  Radius,
  Spacing,
  Type,
  type ColorPalette,
  type ElevationLevel,
  type TypeStyle,
} from "@/constants/theme";
import { useThemeColors } from "@/contexts/theme-context";
import { IconSymbol } from "@/components/ui/icon-symbol";

type IconName = ComponentProps<typeof IconSymbol>["name"];

/* ---------------------------------------------------------------------------
 * Surface —— 可叠层背景容器
 *   level: "base" | "elev" | "elev2"  对应三档 bgElev
 *   elevation: 物理阴影
 *   radius: Radius token
 * ------------------------------------------------------------------------ */

export interface SurfaceProps {
  level?: "base" | "elev" | "elev2";
  radius?: keyof typeof Radius;
  elevation?: ElevationLevel;
  padding?: keyof typeof Spacing;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export function Surface({
  level = "elev",
  radius = "xl",
  elevation = "none",
  padding,
  style,
  children,
}: SurfaceProps) {
  const c = useThemeColors();
  const bg =
    level === "base" ? c.bg : level === "elev2" ? c.bgElev2 : c.bgElev;
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderRadius: Radius[radius],
          padding: padding ? Spacing[padding] : undefined,
        },
        elevation !== "none" && Elevation[elevation],
        style,
      ]}
    >
      {children}
    </View>
  );
}

/* ---------------------------------------------------------------------------
 * PressableScale —— 按下时缩放 + Haptics 的统一交互单元
 *
 * 不直接暴露 Pressable，避免每个调用点都写一遍 transform 动画。
 * ------------------------------------------------------------------------ */

export interface PressableScaleProps
  extends Omit<PressableProps, "style" | "children"> {
  style?: StyleProp<ViewStyle>;
  /** 按下时缩放比例（默认 0.97） */
  scale?: number;
  /** 触感强度：none / selection / light / medium / heavy */
  haptic?: "none" | "selection" | "light" | "medium" | "heavy";
  /** 按下时叠加的背景色（覆盖在原 style 上） */
  pressedBg?: string;
  children?: ReactNode;
}

/**
 * 这些键需要作用在外层 Pressable 上才能让父容器正确分配空间
 * （width: '100%' / flex: 1 / alignSelf: 'stretch' 等）。
 * 仅作用在内层 Animated.View 时，Pressable 会按内容收缩，
 * 导致按钮内容看似偏右、segmented 三档挤在一起、ToggleRow 文字被截断等。
 */
const LAYOUT_STYLE_KEYS = [
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "flex",
  "flexBasis",
  "flexGrow",
  "flexShrink",
  "alignSelf",
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "marginHorizontal",
  "marginVertical",
  "marginStart",
  "marginEnd",
  "position",
  "top",
  "left",
  "right",
  "bottom",
  "zIndex",
] as const;

function splitPressableScaleStyle(style: StyleProp<ViewStyle>): {
  outer: ViewStyle;
  inner: ViewStyle;
} {
  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if ((LAYOUT_STYLE_KEYS as readonly string[]).includes(k)) {
      outer[k] = v;
    } else {
      inner[k] = v;
    }
  }
  return { outer: outer as ViewStyle, inner: inner as ViewStyle };
}

export function PressableScale({
  style,
  scale = Motion.pressScale,
  haptic = "light",
  pressedBg,
  onPressIn,
  onPress,
  children,
  ...rest
}: PressableScaleProps) {
  const anim = useRef(new Animated.Value(1)).current;
  const { outer: outerStyle, inner: innerStyle } = useMemo(
    () => splitPressableScaleStyle(style),
    [style],
  );

  const handlePressIn = (e: GestureResponderEvent) => {
    Animated.spring(anim, {
      toValue: scale,
      ...Motion.spring.button,
      useNativeDriver: true,
    }).start();
    onPressIn?.(e);
  };
  const handlePressOut = () => {
    Animated.spring(anim, {
      toValue: 1,
      ...Motion.spring.button,
      useNativeDriver: true,
    }).start();
  };
  const handlePress = (e: GestureResponderEvent) => {
    if (haptic !== "none") {
      if (haptic === "selection") Haptics.selectionAsync();
      else if (haptic === "light")
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      else if (haptic === "medium")
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      else if (haptic === "heavy")
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
    onPress?.(e);
  };

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      style={outerStyle}
      {...rest}
    >
      {({ pressed }) => (
        <Animated.View
          style={[
            innerStyle,
            { alignSelf: "stretch", flexGrow: 1 },
            { transform: [{ scale: anim }] },
            pressed && pressedBg ? { backgroundColor: pressedBg } : null,
          ]}
        >
          {children}
        </Animated.View>
      )}
    </Pressable>
  );
}

/* ---------------------------------------------------------------------------
 * Button —— 统一按钮（primary/secondary/ghost/danger，三种尺寸）
 * ------------------------------------------------------------------------ */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "lg" | "md" | "sm";

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled,
  fullWidth,
  style,
}: ButtonProps) {
  const c = useThemeColors();
  const v = buttonVariantStyle(variant, c);
  const height =
    size === "lg" ? Hit.buttonLg : size === "sm" ? Hit.buttonSm : Hit.buttonMd;
  const px = size === "lg" ? Spacing.xl : size === "sm" ? Spacing.md : Spacing.lg;
  const t: TypeStyle =
    size === "lg" ? Type.headline : size === "sm" ? Type.subhead : Type.bodyEmph;
  const iconSize = size === "lg" ? 18 : size === "sm" ? 14 : 16;

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic={variant === "danger" ? "medium" : "light"}
      pressedBg={v.pressedBg}
      style={[
        {
          height,
          paddingHorizontal: px,
          borderRadius: size === "sm" ? Radius.md : Radius.lg,
          backgroundColor: v.bg,
          alignSelf: fullWidth ? "stretch" : "flex-start",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: Spacing.sm,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {icon ? <IconSymbol name={icon} size={iconSize} color={v.fg} /> : null}
      <Text style={{ ...t, color: v.fg, includeFontPadding: false }}>
        {label}
      </Text>
      {iconRight ? (
        <IconSymbol name={iconRight} size={iconSize} color={v.fg} />
      ) : null}
    </PressableScale>
  );
}

function buttonVariantStyle(v: ButtonVariant, c: ColorPalette) {
  switch (v) {
    case "primary":
      return { bg: c.accent, fg: c.accentInk, pressedBg: c.text2 };
    case "danger":
      return { bg: c.danger, fg: "#ffffff", pressedBg: c.danger };
    case "secondary":
      return { bg: c.bgElev, fg: c.text, pressedBg: c.bgActive };
    case "ghost":
    default:
      return { bg: "transparent", fg: c.text, pressedBg: c.bgHover };
  }
}

/* ---------------------------------------------------------------------------
 * IconButton —— 仅图标的圆形按钮
 * ------------------------------------------------------------------------ */

export interface IconButtonProps {
  icon: IconName;
  onPress?: () => void;
  size?: number;
  iconSize?: number;
  variant?: "ghost" | "solid" | "tinted";
  color?: string;
  haptic?: PressableScaleProps["haptic"];
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  icon,
  onPress,
  size = Hit.min,
  iconSize,
  variant = "ghost",
  color,
  haptic = "light",
  disabled,
  style,
}: IconButtonProps) {
  const c = useThemeColors();
  const finalIconSize = iconSize ?? Math.round(size * 0.5);
  const bg =
    variant === "solid"
      ? c.accent
      : variant === "tinted"
        ? c.bgElev
        : "transparent";
  const fg =
    color ??
    (variant === "solid" ? c.accentInk : c.text);
  const pressedBg =
    variant === "solid" ? c.text2 : variant === "tinted" ? c.bgActive : c.bgHover;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic={haptic}
      pressedBg={pressedBg}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <IconSymbol name={icon} size={finalIconSize} color={fg} />
    </PressableScale>
  );
}

/* ---------------------------------------------------------------------------
 * Chip —— Segmented / Filter Chip
 * ------------------------------------------------------------------------ */

export interface ChipProps {
  label: string;
  active?: boolean;
  count?: number;
  icon?: IconName;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function Chip({ label, active, count, icon, onPress, style }: ChipProps) {
  const c = useThemeColors();
  const bg = active ? c.accent : c.bgElev;
  const fg = active ? c.accentInk : c.text;
  const sub = active ? c.accentInk : c.text3;
  const pressedBg = active ? c.text2 : c.bgActive;
  return (
    <PressableScale
      onPress={onPress}
      haptic="selection"
      scale={0.95}
      pressedBg={pressedBg}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: Spacing.xs,
          paddingHorizontal: Spacing.md,
          height: Hit.buttonSm,
          borderRadius: Radius.full,
          backgroundColor: bg,
        },
        style,
      ]}
    >
      {icon ? <IconSymbol name={icon} size={13} color={fg} /> : null}
      <Text style={{ ...Type.subhead, color: fg, includeFontPadding: false }}>
        {label}
      </Text>
      {typeof count === "number" ? (
        <Text style={{ ...Type.caption, color: sub, includeFontPadding: false }}>
          {count}
        </Text>
      ) : null}
    </PressableScale>
  );
}

/* ---------------------------------------------------------------------------
 * ListGroup —— iOS insetGrouped 列表组
 *
 * 用法：
 *   <ListGroup header="基础" footer="可以编辑的字段">
 *     <ListRow .../>
 *     <ListRow .../>
 *   </ListGroup>
 *
 * 内部自动处理首尾圆角与 hairline。子元素必须是 ListRow（或同样 height）。
 * ------------------------------------------------------------------------ */

export interface ListGroupProps {
  header?: string;
  footer?: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 关闭组容器背景，仅渲染 hairline 分组（用于纯描边场景，少用） */
  plain?: boolean;
}

export function ListGroup({ header, footer, children, style, plain }: ListGroupProps) {
  const c = useThemeColors();
  const items = useMemo(() => {
    const arr: ReactNode[] = [];
    const childArray = Array.isArray(children) ? children : [children];
    const cleaned = childArray.filter(Boolean);
    cleaned.forEach((child, i) => {
      arr.push(child);
      if (i < cleaned.length - 1) {
        arr.push(
          <View
            key={`sep-${i}`}
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: c.lineSoft,
              marginLeft: Spacing.lg + 26, // 缩进至文本对齐位
            }}
          />,
        );
      }
    });
    return arr;
  }, [children, c.lineSoft]);

  return (
    <View style={[{ marginBottom: Spacing.xl }, style]}>
      {header ? (
        <Text
          style={{
            ...Type.footnote,
            color: c.text3,
            paddingHorizontal: Spacing.lg + Spacing.xs,
            paddingBottom: Spacing.sm,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {header}
        </Text>
      ) : null}
      <View
        style={{
          marginHorizontal: Spacing.lg,
          backgroundColor: plain ? "transparent" : c.bgElev,
          borderRadius: Radius.xl,
          overflow: "hidden",
        }}
      >
        {items}
      </View>
      {footer ? (
        <Text
          style={{
            ...Type.footnote,
            color: c.text3,
            paddingHorizontal: Spacing.lg + Spacing.xs,
            paddingTop: Spacing.sm,
          }}
        >
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------------------
 * ListRow —— ListGroup 子项
 *
 * 三段：左 icon/avatar + 中 title/subtitle + 右 value/accessory/chevron
 * ------------------------------------------------------------------------ */

export type ListRowAccessory = "chevron" | "external" | "check" | "none";

export interface ListRowProps {
  title: string;
  subtitle?: string;
  value?: string;
  /** 左侧图标（在浅色圆角方块里渲染） */
  icon?: IconName;
  /** 自定义左侧渲染（替代 icon） */
  leading?: ReactNode;
  /** 自定义右侧渲染（覆盖 value + accessory） */
  trailing?: ReactNode;
  /** icon 背景色（默认 c.bgActive） */
  iconBg?: string;
  /** icon 前景色（默认 c.text） */
  iconColor?: string;
  onPress?: () => void;
  accessory?: ListRowAccessory;
  /** 强调色：覆盖 title 与 icon（用于"删除"等危险动作） */
  tone?: "default" | "danger" | "accent";
  disabled?: boolean;
  /** 行高（不传时按内容自适应，但至少 Hit.row） */
  minHeight?: number;
}

export function ListRow({
  title,
  subtitle,
  value,
  icon,
  leading,
  trailing,
  iconBg,
  iconColor,
  onPress,
  accessory,
  tone = "default",
  disabled,
  minHeight = Hit.row,
}: ListRowProps) {
  const c = useThemeColors();
  const toneColor =
    tone === "danger" ? c.danger : tone === "accent" ? c.info : c.text;
  const finalAccessory =
    accessory ?? (onPress && !trailing && !value ? "chevron" : "none");

  const inner = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        paddingHorizontal: Spacing.lg,
        paddingVertical: subtitle ? Spacing.sm + 2 : Spacing.md - 2,
        minHeight,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {leading ?? (icon ? (
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: Radius.md,
            backgroundColor: iconBg ?? c.bgActive,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconSymbol name={icon} size={16} color={iconColor ?? c.text} />
        </View>
      ) : null)}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{ ...Type.body, color: toneColor }}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={{ ...Type.footnote, color: c.text3, marginTop: 1 }}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ??
        (value ? (
          <Text
            style={{ ...Type.subhead, color: c.text3, maxWidth: 160 }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {value}
          </Text>
        ) : null)}
      {finalAccessory === "chevron" ? (
        <IconSymbol name="chevron.right" size={16} color={c.text4} />
      ) : finalAccessory === "check" ? (
        <IconSymbol name="checkmark" size={16} color={c.info} />
      ) : null}
    </View>
  );

  if (!onPress) return inner;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      scale={0.99}
      haptic="selection"
      pressedBg={c.bgHover}
    >
      {inner}
    </PressableScale>
  );
}

/* ---------------------------------------------------------------------------
 * SectionHeader —— 独立大标题，用于非分组场景的段落标题
 * ------------------------------------------------------------------------ */

export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
}) {
  const c = useThemeColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: Spacing.lg,
        marginTop: Spacing.lg,
        marginBottom: Spacing.sm,
      }}
    >
      <Text style={{ ...Type.title2, color: c.text }}>{title}</Text>
      {action ? (
        <PressableScale
          onPress={action.onPress}
          haptic="selection"
          scale={0.96}
          style={{ paddingVertical: 4, paddingHorizontal: 6 }}
        >
          <Text style={{ ...Type.subhead, color: c.info }}>{action.label}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------------------
 * NavBar —— 模拟 iOS 大/小标题栏
 *   left / right 可放 IconButton
 * ------------------------------------------------------------------------ */

export interface NavBarProps {
  title?: string;
  largeTitle?: boolean;
  left?: ReactNode;
  right?: ReactNode;
  subtitle?: string;
  style?: StyleProp<ViewStyle>;
}

export function NavBar({ title, largeTitle, left, right, subtitle, style }: NavBarProps) {
  const c = useThemeColors();
  return (
    <View
      style={[
        {
          paddingHorizontal: Spacing.lg,
          paddingTop: Spacing.xs,
          paddingBottom: largeTitle ? Spacing.md : Spacing.sm,
          backgroundColor: c.bg,
        },
        style,
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 36,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: Spacing.sm, flex: 1 }}>
          {left}
          {!largeTitle && title ? (
            <Text style={{ ...Type.title2, color: c.text }} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: Spacing.xs }}>
          {right}
        </View>
      </View>
      {largeTitle && title ? (
        <Text
          style={{
            ...Type.largeTitle,
            color: c.text,
            marginTop: Spacing.xs,
          }}
          numberOfLines={1}
        >
          {title}
        </Text>
      ) : null}
      {subtitle ? (
        <Text style={{ ...Type.footnote, color: c.text3, marginTop: 2 }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------------------
 * Badge —— 小色块标记（2FA、泄露等）
 * ------------------------------------------------------------------------ */

export function Badge({
  label,
  tone = "info",
  icon,
  style,
}: {
  label?: string;
  tone?: "info" | "warn" | "danger" | "ok" | "neutral";
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useThemeColors();
  const color =
    tone === "warn"
      ? c.warn
      : tone === "danger"
        ? c.danger
        : tone === "ok"
          ? c.ok
          : tone === "neutral"
            ? c.text2
            : c.info;
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: Radius.sm,
          backgroundColor: color + "1f",
        },
        style,
      ]}
    >
      {icon ? <IconSymbol name={icon} size={10} color={color} /> : null}
      {label ? (
        <Text
          style={{
            fontSize: 10,
            fontWeight: "600",
            color,
            includeFontPadding: false,
          }}
        >
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------------------
 * MaskDots / MaskedValue —— 敏感值遮罩 + 眼睛切换
 *
 * 统一密码 / CVV / TOTP 等敏感字段的展示：遮罩时渲染 6 个圆点（不暴露长度），
 * 点眼睛揭示明文。item 详情与同步冲突 diff 共用。
 * ------------------------------------------------------------------------ */

const MASK_MONO = Fonts?.mono ?? "monospace";

export function MaskDots({ color }: { color?: string }) {
  const c = useThemeColors();
  return (
    <View style={{ flexDirection: "row", gap: 4, paddingVertical: 3 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <View
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: color ?? c.text3,
          }}
        />
      ))}
    </View>
  );
}

export interface MaskedValueProps {
  value: string;
  /** 敏感值：默认遮罩，提供眼睛切换 */
  masked?: boolean;
  /** 等宽字体（密码 / 序列号 / TOTP） */
  mono?: boolean;
  color?: string;
  /** 占位（值为空时显示） */
  placeholder?: string;
  numberOfLines?: number;
  style?: StyleProp<ViewStyle>;
}

export function MaskedValue({
  value,
  masked,
  mono,
  color,
  placeholder = "—",
  numberOfLines = 3,
  style,
}: MaskedValueProps) {
  const c = useThemeColors();
  const [revealed, setRevealed] = useState(false);
  const showMask = !!masked && !revealed;
  return (
    <View
      style={[
        { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
        style,
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        {showMask ? (
          <MaskDots />
        ) : (
          <Text
            style={{
              ...Type.body,
              color: color ?? c.text,
              fontFamily: mono || masked ? MASK_MONO : undefined,
            }}
            numberOfLines={numberOfLines}
          >
            {value || placeholder}
          </Text>
        )}
      </View>
      {masked ? (
        <IconButton
          icon={revealed ? "eye.slash.fill" : "eye.fill"}
          size={28}
          iconSize={15}
          variant="ghost"
          color={c.text3}
          haptic="selection"
          onPress={() => setRevealed((v) => !v)}
        />
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------------------
 * Field —— 表单输入容器（label + 子输入），不直接持有 TextInput
 *
 * 用于在 insetGrouped 列表中渲染 label/value 编辑行：调用方传 children 自定义
 * 输入控件（TextInput / Switch 等），Field 负责包裹与对齐。
 * ------------------------------------------------------------------------ */

export interface FieldProps {
  label: string;
  hint?: string;
  required?: boolean;
  /** 内联模式：label 与控件横向排列（"用户名 [______]"） */
  inline?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}

export function Field({
  label,
  hint,
  required,
  inline,
  children,
  style,
  labelStyle,
}: FieldProps) {
  const c = useThemeColors();
  if (inline) {
    return (
      <View
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: Spacing.lg,
            minHeight: Hit.row,
            gap: Spacing.md,
          },
          style,
        ]}
      >
        <Text
          style={[
            { ...Type.body, color: c.text, minWidth: 96 },
            labelStyle,
          ]}
          numberOfLines={1}
        >
          {label}
          {required ? <Text style={{ color: c.danger }}>{" *"}</Text> : null}
        </Text>
        <View style={{ flex: 1, alignItems: "flex-end" }}>{children}</View>
      </View>
    );
  }
  return (
    <View
      style={[
        {
          paddingHorizontal: Spacing.lg,
          paddingVertical: Spacing.sm + 2,
        },
        style,
      ]}
    >
      <Text
        style={[
          {
            ...Type.footnote,
            color: c.text3,
            marginBottom: 4,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          },
          labelStyle,
        ]}
      >
        {label}
        {required ? <Text style={{ color: c.danger }}>{" *"}</Text> : null}
      </Text>
      {children}
      {hint ? (
        <Text style={{ ...Type.footnote, color: c.text3, marginTop: 4 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------------------
 * Input —— 与 Field 配合的轻量 TextInput 包装
 *
 * 没有边框，靠 ListGroup 容器分层；focus 态用 caret 提示。
 * ------------------------------------------------------------------------ */

export { TextInput as RawTextInput } from "react-native";

/* ---------------------------------------------------------------------------
 * Divider —— 1 像素分隔（hairline）
 * ------------------------------------------------------------------------ */

export function Divider({
  inset = 0,
  style,
}: {
  inset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useThemeColors();
  return (
    <View
      style={[
        {
          height: StyleSheet.hairlineWidth,
          backgroundColor: c.lineSoft,
          marginLeft: inset,
        },
        style,
      ]}
    />
  );
}

/* ---------------------------------------------------------------------------
 * 默认导出整套以便集合引入
 * ------------------------------------------------------------------------ */

export type { ColorPalette };
export { Colors, Radius, Spacing, Type, Elevation, Hit, Motion };
