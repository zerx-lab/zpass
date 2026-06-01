// TotpScan —— 扫码添加 TOTP 条目
//
// 与 phone/components/qr-scanner.tsx 对齐：
//   - 调系统 @kit.ScanKit 扫一次二维码（相机 + 相册合一）
//   - 手动粘贴 otpauth:// URI
//   - 解析 → 结果预览（含密钥显示/隐藏切换、防钓鱼警告）
//   - 确认后 push 到 ItemEdit 表单，不直接写库（FROZEN ROUTER CONTRACT）
//
// 鸿蒙优势：用 ScanKit 比 phone 自实现 BarCodeScanner 简单一大截 ——
// 系统级 UI + 权限弹窗 + 解码全包了。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { parseOtpauth, formatBase32Groups, type OtpMeta, type OtpParseError } from '../lib/Totp';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { promptAction, router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vibrator } from '@kit.SensorServiceKit';

// 错误标题 / 提示映射（与 phone qr-scanner.tsx 对齐）
function errorTitle(err: OtpParseError | 'no-qr'): string {
  if (err === 'no-qr') return '未识别到二维码';
  if (err === 'not-otpauth') return '不是身份验证器二维码';
  if (err === 'missing-secret') return '二维码缺少密钥参数';
  if (err === 'invalid-type') return '不支持的 OTP 类型';
  return 'URI 格式无法解析';
}

function errorHint(err: OtpParseError | 'no-qr'): string {
  if (err === 'no-qr') return '请确保图片中二维码清晰、不被遮挡。';
  if (err === 'not-otpauth') return '扫到的内容不是 otpauth:// 协议链接。';
  if (err === 'missing-secret') return 'otpauth:// URI 中必须包含 secret 参数。';
  if (err === 'invalid-type') return '仅支持 totp / hotp / steam 三种协议。';
  return '请检查 URI 拼写是否正确。';
}

// OTP 类型友好标签（phone 映射：steam→Steam Guard, hotp→HOTP, totp→TOTP）
function otpTypeLabel(t: string): string {
  if (t === 'steam') return 'Steam Guard';
  if (t === 'hotp') return 'HOTP';
  return 'TOTP';
}

// 16 个 dot 索引（不能在 build 内 let，提到文件作用域）
const DOT_INDICES: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

@Entry
@ComponentV2
struct TotpScan {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  @Local raw: string = '';
  @Local meta: OtpMeta | null = null;
  @Local manualInput: string = '';

  // 错误态：kind（no-qr | not-otpauth | missing-secret | invalid-type | invalid-uri | 'scan-err'）
  // rawPreview：扫到但非 otpauth 时最多 80 字符的原始内容
  @Local errKind: string = '';          // '' = 无错误
  @Local rawPreview: string = '';       // 扫到的内容前 80 字符
  @Local scanErrMsg: string = '';       // ScanKit 自身错误文案

  @Local revealSecret: boolean = false;
  @Local isDecoding: boolean = false;

  private resetState(): void {
    this.raw = '';
    this.meta = null;
    this.errKind = '';
    this.rawPreview = '';
    this.scanErrMsg = '';
    this.revealSecret = false;
    this.isDecoding = false;
  }

  // 触感反馈辅助（与 Clipboard.ets lightHaptic 模式一致；无马达/模拟器静默忽略）
  private async playHaptic(effectId: string): Promise<void> {
    try {
      await vibrator.startVibration(
        { type: 'preset', effectId },
        { id: 0, usage: 'touch' },
      );
    } catch (_e) {
      // 无马达 / 模拟器：静默忽略
    }
  }

  private applyRaw(text: string): void {
    this.raw = text;
    const parsed = parseOtpauth(text);
    if (parsed.ok && parsed.meta) {
      this.meta = parsed.meta;
      this.errKind = '';
      this.rawPreview = '';
      this.scanErrMsg = '';
      // 触感反馈：成功（EFFECT_HARD，API 12+）
      this.playHaptic(vibrator.HapticFeedback.EFFECT_HARD);
    } else {
      this.meta = null;
      this.errKind = parsed.error ?? 'no-qr';
      // 与 phone qr-scanner.tsx 对齐：任何解析失败均保存前 80 字符供用户核查
      this.rawPreview = text.length > 0 ? text.slice(0, 80) : '';
      // 触感反馈：失败/警告（EFFECT_SOFT，API 12+）
      this.playHaptic(vibrator.HapticFeedback.EFFECT_SOFT);
    }
  }

  private async openScanner(): Promise<void> {
    this.errKind = '';
    this.rawPreview = '';
    this.scanErrMsg = '';
    this.isDecoding = true;
    try {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.QR_CODE],
        enableMultiMode: false,
        enableAlbum: true,
      };
      const result = await scanBarcode.startScanForResult(
        getContext(this) as Context,
        options,
      );
      this.applyRaw(result.originalValue);
    } catch (e) {
      const err = e as BusinessError;
      if (err.code === 1000500002) {
        // 用户取消扫描，不算错误
        return;
      }
      this.errKind = 'scan-err';
      this.scanErrMsg = `扫描失败：${err.code} ${err.message}`;
    } finally {
      this.isDecoding = false;
    }
  }

  private applyManual(): void {
    if (!this.manualInput.trim()) return;
    this.applyRaw(this.manualInput.trim());
  }

  // FROZEN ROUTER CONTRACT: push to ItemEdit with initialTotpUri
  private navigateToEdit(): void {
    if (!this.meta) return;
    try {
      router.pushUrl({
        url: 'pages/ItemEdit',
        params: { id: 'new', type: 'totp', initialTotpUri: this.raw },
      });
    } catch (e) {
      promptAction.showToast({ message: `跳转失败：${(e as Error).message}`, duration: 2000 });
    }
  }

  // 是否处于错误态
  private hasError(): boolean {
    return this.errKind !== '';
  }

  // 错误标题（供 build 使用）
  private getErrorTitle(): string {
    if (this.errKind === 'scan-err') return '扫描失败';
    return errorTitle(this.errKind as (OtpParseError | 'no-qr'));
  }

  // 错误提示（供 build 使用）
  private getErrorHint(): string {
    if (this.errKind === 'scan-err') return this.scanErrMsg;
    return errorHint(this.errKind as (OtpParseError | 'no-qr'));
  }

  // 参数行文案（HOTP 显示计数器，TOTP/Steam 显示周期）
  private paramLine(): string {
    if (!this.meta) return '';
    const m = this.meta;
    if (m.type === 'hotp') {
      return `${m.algorithm} · ${m.digits} 位 · 计数器 ${m.counter}`;
    }
    return `${m.algorithm} · ${m.digits} 位 · ${m.period}s`;
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // 顶栏
      Row({ space: ZSpacing.sm }) {
        // 返回按钮：ic_chevron_left 图标
        Row() {
          Image($r('app.media.ic_chevron_left'))
            .width(20).height(20)
            .fillColor(this.zc.text2);
        }
        .width(44).height(44)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .onClick(() => router.back());

        Text('添加验证码')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center);

        // 占位（平衡左侧按钮）
        Row().width(44).height(44);
      }
      .width('100%')
      .padding({
        left: ZSpacing.sm,
        right: ZSpacing.sm,
        top: ZSpacing.sm,
        bottom: ZSpacing.sm,
      });

      Scroll() {
        Column({ space: ZSpacing.md }) {

          // ── 解码中 ──────────────────────────────────────────────
          if (this.isDecoding) {
            Column({ space: ZSpacing.sm }) {
              LoadingProgress()
                .width(40).height(40)
                .color(this.zc.text3);
              Text('正在识别…')
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.text3);
            }
            .width('100%')
            .height(160)
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl);
          }

          // ── 结果：解析成功 ───────────────────────────────────────
          if (!this.isDecoding && this.meta !== null) {
            // 成功徽标 "识别成功"
            Row({ space: ZSpacing.xs }) {
              Image($r('app.media.ic_verified'))
                .width(14).height(14)
                .fillColor(this.zc.ok);
              Text('识别成功')
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.ok);
            }
            .height(28)
            .padding({ left: ZSpacing.sm, right: ZSpacing.sm })
            .backgroundColor(this.zc.ok + '1f')
            .borderRadius(ZRadius.md)
            .alignItems(VerticalAlign.Center);

            // Meta 卡片
            Column() {
              this.metaInfoRow('协议', otpTypeLabel(this.meta.type), false);
              if (this.meta.issuer) {
                Divider().strokeWidth(0.5).color(this.zc.lineSoft);
                this.metaInfoRow('发行者', this.meta.issuer, false);
              }
              if (this.meta.account) {
                Divider().strokeWidth(0.5).color(this.zc.lineSoft);
                this.metaInfoRow('账户', this.meta.account, false);
              }
              Divider().strokeWidth(0.5).color(this.zc.lineSoft);
              this.metaInfoRow('参数', this.paramLine(), true);
              Divider().strokeWidth(0.5).color(this.zc.lineSoft);
              this.secretRow();
            }
            .width('100%')
            .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.xs, bottom: ZSpacing.xs })
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            // 防钓鱼警告
            Text('请确认发行者与账户与你的预期一致再使用。来源不明的二维码可能是钓鱼。')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .width('100%');

            // 操作按钮行
            Row({ space: ZSpacing.sm }) {
              // 重新扫（次要）
              Text('重新扫')
                .fontSize(ZType.bodySize)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.zc.text)
                .backgroundColor(this.zc.bgElev)
                .borderRadius(ZRadius.lg)
                .height(48)
                .layoutWeight(1)
                .textAlign(TextAlign.Center)
                .onClick(() => this.resetState());

              // 使用此密钥（主要，含 check 图标）
              Row({ space: ZSpacing.xs }) {
                Image($r('app.media.ic_check'))
                  .width(16).height(16)
                  .fillColor(this.zc.accentInk);
                Text('使用此密钥')
                  .fontSize(ZType.bodySize)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.zc.accentInk);
              }
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              .height(48)
              .layoutWeight(1)
              .backgroundColor(this.zc.accent)
              .borderRadius(ZRadius.lg)
              .onClick(() => this.navigateToEdit());
            }
            .width('100%');
          }

          // ── 结果：解析失败 ───────────────────────────────────────
          if (!this.isDecoding && this.hasError()) {
            Column({ space: ZSpacing.md }) {
              // 警告图标
              Column() {
                Image($r('app.media.ic_warning'))
                  .width(24).height(24)
                  .fillColor(this.zc.warn);
              }
              .width(64).height(64)
              .borderRadius(ZRadius.xl)
              .backgroundColor(this.zc.warn + '1f')
              .justifyContent(FlexAlign.Center)
              .alignItems(HorizontalAlign.Center);

              Text(this.getErrorTitle())
                .fontSize(ZType.title2Size)
                .fontWeight(FontWeight.Bold)
                .fontColor(this.zc.text)
                .textAlign(TextAlign.Center)
                .width('100%');

              Text(this.getErrorHint())
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.text3)
                .textAlign(TextAlign.Center)
                .width('100%');

              // 原始内容预览（仅 not-otpauth 时有内容）
              if (this.rawPreview) {
                Column({ space: ZSpacing.xs }) {
                  Text('识别到的内容')
                    .fontSize(ZType.captionSize)
                    .fontColor(this.zc.text3)
                    .width('100%');
                  Text(this.rawPreview.length >= 80 ? this.rawPreview + '…' : this.rawPreview)
                    .fontSize(ZType.footnoteSize)
                    .fontColor(this.zc.text2)
                    .fontFamily('HarmonyOS Sans Condensed')
                    .maxLines(4)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%');
                }
                .width('100%')
                .padding(ZSpacing.md)
                .backgroundColor(this.zc.bgElev)
                .borderRadius(ZRadius.lg);
              }

              // 重试按钮
              Row({ space: ZSpacing.xs }) {
                Image($r('app.media.ic_refresh'))
                  .width(16).height(16)
                  .fillColor(this.zc.accentInk);
                Text('重试')
                  .fontSize(ZType.bodySize)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.zc.accentInk);
              }
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              .height(48)
              .width('100%')
              .backgroundColor(this.zc.accent)
              .borderRadius(ZRadius.lg)
              .onClick(() => this.resetState());
            }
            .width('100%')
            .padding(ZSpacing.xl)
            .alignItems(HorizontalAlign.Center);
          }

          // ── 空闲态：扫码 + 手动粘贴（无结果、无错误、非解码中时显示）──
          if (!this.isDecoding && !this.meta && !this.hasError()) {
            // 扫码按钮卡
            Column({ space: ZSpacing.sm }) {
              Row({ space: ZSpacing.xs }) {
                Image($r('app.media.ic_qr_scan'))
                  .width(18).height(18)
                  .fillColor(this.zc.accentInk);
                Text('打开相机扫描')
                  .fontSize(ZType.bodySize)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.zc.accentInk);
              }
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              .height(48)
              .width('100%')
              .backgroundColor(this.zc.accent)
              .borderRadius(ZRadius.lg)
              .onClick(() => this.openScanner());

              Text('支持 otpauth:// 二维码（Google Authenticator / Authy 等通用格式），可扫相册图片')
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.text3)
                .width('100%')
                .textAlign(TextAlign.Center);
            }
            .width('100%')
            .padding(ZSpacing.lg)
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl);

            // 手动粘贴卡
            Column({ space: ZSpacing.sm }) {
              Text('或手动粘贴 otpauth:// URI')
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.text3)
                .width('100%');
              Text('支持 totp / hotp / steam 三种协议，可指定 SHA1/256/512 与位数 / 周期等参数。')
                .fontSize(ZType.captionSize)
                .fontColor(this.zc.text3)
                .width('100%');
              TextArea({
                placeholder: 'otpauth://totp/Issuer:user@example.com?secret=…&algorithm=SHA1&digits=6&period=30',
                text: this.manualInput,
              })
                .placeholderColor(this.zc.text3)
                .placeholderFont({ size: ZType.footnoteSize })
                .fontColor(this.zc.text)
                .fontSize(ZType.footnoteSize)
                .fontFamily('HarmonyOS Sans Condensed')
                .backgroundColor(this.zc.bg)
                .borderRadius(ZRadius.lg)
                .padding(ZSpacing.md)
                .width('100%')
                .height(96)
                .onChange((v: string) => { this.manualInput = v; });

              // 解析按钮
              Row({ space: ZSpacing.xs }) {
                Image($r('app.media.ic_arrow_right'))
                  .width(16).height(16)
                  .fillColor(this.zc.accentInk);
                Text('解析')
                  .fontSize(ZType.bodySize)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.zc.accentInk);
              }
              .justifyContent(FlexAlign.Center)
              .alignItems(VerticalAlign.Center)
              .height(44)
              .width('100%')
              .backgroundColor(this.manualInput.trim() ? this.zc.accent : this.zc.bgElev)
              .borderRadius(ZRadius.lg)
              .opacity(this.manualInput.trim() ? 1.0 : 0.5)
              .onClick(() => this.applyManual());
            }
            .width('100%');
          }

          Row().height(40).width('100%');
        }
        .width('100%')
        .constraintSize({ minHeight: '100%' })
        .justifyContent(FlexAlign.Start)
        .alignItems(HorizontalAlign.Start)
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md });
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
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    .padding({ bottom: this.safeArea.keyboard });
  }

  // 通用 meta 信息行（label 左 / value 右）
  @Builder
  metaInfoRow(label: string, value: string, mono: boolean) {
    Row({ space: ZSpacing.md }) {
      Text(label)
        .fontSize(ZType.subheadSize)
        .fontColor(this.zc.text3)
        .width(72);
      Text(value)
        .fontSize(mono ? ZType.subheadSize : ZType.bodySize)
        .fontFamily(mono ? 'HarmonyOS Sans Condensed' : 'HarmonyOS Sans')
        .fontColor(this.zc.text)
        .fontWeight(FontWeight.Medium)
        .layoutWeight(1)
        .textAlign(TextAlign.End)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
    }
    .width('100%')
    .padding({ top: ZSpacing.md, bottom: ZSpacing.md });
  }

  // 密钥行（含显示/隐藏切换）
  @Builder
  secretRow() {
    Column({ space: ZSpacing.sm }) {
      // 标题行：密钥 label + 显示/隐藏按钮
      Row() {
        Text('密钥')
          .fontSize(ZType.subheadSize)
          .fontColor(this.zc.text3)
          .layoutWeight(1);
        Row({ space: ZSpacing.xs }) {
          Image(this.revealSecret
            ? $r('app.media.ic_eye_off')
            : $r('app.media.ic_eye'))
            .width(13).height(13)
            .fillColor(this.zc.info);
          Text(this.revealSecret ? '隐藏' : '显示')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.info)
            .fontWeight(FontWeight.Bold);
        }
        .padding({ left: ZSpacing.xs, right: ZSpacing.xs, top: 2, bottom: 2 })
        .onClick(() => { this.revealSecret = !this.revealSecret; });
      }
      .width('100%')
      .padding({ top: ZSpacing.md, bottom: ZSpacing.xs });

      // 密钥内容：隐藏时显示 16 个圆点，显示时显示格式化 base32
      if (this.revealSecret && this.meta) {
        Text(formatBase32Groups(this.meta.secret))
          .fontSize(ZType.bodySize)
          .fontFamily('HarmonyOS Sans Condensed')
          .fontColor(this.zc.text)
          .fontWeight(FontWeight.Medium)
          .letterSpacing(0.5)
          .copyOption(CopyOptions.LocalDevice)
          .width('100%')
          .padding({ bottom: ZSpacing.md });
      } else {
        Row({ space: 6 }) {
          ForEach(DOT_INDICES, (slot: number) => {
            Row()
              .width(7).height(7)
              .borderRadius(4)
              .backgroundColor(this.zc.text3);
          }, (slot: number) => slot.toString());
        }
        .width('100%')
        .padding({ top: ZSpacing.xs, bottom: ZSpacing.md });
      }
    }
    .width('100%');
  }
}
