// 纯 JS 二维码渲染（无原生依赖）
//
// 用 qrcode-generator 算出 module 矩阵，再把每行的连续黑块合并成若干 <View> 渲染，
// 避免 N×N 个 View。二维码须高对比（黑底白块），故固定 #000/#fff，不随主题变色，
// 外层留白（quiet zone）保证可扫描。

import { useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import qrcodeGen from "qrcode-generator";

export interface QRCodeProps {
  /** 编码内容（如 zpass-sync://host:port?pin=123456） */
  value: string;
  /** 矩阵区域边长（px），不含留白 */
  size?: number;
  /** 留白宽度（px），默认 12 */
  quietZone?: number;
  style?: StyleProp<ViewStyle>;
}

interface Run {
  col: number;
  len: number;
}

export function QRCode({ value, size = 200, quietZone = 12, style }: QRCodeProps) {
  const matrix = useMemo(() => {
    if (!value) return null;
    try {
      const qr = qrcodeGen(0, "M"); // 0 = 自动版本，M = 中等纠错
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      const rows: Run[][] = [];
      for (let r = 0; r < count; r++) {
        const runs: Run[] = [];
        let start = -1;
        for (let col = 0; col < count; col++) {
          if (qr.isDark(r, col)) {
            if (start < 0) start = col;
          } else if (start >= 0) {
            runs.push({ col: start, len: col - start });
            start = -1;
          }
        }
        if (start >= 0) runs.push({ col: start, len: count - start });
        rows.push(runs);
      }
      return { count, rows };
    } catch {
      return null;
    }
  }, [value]);

  if (!matrix) return null;
  const cell = size / matrix.count;

  return (
    <View
      style={[
        {
          width: size + quietZone * 2,
          height: size + quietZone * 2,
          padding: quietZone,
          backgroundColor: "#ffffff",
        },
        style,
      ]}
    >
      <View style={{ width: size, height: size }}>
        {matrix.rows.map((runs, r) => (
          <View
            key={r}
            style={{
              position: "absolute",
              top: r * cell,
              left: 0,
              height: cell,
              width: size,
            }}
          >
            {runs.map((run, i) => (
              <View
                key={i}
                style={{
                  position: "absolute",
                  left: run.col * cell,
                  width: run.len * cell,
                  height: cell,
                  backgroundColor: "#000000",
                }}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}
