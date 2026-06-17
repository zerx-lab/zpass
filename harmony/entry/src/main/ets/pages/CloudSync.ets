// CloudSync —— 保险库云同步（多空间：每空间 ↔ 一个云 vault，自动镜像 + 自由解绑/绑定）
//
// 角色对应 desktop features/settings/CloudSyncSection.tsx。登录后：
//   - 空间列表：逐空间展示同步状态（已同步 / 仅本地 / 超出套餐 / 已冻结），并提供
//     解绑 / 激活 / 新建并同步 / 绑定已有 操作。
//   - 自动镜像：新建空间会自动建库；其它设备按空间名领养已有 vault（见 CloudService.reconcileSpaces）。
//   - 套餐：展示当前套餐与云保险库用量；超额时新建会报错并标注空间「超出套餐」。
//   - 冲突：真冲突（同时编辑 / 删除vs编辑）逐条决策（采用本端 / 采用对端）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { cloudService, CloudService, type SpaceCloudStatus, type RemoteVaultInfo } from '../lib/CloudService';
import { vaultStore, VaultStore } from '../state/VaultStore';
import { type Entitlements } from '../lib/CloudClient';
import { type CloudConflict } from '../lib/CloudSync';
import { promptAction, router } from '@kit.ArkUI';

@Entry
@ComponentV2
struct CloudSyncPage {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local cs: CloudService = cloudService;
  @Local vs: VaultStore = vaultStore;

  /** 正在操作的空间/ vault id（禁用按钮）。 */
  @Local busyId: string = '';
  @Local errorText: string = '';
  /** 套餐额度（best-effort 拉取）。 */
  @Local ent: Entitlements | null = null;
  /** 「绑定已有」选择浮层。 */
  @Local showBindPicker: boolean = false;
  @Local bindTargetSpaceId: string = '';
  @Local bindTargetSpaceName: string = '';
  @Local bindCandidates: RemoteVaultInfo[] = [];
  /** 云端 vault 概览（进入页面 / 立即同步后拉取）：总数 / 未绑定到本地数。-1 = 未拉取。 */
  @Local remoteTotal: number = -1;
  @Local remoteUnbound: number = -1;

  async aboutToAppear(): Promise<void> {
    if (this.cs.signedIn) {
      // 进入同步设置时主动对账：下拉云端已有但本地缺失的空间（对标 desktop CloudSyncSection 挂载即
      // reconcile）。否则在其它设备新建的空间，需重新登录/解锁才会被拉下来。vault 锁定时 syncNow 自身空跑。
      if (this.vs.isUnlocked()) await this.cs.syncNow();
      await this.loadEntitlements();
      await this.loadRemoteSummary();
    }
  }

  private async loadEntitlements(): Promise<void> {
    try {
      this.ent = await this.cs.entitlements();
    } catch (_e) {
      // 离线 / 失败 → 不展示用量，不打扰
    }
  }

  /** 拉取云端 vault 概览，让用户直观看到云端有几个保险库、几个尚未落到本地。 */
  private async loadRemoteSummary(): Promise<void> {
    try {
      const all = await this.cs.listRemoteVaults();
      let unbound = 0;
      for (const v of all) { if (v.boundSpaceId.length === 0) unbound++; }
      this.remoteTotal = all.length;
      this.remoteUnbound = unbound;
    } catch (_e) {
      // 离线 / 失败 → 不展示概览
    }
  }

  private async onSyncNow(): Promise<void> {
    if (!this.vs.isUnlocked()) {
      promptAction.showToast({ message: '请先解锁本地保险库', duration: 1500 });
      return;
    }
    this.errorText = '';
    try {
      await this.cs.syncNow();
      await this.loadEntitlements();
      await this.loadRemoteSummary();
    } catch (e) {
      this.errorText = this.msg(e);
    }
  }

  private async onCreate(s: SpaceCloudStatus): Promise<void> {
    if (!this.vs.isUnlocked()) {
      promptAction.showToast({ message: '请先解锁本地保险库', duration: 1500 });
      return;
    }
    this.busyId = s.spaceId;
    this.errorText = '';
    try {
      await this.cs.createCloudVault(s.spaceId, s.spaceName);
      await this.loadEntitlements();
      promptAction.showToast({ message: `「${s.spaceName}」已上云并同步`, duration: 1500 });
    } catch (e) {
      this.errorText = this.msg(e);
    } finally {
      this.busyId = '';
    }
  }

  private async onUnlink(s: SpaceCloudStatus): Promise<void> {
    const r = await promptAction.showDialog({
      title: '解绑云保险库',
      message: `确认解绑空间「${s.spaceName}」？本地数据保留，仅停止该空间的云同步，且不再自动镜像。`,
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '解绑', color: this.zc.danger },
      ],
    });
    if (r.index !== 1) return;
    this.busyId = s.spaceId;
    this.errorText = '';
    try {
      await this.cs.unlinkSpace(s.spaceId);
      promptAction.showToast({ message: `已解绑「${s.spaceName}」`, duration: 1500 });
    } catch (e) {
      this.errorText = this.msg(e);
    } finally {
      this.busyId = '';
    }
  }

  private async onActivate(s: SpaceCloudStatus): Promise<void> {
    this.busyId = s.spaceId;
    this.errorText = '';
    try {
      await this.cs.activateRemoteVault(s.vaultId);
      await this.loadEntitlements();
      promptAction.showToast({ message: `「${s.spaceName}」已激活`, duration: 1500 });
    } catch (e) {
      this.errorText = this.msg(e);
    } finally {
      this.busyId = '';
    }
  }

  /** 绑定已有：拉未绑定的远端 vault → 弹浮层选择 → 绑定。 */
  private async onBindExisting(s: SpaceCloudStatus): Promise<void> {
    if (!this.vs.isUnlocked()) {
      promptAction.showToast({ message: '请先解锁本地保险库', duration: 1500 });
      return;
    }
    this.busyId = s.spaceId;
    this.errorText = '';
    try {
      const all = await this.cs.listRemoteVaults();
      const free = all.filter((v) => v.boundSpaceId.length === 0);
      if (free.length === 0) {
        promptAction.showToast({ message: '没有可绑定的云保险库', duration: 1500 });
        return;
      }
      this.bindCandidates = free;
      this.bindTargetSpaceId = s.spaceId;
      this.bindTargetSpaceName = s.spaceName;
      this.showBindPicker = true;
    } catch (e) {
      this.errorText = this.msg(e);
    } finally {
      this.busyId = '';
    }
  }

  /** 浮层中选定某个云 vault 绑定到目标空间。 */
  private async doBind(vaultId: string): Promise<void> {
    const spaceId = this.bindTargetSpaceId;
    const name = this.bindTargetSpaceName;
    this.showBindPicker = false;
    this.busyId = spaceId;
    this.errorText = '';
    try {
      await this.cs.bindCloudVault(spaceId, vaultId);
      await this.loadEntitlements();
      promptAction.showToast({ message: `已绑定到「${name}」`, duration: 1500 });
    } catch (e) {
      this.errorText = this.msg(e);
    } finally {
      this.busyId = '';
    }
  }

  private async onResolve(localId: string, choice: string): Promise<void> {
    try {
      await this.cs.resolveConflict(localId, choice);
    } catch (e) {
      this.errorText = this.msg(e);
    }
  }

  /* --------------------------- 文案 / 颜色助手 --------------------------- */

  private msg(e: Object): string {
    if (e instanceof Error) return e.message ?? '';
    return String(e);
  }

  /**
   * ForEach 键值：必须随行内可见状态变化而变化，否则绑定/解绑后 spaceId 不变，
   * ForEach 视作同一项不重建，行内容停留在旧状态（需返回再进才刷新）。
   */
  private spaceKey(s: SpaceCloudStatus): string {
    const flags = `${s.bound ? 1 : 0}${s.frozen ? 1 : 0}${s.detached ? 1 : 0}${s.overQuota ? 1 : 0}`;
    return `${s.spaceId}|${s.spaceName}|${flags}|${s.vaultId}`;
  }

  private statusText(s: SpaceCloudStatus): string {
    if (s.bound) return s.frozen ? '已冻结（套餐降级）' : '已同步';
    if (s.overQuota) return '超出套餐';
    if (s.detached) return '已解绑（仅本地）';
    return '仅本地';
  }

  private statusColor(s: SpaceCloudStatus): string {
    if (s.bound) return s.frozen ? this.zc.warn : this.zc.ok;
    if (s.overQuota) return this.zc.warn;
    return this.zc.text3;
  }

  private remoteLabel(v: RemoteVaultInfo): string {
    const nm = v.name.length > 0 ? v.name : this.shortId(v.vaultId);
    return `${nm} · ${v.itemCount} 条${v.frozen ? ' · 已冻结' : ''}`;
  }

  private formatTime(ms: number): string {
    if (ms <= 0) return '尚未同步';
    const d = new Date(ms);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `上次同步 ${hh}:${mm}`;
  }

  private shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(id.length - 4)}` : id;
  }

  /** 云保险库用量文案（找 vault 数量维度）；无则返回 ''。 */
  private vaultUsage(): string {
    const e = this.ent;
    if (!e) return '';
    for (const d of e.dimensions) {
      if (d.dimension === 'max_vaults' || d.dimension.indexOf('vault') >= 0) {
        const limit = d.limit === null ? '不限' : `${d.limit}`;
        return `云保险库 ${d.current}/${limit}`;
      }
    }
    return '';
  }

  build() {
    Stack() {
      Column() {
        Row().height(this.safeArea.top).width('100%');

        Row({ space: ZSpacing.sm }) {
          Row() {
            Image($r('app.media.ic_chevron_left')).width(20).height(20).fillColor(this.zc.text2);
          }
          .width(36).height(36)
          .justifyContent(FlexAlign.Center).alignItems(VerticalAlign.Center)
          .onClick(() => router.back());
          Text('保险库同步')
            .fontSize(ZType.title2Size).fontWeight(FontWeight.Bold).fontColor(this.zc.text)
            .layoutWeight(1).textAlign(TextAlign.Center);
          Row().width(36);
        }
        .width('100%')
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.sm, bottom: ZSpacing.sm });

        Scroll() {
          Column({ space: ZSpacing.md }) {
            if (!this.cs.signedIn) {
              this.signInPrompt();
            } else {
              this.statusCard();
              this.spacesSection();
              if (this.cs.conflicts.length > 0) {
                this.conflictsSection();
              }
            }
            if (this.errorText) {
              this.errorCard(this.errorText);
            }
            Row().height(80).width('100%');
          }
          .width('100%').constraintSize({ minHeight: '100%' })
          .alignItems(HorizontalAlign.Start)
          .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
        }
        .scrollBar(BarState.Off).layoutWeight(1).width('100%').align(Alignment.TopStart);

        Row().height(this.safeArea.bottom).width('100%');
      }
      .width('100%').height('100%')
      .alignItems(HorizontalAlign.Start).align(Alignment.TopStart)
      .backgroundColor(this.zc.bg);

      if (this.showBindPicker) {
        this.bindPickerOverlay();
      }
    }
    .width('100%').height('100%').alignContent(Alignment.Center);
  }

  @Builder
  bindPickerOverlay() {
    Column() {
      Column({ space: ZSpacing.sm }) {
        Text(`绑定到「${this.bindTargetSpaceName}」`)
          .fontSize(ZType.title2Size).fontWeight(FontWeight.Bold).fontColor(this.zc.text);
        Text('选择一个云保险库绑定到该空间')
          .fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
        ForEach(this.bindCandidates, (v: RemoteVaultInfo) => {
          Row() {
            Text(this.remoteLabel(v))
              .fontSize(ZType.subheadSize).fontColor(this.zc.text).layoutWeight(1)
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
          }
          .width('100%').padding(ZSpacing.md)
          .backgroundColor(this.zc.bg).borderRadius(ZRadius.md)
          .onClick(() => { this.doBind(v.vaultId); });
        }, (v: RemoteVaultInfo) => v.vaultId);
        Text('取消')
          .fontSize(ZType.bodySize).fontColor(this.zc.text2)
          .textAlign(TextAlign.Center).width('100%').height(44)
          .onClick(() => { this.showBindPicker = false; });
      }
      .width('100%').padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl)
      .alignItems(HorizontalAlign.Start);
    }
    .width('100%').height('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl })
    .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.overlay)
    .onClick(() => { this.showBindPicker = false; });
  }

  @Builder
  signInPrompt() {
    Column({ space: ZSpacing.md }) {
      Text('尚未登录云账户').fontSize(ZType.bodySize).fontColor(this.zc.text);
      Text('前往「云账户」登录后即可自动镜像各空间到云端并同步。')
        .fontSize(ZType.footnoteSize).fontColor(this.zc.text3).lineHeight(18);
      Text('前往云账户')
        .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
        .textAlign(TextAlign.Center).width('100%').height(48)
        .backgroundColor(this.zc.accent).borderRadius(ZRadius.lg)
        .onClick(() => {
          router.pushUrl({ url: 'pages/CloudAccount' }).catch(() => {});
        });
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl)
    .margin({ top: ZSpacing.lg }).alignItems(HorizontalAlign.Start);
  }

  @Builder
  statusCard() {
    Column({ space: ZSpacing.sm }) {
      Row({ space: ZSpacing.sm }) {
        Column() {
          Image($r('app.media.ic_refresh'))
            .width(20).height(20)
            .fillColor(this.cs.syncing ? this.zc.info : this.zc.text2);
        }
        .width(40).height(40).borderRadius(ZRadius.lg)
        .backgroundColor(alpha1f(this.zc.info))
        .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center);
        Column({ space: 2 }) {
          Text(this.cs.syncing ? '同步中…' : this.formatTime(this.cs.lastSyncAt))
            .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.text);
          Text(this.planLine()).fontSize(ZType.captionSize).fontColor(this.zc.text3)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
        }
        .alignItems(HorizontalAlign.Start).layoutWeight(1);
      }
      .width('100%');

      if (this.cs.lastError) {
        this.noticeRow($r('app.media.ic_error'), this.zc.danger, this.cs.lastError);
      }
      if (this.remoteTotal > 0) {
        Text(this.remoteUnbound > 0
          ? `云端 ${this.remoteTotal} 个保险库 · ${this.remoteUnbound} 个未在本地`
          : `云端 ${this.remoteTotal} 个保险库 · 均已同步`)
          .fontSize(ZType.captionSize).fontColor(this.zc.text3).width('100%');
      }

      Text(this.cs.syncing ? '同步中…' : '立即同步')
        .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
        .textAlign(TextAlign.Center).width('100%').height(48)
        .backgroundColor(this.cs.syncing ? this.zc.text3 : this.zc.accent).borderRadius(ZRadius.lg)
        .enabled(!this.cs.syncing)
        .onClick(() => this.onSyncNow());
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
  }

  private planLine(): string {
    const usage = this.vaultUsage();
    const plan = this.cs.plan.length > 0 ? `套餐：${this.cs.plan}` : this.cs.email;
    return usage.length > 0 ? `${plan} · ${usage}` : plan;
  }

  @Builder
  noticeRow(icon: Resource, color: string, message: string) {
    Row({ space: ZSpacing.xs }) {
      Image(icon).width(14).height(14).fillColor(color);
      Text(message).fontSize(ZType.footnoteSize).fontColor(color).layoutWeight(1);
    }
    .width('100%').padding({ top: 6, bottom: 6 });
  }

  @Builder
  spacesSection() {
    Column({ space: ZSpacing.sm }) {
      Text('空间')
        .fontSize(ZType.footnoteSize).fontWeight(FontWeight.Medium).fontColor(this.zc.text3);
      ForEach(this.cs.spaceStates, (s: SpaceCloudStatus) => {
        this.spaceRow(s);
      }, (s: SpaceCloudStatus) => this.spaceKey(s));
    }
    .width('100%').alignItems(HorizontalAlign.Start);
  }

  @Builder
  spaceRow(s: SpaceCloudStatus) {
    Column({ space: ZSpacing.sm }) {
      Row({ space: ZSpacing.sm }) {
        Column() {
          Row().width(8).height(8).borderRadius(4).backgroundColor(this.statusColor(s));
        }
        .width(20).height(36).justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center);
        Column({ space: 2 }) {
          Text(s.spaceName).fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.text)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
          Text(this.statusText(s)).fontSize(ZType.captionSize).fontColor(this.statusColor(s));
        }
        .alignItems(HorizontalAlign.Start).layoutWeight(1);
      }
      .width('100%');

      // 操作区
      Row({ space: ZSpacing.sm }) {
        if (s.bound && s.frozen) {
          this.rowButton('激活', this.zc.accent, this.zc.accentInk, s.spaceId, () => this.onActivate(s));
          this.rowButton('解绑', this.zc.bg, this.zc.text, s.spaceId, () => this.onUnlink(s));
        } else if (s.bound) {
          this.rowButton('解绑', this.zc.bg, this.zc.text, s.spaceId, () => this.onUnlink(s));
        } else {
          this.rowButton('新建并同步', this.zc.accent, this.zc.accentInk, s.spaceId, () => this.onCreate(s));
          this.rowButton('绑定已有', this.zc.bg, this.zc.text, s.spaceId, () => this.onBindExisting(s));
        }
      }
      .width('100%');
    }
    .width('100%').padding(ZSpacing.md).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.lg)
    .alignItems(HorizontalAlign.Start);
  }

  @Builder
  rowButton(label: string, bg: string, ink: string, spaceId: string, onTap: () => void) {
    Text(this.busyId === spaceId ? '处理中…' : label)
      .fontSize(ZType.subheadSize).fontWeight(FontWeight.Medium).fontColor(ink)
      .textAlign(TextAlign.Center).layoutWeight(1).height(38)
      .backgroundColor(this.busyId === spaceId ? this.zc.text3 : bg).borderRadius(ZRadius.md)
      .enabled(this.busyId.length === 0)
      .onClick(() => { if (this.busyId.length === 0) onTap(); });
  }

  @Builder
  conflictsSection() {
    Column({ space: ZSpacing.sm }) {
      Text(`同步冲突 · ${this.cs.conflicts.length}`)
        .fontSize(ZType.footnoteSize).fontWeight(FontWeight.Medium).fontColor(this.zc.warnText);
      ForEach(this.cs.conflicts, (c: CloudConflict) => {
        this.conflictRow(c);
      }, (c: CloudConflict) => c.localId);
    }
    .width('100%').alignItems(HorizontalAlign.Start);
  }

  @Builder
  conflictRow(c: CloudConflict) {
    Column({ space: ZSpacing.sm }) {
      Text(c.localName.length > 0 ? c.localName : (c.remoteName.length > 0 ? c.remoteName : c.localId))
        .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.text)
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
      Text(c.kind === 'delete_vs_edit' ? '删除与编辑冲突' : '两端同时修改')
        .fontSize(ZType.captionSize).fontColor(this.zc.text3);
      Row({ space: ZSpacing.sm }) {
        Text('采用本端')
          .fontSize(ZType.subheadSize).fontColor(this.zc.text)
          .textAlign(TextAlign.Center).layoutWeight(1).height(38)
          .backgroundColor(this.zc.bg).borderRadius(ZRadius.md)
          .onClick(() => this.onResolve(c.localId, 'local'));
        Text('采用对端')
          .fontSize(ZType.subheadSize).fontColor(this.zc.accentInk)
          .textAlign(TextAlign.Center).layoutWeight(1).height(38)
          .backgroundColor(this.zc.accent).borderRadius(ZRadius.md)
          .onClick(() => this.onResolve(c.localId, 'remote'));
      }
      .width('100%');
    }
    .width('100%').padding(ZSpacing.md).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.lg)
    .alignItems(HorizontalAlign.Start);
  }

  @Builder
  errorCard(message: string) {
    Row({ space: ZSpacing.xs }) {
      Image($r('app.media.ic_error')).width(14).height(14).fillColor(this.zc.danger);
      Text(message).fontSize(ZType.footnoteSize).fontColor(this.zc.danger).layoutWeight(1);
    }
    .width('100%').padding({ left: ZSpacing.md, right: ZSpacing.md, top: ZSpacing.sm, bottom: ZSpacing.sm })
    .backgroundColor(alpha1f(this.zc.danger)).borderRadius(ZRadius.md);
  }
}
