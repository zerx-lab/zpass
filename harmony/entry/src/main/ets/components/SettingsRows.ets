// SettingsRows —— 「我的」设置体系通用行组件
//
// 主页（MeTab）与分组子页（MeProtection / MeAppearance / MeData）共用，
// 取代原先 MeTab 里成套的 rowAction / rowValue / rowToggle / rowDanger
// @Builder，避免拆页后跨文件复制粘贴。
//
//   - SettingsSectionHeader 分组小标题
//   - SettingsRowNav        左图标 + 标签 (+ 右值) + 右箭头，点击进入下一级
//   - SettingsRowToggle     左图标 + 标题/副标题 (+ 状态文字) + 自绘开关
//   - SettingsRowDanger     危险操作行：tint 图标底 + danger 色标签
//   - SettingsErrorBox      表单错误提示框
//
// 主题色全部走 ZColors 单例（@Trace 字段），切主题自动重渲。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';

@ComponentV2
export struct SettingsSectionHeader {
  @Local zc: ZColorsClass = ZColors;
  @Require @Param label: string;

  build() {
    Text(this.label)
      .fontSize(ZType.footnoteSize)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.zc.text3)
      .padding({ left: ZSpacing.sm, top: ZSpacing.sm, bottom: 6 });
  }
}

@ComponentV2
export struct SettingsRowNav {
  @Local zc: ZColorsClass = ZColors;
  @Require @Param label: string;
  /** 右侧值文字（可空） */
  @Param value: string = '';
  @Require @Param icon: Resource;
  /** false 时不渲染右箭头（纯展示行，如版本号） */
  @Param navigable: boolean = true;
  @Event onTap: () => void = () => {};

  build() {
    Row({ space: ZSpacing.md }) {
      Row() {
        Image(this.icon)
          .width(18)
          .height(18)
          .fillColor(this.zc.text);
      }
      .width(32)
      .height(32)
      .borderRadius(ZRadius.md)
      .backgroundColor(this.zc.bgElev)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center);

      Text(this.label)
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.text)
        .layoutWeight(1);
      if (this.value) {
        Text(this.value)
          .fontSize(ZType.subheadSize)
          .fontColor(this.zc.text3)
          .margin({ right: this.navigable ? ZSpacing.xs : 0 });
      }
      if (this.navigable) {
        Image($r('app.media.ic_chevron_right'))
          .width(16)
          .height(16)
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
    .onClick(() => this.onTap());
  }
}

@ComponentV2
export struct SettingsRowToggle {
  @Local zc: ZColorsClass = ZColors;
  @Require @Param title: string;
  @Param subtitle: string = '';
  /** 开关左侧的状态文字（如「已启用」），可空 */
  @Param value: string = '';
  @Require @Param icon: Resource;
  @Require @Param isOn: boolean;
  /** 置灰整行（如设备不支持）；点击仍回调，由父层决定提示或忽略 */
  @Param dimmed: boolean = false;
  @Event onToggle: () => void = () => {};

  build() {
    Row({ space: ZSpacing.md }) {
      Row() {
        Image(this.icon)
          .width(18)
          .height(18)
          .fillColor(this.zc.text);
      }
      .width(32)
      .height(32)
      .borderRadius(ZRadius.md)
      .backgroundColor(this.zc.bgElev)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center);

      Column({ space: 2 }) {
        Text(this.title)
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text);
        if (this.subtitle) {
          Text(this.subtitle)
            .fontSize(ZType.captionSize)
            .fontColor(this.zc.text3)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis });
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      if (this.value) {
        Text(this.value)
          .fontSize(ZType.subheadSize)
          .fontColor(this.zc.text3)
          .margin({ right: ZSpacing.xs });
      }

      Stack({ alignContent: Alignment.Start }) {
        Row()
          .width(50)
          .height(30)
          .backgroundColor(this.isOn ? this.zc.accent : this.zc.text3)
          .borderRadius(15);
        Row()
          .width(26)
          .height(26)
          .backgroundColor('#FFFFFF')
          .borderRadius(13)
          .margin({ left: this.isOn ? 22 : 2 });
      }
      .width(50)
      .height(30);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .opacity(this.dimmed ? 0.4 : 1)
    .onClick(() => this.onToggle());
  }
}

@ComponentV2
export struct SettingsRowDanger {
  @Local zc: ZColorsClass = ZColors;
  @Require @Param label: string;
  @Require @Param icon: Resource;
  /** 图标色（danger / warn）；标签恒 danger 色，对齐原 rowDanger / rowDangerWarn */
  @Require @Param iconColor: string;
  @Event onTap: () => void = () => {};

  build() {
    Row({ space: ZSpacing.md }) {
      Row() {
        Image(this.icon)
          .width(18)
          .height(18)
          .fillColor(this.iconColor);
      }
      .width(32)
      .height(32)
      .borderRadius(ZRadius.md)
      .backgroundColor(alpha1f(this.iconColor))
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center);

      Text(this.label)
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.danger)
        .layoutWeight(1);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .onClick(() => this.onTap());
  }
}

@ComponentV2
export struct SettingsErrorBox {
  @Local zc: ZColorsClass = ZColors;
  @Require @Param message: string;

  build() {
    Row({ space: ZSpacing.xs }) {
      Image($r('app.media.ic_error'))
        .width(14)
        .height(14)
        .fillColor(this.zc.danger);
      Text(this.message)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.danger)
        .layoutWeight(1);
    }
    .width('100%')
    .padding({ left: ZSpacing.md, right: ZSpacing.md, top: ZSpacing.sm, bottom: ZSpacing.sm })
    .backgroundColor(alpha1f(this.zc.danger))
    .borderRadius(ZRadius.md);
  }
}
