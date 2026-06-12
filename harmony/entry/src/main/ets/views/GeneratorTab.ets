// GeneratorTab —— 密码 / 词组 / PIN 生成器
//
// 从原 pages/Index.ets 抽出。算法走 lib/PassGen.ets（已存在），
// 与 phone/(tabs)/generator.tsx 行为对齐：三种模式 + 批量去重生成 +
// 逐字符着色 + 强度条 + 复制反馈 + 保存到密码库。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import {
  calcStrength,
  generatePassphrase,
  generatePassword,
  generatePin,
  generateUniqueBatch,
  type GenMode,
  type GenOptions,
  type StrengthResult,
} from '../lib/PassGen';
import { copyText } from '../lib/Clipboard';
import { promptAction, router } from '@kit.ArkUI';

// 逐字符着色用：字符 + 类别
interface CharToken {
  char: string;
  kind: string; // 'upper' | 'lower' | 'number' | 'symbol'
}

@ComponentV2
export struct GeneratorTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  @Local genMode: GenMode = 'password';
  @Local genLength: number = 20;
  @Local genWordCount: number = 5;
  @Local genPinLength: number = 6;
  @Local genUpper: boolean = true;
  @Local genLower: boolean = true;
  @Local genNumbers: boolean = true;
  @Local genSymbols: boolean = true;
  @Local genAvoidAmbiguous: boolean = false;
  @Local genPronounceable: boolean = false;
  @Local genResult: string = '';
  @Local genStrength: StrengthResult = { score: 0, label: '无', entropy: 0 };

  // 批量生成
  @Local genCount: number = 1;
  @Local genBatch: string[] = [];

  // 复制反馈
  @Local genCopied: boolean = false;
  // 计数器点击直接输入
  @Local genCountEditing: boolean = false;
  @Local genCountDraft: string = '';

  // setTimeout 句柄（非响应式，故不加 @Local）
  private copyTimerId: number = -1;

  aboutToAppear(): void {
    this.regenerate();
  }

  aboutToDisappear(): void {
    if (this.copyTimerId !== -1) {
      clearTimeout(this.copyTimerId);
      this.copyTimerId = -1;
    }
  }

  private currentOptions(): GenOptions {
    return {
      upper: this.genUpper,
      lower: this.genLower,
      numbers: this.genNumbers,
      symbols: this.genSymbols,
      avoidAmbiguous: this.genAvoidAmbiguous,
      pronounceable: this.genPronounceable,
    };
  }

  // 单条生成器 —— 批量与单条共用，保证复杂度 / 长度约束完全一致
  private genOne(): string {
    if (this.genMode === 'password') {
      return generatePassword(this.genLength, this.currentOptions());
    }
    if (this.genMode === 'passphrase') {
      return generatePassphrase(this.genWordCount);
    }
    return generatePin(this.genPinLength);
  }

  private regenerate(): void {
    try {
      if (this.genCount <= 1) {
        const pw = this.genOne();
        this.genResult = pw;
        this.genBatch = [pw];
      } else {
        const list = generateUniqueBatch(this.genCount, (): string => this.genOne());
        this.genBatch = list;
        this.genResult = list.length > 0 ? list[0] : '';
      }
      this.genStrength = calcStrength(this.genResult, this.currentOptions(), this.genMode);
    } catch (_e) {
      this.genResult = '';
      this.genBatch = [];
      this.genStrength = { score: 0, label: '失败', entropy: 0 };
    }
  }

  private async copyResult(): Promise<void> {
    if (this.genCount > 1 && this.genBatch.length === 0) return;
    if (this.genCount <= 1 && this.genResult.length === 0) return;
    const text = this.genCount > 1 ? this.genBatch.join('\n') : this.genResult;
    try {
      await copyText(text);
      promptAction.showToast({ message: '已复制到剪贴板', duration: 1500 });
      this.genCopied = true;
      if (this.copyTimerId !== -1) clearTimeout(this.copyTimerId);
      this.copyTimerId = setTimeout(() => {
        this.genCopied = false;
        this.copyTimerId = -1;
      }, 1500);
    } catch (_e) {
      promptAction.showToast({ message: '复制失败', duration: 1500 });
    }
  }

  // 保存到密码库 —— 跳转 ItemEdit 新建 login，预填生成的密码。
  // 走 FROZEN 路由契约 { id:'new', type:'login', initialPassword }：ItemEdit 头注释与
  // 'new' 哨兵分支（mode 默认 create，id==='new' 不触发 loadExisting）对此为一等输入，
  // 并与扫码交接 { id:'new', type:'totp', initialTotpUri } 保持一致。
  private handleSave(): void {
    try {
      router.pushUrl({
        url: 'pages/ItemEdit',
        params: { id: 'new', type: 'login', initialPassword: this.genResult },
      });
    } catch (_e) {
      promptAction.showToast({ message: '无法打开编辑页', duration: 1500 });
    }
  }

  private commitCount(): void {
    const n = parseInt(this.genCountDraft, 10);
    if (!isNaN(n) && n >= 1) {
      this.genCount = n;
    }
    this.genCountEditing = false;
    this.regenerate();
  }

  private strengthColor(): string {
    const s = this.genStrength.score;
    if (s >= 70) return this.zc.ok;
    if (s >= 40) return this.zc.warn;
    if (s > 0) return this.zc.danger;
    return this.zc.text3;
  }

  /** 强度标签文字色 —— 文字用高对比变体，进度条填充仍用鲜亮原色 */
  private strengthTextColor(): string {
    const s = this.genStrength.score;
    if (s >= 70) return this.zc.okText;
    if (s >= 40) return this.zc.warnText;
    if (s > 0) return this.zc.danger;
    return this.zc.text3;
  }

  // 逐字符分类（私有方法，build() 内通过 @Builder 间接调用）
  private tokenize(): CharToken[] {
    const out: CharToken[] = [];
    const s = this.genResult;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      let kind = 'symbol';
      if (/[A-Z]/.test(ch)) {
        kind = 'upper';
      } else if (/[a-z]/.test(ch)) {
        kind = 'lower';
      } else if (/[0-9]/.test(ch)) {
        kind = 'number';
      }
      out.push({ char: ch, kind });
    }
    return out;
  }

  private charColor(kind: string): string {
    if (kind === 'upper') return this.zc.text;
    if (kind === 'lower') return this.zc.text2;
    if (kind === 'number') return this.zc.info;
    return this.zc.warn; // symbol
  }

  private badgeText(): string {
    return this.genCount > 1 ? `${this.genBatch.length} 条` : `${this.genResult.length} 字符`;
  }

  private copyLabel(): string {
    if (this.genCopied) return '已复制';
    return this.genCount > 1 ? '复制全部' : '复制';
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // Header —— 标题
      Column({ space: 2 }) {
        Text('生成器')
          .fontSize(ZType.titleSize)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.xs,
        bottom: ZSpacing.sm,
      });

      Scroll() {
        Column({ space: ZSpacing.md }) {
          // ── 结果展示卡（角标 + 单条着色 / 批量滚动 + 强度行）──
          Stack({ alignContent: Alignment.TopEnd }) {
            Column() {
              if (this.genCount <= 1) {
                this.colorizedText();

                // 强度行：进度条占满 + 标签 + 熵值，顶部 1px 细线分隔
                Row({ space: ZSpacing.sm }) {
                  Stack({ alignContent: Alignment.Start }) {
                    Row()
                      .width('100%')
                      .height(4)
                      .borderRadius(2)
                      .backgroundColor(this.zc.bgActive);
                    Row()
                      .width(`${this.genStrength.score}%`)
                      .height(4)
                      .borderRadius(2)
                      .backgroundColor(this.strengthColor());
                  }
                  .layoutWeight(1)
                  .height(4);

                  Text(this.genStrength.label)
                    .fontSize(ZType.captionSize)
                    .fontColor(this.strengthTextColor())
                    .constraintSize({ minWidth: 28 })
                    .textAlign(TextAlign.End);

                  Text(`${this.genStrength.entropy}b`)
                    .fontSize(ZType.captionSize)
                    .fontColor(this.zc.text3)
                    .fontFamily('HarmonyOS Sans Condensed')
                    .constraintSize({ minWidth: 32 })
                    .textAlign(TextAlign.End);
                }
                .width('100%')
                .margin({ top: ZSpacing.md })
                .padding({ top: ZSpacing.sm })
                .border({ width: { top: 1 }, color: this.zc.lineSoft })
                .alignItems(VerticalAlign.Center);
              } else {
                // 批量：多行纯文本，限制最大高度并内部滚动
                Scroll() {
                  Text(this.genBatch.join('\n'))
                    .fontSize(ZType.calloutSize)
                    .fontColor(this.zc.text2)
                    .fontFamily('HarmonyOS Sans Condensed')
                    .lineHeight(22)
                    .width('100%')
                    .copyOption(CopyOptions.LocalDevice);
                }
                .scrollBar(BarState.Auto)
                .constraintSize({ maxHeight: 260 })
                .width('100%')
                .align(Alignment.TopStart);
              }
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding({ top: ZSpacing.sm });

            // 右上角字符 / 条数角标
            Text(this.badgeText())
              .fontSize(ZType.captionSize)
              .fontColor(this.zc.text3)
              .fontFamily('HarmonyOS Sans Condensed');
          }
          .width('100%')
          .constraintSize({ minHeight: 110 })
          .padding(ZSpacing.lg)
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.xl);

          // ── 操作按钮行：重新生成（次）/ 复制（主）──
          Row({ space: ZSpacing.sm }) {
            Row({ space: ZSpacing.xs }) {
              Image($r('app.media.ic_refresh'))
                .width(16)
                .height(16)
                .fillColor(this.zc.text);
              Text('重新生成')
                .fontSize(ZType.bodySize)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.zc.text);
            }
            .layoutWeight(1)
            .height(44)
            .justifyContent(FlexAlign.Center)
            .alignItems(VerticalAlign.Center)
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.lg)
            .onClick(() => this.regenerate());

            Row({ space: ZSpacing.xs }) {
              Image($r(this.genCopied ? 'app.media.ic_check' : 'app.media.ic_copy'))
                .width(16)
                .height(16)
                .fillColor(this.zc.accentInk);
              Text(this.copyLabel())
                .fontSize(ZType.bodySize)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.zc.accentInk);
            }
            .layoutWeight(1)
            .height(44)
            .justifyContent(FlexAlign.Center)
            .alignItems(VerticalAlign.Center)
            .backgroundColor(this.zc.accent)
            .borderRadius(ZRadius.lg)
            .onClick(() => this.copyResult());
          }
          .width('100%');

          // ── 模式分段 ──
          Row() {
            this.modeChip('密码', 'password');
            this.modeChip('词组', 'passphrase');
            this.modeChip('PIN', 'pin');
          }
          .width('100%')
          .padding(2)
          .backgroundColor(this.zc.bgActive)
          .borderRadius(ZRadius.lg);

          // ── 生成数量（自绘步进器，无上限，点击数字直接输入）──
          this.CountSection();

          // ── 选项区 ──
          if (this.genMode === 'password') {
            this.PasswordOptions();
          } else if (this.genMode === 'passphrase') {
            this.PassphraseOptions();
          } else {
            this.PinOptions();
          }

          // ── 保存到密码库（仅单条模式）──
          if (this.genCount <= 1) {
            Row({ space: ZSpacing.xs }) {
              Image($r('app.media.ic_download'))
                .width(16)
                .height(16)
                .fillColor(this.zc.text);
              Text('保存到密码库')
                .fontSize(ZType.bodySize)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.zc.text);
            }
            .width('100%')
            .height(44)
            .justifyContent(FlexAlign.Center)
            .alignItems(VerticalAlign.Center)
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.lg)
            .onClick(() => this.handleSave());
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

  // 逐字符着色文本 —— 单条模式展示
  //
  // 不接收 tokens 入参：@Builder 的「按值传参」不会随源数据变化刷新（这正是
  // 「单条密码点重新生成不更新、批量正常」的根因 —— 批量走 build() 内联 Text 直读
  // 状态，故能刷新）。改为无参、在 builder 体内直读 this.genResult（经 tokenize），
  // 让 @ComponentV2 把 genResult 记为该 builder 的依赖，regenerate 后正常刷新。
  @Builder
  colorizedText() {
    Text() {
      ForEach(
        this.tokenize(),
        (tok: CharToken, _i: number) => {
          Span(tok.char).fontColor(this.charColor(tok.kind));
        },
        (tok: CharToken, i: number) => `${i}_${tok.char}`,
      )
    }
    .fontSize(ZType.titleSize)
    .fontFamily('HarmonyOS Sans Condensed')
    .fontWeight(FontWeight.Medium)
    .lineHeight(32)
    .textAlign(TextAlign.Start)
    .width('100%');
  }

  @Builder
  modeChip(label: string, mode: GenMode) {
    Text(label)
      .fontSize(ZType.subheadSize)
      .fontWeight(this.genMode === mode ? FontWeight.Bold : FontWeight.Medium)
      .fontColor(this.genMode === mode ? this.zc.text : this.zc.text2)
      .backgroundColor(this.genMode === mode ? this.zc.bg : '#00000000')
      .borderRadius(ZRadius.md)
      .height(34)
      .layoutWeight(1)
      .textAlign(TextAlign.Center)
      .onClick(() => {
        this.genMode = mode;
        this.regenerate();
      });
  }

  // 生成数量步进器 —— 减 / 数值（可点输入）/ 加，无上限
  @Builder
  CountSection() {
    Column({ space: ZSpacing.sm }) {
      Text('生成数量')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .letterSpacing(0.4)
        .width('100%');

      Row({ space: ZSpacing.md }) {
        Row() {
          Image($r('app.media.ic_minus'))
            .width(18)
            .height(18)
            .fillColor(this.zc.text);
        }
        .width(36)
        .height(36)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .backgroundColor(this.zc.bgActive)
        .borderRadius(ZRadius.md)
        .onClick(() => {
          if (this.genCount > 1) {
            this.genCount -= 1;
            this.regenerate();
          }
        });

        if (this.genCountEditing) {
          TextInput({ text: this.genCountDraft })
            .type(InputType.Number)
            .fontFamily('HarmonyOS Sans Condensed')
            .fontSize(ZType.headlineSize)
            .fontColor(this.zc.text)
            .textAlign(TextAlign.Center)
            .backgroundColor(this.zc.bgActive)
            .borderRadius(ZRadius.md)
            .width(96)
            .height(36)
            .onChange((v: string) => {
              this.genCountDraft = v;
            })
            .onSubmit(() => this.commitCount())
            .onBlur(() => this.commitCount());
        } else {
          Text(`${this.genCount}`)
            .fontFamily('HarmonyOS Sans Condensed')
            .fontSize(ZType.headlineSize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text)
            .width(96)
            .height(36)
            .textAlign(TextAlign.Center)
            .onClick(() => {
              this.genCountDraft = `${this.genCount}`;
              this.genCountEditing = true;
            });
        }

        Row() {
          Image($r('app.media.ic_plus'))
            .width(18)
            .height(18)
            .fillColor(this.zc.text);
        }
        .width(36)
        .height(36)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .backgroundColor(this.zc.bgActive)
        .borderRadius(ZRadius.md)
        .onClick(() => {
          this.genCount += 1;
          this.regenerate();
        });
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center);

      Text('大于 1 时批量生成，结果互不重复（点击数字可直接输入，无上限）')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3)
        .textAlign(TextAlign.Center)
        .width('100%');
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  PasswordOptions() {
    Column({ space: ZSpacing.sm }) {
      // 长度滑块（8 ~ 64）
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
          min: 8,
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

      // 选项开关 —— 两列网格（每行两张 48% 宽卡片）
      Row({ space: ZSpacing.sm }) {
        this.toggleCard('大写字母', 'A B C D E F', this.genUpper, (v: boolean) => {
          this.genUpper = v;
          this.regenerate();
        });
        this.toggleCard('小写字母', 'a b c d e f', this.genLower, (v: boolean) => {
          this.genLower = v;
          this.regenerate();
        });
      }
      .width('100%')
      .justifyContent(FlexAlign.SpaceBetween);

      Row({ space: ZSpacing.sm }) {
        this.toggleCard('数字', '0 1 2 3 4 5', this.genNumbers, (v: boolean) => {
          this.genNumbers = v;
          this.regenerate();
        });
        this.toggleCard('特殊符号', '! @ # $ % ^', this.genSymbols, (v: boolean) => {
          this.genSymbols = v;
          this.regenerate();
        });
      }
      .width('100%')
      .justifyContent(FlexAlign.SpaceBetween);

      Row({ space: ZSpacing.sm }) {
        this.toggleCard('避免混淆', 'Il1O0', this.genAvoidAmbiguous, (v: boolean) => {
          this.genAvoidAmbiguous = v;
          this.regenerate();
        });
        this.toggleCard('易读模式', 'pronounceable', this.genPronounceable, (v: boolean) => {
          this.genPronounceable = v;
          this.regenerate();
        });
      }
      .width('100%')
      .justifyContent(FlexAlign.SpaceBetween);
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
          min: 2,
          max: 12,
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

        Text('单词以 - 分隔，例如：apple-brave-cloud')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .textAlign(TextAlign.Center)
          .width('100%')
          .margin({ top: ZSpacing.xs });
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
          max: 12,
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

        Text('范围 4 ~ 12 位，仅含数字 0-9')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .textAlign(TextAlign.Center)
          .width('100%')
          .margin({ top: ZSpacing.xs });
      }
      .width('100%')
      .padding(ZSpacing.md)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.lg);
    }
    .width('100%');
  }

  // 两列网格中的单张开关卡 —— 48% 宽
  @Builder
  toggleCard(label: string, sub: string, value: boolean, onChange: (v: boolean) => void) {
    Row() {
      Column({ space: 2 }) {
        Text(label)
          .fontSize(ZType.subheadSize)
          .fontColor(this.zc.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
        Text(sub)
          .fontSize(ZType.captionSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Toggle({ type: ToggleType.Switch, isOn: value })
        .selectedColor(this.zc.text)
        .switchPointColor(this.zc.accentInk)
        .onChange((isOn: boolean) => onChange(isOn));
    }
    .width('48%')
    .constraintSize({ minHeight: 56 })
    .padding({
      left: ZSpacing.md,
      right: ZSpacing.md,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }
}
