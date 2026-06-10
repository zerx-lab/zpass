// Authenticator —— 验证器实时码列表页
//
// 列出所有「含 TOTP」的条目（独立 totp + 携带 totp 的 login），每行展示
// 实时验证码 + 倒计时。点击进 TotpDetail 大屏。
//
// 实时刷新（见 advisor）：用单个 setInterval 累加一个 @Local tick 计数器，
// 行内 code / remaining 通过读取 this.tick 建立依赖 → 每秒重渲。
// 每条的 OtpMeta 在 reload 时 resolveOtpMeta 一次后缓存进 entries，不在每 tick 重解析。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { itemHasTotp, type ItemPayload } from '../lib/VaultService';
import {
  computeOtp,
  formatTotpCode,
  otpRemaining,
  resolveOtpMeta,
  type OtpMeta,
} from '../lib/Totp';
import { typeLabel } from '../lib/Format';
import { faviconSourceForItem } from '../lib/Favicon';
import { Favicon } from '../components/Favicon';
import { copyEphemeral } from '../lib/Clipboard';
import { promptAction, router } from '@kit.ArkUI';

interface AuthEntry {
  item: ItemPayload;
  meta: OtpMeta;
}

@Entry
@ComponentV2
struct Authenticator {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local entries: AuthEntry[] = [];
  /** 每秒 +1，驱动行内实时码 / 倒计时重渲 */
  @Local tick: number = 0;

  private timer: number = -1;

  aboutToAppear(): void {
    this.reload();
    this.startTimer();
  }

  aboutToDisappear(): void {
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  onPageShow(): void {
    this.reload();
  }

  private async reload(): Promise<void> {
    await this.store.refresh();
    const list: AuthEntry[] = [];
    for (const it of this.store.items) {
      if (!itemHasTotp(it)) continue;
      const secret = this.extractSecret(it);
      if (!secret) continue;
      const meta = resolveOtpMeta(secret);
      if (!meta) continue;
      list.push({ item: it, meta });
    }
    this.entries = list;
  }

  private extractSecret(it: ItemPayload): string | undefined {
    const f = it.fields;
    if (it.type === 'login') return f.totp as string | undefined;
    if (it.type === 'totp') return f.secret as string | undefined;
    return undefined;
  }

  private startTimer(): void {
    if (this.timer !== -1) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.tick = this.tick + 1;
    }, 1000);
  }

  /* ---- 行内实时值（读 this.tick 建立每秒依赖） ---- */

  private codeText(meta: OtpMeta): string {
    const t = this.tick;
    return t >= 0 ? formatTotpCode(computeOtp(meta)) : '------';
  }

  private remainingSec(meta: OtpMeta): number {
    const t = this.tick;
    if (t < 0) return meta.period;
    if (meta.type === 'hotp') return meta.period;
    return otpRemaining(meta);
  }

  private isUrgent(meta: OtpMeta): boolean {
    return meta.type !== 'hotp' && this.remainingSec(meta) <= 5;
  }

  private subtitle(it: ItemPayload): string {
    const f = it.fields;
    if (it.type === 'login') {
      return (f.username as string | undefined) ?? typeLabel('login');
    }
    return (f.account as string | undefined) ?? (f.issuer as string | undefined) ?? '验证器';
  }

  private async onTapItem(it: ItemPayload): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/TotpDetail', params: { id: it.id } });
    } catch (_e) {
      // 忽略
    }
  }

  /** 点击行：快速复制当前验证码（copyEphemeral 超时后自清） */
  private async copyCode(e: AuthEntry): Promise<void> {
    try {
      await copyEphemeral(computeOtp(e.meta));
      promptAction.showToast({ message: '验证码已复制', duration: 1200 });
    } catch (_e) {
      // 忽略
    }
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // 顶栏
      Row() {
        Column() {
          Image($r('app.media.ic_chevron_left'))
            .width(20)
            .height(20)
            .fillColor(this.zc.text2);
        }
        .width(36)
        .height(36)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .onClick(() => router.back());

        Text('验证器')
          .fontSize(ZType.titleSize)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .layoutWeight(1)
          .margin({ left: ZSpacing.xs });

        Row().width(36).height(36);
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: ZSpacing.xs, bottom: ZSpacing.sm });

      if (this.entries.length === 0) {
        this.emptyState();
      } else {
        List({ space: ZSpacing.md }) {
          ForEach(this.entries, (e: AuthEntry) => {
            ListItem() {
              this.authRow(e);
            }
            // 点击快速复制验证码；长按进详情大屏
            .onClick(() => this.copyCode(e))
            .gesture(LongPressGesture().onAction(() => this.onTapItem(e.item)));
          // key 编入 revision：同 key 复用不重绘，编辑保存后返回需刷新行内容
          }, (e: AuthEntry) => `${e.item.id}:${e.item.revision ?? 0}`);

          ListItem() {
            Row().height(ZSpacing.xl + this.safeArea.bottom).width('100%');
          }
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.sm });
      }
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
  authRow(e: AuthEntry) {
    Row({ space: ZSpacing.md }) {
      // favicon（站点图标 / 字形回退）
      Favicon({
        name: e.item.name,
        host: faviconSourceForItem(e.item.type, e.item.fields),
        boxSize: 40,
        radius: ZRadius.lg,
        fontSize: 15,
      });

      // 名称 + 副标题
      Column({ space: 2 }) {
        Text(e.item.name)
          .fontSize(ZType.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
        Text(this.subtitle(e.item))
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      // 实时码
      Text(this.codeText(e.meta))
        .fontSize(ZType.titleSize)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.isUrgent(e.meta) ? this.zc.danger : this.zc.text)
        .fontFamily('HarmonyOS Sans Condensed')
        .letterSpacing(1)
        .flexShrink(0);

      // 倒计时圆
      Column() {
        Text(`${this.remainingSec(e.meta)}`)
          .fontSize(ZType.captionSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.isUrgent(e.meta) ? this.zc.danger : this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed');
      }
      .width(26)
      .height(26)
      .borderRadius(13)
      .border({ width: 1.5, color: this.isUrgent(e.meta) ? this.zc.danger : this.zc.info })
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .flexShrink(0);
    }
    .width('100%')
    .padding(ZSpacing.md)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .alignItems(VerticalAlign.Center);
  }

  @Builder
  emptyState() {
    Column({ space: ZSpacing.sm }) {
      Column() {
        Image($r('app.media.ic_shield'))
          .width(28)
          .height(28)
          .fillColor(this.zc.text3);
      }
      .width(56)
      .height(56)
      .borderRadius(ZRadius.xl)
      .backgroundColor(this.zc.bgElev)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.sm });

      Text('没有验证码')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text('在登录条目里添加 TOTP 密钥，或新建验证器条目')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center);
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl, top: ZSpacing.xxxl });
  }
}
