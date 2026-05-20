//! Unlock 屏：输主密码解锁。
//!
//! Phase B 同 onboarding 屏：使用固定 demo 密码（password 1234），点按钮解锁。
//! 真正的密码输入留在 Phase C。

use std::sync::Arc;

use gpui::{
    Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, prelude::*, px,
};

use crate::app::{AppState, RouteIntent, dispatch};
use crate::i18n;
use crate::services::vault::VaultHandle;

const DEMO_PASSWORD: &str = "password 1234";

pub struct UnlockView {
    vault: Arc<VaultHandle>,
    error_key: Option<&'static str>,
}

impl UnlockView {
    pub fn new(_cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        Self {
            vault,
            error_key: None,
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        match self.vault.service().unlock(DEMO_PASSWORD) {
            Ok(()) => {
                self.error_key = None;
                dispatch(cx, RouteIntent::GoVault);
            }
            Err(_) => {
                self.error_key = Some("unlock.error.invalid");
                cx.notify();
            }
        }
    }
}

impl Render for UnlockView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;

        let mut col = div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.0))
            .child(
                div()
                    .text_size(px(24.0))
                    .text_color(theme.text)
                    .child(SharedString::from(i18n::t("unlock.heading"))),
            )
            .child(
                div()
                    .max_w(px(420.0))
                    .text_size(px(13.0))
                    .text_color(theme.text_2)
                    .child(SharedString::from(i18n::t("unlock.subtitle"))),
            )
            .child(
                div()
                    .w(px(360.0))
                    .px(px(12.0))
                    .py(px(10.0))
                    .rounded(px(crate::theme::tokens::sizes::RADIUS_PX))
                    .bg(theme.bg_elev_2)
                    .border_1()
                    .border_color(theme.line)
                    .font_family(SharedString::from(crate::theme::tokens::fonts::MONO))
                    .text_color(theme.text_2)
                    .text_size(px(13.0))
                    .child(SharedString::from(format!("demo: {DEMO_PASSWORD}"))),
            );

        if let Some(err) = self.error_key {
            col = col.child(
                div()
                    .text_size(px(12.0))
                    .text_color(theme.danger)
                    .child(SharedString::from(i18n::t(err))),
            );
        }

        col.child(
            div().mt(px(16.0)).child(
                div()
                    .id("unlock-submit")
                    .min_w(px(360.0))
                    .px(px(16.0))
                    .py(px(10.0))
                    .rounded(px(crate::theme::tokens::sizes::RADIUS_PX))
                    .bg(theme.accent)
                    .text_color(theme.accent_ink)
                    .text_size(px(14.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(SharedString::from(i18n::t("unlock.submit")))
                    .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
            ),
        )
    }
}
