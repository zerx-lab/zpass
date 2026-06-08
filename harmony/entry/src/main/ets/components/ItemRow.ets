// ItemRow —— 单条 vault item 行（纯展示组件）
//
// 抽自原 VaultTab.itemRow，供 VaultList / 任意列表页 ForEach 复用。
// 设计原则（见 advisor）：单条子组件 @Param item，是 item 的纯函数；
// 点击 / 滑动等交互由外层 ListItem 负责，本组件只渲染视觉内容。
//
// 视觉：字形 favicon + 名称行(名称 + 收藏星 + 2FA badge + 泄露 badge)
//      + 副标题 + 右侧(更新时间 + login 密码强度条)。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import type { ItemPayload } from '../lib/VaultService';
import { relativeTime, typeLabel } from '../lib/Format';
import { faviconSourceForItem } from '../lib/Favicon';
import { Favicon } from './Favicon';
import { estimateStrength } from '../lib/Password';

@ComponentV2
export struct ItemRow {
  @Param @Require item: ItemPayload;
  @Local zc: ZColorsClass = ZColors;

  build() {
    Row({ space: ZSpacing.md }) {
      // favicon（站点图标 / 字形回退）
      Favicon({
        name: this.item.name,
        host: faviconSourceForItem(this.item.type, this.item.fields),
        boxSize: 38,
        radius: ZRadius.lg,
        fontSize: 15,
      });

      // 中间：名称行 + 副标题
      Column({ space: 2 }) {
        Row({ space: ZSpacing.xs }) {
          Text(this.item.name)
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1);

          if (this.isFavorite()) {
            Image($r('app.media.ic_star'))
              .width(11)
              .height(11)
              .fillColor(this.zc.warn);
          }

          if (this.hasTotp()) {
            Text('2FA')
              .fontSize(ZType.captionSize)
              .fontColor('#ffffff')
              .backgroundColor(this.zc.info)
              .borderRadius(ZRadius.sm)
              .padding({ left: 4, right: 4, top: 2, bottom: 2 });
          }

          if (this.isBreached()) {
            Row({ space: 2 }) {
              Image($r('app.media.ic_warning'))
                .width(10)
                .height(10)
                .fillColor('#ffffff');
            }
            .padding({ left: 4, right: 4, top: 2, bottom: 2 })
            .backgroundColor(this.zc.danger)
            .borderRadius(ZRadius.sm);
          }
        }
        .width('100%');

        Text(this.subtitle())
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      // 右侧：时间 + 强度进度条（login）
      Column({ space: 5 }) {
        Text(relativeTime(this.item.updatedAt))
          .fontSize(ZType.captionSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed');

        if (this.item.type === 'login' && this.loginStrength() !== undefined) {
          Column() {
            this.strengthBar(this.loginStrength() ?? 0);
          }
          .width(36);
        }
      }
      .alignItems(HorizontalAlign.End)
      .flexShrink(0);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    });
  }

  @Builder
  strengthBar(score: number) {
    Stack({ alignContent: Alignment.Start }) {
      Row()
        .width(36)
        .height(3)
        .borderRadius(2)
        .backgroundColor(this.zc.lineSoft);
      Row()
        .width(score > 0 ? Math.round((score / 100) * 36) : 0)
        .height(3)
        .borderRadius(2)
        .backgroundColor(this.strengthColor(score));
    }
    .width(36)
    .height(3);
  }

  private isFavorite(): boolean {
    return (this.item.fields.favorite as boolean | undefined) === true;
  }

  private isBreached(): boolean {
    return this.item.type === 'login' && (this.item.fields.breached as boolean | undefined) === true;
  }

  private hasTotp(): boolean {
    const t = this.item.fields.totp;
    return this.item.type === 'login' && typeof t === 'string' && (t as string).length > 0;
  }

  private loginStrength(): number | undefined {
    const it = this.item;
    if (it.type !== 'login') return undefined;
    const s = it.fields.strength;
    if (typeof s === 'number') return s as number;
    const pw = it.fields.password;
    if (typeof pw === 'string' && (pw as string).length > 0) {
      return estimateStrength(pw as string).score;
    }
    return undefined;
  }

  private strengthColor(score: number): string {
    if (score >= 80) return this.zc.ok;
    if (score >= 50) return this.zc.warn;
    return this.zc.danger;
  }

  /** 与原 VaultTab.getSubtitle 一致的副标题派生 */
  private subtitle(): string {
    const it = this.item;
    const f = it.fields;
    switch (it.type) {
      case 'login':
        return (f.username as string | undefined) ?? '';
      case 'card': {
        const n = (f.number as string | undefined) ?? '';
        const last4 = n.replace(/\s/g, '').slice(-4);
        return last4 ? `•••• ${last4}` : '支付卡';
      }
      case 'note':
        return ((f.note as string | undefined) ?? '安全笔记').split('\n')[0];
      case 'identity':
        return (f.email as string | undefined) ?? '';
      case 'ssh':
        return (f.apiKey as string | undefined)
          ? 'API Token'
          : ((f.username as string | undefined) ?? (f.keyType as string | undefined) ?? 'SSH');
      case 'passkey':
        return (f.rpId as string | undefined) ?? '';
      case 'totp':
        return ((f.account as string | undefined) ?? (f.issuer as string | undefined) ?? 'TOTP');
      default:
        return typeLabel(it.type);
    }
  }
}
