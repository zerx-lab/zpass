// SecurityTab —— 安全中心：综合评分 Hero + 统计磁贴 + 泄露监控 + 行动建议 + 强度分布
//
// 与 phone/(tabs)/security.tsx 行为对齐：
//   - 本地审计：登录条目总数 / 带密码数 / 弱密码（强度 < 60）/ 综合评分 / 强度直方图
//   - 联网审计：HIBP k-anonymity 泄露扫描（用户主动点扫描按钮触发）
//   - 行动建议：泄露项优先 + 弱密码次之，按 id 去重，最多 12 条，可点击跳详情
//
// 网络扫描缓存：进程内 Map，vault 锁定时一并清空（在 vaultStore.lock() 里调）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { estimateStrength } from '../lib/Password';
import { batchCheckBreaches, type BreachableItem, type BreachResult } from '../lib/Breach';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { router } from '@kit.ArkUI';

interface Audit {
  total: number;
  weak: number;
  withPassword: number;
  score: number;
  histogram: number[];
}

interface ActionIssue {
  id: string;
  name: string;
  severity: string;
  count: number;
  strength: number;
}

type ScanStatus = 'idle' | 'scanning' | 'done' | 'error';

const MONO: string = 'Courier New';
const HIST_LABELS: string[] = ['0-20', '20-40', '40-60', '60-80', '80-100'];

@ComponentV2
export struct SecurityTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local scanStatus: ScanStatus = 'idle';
  @Local scanResults: BreachResult[] = [];
  @Local scanError: string = '';
  @Local scanLastAt: number = 0;

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
      this.scanLastAt = 0;
    }
  }

  /**
   * @Computed 字段会随依赖（store.items）变化自动重算并缓存，
   * 让 build() 直接通过 `this.audit` 访问统计结果，避免在 build 里写
   * `const a = ...` 这种 ArkTS @ComponentV2 不允许的语句。
   */
  @Computed
  get audit(): Audit {
    const items = this.store.items.filter((i) => i.type === 'login');
    const histogram: number[] = [0, 0, 0, 0, 0];
    let weak = 0;
    let withPw = 0;
    let sum = 0;
    for (const it of items) {
      const pw = (it.fields.password as string | undefined) ?? '';
      if (!pw) continue;
      withPw++;
      const strength = estimateStrength(pw).score;
      sum += strength;
      if (strength < 60) weak++;
      const bin = Math.min(4, Math.floor(strength / 20));
      histogram[bin] += 1;
    }
    let score = 0;
    if (withPw > 0) {
      score = Math.max(0, Math.min(100, Math.round(sum / withPw)));
    }
    return { total: items.length, weak, withPassword: withPw, score, histogram };
  }

  @Computed
  get pwnedCount(): number {
    return this.scanResults.filter((r) => r.pwned).length;
  }

  @Computed
  get scanFailedCount(): number {
    return this.scanResults.filter((r) => !!r.error).length;
  }

  @Computed
  get breachedItems(): BreachResult[] {
    return this.scanResults.filter((r) => r.pwned && r.count > 0);
  }

  @Computed
  get breachErrorCount(): number {
    return this.scanResults.filter((r) => !!r.error).length;
  }

  @Computed
  get adjustedScore(): number {
    const base = this.audit.score;
    if (this.breachedItems.length === 0) return base;
    const penalty = Math.min(30, this.breachedItems.length * 5);
    return Math.max(0, base - penalty);
  }

  @Computed
  get actionItems(): ActionIssue[] {
    return this.buildActionItems();
  }

  private buildActionItems(): ActionIssue[] {
    const seen = new Set<string>();
    const ranked: ActionIssue[] = [];
    for (const r of this.breachedItems) {
      if (seen.has(r.itemId)) continue;
      seen.add(r.itemId);
      const item = this.store.items.find((i) => i.id === r.itemId);
      if (!item) continue;
      const pw = (item.fields.password as string | undefined) ?? '';
      ranked.push({
        id: r.itemId,
        name: item?.name ?? r.itemName,
        severity: 'breach',
        count: r.count,
        strength: pw ? estimateStrength(pw).score : 0,
      });
    }
    for (const it of this.store.items.filter((i) => i.type === 'login')) {
      if (seen.has(it.id)) continue;
      const pw = (it.fields.password as string | undefined) ?? '';
      if (!pw) continue;
      const s = estimateStrength(pw).score;
      if (s >= 60) continue;
      seen.add(it.id);
      ranked.push({ id: it.id, name: it.name, severity: 'weak', count: 0, strength: s });
    }
    return ranked.slice(0, 12);
  }

  private gradeForScore(s: number): string {
    if (s >= 85) return 'A';
    if (s >= 70) return 'B';
    if (s >= 50) return 'C';
    return 'D';
  }

  private gradeLabel(g: string): string {
    if (g === 'A') return '优秀';
    if (g === 'B') return '良好';
    if (g === 'C') return '需关注';
    return '存在风险';
  }

  private colorForScore(s: number): string {
    if (s >= 85) return this.zc.ok;
    if (s >= 70) return this.zc.info;
    if (s >= 50) return this.zc.warn;
    return this.zc.danger;
  }

  private firstChar(name: string): string {
    const chars = Array.from(name);
    return (chars[0] ?? '.').toUpperCase();
  }

  private resolveName(r: BreachResult): string {
    const item = this.store.items.find((i) => i.id === r.itemId);
    return item?.name ?? r.itemName;
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  private scanButtonLabel(): string {
    if (this.scanStatus === 'scanning') return '扫描中';
    if (this.scanStatus === 'idle') return '扫描';
    return '重新扫描';
  }

  private breachedCountLabel(): string {
    if (this.breachResultsNull()) return '—';
    return `${this.breachedItems.length}`;
  }

  private breachResultsNull(): boolean {
    return this.scanStatus === 'idle' && this.scanResults.length === 0;
  }

  private histMax(): number {
    return Math.max(this.audit.histogram[0], this.audit.histogram[1], this.audit.histogram[2],
      this.audit.histogram[3], this.audit.histogram[4], 1);
  }

  private barHeight(value: number): number {
    return Math.max(3, Math.round((value / this.histMax()) * 96));
  }

  private binColor(i: number): string {
    if (i <= 1) return this.zc.danger;
    if (i === 2) return this.zc.warn;
    if (i === 3) return this.zc.info;
    return this.zc.ok;
  }

  private onOpenItem(id: string): void {
    router.pushUrl({ url: 'pages/ItemDetail', params: { id } }).catch(() => {});
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
      this.scanResults = [];
      this.scanError = '没有可检测的密码（先添加带密码的登录条目）';
      this.scanLastAt = Date.now();
      this.scanStatus = 'error';
      return;
    }

    this.scanStatus = 'scanning';
    this.scanError = '';
    try {
      const results = await batchCheckBreaches(targets, { force });
      this.scanResults = results;
      this.scanLastAt = Date.now();
      this.scanStatus = 'done';
    } catch (e) {
      this.scanError = (e as Error).message;
      this.scanStatus = 'error';
    }
  }

  build() {
    Column({ space: ZSpacing.sm }) {
      Row().height(this.safeArea.top).width('100%');

      Column({ space: ZSpacing.xs }) {
        Text('安全中心')
          .fontSize(ZType.titleSize)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);
        Text('保险库健康度一览 · 轮换弱密码、清理泄露项')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.xs,
        bottom: ZSpacing.sm,
      });

      Scroll() {
        Column({ space: ZSpacing.md }) {
          if (this.audit.total === 0) {
            this.emptyStateCard();
          } else {
            this.heroCard();
            this.statTilesRow();
            this.breachCard();
            this.actionCard();
            this.histogramCard();
          }
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
  emptyStateCard() {
    Column({ space: ZSpacing.sm }) {
      Column() {
        Image($r('app.media.ic_shield_check'))
          .width(28)
          .height(28)
          .fillColor(this.zc.ok);
      }
      .width(64)
      .height(64)
      .borderRadius(ZRadius.xl)
      .backgroundColor(alpha1f(this.zc.ok))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.sm });

      Text('暂无登录条目')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text('添加一条登录开始追踪保险库健康度')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center);
    }
    .width('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl, top: ZSpacing.xxxl, bottom: ZSpacing.xxxl })
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  heroCard() {
    Column({ space: ZSpacing.lg }) {
      // 顶部：评分 + 等级环
      Row() {
        Column() {
          Text('综合评分')
            .fontSize(ZType.captionSize)
            .fontColor(this.zc.text3)
            .letterSpacing(1.2);
          Row({ space: ZSpacing.xs }) {
            Text(`${this.adjustedScore}`)
              .fontSize(56)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.colorForScore(this.adjustedScore))
              .fontFamily(MONO);
            Text('/100')
              .fontSize(ZType.bodySize)
              .fontColor(this.zc.text3)
              .fontFamily(MONO)
              .padding({ bottom: 8 });
          }
          .alignItems(VerticalAlign.Bottom)
          .margin({ top: ZSpacing.xs });
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1);

        Column({ space: 6 }) {
          Column() {
            Text(this.gradeForScore(this.adjustedScore))
              .fontSize(22)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.colorForScore(this.adjustedScore))
              .fontFamily(MONO);
          }
          .width(56)
          .height(56)
          .borderRadius(28)
          .backgroundColor(alpha1f(this.colorForScore(this.adjustedScore)))
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center);

          Text(this.gradeLabel(this.gradeForScore(this.adjustedScore)))
            .fontSize(ZType.captionSize)
            .fontColor(this.zc.text3)
            .letterSpacing(0.8);
        }
        .alignItems(HorizontalAlign.Center);
      }
      .width('100%')
      .justifyContent(FlexAlign.SpaceBetween)
      .alignItems(VerticalAlign.Center);

      // 分隔线
      Divider().strokeWidth(1).color(this.zc.lineSoft);

      // 底部：三列统计
      Row() {
        this.heroStatCol('登录', `${this.audit.total}`, this.zc.text);
        Column().width(1).height(36).backgroundColor(this.zc.lineSoft);
        this.heroStatCol('已泄露', this.breachedCountLabel(),
          this.breachedItems.length > 0 ? this.zc.danger : this.zc.text);
        Column().width(1).height(36).backgroundColor(this.zc.lineSoft);
        this.heroStatCol('待修复', `${this.actionItems.length}`, this.zc.text);
      }
      .width('100%');
    }
    .width('100%')
    .padding(ZSpacing.xl)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  heroStatCol(label: string, value: string, color: string) {
    Column({ space: 2 }) {
      Text(label)
        .fontSize(ZType.captionSize)
        .fontColor(this.zc.text3)
        .letterSpacing(1);
      Text(value)
        .fontSize(22)
        .fontWeight(FontWeight.Medium)
        .fontColor(color)
        .fontFamily(MONO);
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  statTilesRow() {
    Row({ space: ZSpacing.sm }) {
      this.statTile('已泄露', this.breachedItems.length, $r('app.media.ic_shield_off'),
        this.breachedItems.length === 0 ? this.zc.text2 : this.zc.danger);
      this.statTile('弱密码', this.audit.weak, $r('app.media.ic_warning'),
        this.audit.weak === 0 ? this.zc.text2 : this.zc.warn);
    }
    .width('100%');
  }

  @Builder
  statTile(label: string, count: number, icon: Resource, accent: string) {
    Row({ space: ZSpacing.md }) {
      Column() {
        Image(icon)
          .width(16)
          .height(16)
          .fillColor(accent);
      }
      .width(38)
      .height(38)
      .borderRadius(ZRadius.lg)
      .backgroundColor(alpha1f(accent))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center);

      Column({ space: 1 }) {
        Text(`${count}`)
          .fontSize(22)
          .fontWeight(FontWeight.Medium)
          .fontColor(accent)
          .fontFamily(MONO);
        Text(label)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
    }
    .layoutWeight(1)
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .padding(ZSpacing.md);
  }

  @Builder
  breachCard() {
    Column({ space: ZSpacing.sm }) {
      // 头部：标题 + 时间戳 + 扫描按钮
      Row() {
        Row({ space: ZSpacing.sm }) {
          Image($r('app.media.ic_search'))
            .width(14)
            .height(14)
            .fillColor(this.zc.text3);
          Text('泄露监控')
            .fontSize(ZType.headlineSize)
            .fontColor(this.zc.text);
        }
        .layoutWeight(1);

        Row({ space: ZSpacing.sm }) {
          if (this.scanLastAt > 0) {
            Text(this.formatTime(this.scanLastAt))
              .fontSize(ZType.captionSize)
              .fontColor(this.zc.text3)
              .fontFamily(MONO);
          }
          Text(this.scanButtonLabel())
            .fontSize(ZType.subheadSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text)
            .backgroundColor(this.zc.bgElev2)
            .borderRadius(ZRadius.lg)
            .height(32)
            .padding({ left: ZSpacing.md, right: ZSpacing.md })
            .textAlign(TextAlign.Center)
            .enabled(this.scanStatus !== 'scanning')
            .opacity(this.scanStatus === 'scanning' ? 0.5 : 1)
            .onClick(() => this.onScanBreaches(true));
        }
        .alignItems(VerticalAlign.Center);
      }
      .width('100%')
      .alignItems(VerticalAlign.Center);

      // 主体：按状态分支
      if (this.scanStatus === 'idle') {
        this.breachIdleBody();
      } else if (this.scanStatus === 'scanning') {
        this.breachScanningBody();
      } else if (this.scanStatus === 'error') {
        Text(this.scanError)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.danger)
          .width('100%');
      } else if (this.breachedItems.length === 0 && this.breachErrorCount === 0) {
        this.breachClearBody();
      } else if (this.breachedItems.length === 0 && this.breachErrorCount > 0) {
        this.breachErrorOnlyBody();
      } else {
        this.breachFoundBody();
      }

      // 页脚
      Text('由 Have I Been Pwned 提供支持')
        .fontSize(ZType.captionSize)
        .fontColor(this.zc.text4)
        .fontFamily(MONO)
        .letterSpacing(0.8)
        .textAlign(TextAlign.Center)
        .width('100%')
        .margin({ top: ZSpacing.xs });
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  breachIdleBody() {
    Column({ space: ZSpacing.sm }) {
      Image($r('app.media.ic_lock_shield'))
        .width(28)
        .height(28)
        .fillColor(this.zc.text3);
      Text('仅发送密码 SHA-1 哈希的前 5 位 — HIBP 无法得知你的真实密码')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center)
        .constraintSize({ maxWidth: 280 });
    }
    .width('100%')
    .padding({ top: ZSpacing.xl, bottom: ZSpacing.xl })
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  breachScanningBody() {
    Row({ space: ZSpacing.sm }) {
      LoadingProgress()
        .width(20)
        .height(20)
        .color(this.zc.text3);
      Text('正在扫描…')
        .fontSize(ZType.subheadSize)
        .fontColor(this.zc.text3)
        .fontFamily(MONO);
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ top: ZSpacing.xl, bottom: ZSpacing.xl });
  }

  @Builder
  breachClearBody() {
    Column({ space: ZSpacing.xs }) {
      Column() {
        Image($r('app.media.ic_shield_check'))
          .width(24)
          .height(24)
          .fillColor(this.zc.ok);
      }
      .width(56)
      .height(56)
      .borderRadius(ZRadius.xl)
      .backgroundColor(alpha1f(this.zc.ok))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.xs });

      Text('未发现泄露')
        .fontSize(ZType.headlineSize)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text('所有密码均未出现在已知泄露数据中')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center);
    }
    .width('100%')
    .padding({ top: ZSpacing.lg, bottom: ZSpacing.lg })
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  breachErrorOnlyBody() {
    Column({ space: ZSpacing.xs }) {
      Column() {
        Image($r('app.media.ic_warning'))
          .width(24)
          .height(24)
          .fillColor(this.zc.warn);
      }
      .width(56)
      .height(56)
      .borderRadius(ZRadius.xl)
      .backgroundColor(alpha1f(this.zc.warn))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.xs });

      Text(`${this.breachErrorCount} 条扫描失败`)
        .fontSize(ZType.headlineSize)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text('请检查网络后重试')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center);
    }
    .width('100%')
    .padding({ top: ZSpacing.lg, bottom: ZSpacing.lg })
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  breachFoundBody() {
    Column({ space: ZSpacing.md }) {
      Row({ space: ZSpacing.xs }) {
        Image($r('app.media.ic_shield_off'))
          .width(16)
          .height(16)
          .fillColor(this.zc.danger);
        Text(`发现 ${this.breachedItems.length} 个密码已泄露`)
          .fontSize(ZType.subheadSize)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.danger);
      }
      .width('100%')
      .alignItems(VerticalAlign.Center);

      if (this.breachErrorCount > 0) {
        Text(`另有 ${this.breachErrorCount} 条扫描失败，建议重试`)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.warn)
          .width('100%');
      }

      Column() {
        ForEach(this.breachedItems, (r: BreachResult, idx: number) => {
          Column() {
            Row({ space: ZSpacing.md }) {
              Column() {
                Text(this.firstChar(this.resolveName(r)))
                  .fontSize(13)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.zc.danger)
                  .fontFamily(MONO);
              }
              .width(32)
              .height(32)
              .borderRadius(ZRadius.md)
              .backgroundColor(alpha1f(this.zc.danger))
              .justifyContent(FlexAlign.Center)
              .alignItems(HorizontalAlign.Center);

              Column({ space: 2 }) {
                Text(this.resolveName(r))
                  .fontSize(ZType.subheadSize)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.zc.text)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis });
                Text(`已暴露 ${r.count} 次`)
                  .fontSize(ZType.footnoteSize)
                  .fontColor(this.zc.text3)
                  .fontFamily(MONO);
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1);

              Text('已泄露')
                .fontSize(ZType.captionSize)
                .fontColor(this.zc.danger)
                .backgroundColor(alpha1f(this.zc.danger))
                .borderRadius(ZRadius.md)
                .padding({ left: 6, right: 6, top: 2, bottom: 2 });

              Image($r('app.media.ic_chevron_right'))
                .width(14)
                .height(14)
                .fillColor(this.zc.text4);
            }
            .width('100%')
            .height(52)
            .alignItems(VerticalAlign.Center)
            .padding({ left: ZSpacing.md, right: ZSpacing.md })
            .onClick(() => this.onOpenItem(r.itemId));

            if (idx < this.breachedItems.length - 1) {
              Divider()
                .strokeWidth(1)
                .color(this.zc.lineSoft)
                .margin({ left: ZSpacing.md + 32 + ZSpacing.md });
            }
          }
          .width('100%');
        }, (r: BreachResult) => r.itemId);
      }
      .width('100%')
      .backgroundColor(this.zc.bgElev2)
      .borderRadius(ZRadius.lg)
      .clip(true);
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder
  actionCard() {
    Column({ space: ZSpacing.sm }) {
      Row() {
        Row({ space: ZSpacing.sm }) {
          Image($r('app.media.ic_bolt'))
            .width(14)
            .height(14)
            .fillColor(this.zc.text3);
          Text('行动建议')
            .fontSize(ZType.headlineSize)
            .fontColor(this.zc.text);
        }
        .layoutWeight(1);

        if (this.actionItems.length > 0) {
          Text(`${this.actionItems.length}`)
            .fontSize(ZType.captionSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.actionItems.length > 5 ? this.zc.danger : this.zc.warn)
            .backgroundColor(alpha1f(this.actionItems.length > 5 ? this.zc.danger : this.zc.warn))
            .borderRadius(ZRadius.md)
            .padding({ left: 6, right: 6, top: 2, bottom: 2 });
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center);

      if (this.actionItems.length === 0) {
        this.actionEmptyBody();
      } else {
        Column() {
          ForEach(this.actionItems, (issue: ActionIssue, idx: number) => {
            Column() {
              Row({ space: ZSpacing.md }) {
                Column() {
                  Text(this.firstChar(issue.name))
                    .fontSize(13)
                    .fontWeight(FontWeight.Bold)
                    .fontColor(this.zc.danger)
                    .fontFamily(MONO);
                }
                .width(32)
                .height(32)
                .borderRadius(ZRadius.md)
                .backgroundColor(alpha1f(this.zc.danger))
                .justifyContent(FlexAlign.Center)
                .alignItems(HorizontalAlign.Center);

                Column({ space: 2 }) {
                  Text(issue.name)
                    .fontSize(ZType.subheadSize)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(this.zc.text)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis });
                  Text(issue.severity === 'breach' ? `已暴露 ${issue.count} 次` : `强度 ${issue.strength}`)
                    .fontSize(ZType.footnoteSize)
                    .fontColor(this.zc.text3)
                    .fontFamily(MONO);
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1);

                Text(issue.severity === 'breach' ? '已泄露' : '弱')
                  .fontSize(ZType.captionSize)
                  .fontColor(this.zc.danger)
                  .backgroundColor(alpha1f(this.zc.danger))
                  .borderRadius(ZRadius.md)
                  .padding({ left: 6, right: 6, top: 2, bottom: 2 });

                Image($r('app.media.ic_chevron_right'))
                  .width(14)
                  .height(14)
                  .fillColor(this.zc.text4);
              }
              .width('100%')
              .height(52)
              .alignItems(VerticalAlign.Center)
              .padding({ left: ZSpacing.md, right: ZSpacing.md })
              .onClick(() => this.onOpenItem(issue.id));

              if (idx < this.actionItems.length - 1) {
                Divider()
                  .strokeWidth(1)
                  .color(this.zc.lineSoft)
                  .margin({ left: ZSpacing.md + 32 + ZSpacing.md });
              }
            }
            .width('100%');
          }, (issue: ActionIssue) => `${issue.id}-${issue.severity}`);
        }
        .width('100%')
        .backgroundColor(this.zc.bgElev2)
        .borderRadius(ZRadius.lg)
        .clip(true);
      }
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  actionEmptyBody() {
    Column({ space: ZSpacing.xs }) {
      Column() {
        Image($r('app.media.ic_shield_check'))
          .width(24)
          .height(24)
          .fillColor(this.zc.ok);
      }
      .width(56)
      .height(56)
      .borderRadius(ZRadius.xl)
      .backgroundColor(alpha1f(this.zc.ok))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.xs });

      Text('全部清理')
        .fontSize(ZType.headlineSize)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text('暂无紧急问题')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center);
    }
    .width('100%')
    .padding({ top: ZSpacing.lg, bottom: ZSpacing.lg })
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  histogramCard() {
    Column({ space: ZSpacing.md }) {
      Row({ space: ZSpacing.sm }) {
        Image($r('app.media.ic_bar_chart'))
          .width(14)
          .height(14)
          .fillColor(this.zc.text3);
        Text('强度分布')
          .fontSize(ZType.headlineSize)
          .fontColor(this.zc.text);
      }
      .width('100%')
      .alignItems(VerticalAlign.Center);

      if (this.audit.withPassword === 0) {
        Column() {
          Text('暂无登录条目可统计')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3);
        }
        .width('100%')
        .height(96)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center);
      } else {
        // 柱状区
        Row({ space: ZSpacing.sm }) {
          ForEach(this.audit.histogram, (b: number, i: number) => {
            Column() {
              Text(`${b}`)
                .fontSize(10)
                .fontColor(this.zc.text2)
                .fontFamily(MONO)
                .margin({ bottom: 4 });
              Column()
                .width('100%')
                .height(this.barHeight(b))
                .borderRadius({ topLeft: ZRadius.sm, topRight: ZRadius.sm })
                .backgroundColor(this.binColor(i))
                .opacity(b === 0 ? 0.2 : 1);
            }
            .layoutWeight(1)
            .height(96)
            .justifyContent(FlexAlign.End)
            .alignItems(HorizontalAlign.Center);
          }, (b: number, i: number) => `${i}`);
        }
        .width('100%')
        .height(96)
        .alignItems(VerticalAlign.Bottom);

        // 标签区
        Row({ space: ZSpacing.sm }) {
          ForEach(HIST_LABELS, (lbl: string) => {
            Column() {
              Text(lbl)
                .fontSize(9)
                .fontColor(this.zc.text4)
                .fontFamily(MONO)
                .letterSpacing(0.4);
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Center);
          }, (lbl: string) => lbl);
        }
        .width('100%');
      }
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }
}
