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
  // 安全中心：泄露盾（红色 X）/ 扫描镜 / 直方图
  "shield.slash.fill": "gpp-bad",
  "magnifyingglass.circle": "manage-search",
  "chart.bar.fill": "bar-chart",
  // ── 自定义字段相关 ──────────────────────────────────────────
  "text.alignleft": "text-fields",
  "switch.2": "toggle-on",
  link: "link",
  // ── 信任设备 / 生物识别 ──────────────────────────────────────
  // Material Icons 没有 face-id，用 fingerprint 兜底 —— 两端都映射成
  // 指纹图标更通用（Android 多见指纹；iOS Face ID 用户也能理解为"生物识别"）
  faceid: "fingerprint",
  // ── 状态 / 工具 ─────────────────────────────────────────────
  "circle.fill": "circle",
  "minus": "remove",
  "arrow.up.right": "north-east",
  "arrow.right": "arrow-forward",
  "arrow.left": "arrow-back",
  "arrow.down": "arrow-downward",
  "arrow.up.doc.fill": "file-upload",
  "arrow.down.doc.fill": "file-download",
  "moon.fill": "dark-mode",
  "sun.max.fill": "light-mode",
  "gearshape.fill": "settings",
  "info.circle": "info",
  "questionmark.circle": "help-outline",
  "bell.fill": "notifications",
  "envelope.fill": "mail",
  "paintbrush.fill": "brush",
  "square.grid.2x2.fill": "apps",
  "lock.shield.fill": "shield",
  "hand.raised.fill": "back-hand",
  "bolt.fill": "bolt",
  "play.fill": "play-arrow",
  "stop.fill": "stop",
  "wifi.exclamationmark": "signal-wifi-bad",
  "antenna.radiowaves.left.and.right": "wifi-tethering",
  "cloud.fill": "cloud",
  "trash": "delete-outline",
  "doc.text.fill": "description",
  "list.bullet": "list",
  "line.3.horizontal.decrease": "filter-list",
  "command": "keyboard-command-key",
  "rectangle.portrait.and.arrow.right": "logout",
  "person.2.fill": "group",
  "square.and.arrow.down.fill": "save-alt",
  "xmark.circle.fill": "cancel",
  "exclamationmark.circle.fill": "error",
  "checkmark.seal.fill": "verified",
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
