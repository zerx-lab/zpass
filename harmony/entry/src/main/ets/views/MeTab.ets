// MeTab —— "我的"页：主密码 / 信任设备 / 同步 / 重置
//
// 与 phone/(tabs)/me.tsx 对齐（基础版本，不含云备份 / 信任设备 / 详细的设置项；
// 后续 Phase 5 补齐）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { promptAction, router } from '@kit.ArkUI';
import { exportVaultToFile, importVaultFromFile } from '../lib/Transfer';
import { common } from '@kit.AbilityKit';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

@ComponentV2
export struct MeTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  private async onLock(): Promise<void> {
    this.store.lock();
    promptAction.showToast({ message: '已锁定', duration: 1200 });
  }

  private async onReset(): Promise<void> {
    promptAction
      .showDialog({
        title: '重置保险库？',
        message:
          '将永久删除所有条目与主密码。该操作不可撤销。如果你启用了同步，请先在其它设备完成同步备份。',
        buttons: [
          { text: '取消', color: this.zc.text2 },
          { text: '永久重置', color: this.zc.danger },
        ],
      })
      .then(async (r) => {
        if (r.index === 1) {
          await this.store.reset();
          promptAction.showToast({ message: 'vault 已重置', duration: 1500 });
        }
      });
  }

  private async onSync(): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/Sync' });
    } catch (_e) {
      promptAction.showToast({ message: '同步功能未启用', duration: 1500 });
    }
  }

  private async onExport(): Promise<void> {
    try {
      const ctx = getContext(this) as common.Context;
      const uri = await exportVaultToFile(ctx);
      promptAction.showToast({ message: `已导出到 ${uri}`, duration: 2500 });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  private async onImport(): Promise<void> {
    const r = await promptAction.showDialog({
      title: '从明文 JSON 导入？',
      message: '导入文件不走厄重装，会为每条 item 生成新 id 追加。仅信任自己刚刚导出的文件。',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '选文件', color: this.zc.info },
      ],
    });
    if (r.index !== 1) return;
    try {
      const ctx = getContext(this) as common.Context;
      const n = await importVaultFromFile(ctx);
      await this.store.refreshItems();
      promptAction.showToast({ message: `导入 ${n} 条`, duration: 2000 });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  build() {
    Column({ space: ZSpacing.sm }) {
      Row().height(this.safeArea.top).width('100%');

      Row() {
        Text('我的')
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
        Column({ space: ZSpacing.lg }) {
          // 状态卡
          Column({ space: ZSpacing.xs }) {
            Text(this.store.status.unlocked ? '已解锁' : '已锁定')
              .fontSize(ZType.title2Size)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.store.status.unlocked ? this.zc.ok : this.zc.text2);
            Text(`${this.store.status.itemCount} 个条目`)
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3);
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding(ZSpacing.lg)
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.xl);

          // 操作组
          Column() {
            this.rowAction('立即锁定', '清空内存中的 DEK', () => this.onLock());
            this.divider();
            this.rowAction('设备间同步', 'PAKE 握手 + 端到端加密', () => this.onSync());
            this.divider();
            this.rowAction('导出 Vault（明文 JSON）', '仅迁移 / 备份用', () => this.onExport());
            this.divider();
            this.rowAction('从 JSON 导入', '追加到当前 vault', () => this.onImport());
          }
          .width('100%')
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.xl)
          .clip(true);

          // 危险区
          Column() {
            this.rowDanger('重置保险库', '永久删除所有条目', () => this.onReset());
          }
          .width('100%')
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.xl)
          .clip(true);

          Row().height(80).width('100%');
        }
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
      }
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .width('100%');
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Start)
    .align(Alignment.TopStart)
    .backgroundColor(this.zc.bg);
  }

  @Builder
  rowAction(label: string, sub: string, onTap: () => void) {
    Row() {
      Column({ space: 2 }) {
        Text(label).fontSize(ZType.bodySize).fontColor(this.zc.text);
        Text(sub).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
      Text('›').fontSize(20).fontColor(this.zc.text3);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .onClick(() => onTap());
  }

  @Builder
  rowDanger(label: string, sub: string, onTap: () => void) {
    Row() {
      Column({ space: 2 }) {
        Text(label).fontSize(ZType.bodySize).fontColor(this.zc.danger);
        Text(sub).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .onClick(() => onTap());
  }

  @Builder
  divider() {
    Divider().strokeWidth(0.5).color(this.zc.line).margin({ left: ZSpacing.lg, right: ZSpacing.lg });
  }
}
