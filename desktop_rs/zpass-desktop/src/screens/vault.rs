//! Vault 屏：list + detail 两 pane（spec/11 § 5 + design/src/vault.jsx + detail.jsx）。
//!
//! Phase C C5 范围：
//! - filter chips（all / login / card / note / identity / ssh / totp / passkey）
//! - 左侧 list pane：按 chip + 搜索框过滤
//! - 右侧 detail pane：选中条目的类型化只读视图（密码 mask toggle + 复制按钮）
//! - 「新建 login」内嵌表单保留（Phase B 兼容）
//! - 删除按钮移到 detail pane 操作区
//!
//! 字段编辑（modal）属于"全功能"路径，留待后续迭代；当前先让所有类型 **可见**。

use std::sync::Arc;

use gpui::{
    AnyElement, ClickEvent, Context, Entity, IntoElement, ParentElement, Render, SharedString,
    Styled, Subscription, Window, div, prelude::*, px,
};
use gpui_component::{
    Sizable as _,
    button::{Button, ButtonVariants as _},
    input::{Input, InputEvent, InputState},
    v_flex,
};
use zpass_vault_format::{FieldValue, ItemPayloadV1, ItemType};

use crate::app::{AppState, RouteIntent, dispatch};
use crate::i18n;
use crate::services::clipboard::copy_text;
use crate::services::vault::{VaultHandle, VaultUiEvent, new_login};
use crate::theme::Theme;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeFilter {
    All,
    Login,
    Card,
    Note,
    Identity,
    Ssh,
    Totp,
    Passkey,
}

impl TypeFilter {
    fn matches(self, t: &ItemType) -> bool {
        match self {
            TypeFilter::All => true,
            TypeFilter::Login => *t == ItemType::Login,
            TypeFilter::Card => *t == ItemType::Card,
            TypeFilter::Note => *t == ItemType::Note,
            TypeFilter::Identity => *t == ItemType::Identity,
            TypeFilter::Ssh => *t == ItemType::Ssh,
            TypeFilter::Totp => *t == ItemType::Totp,
            TypeFilter::Passkey => *t == ItemType::Passkey,
        }
    }
    fn label_key(self) -> &'static str {
        match self {
            TypeFilter::All => "vault.filter.all",
            TypeFilter::Login => "vault.filter.login",
            TypeFilter::Card => "vault.filter.card",
            TypeFilter::Note => "vault.filter.note",
            TypeFilter::Identity => "vault.filter.identity",
            TypeFilter::Ssh => "vault.filter.ssh",
            TypeFilter::Totp => "vault.filter.totp",
            TypeFilter::Passkey => "vault.filter.passkey",
        }
    }
}

const FILTERS: &[TypeFilter] = &[
    TypeFilter::All,
    TypeFilter::Login,
    TypeFilter::Card,
    TypeFilter::Note,
    TypeFilter::Identity,
    TypeFilter::Ssh,
    TypeFilter::Totp,
    TypeFilter::Passkey,
];

pub struct VaultView {
    vault: Arc<VaultHandle>,
    pub(super) items: Vec<zpass_vault_service::ItemSummary>,
    pub(super) search_state: Entity<InputState>,
    pub(super) form_open: bool,
    pub(super) name_state: Entity<InputState>,
    pub(super) username_state: Entity<InputState>,
    pub(super) password_state: Entity<InputState>,
    pub(super) form_error: Option<&'static str>,
    pub(super) selected_id: Option<String>,
    pub(super) filter: TypeFilter,
    pub(super) reveal_password: bool,
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
                    this.selected_id = None;
                    dispatch(cx, RouteIntent::GoUnlock);
                }
                _ => {}
            }
        });
        let sub_search = cx.subscribe_in(&search_state, window, {
            move |_this: &mut Self, _, ev: &InputEvent, _window, cx| {
                if matches!(ev, InputEvent::Change) {
                    cx.notify();
                }
            }
        });

        Self {
            vault,
            items: Vec::new(),
            search_state,
            form_open: false,
            name_state,
            username_state,
            password_state,
            form_error: None,
            selected_id: None,
            filter: TypeFilter::All,
            reveal_password: false,
            _subscriptions: vec![sub_vault, sub_search],
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        match self.vault.service().list_items() {
            Ok(items) => {
                self.items = items;
                if let Some(id) = &self.selected_id
                    && !self.items.iter().any(|it| &it.id == id)
                {
                    self.selected_id = None;
                }
            }
            Err(_) => {
                self.items.clear();
                self.selected_id = None;
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

    pub(super) fn save_form(&mut self, cx: &mut Context<Self>) {
        let name = self.name_state.read(cx).value().clone();
        let username = self.username_state.read(cx).value().clone();
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
            self.refresh(cx);
            cx.notify();
        } else {
            self.form_error = Some("common.error");
            cx.notify();
        }
    }

    fn delete_selected(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.selected_id.clone() {
            let _ = self.vault.service().delete_item(&id);
            self.selected_id = None;
            self.refresh(cx);
            cx.notify();
        }
    }

    fn lock(&mut self, cx: &mut Context<Self>) {
        dispatch(cx, RouteIntent::LockVault);
    }

    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected_id = Some(id);
        self.reveal_password = false;
        cx.notify();
    }

    fn set_filter(&mut self, f: TypeFilter, cx: &mut Context<Self>) {
        self.filter = f;
        cx.notify();
    }

    fn toggle_reveal(&mut self, cx: &mut Context<Self>) {
        self.reveal_password = !self.reveal_password;
        cx.notify();
    }

    fn filtered_items(&self, cx: &Context<Self>) -> Vec<zpass_vault_service::ItemSummary> {
        let query = self.search_state.read(cx).value().to_lowercase();
        self.items
            .iter()
            .filter(|it| self.filter.matches(&it.r#type))
            .filter(|it| query.is_empty() || it.name.to_lowercase().contains(&query))
            .cloned()
            .collect()
    }

    fn selected_payload(&self) -> Option<ItemPayloadV1> {
        let id = self.selected_id.as_ref()?;
        self.vault.service().get_item(id).ok()
    }
}

impl Render for VaultView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.items.is_empty() && self.vault.service().is_unlocked() {
            self.refresh(cx);
        }
        let theme = cx.global::<AppState>().theme;

        // 头部 + filter bar + 可选 form + (list + detail) 两 pane。
        let header = build_header(self, theme, cx);
        let filter_bar = build_filter_bar(self.filter, theme, cx);
        let form_section = if self.form_open {
            Some(build_new_login_form(self, theme, cx))
        } else {
            None
        };
        let filtered = self.filtered_items(cx);
        let list_pane = build_list_pane(self, &filtered, theme, cx);
        let detail_pane = build_detail_pane(self, theme, cx);

        let panes_row = div()
            .flex()
            .flex_row()
            .flex_1()
            .min_h(px(0.0))
            .child(list_pane)
            .child(detail_pane);

        let mut body = v_flex().size_full().child(header).child(filter_bar);
        if let Some(form) = form_section {
            body = body.child(form);
        }
        body.child(panes_row)
    }
}

fn build_header(view: &VaultView, theme: Theme, cx: &mut Context<VaultView>) -> AnyElement {
    div()
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
                .child(Input::new(&view.search_state).small()),
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
        )
        .into_any_element()
}

fn build_filter_bar(current: TypeFilter, theme: Theme, cx: &mut Context<VaultView>) -> AnyElement {
    let mut row = div()
        .w_full()
        .px(px(24.0))
        .py(px(10.0))
        .border_b_1()
        .border_color(theme.line_soft)
        .flex()
        .flex_row()
        .gap(px(8.0));
    for f in FILTERS {
        let f = *f;
        let active = current == f;
        let (bg, fg) = if active {
            (theme.bg_active, theme.text)
        } else {
            (theme.bg_elev, theme.text_2)
        };
        let id: SharedString = format!("chip-{f:?}").into();
        row = row.child(
            div()
                .id(id)
                .px(px(10.0))
                .py(px(4.0))
                .rounded(px(7.0))
                .border_1()
                .border_color(theme.line_soft)
                .bg(bg)
                .text_color(fg)
                .text_size(px(12.0))
                .cursor_pointer()
                .hover(|s| s.bg(theme.bg_hover))
                .child(SharedString::from(i18n::t(f.label_key())))
                .on_click(cx.listener(move |this, _, _, cx| this.set_filter(f, cx))),
        );
    }
    row.into_any_element()
}

fn build_new_login_form(view: &VaultView, theme: Theme, cx: &mut Context<VaultView>) -> AnyElement {
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
        .child(Input::new(&view.name_state).small())
        .child(Input::new(&view.username_state).small())
        .child(Input::new(&view.password_state).small().mask_toggle())
        .children(view.form_error.map(|err| {
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
        .into_any_element()
}

fn build_list_pane(
    view: &VaultView,
    items: &[zpass_vault_service::ItemSummary],
    theme: Theme,
    cx: &mut Context<VaultView>,
) -> AnyElement {
    let mut col = v_flex()
        .w(px(360.0))
        .h_full()
        .border_r_1()
        .border_color(theme.line);
    if items.is_empty() {
        col = col.child(
            div()
                .w_full()
                .py(px(48.0))
                .flex()
                .justify_center()
                .text_color(theme.text_3)
                .text_size(px(13.0))
                .child(SharedString::from(i18n::t("vault.empty"))),
        );
    } else {
        for item in items {
            col = col.child(item_row(view, item, theme, cx));
        }
    }
    col.into_any_element()
}

fn item_row(
    view: &VaultView,
    item: &zpass_vault_service::ItemSummary,
    theme: Theme,
    cx: &mut Context<VaultView>,
) -> AnyElement {
    let id = item.id.clone();
    let is_active = view.selected_id.as_deref() == Some(id.as_str());
    let bg = if is_active { theme.bg_active } else { theme.bg };
    let row_id: SharedString = format!("row-{}", item.id).into();
    div()
        .id(row_id)
        .w_full()
        .px(px(24.0))
        .py(px(12.0))
        .flex()
        .items_center()
        .justify_between()
        .border_b_1()
        .border_color(theme.line_soft)
        .bg(bg)
        .cursor_pointer()
        .hover(|s| s.bg(theme.bg_hover))
        .on_click({
            let id = id.clone();
            cx.listener(move |this, _: &ClickEvent, _, cx| this.select(id.clone(), cx))
        })
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
                        .child(SharedString::from(type_label(&item.r#type))),
                ),
        )
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.text_3)
                .child(SharedString::from(if item.has_totp { "TOTP" } else { "" })),
        )
        .into_any_element()
}

fn type_label(t: &ItemType) -> &'static str {
    match t {
        ItemType::Login => "Login",
        ItemType::Card => "Card",
        ItemType::Note => "Note",
        ItemType::Identity => "Identity",
        ItemType::Ssh => "SSH",
        ItemType::Totp => "TOTP",
        ItemType::Passkey => "Passkey",
    }
}

fn build_detail_pane(view: &VaultView, theme: Theme, cx: &mut Context<VaultView>) -> AnyElement {
    let payload = view.selected_payload();
    let Some(payload) = payload else {
        return div()
            .flex_1()
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .text_color(theme.text_3)
            .text_size(px(13.0))
            .child(SharedString::from(i18n::t("vault.detail.empty")))
            .into_any_element();
    };

    let mut col = v_flex().flex_1().h_full().p(px(32.0)).gap(px(12.0));

    // 标题区
    col = col.child(
        div()
            .text_size(px(22.0))
            .text_color(theme.text)
            .child(SharedString::from(payload.name.clone())),
    );
    col = col.child(
        div()
            .text_size(px(12.0))
            .text_color(theme.text_3)
            .child(SharedString::from(format!(
                "{} · ID {}",
                type_label(&payload.r#type),
                &payload.id[..8.min(payload.id.len())]
            ))),
    );

    // 字段
    let field_rows = build_field_rows(&payload, view.reveal_password, theme, cx);
    for row in field_rows {
        col = col.child(row);
    }

    // 操作区
    col = col.child(
        div()
            .pt(px(16.0))
            .mt(px(8.0))
            .border_t_1()
            .border_color(theme.line_soft)
            .flex()
            .gap(px(8.0))
            .child(
                Button::new("vault-detail-delete")
                    .danger()
                    .small()
                    .label(i18n::t("vault.delete"))
                    .on_click(cx.listener(|this, _, _, cx| this.delete_selected(cx))),
            ),
    );

    col.into_any_element()
}

fn build_field_rows(
    p: &ItemPayloadV1,
    revealed: bool,
    theme: Theme,
    cx: &mut Context<VaultView>,
) -> Vec<AnyElement> {
    match p.r#type {
        ItemType::Login => login_rows(p, revealed, theme, cx),
        ItemType::Card => card_rows(p, theme, cx),
        ItemType::Note => note_rows(p, theme, cx),
        ItemType::Identity => identity_rows(p, theme, cx),
        ItemType::Ssh => ssh_rows(p, theme, cx),
        ItemType::Totp => totp_rows(p, theme, cx),
        ItemType::Passkey => passkey_rows(p, theme),
    }
}

fn s_field(p: &ItemPayloadV1, key: &str) -> Option<String> {
    match p.fields.get(key) {
        Some(FieldValue::Text(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// 普通字段行（label + value + copy 按钮）。
fn plain_row(
    label: &str,
    value: &str,
    mono: bool,
    theme: Theme,
    cx: &mut Context<VaultView>,
) -> AnyElement {
    let value_for_copy = value.to_string();
    let copy_id: SharedString = format!("copy-{label}").into();
    let mut val = div().flex_1().text_size(px(13.0)).text_color(theme.text);
    if mono {
        val = val.font_family(crate::theme::tokens::fonts::MONO);
    }
    val = val.child(SharedString::from(value.to_string()));
    div()
        .w_full()
        .py(px(8.0))
        .flex()
        .items_center()
        .gap(px(12.0))
        .border_b_1()
        .border_color(theme.line_soft)
        .child(
            div()
                .w(px(140.0))
                .text_size(px(12.0))
                .text_color(theme.text_3)
                .child(SharedString::from(label.to_string())),
        )
        .child(val)
        .child(
            Button::new(copy_id)
                .small()
                .label(i18n::t("vault.detail.copy"))
                .on_click(cx.listener(move |_this, _ev, _w, _cx| {
                    let _ = copy_text(&value_for_copy);
                })),
        )
        .into_any_element()
}

/// Masked 字段行：可点击眼睛 toggle reveal_password。
fn masked_row(
    label: &str,
    value: &str,
    revealed: bool,
    mono: bool,
    theme: Theme,
    cx: &mut Context<VaultView>,
) -> AnyElement {
    let display: SharedString = if revealed {
        SharedString::from(value.to_string())
    } else {
        SharedString::from("•".repeat(value.chars().count().clamp(8, 20)))
    };
    let mut val = div().flex_1().text_size(px(13.0)).text_color(theme.text);
    if mono {
        val = val.font_family(crate::theme::tokens::fonts::MONO);
    }
    val = val.child(display);
    let value_for_copy = value.to_string();
    let copy_id: SharedString = format!("copy-{label}").into();
    let eye_id: SharedString = format!("eye-{label}").into();
    let eye_label = i18n::t(if revealed {
        "vault.detail.hide"
    } else {
        "vault.detail.show"
    });
    div()
        .w_full()
        .py(px(8.0))
        .flex()
        .items_center()
        .gap(px(12.0))
        .border_b_1()
        .border_color(theme.line_soft)
        .child(
            div()
                .w(px(140.0))
                .text_size(px(12.0))
                .text_color(theme.text_3)
                .child(SharedString::from(label.to_string())),
        )
        .child(val)
        .child(
            Button::new(eye_id)
                .small()
                .label(eye_label)
                .on_click(cx.listener(|this, _, _, cx| this.toggle_reveal(cx))),
        )
        .child(
            Button::new(copy_id)
                .small()
                .label(i18n::t("vault.detail.copy"))
                .on_click(cx.listener(move |_this, _ev, _w, _cx| {
                    let _ = copy_text(&value_for_copy);
                })),
        )
        .into_any_element()
}

fn login_rows(
    p: &ItemPayloadV1,
    revealed: bool,
    theme: Theme,
    cx: &mut Context<VaultView>,
) -> Vec<AnyElement> {
    let mut out = Vec::new();
    if let Some(v) = s_field(p, "username") {
        out.push(plain_row(
            i18n::t("vault.item.username"),
            &v,
            true,
            theme,
            cx,
        ));
    }
    if let Some(v) = s_field(p, "password") {
        out.push(masked_row(
            i18n::t("vault.item.password"),
            &v,
            revealed,
            true,
            theme,
            cx,
        ));
    }
    if let Some(v) = s_field(p, "url") {
        out.push(plain_row(i18n::t("vault.item.url"), &v, false, theme, cx));
    }
    if let Some(v) = s_field(p, "notes") {
        out.push(plain_row(i18n::t("vault.item.notes"), &v, false, theme, cx));
    }
    if let Some(v) = s_field(p, "totp") {
        out.push(masked_row("TOTP secret", &v, revealed, true, theme, cx));
    }
    out
}

fn card_rows(p: &ItemPayloadV1, theme: Theme, cx: &mut Context<VaultView>) -> Vec<AnyElement> {
    let mut out = Vec::new();
    for (key, label, masked, mono) in [
        ("holder", "Card holder", false, false),
        ("number", "Card number", false, true),
        ("expiry_month", "Expiry month", false, true),
        ("expiry_year", "Expiry year", false, true),
        ("cvv", "CVV", true, true),
        ("notes", "Notes", false, false),
    ] {
        if let Some(v) = s_field(p, key) {
            if masked {
                out.push(masked_row(label, &v, false, mono, theme, cx));
            } else {
                out.push(plain_row(label, &v, mono, theme, cx));
            }
        }
    }
    out
}

fn note_rows(p: &ItemPayloadV1, theme: Theme, cx: &mut Context<VaultView>) -> Vec<AnyElement> {
    let mut out = Vec::new();
    if let Some(v) = s_field(p, "notes") {
        out.push(plain_row(i18n::t("vault.item.notes"), &v, false, theme, cx));
    }
    out
}

fn identity_rows(p: &ItemPayloadV1, theme: Theme, cx: &mut Context<VaultView>) -> Vec<AnyElement> {
    let mut out = Vec::new();
    for (key, label) in [
        ("first_name", "First name"),
        ("last_name", "Last name"),
        ("email", "Email"),
        ("phone", "Phone"),
        ("address", "Address"),
        ("notes", "Notes"),
    ] {
        if let Some(v) = s_field(p, key) {
            out.push(plain_row(label, &v, false, theme, cx));
        }
    }
    out
}

fn ssh_rows(p: &ItemPayloadV1, theme: Theme, cx: &mut Context<VaultView>) -> Vec<AnyElement> {
    let mut out = Vec::new();
    if let Some(v) = s_field(p, "public_key") {
        out.push(plain_row("Public key", &v, true, theme, cx));
    }
    if let Some(v) = s_field(p, "private_key") {
        out.push(masked_row("Private key", &v, false, true, theme, cx));
    }
    if let Some(v) = s_field(p, "passphrase") {
        out.push(masked_row("Passphrase", &v, false, true, theme, cx));
    }
    if let Some(v) = s_field(p, "notes") {
        out.push(plain_row("Notes", &v, false, theme, cx));
    }
    out
}

fn totp_rows(p: &ItemPayloadV1, theme: Theme, cx: &mut Context<VaultView>) -> Vec<AnyElement> {
    let mut out = Vec::new();
    if let Some(v) = s_field(p, "secret").or_else(|| s_field(p, "totp")) {
        out.push(masked_row("Secret", &v, false, true, theme, cx));
    }
    if let Some(v) = s_field(p, "issuer") {
        out.push(plain_row("Issuer", &v, false, theme, cx));
    }
    if let Some(v) = s_field(p, "account") {
        out.push(plain_row("Account", &v, false, theme, cx));
    }
    out
}

fn passkey_rows(p: &ItemPayloadV1, theme: Theme) -> Vec<AnyElement> {
    let rp_id = s_field(p, "rp_id").unwrap_or_default();
    let rp_name = s_field(p, "rp_name").unwrap_or_default();
    let user_name = s_field(p, "user_name").unwrap_or_default();
    let sign_count = match p.fields.get("sign_count") {
        Some(FieldValue::Number(n)) => *n,
        _ => 0,
    };
    let make_line = |s: String, mono: bool| {
        let mut d = div()
            .py(px(8.0))
            .text_color(theme.text_2)
            .text_size(px(13.0));
        if mono {
            d = d.font_family(crate::theme::tokens::fonts::MONO);
        }
        d.child(SharedString::from(s)).into_any_element()
    };
    vec![
        make_line(format!("Relying party: {} ({})", rp_name, rp_id), false),
        make_line(format!("User: {}", user_name), false),
        make_line(format!("sign_count: {}", sign_count), true),
    ]
}
