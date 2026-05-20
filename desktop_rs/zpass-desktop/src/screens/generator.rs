//! 密码生成器屏（spec/11 § 9a + design/src/generator.jsx）。
//!
//! Phase C / sub-phase C7 才填实质内容。C4 先放可路由的占位。

use gpui::{Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, px};

use crate::app::AppState;
use crate::i18n;

pub struct GeneratorView {
    // C7 填字段（长度 / class 切换 / 当前密码 etc）。
}

impl GeneratorView {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {}
    }
}

impl Render for GeneratorView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;
        div()
            .size_full()
            .p(px(32.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(px(24.0))
                    .text_color(theme.text)
                    .child(SharedString::from(i18n::t("generator.title"))),
            )
            .child(
                div()
                    .text_size(px(13.0))
                    .text_color(theme.text_3)
                    .child(SharedString::from(i18n::t("generator.subtitle"))),
            )
    }
}
