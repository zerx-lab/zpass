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
 */
export const Radius = {
  sm: 5,
  md: 7,
  lg: 10,
  xl: 14,
} as const;
