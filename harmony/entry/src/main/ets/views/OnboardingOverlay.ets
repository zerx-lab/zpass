// OnboardingOverlay —— 首次启动两步引导
//
// 与 phone/components/onboarding-overlay.tsx 行为对齐：
//   1. 设主密码（仅暂存到内存，不立即 initialize）
//   2. 给"默认空间"取个名字，提交时一次性 initialize → renameSpace
//
// 这样 KDF 等待发生在最后，避免在第一步就占用 UI 数秒。
// 主密码不可找回 —— 用户应在第一步看到"不可恢复"提示。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { estimateStrength, type Strength } from '../lib/Password';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { SpaceAvatar } from '../components/SpaceAvatar';
import { DEFAULT_SPACE_ID } from '../lib/Spaces';
import { isNativeKDF } from '../lib/Crypto';

type Step = 'password' | 'space';

@ComponentV2
export struct OnboardingOverlay {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local step: Step = 'password';
  @Local password: string = '';
  @Local confirm: string = '';
  @Local spaceName: string = '';
  @Local errorText: string = '';

  // reveal toggles for each password field
  @Local pwRevealed: boolean = false;
  @Local cfRevealed: boolean = false;

  private onNext(): void {
    if (this.password.length < 8) {
      this.errorText = '主密码至少 8 位';
      return;
    }
    if (this.password !== this.confirm) {
      this.errorText = '两次输入不一致';
      return;
    }
    this.errorText = '';
    this.step = 'space';
  }

  private onBack(): void {
    this.errorText = '';
    this.step = 'password';
  }

  private async onSubmit(): Promise<void> {
    const trimmed = this.spaceName.trim();
    if (!trimmed) {
      this.errorText = '空间名不能为空';
      return;
    }
    if (trimmed.length > 32) {
      this.errorText = '空间名不超过 32 个字符';
      return;
    }
    this.errorText = '';
    try {
      await this.store.initialize(this.password);
    } catch (e) {
      this.errorText = (e as Error).message || '初始化失败';
      return;
    }
    try {
      await this.store.renameSpace(DEFAULT_SPACE_ID, trimmed);
    } catch (_e) {
      // 重命名失败不影响主流程（vault 已初始化），phone 端同处理
    }
    this.password = '';
    this.confirm = '';
    this.spaceName = '';
  }

  private strengthColor(score: number): string {
    if (score >= 80) return this.zc.ok;
    if (score >= 50) return this.zc.warn;
    if (score > 0) return this.zc.danger;
    return this.zc.text3;
  }

  private kdfHintText(): string {
    if (isNativeKDF()) {
      return '原生加速 · 派生约 0.3 秒';
    }
    return '派生需要数秒，请稍候';
  }

  @Computed
  get tooShort(): boolean {
    return this.password.length > 0 && this.password.length < 8;
  }

  @Computed
  get mismatch(): boolean {
    return this.confirm.length > 0 && this.confirm !== this.password;
  }

  @Computed
  get strength(): Strength {
    return estimateStrength(this.password);
  }

  @Computed
  get isPasswordStep(): boolean {
    return this.step === 'password';
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      Scroll() {
        Column({ space: ZSpacing.lg }) {
          // 顶部 logo —— 第一步显示 Z，第二步显示 SpaceAvatar
          if (this.isPasswordStep) {
            Column() {
              Text('Z')
                .fontSize(32)
                .fontWeight(FontWeight.Bold)
                .fontColor(this.zc.accentInk);
            }
            .width(64)
            .height(64)
            .borderRadius(ZRadius.xl)
            .backgroundColor(this.zc.accent)
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            .margin({ top: ZSpacing.lg, bottom: ZSpacing.lg });
          } else {
            Row() {
              SpaceAvatar({
                avatarName: this.spaceName.trim(),
                avatarSize: 64,
                avatarBg: this.zc.accent,
                avatarFg: this.zc.accentInk,
                avatarFontSize: 28,
                avatarRadius: ZRadius.xl,
              });
            }
            .margin({ top: ZSpacing.lg, bottom: ZSpacing.lg });
          }

          // 标题 / 副标题
          Column({ space: ZSpacing.xs }) {
            Text(this.isPasswordStep ? '欢迎使用 ZPass' : '为空间取个名字')
              .fontSize(ZType.titleSize)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.zc.text)
              .textAlign(TextAlign.Center);
            Text(this.isPasswordStep ? '设置主密码以加密你的保险库' : '头像首字符会跟随名字')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .textAlign(TextAlign.Center);
          }
          .alignItems(HorizontalAlign.Center)
          .width('100%');

          // 步骤指示器
          Row({ space: 4 }) {
            Row()
              .width(8)
              .height(8)
              .borderRadius(4)
              .backgroundColor(this.zc.accent);
            Row()
              .width(32)
              .height(2)
              .borderRadius(1)
              .backgroundColor(this.step === 'space' ? this.zc.accent : this.zc.bgActive);
            Row()
              .width(8)
              .height(8)
              .borderRadius(4)
              .backgroundColor(this.step === 'space' ? this.zc.accent : this.zc.bgActive);
          }
          .justifyContent(FlexAlign.Center);

          // 主卡片
          if (this.isPasswordStep) {
            this.passwordCard();
          } else {
            this.spaceCard();
          }

          // 底部按钮区
          if (this.isPasswordStep) {
            // 下一步按钮（带右箭头图标）
            Row() {
              Text('下一步')
                .fontSize(ZType.bodySize)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.zc.accentInk)
                .layoutWeight(1)
                .textAlign(TextAlign.End);
              Image($r('app.media.ic_arrow_right'))
                .width(16)
                .height(16)
                .fillColor(this.zc.accentInk)
                .margin({ left: ZSpacing.xs });
            }
            .backgroundColor(this.zc.accent)
            .borderRadius(ZRadius.lg)
            .height(48)
            .width('100%')
            .padding({ left: ZSpacing.xl, right: ZSpacing.md })
            .justifyContent(FlexAlign.Center)
            .alignItems(VerticalAlign.Center)
            .onClick(() => this.onNext());

            // KDF 派生时间提示
            Text(this.kdfHintText())
              .fontSize(ZType.captionSize)
              .fontColor(this.zc.text4)
              .fontFamily('HarmonyOS Sans Condensed')
              .textAlign(TextAlign.Center)
              .width('100%');
          } else {
            // 返回 + 创建保险库
            Row({ space: ZSpacing.sm }) {
              // 返回按钮（带左箭头图标）
              Row() {
                Image($r('app.media.ic_arrow_left'))
                  .width(16)
                  .height(16)
                  .fillColor(this.zc.text)
                  .margin({ right: ZSpacing.xs });
                Text('返回')
                  .fontSize(ZType.bodySize)
                  .fontColor(this.zc.text);
              }
              .backgroundColor(this.zc.bgElev)
              .borderRadius(ZRadius.lg)
              .height(48)
              .padding({ left: ZSpacing.md, right: ZSpacing.md })
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              .enabled(!this.store.busy)
              .onClick(() => this.onBack());

              // 创建保险库按钮（带勾选图标）
              Row() {
                Text(this.store.busy ? '创建中…' : '创建保险库')
                  .fontSize(ZType.bodySize)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.zc.accentInk)
                  .layoutWeight(1)
                  .textAlign(TextAlign.End);
                if (!this.store.busy) {
                  Image($r('app.media.ic_check'))
                    .width(16)
                    .height(16)
                    .fillColor(this.zc.accentInk)
                    .margin({ left: ZSpacing.xs });
                }
              }
              .backgroundColor(this.store.busy ? this.zc.text3 : this.zc.accent)
              .borderRadius(ZRadius.lg)
              .height(48)
              .layoutWeight(1)
              .padding({ left: ZSpacing.md, right: ZSpacing.md })
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              .enabled(!this.store.busy)
              .onClick(() => this.onSubmit());
            }
            .width('100%');

            // 创建后提示
            Text('创建后随时可在「我的 → 空间」里重命名')
              .fontSize(ZType.captionSize)
              .fontColor(this.zc.text4)
              .textAlign(TextAlign.Center)
              .width('100%');
          }

          Row().height(40).width('100%');
        }
        .width('100%')
        .constraintSize({ minHeight: '100%' })
        .justifyContent(FlexAlign.Start)
        .alignItems(HorizontalAlign.Center)
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
    // 沉浸式窗口下 ArkUI 默认 KeyboardAvoidMode 失效，由 EntryAbility 推送
    // keyboard avoidArea 高度反馈到 padding 上。
    .padding({ bottom: this.safeArea.keyboard });
  }

  /** 字段标签行：大写 + 提示 */
  @Builder
  fieldLabel(label: string, hint: string) {
    Row() {
      Text(label.toUpperCase())
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .letterSpacing(0.4);
      if (hint) {
        Text(hint)
          .fontSize(ZType.captionSize)
          .fontColor(this.zc.text4)
          .fontFamily('HarmonyOS Sans Condensed')
          .margin({ left: ZSpacing.xs });
      }
    }
    .width('100%')
    .justifyContent(FlexAlign.SpaceBetween)
    .alignItems(VerticalAlign.Bottom)
    .margin({ bottom: ZSpacing.xs });
  }

  /** 错误提示框（带图标的危险色背景行） */
  @Builder
  errorBox() {
    Row({ space: ZSpacing.xs }) {
      Image($r('app.media.ic_error'))
        .width(14)
        .height(14)
        .fillColor(this.zc.danger);
      Text(this.errorText)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.danger)
        .layoutWeight(1);
    }
    .width('100%')
    .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: 6, bottom: 6 })
    .backgroundColor(alpha1f(this.zc.danger))
    .borderRadius(ZRadius.md)
    .margin({ top: ZSpacing.sm });
  }

  @Builder
  passwordCard() {
    Column({ space: ZSpacing.sm }) {
      // 主密码字段标签
      this.fieldLabel('主密码', '至少 8 位字符');

      // 主密码输入框（含锁图标 + 显示/隐藏切换）
      Row({ space: ZSpacing.sm }) {
        Image($r('app.media.ic_lock'))
          .width(16)
          .height(16)
          .fillColor(this.zc.text3);
        TextInput({ placeholder: '主密码', text: this.password })
          .type(this.pwRevealed ? InputType.Normal : InputType.Password)
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .backgroundColor('#00000000')
          .borderRadius(0)
          .padding(0)
          .layoutWeight(1)
          .onChange((v: string) => {
            this.password = v;
            this.errorText = '';
          });
        Image(this.pwRevealed ? $r('app.media.ic_eye_off') : $r('app.media.ic_eye'))
          .width(20)
          .height(20)
          .fillColor(this.zc.text3)
          .onClick(() => {
            this.pwRevealed = !this.pwRevealed;
          });
      }
      .width('100%')
      .height(48)
      .backgroundColor(this.zc.bg)
      .borderRadius(ZRadius.lg)
      .border({ width: 1, color: this.tooShort ? this.zc.danger : this.zc.line })
      .padding({ left: ZSpacing.md, right: ZSpacing.sm });

      if (this.tooShort) {
        Text('主密码至少 8 位')
          .fontSize(ZType.captionSize)
          .fontColor(this.zc.danger)
          .width('100%');
      }

      // 密码强度（harmony 扩展，phone 无此功能 — 可接受增强）
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

      // 确认密码字段标签
      this.fieldLabel('确认主密码', '');

      // 确认密码输入框（含锁图标 + 显示/隐藏切换）
      Row({ space: ZSpacing.sm }) {
        Image($r('app.media.ic_lock'))
          .width(16)
          .height(16)
          .fillColor(this.zc.text3);
        TextInput({ placeholder: '再次输入', text: this.confirm })
          .type(this.cfRevealed ? InputType.Normal : InputType.Password)
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .backgroundColor('#00000000')
          .borderRadius(0)
          .padding(0)
          .layoutWeight(1)
          .onChange((v: string) => {
            this.confirm = v;
            this.errorText = '';
          })
          .onSubmit(() => this.onNext());
        Image(this.cfRevealed ? $r('app.media.ic_eye_off') : $r('app.media.ic_eye'))
          .width(20)
          .height(20)
          .fillColor(this.zc.text3)
          .onClick(() => {
            this.cfRevealed = !this.cfRevealed;
          });
      }
      .width('100%')
      .height(48)
      .backgroundColor(this.zc.bg)
      .borderRadius(ZRadius.lg)
      .border({ width: 1, color: this.mismatch ? this.zc.danger : this.zc.line })
      .padding({ left: ZSpacing.md, right: ZSpacing.sm });

      if (this.mismatch) {
        Text('两次输入不一致')
          .fontSize(ZType.captionSize)
          .fontColor(this.zc.danger)
          .width('100%');
      }

      // 错误提示框
      if (this.errorText) {
        this.errorBox();
      }

      // 安全特性说明（带勾选徽标）
      Column({ space: ZSpacing.sm }) {
        Divider()
          .strokeWidth(0.5)
          .color(this.zc.lineSoft)
          .margin({ top: ZSpacing.sm, bottom: ZSpacing.xs });

        this.securityPoint('数据仅保存在本设备，零知识端到端');
        this.securityPoint('Argon2id 派生主密码 → XChaCha20-Poly1305 加密');
        this.securityPoint('主密码不会离开设备，丢失无法恢复');
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%');
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .clip(true);
  }

  /** 单条安全说明行：圆形勾徽标 + 文本 */
  @Builder
  securityPoint(text: string) {
    Row({ space: ZSpacing.sm }) {
      Column() {
        Image($r('app.media.ic_check'))
          .width(11)
          .height(11)
          .fillColor(this.zc.ok);
      }
      .width(20)
      .height(20)
      .borderRadius(10)
      .backgroundColor(alpha1f(this.zc.ok))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center);

      Text(text)
        .fontSize(ZType.subheadSize)
        .fontColor(this.zc.text2)
        .layoutWeight(1);
    }
    .width('100%')
    .alignItems(VerticalAlign.Center);
  }

  @Builder
  spaceCard() {
    Column({ space: ZSpacing.sm }) {
      // 空间名字段标签
      this.fieldLabel('空间名', '个人 / 工作 / 家庭 …');

      // 空间名输入框（含 tag 图标）
      Row({ space: ZSpacing.sm }) {
        Image($r('app.media.ic_tag'))
          .width(16)
          .height(16)
          .fillColor(this.zc.text3);
        TextInput({ placeholder: '为这个空间取个名字', text: this.spaceName })
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .backgroundColor('#00000000')
          .borderRadius(0)
          .padding(0)
          .layoutWeight(1)
          .maxLength(32)
          .onChange((v: string) => {
            this.spaceName = v;
            this.errorText = '';
          })
          .onSubmit(() => this.onSubmit());
      }
      .width('100%')
      .height(48)
      .backgroundColor(this.zc.bg)
      .borderRadius(ZRadius.lg)
      .padding({ left: ZSpacing.md, right: ZSpacing.md });

      // 错误提示框
      if (this.errorText) {
        this.errorBox();
      }

      // 空间说明文字
      Column({ space: ZSpacing.xs }) {
        Divider()
          .strokeWidth(0.5)
          .color(this.zc.lineSoft)
          .margin({ top: ZSpacing.sm, bottom: ZSpacing.xs });
        Text('空间是 ZPass 里的顶层隔离容器，类似不同账号。每个空间独立存放条目，可随时新建、切换、重命名。')
          .fontSize(ZType.subheadSize)
          .fontColor(this.zc.text2)
          .width('100%')
          .lineHeight(20);
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%');
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .clip(true);
  }
}
