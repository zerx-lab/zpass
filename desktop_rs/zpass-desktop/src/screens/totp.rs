//! TOTP 聚合屏（spec/11 § 5 + design/src/detail.jsx Totp 区）。
//!
//! 展示 vault 中所有 TOTP 类型条目 + 拥有 totp 字段的 login 条目。
//! 每条显示当前 code + 剩余秒数（独立 1s 定时器，per planner finding #10）。
//!
//! 计算：纯 `read_otp_meta` + `zpass_otp::totp`，不调 vault advance（HOTP 路径
//! 不在本屏，留到详情页主动按钮触发；TOTP 是无副作用的）。

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{
    Context, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div,
    px,
};
use gpui_component::{Sizable as _, button::Button, v_flex};
use zpass_otp::{OtpInput, OtpType, steam_guard, totp};
use zpass_vault_format::ItemType;

use crate::app::AppState;
use crate::i18n;
use crate::services::clipboard::copy_text;
use crate::services::otp::{OtpMeta, read_otp_meta};
use crate::services::vault::{VaultHandle, VaultUiEvent};
use crate::theme::Theme;

/// 一条 TOTP 行的展示信息。
#[derive(Debug, Clone)]
struct TotpEntry {
    name: String,
    item_id: String,
    code: String,
    remaining: u32,
    period: u32,
}

pub struct TotpView {
    vault: Arc<VaultHandle>,
    entries: Vec<TotpEntry>,
    /// 启动 timer 用：tick 一次重算所有 code + remaining。
    _subscriptions: Vec<Subscription>,
}

impl TotpView {
    pub fn new(cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        // 订阅 vault 事件：解锁 / 新建 / 删除 / 更新 都触发列表重新计算。
        let subject = vault.gpui_subject(cx);
        let sub_vault = cx.subscribe(&subject, {
            move |this: &mut Self, _, ev: &VaultUiEvent, cx| match ev {
                VaultUiEvent::Unlocked
                | VaultUiEvent::ItemCreated { .. }
                | VaultUiEvent::ItemDeleted { .. }
                | VaultUiEvent::ItemUpdated { .. } => {
                    this.recompute(cx);
                    cx.notify();
                }
                VaultUiEvent::Locked => {
                    this.entries.clear();
                    cx.notify();
                }
                _ => {}
            }
        });

        // 独立 1s 定时器：每秒重算 code 与 remaining 并 notify。
        // 注意（spec/11 § 8 + planner finding #10）：这是 TotpView 自己的
        // tick，**不**借用 vault 事件桥的 16ms 轮询。
        cx.spawn(async move |this, async_cx| {
            loop {
                async_cx
                    .background_executor()
                    .timer(Duration::from_secs(1))
                    .await;
                // this 是 WeakEntity<Self>；update 失败时 window 已关闭，安全退出 loop。
                if this
                    .update(async_cx, |v, cx| {
                        v.recompute(cx);
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();

        let mut me = Self {
            vault,
            entries: Vec::new(),
            _subscriptions: vec![sub_vault],
        };
        me.recompute(cx);
        me
    }

    /// 重新读取所有 TOTP 条目并算出当前 code。
    fn recompute(&mut self, cx: &mut Context<Self>) {
        let _ = cx; // notify 在调用方
        let svc = self.vault.service();
        let summaries = match svc.list_items() {
            Ok(s) => s,
            Err(_) => {
                self.entries.clear();
                return;
            }
        };
        let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs(),
            Err(_) => 0,
        };
        let mut out = Vec::new();
        for s in summaries {
            // 收录条件：type=totp 或 login.has_totp
            let include = matches!(s.r#type, ItemType::Totp) || s.has_totp;
            if !include {
                continue;
            }
            let Ok(payload) = svc.get_item(&s.id) else {
                continue;
            };
            let Ok(meta) = read_otp_meta(&payload) else {
                continue;
            };
            if let Some(entry) = compute_entry(&meta, &s.id, &s.name, now) {
                out.push(entry);
            }
        }
        self.entries = out;
    }
}

fn compute_entry(meta: &OtpMeta, item_id: &str, name: &str, now: u64) -> Option<TotpEntry> {
    match meta.otp_type {
        OtpType::Totp => {
            let code = totp(
                &OtpInput {
                    secret_base32: &meta.secret,
                    algorithm: meta.algorithm,
                    digits: meta.digits,
                    period_sec: meta.period,
                    counter: None,
                },
                now,
            )
            .ok()?;
            Some(TotpEntry {
                name: name.into(),
                item_id: item_id.into(),
                code: code.code,
                remaining: code.remaining,
                period: code.period,
            })
        }
        OtpType::Steam => {
            let code = steam_guard(&meta.secret, now).ok()?;
            Some(TotpEntry {
                name: name.into(),
                item_id: item_id.into(),
                code: code.code,
                remaining: code.remaining,
                period: code.period,
            })
        }
        // HOTP 不在本屏聚合（需要按钮显式 advance；留给 detail pane）。
        OtpType::Hotp => None,
    }
}

impl Render for TotpView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;

        let mut col = v_flex().size_full().p(px(32.0)).gap(px(16.0));

        col = col.child(
            div()
                .text_size(px(24.0))
                .text_color(theme.text)
                .child(SharedString::from(i18n::t("totp.title"))),
        );
        col = col.child(
            div()
                .text_size(px(13.0))
                .text_color(theme.text_3)
                .child(SharedString::from(i18n::t("totp.subtitle"))),
        );

        if self.entries.is_empty() {
            col = col.child(
                div()
                    .py(px(48.0))
                    .flex()
                    .justify_center()
                    .text_color(theme.text_3)
                    .text_size(px(13.0))
                    .child(SharedString::from(i18n::t("totp.empty"))),
            );
        } else {
            for e in &self.entries {
                col = col.child(entry_row(theme, e, cx));
            }
        }
        col
    }
}

fn entry_row(theme: Theme, e: &TotpEntry, cx: &mut Context<TotpView>) -> impl IntoElement {
    let code_for_copy = e.code.clone();
    let copy_id: SharedString = format!("totp-copy-{}", e.item_id).into();
    // 6 位 code 中间留一个空格视觉对齐 design/src/detail.jsx 的 Totp 区
    let code_display: SharedString = if e.code.len() == 6 {
        format!("{} {}", &e.code[..3], &e.code[3..]).into()
    } else {
        e.code.clone().into()
    };
    div()
        .w_full()
        .py(px(14.0))
        .px(px(16.0))
        .flex()
        .items_center()
        .gap(px(16.0))
        .border_b_1()
        .border_color(theme.line_soft)
        .bg(theme.bg_elev)
        .rounded(px(10.0))
        .child(
            v_flex()
                .flex_1()
                .gap(px(2.0))
                .child(
                    div()
                        .text_size(px(13.0))
                        .text_color(theme.text)
                        .child(SharedString::from(e.name.clone())),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.text_3)
                        .font_family(crate::theme::tokens::fonts::MONO)
                        .child(SharedString::from(format!("TOTP · {}s", e.period))),
                ),
        )
        .child(
            div()
                .text_size(px(24.0))
                .text_color(theme.text)
                .font_family(crate::theme::tokens::fonts::MONO)
                .child(code_display),
        )
        .child(
            div()
                .min_w(px(48.0))
                .text_size(px(12.0))
                .text_color(theme.text_3)
                .font_family(crate::theme::tokens::fonts::MONO)
                .child(SharedString::from(format!("{}s", e.remaining))),
        )
        .child(
            Button::new(copy_id)
                .small()
                .label(i18n::t("vault.detail.copy"))
                .on_click(cx.listener(move |_this, _ev, _w, _cx| {
                    let _ = copy_text(&code_for_copy);
                })),
        )
}
