// MeTab —— "我的"页：用户卡 / 空间 / 安全与隐私 / 外观 / 数据 / 条目统计
//
// 与 phone/(tabs)/me.tsx 行为对齐：
//   - UserCard：SpaceAvatar + 当前空间名 + 条目数
//   - 安全与隐私：改主密码 / 生物解锁 / 同步 / 立即锁定
//   - 外观：主题（跟随系统 / 深色 / 浅色）
//   - 数据：导入 / 导出 / 重置
//   - 条目统计：按 type 数量分类
//
// 主密码修改：弹出全屏 sheet，三段输入（当前 / 新 / 确认），提交走
// vaultStore.changeMasterPassword(old, new)。
//
// autoLock / clipboardClear 等高级设置 phone 端也未实现，本端同步不做。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { promptAction, router } from '@kit.ArkUI';
import { exportVaultToFile, importVaultFromFile } from '../lib/Transfer';
import { common } from '@kit.AbilityKit';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { themeStore, type ThemeMode } from '../state/ThemeStore';
import { SpaceAvatar } from '../components/SpaceAvatar';
import type { ItemPayload } from '../lib/VaultService';
import type { VaultItemType } from '../lib/VaultService';
import { sortSpaces, type Space } from '../lib/Spaces';

interface TypeRow {
  label: string;
  type: VaultItemType;
}

/** 与 AppScope/app.json5 的 versionName 保持一致 —— 跨 release 时手动同步 */
const APP_VERSION: string = '1.0.0';

const TYPE_ROWS: TypeRow[] = [
  { label: '登录凭据', type: 'login' },
  { label: '验证码', type: 'totp' },
  { label: '支付卡', type: 'card' },
  { label: '安全笔记', type: 'note' },
  { label: '身份信息', type: 'identity' },
  { label: 'SSH 密钥', type: 'ssh' },
  { label: '通行密钥', type: 'passkey' },
];

@ComponentV2
export struct MeTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

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

  /** 主题选择浮层 */
  @Local showThemePicker: boolean = false;

  /** 空间管理浮层 */
  @Local showSpacesModal: boolean = false;
  /** 空间命名 prompt：'create' / 'rename' / null */
  @Local spacePromptMode: string = '';
  @Local spacePromptValue: string = '';
  @Local spacePromptTargetId: string = '';
  @Local spacePromptError: string = '';

  aboutToAppear(): void {
    this.store.refreshTrustedState().catch(() => {
      // 静默吞 —— 探测失败时按"不支持"显示
    });
  }

  @Computed
  get activeSpaceName(): string {
    const id = this.store.activeSpaceId;
    if (!id) return '本地保险库';
    return this.store.spaces.find((s) => s.id === id)?.name ?? '本地保险库';
  }

  @Computed
  get typeCounts(): Map<VaultItemType, number> {
    const m = new Map<VaultItemType, number>();
    for (const it of this.store.items as ItemPayload[]) {
      const n = m.get(it.type) ?? 0;
      m.set(it.type, n + 1);
    }
    return m;
  }

  @Computed
  get themeLabel(): string {
    if (themeStore.mode === 'system') {
      return `跟随系统 · ${themeStore.effective === 'dark' ? '深色' : '浅色'}`;
    }
    return themeStore.mode === 'dark' ? '深色' : '浅色';
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

  private onPickTheme(mode: ThemeMode): void {
    themeStore.setMode(mode);
    this.showThemePicker = false;
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

  private async onReset(): Promise<void> {
    const r = await promptAction.showDialog({
      title: '重置保险库？',
      message:
        '将永久删除所有条目与主密码。该操作不可撤销。如果你启用了同步，请先在其它设备完成同步备份。',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '永久重置', color: this.zc.danger },
      ],
    });
    if (r.index === 1) {
      await this.store.reset();
      promptAction.showToast({ message: 'vault 已重置', duration: 1500 });
    }
  }

  private async onSync(): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/Sync' });
    } catch (_e) {
      promptAction.showToast({ message: '同步功能未启用', duration: 1500 });
    }
  }

  private async onExport(): Promise<void> {
    try {
      const ctx = getContext(this) as common.Context;
      const uri = await exportVaultToFile(ctx);
      promptAction.showToast({ message: `已导出到 ${uri}`, duration: 2500 });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  private async onImport(): Promise<void> {
    const r = await promptAction.showDialog({
      title: '从明文 JSON 导入？',
      message: '导入文件不走解密，会为每条 item 生成新 id 追加。仅信任自己刚刚导出的文件。',
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '选文件', color: this.zc.info },
      ],
    });
    if (r.index !== 1) return;
    try {
      const ctx = getContext(this) as common.Context;
      const n = await importVaultFromFile(ctx);
      await this.store.refreshItems();
      promptAction.showToast({ message: `导入 ${n} 条`, duration: 2000 });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1800 });
    }
  }

  build() {
    Stack() {
      Column({ space: ZSpacing.sm }) {
        Row().height(this.safeArea.top).width('100%');

        Row() {
          Text('我的')
            .fontSize(ZType.titleSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text)
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

            // 安全与隐私
            this.sectionHeader('安全与隐私');
            Column() {
              this.rowAction('修改主密码', undefined, () => this.onChangePwOpen());
              this.divider();
              if (this.store.trustedSupported) {
                this.rowTrustedSwitch();
                this.divider();
              }
              this.rowAction('设备间同步', 'PAKE 握手 + 端到端加密', () => this.onSync());
              this.divider();
              this.rowDanger('立即锁定', '清空内存中的 DEK', () => this.onLock());
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 外观
            this.sectionHeader('外观');
            Column() {
              this.rowValue('主题', this.themeLabel, () => {
                this.showThemePicker = true;
              });
              this.divider();
              this.rowValue('语言', '中文', () => {
                // 当前仅 zh，与 phone 一致；占位入口不可点
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 数据
            this.sectionHeader('数据');
            Column() {
              this.rowAction('导出 Vault（明文 JSON）', '仅迁移 / 备份用', () => this.onExport());
              this.divider();
              this.rowAction('从 JSON 导入', '追加到当前 vault', () => this.onImport());
              this.divider();
              this.rowDanger('重置保险库', '永久删除所有条目', () => this.onReset());
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 条目统计
            this.sectionHeader('条目统计');
            Column() {
              ForEach(TYPE_ROWS, (row: TypeRow, idx: number) => {
                this.rowCount(row.label, this.typeCounts.get(row.type) ?? 0);
                if (idx < TYPE_ROWS.length - 1) this.divider();
              }, (row: TypeRow) => row.type);
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 关于（版本与许可）
            this.sectionHeader('关于');
            Column() {
              this.rowValue('版本', APP_VERSION, () => {
                // 占位入口，phone 端也不可点
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            Text('零知识本地密码管理器 · 数据永远只在你的设备上加密存储')
              .fontSize(ZType.captionSize)
              .fontColor(this.zc.text3)
              .textAlign(TextAlign.Center)
              .width('100%')
              .padding({ top: ZSpacing.sm, left: ZSpacing.lg, right: ZSpacing.lg });

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

      if (this.showConfirmPw) {
        this.confirmPwOverlay();
      }
      if (this.showChangePw) {
        this.changePwOverlay();
      }
      if (this.showThemePicker) {
        this.themePickerOverlay();
      }
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
        Text(`${this.store.items.length} 条加密条目 · 零知识`)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
      Text('›')
        .fontSize(20)
        .fontColor(this.zc.text3);
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .onClick(() => this.openSpaces());
  }

  @Builder
  sectionHeader(label: string) {
    Text(label)
      .fontSize(ZType.footnoteSize)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.zc.text3)
      .padding({ left: ZSpacing.sm, top: ZSpacing.sm, bottom: 6 });
  }

  @Builder
  rowAction(label: string, sub: string | undefined, onTap: () => void) {
    Row() {
      Column({ space: 2 }) {
        Text(label).fontSize(ZType.bodySize).fontColor(this.zc.text);
        if (sub) {
          Text(sub).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
      Text('›').fontSize(20).fontColor(this.zc.text3);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .onClick(() => onTap());
  }

  @Builder
  rowValue(label: string, value: string, onTap: () => void) {
    Row() {
      Text(label)
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.text)
        .layoutWeight(1);
      Text(value)
        .fontSize(ZType.subheadSize)
        .fontColor(this.zc.text3)
        .margin({ right: ZSpacing.xs });
      Text('›').fontSize(20).fontColor(this.zc.text3);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .onClick(() => onTap());
  }

  @Builder
  rowCount(label: string, count: number) {
    Row() {
      Text(label).fontSize(ZType.bodySize).fontColor(this.zc.text).layoutWeight(1);
      Text(`${count} 项`).fontSize(ZType.subheadSize).fontColor(this.zc.text3);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    });
  }

  @Builder
  rowDanger(label: string, sub: string, onTap: () => void) {
    Row() {
      Column({ space: 2 }) {
        Text(label).fontSize(ZType.bodySize).fontColor(this.zc.danger);
        Text(sub).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .onClick(() => onTap());
  }

  @Builder
  rowTrustedSwitch() {
    Row() {
      Column({ space: 2 }) {
        Text('生物解锁').fontSize(ZType.bodySize).fontColor(this.zc.text);
        Text(this.trustedValueLabel).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Stack({ alignContent: Alignment.Start }) {
        Row()
          .width(50)
          .height(30)
          .backgroundColor(this.store.trustedEnabled ? this.zc.accent : this.zc.text3)
          .borderRadius(15);
        Row()
          .width(26)
          .height(26)
          .backgroundColor('#FFFFFF')
          .borderRadius(13)
          .margin({ left: this.store.trustedEnabled ? 22 : 2 });
      }
      .width(50)
      .height(30)
      .opacity(this.store.busy ? 0.5 : 1)
      .onClick(() => {
        if (this.store.busy) return;
        this.onToggleTrustedDevice(!this.store.trustedEnabled);
      });
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    });
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
        Text('确认主密码')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);
        Text('启用生物解锁需要再次校验主密码')
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
          Text(this.confirmPwError)
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.danger)
            .width('100%')
            .textAlign(TextAlign.Start);
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
          Text(this.store.busy ? '校验中…' : '启用')
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
    .backgroundColor('rgba(0,0,0,0.5)')
    .onClick(() => {
      // 点击遮罩区不关闭 —— 显式按取消才退出
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

        if (this.cpError) {
          Text(this.cpError)
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.danger)
            .width('100%');
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
          Text(this.store.busy ? '更新中…' : '更新')
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
    .backgroundColor('rgba(0,0,0,0.5)')
    .onClick(() => {
      // 遮罩点击不关闭
    });
  }

  /** 主题选择浮层 */
  @Builder
  themePickerOverlay() {
    Column() {
      Column({ space: ZSpacing.sm }) {
        Text('选择主题')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .padding({ bottom: ZSpacing.xs });

        this.themeOption('跟随系统', 'system');
        this.themeOption('深色', 'dark');
        this.themeOption('浅色', 'light');

        Text('取消')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text2)
          .backgroundColor(this.zc.bg)
          .borderRadius(ZRadius.lg)
          .height(44)
          .width('100%')
          .textAlign(TextAlign.Center)
          .margin({ top: ZSpacing.sm })
          .onClick(() => {
            this.showThemePicker = false;
          });
      }
      .width('100%')
      .padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .height('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor('rgba(0,0,0,0.5)')
    .onClick(() => {
      this.showThemePicker = false;
    });
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
          Text('+')
            .fontSize(22)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text)
            .width(36)
            .height(36)
            .textAlign(TextAlign.Center)
            .borderRadius(ZRadius.md)
            .backgroundColor(this.zc.bgElev)
            .onClick(() => this.openCreateSpace());
        }
        .width('100%')
        .padding({ bottom: ZSpacing.xs });

        Scroll() {
          Column() {
            ForEach(sortSpaces(this.store.spaces), (sp: Space, idx: number) => {
              this.spaceRow(sp);
              if (idx < this.store.spaces.length - 1) {
                Divider()
                  .strokeWidth(0.5)
                  .color(this.zc.lineSoft)
                  .margin({ left: ZSpacing.lg + 32 + ZSpacing.md });
              }
            }, (sp: Space) => sp.id);
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
          .fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
      if (sp.id === this.store.activeSpaceId) {
        Text('当前')
          .fontSize(ZType.captionSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.info)
          .padding({ left: 8, right: 8, top: 2, bottom: 2 })
          .backgroundColor(`${this.zc.info}1f`)
          .borderRadius(ZRadius.sm);
      } else {
        Text('›').fontSize(16).fontColor(this.zc.text4);
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
          Text(this.spacePromptError)
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.danger)
            .width('100%');
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
    .backgroundColor('rgba(0,0,0,0.5)');
  }

  @Builder
  themeOption(label: string, value: ThemeMode) {
    Row() {
      Text(label)
        .fontSize(ZType.bodySize)
        .fontColor(themeStore.mode === value ? this.zc.accentInk : this.zc.text)
        .layoutWeight(1);
      if (themeStore.mode === value) {
        Text('· 当前')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.accentInk);
      }
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md })
    .backgroundColor(themeStore.mode === value ? this.zc.accent : this.zc.bg)
    .borderRadius(ZRadius.lg)
    .onClick(() => this.onPickTheme(value));
  }
}
