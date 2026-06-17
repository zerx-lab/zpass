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
import { vaultService } from '../lib/VaultService';
import { cloudService } from '../lib/CloudService';
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
  /** 「清空所有数据」云端二次验证浮层状态。 */
  @Local showClearVerify: boolean = false;
  @Local clearMp: string = '';
  @Local clearSk: string = '';
  @Local clearBusy: boolean = false;
  @Local clearError: string = '';
  /** 导入进度浮层状态 —— importBusy 期间禁止返回 / 切页，避免半截导入。 */
  @Local importBusy: boolean = false;
  @Local importDone: number = 0;
  @Local importTotal: number = 0;

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
    // 文件选择器关闭后进度浮层即覆盖屏幕；期间 onBackPress 消费返回、顶栏返回禁用。
    this.importDone = 0;
    this.importTotal = 0;
    this.importBusy = true;
    let n = -1;
    try {
      const ctx = getContext(this) as common.Context;
      n = await importVaultFromFile(ctx, (done: number, total: number) => {
        this.importDone = done;
        this.importTotal = total;
      });
      await this.store.refreshItems();
    } catch (e) {
      this.importBusy = false;
      const msg = (e as Error).message;
      if (msg === '未选择文件') return;
      promptAction.showToast({ message: msg, duration: 1800 });
      return;
    }
    this.importBusy = false;
    await promptAction.showDialog({
      title: '导入完成',
      message: `已成功导入 ${n} 个条目到当前保险库。`,
      buttons: [
        { text: '确定', color: this.zc.text },
      ],
    });
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

  private async onClearAllData(): Promise<void> {
    if (cloudService.hasAccount && !cloudService.signedIn) {
      // 有云账户但会话未恢复（MFA / 离线）：本地清空会被下次同步拉回 → 先要求登录再清。
      await promptAction.showDialog({
        title: '清空所有数据',
        message: '检测到云账户但当前未登录。请先在「云账户」页登录，再回到这里清空（以便同时删除云端数据）。',
        buttons: [{ text: '知道了', color: this.zc.text }],
      });
      return;
    }
    if (cloudService.signedIn) {
      // 云端：清空会连云端数据一并删除 → 需二次验证主密码 + Secret Key（弹浮层）。
      this.clearMp = '';
      this.clearSk = '';
      this.clearError = '';
      this.showClearVerify = true;
      return;
    }
    // 本地：删除所有空间与条目，回到单个空的默认空间（保留主密码）。
    const r = await promptAction.showDialog({
      title: '清空所有数据',
      message: '将永久删除所有空间及其全部条目，仅保留一个空的默认空间。主密码保留，此操作不可撤销，建议先导出备份。',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '清空', color: this.zc.danger },
      ],
    });
    if (r.index !== 1) return;
    try {
      await vaultService.purgeAllData();
      await this.store.refresh();
      promptAction.showToast({ message: '已清空所有数据', duration: 1500 });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  private async onReset(): Promise<void> {
    const r = await promptAction.showDialog({
      title: '重置 ZPass',
      message:
        '将永久删除主密码、所有空间与条目，并清除云账户登录信息与同步绑定，应用回到初始状态。云端数据不受影响（可重新登录恢复）。此操作不可撤销。',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '重置', color: this.zc.danger },
      ],
    });
    if (r.index !== 1) return;
    // 先清本地云账户/令牌/SK/绑定（best-effort 吊销当前会话），再物理重置本地保险库。
    try {
      await cloudService.signOut();
    } catch (_e) {
      // 离线 / 吊销失败 → 忽略，继续本地重置
    }
    await this.store.reset();
    promptAction.showToast({ message: 'ZPass 已重置', duration: 1500 });
    // 重置后回到主页，由 Index 接管初始化引导
    router.back();
  }

  private closeClearVerify(): void {
    this.showClearVerify = false;
    this.clearMp = '';
    this.clearSk = '';
    this.clearError = '';
    this.clearBusy = false;
  }

  /** 云端清空：验证主密码 + Secret Key → 先删云端数据（失败即中止，避免本地清空后被同步拉回）→ 清本地。 */
  private async doClearWithCloud(): Promise<void> {
    if (this.clearBusy) return;
    this.clearError = '';
    let mpOk = false;
    try {
      mpOk = await vaultService.verifyPassword(this.clearMp);
    } catch (e) {
      this.clearError = (e as Error).message ?? '主密码验证失败';
      return;
    }
    if (!mpOk) { this.clearError = '主密码错误'; return; }
    if (!cloudService.verifySecretKey(this.clearSk)) { this.clearError = 'Secret Key 不匹配'; return; }
    this.clearBusy = true;
    try {
      await cloudService.clearAllCloudData();
      await vaultService.purgeAllData();
      await this.store.refresh();
      this.closeClearVerify();
      promptAction.showToast({ message: '已清空本地与云端所有数据', duration: 1800 });
    } catch (e) {
      this.clearError = (e as Error).message ?? '清空失败';
      this.clearBusy = false;
    }
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
        .onClick(() => { if (!this.importBusy) router.back(); });

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
              label: '清空所有数据',
              icon: $r('app.media.ic_trash'),
              iconColor: this.zc.warn,
              onTap: () => this.onClearAllData(),
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
      if (this.showClearVerify) {
        this.clearVerifyOverlay();
      }
      if (this.importBusy) {
        this.importOverlay();
      }
    }
    .width('100%').height('100%');
  }

  @Builder
  divider() {
    Divider().strokeWidth(0.5).color(this.zc.line).margin({ left: ZSpacing.lg, right: ZSpacing.lg });
  }

  @Builder
  fieldLabel(text: string) {
    Text(text)
      .fontSize(ZType.footnoteSize)
      .fontColor(this.zc.text3)
      .margin({ bottom: ZSpacing.xs });
  }

  @Builder
  clearVerifyOverlay() {
    Column() {
      Column({ space: ZSpacing.md }) {
        Text('清空所有数据')
          .fontSize(ZType.titleSize).fontWeight(FontWeight.Bold).fontColor(this.zc.text);
        Text('将永久删除本地所有空间与条目，并删除云端所有保险库数据，无法找回。请输入主密码与 Secret Key 确认。')
          .fontSize(ZType.footnoteSize).fontColor(this.zc.text3).lineHeight(18).width('100%');
        Column() {
          this.fieldLabel('主密码');
          TextInput({ placeholder: '主密码', text: this.clearMp })
            .type(InputType.Password)
            .placeholderColor(this.zc.text4).placeholderFont({ size: ZType.bodySize })
            .fontColor(this.zc.text).fontSize(ZType.bodySize)
            .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
            .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(44).width('100%')
            .enabled(!this.clearBusy)
            .onChange((v: string) => { this.clearMp = v; });
        }
        .alignItems(HorizontalAlign.Start).width('100%');
        Column() {
          this.fieldLabel('Secret Key');
          TextInput({ placeholder: 'Z1-XXXXXX-…', text: this.clearSk })
            .placeholderColor(this.zc.text4).placeholderFont({ size: ZType.bodySize })
            .fontColor(this.zc.text).fontSize(ZType.bodySize)
            .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
            .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(44).width('100%')
            .enabled(!this.clearBusy)
            .onChange((v: string) => { this.clearSk = v; });
        }
        .alignItems(HorizontalAlign.Start).width('100%');
        if (this.clearError) {
          Text(this.clearError).fontSize(ZType.footnoteSize).fontColor(this.zc.danger).width('100%');
        }
        Row({ space: ZSpacing.sm }) {
          Text('取消')
            .fontSize(ZType.bodySize).fontColor(this.zc.text2)
            .layoutWeight(1).height(44).textAlign(TextAlign.Center)
            .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
            .onClick(() => { if (!this.clearBusy) this.closeClearVerify(); });
          Text(this.clearBusy ? '清空中…' : '确认清空')
            .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(Color.White)
            .layoutWeight(1).height(44).textAlign(TextAlign.Center)
            .backgroundColor(this.zc.danger).borderRadius(ZRadius.lg)
            .onClick(() => { this.doClearWithCloud(); });
        }
        .width('100%');
      }
      .width('100%').padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl)
      .alignItems(HorizontalAlign.Start);
    }
    .width('100%').height('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl })
    .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.overlay);
  }

  /** 导入进度百分比（0-100），用于浮层进度条宽度。 */
  private importPct(): number {
    if (this.importTotal <= 0) return 0;
    const pct = Math.floor((this.importDone / this.importTotal) * 100);
    if (pct < 0) return 0;
    if (pct > 100) return 100;
    return pct;
  }

  /** 导入进行中拦截系统返回手势：返回 true 消费事件，防止页面卸载中断导入。 */
  onBackPress(): boolean {
    return this.importBusy;
  }

  @Builder
  importOverlay() {
    Column() {
      Column({ space: ZSpacing.md }) {
        LoadingProgress()
          .width(40).height(40)
          .color(this.zc.info);
        Text('正在导入数据…')
          .fontSize(ZType.titleSize).fontWeight(FontWeight.Bold).fontColor(this.zc.text);
        if (this.importTotal > 0) {
          Text(`已导入 ${this.importDone} / ${this.importTotal}`)
            .fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
          Stack({ alignContent: Alignment.Start }) {
            Row().width('100%').height(6).backgroundColor(this.zc.line).borderRadius(3);
            Row().width(`${this.importPct()}%`).height(6).backgroundColor(this.zc.info).borderRadius(3);
          }
          .width('100%').height(6);
        } else {
          Text('正在准备…')
            .fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
        }
        Text('导入期间请保持应用在前台，请勿切换页面或关闭应用。')
          .fontSize(ZType.footnoteSize).fontColor(this.zc.text4).lineHeight(18)
          .textAlign(TextAlign.Center).width('100%');
      }
      .width('100%').padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl)
      .alignItems(HorizontalAlign.Center);
    }
    .width('100%').height('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl })
    .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.overlay);
  }
}
