/*
 * render-appicon.mjs —— 渲染 ZPass 桌面端应用图标 PNG
 * ---------------------------------------------------------------------------
 * 目的：与 `appicon.icon/Assets/wails_icon_vector.svg` 视觉同源，
 *      直接生成 `appicon.png` —— wails3 generate icons 流程中
 *      Windows `.ico` 与 Linux 图标的输入位图。
 *
 * 设计：1024×1024，透明背景，7×7 圆点矩阵构成字母 "Z"
 *      （顶部 2 行 + 中间对角 3 行 + 底部 2 行 = "Z"，中间另 15 点
 *       以低透明度作 OTP 颗粒底纹）。
 *
 * 实现：纯 Node 内建模块（zlib + crypto + buffer），无 npm 依赖。
 *      直接写 PNG 二进制（IHDR / IDAT / IEND）。
 *
 * 用法：node build/render-appicon.mjs
 */

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ============ 1. 画布与几何参数 ============
const SIZE = 1024; // 输出 PNG 尺寸（正方形）
// SVG 的 viewBox 是 583×533，把它居中映射到 1024×1024 画布
// scale = min(1024/583, 1024/533) = 1024/583 ≈ 1.756（按宽度铺满）
// 实际上让 Z 留出 padding，scale 取稍小值
const SVG_W = 583;
const SVG_H = 533;
const scale = Math.min(SIZE / SVG_W, SIZE / SVG_H) * 0.94; // 留 6% 边距
const offX = (SIZE - SVG_W * scale) / 2;
const offY = (SIZE - SVG_H * scale) / 2;

// SVG 中的圆点坐标系（与 wails_icon_vector.svg 完全对应）
const cx = (col) => 81.5 + col * 70;
const cy = (row) => 56.5 + row * 70;
const R = 30;

/** 圆点定义：{col, row, alpha} —— alpha 0..1 */
const dots = [];

// 中间 3 行的"OTP 颗粒"底纹（浅灰，alpha 0.18）
const dim = (col, row) => dots.push({ col, row, a: 0.18 });
[0, 1, 2, 3, 6].forEach((c) => dim(c, 2));
[0, 1, 2, 5, 6].forEach((c) => dim(c, 3));
[0, 1, 4, 5, 6].forEach((c) => dim(c, 4));

// Z 字主体（实心黑，alpha 1.0）
const solid = (col, row) => dots.push({ col, row, a: 1.0 });
// 行 0 / 1：上横
for (let c = 0; c <= 6; c++) {
	solid(c, 0);
	solid(c, 1);
}
// 行 2：对角线右侧 cols 4,5
solid(4, 2);
solid(5, 2);
// 行 3：对角线中间 cols 3,4
solid(3, 3);
solid(4, 3);
// 行 4：对角线左侧 cols 2,3
solid(2, 4);
solid(3, 4);
// 行 5 / 6：下横
for (let c = 0; c <= 6; c++) {
	solid(c, 5);
	solid(c, 6);
}

// ============ 2. 光栅化（RGBA buffer） ============
// 透明背景，前景纯黑 (0,0,0)，alpha 由 dot 的 a 与 antialiasing 联合决定。
const rgba = Buffer.alloc(SIZE * SIZE * 4); // 默认 0 全透明

// 把 SVG 坐标转画布像素
const px = (svgX) => offX + svgX * scale;
const py = (svgY) => offY + svgY * scale;
const pr = R * scale;

// 对每个像素与每个 dot 做距离测试，AA 用 1px 软边缘
for (const dot of dots) {
	const dotPxX = px(cx(dot.col));
	const dotPxY = py(cy(dot.row));
	const radius = pr;
	const aa = 1.0; // 1 像素抗锯齿带

	// 仅遍历包围盒
	const minX = Math.max(0, Math.floor(dotPxX - radius - aa));
	const maxX = Math.min(SIZE - 1, Math.ceil(dotPxX + radius + aa));
	const minY = Math.max(0, Math.floor(dotPxY - radius - aa));
	const maxY = Math.min(SIZE - 1, Math.ceil(dotPxY + radius + aa));

	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			const dx = x + 0.5 - dotPxX;
			const dy = y + 0.5 - dotPxY;
			const dist = Math.sqrt(dx * dx + dy * dy);
			// 软边：dist <= R-aa 全实心；R-aa < dist < R+aa 线性衰减；>= R+aa 透明
			let coverage;
			if (dist <= radius - aa) coverage = 1;
			else if (dist >= radius + aa) coverage = 0;
			else coverage = (radius + aa - dist) / (2 * aa);

			const newA = coverage * dot.a;
			if (newA <= 0) continue;

			// alpha-over 合成（dst 在下，src 是当前 dot；前景全 0 黑）
			const idx = (y * SIZE + x) * 4;
			const dstA = rgba[idx + 3] / 255;
			const outA = newA + dstA * (1 - newA);
			if (outA <= 0) continue;
			// 前景 RGB 全 0，简化为 dst.rgb * (1-newA) * dstA / outA
			const k = (dstA * (1 - newA)) / outA;
			rgba[idx] = Math.round(rgba[idx] * k);
			rgba[idx + 1] = Math.round(rgba[idx + 1] * k);
			rgba[idx + 2] = Math.round(rgba[idx + 2] * k);
			rgba[idx + 3] = Math.round(outA * 255);
		}
	}
}

// ============ 3. 编码 PNG ============
/** CRC32（PNG 用 IEEE 802.3 多项式） */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crc]);
}

// PNG 签名
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.writeUInt8(8, 8); // bit depth
ihdr.writeUInt8(6, 9); // color type RGBA
ihdr.writeUInt8(0, 10); // compression
ihdr.writeUInt8(0, 11); // filter
ihdr.writeUInt8(0, 12); // interlace

// IDAT —— 每行加 filter byte (0=None)，再整体 zlib 压缩
const rowSize = SIZE * 4 + 1;
const raw = Buffer.alloc(rowSize * SIZE);
for (let y = 0; y < SIZE; y++) {
	raw[y * rowSize] = 0;
	rgba.copy(raw, y * rowSize + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([
	SIG,
	chunk("IHDR", ihdr),
	chunk("IDAT", idat),
	chunk("IEND", Buffer.alloc(0)),
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "appicon.png");
writeFileSync(outPath, png);
console.log(`Wrote ${outPath}  (${SIZE}×${SIZE}, ${png.length} bytes)`);
