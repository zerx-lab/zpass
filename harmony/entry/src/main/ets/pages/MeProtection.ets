// MeProtection —— 「我的 → 应用保护」分组设置页
//
// 分组对齐主流密码管理器的保护设置页：
//   - 保险库解锁：修改主密码 / 此设备自动解锁
//   - 屏幕与隐私：禁止截图 / 后台模糊保护
//   - 锁定：切到后台锁定 / 立即锁定
//
// 改主密码与启用信任设备的确认浮层随业务逻辑一起从 MeTab 迁入。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { securityStore, SecurityStore } from '../state/SecurityStore';
import { promptAction, router } from '@kit.ArkUI';
import {
  SettingsErrorBox,
  SettingsRowDanger,
  SettingsRowNav,
  SettingsRowToggle,
  SettingsSectionHeader,
} from '../components/SettingsRows';

@Entry
@ComponentV2
struct MeProtection {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;
  @Local sec: SecurityStore = securityStore;

  /** 启用信任设备时的密码确认浮层 */
  @Local showConfirmPw: boolean = false;
  @Local confirmPw: string = '';
  @Local confirmPwError: string = '';

  /** 改主密码浮层 */
  @Local showChangePw: boolean = false;
  @Local cpOld: string = '';
  @Local cpNew: string = '';
  @Local cpConfirm: string = '';
  @Local cpError: string = '';

  aboutToAppear(): void {
    this.store.refreshTrustedState().catch(() => {
      // 静默吞 —— 探测失败时按"不支持"显示
    });
  }

  @Computed
  get trustedValueLabel(): string {
    if (!this.store.trustedSupported) return '不支持';
    return this.store.trustedEnabled ? '已启用' : '未启用';
  }

  private async onLock(): Promise<void> {
    const r = await promptAction.showDialog({
      title: '锁定 ZPass',
      message: '确认要锁定保险库吗？',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '锁定', color: this.zc.danger },
      ],
    });
    if (r.index === 1) {
      this.store.lock();
      promptAction.showToast({ message: '已锁定', duration: 1200 });
      // 锁屏遮罩盖在 Index 上，留在子页会绕过它 —— 退回主页
      router.back();
    }
  }

  private onChangePwOpen(): void {
    if (!this.store.status.unlocked) {
      promptAction.showToast({ message: '请先解锁后再修改', duration: 1500 });
      return;
    }
    this.cpOld = '';
    this.cpNew = '';
    this.cpConfirm = '';
    this.cpError = '';
    this.showChangePw = true;
  }

  private onChangePwCancel(): void {
    if (this.store.busy) return;
    this.cpOld = '';
    this.cpNew = '';
    this.cpConfirm = '';
    this.cpError = '';
    this.showChangePw = false;
  }

  private async onChangePwSubmit(): Promise<void> {
    this.cpError = '';
    if (!this.cpOld) {
      this.cpError = '请输入当前主密码';
      return;
    }
    if (this.cpNew.length < 8) {
      this.cpError = '新密码至少 8 位';
      return;
    }
    if (this.cpNew !== this.cpConfirm) {
      this.cpError = '两次输入不一致';
      return;
    }
    try {
      await this.store.changeMasterPassword(this.cpOld, this.cpNew);
      this.cpOld = '';
      this.cpNew = '';
      this.cpConfirm = '';
      this.showChangePw = false;
      promptAction.showToast({ message: '主密码已更新', duration: 1500 });
    } catch (e) {
      this.cpError = (e as Error).message;
    }
  }

  private onTrustedRowTap(): void {
    if (!this.store.trustedSupported) {
      promptAction.showToast({ message: '当前设备不支持生物解锁', duration: 1800 });
      return;
    }
    if (this.store.busy) return;
    this.onToggleTrustedDevice(!this.store.trustedEnabled);
  }

  private async onToggleTrustedDevice(target: boolean): Promise<void> {
    if (target) {
      if (!this.store.status.unlocked) {
        promptAction.showToast({ message: '请先解锁后再启用', duration: 1500 });
        return;
      }
      this.confirmPw = '';
      this.confirmPwError = '';
      this.showConfirmPw = true;
      return;
    }
    const r = await promptAction.showDialog({
      title: '关闭设备解锁',
      message: '下次启动 ZPass 需要重新输入主密码。',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '关闭', color: this.zc.danger },
      ],
    });
    if (r.index !== 1) return;
    try {
      await this.store.disableTrustedDevice();
      promptAction.showToast({ message: '已关闭生物解锁', duration: 1200 });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  private async onConfirmEnable(): Promise<void> {
    if (!this.confirmPw) {
      this.confirmPwError = '请输入主密码';
      return;
    }
    this.confirmPwError = '';
    try {
      await this.store.enableTrustedDevice(this.confirmPw);
      this.confirmPw = '';
      this.showConfirmPw = false;
      promptAction.showToast({ message: '已启用生物解锁', duration: 1500 });
    } catch (e) {
      this.confirmPwError = (e as Error).message;
      this.confirmPw = '';
    }
  }

  private onCancelEnable(): void {
    this.confirmPw = '';
    this.confirmPwError = '';
    this.showConfirmPw = false;
  }

  build() {
    Stack() {
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

          Text('应用保护')
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
            SettingsSectionHeader({ label: '保险库解锁' });
            Column() {
              SettingsRowNav({
                label: '修改主密码',
                icon: $r('app.media.ic_lock'),
                onTap: () => this.onChangePwOpen(),
              });
              this.divider();
              SettingsRowToggle({
                title: '此设备自动解锁',
                value: this.trustedValueLabel,
                icon: $r('app.media.ic_face'),
                isOn: this.store.trustedEnabled,
                dimmed: !this.store.trustedSupported,
                onToggle: () => this.onTrustedRowTap(),
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            SettingsSectionHeader({ label: '屏幕与隐私' });
            Column() {
              SettingsRowToggle({
                title: '禁止截图',
                subtitle: '截屏、录屏与多任务预览均不可见',
                icon: $r('app.media.ic_lock_shield'),
                isOn: this.sec.antiPeepEnabled,
                onToggle: () => this.sec.setAntiPeepEnabled(!this.sec.antiPeepEnabled),
              });
              this.divider();
              SettingsRowToggle({
                title: '后台模糊保护',
                subtitle: '切到后台时遮挡界面，防多任务卡片泄露',
                icon: $r('app.media.ic_grid'),
                isOn: this.sec.bgBlurEnabled,
                onToggle: () => this.sec.setBgBlurEnabled(!this.sec.bgBlurEnabled),
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            SettingsSectionHeader({ label: '锁定' });
            Column() {
              SettingsRowToggle({
                title: '切到后台锁定',
                subtitle: '离开 ZPass 即刻锁定保险库',
                icon: $r('app.media.ic_lock'),
                isOn: this.sec.lockOnBackground,
                onToggle: () => this.sec.setLockOnBackground(!this.sec.lockOnBackground),
              });
              this.divider();
              SettingsRowDanger({
                label: '立即锁定',
                icon: $r('app.media.ic_lock_shield'),
                iconColor: this.zc.danger,
                onTap: () => this.onLock(),
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
      .backgroundColor(this.zc.bg);

      if (this.showConfirmPw) {
        this.confirmPwOverlay();
      }
      if (this.showChangePw) {
        this.changePwOverlay();
      }
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Center)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);
  }

  @Builder
  divider() {
    Divider().strokeWidth(0.5).color(this.zc.line).margin({ left: ZSpacing.lg, right: ZSpacing.lg });
  }

  /** 启用信任设备时的主密码确认浮层 */
  @Builder
  confirmPwOverlay() {
    Column() {
      Column({ space: ZSpacing.md }) {
        Text('启用设备解锁')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);
        Text('启用后此设备可用生物识别 / 设备凭据解锁。请输入主密码以确认。')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);

        TextInput({ placeholder: '主密码', text: this.confirmPw })
          .type(InputType.Password)
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg)
          .borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .height(48)
          .width('100%')
          .enabled(!this.store.busy)
          .onChange((v: string) => {
            this.confirmPw = v;
            this.confirmPwError = '';
          })
          .onSubmit(() => this.onConfirmEnable());

        if (this.confirmPwError) {
          SettingsErrorBox({ message: this.confirmPwError });
        }

        Row({ space: ZSpacing.md }) {
          Text('取消')
            .fontSize(ZType.bodySize)
            .fontColor(this.zc.text2)
            .backgroundColor(this.zc.bg)
            .borderRadius(ZRadius.lg)
            .height(44)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .enabled(!this.store.busy)
            .onClick(() => this.onCancelEnable());
          Text(this.store.busy ? '启用中…' : '启用')
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.accentInk)
            .backgroundColor(this.store.busy ? this.zc.text3 : this.zc.accent)
            .borderRadius(ZRadius.lg)
            .height(44)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .enabled(!this.store.busy)
            .onClick(() => this.onConfirmEnable());
        }
        .width('100%');
      }
      .width('100%')
      .padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .height('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl, bottom: this.safeArea.keyboard })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.overlay)
    .onClick(() => {
      // 点遮罩也可关闭（与 phone SheetModal backdrop 行为对齐）
      if (!this.store.busy) this.onCancelEnable();
    });
  }

  /** 改主密码浮层 */
  @Builder
  changePwOverlay() {
    Column() {
      Column({ space: ZSpacing.md }) {
        Text('修改主密码')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);
        Text('主密码用于解锁与加密保险库，请妥善保管')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);

        Column({ space: 4 }) {
          Text('当前主密码')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3)
            .width('100%');
          TextInput({ placeholder: '当前主密码', text: this.cpOld })
            .type(InputType.Password)
            .placeholderColor(this.zc.text3)
            .placeholderFont({ size: ZType.bodySize })
            .fontColor(this.zc.text)
            .fontSize(ZType.bodySize)
            .backgroundColor(this.zc.bg)
            .borderRadius(ZRadius.lg)
            .padding({ left: ZSpacing.md, right: ZSpacing.md })
            .height(44)
            .width('100%')
            .enabled(!this.store.busy)
            .onChange((v: string) => {
              this.cpOld = v;
              this.cpError = '';
            });
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');

        Column({ space: 4 }) {
          Text('新主密码')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3)
            .width('100%');
          TextInput({ placeholder: '新主密码（≥ 8 位）', text: this.cpNew })
            .type(InputType.Password)
            .placeholderColor(this.zc.text3)
            .placeholderFont({ size: ZType.bodySize })
            .fontColor(this.zc.text)
            .fontSize(ZType.bodySize)
            .backgroundColor(this.zc.bg)
            .borderRadius(ZRadius.lg)
            .padding({ left: ZSpacing.md, right: ZSpacing.md })
            .height(44)
            .width('100%')
            .enabled(!this.store.busy)
            .onChange((v: string) => {
              this.cpNew = v;
              this.cpError = '';
            });
          Text('至少 8 位，建议混合大小写 + 数字 + 符号')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3)
            .width('100%');
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');

        Column({ space: 4 }) {
          Text('确认新主密码')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3)
            .width('100%');
          TextInput({ placeholder: '再次输入新主密码', text: this.cpConfirm })
            .type(InputType.Password)
            .placeholderColor(this.zc.text3)
            .placeholderFont({ size: ZType.bodySize })
            .fontColor(this.zc.text)
            .fontSize(ZType.bodySize)
            .backgroundColor(this.zc.bg)
            .borderRadius(ZRadius.lg)
            .padding({ left: ZSpacing.md, right: ZSpacing.md })
            .height(44)
            .width('100%')
            .enabled(!this.store.busy)
            .onChange((v: string) => {
              this.cpConfirm = v;
              this.cpError = '';
            })
            .onSubmit(() => this.onChangePwSubmit());
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%');

        if (this.cpError) {
          SettingsErrorBox({ message: this.cpError });
        }

        Row({ space: ZSpacing.md }) {
          Text('取消')
            .fontSize(ZType.bodySize)
            .fontColor(this.zc.text2)
            .backgroundColor(this.zc.bg)
            .borderRadius(ZRadius.lg)
            .height(44)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .enabled(!this.store.busy)
            .onClick(() => this.onChangePwCancel());
          Text(this.store.busy ? '更新中…' : '确认修改')
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.accentInk)
            .backgroundColor(this.store.busy ? this.zc.text3 : this.zc.accent)
            .borderRadius(ZRadius.lg)
            .height(44)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .enabled(!this.store.busy)
            .onClick(() => this.onChangePwSubmit());
        }
        .width('100%');
      }
      .width('100%')
      .padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .height('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl, bottom: this.safeArea.keyboard })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.overlay)
    .onClick(() => {
      // 遮罩点击不关闭 —— 表单较重，要求显式按取消
    });
  }
}
