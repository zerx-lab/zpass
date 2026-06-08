/**
 * ZPass 设计 Token（HarmonyOS / ArkTS 版）
 *
 * 与 phone/constants/theme.ts、design/src/tokens.css 严格对齐：
 *  - 暗 / 亮双 palette，默认跟随系统（由 state/ThemeStore.ets 切换）
 *  - 描边优先于填充；圆角仅 5 / 7 / 10 / 14
 *  - 主题色严格收紧：accent 仅黑 / 白；favicon 板已剔除紫蓝色
 *  - 渲染层禁止 emoji 与 Unicode 装饰符号，统一走图标系统
 *
 * 颜色访问规范：
 *   import { ZColors } from '../theme/Tokens';
 *   // ZColors 是 @ObservedV2 单例；组件中通过 `@Local zc: ZColorsClass = ZColors;`
 *   // 拿到引用即可。ZColors.bg / this.zc.bg 都会触发渲染追踪。
 */

interface Palette {
  bg: string;
  bgElev: string;
  bgElev2: string;
  bgHover: string;
  bgActive: string;
  line: string;
  lineSoft: string;
  text: string;
  text2: string;
  text3: string;
  text4: string;
  accent: string;
  accentInk: string;
  accentGlow: string;
  danger: string;
  warn: string;
  ok: string;
  info: string;
  overlay: string;
}

/** 暗色调色板 —— 与 phone dark 对齐 */
const DARK_PALETTE: Palette = {
  bg: '#0c0c0d',
  bgElev: '#111113',
  bgElev2: '#16161a',
  bgHover: '#18181c',
  bgActive: '#1d1d22',
  line: '#232328',
  lineSoft: '#1a1a1e',
  text: '#ececec',
  text2: '#a8a8ac',
  text3: '#6e6e73',
  text4: '#45454a',
  accent: '#ececec',
  accentInk: '#0c0c0d',
  accentGlow: 'rgba(255,255,255,0.04)',
  danger: '#e55a4a',
  warn: '#c8934a',
  ok: '#5ea47a',
  info: '#6b9cc4',
  overlay: 'rgba(0,0,0,0.55)',
};

/** 浅色调色板 —— 与 phone/constants/theme.ts light 字节级对齐（iOS HIG 系统色） */
const LIGHT_PALETTE: Palette = {
  bg: '#ffffff',
  bgElev: '#f7f7f9',
  bgElev2: '#ffffff',
  bgHover: '#f0f0f3',
  bgActive: '#e8e8eb',
  line: '#d8d8dc',
  lineSoft: '#ececef',
  text: '#000000',
  text2: '#3c3c43',
  text3: '#8e8e93',
  text4: '#c7c7cc',
  accent: '#000000',
  accentInk: '#ffffff',
  accentGlow: 'rgba(0,0,0,0.04)',
  danger: '#ff3b30',
  warn: '#ff9500',
  ok: '#34c759',
  info: '#007aff',
  overlay: 'rgba(0,0,0,0.32)',
};

/** favicon 头像色板 —— 已剔除偏紫色，统一 12 色 */
const FAVICON_DARK: string[] = [
  '#1a1a2e', '#3b6ea5', '#2c2c2c', '#c8533f',
  '#141414', '#c87a1e', '#a85a1e', '#0f4c75',
  '#7a2b2b', '#1e4d2b', '#3f5e76', '#5e6e76',
];

const FAVICON_LIGHT: string[] = [
  '#3f5680', '#5a82b5', '#4a4a4a', '#cc6450',
  '#3a3a3a', '#d68a30', '#c47030', '#356a93',
  '#a04848', '#3f7456', '#5a7b95', '#7a8a93',
];

/**
 * ZColors —— 响应式调色板单例
 *
 * @ObservedV2 + @Trace 字段意味着任何组件的 build / @Computed 中访问
 * ZColors.x 都会被框架记录依赖；切换主题时 setPalette() 同步更新所有字段，
 * 依赖此调色板的组件会自动重渲。
 */
@ObservedV2
export class ZColorsClass {
  @Trace bg: string = DARK_PALETTE.bg;
  @Trace bgElev: string = DARK_PALETTE.bgElev;
  @Trace bgElev2: string = DARK_PALETTE.bgElev2;
  @Trace bgHover: string = DARK_PALETTE.bgHover;
  @Trace bgActive: string = DARK_PALETTE.bgActive;
  @Trace line: string = DARK_PALETTE.line;
  @Trace lineSoft: string = DARK_PALETTE.lineSoft;
  @Trace text: string = DARK_PALETTE.text;
  @Trace text2: string = DARK_PALETTE.text2;
  @Trace text3: string = DARK_PALETTE.text3;
  @Trace text4: string = DARK_PALETTE.text4;
  @Trace accent: string = DARK_PALETTE.accent;
  @Trace accentInk: string = DARK_PALETTE.accentInk;
  @Trace accentGlow: string = DARK_PALETTE.accentGlow;
  @Trace danger: string = DARK_PALETTE.danger;
  @Trace warn: string = DARK_PALETTE.warn;
  @Trace ok: string = DARK_PALETTE.ok;
  @Trace info: string = DARK_PALETTE.info;
  @Trace overlay: string = DARK_PALETTE.overlay;

  /** 是否暗色态；favicon / 系统栏 / SVG 等场景按此切板 */
  @Trace isDark: boolean = true;

  /** favicon 头像底色（12 色，跟随主题切板） */
  @Trace faviconColors: string[] = FAVICON_DARK;

  /** favicon 字母前景色 —— 两套 palette 的 favicon 底色都偏深，白字保证对比 */
  readonly faviconInk: string = '#ECECEC';

  /** 用于 onChange 等少量场景；@Trace 字段已经能被追踪，这里仅是计数兜底 */
  @Trace revision: number = 0;

  applyDark(): void {
    this.setPalette(DARK_PALETTE, FAVICON_DARK, true);
  }

  applyLight(): void {
    this.setPalette(LIGHT_PALETTE, FAVICON_LIGHT, false);
  }

  private setPalette(p: Palette, fav: string[], dark: boolean): void {
    if (this.isDark === dark) return;
    this.bg = p.bg;
    this.bgElev = p.bgElev;
    this.bgElev2 = p.bgElev2;
    this.bgHover = p.bgHover;
    this.bgActive = p.bgActive;
    this.line = p.line;
    this.lineSoft = p.lineSoft;
    this.text = p.text;
    this.text2 = p.text2;
    this.text3 = p.text3;
    this.text4 = p.text4;
    this.accent = p.accent;
    this.accentInk = p.accentInk;
    this.accentGlow = p.accentGlow;
    this.danger = p.danger;
    this.warn = p.warn;
    this.ok = p.ok;
    this.info = p.info;
    this.overlay = p.overlay;
    this.faviconColors = fav;
    this.isDark = dark;
    this.revision++;
  }
}

export const ZColors: ZColorsClass = new ZColorsClass();

/**
 * 将 6 位 hex (#RRGGBB) 转换为 ArkUI 的 12% 透明前缀格式 (#1fRRGGBB / #AARRGGBB)。
 * ArkUI 8 位十六进制格式为 #AARRGGBB，alpha 在最前，与 CSS/RN 的 #RRGGBBAA 相反。
 * 传入非标准格式（非 '#' 开头或长度不为 7）时原样返回。
 */
export function alpha1f(hex: string): string {
  return hex.length === 7 && hex.charAt(0) === '#' ? '#1f' + hex.substring(1) : hex;
}

export class ZSpacing {
  static readonly xs: number = 4;
  static readonly sm: number = 8;
  static readonly md: number = 12;
  static readonly lg: number = 16;
  static readonly xl: number = 20;
  static readonly xxl: number = 24;
  static readonly xxxl: number = 32;
}

export class ZRadius {
  static readonly sm: number = 5;
  static readonly md: number = 7;
  static readonly lg: number = 10;
  static readonly xl: number = 14;
}

export class ZType {
  // 字号 / 行高（ArkUI 按 fp / vp 计；这里直接给数值，ArkUI 默认按 fp 处理 fontSize）
  static readonly largeTitleSize: number = 32;
  static readonly titleSize: number = 22;
  static readonly title2Size: number = 17;
  static readonly headlineSize: number = 15;
  static readonly bodySize: number = 15;
  static readonly calloutSize: number = 14;
  static readonly subheadSize: number = 13;
  static readonly footnoteSize: number = 12;
  static readonly captionSize: number = 11;
}

// 安全区高度已迁移到 state/SafeArea.ets 的 @ObservedV2 单例，不再走 AppStorage。
