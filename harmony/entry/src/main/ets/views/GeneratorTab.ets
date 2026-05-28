// GeneratorTab —— 密码 / 词组 / PIN 生成器
//
// 从原 pages/Index.ets 抽出。算法走 lib/PassGen.ets（已存在），
// 与 phone/(tabs)/generator.tsx 行为对齐。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import {
  calcStrength,
  generatePassphrase,
  generatePassword,
  generatePin,
  type GenMode,
  type GenOptions,
  type StrengthResult,
} from '../lib/PassGen';
import { copyText } from '../lib/Password';
import { promptAction } from '@kit.ArkUI';

@ComponentV2
export struct GeneratorTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  @Local genMode: GenMode = 'password';
  @Local genLength: number = 18;
  @Local genWordCount: number = 5;
  @Local genPinLength: number = 6;
  @Local genUpper: boolean = true;
  @Local genLower: boolean = true;
  @Local genNumbers: boolean = true;
  @Local genSymbols: boolean = true;
  @Local genAvoidAmbiguous: boolean = false;
  @Local genResult: string = '';
  @Local genStrength: StrengthResult = { score: 0, label: '无', entropy: 0 };

  aboutToAppear(): void {
    this.regenerate();
  }

  private currentOptions(): GenOptions {
    return {
      upper: this.genUpper,
      lower: this.genLower,
      numbers: this.genNumbers,
      symbols: this.genSymbols,
      avoidAmbiguous: this.genAvoidAmbiguous,
    };
  }

  private regenerate(): void {
    try {
      let pw = '';
      if (this.genMode === 'password') {
        pw = generatePassword(this.genLength, this.currentOptions());
      } else if (this.genMode === 'passphrase') {
        pw = generatePassphrase(this.genWordCount);
      } else {
        pw = generatePin(this.genPinLength);
      }
      this.genResult = pw;
      this.genStrength = calcStrength(pw, this.currentOptions(), this.genMode);
    } catch (_e) {
      this.genResult = '';
      this.genStrength = { score: 0, label: '失败', entropy: 0 };
    }
  }

  private async copyResult(): Promise<void> {
    if (this.genResult.length === 0) return;
    try {
      await copyText(this.genResult);
      promptAction.showToast({ message: '已复制到剪贴板', duration: 1500 });
    } catch (_e) {
      promptAction.showToast({ message: '复制失败', duration: 1500 });
    }
  }

  private strengthColor(): string {
    const s = this.genStrength.score;
    if (s >= 80) return this.zc.ok;
    if (s >= 50) return this.zc.warn;
    if (s > 0) return this.zc.danger;
    return this.zc.text3;
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      Row() {
        Text('生成器')
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
        Column({ space: ZSpacing.md }) {
          // 结果卡 —— Column 用 constraintSize(minHeight 100%) 强制至少撑满 Scroll，
          // 配合 justifyContent: Start 保证短内容（如词组 / PIN 模式）也贴顶。
          Column({ space: ZSpacing.sm }) {
            Text(this.genResult.length > 0 ? this.genResult : '— 点击重新生成 —')
              .fontSize(this.genResult.length > 20 ? 18 : 22)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.zc.text)
              .fontFamily('HarmonyOS Sans')
              .textAlign(TextAlign.Center)
              .width('100%');

            Row({ space: ZSpacing.sm }) {
              Text(`${this.genStrength.label}  ·  ${this.genStrength.entropy} bit`)
                .fontSize(ZType.footnoteSize)
                .fontColor(this.strengthColor());
            }
            .width('100%')
            .justifyContent(FlexAlign.Center);

            Stack({ alignContent: Alignment.Start }) {
              Row()
                .width('100%')
                .height(3)
                .borderRadius(2)
                .backgroundColor(this.zc.lineSoft);
              Row()
                .width(`${this.genStrength.score}%`)
                .height(3)
                .borderRadius(2)
                .backgroundColor(this.strengthColor());
            }
            .width('100%')
            .height(3);
          }
          .width('100%')
          .padding(ZSpacing.lg)
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.xl);

          // 按钮行
          Row({ space: ZSpacing.sm }) {
            Text('重新生成')
              .fontSize(ZType.bodySize)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.zc.accentInk)
              .backgroundColor(this.zc.accent)
              .borderRadius(ZRadius.lg)
              .height(44)
              .layoutWeight(1)
              .textAlign(TextAlign.Center)
              .onClick(() => this.regenerate());
            Text('复制')
              .fontSize(ZType.bodySize)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.zc.text)
              .backgroundColor(this.zc.bgElev)
              .borderRadius(ZRadius.lg)
              .height(44)
              .layoutWeight(1)
              .textAlign(TextAlign.Center)
              .onClick(() => this.copyResult());
          }
          .width('100%');

          // 模式分段
          Row() {
            this.modeChip('密码', 'password');
            this.modeChip('词组', 'passphrase');
            this.modeChip('PIN', 'pin');
          }
          .width('100%')
          .padding(2)
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.lg);

          // 选项区
          if (this.genMode === 'password') {
            this.PasswordOptions();
          } else if (this.genMode === 'passphrase') {
            this.PassphraseOptions();
          } else {
            this.PinOptions();
          }

          // 底部 Tab bar 避让
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
  }

  @Builder
  modeChip(label: string, mode: GenMode) {
    Text(label)
      .fontSize(ZType.subheadSize)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.genMode === mode ? this.zc.accentInk : this.zc.text2)
      .backgroundColor(this.genMode === mode ? this.zc.accent : '#00000000')
      .borderRadius(ZRadius.md)
      .height(34)
      .layoutWeight(1)
      .textAlign(TextAlign.Center)
      .onClick(() => {
        this.genMode = mode;
        this.regenerate();
      });
  }

  @Builder
  PasswordOptions() {
    Column({ space: ZSpacing.sm }) {
      // 长度滑块
      Column({ space: ZSpacing.xs }) {
        Row() {
          Text('长度')
            .fontSize(ZType.bodySize)
            .fontColor(this.zc.text)
            .layoutWeight(1);
          Text(`${this.genLength}`)
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text);
        }
        .width('100%');

        Slider({
          value: this.genLength,
          min: 6,
          max: 64,
          step: 1,
          style: SliderStyle.OutSet,
        })
          .blockColor(this.zc.text)
          .selectedColor(this.zc.text)
          .trackColor(this.zc.lineSoft)
          .width('100%')
          .onChange((v: number) => {
            this.genLength = Math.round(v);
            this.regenerate();
          });
      }
      .width('100%')
      .padding(ZSpacing.md)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.lg);

      this.toggleRow('大写字母', 'A-Z', this.genUpper, (v: boolean) => {
        this.genUpper = v;
        this.regenerate();
      });
      this.toggleRow('小写字母', 'a-z', this.genLower, (v: boolean) => {
        this.genLower = v;
        this.regenerate();
      });
      this.toggleRow('数字', '0-9', this.genNumbers, (v: boolean) => {
        this.genNumbers = v;
        this.regenerate();
      });
      this.toggleRow('符号', '!@#$%^&*()', this.genSymbols, (v: boolean) => {
        this.genSymbols = v;
        this.regenerate();
      });
      this.toggleRow('避免歧义', '排除 I l 1 O 0', this.genAvoidAmbiguous, (v: boolean) => {
        this.genAvoidAmbiguous = v;
        this.regenerate();
      });
    }
    .width('100%');
  }

  @Builder
  PassphraseOptions() {
    Column({ space: ZSpacing.sm }) {
      Column({ space: ZSpacing.xs }) {
        Row() {
          Text('单词数')
            .fontSize(ZType.bodySize)
            .fontColor(this.zc.text)
            .layoutWeight(1);
          Text(`${this.genWordCount}`)
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text);
        }
        .width('100%');

        Slider({
          value: this.genWordCount,
          min: 3,
          max: 10,
          step: 1,
          style: SliderStyle.OutSet,
        })
          .blockColor(this.zc.text)
          .selectedColor(this.zc.text)
          .trackColor(this.zc.lineSoft)
          .width('100%')
          .onChange((v: number) => {
            this.genWordCount = Math.round(v);
            this.regenerate();
          });
      }
      .width('100%')
      .padding(ZSpacing.md)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.lg);
    }
    .width('100%');
  }

  @Builder
  PinOptions() {
    Column({ space: ZSpacing.sm }) {
      Column({ space: ZSpacing.xs }) {
        Row() {
          Text('位数')
            .fontSize(ZType.bodySize)
            .fontColor(this.zc.text)
            .layoutWeight(1);
          Text(`${this.genPinLength}`)
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text);
        }
        .width('100%');

        Slider({
          value: this.genPinLength,
          min: 4,
          max: 10,
          step: 1,
          style: SliderStyle.OutSet,
        })
          .blockColor(this.zc.text)
          .selectedColor(this.zc.text)
          .trackColor(this.zc.lineSoft)
          .width('100%')
          .onChange((v: number) => {
            this.genPinLength = Math.round(v);
            this.regenerate();
          });
      }
      .width('100%')
      .padding(ZSpacing.md)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.lg);
    }
    .width('100%');
  }

  @Builder
  toggleRow(label: string, sub: string, value: boolean, onChange: (v: boolean) => void) {
    Row() {
      Column({ space: 2 }) {
        Text(label).fontSize(ZType.bodySize).fontColor(this.zc.text);
        Text(sub).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Toggle({ type: ToggleType.Switch, isOn: value })
        .selectedColor(this.zc.text)
        .switchPointColor(this.zc.accentInk)
        .onChange((isOn: boolean) => onChange(isOn));
    }
    .width('100%')
    .padding({
      left: ZSpacing.md,
      right: ZSpacing.md,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.lg);
  }
}
