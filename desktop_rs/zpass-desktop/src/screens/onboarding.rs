//! Onboarding 屏：设主密码 + 强度提示。
//!
//! 使用 gpui-component 的 `Input` 控件（masked + 校验）。验证规则：
//! - 主密码长度 >= 8（spec/04 默认 KDF 上限内的最小可用强度）。
//! - 两次输入必须一致。
//!
//! 满足条件后调用 `VaultService::initialize` 并跳转到 vault 屏。

use std::sync::Arc;

use gpui::{
    Context, Entity, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, prelude::*, px,
};
use gpui_component::{
    WindowExt as _,
    button::{Button, ButtonVariants as _},
    input::{Input, InputEvent, InputState},
    notification::NotificationType,
    v_flex,
};
use zeroize::Zeroizing;
use zpass_vault_service::VaultError;

use crate::app::{AppState, RouteIntent, dispatch};
use crate::i18n;
use crate::services::vault::{VaultHandle, password_strength_label};
use crate::theme::Theme;

pub struct OnboardingView {
    vault: Arc<VaultHandle>,
    pub(super) password_state: Entity<InputState>,
    pub(super) confirm_state: Entity<InputState>,
    pub(super) error_key: Option<&'static str>,
    _subscriptions: Vec<Subscription>,
}

impl OnboardingView {
    /// 当前主密码强度的 i18n key。读 input 值实时计算（gpui-component 0.5 的
    /// `InputState::set_value` 不触发 `Change` 事件，所以这里改为 pull-based）。
    pub(super) fn strength_key(&self, cx: &gpui::App) -> &'static str {
        password_strength_label(self.password_state.read(cx).value().as_ref())
    }

    pub fn new(window: &mut Window, cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        let password_state = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder(i18n::t("onboarding.password.placeholder"))
        });
        let confirm_state = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder(i18n::t("onboarding.confirm.placeholder"))
        });

        // 订阅密码输入变化 → 触发重渲染（让 strength label 实时刷新）+ 清错。
        let sub_pw = cx.subscribe_in(&password_state, window, {
            move |this: &mut Self, _, ev: &InputEvent, _window, cx| {
                if matches!(ev, InputEvent::Change) {
                    this.error_key = None;
                    cx.notify();
                }
            }
        });
        // 订阅 confirm 输入变化 → 清空 error（用户重新输入）。
        let sub_confirm = cx.subscribe_in(&confirm_state, window, {
            move |this: &mut Self, _, ev: &InputEvent, _window, cx| {
                if matches!(ev, InputEvent::Change) {
                    this.error_key = None;
                    cx.notify();
                }
            }
        });
        // Enter 在 confirm 上提交。
        let sub_enter = cx.subscribe_in(&confirm_state, window, {
            move |this: &mut Self, _, ev: &InputEvent, window, cx| {
                if matches!(ev, InputEvent::PressEnter { .. }) {
                    this.submit(window, cx);
                }
            }
        });

        Self {
            vault,
            password_state,
            confirm_state,
            error_key: None,
            _subscriptions: vec![sub_pw, sub_confirm, sub_enter],
        }
    }

    /// 读取输入并立即包到 `Zeroizing<String>`：drop 时 OS allocator 之外的内存会被
    /// 抹零（`Arc<str>` 自身不会被 zero，但我们持有的副本会，这是 best-effort vs Go memguard）。
    fn current_password(&self, cx: &Context<Self>) -> Zeroizing<String> {
        Zeroizing::new(self.password_state.read(cx).value().as_ref().to_owned())
    }

    fn current_confirm(&self, cx: &Context<Self>) -> Zeroizing<String> {
        Zeroizing::new(self.confirm_state.read(cx).value().as_ref().to_owned())
    }

    /// 提交：校验 + 调用 vault.initialize；错误用 notification 弹出。
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let password = self.current_password(cx);
        let confirm = self.current_confirm(cx);

        if password.chars().count() < 8 {
            self.error_key = Some("onboarding.error.tooShort");
            cx.notify();
            return;
        }
        if *password != *confirm {
            self.error_key = Some("onboarding.error.mismatch");
            cx.notify();
            return;
        }

        match self.vault.service().initialize(password.as_str()) {
            Ok(()) => {
                self.error_key = None;
                cx.notify();
                dispatch(cx, RouteIntent::GoVault);
            }
            Err(VaultError::AlreadyInitialized) => {
                self.error_key = None;
                cx.notify();
                dispatch(cx, RouteIntent::GoUnlock);
            }
            Err(_) => {
                self.error_key = Some("common.error");
                window.push_notification((NotificationType::Error, i18n::t("common.error")), cx);
                cx.notify();
            }
        }
    }
}

impl Render for OnboardingView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;
        let strength_label = i18n::t(self.strength_key(cx));

        let mut col = v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap(px(12.0))
            .child(heading(theme, i18n::t("onboarding.heading")))
            .child(subtitle(theme, i18n::t("onboarding.subtitle")))
            .child(
                div()
                    .w(px(360.0))
                    .child(Input::new(&self.password_state).mask_toggle()),
            )
            .child(
                div()
                    .w(px(360.0))
                    .child(Input::new(&self.confirm_state).mask_toggle()),
            )
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(theme.text_3)
                    .child(SharedString::from(strength_label)),
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
                    Button::new("onboarding-submit")
                        .primary()
                        .label(i18n::t("onboarding.submit"))
                        .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                )
                .child(
                    Button::new("onboarding-back")
                        .label("Back")
                        .on_click(|_, _, cx| dispatch(cx, RouteIntent::GoWelcome)),
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

#[cfg(test)]
mod tests {
    // gpui::test 测试在 src/screens/tests.rs（顶层），避免每个 screen 重复测试装配。
}
