// ThemeStore —— 主题模式（system / dark / light）状态与 ZColors palette 联动
//
// 设计：
//   - 默认 mode 为 'system'，systemColorMode 由 EntryAbility 通过 mediaquery 注入
//   - 用户也可手动覆盖（mode = 'dark' | 'light'），会持久化到 preferences（后续 Phase）
//   - 任意 mode 变更或 systemColorMode 变更后都重算 resolved 并同步 ZColors palette
//
// 这里不直接 import @kit.ArkUI 的 mediaquery —— EntryAbility 负责订阅系统并通知。

import { ZColors } from '../theme/Tokens';

export type ThemeMode = 'system' | 'dark' | 'light';
export type ColorMode = 'dark' | 'light';

@ObservedV2
export class ThemeStore {
  /** 用户选择的模式 */
  @Trace mode: ThemeMode = 'system';

  /** 系统当前的颜色模式（mediaquery 推过来） */
  @Trace systemColorMode: ColorMode = 'dark';

  /** 实际生效的颜色模式（resolved） */
  @Trace effective: ColorMode = 'dark';

  /** 由 EntryAbility 注入：系统栏内容色随主题切换时回调（白底用黑图标，反之亦然） */
  private onEffectiveChange?: (mode: ColorMode) => void;

  setOnEffectiveChange(cb: (mode: ColorMode) => void): void {
    this.onEffectiveChange = cb;
    cb(this.effective);
  }

  /** 由 EntryAbility 在 mediaquery change 时调用 */
  setSystemColorMode(m: ColorMode): void {
    if (this.systemColorMode === m) return;
    this.systemColorMode = m;
    if (this.mode === 'system') this.applyEffective(m);
  }

  /** 用户在设置里手动切换 */
  setMode(m: ThemeMode): void {
    if (this.mode === m) return;
    this.mode = m;
    const next: ColorMode = m === 'system' ? this.systemColorMode : m;
    this.applyEffective(next);
  }

  private applyEffective(m: ColorMode): void {
    if (this.effective === m) {
      // 即使 effective 没变，也确保 palette 已对齐（首次初始化场景）
      if (m === 'dark') ZColors.applyDark(); else ZColors.applyLight();
      return;
    }
    this.effective = m;
    if (m === 'dark') ZColors.applyDark(); else ZColors.applyLight();
    if (this.onEffectiveChange) this.onEffectiveChange(m);
  }
}

export const themeStore: ThemeStore = new ThemeStore();
