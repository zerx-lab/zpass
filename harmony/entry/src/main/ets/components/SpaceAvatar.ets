// SpaceAvatar —— 空间头像统一渲染组件
//
// 与 phone/components/space-avatar.tsx 行为对齐：把"头像方块"集中在一个地方，
// Vault 顶栏 / Me 个人卡 / Lock 解锁页 / Onboarding 第二步等位置都用同一份
// 回退规则，避免散落在四处的硬编码 "Z"。
//
// 渲染策略：
//   - 鸿蒙端不支持自定义图片头像（与 desktop 一致，暂不实现），仅渲染
//     基于空间名首字符派生的文字方块。
//   - 默认黑底白字 / 白底黑字由调用方按 zc.text / zc.bg 显式传入。
//   - 字号 / 圆角 / 尺寸由调用方控制；不传时按 size 比例自动派生。
//
// 注意：name 可能为空（首次进入未创建任何空间，或锁定态尚未读到 plaintext
// spaces），此时退化为 fallback（默认 "Z"）。
//
// 字段命名说明：ArkTS struct 中 size / background / fontSize / borderRadius
// 与 Component 同名属性方法冲突，因此 props 全部加 avatar 前缀。

import { deriveGlyph } from '../lib/Spaces';

@ComponentV2
export struct SpaceAvatar {
  /** 空间名（仅取首字符派生）；为空时退化到 fallback */
  @Param avatarName: string | undefined = undefined;
  /** 方块尺寸（宽 = 高） */
  @Param avatarSize: number = 40;
  /** 方块底色（通常传 zc.text / zc.accent / zc.bgElev） */
  @Param avatarBg: string = '#000000';
  /** 文字颜色（通常传 zc.bg / zc.accentInk / zc.text） */
  @Param avatarFg: string = '#ffffff';
  /** 字号；未传（0）时按 size * 0.5 派生 */
  @Param avatarFontSize: number = 0;
  /** 圆角；未传（0）时按 size * 0.23 派生，与 phone 视觉一致 */
  @Param avatarRadius: number = 0;
  /** name 为空时的兜底字符（默认 "Z"） */
  @Param fallback: string = 'Z';

  build() {
    Column() {
      Text(this.derivedChar())
        .fontWeight(FontWeight.Bold)
        .fontSize(this.resolvedFontSize())
        .fontColor(this.avatarFg)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
    }
    .width(this.avatarSize)
    .height(this.avatarSize)
    .borderRadius(this.resolvedRadius())
    .backgroundColor(this.avatarBg)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center);
  }

  private derivedChar(): string {
    const trimmed = (this.avatarName ?? '').trim();
    if (!trimmed) return this.fallback;
    return deriveGlyph(trimmed);
  }

  private resolvedFontSize(): number {
    return this.avatarFontSize > 0
      ? this.avatarFontSize
      : Math.round(this.avatarSize * 0.5);
  }

  private resolvedRadius(): number {
    return this.avatarRadius > 0
      ? this.avatarRadius
      : Math.round(this.avatarSize * 0.23);
  }
}
