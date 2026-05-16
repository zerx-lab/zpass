// 把 7×7 点阵 Z 字 SVG 栅格化为多尺寸 PNG，供浏览器扩展 manifest.icons 使用。
//
// 用法：
//   cd ZPass/extension
//   node scripts/generate-icons.mjs
//
// 依赖：sharp（首次运行需 `npm i -D sharp`）。
// 输出：public/icon/{16,32,48,96,128}.png
//
// 设计意图：
//   纯 Node 手写 PNG 编码器虽然可行，但抗锯齿圆点会很复杂且不易维护。
//   sharp 是 Node 生态 SVG→PNG 的事实标准（pixel-perfect、libvips 渲染）。
//   只在生成 PNG 时使用，不进入运行时产物，不增加扩展包体积。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const srcSvg = join(root, "public", "icon", "icon.svg");
const outDir = join(root, "public", "icon");

const sizes = [16, 32, 48, 96, 128];

let sharp;
try {
  ({ default: sharp } = await import("sharp"));
} catch (err) {
  console.error("[generate-icons] 需要 sharp 依赖：cd ZPass/extension && npm i -D sharp");
  process.exit(1);
}

const svgBuffer = readFileSync(srcSvg);

mkdirSync(outDir, { recursive: true });

for (const size of sizes) {
  const outFile = join(outDir, `${size}.png`);
  // density 设高保证小尺寸下圆点边缘平滑；resize 用 nearest 关闭额外插值会失去抗锯齿，
  // 这里让 libvips 默认（lanczos3）处理，14×14 viewBox 放大到 128 仍清晰。
  const buf = await sharp(svgBuffer, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(outFile, buf);
  console.log(`[generate-icons] wrote ${outFile} (${buf.length} bytes)`);
}

console.log("[generate-icons] done.");
