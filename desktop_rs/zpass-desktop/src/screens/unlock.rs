//! Unlock 屏：输主密码解锁。
//!
//! 使用 gpui-component 的 `Input`（masked）。错误时弹一个 `NotificationType::Error` toast
//! 同时把 `error_key` 设为 `unlock.error.invalid`，供测试断言。

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

use crate::app::{AppState, RouteIntent, dispatch};
use crate::i18n;
use crate::services::vault::VaultHandle;
use crate::theme::Theme;

pub struct UnlockView {
    vault: Arc<VaultHandle>,
    pub(super) password_state: Entity<InputState>,
    pub(super) error_key: Option<&'static str>,
    _subscriptions: Vec<Subscription>,
}

impl UnlockView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        let password_state = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder(i18n::t("unlock.password.placeholder"))
        });

        // Enter 触发提交。
        let sub_enter = cx.subscribe_in(&password_state, window, {
            move |this: &mut Self, _, ev: &InputEvent, window, cx| {
                if matches!(ev, InputEvent::PressEnter { .. }) {
                    this.submit(window, cx);
                }
            }
        });
        // 输入变化清错误。
        let sub_change = cx.subscribe_in(&password_state, window, {
            move |this: &mut Self, _, ev: &InputEvent, _window, cx| {
                if matches!(ev, InputEvent::Change) && this.error_key.is_some() {
                    this.error_key = None;
                    cx.notify();
                }
            }
        });

        Self {
            vault,
            password_state,
            error_key: None,
            _subscriptions: vec![sub_enter, sub_change],
        }
    }

    pub(super) fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // 副本即时 zero（gpui-component 的 InputState 自己持有 SharedString，无法 zero；
        // 但我们传给 vault 的字符串至少不在我们的栈上留印迹）。
        let password = Zeroizing::new(self.password_state.read(cx).value().as_ref().to_owned());
        match self.vault.service().unlock(password.as_str()) {
            Ok(()) => {
                self.error_key = None;
                cx.notify();
                dispatch(cx, RouteIntent::GoVault);
            }
            Err(_) => {
                self.error_key = Some("unlock.error.invalid");
                window.push_notification(
                    (NotificationType::Error, i18n::t("unlock.error.invalid")),
                    cx,
                );
                cx.notify();
            }
        }
    }
}

impl Render for UnlockView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;

        let mut col = v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap(px(12.0))
            .child(heading(theme, i18n::t("unlock.heading")))
            .child(subtitle(theme, i18n::t("unlock.subtitle")))
            .child(
                div()
                    .w(px(360.0))
                    .child(Input::new(&self.password_state).mask_toggle()),
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
                Button::new("unlock-submit")
                    .primary()
                    .label(i18n::t("unlock.submit"))
                    .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
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
