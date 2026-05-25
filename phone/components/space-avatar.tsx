// SpaceAvatar —— 空间头像统一渲染组件
//
// 与 desktop 的同名组件思路一致：把"头像方块"这件事收在一个地方，
// 任何位置（vault 顶栏 logo / me 个人卡 / 锁屏页 logo / onboarding 第二步）
// 都用同一份回退规则，避免散落在四处的"硬编码 Z"。
//
// 渲染策略：
//   - 当前 phone 端不支持自定义图片头像（与 desktop 简化差异），仅渲染
//     基于空间名首字符派生的文字方块。未来若引入 image picker，把
//     avatarDataUrl 分支补在 if (space.avatarDataUrl) 即可，UI 调用侧
//     不用动。
//
// 风格统一：
//   - 默认黑底白字（dark）/ 白底黑字由调用方按 c.text / c.bg 显式传入
//   - 字号 / 圆角 / 尺寸全部由调用方控制，组件只负责"文字居中"
//
// 注意：space 可能为 null（首次进入未创建任何空间，或锁定态尚未读到
// plaintext spaces），此时退化为 "Z" 占位。

import React from "react";
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";

import { deriveGlyph, type Space } from "@/lib/spaces";

export interface SpaceAvatarProps {
  /** 当前空间（仅取 name）；为空时退化到 fallback 字符 */
  space: Pick<Space, "name"> | null | undefined;
  /** 方块尺寸（宽 = 高）—— 圆角默认 ≈ size * 0.23（与原 hard-coded 比例一致） */
  size: number;
  /** 方块底色（通常传 c.text） */
  background: string;
  /** 文字颜色（通常传 c.bg） */
  foreground: string;
  /** 字号 —— 默认按 size * 0.5 计算 */
  fontSize?: number;
  /** 圆角覆盖 —— 不传则按 size * 0.23 圆角，匹配既有视觉 */
  borderRadius?: number;
  /** 外层 style 透传（用于 margin / 定位） */
  style?: ViewStyle;
  /** 文字额外样式 */
  textStyle?: TextStyle;
  /** name 为空时的兜底字符（默认 "Z"，保持品牌一致性） */
  fallback?: string;
}

export function SpaceAvatar({
  space,
  size,
  background,
  foreground,
  fontSize,
  borderRadius,
  style,
  textStyle,
  fallback = "Z",
}: SpaceAvatarProps) {
  // 优先用空间名首字符；空间不存在或名字空时用 fallback
  const name = space?.name?.trim() ?? "";
  const char = name ? deriveGlyph(name) : fallback;

  const resolvedRadius =
    typeof borderRadius === "number" ? borderRadius : Math.round(size * 0.23);
  const resolvedFontSize =
    typeof fontSize === "number" ? fontSize : Math.round(size * 0.5);

  return (
    <View
      style={[
        styles.box,
        {
          width: size,
          height: size,
          borderRadius: resolvedRadius,
          backgroundColor: background,
        },
        style,
      ]}
    >
      <Text
        // 单字符不需要 numberOfLines，但加上能防御 emoji 多字符变种
        numberOfLines={1}
        style={[
          styles.text,
          {
            color: foreground,
            fontSize: resolvedFontSize,
            // lineHeight 略大于 fontSize，让中文字符垂直居中不偏上
            lineHeight: Math.round(resolvedFontSize * 1.15),
          },
          textStyle,
        ]}
      >
        {char}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    fontWeight: "700",
    includeFontPadding: false,
  },
});

export default SpaceAvatar;
