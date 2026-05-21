//! 密码生成器屏（spec/11 § 9a + design/src/generator.jsx）。
//!
//! - 长度滑条用按钮 ± 调整（GPUI gpui-component 暂未提供原生 slider；用 +/- 按钮
//!   分级是与 design 视觉一致的最简实现）。
//! - 4 个字符类 toggle（lower / upper / digits / symbols）+ avoid_ambiguous toggle。
//! - 主显示区：当前密码 mono 字号大。Copy / Regenerate 按钮。
//! - 右侧：熵 bit 数 + 强度等级文案。

use gpui::{Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, px};
use gpui_component::{
    Sizable as _,
    button::{Button, ButtonVariants as _},
    v_flex,
};
use zeroize::Zeroizing;

use crate::app::AppState;
use crate::i18n;
use crate::services::clipboard::copy_text;
use crate::services::generator::{
    GenOpts, StrengthLevel, classify_strength, entropy_bits, generate,
};
use crate::theme::Theme;

pub struct GeneratorView {
    opts: GenOpts,
    /// 当前显示密码。用 String 包 Zeroizing；render 时只读引用。
    current: Zeroizing<String>,
    /// 上一次生成是否出错（length 范围 / 没字符类）。
    error_key: Option<&'static str>,
}

impl GeneratorView {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        let opts = GenOpts::default();
        let current = generate(&opts).unwrap_or_else(|_| Zeroizing::new(String::new()));
        Self {
            opts,
            current,
            error_key: None,
        }
    }

    fn regen(&mut self, cx: &mut Context<Self>) {
        match generate(&self.opts) {
            Ok(pw) => {
                self.current = pw;
                self.error_key = None;
            }
            Err(_) => {
                self.error_key = Some("generator.error");
            }
        }
        cx.notify();
    }

    fn copy_current(&mut self, _cx: &mut Context<Self>) {
        // Zeroizing<String> deref → &str
        let _ = copy_text(&self.current);
    }

    fn adjust_length(&mut self, delta: i32, cx: &mut Context<Self>) {
        let new = (self.opts.length as i32 + delta).clamp(8, 128) as usize;
        self.opts.length = new;
        self.regen(cx);
    }

    fn toggle_class(&mut self, which: ClassToggle, cx: &mut Context<Self>) {
        match which {
            ClassToggle::Lower => self.opts.lowercase = !self.opts.lowercase,
            ClassToggle::Upper => self.opts.uppercase = !self.opts.uppercase,
            ClassToggle::Digits => self.opts.digits = !self.opts.digits,
            ClassToggle::Symbols => self.opts.symbols = !self.opts.symbols,
            ClassToggle::AvoidAmbiguous => self.opts.avoid_ambiguous = !self.opts.avoid_ambiguous,
        }
        self.regen(cx);
    }
}

#[derive(Debug, Clone, Copy)]
enum ClassToggle {
    Lower,
    Upper,
    Digits,
    Symbols,
    AvoidAmbiguous,
}

impl Render for GeneratorView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;
        let bits = entropy_bits(&self.opts);
        let level = classify_strength(bits);

        let mut col = v_flex().size_full().p(px(32.0)).gap(px(20.0));

        // 标题
        col = col.child(
            div()
                .text_size(px(24.0))
                .text_color(theme.text)
                .child(SharedString::from(i18n::t("generator.title"))),
        );
        col = col.child(
            div()
                .text_size(px(13.0))
                .text_color(theme.text_3)
                .child(SharedString::from(i18n::t("generator.subtitle"))),
        );

        // 当前密码大字号显示
        col = col.child(
            div()
                .w_full()
                .p(px(20.0))
                .rounded(px(10.0))
                .bg(theme.bg_elev)
                .border_1()
                .border_color(theme.line)
                .text_size(px(20.0))
                .font_family(crate::theme::tokens::fonts::MONO)
                .text_color(theme.text)
                .child(SharedString::from(self.current.to_string())),
        );

        // 主操作按钮
        col = col.child(
            div()
                .flex()
                .gap(px(8.0))
                .child(
                    Button::new("gen-regen")
                        .small()
                        .label(i18n::t("generator.regenerate"))
                        .on_click(cx.listener(|this, _, _, cx| this.regen(cx))),
                )
                .child(
                    Button::new("gen-copy")
                        .primary()
                        .small()
                        .label(i18n::t("generator.copy"))
                        .on_click(cx.listener(|this, _, _, cx| this.copy_current(cx))),
                ),
        );

        // 长度控制
        col = col.child(
            div()
                .flex()
                .items_center()
                .gap(px(12.0))
                .child(
                    div()
                        .w(px(120.0))
                        .text_color(theme.text_2)
                        .text_size(px(13.0))
                        .child(SharedString::from(i18n::t("generator.length"))),
                )
                .child(
                    Button::new("gen-len-minus")
                        .small()
                        .label("-")
                        .on_click(cx.listener(|this, _, _, cx| this.adjust_length(-1, cx))),
                )
                .child(
                    div()
                        .min_w(px(40.0))
                        .text_color(theme.text)
                        .text_size(px(14.0))
                        .font_family(crate::theme::tokens::fonts::MONO)
                        .child(SharedString::from(format!("{}", self.opts.length))),
                )
                .child(
                    Button::new("gen-len-plus")
                        .small()
                        .label("+")
                        .on_click(cx.listener(|this, _, _, cx| this.adjust_length(1, cx))),
                )
                .child(
                    Button::new("gen-len-minus8")
                        .small()
                        .label("--")
                        .on_click(cx.listener(|this, _, _, cx| this.adjust_length(-8, cx))),
                )
                .child(
                    Button::new("gen-len-plus8")
                        .small()
                        .label("++")
                        .on_click(cx.listener(|this, _, _, cx| this.adjust_length(8, cx))),
                ),
        );

        // class 切换
        col = col.child(
            div()
                .flex()
                .gap(px(8.0))
                .child(class_toggle(
                    "gen-lower",
                    "generator.class.lowercase",
                    self.opts.lowercase,
                    theme,
                    cx,
                    ClassToggle::Lower,
                ))
                .child(class_toggle(
                    "gen-upper",
                    "generator.class.uppercase",
                    self.opts.uppercase,
                    theme,
                    cx,
                    ClassToggle::Upper,
                ))
                .child(class_toggle(
                    "gen-digits",
                    "generator.class.digits",
                    self.opts.digits,
                    theme,
                    cx,
                    ClassToggle::Digits,
                ))
                .child(class_toggle(
                    "gen-symbols",
                    "generator.class.symbols",
                    self.opts.symbols,
                    theme,
                    cx,
                    ClassToggle::Symbols,
                ))
                .child(class_toggle(
                    "gen-amb",
                    "generator.class.avoidAmbiguous",
                    self.opts.avoid_ambiguous,
                    theme,
                    cx,
                    ClassToggle::AvoidAmbiguous,
                )),
        );

        // 错误显示
        if let Some(key) = self.error_key {
            col = col.child(
                div()
                    .text_size(px(12.0))
                    .text_color(theme.danger)
                    .child(SharedString::from(i18n::t(key))),
            );
        }

        // 熵 / 强度
        col = col.child(
            div()
                .flex()
                .gap(px(16.0))
                .pt(px(12.0))
                .border_t_1()
                .border_color(theme.line_soft)
                .child(
                    div()
                        .flex_1()
                        .text_color(theme.text_2)
                        .text_size(px(13.0))
                        .font_family(crate::theme::tokens::fonts::MONO)
                        .child(SharedString::from(format!(
                            "{}: {} bits",
                            i18n::t("generator.entropy"),
                            bits
                        ))),
                )
                .child(
                    div()
                        .text_color(strength_color(level, theme))
                        .text_size(px(13.0))
                        .child(SharedString::from(i18n::t(strength_label_key(level)))),
                ),
        );

        col
    }
}

fn class_toggle(
    id: &'static str,
    label_key: &'static str,
    active: bool,
    _theme: Theme,
    cx: &mut Context<GeneratorView>,
    which: ClassToggle,
) -> impl IntoElement {
    let mut btn = Button::new(id).small().label(i18n::t(label_key));
    if active {
        btn = btn.primary();
    }
    btn.on_click(cx.listener(move |this, _, _, cx| this.toggle_class(which, cx)))
}

fn strength_label_key(level: StrengthLevel) -> &'static str {
    match level {
        StrengthLevel::Weak => "generator.strength.weak",
        StrengthLevel::Fair => "generator.strength.fair",
        StrengthLevel::Strong => "generator.strength.strong",
        StrengthLevel::VeryStrong => "generator.strength.veryStrong",
    }
}

fn strength_color(level: StrengthLevel, theme: Theme) -> gpui::Hsla {
    match level {
        StrengthLevel::Weak => theme.danger,
        StrengthLevel::Fair => theme.warn,
        StrengthLevel::Strong => theme.ok,
        StrengthLevel::VeryStrong => theme.accent,
    }
}
