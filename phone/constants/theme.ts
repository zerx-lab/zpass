import { Platform } from "react-native";

/**
 * ZPass 设计 Token —— 与 ZPassDesign/src/tokens.css 和 zp-shared.jsx 严格对齐
 *
 * 设计原则：
 * - 暗色：近黑 + 冷灰底，营造高级感与隐私感
 * - 浅色：暖米白（#f5f5f3 系，非纯白），降低刺眼感、提升精致度
 * - 描边优先于填充，依赖 line / lineSoft 区分层级
 * - accent 即"主色"，暗色为白、浅色为近黑（构成强对比按钮）
 */
/**
 * 调色板接口 —— 让 dark / light 共享同一类型签名，
 * 避免 `as const` 推断出的字面量类型互不兼容（导致
 * `c: typeof Colors.dark` 形参无法接收 light 调色板）。
 */
export interface Palette {
  /* 背景层级 */
  bg: string;
  bgElev: string;
  bgElev2: string;
  bgHover: string;
  bgActive: string;

  /* 描边 */
  line: string;
  lineSoft: string;

  /* 文字层级 */
  text: string;
  text2: string;
  text3: string;
  text4: string;

  /* 主色 */
  accent: string;
  accentInk: string;
  accentGlow: string;

  /* 语义色 */
  danger: string;
  warn: string;
  ok: string;
  info: string;

  /* 网格 / 覆盖层 */
  grid: string;
  overlay: string;

  /* 向后兼容字段 */
  background: string;
  tint: string;
  icon: string;
  tabIconDefault: string;
  tabIconSelected: string;
}

export const Colors: { dark: Palette; light: Palette } = {
  dark: {
    /* 背景层级：bg < bgElev < bgElev2 */
    bg: "#0c0c0d",
    bgElev: "#111113",
    bgElev2: "#16161a",
    bgHover: "#18181c",
    bgActive: "#1d1d22",

    /* 描边 */
    line: "#232328",
    lineSoft: "#1a1a1e",

    /* 文字层级 */
    text: "#ececec",
    text2: "#a8a8ac",
    text3: "#6e6e73",
    text4: "#45454a",

    /* 主色（按钮 / 强调） */
    accent: "#ececec",
    accentInk: "#0c0c0d",
    accentGlow: "rgba(255,255,255,0.04)",

    /* 语义色 */
    danger: "#e55a4a",
    warn: "#c8934a",
    ok: "#5ea47a",
    info: "#6b9cc4",

    /* 网格 / 分隔覆盖层 */
    grid: "rgba(255,255,255,0.025)",
    overlay: "rgba(0,0,0,0.55)",

    /* 向后兼容字段（react-navigation / expo 默认接口需要） */
    background: "#0c0c0d",
    tint: "#ececec",
    icon: "#a8a8ac",
    tabIconDefault: "#6e6e73",
    tabIconSelected: "#ececec",
  },
  light: {
    /**
     * 浅色主题（iOS 26 / Apple HIG 对齐版）：
     *
     * 调研依据：
     * - Apple Human Interface Guidelines (developer.apple.com/design/.../color)
     * - iOS 26 Liquid Glass 设计语言（WWDC 2025 发布）
     * - Apple 系统色精确 hex 值（System Gray 1-6 / System Background / Label / Separator）
     *
     * 核心原则：
     * 1. 背景层级使用 iOS 标准三层：System Background (#FFFFFF) / Secondary (#F2F2F7) / Tertiary (#FFFFFF)
     * 2. Liquid Glass 提倡"靠描边和半透明区分层级，而非填充色"
     * 3. 灰阶严格采用 System Gray 1-6 系列
     * 4. 语义色用 iOS 标准（System Red/Green/Blue/Orange），用户已熟知
     * 5. 文本采用 Label 系列（黑 + Secondary Label #3C3C43）
     */
    /* 背景层级 —— 极轻三层，避免"脏灰"观感
     *
     * 设计修正（基于用户反馈"列表/搜索框背景脏"）：
     * iOS 26 真正做法是列表行白底 + hairline 分隔线（参考 Settings/Notes/Photos），
     * 而不是把 bgElev 直接当列表行背景。我们把 bgElev 灰度降到极轻档（#f7f7f9），
     * 它仅用于"小元素的轻微高亮"（如搜索框/小按钮/详情卡），不再用作大色块。
     * 大列表请用 bg（纯白） + lineSoft 分隔。
     */
    bg: "#ffffff" /* System Background：纯白主背景（也用于列表行） */,
    bgElev: "#f7f7f9" /* 极轻灰：搜索框 / 小按钮 / 详情卡的微高亮 */,
    bgElev2: "#ffffff" /* 卡片层：纯白，靠描边 + 阴影区分 */,
    bgHover:
      "#f0f0f3" /* hover 瞬时态可以稍明显（介于 bgElev 与 bgActive 之间） */,
    bgActive: "#e8e8eb" /* active 按下态：明显但仍轻于 System Gray 5 */,

    /* 描边 —— 比 iOS Separator 略柔，避免在浅底上过重 */
    line: "#d8d8dc" /* 主描边：比 iOS #c6c6c8 略浅，与 #f7f7f9 的 bgElev 协调 */,
    lineSoft: "#ececef" /* hairline：列表行底部分隔线（极淡，不切割视觉） */,

    /* 文字层级 —— iOS Label 系列 + System Gray */
    text: "#000000" /* Label：纯黑（Apple 标准主文本） */,
    text2: "#3c3c43" /* Secondary Label：86% 黑（次级文本） */,
    text3: "#8e8e93" /* System Gray：占位符 / 三级文本 */,
    text4: "#c7c7cc" /* System Gray 3：禁用态文本 */,

    /* 主色（保留 ZPass 品牌：黑白强对比，与暗色主题对称）
     * 注：iOS 默认 accent 是 System Blue (#007aff)，但 ZPass 的设计语言
     * 是"黑白极简 + 描边优先"，accent 改 blue 会破坏品牌。
     * 因此：accent 仍用近黑，info 语义色才用 System Blue。 */
    accent: "#000000" /* 纯黑：与 dark.accent=白 形成对称 */,
    accentInk: "#ffffff",
    accentGlow: "rgba(0,0,0,0.04)",

    /* 语义色（Apple HIG 系统色 light 模式精确值，用户已熟悉） */
    danger: "#ff3b30" /* System Red */,
    warn: "#ff9500" /* System Orange */,
    ok: "#34c759" /* System Green */,
    info: "#007aff" /* System Blue：留给"链接 / 信息提示"语义 */,

    /* 网格 / 覆盖层 */
    grid: "rgba(0,0,0,0.035)",
    overlay: "rgba(0,0,0,0.32)",

    /* 向后兼容字段（与 accent 黑色对齐，保持 ZPass 黑白品牌识别） */
    background: "#ffffff",
    tint: "#000000",
    icon: "#3c3c43",
    tabIconDefault: "#8e8e93",
    tabIconSelected: "#000000" /* 选中 Tab 用纯黑，与暗色主题"白"对称 */,
  },
};

export type ColorScheme = keyof typeof Colors;
export type ColorPalette = Palette;

/**
 * 字体（保留 Geist 系列，参考 ZPassDesign）
 * iOS 用 system 同名字族；Android / 默认 用回退；Web 用完整栈
 */
export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: "system-ui",
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: "ui-serif",
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: "ui-rounded",
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: "ui-monospace",
  },
  default: {
    sans: "normal",
    serif: "serif",
    rounded: "normal",
    mono: "monospace",
  },
  web: {
    sans: "Geist, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded:
      "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "'Geist Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});

/**
 * 圆角 Token（与设计系统一致：仅 5 / 7 / 10 / 14）
 * - sm: pill / 小标签
 * - md: 小按钮 / chip
 * - lg: 输入框 / 行内按钮
 * - xl: 卡片 / Sheet / 弹层
 */
export const Radius = {
  sm: 5,
  md: 7,
  lg: 10,
  xl: 14,
  full: 9999,
} as const;

/**
 * 间距 Token（4 倍数体系，iOS HIG 偏好 8/16）
 *   xs(4)  · 微小间距（图标 + 文本）
 *   sm(8)  · 紧凑分隔
 *   md(12) · 行内
 *   lg(16) · 屏幕主 padding / 卡片 padding
 *   xl(20) · 大块分隔
 *   xxl(24) · 段落标题上下
 *   xxxl(32) · 节末留白
 */
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/**
 * Elevation Token —— iOS 用 shadow，Android 用 elevation
 *   none: 无阴影
 *   sm: 列表行/小卡片 hover
 *   md: insetGrouped 卡片
 *   lg: FAB / Sheet
 *   xl: 弹层 (dialog)
 *
 * 暗色主题下 shadow 几乎不可见，主要靠 bgElev 颜色区分；
 * 这里仍提供 shadowOpacity 让浅色主题获益。
 */
export type ElevationLevel = "none" | "sm" | "md" | "lg" | "xl";

export interface ElevationStyle {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

export const Elevation: Record<ElevationLevel, ElevationStyle> = {
  none: {
    shadowColor: "transparent",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  sm: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  lg: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 12,
    elevation: 6,
  },
  xl: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.24,
    shadowRadius: 28,
    elevation: 18,
  },
};

/**
 * Typography 角色（取代散落的 fontSize/fontWeight 拼装）
 * 以 iOS HIG 文本样式为参照，权重保留 ZPass "克制" 偏好（多数 500/600）。
 */
export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  fontWeight: "400" | "500" | "600" | "700";
  letterSpacing?: number;
}

export const Type: Record<
  | "largeTitle"
  | "title"
  | "title2"
  | "headline"
  | "body"
  | "bodyEmph"
  | "callout"
  | "subhead"
  | "footnote"
  | "caption"
  | "mono",
  TypeStyle
> = {
  largeTitle: { fontSize: 32, lineHeight: 38, fontWeight: "700", letterSpacing: -0.6 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.4 },
  title2: { fontSize: 17, lineHeight: 22, fontWeight: "700", letterSpacing: -0.2 },
  headline: { fontSize: 15, lineHeight: 20, fontWeight: "600", letterSpacing: -0.1 },
  body: { fontSize: 15, lineHeight: 20, fontWeight: "400" },
  bodyEmph: { fontSize: 15, lineHeight: 20, fontWeight: "500" },
  callout: { fontSize: 14, lineHeight: 19, fontWeight: "400" },
  subhead: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  footnote: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: "500" },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
};

/**
 * Motion Token —— 统一动效时长 / 缓动
 * 与 iOS UIView 动画曲线对齐：短交互 200ms 内，弹层 ≤ 260ms。
 */
export const Motion = {
  duration: {
    fast: 130,
    base: 180,
    slow: 240,
    sheet: 260,
  },
  spring: {
    /** 触感按钮的弹簧（小回弹） */
    button: { speed: 28, bounciness: 2 },
    /** 卡片/弹层进入 */
    enter: { speed: 22, bounciness: 4 },
  },
  /** 按下态缩放 */
  pressScale: 0.97,
} as const;

/**
 * 命中区 / 控件高度
 */
export const Hit = {
  /** 最小命中区域（44 iOS HIG） */
  min: 44,
  /** 列表行高 */
  row: 52,
  /** 大按钮 */
  buttonLg: 52,
  /** 中按钮 */
  buttonMd: 44,
  /** 小按钮 / chip */
  buttonSm: 32,
} as const;
