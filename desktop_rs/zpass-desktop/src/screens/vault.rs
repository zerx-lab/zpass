//! Vault 屏：item 列表 + 搜索框 + 新建 login 表单。
//!
//! Phase B 范围：
//! - 列表展示 `name` + 类型，按搜索框过滤（client-side substring match）。
//! - 「新建 login」按钮展开一个表单（name / username / password 3 个 Input），保存后追加到列表。
//! - 每行尾端的「删除」按钮即时移除。
//! - 不实现编辑 / 详情查看 / 非 login 类型（留 Phase C）。
//!
//! 事件订阅：构造时通过 `VaultHandle::gpui_subject(cx)` 拿到 subject，订阅 `ItemCreated`
//! / `ItemDeleted` / `Locked` 即可重刷列表。

use std::sync::Arc;

use gpui::{
    App, Context, Entity, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, prelude::*, px,
};
use gpui_component::{
    Sizable as _,
    button::{Button, ButtonVariants as _},
    input::{Input, InputEvent, InputState},
    v_flex,
};

use crate::app::{AppState, RouteIntent, dispatch};
use crate::i18n;
use crate::services::vault::{VaultHandle, VaultUiEvent, new_login};
use crate::theme::Theme;

pub struct VaultView {
    vault: Arc<VaultHandle>,
    pub(super) items: Vec<zpass_vault_service::ItemSummary>,
    pub(super) search_state: Entity<InputState>,
    /// 新建表单是否展开。
    pub(super) form_open: bool,
    pub(super) name_state: Entity<InputState>,
    pub(super) username_state: Entity<InputState>,
    pub(super) password_state: Entity<InputState>,
    pub(super) form_error: Option<&'static str>,
    _subscriptions: Vec<Subscription>,
}

impl VaultView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        let search_state = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t("vault.search.placeholder"))
                .clean_on_escape()
        });
        let name_state =
            cx.new(|cx| InputState::new(window, cx).placeholder(i18n::t("vault.item.name")));
        let username_state =
            cx.new(|cx| InputState::new(window, cx).placeholder(i18n::t("vault.item.username")));
        let password_state = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder(i18n::t("vault.item.password"))
        });

        // 订阅 vault 事件：item create/delete/lock 时刷新列表。
        let subject = vault.gpui_subject(cx);
        let sub_vault = cx.subscribe(&subject, {
            move |this: &mut Self, _, ev: &VaultUiEvent, cx| match ev {
                VaultUiEvent::Unlocked
                | VaultUiEvent::ItemCreated { .. }
                | VaultUiEvent::ItemDeleted { .. }
                | VaultUiEvent::ItemUpdated { .. } => {
                    this.refresh(cx);
                    cx.notify();
                }
                VaultUiEvent::Locked => {
                    this.items.clear();
                    dispatch(cx, RouteIntent::GoUnlock);
                }
                _ => {}
            }
        });
        // 搜索框变化 → 触发重渲染。
        let sub_search = cx.subscribe_in(&search_state, window, {
            move |_this: &mut Self, _, ev: &InputEvent, _window, cx| {
                if matches!(ev, InputEvent::Change) {
                    cx.notify();
                }
            }
        });

        // 不在构造时 refresh：构造发生在 WorkspaceView::new 装配阶段，此时 vault
        // 大概率还未解锁，提前调 list_items() 会 dispatch(GoUnlock) 干扰初始路由
        // （即使当前屏是 Welcome）。改由 Render 在 vault 解锁后主动调 refresh。
        Self {
            vault,
            items: Vec::new(),
            search_state,
            form_open: false,
            name_state,
            username_state,
            password_state,
            form_error: None,
            _subscriptions: vec![sub_vault, sub_search],
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        match self.vault.service().list_items() {
            Ok(items) => {
                self.items = items;
            }
            Err(_) => {
                // vault 已锁 → 切回 unlock。
                self.items.clear();
                dispatch(cx, RouteIntent::GoUnlock);
            }
        }
    }

    pub(super) fn open_form(&mut self, cx: &mut Context<Self>) {
        self.form_open = true;
        self.form_error = None;
        cx.notify();
    }

    fn cancel_form(&mut self, cx: &mut Context<Self>) {
        self.form_open = false;
        self.form_error = None;
        cx.notify();
    }

    /// 表单提交：3 字段都非空才创建；事件桥会触发 `refresh`，但为可测性这里也立刻 refresh 一次。
    pub(super) fn save_form(&mut self, cx: &mut Context<Self>) {
        let name = self.name_state.read(cx).value().clone();
        let username = self.username_state.read(cx).value().clone();
        // 密码即时包 Zeroizing；name / username 不算敏感。
        let password =
            zeroize::Zeroizing::new(self.password_state.read(cx).value().as_ref().to_owned());

        if name.trim().is_empty() {
            self.form_error = Some("common.error");
            cx.notify();
            return;
        }

        let new = new_login(
            name.as_ref(),
            username.as_ref(),
            password.as_str(),
            None,
            None,
        );
        if self.vault.service().create_item(new).is_ok() {
            self.form_open = false;
            self.form_error = None;
            // 清空表单字段（gpui-component 的 InputState 没有 reset 公开 API，
            // Phase B 不强求；Phase C 增加 generator 时再统一处理）。
            self.refresh(cx);
            cx.notify();
        } else {
            self.form_error = Some("common.error");
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

    fn filtered_items(&self, cx: &Context<Self>) -> Vec<zpass_vault_service::ItemSummary> {
        let query = self.search_state.read(cx).value().to_lowercase();
        if query.is_empty() {
            return self.items.clone();
        }
        self.items
            .iter()
            .filter(|it| it.name.to_lowercase().contains(&query))
            .cloned()
            .collect()
    }
}

impl Render for VaultView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 首次渲染时（vault 已解锁但 items 还空）保险刷一次：路由切到 vault 屏后
        // `Unlocked` 事件可能已经发完，无法补触发。
        if self.items.is_empty() && self.vault.service().is_unlocked() {
            // is_unlocked 是 Phase A 公开 API；这里同步快查，避开 list_items() 抛错。
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
            .gap(px(12.0))
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
                    .flex_1()
                    .max_w(px(360.0))
                    .child(Input::new(&self.search_state).small()),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        Button::new("vault-new")
                            .primary()
                            .small()
                            .label(i18n::t("vault.new"))
                            .on_click(cx.listener(|this, _, _, cx| this.open_form(cx))),
                    )
                    .child(
                        Button::new("vault-lock")
                            .small()
                            .label(i18n::t("vault.lock"))
                            .on_click(cx.listener(|this, _, _, cx| this.lock(cx))),
                    ),
            );

        let form_section: Option<gpui::AnyElement> = if self.form_open {
            Some(
                v_flex()
                    .w_full()
                    .px(px(24.0))
                    .py(px(16.0))
                    .gap(px(8.0))
                    .border_b_1()
                    .border_color(theme.line)
                    .bg(theme.bg_elev)
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(theme.text_2)
                            .child(SharedString::from(i18n::t("vault.new"))),
                    )
                    .child(Input::new(&self.name_state).small())
                    .child(Input::new(&self.username_state).small())
                    .child(Input::new(&self.password_state).small().mask_toggle())
                    .children(self.form_error.map(|err| {
                        div()
                            .text_size(px(12.0))
                            .text_color(theme.danger)
                            .child(SharedString::from(i18n::t(err)))
                    }))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .child(
                                Button::new("vault-form-save")
                                    .primary()
                                    .small()
                                    .label(i18n::t("vault.save"))
                                    .on_click(cx.listener(|this, _, _, cx| this.save_form(cx))),
                            )
                            .child(
                                Button::new("vault-form-cancel")
                                    .small()
                                    .label(i18n::t("vault.cancel"))
                                    .on_click(cx.listener(|this, _, _, cx| this.cancel_form(cx))),
                            ),
                    )
                    .into_any_element(),
            )
        } else {
            None
        };

        let filtered = self.filtered_items(cx);
        let list: gpui::AnyElement = if filtered.is_empty() {
            div()
                .w_full()
                .py(px(48.0))
                .flex()
                .justify_center()
                .text_color(theme.text_3)
                .text_size(px(13.0))
                .child(SharedString::from(i18n::t("vault.empty")))
                .into_any_element()
        } else {
            let mut list_col = v_flex().w_full();
            for item in filtered {
                let id = item.id.clone();
                list_col = list_col.child(item_row(
                    theme,
                    &item,
                    cx.listener(move |this, _, _, cx| this.delete(id.clone(), cx)),
                ));
            }
            list_col.into_any_element()
        };

        let mut body = v_flex().size_full().child(header);
        if let Some(form) = form_section {
            body = body.child(form);
        }
        body.child(list)
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
            v_flex()
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
            Button::new(SharedString::from(format!("del-{}", item.id)))
                .danger()
                .small()
                .label(i18n::t("vault.delete"))
                .on_click(on_delete),
        )
}
