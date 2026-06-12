// MeAppearance —— 「我的 → 外观与交互」分组设置页
//
// 分组：
//   - 外观：主题（选择浮层）/ 语言（当前仅中文，纯展示）/ 安全页展示开关
//   - 交互：智感握姿
//
// 主题选择浮层随业务逻辑一起从 MeTab 迁入。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { themeStore, type ThemeMode } from '../state/ThemeStore';
import { motionStore, MotionStore } from '../state/MotionStore';
import { uiStore, UiStore } from '../state/UiStore';
import { router } from '@kit.ArkUI';
import {
  SettingsRowNav,
  SettingsRowToggle,
  SettingsSectionHeader,
} from '../components/SettingsRows';

@Entry
@ComponentV2
struct MeAppearance {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local ms: MotionStore = motionStore;
  @Local ui: UiStore = uiStore;

  /** 主题选择浮层 */
  @Local showThemePicker: boolean = false;

  @Computed
  get themeLabel(): string {
    if (themeStore.mode === 'system') {
      return `跟随系统 · ${themeStore.effective === 'dark' ? '深色' : '浅色'}`;
    }
    return themeStore.mode === 'dark' ? '深色' : '浅色';
  }

  private onPickTheme(mode: ThemeMode): void {
    themeStore.setMode(mode);
    this.showThemePicker = false;
  }

  build() {
    Stack() {
      Column() {
        Row().height(this.safeArea.top).width('100%');

        // 顶栏
        Row() {
          Column() {
            Image($r('app.media.ic_chevron_left'))
              .width(20)
              .height(20)
              .fillColor(this.zc.text2);
          }
          .width(36)
          .height(36)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => router.back());

          Text('外观与交互')
            .fontSize(ZType.titleSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text)
            .layoutWeight(1)
            .margin({ left: ZSpacing.xs });

          Row().width(36).height(36);
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: ZSpacing.xs, bottom: ZSpacing.sm });

        Scroll() {
          Column({ space: ZSpacing.sm }) {
            SettingsSectionHeader({ label: '外观' });
            Column() {
              SettingsRowNav({
                label: '主题',
                value: this.themeLabel,
                icon: $r('app.media.ic_settings'),
                onTap: () => {
                  this.showThemePicker = true;
                },
              });
              this.divider();
              SettingsRowNav({
                label: '语言',
                value: '中文',
                icon: $r('app.media.ic_globe'),
                navigable: false,
              });
              this.divider();
              SettingsRowToggle({
                title: '安全页',
                subtitle: '在底部标签栏展示安全评分与泄露检测',
                icon: $r('app.media.ic_tab_security'),
                isOn: this.ui.securityTabEnabled,
                onToggle: () => this.ui.setSecurityTabEnabled(!this.ui.securityTabEnabled),
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            SettingsSectionHeader({ label: '交互' });
            Column() {
              SettingsRowToggle({
                title: '智感握姿',
                subtitle: '自动识别握持手，首页添加按钮随手移位',
                icon: $r('app.media.ic_settings'),
                isOn: this.ms.gripEnabled,
                onToggle: () => motionStore.setGripEnabled(!motionStore.gripEnabled),
              });
            }
            .width('100%')
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);

            Row().height(ZSpacing.xl + this.safeArea.bottom).width('100%');
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

      if (this.showThemePicker) {
        this.themePickerOverlay();
      }
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Center)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);
  }

  @Builder
  divider() {
    Divider().strokeWidth(0.5).color(this.zc.line).margin({ left: ZSpacing.lg, right: ZSpacing.lg });
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
    .backgroundColor(this.zc.overlay)
    .onClick(() => {
      this.showThemePicker = false;
    });
  }

  @Builder
  themeOption(label: string, value: ThemeMode) {
    Row() {
      Text(label)
        .fontSize(ZType.bodySize)
        .fontColor(themeStore.mode === value ? this.zc.accentInk : this.zc.text)
        .layoutWeight(1);
      if (themeStore.mode === value) {
        Image($r('app.media.ic_check'))
          .width(14)
          .height(14)
          .fillColor(this.zc.accentInk);
      }
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md })
    .backgroundColor(themeStore.mode === value ? this.zc.accent : this.zc.bg)
    .borderRadius(ZRadius.lg)
    .onClick(() => this.onPickTheme(value));
  }
}
