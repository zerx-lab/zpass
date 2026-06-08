// Sync —— 局域网同步（client 模式）
//
// 与 phone/app/sync.tsx 行为对齐：
//   - 顶部 IP / 端口输入
//   - 6 格 PIN 输入（支持粘贴 zpass-sync:// URI 自动填充）
//   - 「连接并同步」按钮跑 connectAndSync(baseUrl, pin)
//   - 进度卡（stage / 已完成 / 总数）
//   - 完成卡（拉取 / 推送 / 冲突 统计）
//   - 错误卡
//
// 鸿蒙端无 ActivityIndicator，进度阶段用文本 + 进度条体现。
// PIN 输入用透明 TextInput 叠在 6 格视觉层上，与 phone 视觉等价。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { vaultStore } from '../state/VaultStore';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { promptAction, router } from '@kit.ArkUI';
import {
  connectAndSync,
  parseSyncQRPayload,
  type SyncProgress,
  type SyncResult,
  type SyncStage,
} from '../lib/SyncProtocol';

@Entry
@ComponentV2
struct SyncPage {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  @Local host: string = '';
  @Local port: string = '';
  @Local pin: string = '';
  @Local pinFocused: boolean = false;
  @Local busy: boolean = false;
  @Local progress: SyncProgress | null = null;
  @Local result: SyncResult | null = null;
  @Local errorText: string = '';

  /** 处理粘贴的 zpass-sync:// URI —— 解析成功就同时填 host / port / pin */
  private tryAbsorbQR(text: string): boolean {
    const parsed = parseSyncQRPayload(text);
    if (!parsed) return false;
    const m = parsed.baseUrl.match(/^http:\/\/([^:]+):(\d+)/);
    if (m) {
      this.host = m[1];
      this.port = m[2];
    }
    this.pin = parsed.pin;
    return true;
  }

  private onHostChange(v: string): void {
    if (!this.tryAbsorbQR(v)) {
      this.host = v;
    }
  }

  private onPinChange(v: string): void {
    // 与 phone 一致：仅保留数字，最多 6 位
    this.pin = v.replace(/[^0-9]/g, '').slice(0, 6);
  }

  private async onConnect(): Promise<void> {
    const h = this.host.trim();
    const p = this.port.trim();
    const pinTrim = this.pin.trim();
    if (!h || !p || !pinTrim) {
      promptAction.showToast({ message: 'IP / 端口 / PIN 都不能为空', duration: 1500 });
      return;
    }
    this.busy = true;
    this.errorText = '';
    this.progress = null;
    this.result = null;
    try {
      const baseUrl = `http://${h}:${p}`;
      const r = await connectAndSync(baseUrl, pinTrim, (prog: SyncProgress) => {
        this.progress = prog;
      });
      this.result = r;
      try {
        await vaultStore.refresh();
      } catch (_e) {
        // 静默：vault 内部 refresh 失败不影响 sync 结果展示
      }
    } catch (e) {
      this.errorText = (e as Error).message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // 顶栏
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
        Text('局域网同步')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center);
        Row().width(36);
      }
      .width('100%')
      .padding({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.sm,
        bottom: ZSpacing.sm,
      });

      Scroll() {
        Column({ space: ZSpacing.md }) {
          // Hero
          Column({ space: ZSpacing.sm }) {
            Column() {
              Image($r('app.media.ic_antenna'))
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

            Text('连接桌面端')
              .fontSize(ZType.title2Size)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.zc.text);
            Text('在桌面端「设置 → 安全 → 局域网同步」启动服务后，把屏幕上的 IP 与 PIN 填入此处')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .textAlign(TextAlign.Center)
              .lineHeight(18);
          }
          .alignItems(HorizontalAlign.Center)
          .width('100%')
          .padding({ top: ZSpacing.lg, bottom: ZSpacing.sm });

          // 表单卡
          this.formCard();

          // 进度卡
          if (this.progress) {
            this.progressCard();
          }

          // 结果卡
          if (this.result) {
            this.resultCard();
          }

          // 错误卡
          if (this.errorText) {
            this.errorCard();
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
  }

  @Builder
  formCard() {
    Column({ space: ZSpacing.md }) {
      // 对端 IP
      Column({ space: 6 }) {
        Text('对端 IP')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
        TextInput({ placeholder: '192.168.1.42', text: this.host })
          .placeholderColor(this.zc.text4)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg)
          .borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .height(44)
          .width('100%')
          .enabled(!this.busy)
          .onChange((v: string) => this.onHostChange(v));
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%');

      // 端口
      Column({ space: 6 }) {
        Text('端口')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
        TextInput({ placeholder: '55432', text: this.port })
          .type(InputType.Number)
          .placeholderColor(this.zc.text4)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bg)
          .borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .height(44)
          .width('100%')
          .enabled(!this.busy)
          .onChange((v: string) => {
            this.port = v.replace(/[^0-9]/g, '').slice(0, 5);
          });
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%');

      // PIN
      Column({ space: 6 }) {
        Text('PIN · 桌面端 6 位数字')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
        this.pinInput();
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start);

      Row({ space: ZSpacing.sm }) {
        if (!this.busy) {
          Image($r('app.media.ic_antenna'))
            .width(18)
            .height(18)
            .fillColor(this.zc.accentInk);
        }
        Text(this.busy ? '连接中…' : '连接并同步')
          .fontSize(ZType.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.accentInk);
      }
      .width('100%')
      .height(48)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.busy ? this.zc.text3 : this.zc.accent)
      .borderRadius(ZRadius.lg)
      .margin({ top: ZSpacing.xs })
      .enabled(!this.busy)
      .onClick(() => this.onConnect());
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  pinInput() {
    Stack() {
      // 6 格展示层 —— 底层不可点（hitTestMode None），事件穿透到上层 TextInput
      Row({ space: ZSpacing.xs }) {
        this.pinCell(0);
        this.pinCell(1);
        this.pinCell(2);
        this.pinCell(3);
        this.pinCell(4);
        this.pinCell(5);
      }
      .width('100%')
      .height(48)
      .hitTestBehavior(HitTestMode.None);

      // 真实输入框 —— 透明覆盖在格子上，承接键盘事件
      TextInput({ text: this.pin })
        .type(InputType.Number)
        .maxLength(6)
        .caretColor(Color.Transparent)
        .placeholderColor(Color.Transparent)
        .fontColor(Color.Transparent)
        .backgroundColor(Color.Transparent)
        .borderRadius(ZRadius.lg)
        .padding(0)
        .height(48)
        .width('100%')
        .enabled(!this.busy)
        .onFocus(() => { this.pinFocused = true; })
        .onBlur(() => { this.pinFocused = false; })
        .onChange((v: string) => this.onPinChange(v));
    }
    .width('100%')
    .height(48);
  }

  @Builder
  pinCell(i: number) {
    Column() {
      if (i < this.pin.length) {
        Text(this.pin.charAt(i))
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.accentInk)
          .fontFamily('HarmonyOS Sans Condensed');
      } else {
        Column()
          .width(6)
          .height(6)
          .borderRadius(3)
          .backgroundColor(this.zc.text4);
      }
    }
    .layoutWeight(1)
    .height(48)
    .borderRadius(ZRadius.lg)
    .backgroundColor(i < this.pin.length ? this.zc.accent : this.zc.bg)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .border({
      width: (this.pinFocused && i === this.pin.length) ? 2 : 0,
      color: this.zc.info,
    });
  }

  @Builder
  progressCard() {
    Column({ space: ZSpacing.sm }) {
      Row({ space: ZSpacing.sm }) {
        LoadingProgress()
          .width(20)
          .height(20)
          .color(this.zc.info);
        Text(this.progressLabel(this.progress!.stage))
          .fontSize(ZType.headlineSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.text)
          .layoutWeight(1);
      }
      .width('100%');

      if (this.progress!.total > 0) {
        Stack({ alignContent: Alignment.Start }) {
          Row()
            .width('100%')
            .height(6)
            .borderRadius(3)
            .backgroundColor(this.zc.bgActive);
          Row()
            .width(`${this.progressPercent()}%`)
            .height(6)
            .borderRadius(3)
            .backgroundColor(this.zc.info)
            .animation({ duration: 240, curve: Curve.Linear });
        }
        .width('100%')
        .height(6);
      }

      Text(this.progressHint())
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3);
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  private progressPercent(): number {
    if (!this.progress || this.progress.total === 0) return 0;
    const pct = Math.floor((this.progress.processed / this.progress.total) * 100);
    return Math.min(100, pct);
  }

  private progressHint(): string {
    const p = this.progress!;
    const base = `${p.processed} / ${p.total}`;
    return p.message ? `${base}  ${p.message}` : base;
  }

  private progressLabel(stage: SyncStage): string {
    switch (stage) {
      case 'pairing': return '配对中…';
      case 'manifest': return '拉取目录';
      case 'fetch': return '拉取条目';
      case 'push': return '推送条目';
      case 'merge': return '等待解决冲突';
      case 'commit': return '提交合并';
      case 'done': return '完成';
      default: return stage;
    }
  }

  @Builder
  resultCard() {
    Column({ space: ZSpacing.sm }) {
      Row({ space: ZSpacing.sm }) {
        Column() {
          Image($r('app.media.ic_shield_check'))
            .width(16)
            .height(16)
            .fillColor(this.zc.ok);
        }
        .width(28)
        .height(28)
        .borderRadius(ZRadius.md)
        .backgroundColor(alpha1f(this.zc.ok))
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center);
        Text('同步完成')
          .fontSize(ZType.headlineSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.text)
          .layoutWeight(1);
      }
      .width('100%');

      Row() {
        this.statCell('拉取', `${this.result!.applied}`, this.zc.text);
        Divider().vertical(true).strokeWidth(0.5).color(this.zc.lineSoft).height(28);
        this.statCell('推送', `${this.result!.pushed}`, this.zc.text);
        Divider().vertical(true).strokeWidth(0.5).color(this.zc.lineSoft).height(28);
        this.statCell(
          '冲突',
          `${this.result!.conflicts.length}`,
          this.result!.conflicts.length > 0 ? this.zc.warn : this.zc.text,
        );
      }
      .width('100%')
      .padding({ top: ZSpacing.sm, bottom: ZSpacing.sm });

      if (this.result!.conflicts.length > 0) {
        Row({ space: ZSpacing.xs }) {
          Image($r('app.media.ic_warning'))
            .width(14)
            .height(14)
            .fillColor(this.zc.warn);
          Text(`${this.result!.conflicts.length} 项冲突待在桌面端解决`)
            .fontSize(ZType.footnoteSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.warn)
            .layoutWeight(1);
        }
        .width('100%')
        .padding({
          left: ZSpacing.md,
          right: ZSpacing.md,
          top: ZSpacing.sm,
          bottom: ZSpacing.sm,
        })
        .backgroundColor(alpha1f(this.zc.warn))
        .borderRadius(ZRadius.md);
      }
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  statCell(label: string, value: string, color: string) {
    Column({ space: 2 }) {
      Text(value)
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor(color);
      Text(label)
        .fontSize(ZType.captionSize)
        .fontColor(this.zc.text3);
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  errorCard() {
    Column({ space: ZSpacing.sm }) {
      Row({ space: ZSpacing.sm }) {
        Column() {
          Image($r('app.media.ic_x_circle'))
            .width(16)
            .height(16)
            .fillColor(this.zc.danger);
        }
        .width(28)
        .height(28)
        .borderRadius(ZRadius.md)
        .backgroundColor(alpha1f(this.zc.danger))
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center);
        Text('同步失败')
          .fontSize(ZType.headlineSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.danger)
          .layoutWeight(1);
      }
      .width('100%');

      Text(this.errorText)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text2)
        .lineHeight(18)
        .width('100%');
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }
}
