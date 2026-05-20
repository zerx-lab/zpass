//! Onboarding 屏：设主密码 + 强度提示。
//!
//! **Phase B 限制**：GPUI 核心没有文本输入控件，Zed 的 `editor` crate 体积巨大且
//! 与 Phase B 范围不匹配。本屏目前提供两个交互按钮：
//!
//! - 「使用 demo 密码（password 1234）」：用一个固定密码初始化 vault，让 4 屏路由跑通。
//! - 「返回」：回到 Welcome。
//!
//! 真正的密码输入控件留在 Phase C（与 generator / settings 一起接入文本输入栈）。
//! 详见 docs/dev-setup.md 的 Phase B → C 升级 follow-up。

use std::sync::Arc;

use gpui::{
    Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, prelude::*, px,
};

use crate::app::{AppState, RouteIntent, dispatch};
use crate::i18n;
use crate::services::vault::{VaultHandle, password_strength_label};
use crate::theme::Theme;

const DEMO_PASSWORD: &str = "password 1234";

pub struct OnboardingView {
    vault: Arc<VaultHandle>,
    error_key: Option<&'static str>,
}

impl OnboardingView {
    pub fn new(_cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        Self {
            vault,
            error_key: None,
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        match self.vault.service().initialize(DEMO_PASSWORD) {
            Ok(()) => {
                self.error_key = None;
                dispatch(cx, RouteIntent::GoVault);
            }
            Err(zpass_vault_service::VaultError::AlreadyInitialized) => {
                // vault 已存在 → 直接走 unlock。
                self.error_key = None;
                dispatch(cx, RouteIntent::GoUnlock);
            }
            Err(_) => {
                self.error_key = Some("common.error");
                cx.notify();
            }
        }
    }
}

impl Render for OnboardingView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;
        let strength = password_strength_label(DEMO_PASSWORD);

        let mut col = div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.0))
            .child(heading(theme, i18n::t("onboarding.heading")))
            .child(subtitle(theme, i18n::t("onboarding.subtitle")))
            .child(demo_password_box(theme))
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(theme.text_3)
                    .child(SharedString::from(i18n::t(strength))),
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
            div()
                .mt(px(16.0))
                .flex()
                .gap(px(12.0))
                .child(
                    submit_button(theme, i18n::t("onboarding.submit"))
                        .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
                )
                .child(
                    back_button(theme).on_click(|_, _, cx| dispatch(cx, RouteIntent::GoWelcome)),
                ),
        )
    }
}

fn heading(theme: Theme, label: &'static str) -> impl IntoElement {
    div()
        .text_size(px(24.0))
        .text_color(theme.text)
        .child(SharedString::from(label))
}

fn subtitle(theme: Theme, label: &'static str) -> impl IntoElement {
    div()
        .max_w(px(420.0))
        .text_size(px(13.0))
        .text_color(theme.text_2)
        .child(SharedString::from(label))
}

fn demo_password_box(theme: Theme) -> impl IntoElement {
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
        .child(SharedString::from(format!(
            "demo: {DEMO_PASSWORD}  (Phase C will add real text input)"
        )))
}

fn submit_button(theme: Theme, label: &'static str) -> gpui::Stateful<gpui::Div> {
    div()
        .id("onboarding-submit")
        .min_w(px(180.0))
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
        .child(SharedString::from(label))
}

fn back_button(theme: Theme) -> gpui::Stateful<gpui::Div> {
    div()
        .id("onboarding-back")
        .min_w(px(120.0))
        .px(px(16.0))
        .py(px(10.0))
        .rounded(px(crate::theme::tokens::sizes::RADIUS_PX))
        .bg(theme.bg_elev_2)
        .text_color(theme.text)
        .text_size(px(14.0))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .child(SharedString::from("Back"))
}
