// ZPass 视觉系统通用 SVG 图标集
//
// 所有 icon 通过 currentColor 着色，由 CSS color 控制颜色。
// 尺寸通过 width/height 属性传入，viewBox 固定以保持锐利度。
// 返回值为 SVG 字符串（用于 element.innerHTML），不引入 DOM 依赖。

/**
 * 5×5 简化点阵 Z —— ZPass 品牌核心图形（与 desktop 7×7 完整版同源）
 *
 * 设计理念："OTP FEEL" —— 用一次性密码刻度的颗粒感呈现品牌字母。
 *
 * 网格：cell=5, r=2, pad=2.5
 *   cx(col) = 2.5 + col*5  →  2.5, 7.5, 12.5, 17.5, 22.5
 *   cy(row) = 2.5 + row*5
 *
 * Z 字主体：
 *   行 0：全亮（cols 0-4）
 *   行 1：col 3
 *   行 2：col 2
 *   行 3：col 1
 *   行 4：全亮（cols 0-4）
 *
 * 在 28px 以下小尺寸场景下比 7×7 完整版识别度更高（每点 ~3-4px）。
 */
export function zMatrixIcon(options: { size?: number; muted?: boolean } = {}): string {
  const size = options.size ?? 16;
  const opacity = options.muted ? "0.18" : "1";
  return `<svg width="${size}" height="${size}" viewBox="0 0 25 25" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g fill="currentColor" fill-opacity="${opacity}">
      <circle cx="2.5" cy="2.5" r="2"/><circle cx="7.5" cy="2.5" r="2"/><circle cx="12.5" cy="2.5" r="2"/><circle cx="17.5" cy="2.5" r="2"/><circle cx="22.5" cy="2.5" r="2"/>
      <circle cx="17.5" cy="7.5" r="2"/>
      <circle cx="12.5" cy="12.5" r="2"/>
      <circle cx="7.5" cy="17.5" r="2"/>
      <circle cx="2.5" cy="22.5" r="2"/><circle cx="7.5" cy="22.5" r="2"/><circle cx="12.5" cy="22.5" r="2"/><circle cx="17.5" cy="22.5" r="2"/><circle cx="22.5" cy="22.5" r="2"/>
    </g>
  </svg>`;
}

// lucide.dev 风格描边图标，统一 stroke-width 1.75
function strokeIcon(size: number, path: string): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export function lockIcon(size = 16): string {
  return strokeIcon(size, `<rect width="14" height="10" x="5" y="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`);
}

export function refreshIcon(size = 16): string {
  return strokeIcon(
    size,
    `<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>`
  );
}

export function copyIcon(size = 14): string {
  return strokeIcon(size, `<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16V4a2 2 0 0 1 2-2h12"/>`);
}

export function checkIcon(size = 14): string {
  return strokeIcon(size, `<path d="M20 6 9 17l-5-5"/>`);
}

export function searchIcon(size = 14): string {
  return strokeIcon(size, `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`);
}

export function keyIcon(size = 16): string {
  return strokeIcon(
    size,
    `<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>`
  );
}

export function alertIcon(size = 18): string {
  return strokeIcon(size, `<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>`);
}

export function powerIcon(size = 18): string {
  return strokeIcon(size, `<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>`);
}

export function shieldIcon(size = 18): string {
  return strokeIcon(size, `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`);
}
