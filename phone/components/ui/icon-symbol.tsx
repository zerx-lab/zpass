// Fallback for using MaterialIcons on Android and web.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SymbolWeight, SymbolViewProps } from "expo-symbols";
import { ComponentProps } from "react";
import { OpaqueColorValue, type StyleProp, type TextStyle } from "react-native";

type IconMapping = Record<
  SymbolViewProps["name"],
  ComponentProps<typeof MaterialIcons>["name"]
>;
type IconSymbolName = keyof typeof MAPPING;

/**
 * Add your SF Symbols to Material Icons mappings here.
 * - see Material Icons in the [Icons Directory](https://icons.expo.fyi).
 * - see SF Symbols in the [SF Symbols](https://developer.apple.com/sf-symbols/) app.
 */
const MAPPING = {
  // ── 原有映射 ──────────────────────────────────────────────────
  "house.fill": "home",
  "paperplane.fill": "send",
  "chevron.left.forwardslash.chevron.right": "code",
  "chevron.right": "chevron-right",
  "chevron.left": "chevron-left",

  // ── ZPass Tab 导航图标 ────────────────────────────────────────
  "shield.fill": "security",
  "key.fill": "vpn-key",
  "clock.fill": "access-time",
  "wand.and.stars": "auto-fix-high",
  "person.fill": "person",

  // ── ZPass 通用 UI 图标 ────────────────────────────────────────
  "lock.fill": "lock",
  magnifyingglass: "search",
  plus: "add",
  "doc.on.doc.fill": "content-copy",
  "eye.fill": "visibility",
  "eye.slash.fill": "visibility-off",
  pencil: "edit",
  "square.and.pencil": "edit",
  "trash.fill": "delete",
  "arrow.clockwise": "refresh",
  "arrow.counterclockwise": "refresh",
  "square.and.arrow.up": "share",
  "exclamationmark.triangle.fill": "warning",
  "checkmark.circle.fill": "check-circle",
  checkmark: "check",
  ellipsis: "more-horiz",
  xmark: "close",
  "star.fill": "star",
  star: "star-border",
  globe: "language",
  "tag.fill": "label",
  wifi: "wifi",
  "creditcard.fill": "credit-card",
  "note.text": "description",
  "terminal.fill": "terminal",
  // ── 详情页/列表新增 ───────────────────────────────────────────
  "person.crop.circle.fill": "account-circle",
  "key.horizontal.fill": "key",
  keyboard: "keyboard",
  // ── 扫码 / 二维码 ─────────────────────────────────────────────
  "qrcode.viewfinder": "qr-code-scanner",
  qrcode: "qr-code-2",
  "camera.fill": "camera-alt",
  "photo.fill": "photo",
  "doc.on.clipboard": "content-paste",
  "checkmark.shield.fill": "verified-user",
  // ── 自定义字段相关 ──────────────────────────────────────────
  "text.alignleft": "text-fields",
  "switch.2": "toggle-on",
  link: "link",
} as IconMapping;

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
}) {
  return (
    <MaterialIcons
      color={color}
      size={size}
      name={MAPPING[name]}
      style={style}
    />
  );
}
