// SyncHost —— 作为同步服务端（让别的设备连到本机同步，client 模式对端连入）
//
// 与 phone/app/sync-host.tsx 行为对齐：
//   - 启动服务后展示 配对 PIN（6 格）+ 本机 IP:port（点按复制）+ 二维码
//   - 对端用「局域网同步」（Sync.ets / sync.tsx）扫码或手输连接
//   - 连入端上报冲突时，本机弹出 banner → 进入 SyncConflicts 由本机用户决策
//   - 状态指示行：dot 颜色 + 文案随 server.status / 冲突数变化
//
// 协议本身由 SyncServer.ets 单例承载，本页只读其 @Trace 字段并调
// startServer()/stopServer()。
// 离开本页（aboutToDisappear）或 vault 锁定（@Monitor store.status）时自动停服，
// 避免已配对对端继续读取已锁 vault。
//
// 本页是 Sync.ets（client）的服务端对应，沿用相同的视觉语言（hero / 卡片 / 顶栏）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, VaultStore } from '../state/VaultStore';
import { promptAction, router } from '@kit.ArkUI';
import { copyText } from '../lib/Clipboard';
import { syncServer, SyncServer } from '../lib/SyncServer';

@Entry
@ComponentV2
struct SyncHostPage {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local srv: SyncServer = syncServer;
  @Local store: VaultStore = vaultStore;
  @Local confirmVisible: boolean = false;

  /**
   * vault 锁定即停服。
   * VaultStatus 是 plain interface（子字段非 @Trace），lock() 重新赋整个 status
   * 对象才触发监控；因此监控 status 整体、回调里读 isUnlocked()（与 SecurityTab 一致）。
   */
  @Monitor('store.status')
  onLockChange(): void {
    if (!this.store.isUnlocked() && this.srv.running) {
      void this.srv.stopServer();
    }
  }

  /** 离开本屏（pop 回上级）时停服 */
  aboutToDisappear(): void {
    void this.srv.stopServer();
  }

  private onToggle(): void {
    if (this.srv.running) {
      this.confirmVisible = true;
      return;
    }
    this.startServer();
  }

  private async startServer(): Promise<void> {
    try {
      await this.srv.startServer();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      promptAction.showToast({ message: `无法启动: ${msg}`, duration: 1800 });
    }
  }

  private async confirmStop(): Promise<void> {
    this.confirmVisible = false;
    await this.srv.stopServer();
  }

  private async copyAddr(addr: string): Promise<void> {
    await copyText(addr);
    promptAction.showToast({ message: `已复制 ${addr}`, duration: 1500 });
  }

  private goConflicts(): void {
    router.pushUrl({ url: 'pages/SyncConflicts' }).catch(() => {
      // 未注册时静默：路由由编排层接线
    });
  }

  /** 状态点颜色：冲突优先 warn，配对/应用中 info，其余 ok */
  private statusDotColor(): string {
    if (this.srv.pendingConflicts.length > 0) {
      return this.zc.warn;
    }
    if (this.srv.status === 'paired' || this.srv.status === 'applying') {
      return this.zc.info;
    }
    return this.zc.ok;
  }

  /** 状态文案：与 phone statusLabel 对齐 */
  private statusLabel(): string {
    if (this.srv.pendingConflicts.length > 0) {
      return '收到冲突，待你解决';
    }
    if (this.srv.status === 'listening') {
      return '等待设备连接…';
    }
    if (this.srv.status === 'paired') {
      return '已配对，正在同步…';
    }
    if (this.srv.status === 'merge') {
      return '正在处理冲突…';
    }
    if (this.srv.status === 'applying') {
      return '正在应用决策…';
    }
    if (this.srv.status === 'done') {
      return '同步完成，可继续等待新连接';
    }
    if (this.srv.status === 'starting') {
      return '启动中…';
    }
    return '服务运行中';
  }

  build() {
    Stack() {
      Column() {
        Row().height(this.safeArea.top).width('100%');

        this.navBar();

        Scroll() {
          Column({ space: ZSpacing.md }) {
            this.hero();
            this.toggleButton();

            if (this.srv.running) {
              this.statusRow();
              if (this.srv.pendingConflicts.length > 0) {
                this.conflictBanner();
              }
              this.pinCard();
              this.addressCard();
              if (this.srv.qrPayload) {
                this.qrCard();
              }
            } else {
              this.idleHint();
            }

            Row().height(80).width('100%');
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

        Row().height(this.safeArea.bottom).width('100%');
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Start)
      .alignItems(HorizontalAlign.Start)
      .align(Alignment.TopStart)
      .backgroundColor(this.zc.bg)
      .padding({ bottom: this.safeArea.keyboard });

      if (this.confirmVisible) {
        this.confirmOverlay();
      }
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Center);
  }

  @Builder
  navBar() {
    Row({ space: ZSpacing.sm }) {
      Row() {
        Image($r('app.media.ic_chevron_left'))
          .width(20)
          .height(20)
          .fillColor(this.zc.text2);
      }
      .width(36)
      .height(36)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => router.back());

      Text('同步服务端')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text)
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .maxLines(1);

      Row().width(36);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.sm,
      bottom: ZSpacing.sm,
    });
  }

  @Builder
  hero() {
    Column({ space: ZSpacing.sm }) {
      Column() {
        Image($r('app.media.ic_users'))
          .width(26)
          .height(26)
          .fillColor(this.zc.info);
      }
      .width(56)
      .height(56)
      .borderRadius(ZRadius.xl)
      .backgroundColor(alpha1f(this.zc.info))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.xs });

      Text('让别人连我')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text('在另一台设备的「局域网同步」里扫码或手输下方 IP 与 PIN 即可连接到本机同步')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center)
        .lineHeight(18)
        .padding({ left: ZSpacing.md, right: ZSpacing.md });
    }
    .alignItems(HorizontalAlign.Center)
    .width('100%')
    .padding({ top: ZSpacing.lg, bottom: ZSpacing.sm });
  }

  @Builder
  toggleButton() {
    Row({ space: ZSpacing.xs }) {
      if (this.srv.running) {
        Image($r('app.media.ic_close'))
          .width(18)
          .height(18)
          .fillColor(this.zc.accentInk);
      }
      Text(this.srv.running ? '停止服务' : '启动服务')
        .fontSize(ZType.bodySize)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.zc.accentInk);
    }
    .width('100%')
    .height(48)
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.srv.running ? this.zc.danger : this.zc.accent)
    .borderRadius(ZRadius.lg)
    .margin({ top: ZSpacing.xs })
    .onClick(() => this.onToggle());
  }

  @Builder
  idleHint() {
    Text('启动后本机会监听局域网连接；保持本页打开，对端连接期间请勿锁屏。')
      .fontSize(ZType.footnoteSize)
      .fontColor(this.zc.text3)
      .textAlign(TextAlign.Center)
      .lineHeight(18)
      .width('100%')
      .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
  }

  @Builder
  statusRow() {
    Row({ space: ZSpacing.sm }) {
      Column()
        .width(8)
        .height(8)
        .borderRadius(4)
        .backgroundColor(this.statusDotColor());
      Text(this.statusLabel())
        .fontSize(ZType.subheadSize)
        .fontColor(this.zc.text2)
        .layoutWeight(1);
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.lg)
    .padding({
      left: ZSpacing.md,
      right: ZSpacing.md,
      top: ZSpacing.sm + 2,
      bottom: ZSpacing.sm + 2,
    });
  }

  @Builder
  conflictBanner() {
    Row({ space: ZSpacing.sm }) {
      Image($r('app.media.ic_warning'))
        .width(18)
        .height(18)
        .fillColor(this.zc.warn);
      Text(`${this.srv.pendingConflicts.length} 项冲突待解决`)
        .fontSize(ZType.bodySize)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.zc.warn)
        .layoutWeight(1);
      Image($r('app.media.ic_chevron_right'))
        .width(16)
        .height(16)
        .fillColor(this.zc.warn);
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .backgroundColor(alpha1f(this.zc.warn))
    .borderRadius(ZRadius.lg)
    .padding({
      left: ZSpacing.md,
      right: ZSpacing.md,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .onClick(() => this.goConflicts());
  }

  @Builder
  pinCard() {
    Column({ space: ZSpacing.sm }) {
      Text('配对 PIN')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .letterSpacing(0.4);
      Row({ space: ZSpacing.xs }) {
        this.pinCell(0);
        this.pinCell(1);
        this.pinCell(2);
        this.pinCell(3);
        this.pinCell(4);
        this.pinCell(5);
      }
      .width('100%');
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  pinCell(i: number) {
    Column() {
      Text(this.srv.pin.charAt(i))
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.accentInk)
        .fontFamily('HarmonyOS Sans Condensed');
    }
    .layoutWeight(1)
    .height(48)
    .borderRadius(ZRadius.lg)
    .backgroundColor(this.zc.accent)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  addressCard() {
    Column({ space: ZSpacing.sm }) {
      Text(`本机地址 · 端口 ${this.srv.port}`)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .letterSpacing(0.4);

      if (this.srv.hosts.length === 0) {
        Text('未检测到局域网地址，请确认已连接 Wi-Fi')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
      } else {
        ForEach(this.srv.hosts, (h: string) => {
          this.addrRow(h);
        }, (h: string) => h);
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  addrRow(h: string) {
    Row() {
      Text(`${h}:${this.srv.port}`)
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.text)
        .fontFamily('HarmonyOS Sans Condensed')
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
      Image($r('app.media.ic_copy'))
        .width(15)
        .height(15)
        .fillColor(this.zc.text3);
    }
    .width('100%')
    .justifyContent(FlexAlign.SpaceBetween)
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.zc.bg)
    .borderRadius(ZRadius.lg)
    .padding({ left: ZSpacing.md, right: ZSpacing.md, top: 11, bottom: 11 })
    .onClick(() => this.copyAddr(`${h}:${this.srv.port}`));
  }

  @Builder
  qrCard() {
    Column({ space: ZSpacing.md }) {
      Text('扫码连接')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .letterSpacing(0.4)
        .alignSelf(ItemAlign.Start);
      QRCode(this.srv.qrPayload)
        .width(200)
        .height(200)
        .color(this.zc.text)
        .backgroundColor(this.zc.bgElev);
      Text('另一台手机用「局域网同步」扫此码即可自动填充')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center);
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  confirmOverlay() {
    Column() {
      Column({ space: ZSpacing.md }) {
        Text('停止同步服务')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);
        Text('停止后对端将无法连接。确认停止？')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text2)
          .lineHeight(20)
          .width('100%');
        Row({ space: ZSpacing.sm }) {
          Text('取消')
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text)
            .backgroundColor(this.zc.bgActive)
            .borderRadius(ZRadius.lg)
            .height(44)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .onClick(() => { this.confirmVisible = false; });
          Text('停止')
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.accentInk)
            .backgroundColor(this.zc.danger)
            .borderRadius(ZRadius.lg)
            .height(44)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .onClick(() => this.confirmStop());
        }
        .width('100%')
        .margin({ top: ZSpacing.xs });
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .height('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl, bottom: this.safeArea.keyboard })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.overlay);
  }
}
