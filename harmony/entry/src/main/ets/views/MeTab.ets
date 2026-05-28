// MeTab —— "我的"页：主密码 / 信任设备 / 同步 / 重置
//
// 与 phone/(tabs)/me.tsx 对齐（基础版本，不含云备份 / 信任设备 / 详细的设置项；
// 后续 Phase 5 补齐）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { promptAction, router } from '@kit.ArkUI';
import { exportVaultToFile, importVaultFromFile } from '../lib/Transfer';
import { common } from '@kit.AbilityKit';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

@ComponentV2
export struct MeTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  /** 启用信任设备时的密码确认浮层 */
  @Local showConfirmPw: boolean = false;
  @Local confirmPw: string = '';
  @Local confirmPwError: string = '';

  aboutToAppear(): void {
    // 刷新信任设备能力 / 启用态 —— 用户从其它 tab 切回时也能拿到最新
    this.store.refreshTrustedState().catch(() => {
      // 静默吞 —— 探测失败时按"不支持"显示
    });
  }

  private async onLock(): Promise<void> {
    this.store.lock();
    promptAction.showToast({ message: '已锁定', duration: 1200 });
  }

  /**
   * Switch onTap 入口。target = 用户期望的目标态（即取反当前 value）。
   *
   * 自绘 Switch UI 完全由 store.trustedEnabled 驱动，所以这里只关心
   * 业务执行 —— 业务成功后 store.trustedEnabled 自动变化、@Trace 触发
   * build 重新执行、Switch 渲染即跟随更新。无需任何额外的"强制刷新"。
   */
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
    promptAction
      .showDialog({
        title: '重置保险库？',
        message:
          '将永久删除所有条目与主密码。该操作不可撤销。如果你启用了同步，请先在其它设备完成同步备份。',
        buttons: [
          { text: '取消', color: this.zc.text2 },
          { text: '永久重置', color: this.zc.danger },
        ],
      })
      .then(async (r) => {
        if (r.index === 1) {
          await this.store.reset();
          promptAction.showToast({ message: 'vault 已重置', duration: 1500 });
        }
      });
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
      message: '导入文件不走厄重装，会为每条 item 生成新 id 追加。仅信任自己刚刚导出的文件。',
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
            // 状态卡
            Column({ space: ZSpacing.xs }) {
              Text(this.store.status.unlocked ? '已解锁' : '已锁定')
                .fontSize(ZType.title2Size)
                .fontWeight(FontWeight.Bold)
                .fontColor(this.store.status.unlocked ? this.zc.ok : this.zc.text2);
              Text(`${this.store.status.itemCount} 个条目`)
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.text3);
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding(ZSpacing.lg)
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl);

            // 操作组
            Column() {
              if (this.store.trustedSupported) {
                this.rowTrustedSwitch();
                this.divider();
              }
              this.rowAction('立即锁定', '清空内存中的 DEK', () => this.onLock());
              this.divider();
              this.rowAction('设备间同步', 'PAKE 握手 + 端到端加密', () => this.onSync());
              this.divider();
              this.rowAction('导出 Vault（明文 JSON）', '仅迁移 / 备份用', () => this.onExport());
              this.divider();
              this.rowAction('从 JSON 导入', '追加到当前 vault', () => this.onImport());
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 危险区
            Column() {
              this.rowDanger('重置保险库', '永久删除所有条目', () => this.onReset());
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

      if (this.showConfirmPw) {
        this.confirmPwOverlay();
      }
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Center);
  }

  @Builder
  rowAction(label: string, sub: string, onTap: () => void) {
    Row() {
      Column({ space: 2 }) {
        Text(label).fontSize(ZType.bodySize).fontColor(this.zc.text);
        Text(sub).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
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

  /**
   * 生物解锁开关行 —— 专用 @Builder，UI 完全由 this.store.trustedEnabled 驱动
   *
   * 关键点：所有属性表达式 **直接读 `this.store.trustedEnabled`**，不通过
   * @Builder 参数 snapshot 间接传递；这样 ArkUI V2 才能正确建立 @Trace 反向
   * 依赖，trustedEnabled 一变 ArkUI 立刻重新评估颜色 / 位置属性。
   *
   * 弃用系统 Toggle 的原因：Toggle 用户拨动后进入内部 uncontrolled 状态，与
   * 外部 isOn 解耦；自绘 Stack + Row 完全无内部状态，从根上避免错乱。
   */
  @Builder
  rowTrustedSwitch() {
    Row() {
      Column({ space: 2 }) {
        Text('生物解锁').fontSize(ZType.bodySize).fontColor(this.zc.text);
        Text('用指纹或人脸快速解锁').fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Stack({ alignContent: Alignment.Start }) {
        // 背景轨道 —— 颜色由 trustedEnabled 决定
        Row()
          .width(50)
          .height(30)
          .backgroundColor(this.store.trustedEnabled ? this.zc.accent : this.zc.text3)
          .borderRadius(15);
        // 圆点 —— 位置由 trustedEnabled 决定（已启用靠右 / 未启用靠左）
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

  /** 启用信任设备时的主密码确认浮层 —— 半透明遮罩 + 居中卡片 */
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
      // 点击遮罩区不关闭 —— 避免误触丢密码；显式按取消才退出
    });
  }
}
