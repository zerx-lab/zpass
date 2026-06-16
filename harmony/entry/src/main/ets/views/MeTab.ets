// MeTab —— “我的”页：用户卡 + 分组入口（不再平铺所有设置项）
//
// 分组策略对齐主流密码管理器：主页只放分组入口，具体设置项在各自子页：
//   - 用户卡：SpaceAvatar + 当前空间名（点击进空间管理）
//   - 空间：当前空间展示行
//   - 设置：应用保护（pages/MeProtection）/ 外观与交互（pages/MeAppearance）
//          / 数据管理（pages/MeData）
//   - 同步：局域网同步（pages/Sync）/ 接受设备连接（pages/SyncHost）
//   - 关于：版本（纯展示）
//
// 空间管理浮层（列表 / 新建 / 重命名 / 删除）仍留在本页；其余业务逻辑
// 已随设置项迁入对应子页。
//
// autoLock / clipboardClear 等高级设置 phone 端也未实现，本端同步不做。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { promptAction, router } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { SpaceAvatar } from '../components/SpaceAvatar';
import { sortSpaces, type Space } from '../lib/Spaces';
import { appVersionName } from '../lib/AppInfo';
import {
  SettingsErrorBox,
  SettingsRowNav,
  SettingsSectionHeader,
} from '../components/SettingsRows';

@ComponentV2
export struct MeTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  /** 真实安装包版本号（bundleManager 读回，权威来源 AppScope/app.json5） */
  @Local appVersion: string = appVersionName();

  /** 空间管理浮层 */
  @Local showSpacesModal: boolean = false;
  /** 空间命名 prompt：'create' / 'rename' / null */
  @Local spacePromptMode: string = '';
  @Local spacePromptValue: string = '';
  @Local spacePromptTargetId: string = '';
  @Local spacePromptError: string = '';

  @Computed
  get activeSpaceName(): string {
    const id = this.store.activeSpaceId;
    if (!id) return '—';
    return this.store.spaces.find((s) => s.id === id)?.name ?? '—';
  }

  /** 进入分组子页；未注册的 url 会抛 100002，吞掉并提示 */
  private async openPage(url: string): Promise<void> {
    try {
      await router.pushUrl({ url });
    } catch (_e) {
      promptAction.showToast({ message: '页面暂不可用', duration: 1500 });
    }
  }

  /* ---- 空间管理 ---- */

  private openSpaces(): void {
    if (!this.store.status.unlocked) {
      promptAction.showToast({ message: '请先解锁后再管理空间', duration: 1500 });
      return;
    }
    this.showSpacesModal = true;
  }

  private closeSpaces(): void {
    this.showSpacesModal = false;
  }

  private openCreateSpace(): void {
    this.spacePromptMode = 'create';
    this.spacePromptValue = '';
    this.spacePromptTargetId = '';
    this.spacePromptError = '';
  }

  private openRenameSpace(sp: Space): void {
    this.spacePromptMode = 'rename';
    this.spacePromptValue = sp.name;
    this.spacePromptTargetId = sp.id;
    this.spacePromptError = '';
  }

  private closeSpacePrompt(): void {
    this.spacePromptMode = '';
    this.spacePromptValue = '';
    this.spacePromptTargetId = '';
    this.spacePromptError = '';
  }

  private async submitSpacePrompt(): Promise<void> {
    const name = this.spacePromptValue.trim();
    if (!name) {
      this.spacePromptError = '名称不能为空';
      return;
    }
    if (name.length > 32) {
      this.spacePromptError = '名称不超过 32 字符';
      return;
    }
    try {
      if (this.spacePromptMode === 'create') {
        await this.store.createSpace(name);
      } else if (this.spacePromptMode === 'rename') {
        if (!this.spacePromptTargetId) return;
        await this.store.renameSpace(this.spacePromptTargetId, name);
      }
      this.closeSpacePrompt();
    } catch (e) {
      this.spacePromptError = (e as Error).message;
    }
  }

  private async onSelectSpace(sp: Space): Promise<void> {
    try {
      await this.store.setActiveSpace(sp.id);
      this.showSpacesModal = false;
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1500 });
    }
  }

  private async onDeleteSpace(sp: Space): Promise<void> {
    if (this.store.spaces.length <= 1) {
      promptAction.showToast({ message: '至少需要保留一个空间', duration: 1500 });
      return;
    }
    const r = await promptAction.showDialog({
      title: '删除空间',
      message: `确认删除「${sp.name}」？该空间下的所有条目会迁移到其它空间。`,
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '删除', color: this.zc.danger },
      ],
    });
    if (r.index !== 1) return;
    try {
      await this.store.deleteSpace(sp.id);
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  private async onLongPressSpace(sp: Space): Promise<void> {
    // ArkUI 没有 ActionSheet API，用 showActionMenu 模拟
    try {
      const r = await promptAction.showActionMenu({
        title: sp.name,
        buttons: [
          { text: '切换到此空间', color: this.zc.text },
          { text: '重命名', color: this.zc.text },
          { text: '删除', color: this.zc.danger },
        ],
      });
      if (r.index === 0) await this.onSelectSpace(sp);
      else if (r.index === 1) this.openRenameSpace(sp);
      else if (r.index === 2) await this.onDeleteSpace(sp);
    } catch (_e) {
      // 用户取消会抛 error，吞掉
    }
  }

  build() {
    Stack() {
      Column({ space: ZSpacing.sm }) {
        Row().height(this.safeArea.top).width('100%');

        Row() {
          Text('我的')
            .fontSize(ZType.largeTitleSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text)
            .letterSpacing(-0.6)
            .layoutWeight(1);
        }
        .width('100%')
        .padding({
          left: ZSpacing.lg,
          right: ZSpacing.lg,
          top: ZSpacing.xs,
          bottom: ZSpacing.sm,
        });

        Scroll() {
          Column({ space: ZSpacing.lg }) {
            // 用户卡
            this.userCard();

            // 空间
            SettingsSectionHeader({ label: '空间' });
            Column() {
              SettingsRowNav({
                label: '当前空间',
                value: this.activeSpaceName,
                icon: $r('app.media.ic_grid'),
                onTap: () => this.openSpaces(),
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 设置分组入口
            SettingsSectionHeader({ label: '设置' });
            Column() {
              SettingsRowNav({
                label: '应用保护',
                icon: $r('app.media.ic_lock_shield'),
                onTap: () => this.openPage('pages/MeProtection'),
              });
              this.divider();
              SettingsRowNav({
                label: '外观与交互',
                icon: $r('app.media.ic_settings'),
                onTap: () => this.openPage('pages/MeAppearance'),
              });
              this.divider();
              SettingsRowNav({
                label: '数据管理',
                icon: $r('app.media.ic_download'),
                onTap: () => this.openPage('pages/MeData'),
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 同步
            SettingsSectionHeader({ label: '同步' });
            Column() {
              SettingsRowNav({
                label: '局域网同步',
                value: '连接桌面端',
                icon: $r('app.media.ic_antenna'),
                onTap: () => this.openPage('pages/Sync'),
              });
              this.divider();
              SettingsRowNav({
                label: '接受设备连接',
                icon: $r('app.media.ic_users'),
                onTap: () => this.openPage('pages/SyncHost'),
              });
              this.divider();
              SettingsRowNav({
                label: '云同步',
                value: '账户与设备',
                icon: $r('app.media.ic_globe'),
                onTap: () => this.openPage('pages/CloudAccount'),
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 关于（版本与许可）
            SettingsSectionHeader({ label: '关于' });
            Column() {
              SettingsRowNav({
                label: '版本',
                value: this.appVersion,
                icon: $r('app.media.ic_info'),
                navigable: false,
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

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
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Start)
      .alignItems(HorizontalAlign.Start)
      .align(Alignment.TopStart)
      .backgroundColor(this.zc.bg);

      if (this.showSpacesModal) {
        this.spacesModalOverlay();
      }
      if (this.spacePromptMode) {
        this.spacePromptOverlay();
      }
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Center);
  }

  @Builder
  userCard() {
    Row({ space: ZSpacing.md }) {
      SpaceAvatar({
        avatarName: this.activeSpaceName,
        avatarSize: 56,
        avatarBg: this.zc.accent,
        avatarFg: this.zc.accentInk,
        avatarFontSize: 22,
        avatarRadius: 28,
      });
      Column({ space: 4 }) {
        Text(this.activeSpaceName)
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
        Text(`${this.store.items.length} 条加密条目`)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
      Image($r('app.media.ic_chevron_right'))
        .width(16)
        .height(16)
        .fillColor(this.zc.text4);
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .onClick(() => this.openSpaces());
  }

  @Builder
  divider() {
    Divider().strokeWidth(0.5).color(this.zc.line).margin({ left: ZSpacing.lg, right: ZSpacing.lg });
  }

  /** 空间管理浮层 —— 与 phone SpacesModal 行为一致 */
  @Builder
  spacesModalOverlay() {
    Column() {
      Column({ space: ZSpacing.sm }) {
        Row() {
          Text('空间')
            .fontSize(ZType.title2Size)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text)
            .layoutWeight(1);
          // 新建空间按钮：使用 ic_plus 图标替代 unicode '+'
          Row() {
            Image($r('app.media.ic_plus'))
              .width(16)
              .height(16)
              .fillColor(this.zc.text);
          }
          .width(36)
          .height(36)
          .borderRadius(ZRadius.md)
          .backgroundColor(this.zc.bgActive)
          .justifyContent(FlexAlign.Center)
          .alignItems(VerticalAlign.Center)
          .onClick(() => this.openCreateSpace());
        }
        .width('100%')
        .padding({ bottom: ZSpacing.xs });

        Scroll() {
          Column() {
            if (sortSpaces(this.store.spaces).length === 0) {
              Text('没有空间')
                .fontSize(ZType.subheadSize)
                .fontColor(this.zc.text3)
                .width('100%')
                .textAlign(TextAlign.Center)
                .padding({ top: ZSpacing.lg, bottom: ZSpacing.lg });
            } else {
              ForEach(sortSpaces(this.store.spaces), (sp: Space, idx: number) => {
                this.spaceRow(sp);
                if (idx < this.store.spaces.length - 1) {
                  Divider()
                    .strokeWidth(0.5)
                    .color(this.zc.lineSoft)
                    .margin({ left: ZSpacing.lg + 32 + ZSpacing.md });
                }
              // key 编入 name + 激活态：同 key 复用不重绘，重命名 / 切换空间后行需刷新
              }, (sp: Space) => `${sp.id}:${sp.name}:${sp.id === this.store.activeSpaceId}`);
            }
          }
          .width('100%')
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.lg);
        }
        .scrollBar(BarState.Off)
        .constraintSize({ maxHeight: 400 })
        .width('100%');

        Text('长按一行可重命名或删除')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding({ top: ZSpacing.xs });

        Text('关闭')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text2)
          .backgroundColor(this.zc.bg)
          .borderRadius(ZRadius.lg)
          .height(44)
          .width('100%')
          .textAlign(TextAlign.Center)
          .margin({ top: ZSpacing.sm })
          .onClick(() => this.closeSpaces());
      }
      .width('100%')
      .padding(ZSpacing.lg)
      .backgroundColor(this.zc.bgElev2)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .height('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, bottom: this.safeArea.keyboard })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.overlay)
    .onClick(() => {
      // 点遮罩关闭
      this.closeSpaces();
    });
  }

  @Builder
  spaceRow(sp: Space) {
    Row({ space: ZSpacing.md }) {
      SpaceAvatar({
        avatarName: sp.name,
        avatarSize: 32,
        avatarBg: sp.id === this.store.activeSpaceId ? this.zc.accent : this.zc.bgActive,
        avatarFg: sp.id === this.store.activeSpaceId ? this.zc.accentInk : this.zc.text,
        avatarFontSize: 14,
        avatarRadius: ZRadius.md,
      });
      Column({ space: 2 }) {
        Text(sp.name)
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
        Text(`#${sp.order}`)
          .fontSize(ZType.captionSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed');
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
      if (sp.id === this.store.activeSpaceId) {
        Text('当前')
          .fontSize(ZType.captionSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.info)
          .padding({ left: 8, right: 8, top: 2, bottom: 2 })
          .backgroundColor(alpha1f(this.zc.info))
          .borderRadius(ZRadius.sm);
      } else {
        Image($r('app.media.ic_chevron_right'))
          .width(14)
          .height(14)
          .fillColor(this.zc.text4);
      }
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .onClick(() => this.onSelectSpace(sp))
    .gesture(LongPressGesture({ repeat: false })
      .onAction(() => this.onLongPressSpace(sp)));
  }

  /** 空间命名 prompt 浮层 —— create / rename 共用 */
  @Builder
  spacePromptOverlay() {
    Column() {
      Column({ space: ZSpacing.md }) {
        Text(this.spacePromptMode === 'create' ? '新建空间' : '重命名空间')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);

        TextInput({ placeholder: '空间名（≤ 32 字符）', text: this.spacePromptValue })
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg)
          .borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .height(44)
          .width('100%')
          .maxLength(32)
          .enabled(!this.store.busy)
          .onChange((v: string) => {
            this.spacePromptValue = v;
            this.spacePromptError = '';
          })
          .onSubmit(() => this.submitSpacePrompt());

        if (this.spacePromptError) {
          SettingsErrorBox({ message: this.spacePromptError });
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
            .onClick(() => this.closeSpacePrompt());
          Text(this.spacePromptMode === 'create' ? '新建' : '保存')
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.accentInk)
            .backgroundColor(this.store.busy ? this.zc.text3 : this.zc.accent)
            .borderRadius(ZRadius.lg)
            .height(44)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .enabled(!this.store.busy)
            .onClick(() => this.submitSpacePrompt());
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
    .backgroundColor(this.zc.overlay);
  }
}
