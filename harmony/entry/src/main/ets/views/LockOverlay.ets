// LockOverlay —— 解锁界面（与 phone/components/lock-overlay.tsx 对齐）
//
// 当 vault 已初始化但未解锁时显示。提供：
//  - 主密码输入
//  - 解锁按钮（异步，期间禁用 + loading）
//  - "信任设备解锁"按钮（如果支持）
//
// 显示规则由 pages/Index 控制；本组件只关心解锁动作。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { vaultService } from '../lib/VaultService';
import { promptAction } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { SpaceAvatar } from '../components/SpaceAvatar';

@ComponentV2
export struct LockOverlay {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local password: string = '';
  @Local errorText: string = '';
  /** 仅 supported && enabled 时才显示「生物解锁」按钮 —— 未启用时显示按钮没意义 */
  @Local trustedAvailable: boolean = false;

  /** 当前活跃空间名 —— 锁定态尚未读到 plaintext spaces 时返回 undefined，
   *  SpaceAvatar 将退化到 fallback "Z"。解锁后短暂残留 → 走真名。 */
  private activeSpaceName(): string | undefined {
    const id = this.store.activeSpaceId;
    if (!id) return undefined;
    return this.store.spaces.find((s) => s.id === id)?.name;
  }

  aboutToAppear(): void {
    // 启动时先探测能力 + 启用态；仅"已启用"时才尝试自动弹生物识别
    this.detectTrustedAvailability()
      .then(async () => {
        if (!this.trustedAvailable) return;
        try {
          await this.store.tryAutoUnlock();
        } catch (_e) {
          // tryAutoUnlock 内部已吞错；此处兜底
        }
      })
      .catch(() => {
        // 探测失败时按"不支持"显示，主密码流程不受影响
      });
  }

  private async detectTrustedAvailability(): Promise<void> {
    let supported = false;
    let enabled = false;
    try {
      supported = await vaultService.isTrustedDeviceSupported();
    } catch (_e) {
      supported = false;
    }
    if (supported) {
      try {
        enabled = await vaultService.isTrustedDeviceEnabled();
      } catch (_e) {
        enabled = false;
      }
    }
    this.trustedAvailable = supported && enabled;
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
        promptAction.showToast({ message: '生物解锁失败', duration: 1500 });
        // 失败可能是 absent（key 被系统失效）→ 重新探测一次，避免按钮悬挂
        await this.detectTrustedAvailability();
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
          SpaceAvatar({
            avatarName: this.activeSpaceName(),
            avatarSize: 72,
            avatarBg: this.zc.accent,
            avatarFg: this.zc.accentInk,
            avatarFontSize: 32,
            avatarRadius: ZRadius.xl + 4,
          })
            .margin({ bottom: ZSpacing.md });

          Text('ZPass')
            .fontSize(ZType.largeTitleSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text);
          Text('输入主密码解锁')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3);
        }
        .alignItems(HorizontalAlign.Center);

        // 密码输入
        Column({ space: ZSpacing.sm }) {
          TextInput({ placeholder: '主密码', text: this.password })
            .type(InputType.Password)
            .placeholderColor(this.zc.text3)
            .placeholderFont({ size: ZType.bodySize })
            .fontColor(this.zc.text)
            .fontSize(ZType.bodySize)
            .backgroundColor(this.zc.bgElev)
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
              .fontColor(this.zc.danger)
              .width('100%')
              .textAlign(TextAlign.Start);
          }

          Text(this.store.busy ? '解锁中…' : '解锁')
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.accentInk)
            .backgroundColor(this.store.busy ? this.zc.text3 : this.zc.accent)
            .borderRadius(ZRadius.lg)
            .height(48)
            .width('100%')
            .textAlign(TextAlign.Center)
            .enabled(!this.store.busy)
            .onClick(() => this.onUnlock());

          if (this.trustedAvailable) {
            Text('生物解锁')
              .fontSize(ZType.bodySize)
              .fontColor(this.zc.text2)
              .backgroundColor(this.zc.bgElev)
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
      .padding({
        left: ZSpacing.xl,
        right: ZSpacing.xl,
        top: ZSpacing.xxxl + ZSpacing.xl,
      })
      .justifyContent(FlexAlign.Start)
      .alignItems(HorizontalAlign.Center);

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Start)
    .align(Alignment.TopStart)
    .backgroundColor(this.zc.bg)
    // 键盘弹出时主动让出底部空间（沉浸式窗口下 ArkUI 默认 KeyboardAvoidMode 失效）
    .padding({ bottom: this.safeArea.keyboard });
  }
}
