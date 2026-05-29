// SecurityTab —— 安全审计：重复 / 弱密码 / 泄露检测
//
// 与 phone/(tabs)/security.tsx 行为对齐：
//   - 本地审计：登录条目总数 / 带密码数 / 弱密码 / 重复
//   - 联网审计：HIBP k-anonymity 泄露扫描（用户主动点扫描按钮触发）
//
// 网络扫描缓存：进程内 Map，vault 锁定时一并清空（在 vaultStore.lock() 里调）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { estimateStrength } from '../lib/Password';
import { batchCheckBreaches, type BreachableItem, type BreachResult } from '../lib/Breach';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

interface Audit {
  duplicates: number;
  weak: number;
  total: number;
  loginsWithPassword: number;
}

type ScanStatus = 'idle' | 'scanning' | 'done' | 'error';

@ComponentV2
export struct SecurityTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local scanStatus: ScanStatus = 'idle';
  @Local scanResults: BreachResult[] = [];
  @Local scanError: string = '';

  /**
   * 锁屏即把"扫描结果"也一并丢掉 —— 与 phone vault-context.lock() 行为对齐。
   * 与 store.lock() 内部 clearBreachCache() 配合：缓存清空 + UI 状态清空。
   * 解锁后重新打开本页需要手动再扫一次。
   *
   * VaultStatus 是 plain interface（子字段不是 @Trace），所以监控 status 整体；
   * lock() 重新赋值整个 status 对象会触发此回调，回调里读 unlocked 子字段。
   */
  @Monitor('store.status')
  onStatusChange(): void {
    if (!this.store.status.unlocked) {
      this.scanStatus = 'idle';
      this.scanResults = [];
      this.scanError = '';
    }
  }

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

  @Computed
  get pwnedCount(): number {
    return this.scanResults.filter((r) => r.pwned).length;
  }

  @Computed
  get scanFailedCount(): number {
    return this.scanResults.filter((r) => !!r.error).length;
  }

  private async onScanBreaches(force: boolean): Promise<void> {
    if (this.scanStatus === 'scanning') return;
    const targets: BreachableItem[] = this.store.items
      .filter((i) => i.type === 'login')
      .map((i) => {
        const pw = i.fields.password as string | undefined;
        return { id: i.id, name: i.name, password: pw ?? '' } as BreachableItem;
      })
      .filter((t) => !!t.password);

    if (targets.length === 0) {
      this.scanStatus = 'done';
      this.scanResults = [];
      this.scanError = '没有可检测的密码（先添加带密码的登录条目）';
      return;
    }

    this.scanStatus = 'scanning';
    this.scanError = '';
    try {
      const results = await batchCheckBreaches(targets, { force });
      this.scanResults = results;
      this.scanStatus = 'done';
    } catch (e) {
      this.scanError = (e as Error).message;
      this.scanStatus = 'error';
    }
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

          this.breachCard();

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

  @Builder
  breachCard() {
    Column({ space: ZSpacing.sm }) {
      Row() {
        Column({ space: 2 }) {
          Text('泄露检测')
            .fontSize(ZType.calloutSize)
            .fontColor(this.zc.text2);
          Text(this.breachHint())
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3);
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1);

        if (this.scanStatus === 'done' || this.scanStatus === 'error') {
          Text(`${this.pwnedCount}`)
            .fontSize(28)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.pwnedCount > 0 ? this.zc.danger : this.zc.ok);
        } else if (this.scanStatus === 'scanning') {
          Text('…')
            .fontSize(28)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text3);
        } else {
          Text('—')
            .fontSize(28)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text3);
        }
      }
      .width('100%');

      Row({ space: ZSpacing.sm }) {
        Text(this.scanStatus === 'scanning' ? '扫描中…' : '检查 HIBP')
          .fontSize(ZType.subheadSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.accentInk)
          .backgroundColor(this.scanStatus === 'scanning' ? this.zc.text3 : this.zc.accent)
          .borderRadius(ZRadius.lg)
          .height(40)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .enabled(this.scanStatus !== 'scanning')
          .onClick(() => this.onScanBreaches(false));

        if (this.scanStatus === 'done' || this.scanStatus === 'error') {
          // 分支内 scanStatus 已收窄为 'done' | 'error'，按钮恒可点
          Text('重新扫描')
            .fontSize(ZType.subheadSize)
            .fontColor(this.zc.text)
            .backgroundColor(this.zc.bg)
            .borderRadius(ZRadius.lg)
            .height(40)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .onClick(() => this.onScanBreaches(true));
        }
      }
      .width('100%');

      if (this.scanError) {
        Text(this.scanError)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.danger)
          .width('100%');
      }

      if (this.scanStatus === 'done' && this.pwnedCount > 0) {
        Column({ space: ZSpacing.xs }) {
          ForEach(this.scanResults.filter((r) => r.pwned), (r: BreachResult) => {
            Row() {
              Text(r.itemName)
                .fontSize(ZType.subheadSize)
                .fontColor(this.zc.text)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1);
              Text(`${r.count} 次`)
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.danger);
            }
            .width('100%')
            .padding({ top: 6, bottom: 6 });
          }, (r: BreachResult) => r.itemId);
        }
        .width('100%')
        .padding({ top: ZSpacing.xs });
      }

      if (this.scanFailedCount > 0) {
        Text(`${this.scanFailedCount} 条检测失败（网络或限流）`)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.warn)
          .width('100%');
      }
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  private breachHint(): string {
    if (this.scanStatus === 'scanning') return '正在向 HIBP 提交 SHA-1 前缀…';
    if (this.scanStatus === 'done') {
      if (this.pwnedCount === 0) return '没有发现已泄露密码';
      return `${this.pwnedCount} 个密码出现在 HIBP 泄露库`;
    }
    if (this.scanStatus === 'error') return '扫描失败，点重新扫描重试';
    return '通过 k-anonymity 比对 HIBP（不上传密码）';
  }
}
