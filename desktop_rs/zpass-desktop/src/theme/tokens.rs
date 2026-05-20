//! 由 scripts/sync-tokens.py 自动生成，请勿手改。
//! 源：design/src/tokens.css
//!
//! `dark` 对应 CSS `:root`（默认主题）；`light` 对应 `[data-theme="light"]`。
//!
//! 颜色统一用 `Rgba { r, g, b, a }` 表示。GPUI 端调用时用
//! [`Rgba::to_gpui()`] 转 `gpui::Hsla`，避免在生成代码中依赖 gpui crate。

#![allow(dead_code)]

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f32,
}

impl Rgba {
    pub const fn new(r: u8, g: u8, b: u8, a: f32) -> Self {
        Self { r, g, b, a }
    }
    /// 转 `gpui::Rgba`（0..=1 浮点）。
    pub fn to_gpui(self) -> gpui::Rgba {
        gpui::Rgba {
            r: self.r as f32 / 255.0,
            g: self.g as f32 / 255.0,
            b: self.b as f32 / 255.0,
            a: self.a,
        }
    }
    pub fn to_hsla(self) -> gpui::Hsla {
        self.to_gpui().into()
    }
}

pub mod dark {
    use super::Rgba;

    pub const ACCENT: Rgba = Rgba::new(236, 236, 236, 1.0);
    pub const ACCENT_GLOW: Rgba = Rgba::new(255, 255, 255, 0.04);
    pub const ACCENT_INK: Rgba = Rgba::new(12, 12, 13, 1.0);
    pub const BG: Rgba = Rgba::new(12, 12, 13, 1.0);
    pub const BG_ACTIVE: Rgba = Rgba::new(29, 29, 34, 1.0);
    pub const BG_ELEV: Rgba = Rgba::new(17, 17, 19, 1.0);
    pub const BG_ELEV_2: Rgba = Rgba::new(22, 22, 26, 1.0);
    pub const BG_HOVER: Rgba = Rgba::new(24, 24, 28, 1.0);
    pub const DANGER: Rgba = Rgba::new(229, 90, 74, 1.0);
    pub const GRID: Rgba = Rgba::new(255, 255, 255, 0.02);
    pub const INFO: Rgba = Rgba::new(107, 156, 196, 1.0);
    pub const LINE: Rgba = Rgba::new(35, 35, 40, 1.0);
    pub const LINE_SOFT: Rgba = Rgba::new(26, 26, 30, 1.0);
    pub const OK: Rgba = Rgba::new(94, 164, 122, 1.0);
    pub const TEXT: Rgba = Rgba::new(236, 236, 236, 1.0);
    pub const TEXT_2: Rgba = Rgba::new(168, 168, 172, 1.0);
    pub const TEXT_3: Rgba = Rgba::new(110, 110, 115, 1.0);
    pub const TEXT_4: Rgba = Rgba::new(69, 69, 74, 1.0);
    pub const WARN: Rgba = Rgba::new(200, 147, 74, 1.0);
}

pub mod light {
    use super::Rgba;

    pub const ACCENT: Rgba = Rgba::new(20, 20, 22, 1.0);
    pub const ACCENT_GLOW: Rgba = Rgba::new(0, 0, 0, 0.04);
    pub const ACCENT_INK: Rgba = Rgba::new(245, 245, 243, 1.0);
    pub const BG: Rgba = Rgba::new(245, 245, 243, 1.0);
    pub const BG_ACTIVE: Rgba = Rgba::new(228, 228, 224, 1.0);
    pub const BG_ELEV: Rgba = Rgba::new(251, 251, 249, 1.0);
    pub const BG_ELEV_2: Rgba = Rgba::new(255, 255, 255, 1.0);
    pub const BG_HOVER: Rgba = Rgba::new(237, 237, 234, 1.0);
    pub const DANGER: Rgba = Rgba::new(181, 61, 43, 1.0);
    pub const GRID: Rgba = Rgba::new(0, 0, 0, 0.03);
    pub const INFO: Rgba = Rgba::new(53, 90, 122, 1.0);
    pub const LINE: Rgba = Rgba::new(225, 225, 221, 1.0);
    pub const LINE_SOFT: Rgba = Rgba::new(236, 236, 234, 1.0);
    pub const OK: Rgba = Rgba::new(53, 115, 79, 1.0);
    pub const TEXT: Rgba = Rgba::new(20, 20, 22, 1.0);
    pub const TEXT_2: Rgba = Rgba::new(74, 74, 78, 1.0);
    pub const TEXT_3: Rgba = Rgba::new(119, 119, 124, 1.0);
    pub const TEXT_4: Rgba = Rgba::new(166, 166, 170, 1.0);
    pub const WARN: Rgba = Rgba::new(154, 106, 26, 1.0);
}

pub mod sizes {
    pub const DENS_PAD_PX: f32 = 16.0;
    pub const DENS_ROW_PX: f32 = 48.0;
    pub const RADIUS_PX: f32 = 7.0;
    pub const RADIUS_LG_PX: f32 = 10.0;
    pub const RADIUS_SM_PX: f32 = 5.0;
    pub const RADIUS_XL_PX: f32 = 14.0;
}

/// 字体族常量（仅 Geist + Geist Mono，spec/00 § D5）。
pub mod fonts {
    pub const SANS: &str = "Geist";
    pub const MONO: &str = "Geist Mono";
}
