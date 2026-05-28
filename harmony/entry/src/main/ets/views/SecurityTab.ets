// SecurityTab —— 安全审计：重复 / 弱密码 / 泄露检测
//
// 与 phone/(tabs)/security.tsx 行为对齐（基础版本，仅本地审计；
// 泄露检测需要 HIBP API 网络访问，后续 Phase 5 接入）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { estimateStrength } from '../lib/Password';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

interface Audit {
  duplicates: number;
  weak: number;
  total: number;
  loginsWithPassword: number;
}

@ComponentV2
export struct SecurityTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  /**
   * @Computed 字段会随依赖（store.items）变化自动重算并缓存，
   * 让 build() 直接通过 `this.audit` 访问统计结果，避免在 build 里写
   * `const a = ...` 这种 ArkTS @Entry/@Component 不允许的语句。
   */
  @Computed
  get audit(): Audit {
    const items = this.store.items.filter((i) => i.type === 'login');
    const seen = new Map<string, number>();
    let weak = 0;
    let withPw = 0;
    for (const it of items) {
      const pw = (it.fields.password as string | undefined) ?? '';
      if (!pw) continue;
      withPw++;
      const n = seen.get(pw) ?? 0;
      seen.set(pw, n + 1);
      if (estimateStrength(pw).score < 50) weak++;
    }
    let duplicates = 0;
    seen.forEach((count, _pw) => {
      if (count > 1) duplicates += count;
    });
    return { duplicates, weak, total: items.length, loginsWithPassword: withPw };
  }

  build() {
    Column({ space: ZSpacing.sm }) {
      Row().height(this.safeArea.top).width('100%');

      Row() {
        Text('安全')
          .fontSize(ZType.titleSize)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .layoutWeight(1);
      }
      .width('100%')
      .padding({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.xs,
        bottom: ZSpacing.sm,
      });

      Scroll() {
        Column({ space: ZSpacing.md }) {
          this.metricCard(
            '登录条目',
            `${this.audit.total}`,
            `其中有密码 ${this.audit.loginsWithPassword}`,
            this.zc.text,
          );
          this.metricCard(
            '弱密码',
            `${this.audit.weak}`,
            '强度低于 50',
            this.audit.weak > 0 ? this.zc.danger : this.zc.ok,
          );
          this.metricCard(
            '重复密码',
            `${this.audit.duplicates}`,
            '多个条目共用同一密码',
            this.audit.duplicates > 0 ? this.zc.warn : this.zc.ok,
          );
          this.metricCard('泄露检测', '—', '需要联网（Phase 5 接入）', this.zc.text3);

          Row().height(80).width('100%');
        }
        .width('100%')
        .constraintSize({ minHeight: '100%' })
        .justifyContent(FlexAlign.Start)
        .alignItems(HorizontalAlign.Start)
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
      }
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart);
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Start)
    .align(Alignment.TopStart)
    .backgroundColor(this.zc.bg);
  }

  @Builder
  metricCard(label: string, value: string, hint: string, color: string) {
    Column({ space: ZSpacing.xs }) {
      Row() {
        Text(label)
          .fontSize(ZType.calloutSize)
          .fontColor(this.zc.text2)
          .layoutWeight(1);
        Text(value)
          .fontSize(28)
          .fontWeight(FontWeight.Bold)
          .fontColor(color);
      }
      .width('100%');

      Text(hint)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3);
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }
}
