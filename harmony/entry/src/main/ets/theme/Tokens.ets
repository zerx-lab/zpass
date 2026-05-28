/**
 * ZPass 设计 Token（HarmonyOS / ArkTS 版）
 *
 * 与 phone/constants/theme.ts、design/src/tokens.css 严格对齐：
 *  - 暗色为主（先做暗色，浅色后续按 iOS HIG light 移植）
 *  - 描边优先于填充；圆角仅 5 / 7 / 10 / 14
 *  - 渲染层禁止 emoji 与 Unicode 装饰符号，统一走图标系统
 */

export class ZColors {
  // 背景层级
  static readonly bg: string = '#0c0c0d';
  static readonly bgElev: string = '#111113';
  static readonly bgElev2: string = '#16161a';
  static readonly bgHover: string = '#18181c';
  static readonly bgActive: string = '#1d1d22';

  // 描边
  static readonly line: string = '#232328';
  static readonly lineSoft: string = '#1a1a1e';

  // 文字层级
  static readonly text: string = '#ececec';
  static readonly text2: string = '#a8a8ac';
  static readonly text3: string = '#6e6e73';
  static readonly text4: string = '#45454a';

  // 主色
  static readonly accent: string = '#ececec';
  static readonly accentInk: string = '#0c0c0d';
  static readonly accentGlow: string = 'rgba(255,255,255,0.04)';

  // 语义色（与 phone 对齐：克制偏暖系，danger 偏红土，warn 琥珀，ok 草绿，info 蓝灰）
  static readonly danger: string = '#e55a4a';
  static readonly warn: string = '#c8934a';
  static readonly ok: string = '#5ea47a';
  static readonly info: string = '#6b9cc4';

  // 覆盖层
  static readonly overlay: string = 'rgba(0,0,0,0.55)';
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
// 历史 ZSafeArea 常量已删除；组件直接 `@Local safeArea: SafeAreaState = safeAreaState`。
