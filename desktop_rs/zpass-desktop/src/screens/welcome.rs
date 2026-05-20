//! Welcome 屏：欢迎 + 「Create vault / Open vault」分流。
//!
//! Phase B 简化：vault 文件在固定路径（`config_root/vault.db`），两个按钮
//! 实际做同一件事——切到 onboarding 或 unlock，由 vault 是否 initialized 决定。
//!
//! NOTE：按钮点击通过 `WorkspaceView` 全局 message 路由（见 `crate::app::route`），
//! 此处只负责渲染。

use std::sync::Arc;

use gpui::{
    Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, prelude::*, px,
};

use crate::app::{AppState, RouteIntent};
use crate::i18n;
use crate::services::vault::VaultHandle;
use crate::theme::Theme;

pub struct WelcomeView {
    vault: Arc<VaultHandle>,
}

impl WelcomeView {
    pub fn new(_cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        Self { vault }
    }
}

impl Render for WelcomeView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;
        let initialized = self
            .vault
            .status_blocking()
            .map(|s| s.initialized)
            .unwrap_or(false);

        let create_intent = if initialized {
            RouteIntent::GoUnlock
        } else {
            RouteIntent::GoOnboarding
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(24.0))
            .child(heading(theme, i18n::t("welcome.heading")))
            .child(subtitle(theme, i18n::t("welcome.subtitle")))
            .child(
                div()
                    .mt(px(24.0))
                    .flex()
                    .gap(px(12.0))
                    .child(primary_button(
                        theme,
                        i18n::t("welcome.create"),
                        create_intent,
                    ))
                    .child(secondary_button(
                        theme,
                        i18n::t("welcome.open"),
                        RouteIntent::GoUnlock,
                    )),
            )
    }
}

fn heading(theme: Theme, label: &'static str) -> impl IntoElement {
    div()
        .text_size(px(32.0))
        .text_color(theme.text)
        .child(SharedString::from(label))
}

fn subtitle(theme: Theme, label: &'static str) -> impl IntoElement {
    div()
        .max_w(px(420.0))
        .text_size(px(14.0))
        .text_color(theme.text_2)
        .child(SharedString::from(label))
}

pub(crate) fn primary_button(
    theme: Theme,
    label: &'static str,
    intent: RouteIntent,
) -> impl IntoElement {
    button_inner(theme, label, theme.accent, theme.accent_ink, intent)
}

pub(crate) fn secondary_button(
    theme: Theme,
    label: &'static str,
    intent: RouteIntent,
) -> impl IntoElement {
    button_inner(theme, label, theme.bg_elev_2, theme.text, intent)
}

fn button_inner(
    _theme: Theme,
    label: &'static str,
    bg: gpui::Hsla,
    fg: gpui::Hsla,
    intent: RouteIntent,
) -> impl IntoElement {
    div()
        .id(SharedString::from(format!("btn-{label}")))
        .min_w(px(160.0))
        .px(px(16.0))
        .py(px(10.0))
        .rounded(px(crate::theme::tokens::sizes::RADIUS_PX))
        .bg(bg)
        .text_color(fg)
        .text_size(px(14.0))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .child(SharedString::from(label))
        .on_click(move |_event, _window, cx| {
            crate::app::dispatch(cx, intent);
        })
}
