// CloudSync —— 保险库云同步（绑定云 vault / 立即同步 / 状态 / 冲突解决）
//
// 角色对应 desktop features/settings/CloudSyncSection.tsx。登录后：
//   - 未绑定：新建云保险库，或从账户下已有 vault 中绑定一个（鸿蒙单 vault ↔ 单云 vault）
//   - 已绑定：展示同步状态 + 立即同步；冻结/错误提示
//   - 冲突：真冲突（同时编辑 / 删除vs编辑）逐条决策（采用本端 / 采用对端）

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { cloudService, CloudService } from '../lib/CloudService';
import { vaultStore, VaultStore } from '../state/VaultStore';
import { type VaultSummary } from '../lib/CloudClient';
import { type CloudConflict } from '../lib/CloudSync';
import { promptAction, router } from '@kit.ArkUI';

@Entry
@ComponentV2
struct CloudSyncPage {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local cs: CloudService = cloudService;
  @Local vs: VaultStore = vaultStore;

  @Local remoteVaults: VaultSummary[] = [];
  @Local loadingVaults: boolean = false;
  @Local busy: boolean = false;
  @Local errorText: string = '';

  async aboutToAppear(): Promise<void> {
    if (this.cs.signedIn && !this.cs.vaultBound) {
      await this.loadVaults();
    }
  }

  private async loadVaults(): Promise<void> {
    this.loadingVaults = true;
    this.errorText = '';
    try {
      this.remoteVaults = await this.cs.listRemoteVaults();
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    } finally {
      this.loadingVaults = false;
    }
  }

  private async onSyncNow(): Promise<void> {
    if (!this.vs.isUnlocked()) {
      promptAction.showToast({ message: '请先解锁本地保险库', duration: 1500 });
      return;
    }
    await this.cs.syncNow();
  }

  private async onCreateVault(): Promise<void> {
    this.busy = true;
    this.errorText = '';
    try {
      await this.cs.createCloudVault();
      promptAction.showToast({ message: '云保险库已创建并同步', duration: 1500 });
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  private async onBindVault(vaultId: string): Promise<void> {
    this.busy = true;
    this.errorText = '';
    try {
      await this.cs.bindCloudVault(vaultId);
      promptAction.showToast({ message: '已绑定并同步', duration: 1500 });
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  private async onResolve(localId: string, choice: string): Promise<void> {
    try {
      await this.cs.resolveConflict(localId, choice);
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    }
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
            if (this.cs.vaultBound) {
              this.boundCard();
            } else {
              this.bindSection();
            }
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
  }

  @Builder
  signInPrompt() {
    Column({ space: ZSpacing.md }) {
      Text('尚未登录云账户').fontSize(ZType.bodySize).fontColor(this.zc.text);
      Text('前往「云账户」登录后即可绑定云保险库并同步。')
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
          Text(this.cs.email).fontSize(ZType.captionSize).fontColor(this.zc.text3)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
        }
        .alignItems(HorizontalAlign.Start).layoutWeight(1);
      }
      .width('100%');

      if (this.cs.frozen) {
        this.noticeRow($r('app.media.ic_warning'), this.zc.warnText, '云保险库已冻结（套餐降级）：可拉取、不可写入。');
      }
      if (this.cs.lastError) {
        this.noticeRow($r('app.media.ic_error'), this.zc.danger, this.cs.lastError);
      }

      if (this.cs.vaultBound) {
        Text(this.cs.syncing ? '同步中…' : '立即同步')
          .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
          .textAlign(TextAlign.Center).width('100%').height(48)
          .backgroundColor(this.cs.syncing ? this.zc.text3 : this.zc.accent).borderRadius(ZRadius.lg)
          .enabled(!this.cs.syncing)
          .onClick(() => this.onSyncNow());
      }
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
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
  boundCard() {
    Column({ space: 6 }) {
      Text('已绑定云保险库').fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      Text(this.shortId(this.cs.vaultId)).fontSize(ZType.bodySize).fontColor(this.zc.text);
    }
    .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl)
    .alignItems(HorizontalAlign.Start);
  }

  @Builder
  bindSection() {
    Column({ space: ZSpacing.md }) {
      Text('绑定云保险库')
        .fontSize(ZType.footnoteSize).fontWeight(FontWeight.Medium).fontColor(this.zc.text3);

      // 新建
      Column({ space: ZSpacing.sm }) {
        Text('新建云保险库').fontSize(ZType.bodySize).fontWeight(FontWeight.Medium).fontColor(this.zc.text);
        Text('为本机保险库创建一个全新的端到端加密云保险库，并把现有条目推送上去。')
          .fontSize(ZType.captionSize).fontColor(this.zc.text3).lineHeight(16);
        Text(this.busy ? '处理中…' : '新建并同步')
          .fontSize(ZType.subheadSize).fontWeight(FontWeight.Medium).fontColor(this.zc.accentInk)
          .textAlign(TextAlign.Center).width('100%').height(44)
          .backgroundColor(this.busy ? this.zc.text3 : this.zc.accent).borderRadius(ZRadius.lg)
          .enabled(!this.busy)
          .onClick(() => this.onCreateVault());
      }
      .width('100%').padding(ZSpacing.lg).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl)
      .alignItems(HorizontalAlign.Start);

      // 已有
      if (this.loadingVaults) {
        Text('正在加载云保险库…').fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      } else if (this.remoteVaults.length > 0) {
        Column({ space: ZSpacing.sm }) {
          Text('或绑定已有云保险库').fontSize(ZType.captionSize).fontColor(this.zc.text3);
          ForEach(this.remoteVaults, (v: VaultSummary) => {
            this.remoteVaultRow(v);
          }, (v: VaultSummary) => v.vault_id);
        }
        .width('100%').alignItems(HorizontalAlign.Start);
      }
    }
    .width('100%').alignItems(HorizontalAlign.Start);
  }

  @Builder
  remoteVaultRow(v: VaultSummary) {
    Row({ space: ZSpacing.sm }) {
      Column({ space: 2 }) {
        Text(this.shortId(v.vault_id)).fontSize(ZType.subheadSize).fontColor(this.zc.text);
        Text(`${v.item_count} 条${v.frozen ? ' · 已冻结' : ''}`)
          .fontSize(ZType.captionSize).fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start).layoutWeight(1);
      Text('绑定')
        .fontSize(ZType.subheadSize).fontColor(this.zc.accentInk)
        .padding({ left: ZSpacing.md, right: ZSpacing.md }).height(34)
        .backgroundColor(this.zc.accent).borderRadius(ZRadius.md).textAlign(TextAlign.Center)
        .onClick(() => { if (!this.busy) this.onBindVault(v.vault_id); });
    }
    .width('100%').padding(ZSpacing.md).backgroundColor(this.zc.bgElev).borderRadius(ZRadius.lg);
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
