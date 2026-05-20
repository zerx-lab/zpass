//! TOTP 聚合屏（spec/11 § 5 + design/src/vault.jsx 的 TOTP 视图）。
//!
//! Phase C / sub-phase C6 才填实质内容；C4 先放可路由的占位。

use std::sync::Arc;

use gpui::{Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, px};

use crate::app::AppState;
use crate::i18n;
use crate::services::vault::VaultHandle;

pub struct TotpView {
    #[allow(dead_code)]
    vault: Arc<VaultHandle>,
}

impl TotpView {
    pub fn new(_cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        Self { vault }
    }
}

impl Render for TotpView {
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
                    .child(SharedString::from(i18n::t("totp.title"))),
            )
            .child(
                div()
                    .text_size(px(13.0))
                    .text_color(theme.text_3)
                    .child(SharedString::from(i18n::t("totp.subtitle"))),
            )
    }
}
