// CloudAccount —— 云账户（注册 / 登录 / 恢复会话 / 登出）
//
// 角色对应 desktop features/signin/SignInPage.tsx：零知识 SRP-6a 登录入口。
// 配好云服务地址后，注册产出一次性 Secret Key（用户须备份）；登录需邮箱 + 主密码 + Secret Key；
// 已保存账户时仅需主密码即可恢复会话（解锁 vault 时也会自动恢复）。
//
// 会话建立后跳「保险库同步」(pages/CloudSync) 完成云 vault 绑定与同步。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { cloudService, CloudService } from '../lib/CloudService';
import { vaultStore, VaultStore } from '../state/VaultStore';
import { promptAction, router } from '@kit.ArkUI';

@Entry
@ComponentV2
struct CloudAccountPage {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local cs: CloudService = cloudService;
  @Local vs: VaultStore = vaultStore;

  @Local serverUrl: string = '';
  @Local email: string = '';
  @Local password: string = '';
  @Local secretKeyInput: string = '';
  /** 'login' | 'register' */
  @Local mode: string = 'login';
  @Local busy: boolean = false;
  @Local errorText: string = '';
  @Local mfaCode: string = '';

  aboutToAppear(): void {
    this.initState();
  }

  private async initState(): Promise<void> {
    if (!this.cs.hydrated) {
      await this.cs.hydrate();
    }
    this.serverUrl = this.cs.baseUrl;
    this.email = this.cs.email;
  }

  /* ------------------------------------------------------------------------ */
  /* 操作                                                                      */
  /* ------------------------------------------------------------------------ */

  private onSaveServer(): void {
    try {
      this.cs.configure(this.serverUrl);
      this.errorText = '';
      promptAction.showToast({ message: '云服务地址已保存', duration: 1200 });
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    }
  }

  private async onRegister(): Promise<void> {
    this.busy = true;
    this.errorText = '';
    try {
      await this.cs.register(this.email, this.password);
      this.password = '';
      promptAction.showToast({ message: '注册成功，请备份 Secret Key', duration: 2000 });
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  private async onLogin(): Promise<void> {
    this.busy = true;
    this.errorText = '';
    try {
      await this.cs.signIn(this.email, this.password, this.secretKeyInput);
      this.password = '';
      this.secretKeyInput = '';
      if (!this.cs.mfaRequired) promptAction.showToast({ message: '登录成功', duration: 1200 });
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  private async onRestore(): Promise<void> {
    if (!this.vs.isUnlocked()) {
      promptAction.showToast({ message: '请先解锁本地保险库', duration: 1500 });
      return;
    }
    this.busy = true;
    this.errorText = '';
    try {
      await this.cs.restoreSession(this.password);
      this.password = '';
      if (this.cs.mfaRequired) return;
      if (this.cs.vaultBound) await this.cs.syncNow();
      promptAction.showToast({ message: '云会话已恢复', duration: 1200 });
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  private async onLogout(): Promise<void> {
    const res = await promptAction.showDialog({
      title: '退出云账户',
      message: '将清除本设备保存的云账户与同步绑定（本地保险库不受影响）。',
      buttons: [{ text: '取消', color: this.zc.text2 }, { text: '退出', color: this.zc.danger }],
    });
    if (res.index !== 1) return;
    await this.cs.signOut();
    this.password = '';
    this.secretKeyInput = '';
  }

  private async onCompleteMfa(): Promise<void> {
    this.busy = true;
    this.errorText = '';
    try {
      await this.cs.completeMfa(this.mfaCode);
      this.mfaCode = '';
      this.password = '';
      this.secretKeyInput = '';
      promptAction.showToast({ message: '登录成功', duration: 1200 });
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  private onCancelMfa(): void {
    this.cs.cancelMfa();
    this.mfaCode = '';
    this.errorText = '';
  }

  /* ------------------------------------------------------------------------ */
  /* build                                                                     */
  /* ------------------------------------------------------------------------ */

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      Row({ space: ZSpacing.sm }) {
        Row() {
          Image($r('app.media.ic_chevron_left')).width(20).height(20).fillColor(this.zc.text2);
        }
        .width(36).height(36)
        .justifyContent(FlexAlign.Center).alignItems(VerticalAlign.Center)
        .onClick(() => router.back());
        Text('云账户')
          .fontSize(ZType.title2Size).fontWeight(FontWeight.Bold).fontColor(this.zc.text)
          .layoutWeight(1).textAlign(TextAlign.Center);
        Row().width(36);
      }
      .width('100%')
      .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.sm, bottom: ZSpacing.sm });

      Scroll() {
        Column({ space: ZSpacing.md }) {
          this.hero();

          if (this.cs.secretKeyBackup) {
            this.secretKeyCard();
          }

          if (!this.cs.configured) {
            this.serverCard();
          } else if (this.cs.signedIn) {
            this.accountCard();
          } else if (this.cs.mfaRequired) {
            this.mfaCard();
          } else if (this.cs.hasAccount) {
            this.restoreCard();
          } else {
            this.authCard();
          }

          if (this.errorText) {
            this.errorCard();
          }

          Row().height(80).width('100%');
        }
        .width('100%')
        .constraintSize({ minHeight: '100%' })
        .alignItems(HorizontalAlign.Start)
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
      }
      .scrollBar(BarState.Off).layoutWeight(1).width('100%').align(Alignment.TopStart);

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%').height('100%')
    .alignItems(HorizontalAlign.Start).align(Alignment.TopStart)
    .backgroundColor(this.zc.bg)
    .padding({ bottom: this.safeArea.keyboard });
  }

  @Builder
  mfaCard() {
    Column({ space: ZSpacing.md }) {
      Row({ space: ZSpacing.xs }) {
        Image($r('app.media.ic_key')).width(18).height(18).fillColor(this.zc.info);
        Text('二次验证').fontSize(ZType.bodySize).fontWeight(FontWeight.Bold).fontColor(this.zc.text);
      }
      .width('100%');
      Text('该账户已开启 TOTP 二次验证，请输入身份验证器中的 6 位验证码。')
        .fontSize(ZType.captionSize).fontColor(this.zc.text3).lineHeight(16);
      Column() {
        this.fieldLabel('验证码');
        TextInput({ placeholder: '6 位数字', text: this.mfaCode })
          .type(InputType.Number)
          .placeholderColor(this.zc.text4).placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text).fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(44).width('100%')
          .maxLength(6)
          .enabled(!this.busy)
          .onChange((v: string) => { this.mfaCode = v; });
      }
      .alignItems(HorizontalAlign.Start).width('100%');
      Text(this.busy ? '验证中…' : '验证')
        .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
        .textAlign(TextAlign.Center).width('100%').height(48)
        .backgroundColor(this.busy ? this.zc.text3 : this.zc.accent).borderRadius(ZRadius.lg)
        .enabled(!this.busy)
        .onClick(() => this.onCompleteMfa());
      Text('取消')
        .fontSize(ZType.subheadSize).fontColor(this.zc.text2).textAlign(TextAlign.Center)
        .width('100%')
        .onClick(() => this.onCancelMfa());
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
  }

  @Builder
  hero() {
    Column({ space: ZSpacing.sm }) {
      Column() {
        Image($r('app.media.ic_globe')).width(26).height(26).fillColor(this.zc.info);
      }
      .width(56).height(56).borderRadius(ZRadius.xl).backgroundColor(alpha1f(this.zc.info))
      .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.xs });
      Text('云同步账户')
        .fontSize(ZType.title2Size).fontWeight(FontWeight.Bold).fontColor(this.zc.text);
      Text('零知识端到端加密：主密码与 Secret Key 永不离开本机，服务器只存密文')
        .fontSize(ZType.footnoteSize).fontColor(this.zc.text3)
        .textAlign(TextAlign.Center).lineHeight(18);
    }
    .alignItems(HorizontalAlign.Center).width('100%')
    .padding({ top: ZSpacing.lg, bottom: ZSpacing.sm });
  }

  @Builder
  fieldLabel(label: string) {
    Text(label).fontSize(ZType.footnoteSize).fontColor(this.zc.text3).margin({ bottom: 6 });
  }

  @Builder
  serverCard() {
    Column({ space: ZSpacing.md }) {
      Column() {
        this.fieldLabel('云服务地址');
        TextInput({ placeholder: 'https://zpass.example.com', text: this.serverUrl })
          .placeholderColor(this.zc.text4).placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text).fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(44).width('100%')
          .enabled(!this.busy)
          .onChange((v: string) => { this.serverUrl = v; });
      }
      .alignItems(HorizontalAlign.Start).width('100%');

      Text('保存地址')
        .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
        .textAlign(TextAlign.Center).width('100%').height(48)
        .backgroundColor(this.zc.accent).borderRadius(ZRadius.lg)
        .onClick(() => this.onSaveServer());
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
  }

  @Builder
  authCard() {
    Column({ space: ZSpacing.md }) {
      Row({ space: ZSpacing.sm }) {
        this.modeTab('login', '登录');
        this.modeTab('register', '注册');
      }
      .width('100%');

      Column() {
        this.fieldLabel('邮箱');
        TextInput({ placeholder: 'you@example.com', text: this.email })
          .placeholderColor(this.zc.text4).placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text).fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(44).width('100%')
          .enabled(!this.busy)
          .onChange((v: string) => { this.email = v; });
      }
      .alignItems(HorizontalAlign.Start).width('100%');

      Column() {
        this.fieldLabel('主密码');
        TextInput({ placeholder: '至少 8 位', text: this.password })
          .type(InputType.Password)
          .placeholderColor(this.zc.text4).placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text).fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(44).width('100%')
          .enabled(!this.busy)
          .onChange((v: string) => { this.password = v; });
      }
      .alignItems(HorizontalAlign.Start).width('100%');

      if (this.mode === 'login') {
        Column() {
          this.fieldLabel('Secret Key');
          TextInput({ placeholder: 'Z1-XXXXXX-…', text: this.secretKeyInput })
            .placeholderColor(this.zc.text4).placeholderFont({ size: ZType.bodySize })
            .fontColor(this.zc.text).fontSize(ZType.bodySize)
            .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
            .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(44).width('100%')
            .enabled(!this.busy)
            .onChange((v: string) => { this.secretKeyInput = v; });
        }
        .alignItems(HorizontalAlign.Start).width('100%');
      }

      if (this.mode === 'register') {
        Text('注册将生成你的 Secret Key —— 它与主密码共同保护数据，丢失无法找回，请务必备份。')
          .fontSize(ZType.captionSize).fontColor(this.zc.text3).lineHeight(16);
        Text(this.busy ? '处理中…' : '注册新账户')
          .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
          .textAlign(TextAlign.Center).width('100%').height(48)
          .backgroundColor(this.busy ? this.zc.text3 : this.zc.accent).borderRadius(ZRadius.lg)
          .enabled(!this.busy)
          .onClick(() => this.onRegister());
      } else {
        Text(this.busy ? '处理中…' : '登录')
          .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
          .textAlign(TextAlign.Center).width('100%').height(48)
          .backgroundColor(this.busy ? this.zc.text3 : this.zc.accent).borderRadius(ZRadius.lg)
          .enabled(!this.busy)
          .onClick(() => this.onLogin());
      }
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
  }

  @Builder
  modeTab(value: string, label: string) {
    Text(label)
      .fontSize(ZType.subheadSize)
      .fontWeight(this.mode === value ? FontWeight.Bold : FontWeight.Normal)
      .fontColor(this.mode === value ? this.zc.accentInk : this.zc.text2)
      .textAlign(TextAlign.Center).layoutWeight(1).height(34)
      .borderRadius(ZRadius.md)
      .backgroundColor(this.mode === value ? this.zc.accent : this.zc.bg)
      .onClick(() => { if (!this.busy) { this.mode = value; this.errorText = ''; } });
  }

  @Builder
  restoreCard() {
    Column({ space: ZSpacing.md }) {
      Row({ space: ZSpacing.sm }) {
        Image($r('app.media.ic_person')).width(18).height(18).fillColor(this.zc.text2);
        Text(this.cs.email).fontSize(ZType.bodySize).fontColor(this.zc.text).layoutWeight(1)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .width('100%');
      Text('输入主密码恢复云会话（解锁本地保险库时也会自动恢复）。')
        .fontSize(ZType.captionSize).fontColor(this.zc.text3).lineHeight(16);
      Column() {
        this.fieldLabel('主密码');
        TextInput({ placeholder: '主密码', text: this.password })
          .type(InputType.Password)
          .placeholderColor(this.zc.text4).placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text).fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(44).width('100%')
          .enabled(!this.busy)
          .onChange((v: string) => { this.password = v; });
      }
      .alignItems(HorizontalAlign.Start).width('100%');
      Text(this.busy ? '处理中…' : '恢复云会话')
        .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
        .textAlign(TextAlign.Center).width('100%').height(48)
        .backgroundColor(this.busy ? this.zc.text3 : this.zc.accent).borderRadius(ZRadius.lg)
        .enabled(!this.busy)
        .onClick(() => this.onRestore());
      Text('退出云账户')
        .fontSize(ZType.subheadSize).fontColor(this.zc.danger).textAlign(TextAlign.Center)
        .width('100%').margin({ top: ZSpacing.xs })
        .onClick(() => this.onLogout());
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
  }

  @Builder
  accountCard() {
    Column({ space: ZSpacing.md }) {
      Row({ space: ZSpacing.sm }) {
        Column() {
          Image($r('app.media.ic_check_circle')).width(20).height(20).fillColor(this.zc.ok);
        }
        .width(40).height(40).borderRadius(ZRadius.lg).backgroundColor(alpha1f(this.zc.ok))
        .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center);
        Column({ space: 2 }) {
          Text('已登录').fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
          Text(this.cs.email).fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.text)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
        }
        .alignItems(HorizontalAlign.Start).layoutWeight(1);
      }
      .width('100%');

      Row({ space: ZSpacing.sm }) {
        Image($r('app.media.ic_refresh')).width(18).height(18).fillColor(this.zc.accentInk);
        Text('保险库同步').fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk);
      }
      .width('100%').height(48).justifyContent(FlexAlign.Center).alignItems(VerticalAlign.Center)
      .backgroundColor(this.zc.accent).borderRadius(ZRadius.lg)
      .onClick(() => {
        router.pushUrl({ url: 'pages/CloudSync' }).catch(() => {
          promptAction.showToast({ message: '页面未注册', duration: 1500 });
        });
      });

      Text('退出云账户')
        .fontSize(ZType.subheadSize).fontColor(this.zc.danger).textAlign(TextAlign.Center)
        .width('100%')
        .onClick(() => this.onLogout());
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
  }

  @Builder
  secretKeyCard() {
    Column({ space: ZSpacing.sm }) {
      Row({ space: ZSpacing.xs }) {
        Image($r('app.media.ic_key')).width(16).height(16).fillColor(this.zc.warn);
        Text('请立即备份你的 Secret Key')
          .fontSize(ZType.footnoteSize).fontWeight(FontWeight.Bold).fontColor(this.zc.warnText).layoutWeight(1);
      }
      .width('100%');
      Text('它与主密码共同解密数据；服务器与我们都无法找回。长按下方文本复制。')
        .fontSize(ZType.captionSize).fontColor(this.zc.text3).lineHeight(16);
      Text(this.cs.secretKeyBackup)
        .fontSize(ZType.bodySize).fontColor(this.zc.text)
        .width('100%').padding(ZSpacing.md)
        .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
        .copyOption(CopyOptions.LocalDevice)
        .textAlign(TextAlign.Center);
      Text('我已安全备份')
        .fontSize(ZType.subheadSize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
        .textAlign(TextAlign.Center).width('100%').height(44)
        .backgroundColor(this.zc.accent).borderRadius(ZRadius.lg)
        .onClick(() => { this.cs.secretKeyBackup = ''; });
    }
    .width('100%').padding(ZSpacing.lg)
    .backgroundColor(alpha1f(this.zc.warn)).borderRadius(ZRadius.xl);
  }

  @Builder
  errorCard() {
    Row({ space: ZSpacing.xs }) {
      Image($r('app.media.ic_error')).width(14).height(14).fillColor(this.zc.danger);
      Text(this.errorText).fontSize(ZType.footnoteSize).fontColor(this.zc.danger).layoutWeight(1);
    }
    .width('100%').padding({ left: ZSpacing.md, right: ZSpacing.md, top: ZSpacing.sm, bottom: ZSpacing.sm })
    .backgroundColor(alpha1f(this.zc.danger)).borderRadius(ZRadius.md);
  }
}
