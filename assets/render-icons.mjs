// One-off renderer: assets/icon-src.svg -> solid-background PNG app icons.
// Run from extension/ (where sharp is installed):
//   node ../assets/render-icons.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
// sharp 装在 extension/ 下，从那里解析依赖
const require = createRequire(join(here, "..", "extension", "package.json"));
const sharp = require("sharp");
const svg = await readFile(join(here, "icon-src.svg"));

for (const size of [216, 1024]) {
  const out = join(here, `icon-${size}.png`);
  await sharp(svg, { density: (72 * size) / 100 })
    .resize(size, size)
    .flatten({ background: "#0A2540" }) // 保险：消除任何透明像素
    .png()
    .toFile(out);
  console.log("wrote", out);
}
