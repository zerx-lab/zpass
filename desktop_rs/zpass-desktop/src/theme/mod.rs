//! Theme + design tokens 桥接到 GPUI。
//!
//! tokens.rs 由 scripts/sync-tokens.py 自动生成，单一真相源是 design/src/tokens.css。

pub mod tokens;

use gpui::Hsla;

/// Phase B 暴露的颜色集合。某些字段（accent / ok / warn 等）当前未用，
/// 留作 Phase C 的 generator / settings 入口；不通过 `#[allow]` 隐藏，让 reviewer 看到。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub bg: Hsla,
    pub bg_elev: Hsla,
    pub bg_elev_2: Hsla,
    pub bg_hover: Hsla,
    pub bg_active: Hsla,
    pub line: Hsla,
    pub line_soft: Hsla,
    pub text: Hsla,
    pub text_2: Hsla,
    pub text_3: Hsla,
    pub accent: Hsla,
    pub accent_ink: Hsla,
    pub danger: Hsla,
    pub ok: Hsla,
    pub warn: Hsla,
}

impl Theme {
    pub fn dark() -> Self {
        use tokens::dark::*;
        Self {
            bg: BG.to_hsla(),
            bg_elev: BG_ELEV.to_hsla(),
            bg_elev_2: BG_ELEV_2.to_hsla(),
            bg_hover: BG_HOVER.to_hsla(),
            bg_active: BG_ACTIVE.to_hsla(),
            line: LINE.to_hsla(),
            line_soft: LINE_SOFT.to_hsla(),
            text: TEXT.to_hsla(),
            text_2: TEXT_2.to_hsla(),
            text_3: TEXT_3.to_hsla(),
            accent: ACCENT.to_hsla(),
            accent_ink: ACCENT_INK.to_hsla(),
            danger: DANGER.to_hsla(),
            ok: OK.to_hsla(),
            warn: WARN.to_hsla(),
        }
    }

    pub fn light() -> Self {
        use tokens::light::*;
        Self {
            bg: BG.to_hsla(),
            bg_elev: BG_ELEV.to_hsla(),
            bg_elev_2: BG_ELEV_2.to_hsla(),
            bg_hover: BG_HOVER.to_hsla(),
            bg_active: BG_ACTIVE.to_hsla(),
            line: LINE.to_hsla(),
            line_soft: LINE_SOFT.to_hsla(),
            text: TEXT.to_hsla(),
            text_2: TEXT_2.to_hsla(),
            text_3: TEXT_3.to_hsla(),
            accent: ACCENT.to_hsla(),
            accent_ink: ACCENT_INK.to_hsla(),
            danger: DANGER.to_hsla(),
            ok: OK.to_hsla(),
            warn: WARN.to_hsla(),
        }
    }
}
