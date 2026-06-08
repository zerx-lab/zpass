// Trash —— 回收站
//
// 列出软删除（tombstone）条目，支持「恢复」。
// 不提供物理彻底删除：sync 模型下对端 tombstone 会复活本地物理删除，purge
// 名不副实（见 VaultService.restoreItem 注释）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import type { ItemPayload } from '../lib/VaultService';
import { faviconColor, faviconInitials, relativeTime, typeLabel } from '../lib/Format';
import { promptAction, router } from '@kit.ArkUI';

@Entry
@ComponentV2
struct Trash {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local deleted: ItemPayload[] = [];

  aboutToAppear(): void {
    this.reload();
  }

  onPageShow(): void {
    this.reload();
  }

  private async reload(): Promise<void> {
    try {
      this.deleted = await this.store.listDeleted();
    } catch (_e) {
      this.deleted = [];
    }
  }

  private async onRestore(it: ItemPayload): Promise<void> {
    try {
      await this.store.restoreItem(it.id);
      promptAction.showToast({ message: `已恢复「${it.name}」`, duration: 1500 });
      await this.reload();
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1500 });
    }
  }

  private deletedSubtitle(it: ItemPayload): string {
    const when = typeof it.deletedAt === 'number' && it.deletedAt > 0 ? relativeTime(it.deletedAt) : '';
    const label = typeLabel(it.type);
    return when ? `${label} · 删除于 ${when}` : label;
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

        Text('回收站')
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

      if (this.deleted.length === 0) {
        this.emptyState();
      } else {
        List({ space: ZSpacing.md }) {
          ForEach(this.deleted, (it: ItemPayload) => {
            ListItem() {
              this.trashRow(it);
            }
          }, (it: ItemPayload) => it.id);

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
  trashRow(it: ItemPayload) {
    Row({ space: ZSpacing.md }) {
      Column() {
        Text(faviconInitials(it.name))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.faviconInk);
      }
      .width(40)
      .height(40)
      .borderRadius(ZRadius.lg)
      .backgroundColor(faviconColor(it.name))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .flexShrink(0)
      .opacity(0.6);

      Column({ space: 2 }) {
        Text(it.name)
          .fontSize(ZType.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
        Text(this.deletedSubtitle(it))
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      // 恢复按钮（描边自绘）
      Text('恢复')
        .fontSize(ZType.subheadSize)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.zc.text)
        .height(32)
        .padding({ left: ZSpacing.md, right: ZSpacing.md })
        .borderRadius(ZRadius.md)
        .border({ width: 1, color: this.zc.line })
        .textAlign(TextAlign.Center)
        .flexShrink(0)
        .onClick(() => this.onRestore(it));
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
        Image($r('app.media.ic_trash'))
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

      Text('回收站为空')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text('删除的条目会暂存在这里，可随时恢复')
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
