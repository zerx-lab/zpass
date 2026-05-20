#!/usr/bin/env python3
"""sync-tokens.py — design tokens 单一真相源同步脚本。

读 `design/src/tokens.css`，生成：
  - `website/src/styles/tokens.css`（直接 copy）
  - `desktop/frontend/src/styles/tokens.css`（直接 copy）
  - `extension/src/styles/tokens.css`（直接 copy）
  - `desktop_rs/zpass-desktop/src/theme/tokens.rs`（解析颜色 / 圆角 / 阴影 / 字体）

CLI:
  python scripts/sync-tokens.py            # 生成 Rust tokens；仅在传 --css 时同步三个 CSS 目标
  python scripts/sync-tokens.py --css      # 同步 Rust + 三个 CSS 目标
  python scripts/sync-tokens.py --check    # 校验当前 Rust tokens 是否与源一致（CI 用）
  python scripts/sync-tokens.py --check --css  # 同时校验 CSS 目标

仅识别本仓库 design tokens 用到的 token 类型：
  - 颜色：`#RRGGBB`、`rgba(r,g,b,a)`
  - 数值（带 px）：圆角等
  - 阴影：保留为字符串，桌面端不直接消费（GPUI 用单独的 elevation）
  - 字体栈：仅取首选项 `"Geist"` / `"Geist Mono"`
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE = REPO_ROOT / "design" / "src" / "tokens.css"
COPY_TARGETS = [
    REPO_ROOT / "website" / "src" / "styles" / "tokens.css",
    REPO_ROOT / "desktop" / "frontend" / "src" / "styles" / "tokens.css",
    REPO_ROOT / "extension" / "src" / "styles" / "tokens.css",
]
RUST_TARGET = REPO_ROOT / "desktop_rs" / "zpass-desktop" / "src" / "theme" / "tokens.rs"


@dataclass
class ThemeBlock:
    name: str  # "root" | "light"
    colors: dict[str, str] = field(default_factory=dict)  # token -> rgba/hex 字符串
    sizes: dict[str, str] = field(default_factory=dict)
    shadows: dict[str, str] = field(default_factory=dict)


_SELECTOR_RE = re.compile(r"(:root|\[data-theme=\"(light)\"\])\s*\{([^}]*)\}", re.S)
_TOKEN_RE = re.compile(r"--([a-zA-Z0-9_-]+):\s*([^;]+);")


def parse_css(text: str) -> dict[str, ThemeBlock]:
    blocks: dict[str, ThemeBlock] = {}
    for match in _SELECTOR_RE.finditer(text):
        selector, _, body = match.groups()
        name = "light" if selector.startswith("[") else "root"
        block = blocks.setdefault(name, ThemeBlock(name=name))
        for tk in _TOKEN_RE.finditer(body):
            key, value = tk.group(1), tk.group(2).strip()
            if key.startswith("radius") or key.startswith("dens"):
                block.sizes[key] = value
            elif key.startswith("shadow"):
                block.shadows[key] = value
            elif key.startswith("font"):
                # 字体栈不进 colors；写入 sizes 但不参与 Rust 生成
                continue
            else:
                block.colors[key] = value
    return blocks


def hex_to_rgba(hex_str: str) -> tuple[int, int, int, float]:
    hex_str = hex_str.lstrip("#")
    if len(hex_str) == 3:
        r, g, b = (int(c * 2, 16) for c in hex_str)
        return r, g, b, 1.0
    if len(hex_str) == 6:
        r, g, b = int(hex_str[0:2], 16), int(hex_str[2:4], 16), int(hex_str[4:6], 16)
        return r, g, b, 1.0
    if len(hex_str) == 8:
        r, g, b, a = (
            int(hex_str[0:2], 16),
            int(hex_str[2:4], 16),
            int(hex_str[4:6], 16),
            int(hex_str[6:8], 16) / 255.0,
        )
        return r, g, b, a
    raise ValueError(f"bad hex: {hex_str}")


def rgba_parse(value: str) -> tuple[int, int, int, float] | None:
    m = re.match(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)", value)
    if not m:
        return None
    r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
    a = float(m.group(4)) if m.group(4) else 1.0
    return r, g, b, a


def to_rgba(value: str) -> tuple[int, int, int, float]:
    if value.startswith("#"):
        return hex_to_rgba(value)
    rgba = rgba_parse(value)
    if rgba:
        return rgba
    raise ValueError(f"无法解析颜色：{value!r}")


def rust_ident(token: str) -> str:
    return token.replace("-", "_").upper()


def emit_rust(blocks: dict[str, ThemeBlock]) -> str:
    """生成 tokens.rs。结构：两个模块 `dark` / `light`，对应 :root / [data-theme=light]。"""
    lines: list[str] = []
    lines.append("//! 由 scripts/sync-tokens.py 自动生成，请勿手改。")
    lines.append("//! 源：design/src/tokens.css")
    lines.append("//!")
    lines.append("//! `dark` 对应 CSS `:root`（默认主题）；`light` 对应 `[data-theme=\"light\"]`。")
    lines.append("//!")
    lines.append("//! 颜色统一用 `Rgba { r, g, b, a }` 表示。GPUI 端调用时用")
    lines.append("//! [`Rgba::to_gpui()`] 转 `gpui::Hsla`，避免在生成代码中依赖 gpui crate。")
    lines.append("")
    lines.append("#![allow(dead_code)]")
    lines.append("")
    lines.append("#[derive(Debug, Clone, Copy, PartialEq)]")
    lines.append("pub struct Rgba {")
    lines.append("    pub r: u8,")
    lines.append("    pub g: u8,")
    lines.append("    pub b: u8,")
    lines.append("    pub a: f32,")
    lines.append("}")
    lines.append("")
    lines.append("impl Rgba {")
    lines.append("    pub const fn new(r: u8, g: u8, b: u8, a: f32) -> Self {")
    lines.append("        Self { r, g, b, a }")
    lines.append("    }")
    lines.append("    /// 转 `gpui::Rgba`（0..=1 浮点）。")
    lines.append("    pub fn to_gpui(self) -> gpui::Rgba {")
    lines.append("        gpui::Rgba {")
    lines.append("            r: self.r as f32 / 255.0,")
    lines.append("            g: self.g as f32 / 255.0,")
    lines.append("            b: self.b as f32 / 255.0,")
    lines.append("            a: self.a,")
    lines.append("        }")
    lines.append("    }")
    lines.append("    pub fn to_hsla(self) -> gpui::Hsla {")
    lines.append("        self.to_gpui().into()")
    lines.append("    }")
    lines.append("}")
    lines.append("")

    root = blocks["root"]
    light = blocks.get("light")

    def emit_theme(mod_name: str, block: ThemeBlock, fallback: ThemeBlock | None) -> None:
        lines.append(f"pub mod {mod_name} {{")
        lines.append("    use super::Rgba;")
        lines.append("")
        colors = dict(block.colors)
        if fallback:
            for k, v in fallback.colors.items():
                colors.setdefault(k, v)
        for key in sorted(colors):
            value = colors[key]
            try:
                r, g, b, a = to_rgba(value)
            except ValueError:
                lines.append(f"    // 跳过 --{key}（无法解析颜色）：{value}")
                continue
            lines.append(
                f"    pub const {rust_ident(key)}: Rgba = Rgba::new({r}, {g}, {b}, {a:.4});"
            )
        lines.append("}")
        lines.append("")

    emit_theme("dark", root, None)
    if light is not None:
        emit_theme("light", light, root)

    # sizes: 取 root 的 radius_* / dens_* 作为常量
    lines.append("pub mod sizes {")
    sizes = dict(root.sizes)
    for key in sorted(sizes):
        value = sizes[key].strip()
        m = re.match(r"(\d+(?:\.\d+)?)px", value)
        if m:
            num = m.group(1)
            if "." not in num:
                num = f"{num}.0"
            lines.append(f"    pub const {rust_ident(key)}_PX: f32 = {num};")
    lines.append("}")
    lines.append("")

    lines.append("/// 字体族常量（仅 Geist + Geist Mono，spec/00 § D5）。")
    lines.append("pub mod fonts {")
    lines.append("    pub const SANS: &str = \"Geist\";")
    lines.append("    pub const MONO: &str = \"Geist Mono\";")
    lines.append("}")
    lines.append("")

    return "\n".join(lines)


def write_if_different(path: Path, content: str, check: bool) -> bool:
    """返回 True 表示需要变更（check 模式下用作退出码）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text() if path.exists() else None
    if existing == content:
        return False
    if check:
        return True
    path.write_text(content)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="只校验目标文件与源是否一致；不一致以退出码 1 失败（CI 用）。",
    )
    parser.add_argument(
        "--css",
        action="store_true",
        help="同时同步 website / desktop / extension 三个 tokens.css 目标。"
        "默认只更新 Rust，避免 Phase B 误改其它项目文件。",
    )
    args = parser.parse_args(argv)

    if not SOURCE.exists():
        print(f"源文件不存在：{SOURCE}", file=sys.stderr)
        return 2

    text = SOURCE.read_text()
    blocks = parse_css(text)

    any_change = False

    if args.css:
        for target in COPY_TARGETS:
            changed = write_if_different(target, text, args.check)
            if changed:
                any_change = True
                print(
                    f"{'WOULD UPDATE' if args.check else 'UPDATED'}: "
                    f"{target.relative_to(REPO_ROOT)}"
                )

    rust = emit_rust(blocks)
    changed = write_if_different(RUST_TARGET, rust, args.check)
    if changed:
        any_change = True
        print(f"{'WOULD UPDATE' if args.check else 'UPDATED'}: {RUST_TARGET.relative_to(REPO_ROOT)}")

    if args.check and any_change:
        print("tokens 不同步，请运行：python scripts/sync-tokens.py", file=sys.stderr)
        return 1
    if not any_change:
        print("tokens 已同步。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
