//! Unlock 屏：输主密码解锁。
//!
//! 使用 gpui-component 的 `Input`（masked）。错误时把 `error_key` 设为
//! `unlock.error.invalid`，渲染时显示为红色提示（供测试断言）。
//!
//! ## 异步解锁
//! Argon2id KDF 在桌面默认参数下需 1–2s，**必须**通过
//! `cx.background_executor().spawn(...)` 推到后台线程，否则 GPUI 主线程会卡死、
//! 按钮无反馈。期间 `submitting=true`，Button 进 loading 状态（自动 spinner +
//! 不响应 click），且 Enter 重入被 guard 早返回阻止。

use std::sync::Arc;

use gpui::{
    Context, Entity, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, prelude::*, px,
};
use gpui_component::{
    Disableable as _,
    button::{Button, ButtonVariants as _},
    input::{Input, InputEvent, InputState},
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
    /// 正在跑 KDF / vault.unlock 的标志。`true` 期间 submit 早返回、Button loading+disabled。
    pub(super) submitting: bool,
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
            submitting: false,
            _subscriptions: vec![sub_enter, sub_change],
        }
    }

    pub(super) fn submit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        // 重入 guard：必须是第一行。KDF 进行中再次 Enter / click 都直接忽略。
        if self.submitting {
            return;
        }

        // 副本即时 zero（gpui-component 的 InputState 自己持有 SharedString，无法 zero；
        // 但我们传给 vault 的字符串至少不在我们的栈上留印迹）。
        let password = Zeroizing::new(self.password_state.read(cx).value().as_ref().to_owned());
        let svc = self.vault.service();

        // 立刻反馈：进入 submitting 状态，清掉旧错误。Render 会把 Button 切到 loading。
        self.submitting = true;
        self.error_key = None;
        cx.notify();

        // 把阻塞 KDF 推到 background executor 上的后台线程。
        // background_executor.spawn 要求 future Send；`Arc<VaultService<SqliteVaultStore>>`
        // 是 Send（编译期断言见 services/vault.rs 末尾的 _assert_send）。
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, async_cx| {
            // 在后台线程跑同步 KDF。`async move { ... }` 把同步代码包成立即 ready 的
            // future；executor 会把它分到一个线程池 worker 上执行。
            let result = bg.spawn(async move { svc.unlock(password.as_str()) }).await;

            // 回主线程：window 可能在 KDF 期间关闭，update 会返 Err，此时直接 drop。
            let _ = this.update(async_cx, |this, cx| {
                this.submitting = false;
                match result {
                    Ok(()) => {
                        this.error_key = None;
                        cx.notify();
                        dispatch(cx, RouteIntent::GoVault);
                    }
                    Err(_) => {
                        this.error_key = Some("unlock.error.invalid");
                        cx.notify();
                    }
                }
            });
        })
        .detach();
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

        let label_key = if self.submitting {
            "unlock.submitting"
        } else {
            "unlock.submit"
        };

        col.child(
            div().mt(px(16.0)).child(
                Button::new("unlock-submit")
                    .primary()
                    .loading(self.submitting)
                    .disabled(self.submitting)
                    .label(i18n::t(label_key))
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
