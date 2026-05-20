//! Vault 屏：item 列表 + "新建 demo login" + "锁定" 按钮。
//!
//! Phase B 简化：
//! - 列表只展示 `name` + `username`（解密 item 后渲染）。
//! - 新建按钮直接创建一个固定 demo login（不弹输入框）。
//! - 删除按钮放在 item 行尾。
//! - 主密码 / 详细字段编辑留给 Phase C。

use std::sync::Arc;

use gpui::{
    App, Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div,
    prelude::*, px,
};
use uuid::Uuid;

use crate::app::{AppState, RouteIntent, dispatch};
use crate::i18n;
use crate::services::vault::{VaultHandle, new_login};
use crate::theme::Theme;

pub struct VaultView {
    vault: Arc<VaultHandle>,
    items: Vec<zpass_vault_service::ItemSummary>,
    refresh_pending: bool,
}

impl VaultView {
    pub fn new(cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        let mut this = Self {
            vault,
            items: Vec::new(),
            refresh_pending: true,
        };
        this.refresh(cx);
        this
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        match self.vault.service().list_items() {
            Ok(items) => {
                self.items = items;
                self.refresh_pending = false;
            }
            Err(_) => {
                // vault 已锁 → 切回 unlock。
                self.items.clear();
                dispatch(cx, RouteIntent::GoUnlock);
            }
        }
    }

    fn create_demo_login(&mut self, cx: &mut Context<Self>) {
        let suffix = &Uuid::new_v4().to_string()[..8];
        let new = new_login(
            &format!("Demo login {suffix}"),
            "demo-user",
            "demo-password",
            Some("https://example.com"),
            None,
        );
        if self.vault.service().create_item(new).is_ok() {
            self.refresh(cx);
            cx.notify();
        }
    }

    fn delete(&mut self, id: String, cx: &mut Context<Self>) {
        let _ = self.vault.service().delete_item(&id);
        self.refresh(cx);
        cx.notify();
    }

    fn lock(&mut self, cx: &mut Context<Self>) {
        dispatch(cx, RouteIntent::LockVault);
    }
}

impl Render for VaultView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.refresh_pending {
            self.refresh(cx);
        }
        let theme = cx.global::<AppState>().theme;

        let header = div()
            .w_full()
            .px(px(24.0))
            .py(px(16.0))
            .flex()
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(theme.line)
            .child(
                div()
                    .text_size(px(18.0))
                    .text_color(theme.text)
                    .child(SharedString::from(i18n::t("vault.title"))),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        button(theme, "vault-new", i18n::t("vault.new"), true)
                            .on_click(cx.listener(|this, _, _, cx| this.create_demo_login(cx))),
                    )
                    .child(
                        button(theme, "vault-lock", i18n::t("vault.lock"), false)
                            .on_click(cx.listener(|this, _, _, cx| this.lock(cx))),
                    ),
            );

        let list = if self.items.is_empty() {
            div()
                .w_full()
                .py(px(48.0))
                .flex()
                .justify_center()
                .text_color(theme.text_3)
                .text_size(px(13.0))
                .child(SharedString::from(i18n::t("vault.empty")))
        } else {
            let mut list = div().w_full().flex().flex_col();
            for item in self.items.clone() {
                let id = item.id.clone();
                list = list.child(item_row(
                    theme,
                    &item,
                    cx.listener(move |this, _, _, cx| this.delete(id.clone(), cx)),
                ));
            }
            list
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .child(header)
            .child(list)
    }
}

fn item_row(
    theme: Theme,
    item: &zpass_vault_service::ItemSummary,
    on_delete: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .w_full()
        .px(px(24.0))
        .py(px(12.0))
        .flex()
        .items_center()
        .justify_between()
        .border_b_1()
        .border_color(theme.line_soft)
        .hover(|s| s.bg(theme.bg_hover))
        .child(
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(theme.text)
                        .child(SharedString::from(item.name.clone())),
                )
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(theme.text_3)
                        .child(SharedString::from(format!("{:?}", item.r#type))),
                ),
        )
        .child(
            div()
                .id(SharedString::from(format!("del-{}", item.id)))
                .px(px(10.0))
                .py(px(6.0))
                .rounded(px(crate::theme::tokens::sizes::RADIUS_SM_PX))
                .bg(theme.bg_elev_2)
                .text_color(theme.danger)
                .text_size(px(12.0))
                .cursor_pointer()
                .child(SharedString::from(i18n::t("vault.delete")))
                .on_click(on_delete),
        )
}

fn button(
    theme: Theme,
    id: &'static str,
    label: &'static str,
    primary: bool,
) -> gpui::Stateful<gpui::Div> {
    let (bg, fg) = if primary {
        (theme.accent, theme.accent_ink)
    } else {
        (theme.bg_elev_2, theme.text)
    };
    div()
        .id(id)
        .px(px(14.0))
        .py(px(8.0))
        .rounded(px(crate::theme::tokens::sizes::RADIUS_PX))
        .bg(bg)
        .text_color(fg)
        .text_size(px(13.0))
        .cursor_pointer()
        .child(SharedString::from(label))
}
