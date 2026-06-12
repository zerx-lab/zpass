// MeData —— 「我的 → 数据管理」分组设置页
//
// 分组：
//   - 导入与导出：导入数据 / 导出明文备份
//   - 危险操作：清空所有条目 / 重置 ZPass
//
// 导入导出与清空 / 重置逻辑从 MeTab 迁入，行为不变。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { exportVaultToFile, importVaultFromFile } from '../lib/Transfer';
import { common } from '@kit.AbilityKit';
import type { ItemPayload } from '../lib/VaultService';
import { promptAction, router } from '@kit.ArkUI';
import {
  SettingsRowDanger,
  SettingsRowNav,
  SettingsSectionHeader,
} from '../components/SettingsRows';

@Entry
@ComponentV2
struct MeData {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  private async onImport(): Promise<void> {
    const confirm = await promptAction.showDialog({
      title: '导入数据',
      message: '导入将把文件中的条目合并到当前保险库，重复条目可能被覆盖。确认继续？',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '导入', color: this.zc.danger },
      ],
    });
    if (confirm.index !== 1) return;
    try {
      const ctx = getContext(this) as common.Context;
      const n = await importVaultFromFile(ctx);
      await this.store.refreshItems();
      const r = await promptAction.showDialog({
        title: '导入完成',
        message: `已成功导入 ${n} 个条目到当前保险库。`,
        buttons: [
          { text: '确定', color: this.zc.text },
        ],
      });
      if (r.index === 0) {
        // 确定关闭
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === '未选择文件') return;
      promptAction.showToast({ message: msg, duration: 1800 });
    }
  }

  private async onExport(): Promise<void> {
    if (this.store.items.length === 0) {
      promptAction.showToast({ message: '保险库为空，暂无可导出的条目', duration: 1800 });
      return;
    }
    const r = await promptAction.showDialog({
      title: '导出明文备份',
      message: `备份文件将包含全部 ${this.store.items.length} 个条目的明文内容（含密码、密钥、TOTP 等）。请妥善保管，切勿上传到不可信的位置。`,
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '继续导出', color: this.zc.danger },
      ],
    });
    if (r.index !== 1) return;
    try {
      const ctx = getContext(this) as common.Context;
      const uri = await exportVaultToFile(ctx);
      promptAction.showToast({ message: `已导出到 ${uri}`, duration: 2500 });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  private async onClearAll(): Promise<void> {
    if (this.store.items.length === 0) {
      promptAction.showToast({ message: '保险库已为空', duration: 1500 });
      return;
    }
    const r = await promptAction.showDialog({
      title: '清空保险库',
      message: `将永久删除全部 ${this.store.items.length} 个条目，主密码与加密元数据保留，此操作不可撤销。建议先导出备份。`,
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '清空', color: this.zc.danger },
      ],
    });
    if (r.index !== 1) return;
    try {
      // clearAll 是 sharedNeeds — 当前通过逐条 deleteItem 实现
      const ids = (this.store.items as ItemPayload[]).map((it) => it.id);
      for (const id of ids) {
        await this.store.deleteItem(id);
      }
      promptAction.showToast({ message: '已清空所有条目', duration: 1500 });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  private async onReset(): Promise<void> {
    const r = await promptAction.showDialog({
      title: '重置 ZPass',
      message:
        '将永久删除主密码与所有条目，应用回到初始状态。此操作不可撤销。',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '重置', color: this.zc.danger },
      ],
    });
    if (r.index === 1) {
      await this.store.reset();
      promptAction.showToast({ message: 'ZPass 已重置', duration: 1500 });
      // 重置后回到主页，由 Index 接管初始化引导
      router.back();
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

        Text('数据管理')
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

      Scroll() {
        Column({ space: ZSpacing.sm }) {
          SettingsSectionHeader({ label: '导入与导出' });
          Column() {
            SettingsRowNav({
              label: '导入数据',
              value: 'ZPass JSON',
              icon: $r('app.media.ic_download'),
              onTap: () => this.onImport(),
            });
            this.divider();
            SettingsRowNav({
              label: '导出明文备份',
              value: `${this.store.items.length} 项`,
              icon: $r('app.media.ic_upload'),
              onTap: () => this.onExport(),
            });
          }
          .width('100%')
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.xl)
          .clip(true);

          SettingsSectionHeader({ label: '危险操作' });
          Column() {
            SettingsRowDanger({
              label: '清空所有条目',
              icon: $r('app.media.ic_trash'),
              iconColor: this.zc.warn,
              onTap: () => this.onClearAll(),
            });
            this.divider();
            SettingsRowDanger({
              label: '重置 ZPass',
              icon: $r('app.media.ic_trash'),
              iconColor: this.zc.danger,
              onTap: () => this.onReset(),
            });
          }
          .width('100%')
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.xl)
          .clip(true);

          Row().height(ZSpacing.xl + this.safeArea.bottom).width('100%');
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
    .backgroundColor(this.zc.bg)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);
  }

  @Builder
  divider() {
    Divider().strokeWidth(0.5).color(this.zc.line).margin({ left: ZSpacing.lg, right: ZSpacing.lg });
  }
}
