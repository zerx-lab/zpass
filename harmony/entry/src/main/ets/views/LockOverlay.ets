// LockOverlay —— 解锁界面（与 phone/components/lock-overlay.tsx 对齐）
//
// 当 vault 已初始化但未解锁时显示。提供：
//  - SpaceAvatar + 危险徽标（lock badge）
//  - 主密码输入（带前置图标 + 错误边框 + disabled-during-busy）
//  - 解锁按钮（idle: icon + label；busy: LoadingProgress + label）
//  - "使用设备解锁"按钮（仅 supported && enabled 时）
//
// 显示规则由 pages/Index 控制；本组件只关心解锁动作。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { promptAction } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { SpaceAvatar } from '../components/SpaceAvatar';
import { securityStore } from '../state/SecurityStore';

@ComponentV2
export struct LockOverlay {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local password: string = '';
  @Local errorText: string = '';
  /** 生物识别尝试中（含 aboutToAppear 自动触发） */
  @Local trustedTrying: boolean = false;

  /** 当前活跃空间名 —— 锁定态尚未读到 plaintext spaces 时返回 undefined */
  private activeSpaceName(): string | undefined {
    const id = this.store.activeSpaceId;
    if (!id) return undefined;
    return this.store.spaces.find((s) => s.id === id)?.name;
  }

  aboutToAppear(): void {
    // 仅冷启动 / 手动锁定时自动生物解锁；「切后台锁定」由 onForeground 回前台后才触发
    if (this.store.trustedSupported && this.store.trustedEnabled && !securityStore.lockedByBackground) {
      this.trustedTrying = true;
      this.store.tryAutoUnlock()
        .catch(() => {
          // tryAutoUnlock 内部已吞错；此处兜底
        })
        .finally(() => {
          this.trustedTrying = false;
        });
    }
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
    if (this.trustedTrying || this.store.busy) return;
    this.trustedTrying = true;
    try {
      const ok = await this.store.tryAutoUnlock();
      if (!ok) {
        promptAction.showToast({ message: '生物解锁失败', duration: 1500 });
      }
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    } finally {
      this.trustedTrying = false;
    }
  }

  /** 解锁按钮内容：busy 时显示 LoadingProgress，否则显示 ic_lock_shield 图标 */
  @Builder
  unlockButtonContent() {
    Row({ space: ZSpacing.sm }) {
      if (this.store.busy) {
        LoadingProgress()
          .width(20).height(20)
          .color(this.zc.accentInk);
      } else {
        Image($r('app.media.ic_lock_shield'))
          .width(18).height(18)
          .fillColor(this.zc.accentInk);
      }
      Text(this.store.busy ? '解锁中…' : '解锁')
        .fontSize(ZType.bodySize)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.zc.accentInk);
    }
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center);
  }

  /** 生物解锁按钮内容：tryingState 时显示 LoadingProgress，否则显示 ic_face 图标 + 文字 */
  @Builder
  trustedButtonContent() {
    Row({ space: ZSpacing.sm }) {
      if (this.trustedTrying) {
        LoadingProgress()
          .width(20).height(20)
          .color(this.zc.info);
      } else {
        Image($r('app.media.ic_face'))
          .width(18).height(18)
          .fillColor(this.zc.info);
        Text('使用设备解锁')
          .fontSize(ZType.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.info);
      }
    }
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center);
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      Column({ space: ZSpacing.xl }) {
        // ── logo / 空间名 / 副标题 ──
        Column({ space: ZSpacing.xs }) {
          // SpaceAvatar + 危险 lock badge（lock 图标叠加在右下角）
          Stack({ alignContent: Alignment.BottomEnd }) {
            SpaceAvatar({
              avatarName: this.activeSpaceName(),
              avatarSize: 72,
              avatarBg: this.zc.accent,
              avatarFg: this.zc.accentInk,
              avatarFontSize: 32,
              avatarRadius: ZRadius.xl + 4,
            });

            // 危险徽标：22x22 圆形，danger 背景，bg 色 2vp 边框，白色 lock 图标
            Column() {
              Image($r('app.media.ic_lock'))
                .width(11).height(11)
                .fillColor('#ffffff');
            }
            .width(22).height(22)
            .borderRadius(11)
            .backgroundColor(this.zc.danger)
            .border({ width: 2, color: this.zc.bg })
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            .offset({ x: 2, y: 2 });
          }
          .margin({ bottom: ZSpacing.md });

          // 标题：使用活跃空间名（与 phone activeSpace?.name ?? 'ZPass' 对齐）
          Text(this.activeSpaceName() ?? 'ZPass')
            .fontSize(ZType.titleSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text);

          Text('输入主密码以解锁保险库')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3);
        }
        .alignItems(HorizontalAlign.Center);

        // ── 密码输入区 ──
        Column({ space: ZSpacing.sm }) {
          // 输入框：Row 外壳提供背景 + 圆角 + 错误边框，内置前置 lock 图标
          Row({ space: ZSpacing.sm }) {
            Image($r('app.media.ic_lock'))
              .width(16).height(16)
              .fillColor(this.zc.text3);

            TextInput({ placeholder: '主密码', text: this.password })
              .type(InputType.Password)
              .placeholderColor(this.zc.text3)
              .placeholderFont({ size: ZType.bodySize })
              .fontColor(this.zc.text)
              .fontSize(ZType.bodySize)
              .backgroundColor('#00000000')
              .borderRadius(0)
              .padding(0)
              .layoutWeight(1)
              .height(48)
              .enabled(!this.store.busy)
              .onChange((v: string) => {
                this.password = v;
                this.errorText = '';
              })
              .onSubmit(() => this.onUnlock());
          }
          .width('100%')
          .height(50)
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.lg)
          .border({ width: 1, color: this.errorText ? this.zc.danger : 'transparent' })
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .alignItems(VerticalAlign.Center);

          // 错误行：图标 + 错误文字（高度占位保持布局稳定）
          if (this.errorText) {
            Row({ space: 5 }) {
              Image($r('app.media.ic_error'))
                .width(12).height(12)
                .fillColor(this.zc.danger);
              Text(this.errorText)
                .fontSize(ZType.footnoteSize)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.zc.danger)
                .layoutWeight(1);
            }
            .width('100%')
            .alignItems(VerticalAlign.Center);
          } else {
            Row().height(16).width('100%');
          }

          // 解锁按钮（主操作，accent 实底）
          Row() {
            this.unlockButtonContent();
          }
          .width('100%')
          .height(48)
          .borderRadius(ZRadius.lg)
          .backgroundColor(this.store.busy ? this.zc.text3 : this.zc.accent)
          .justifyContent(FlexAlign.Center)
          .alignItems(VerticalAlign.Center)
          .enabled(!this.store.busy)
          .onClick(() => this.onUnlock());

          // 生物解锁按钮（仅 supported && enabled 时显示）
          if (this.store.trustedSupported && this.store.trustedEnabled) {
            Row() {
              this.trustedButtonContent();
            }
            .width('100%')
            .height(48)
            .borderRadius(ZRadius.lg)
            .backgroundColor(this.zc.bgElev)
            .justifyContent(FlexAlign.Center)
            .alignItems(VerticalAlign.Center)
            .opacity(this.store.busy || this.trustedTrying ? 0.6 : 1.0)
            .enabled(!this.store.busy && !this.trustedTrying)
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
      })
      .justifyContent(FlexAlign.Center)
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
