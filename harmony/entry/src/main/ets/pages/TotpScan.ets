// TotpScan —— 扫码添加 TOTP 条目
//
// 与 phone/app/totp/[id].tsx + components/qr-scanner.tsx 对齐：
//   - 调系统 @kit.ScanKit 扫一次二维码
//   - 解析 otpauth:// URI
//   - 把字段填入 ItemEdit 表单
//
// 鸿蒙优势：用 ScanKit 比 phone 自实现 BarCodeScanner 简单一大截 ——
// 系统级 UI + 权限弹窗 + 解码全包了。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore } from '../state/VaultStore';
import { parseOtpauth, type OtpMeta } from '../lib/Totp';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { promptAction, router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

@Entry
@ComponentV2
struct TotpScan {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  @Local raw: string = '';
  @Local meta: OtpMeta | null = null;
  @Local manualInput: string = '';
  @Local errorText: string = '';

  private async openScanner(): Promise<void> {
    this.errorText = '';
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
        // 用户取消扫描，不算错误（1000500002 = user canceled，见 @hms.core.scan.scanBarcode.d.ts）
        return;
      }
      this.errorText = `扫描失败：${err.code} ${err.message}`;
    }
  }

  private applyRaw(text: string): void {
    this.raw = text;
    const parsed = parseOtpauth(text);
    if (parsed.ok && parsed.meta) {
      this.meta = parsed.meta;
      this.errorText = '';
    } else {
      this.meta = null;
      this.errorText = '无法识别二维码 / 非 otpauth:// 格式';
    }
  }

  private applyManual(): void {
    if (!this.manualInput.trim()) return;
    this.applyRaw(this.manualInput.trim());
  }

  private async saveAsItem(): Promise<void> {
    if (!this.meta) return;
    try {
      const m = this.meta;
      const name = m.issuer || m.account || 'TOTP';
      const fields: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
      fields.secret = m.secret;
      fields.issuer = m.issuer;
      fields.account = m.account;
      fields.otp_type = m.type;
      fields.otp_algorithm = m.algorithm;
      fields.otp_digits = m.digits;
      fields.otp_period = m.period;
      fields.hotp_counter = m.counter;
      await vaultStore.createItem('totp', name, fields);
      promptAction.showToast({ message: '已添加', duration: 1500 });
      router.back();
    } catch (e) {
      this.errorText = (e as Error).message;
    }
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // 顶栏
      Row({ space: ZSpacing.sm }) {
        Text('返回')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text2)
          .onClick(() => router.back());
        Text('扫码添加 TOTP')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center);
        if (this.meta) {
          Text('保存')
            .fontSize(ZType.bodySize)
            .fontColor(this.zc.accent)
            .onClick(() => this.saveAsItem());
        } else {
          Text(' ').fontSize(ZType.bodySize);
        }
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
          // 扫描按钮
          Column({ space: ZSpacing.sm }) {
            Text('打开相机扫描')
              .fontSize(ZType.bodySize)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.zc.accentInk)
              .backgroundColor(this.zc.accent)
              .borderRadius(ZRadius.lg)
              .height(48)
              .width('100%')
              .textAlign(TextAlign.Center)
              .onClick(() => this.openScanner());

            Text('支持 otpauth:// 二维码（Google Authenticator / Authy 等通用格式）')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .width('100%')
              .textAlign(TextAlign.Center);
          }
          .width('100%')
          .padding(ZSpacing.lg)
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.xl);

          // 手动输入
          Column({ space: ZSpacing.sm }) {
            Text('或手动粘贴 otpauth:// URI')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .width('100%');
            TextArea({
              placeholder: 'otpauth://totp/Issuer:user@example.com?secret=...',
              text: this.manualInput,
            })
              .placeholderColor(this.zc.text3)
              .placeholderFont({ size: ZType.footnoteSize })
              .fontColor(this.zc.text)
              .fontSize(ZType.footnoteSize)
              .backgroundColor(this.zc.bgElev)
              .borderRadius(ZRadius.lg)
              .padding(ZSpacing.md)
              .width('100%')
              .height(96)
              .onChange((v: string) => { this.manualInput = v; });

            Text('解析')
              .fontSize(ZType.bodySize)
              .fontColor(this.zc.text)
              .backgroundColor(this.zc.bgElev)
              .borderRadius(ZRadius.lg)
              .height(44)
              .width('100%')
              .textAlign(TextAlign.Center)
              .onClick(() => this.applyManual());
          }
          .width('100%');

          // 结果预览
          if (this.meta) {
            Column({ space: ZSpacing.sm }) {
              this.metaRow('类型', this.meta.type.toUpperCase());
              this.metaRow('发行者', this.meta.issuer || '—');
              this.metaRow('账户', this.meta.account || '—');
              this.metaRow('哈希', this.meta.algorithm);
              this.metaRow('位数 / 周期', `${this.meta.digits} 位 / ${this.meta.period} s`);
            }
            .width('100%')
            .padding(ZSpacing.lg)
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl);
          }

          if (this.errorText) {
            Text(this.errorText)
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.danger)
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

  @Builder
  metaRow(label: string, value: string) {
    Row() {
      Text(label)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .layoutWeight(1);
      Text(value)
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.text)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .maxLines(1);
    }
    .width('100%');
  }
}
