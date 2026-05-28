// LockOverlay —— 解锁界面（与 phone/components/lock-overlay.tsx 对齐）
//
// 当 vault 已初始化但未解锁时显示。提供：
//  - 主密码输入
//  - 解锁按钮（异步，期间禁用 + loading）
//  - "信任设备解锁"按钮（如果支持）
//
// 显示规则由 pages/Index 控制；本组件只关心解锁动作。

import { ZColors, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { vaultService } from '../lib/VaultService';
import { promptAction } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

@ComponentV2
export struct LockOverlay {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local store: VaultStore = vaultStore;

  @Local password: string = '';
  @Local errorText: string = '';
  @Local trustedSupported: boolean = false;

  aboutToAppear(): void {
    // 启动时试一次信任设备自动解锁；同时探测能力供 UI 判断是否显示按钮。
    this.store
      .tryAutoUnlock()
      .then(async (ok) => {
        if (ok) return;
        try {
          this.trustedSupported = await vaultService.isTrustedDeviceSupported();
        } catch (_e) {
          this.trustedSupported = false;
        }
      })
      .catch(() => {
        // tryAutoUnlock 内部已吞了大部分错误；这里再兜一层
      });
  }

  private async onUnlock(): Promise<void> {
    if (!this.password) {
      this.errorText = '请输入主密码';
      return;
    }
    this.errorText = '';
    try {
      await this.store.unlock(this.password);
      // 解锁成功：父组件根据 store.isUnlocked() 自动切换到 Tabs
      this.password = '';
    } catch (e) {
      this.errorText = (e as Error).message;
      this.password = '';
    }
  }

  private async onTrusted(): Promise<void> {
    try {
      const ok = await this.store.tryAutoUnlock();
      if (!ok) {
        promptAction.showToast({ message: '信任设备解锁失败', duration: 1500 });
      }
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      Column({ space: ZSpacing.xl }) {
        // logo / 标题
        Column({ space: ZSpacing.xs }) {
          Column() {
            Text('Z')
              .fontSize(28)
              .fontWeight(FontWeight.Bold)
              .fontColor(ZColors.text);
          }
          .width(72)
          .height(72)
          .borderRadius(ZRadius.xl)
          .backgroundColor(ZColors.bgElev)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .margin({ bottom: ZSpacing.md });

          Text('ZPass')
            .fontSize(ZType.largeTitleSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(ZColors.text);
          Text('输入主密码解锁')
            .fontSize(ZType.footnoteSize)
            .fontColor(ZColors.text3);
        }
        .alignItems(HorizontalAlign.Center);

        // 密码输入
        Column({ space: ZSpacing.sm }) {
          TextInput({ placeholder: '主密码', text: this.password })
            .type(InputType.Password)
            .placeholderColor(ZColors.text3)
            .placeholderFont({ size: ZType.bodySize })
            .fontColor(ZColors.text)
            .fontSize(ZType.bodySize)
            .backgroundColor(ZColors.bgElev)
            .borderRadius(ZRadius.lg)
            .padding({ left: ZSpacing.md, right: ZSpacing.md })
            .height(48)
            .width('100%')
            .onChange((v: string) => {
              this.password = v;
              this.errorText = '';
            })
            .onSubmit(() => this.onUnlock());

          if (this.errorText) {
            Text(this.errorText)
              .fontSize(ZType.footnoteSize)
              .fontColor(ZColors.danger)
              .width('100%')
              .textAlign(TextAlign.Start);
          }

          Text(this.store.busy ? '解锁中…' : '解锁')
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(ZColors.accentInk)
            .backgroundColor(this.store.busy ? ZColors.text3 : ZColors.accent)
            .borderRadius(ZRadius.lg)
            .height(48)
            .width('100%')
            .textAlign(TextAlign.Center)
            .enabled(!this.store.busy)
            .onClick(() => this.onUnlock());

          if (this.trustedSupported) {
            Text('使用设备解锁')
              .fontSize(ZType.bodySize)
              .fontColor(ZColors.text2)
              .backgroundColor(ZColors.bgElev)
              .borderRadius(ZRadius.lg)
              .height(48)
              .width('100%')
              .textAlign(TextAlign.Center)
              .onClick(() => this.onTrusted());
          }
        }
        .width('100%');
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: ZSpacing.xl, right: ZSpacing.xl })
      .justifyContent(FlexAlign.Center);

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%')
    .height('100%')
    .backgroundColor(ZColors.bg)
    // 键盘弹出时主动让出底部空间（沉浸式窗口下 ArkUI 默认 KeyboardAvoidMode 失效）
    .padding({ bottom: this.safeArea.keyboard });
  }
}
