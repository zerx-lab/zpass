// OnboardingOverlay —— 首次启动设置主密码
//
// 与 phone/components/onboarding-overlay.tsx 行为对齐：
//   - 输入并确认主密码（至少 8 位）
//   - 提交后 vault 立即初始化并进入解锁态
//
// 主密码不可找回 —— 用户应当读懂"不可恢复"提示后再设置。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { estimateStrength, type Strength } from '../lib/Password';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

@ComponentV2
export struct OnboardingOverlay {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local password: string = '';
  @Local confirm: string = '';
  @Local errorText: string = '';

  private async onSubmit(): Promise<void> {
    this.errorText = '';
    if (this.password.length < 8) {
      this.errorText = '主密码至少 8 位';
      return;
    }
    if (this.password !== this.confirm) {
      this.errorText = '两次输入不一致';
      return;
    }
    try {
      await this.store.initialize(this.password);
      this.password = '';
      this.confirm = '';
    } catch (e) {
      this.errorText = (e as Error).message;
    }
  }

  private strengthColor(score: number): string {
    if (score >= 80) return this.zc.ok;
    if (score >= 50) return this.zc.warn;
    if (score > 0) return this.zc.danger;
    return this.zc.text3;
  }

  /** 随 this.password 变化自动重算的密码强度。build() 内不能写 const 语句 */
  @Computed
  get strength(): Strength {
    return estimateStrength(this.password);
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      Scroll() {
        Column({ space: ZSpacing.lg }) {
          Column({ space: ZSpacing.xs }) {
            Text('设置主密码')
              .fontSize(ZType.largeTitleSize)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.zc.text);
            Text('主密码用于派生加密密钥；忘记将无法找回，请妥善保存。')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .lineHeight(18);
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .margin({ top: ZSpacing.xl });

          Column({ space: ZSpacing.sm }) {
            TextInput({ placeholder: '主密码（≥ 8 位）', text: this.password })
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
              });

            if (this.password.length > 0) {
              Row({ space: ZSpacing.sm }) {
                Text(this.strength.label)
                  .fontSize(ZType.footnoteSize)
                  .fontColor(this.strengthColor(this.strength.score))
                  .layoutWeight(1);
                Text(`${this.strength.entropy} bit`)
                  .fontSize(ZType.footnoteSize)
                  .fontColor(this.zc.text3);
              }
              .width('100%');

              Stack({ alignContent: Alignment.Start }) {
                Row()
                  .width('100%')
                  .height(3)
                  .borderRadius(2)
                  .backgroundColor(this.zc.lineSoft);
                Row()
                  .width(`${this.strength.score}%`)
                  .height(3)
                  .borderRadius(2)
                  .backgroundColor(this.strengthColor(this.strength.score));
              }
              .width('100%')
              .height(3);
            }

            TextInput({ placeholder: '再次输入主密码', text: this.confirm })
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
                this.confirm = v;
                this.errorText = '';
              });

            if (this.errorText) {
              Text(this.errorText)
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.danger)
                .width('100%')
                .textAlign(TextAlign.Start);
            }
          }
          .width('100%');

          Text(this.store.busy ? '正在初始化…' : '创建保险库')
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.accentInk)
            .backgroundColor(this.store.busy ? this.zc.text3 : this.zc.accent)
            .borderRadius(ZRadius.lg)
            .height(48)
            .width('100%')
            .textAlign(TextAlign.Center)
            .enabled(!this.store.busy)
            .onClick(() => this.onSubmit());

          Row().height(40).width('100%');
        }
        .width('100%')
        .constraintSize({ minHeight: '100%' })
        .justifyContent(FlexAlign.Start)
        .alignItems(HorizontalAlign.Start)
        .padding({ left: ZSpacing.xl, right: ZSpacing.xl });
      }
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart);

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Start)
    .align(Alignment.TopStart)
    .backgroundColor(this.zc.bg)
    // 键盘弹出时主动让出底部空间 —— 沉浸式窗口下 ArkUI 默认 KeyboardAvoidMode
    // 失效，靠 EntryAbility 订阅的 keyboard avoidArea 高度反馈到 padding 上。
    .padding({ bottom: this.safeArea.keyboard });
  }
}
