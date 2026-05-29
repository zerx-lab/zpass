// TotpDetail —— TOTP 大屏验证码详情页
//
// 路由参数：{ id: string }
//
// 与 phone/app/totp/[id].tsx 行为对齐：
//   - 大号代码（每周期刷新；剩余 ≤ 5s 标红）
//   - 周期进度条（按 elapsed / period 渲染，配 animation 实现平滑过渡）
//   - 服务标签 chip（favicon + 名称 + 账号）
//   - 元信息卡（服务 / 账号 / 算法 line）
//   - 复制按钮（copyEphemeral，30s 自动清空）
//
// 数据源：兼容两种条目类型
//   - type === 'login' 取 fields.totp（与 phone item.totp 字段一致）
//   - type === 'totp'  取 fields.secret
//
// HOTP 不支持进度条（计数器不会自动递增），改为显示计数器值。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore } from '../state/VaultStore';
import type { ItemPayload } from '../lib/VaultService';
import {
  computeOtp,
  formatTotpCode,
  otpElapsed,
  otpRemaining,
  resolveOtpMeta,
  type OtpMeta,
} from '../lib/Totp';
import { copyEphemeral } from '../lib/Clipboard';
import { faviconColor, faviconInitials } from '../lib/Format';
import { promptAction, router } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

@Entry
@ComponentV2
struct TotpDetail {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  @Local item: ItemPayload | null = null;
  @Local meta: OtpMeta | null = null;
  @Local errorText: string = '';

  /** 当前周期生成的 code；meta 不可解析时退化为占位 '------' */
  @Local code: string = '------';
  /** 剩余秒数 —— 仅 TOTP / Steam 有意义，HOTP 总等于 period */
  @Local remaining: number = 30;
  /** 已用时长占比（0..1），用来驱动进度条宽度 */
  @Local progressRatio: number = 0;

  private timer: number = -1;

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object> | null;
    if (params && typeof params.id === 'string') {
      this.load(params.id);
    }
  }

  aboutToDisappear(): void {
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  private async load(id: string): Promise<void> {
    try {
      const it = await vaultStore.getItem(id);
      if (!it) {
        this.errorText = '条目不存在';
        return;
      }
      this.item = it;
      const secret = this.extractSecret(it);
      if (!secret) {
        this.errorText = '该条目没有 TOTP 验证码';
        return;
      }
      this.meta = resolveOtpMeta(secret);
      if (!this.meta) {
        this.errorText = '无法解析 TOTP 密钥';
        return;
      }
      this.errorText = '';
      this.tick();
      this.startTimer();
    } catch (e) {
      this.errorText = (e as Error).message;
    }
  }

  private extractSecret(it: ItemPayload): string | undefined {
    const f = it.fields;
    if (it.type === 'login') return f.totp as string | undefined;
    if (it.type === 'totp') return f.secret as string | undefined;
    return undefined;
  }

  private startTimer(): void {
    if (this.timer !== -1) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    if (!this.meta) return;
    this.code = computeOtp(this.meta);
    if (this.meta.type === 'hotp') {
      this.remaining = this.meta.period;
      this.progressRatio = 0;
      return;
    }
    this.remaining = otpRemaining(this.meta);
    const elapsed = otpElapsed(this.meta);
    this.progressRatio = elapsed === 0 ? 0 : elapsed / this.meta.period;
  }

  @Computed
  get isUrgent(): boolean {
    return this.meta !== null && this.meta.type !== 'hotp' && this.remaining <= 5;
  }

  @Computed
  get codeColor(): string {
    return this.isUrgent ? this.zc.danger : this.zc.text;
  }

  @Computed
  get barColor(): string {
    return this.isUrgent ? this.zc.danger : this.zc.info;
  }

  @Computed
  get algoLine(): string {
    const m = this.meta;
    if (!m) return 'SHA-1 · 6 位 · 30s';
    if (m.type === 'hotp') return `${m.algorithm} · ${m.digits} 位 · 计数器 ${m.counter}`;
    if (m.type === 'steam') return `Steam Guard · ${m.algorithm} · ${m.digits} 位 · ${m.period}s`;
    return `${m.algorithm} · ${m.digits} 位 · ${m.period}s`;
  }

  @Computed
  get usernameDisplay(): string {
    const it = this.item;
    if (!it) return '';
    const f = it.fields;
    if (it.type === 'login') return (f.username as string | undefined) ?? '';
    if (it.type === 'totp') {
      const account = (f.account as string | undefined) ?? '';
      const issuer = (f.issuer as string | undefined) ?? '';
      if (this.meta?.account) return this.meta.account;
      if (account) return account;
      if (this.meta?.issuer) return this.meta.issuer;
      return issuer;
    }
    return '';
  }

  private async onCopy(): Promise<void> {
    if (!this.code || this.code.startsWith('-')) return;
    try {
      await copyEphemeral(this.code);
      promptAction.showToast({ message: '已复制（30 秒后清空）', duration: 1500 });
    } catch (_e) {
      promptAction.showToast({ message: '复制失败', duration: 1200 });
    }
  }

  private async onEdit(): Promise<void> {
    if (!this.item) return;
    await router.pushUrl({
      url: 'pages/ItemEdit',
      params: { mode: 'edit', id: this.item.id },
    });
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // 顶栏
      Row({ space: ZSpacing.sm }) {
        Text('返回')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text2)
          .onClick(() => router.back());
        Text('验证码')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center);
        if (this.item) {
          Text('编辑')
            .fontSize(ZType.bodySize)
            .fontColor(this.zc.accent)
            .onClick(() => this.onEdit());
        } else {
          Text('').width(40);
        }
      }
      .width('100%')
      .padding({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.sm,
        bottom: ZSpacing.sm,
      });

      if (this.errorText) {
        Column() {
          Text(this.errorText)
            .fontSize(ZType.bodySize)
            .fontColor(this.zc.text3);
        }
        .layoutWeight(1)
        .width('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center);
      } else if (this.item && this.meta) {
        Scroll() {
          Column() {
            // 服务 chip
            Row({ space: ZSpacing.sm }) {
              Column() {
                Text(faviconInitials(this.item.name))
                  .fontSize(10)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.zc.faviconInk);
              }
              .width(22)
              .height(22)
              .borderRadius(ZRadius.sm)
              .backgroundColor(faviconColor(this.item.name))
              .justifyContent(FlexAlign.Center)
              .alignItems(HorizontalAlign.Center);

              Text(this.item.name)
                .fontSize(ZType.subheadSize)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.zc.text)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis });

              if (this.usernameDisplay) {
                Text(this.usernameDisplay)
                  .fontSize(ZType.footnoteSize)
                  .fontColor(this.zc.text3)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis });
              }
            }
            .padding({
              left: ZSpacing.md,
              right: ZSpacing.md,
              top: 6,
              bottom: 6,
            })
            .backgroundColor(this.zc.bgElev)
            .borderRadius(999)
            .margin({ bottom: ZSpacing.xxxl });

            // 大号验证码
            Text(formatTotpCode(this.code))
              .fontSize(60)
              .fontWeight(FontWeight.Lighter)
              .fontColor(this.codeColor)
              .letterSpacing(4)
              .textAlign(TextAlign.Center)
              .margin({ bottom: ZSpacing.sm });

            // 倒计时 / 计数器
            if (this.meta.type === 'hotp') {
              Text(`HOTP · 计数器 ${this.meta.counter}`)
                .fontSize(ZType.subheadSize)
                .fontColor(this.zc.text3)
                .margin({ bottom: ZSpacing.lg });
            } else {
              Text(`${this.isUrgent ? '即将刷新 · ' : '有效期 · '}${this.remaining}s`)
                .fontSize(ZType.subheadSize)
                .fontColor(this.zc.text3)
                .margin({ bottom: ZSpacing.lg });

              // 进度条
              Stack({ alignContent: Alignment.Start }) {
                Row()
                  .width('100%')
                  .height(4)
                  .borderRadius(2)
                  .backgroundColor(this.zc.bgActive);
                Row()
                  .width(`${Math.min(100, Math.round(this.progressRatio * 100))}%`)
                  .height(4)
                  .borderRadius(2)
                  .backgroundColor(this.barColor)
                  .animation({ duration: 900, curve: Curve.Linear });
              }
              .width('100%')
              .height(4)
              .margin({ bottom: ZSpacing.xxl });
            }

            // 复制按钮
            Text('复制验证码')
              .fontSize(ZType.bodySize)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.zc.accentInk)
              .backgroundColor(this.zc.accent)
              .borderRadius(ZRadius.lg)
              .height(52)
              .width('100%')
              .textAlign(TextAlign.Center)
              .margin({ bottom: ZSpacing.xxxl })
              .onClick(() => this.onCopy());

            // 元信息卡
            Column() {
              this.metaRow('服务', this.item.name, false);
              this.divider();
              if (this.usernameDisplay) {
                this.metaRow('账号', this.usernameDisplay, false);
                this.divider();
              }
              this.metaRow('算法', this.algoLine, true);
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .padding({ left: ZSpacing.lg, right: ZSpacing.lg })
            .margin({ bottom: ZSpacing.lg });

            // 底部提示
            Text(
              this.meta.type === 'hotp'
                ? 'HOTP 按计数器递增 · 复制后 30 秒自动清空剪贴板'
                : `验证码每 ${this.meta.period} 秒自动刷新 · 复制后 30 秒自动清空剪贴板`,
            )
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .textAlign(TextAlign.Center)
              .width('100%')
              .padding({ left: ZSpacing.lg, right: ZSpacing.lg });

            Row().height(40).width('100%');
          }
          .width('100%')
          .constraintSize({ minHeight: '100%' })
          .justifyContent(FlexAlign.Start)
          .alignItems(HorizontalAlign.Center)
          .padding({
            left: ZSpacing.xl + 4,
            right: ZSpacing.xl + 4,
            top: ZSpacing.xxxl,
          });
        }
        .scrollBar(BarState.Off)
        .layoutWeight(1)
        .width('100%')
        .align(Alignment.TopStart);
      }

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Start)
    .align(Alignment.TopStart)
    .backgroundColor(this.zc.bg)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);
  }

  @Builder
  metaRow(label: string, value: string, mono: boolean) {
    Row({ space: ZSpacing.md }) {
      Text(label)
        .fontSize(ZType.subheadSize)
        .fontColor(this.zc.text3)
        .layoutWeight(1);
      Text(value)
        .fontSize(ZType.bodySize)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.zc.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.End)
        .fontFamily(mono ? 'HarmonyOS Sans Condensed' : 'HarmonyOS Sans');
    }
    .width('100%')
    .padding({ top: ZSpacing.md, bottom: ZSpacing.md });
  }

  @Builder
  divider() {
    Divider().strokeWidth(0.5).color(this.zc.lineSoft);
  }
}
