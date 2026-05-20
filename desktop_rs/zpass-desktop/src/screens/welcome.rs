//! Welcome 屏：欢迎 + 「Create vault / Open vault」分流。
//!
//! Phase B 简化：vault 文件在固定路径（`config_root/vault.db`）。
//! 两个按钮根据 vault 是否已初始化分流到 onboarding 或 unlock。

use std::sync::Arc;

use gpui::{Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, px};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    v_flex,
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

    /// 仅测试用：暴露内部 vault 句柄给 `#[gpui::test]` 断言 wiring 一致。
    #[cfg(test)]
    pub(super) fn vault_arc(&self) -> &Arc<VaultHandle> {
        &self.vault
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

        v_flex()
            .size_full()
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
                    .child(
                        Button::new("welcome-create")
                            .primary()
                            .label(i18n::t("welcome.create"))
                            .on_click(move |_, _, cx| crate::app::dispatch(cx, create_intent)),
                    )
                    .child(
                        Button::new("welcome-open")
                            .label(i18n::t("welcome.open"))
                            .on_click(|_, _, cx| crate::app::dispatch(cx, RouteIntent::GoUnlock)),
                    ),
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
