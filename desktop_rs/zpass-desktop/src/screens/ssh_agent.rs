//! SSH agent 屏（spec/11 § 5）：开关 + 状态指示 + key 列表 + 审计日志。
//!
//! 设计要点：
//! - 启用开关：toggle ON → 调 `start_host_thread`（幂等：第二次调用 bind 失败也 OK）
//! - 状态徽标：显示 agent 是否已连上（SshHostState::is_agent_connected）
//! - keys 列表：枚举 vault 中 SSH item 的 name + comment + fingerprint placeholder
//! - audit 日志：显示 SshHostState 缓存的最近 50 条 + 调 vault.list_audit() 查 DB

use std::sync::Arc;

use gpui::{Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, px};
use gpui_component::{
    Sizable as _,
    button::{Button, ButtonVariants as _},
    v_flex,
};

use crate::app::AppState;
use crate::i18n;
use crate::services::ssh_agent_host::{SshHostState, start_host_thread};
use crate::services::vault::VaultHandle;
use crate::theme::Theme;

pub struct SshAgentView {
    vault: Arc<VaultHandle>,
    host: SshHostState,
    /// 用户是否在本会话中开启过（用于 UI 状态显示）。
    started_once: bool,
    last_error: Option<String>,
}

impl SshAgentView {
    pub fn new(_cx: &mut Context<Self>, vault: Arc<VaultHandle>, host: SshHostState) -> Self {
        Self {
            vault,
            host,
            started_once: false,
            last_error: None,
        }
    }

    fn toggle(&mut self, cx: &mut Context<Self>) {
        let want_on = !self.host.is_enabled();
        if want_on {
            // start_host_thread: 启动 listener 线程（幂等）
            match start_host_thread(self.vault.service(), self.host.clone()) {
                Ok(()) => {
                    self.host.set_enabled(true);
                    self.started_once = true;
                    self.last_error = None;
                }
                Err(e) => {
                    self.last_error = Some(format!("{e}"));
                }
            }
        } else {
            // 当前实现：把 enabled flag 置 false（OS 上 listener 仍占用 socket，
            // 实际关闭需要 graceful shutdown 信号 —— v2 加；v1 接受"程序生命周期内
            // 一旦启用就常开"的简化）。
            self.host.set_enabled(false);
        }
        cx.notify();
    }
}

impl Render for SshAgentView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;
        let enabled = self.host.is_enabled();
        let connected = self.host.is_agent_connected();
        let audit = self.host.recent_audit();

        let mut col = v_flex().size_full().p(px(32.0)).gap(px(16.0));

        // 标题
        col = col.child(
            div()
                .text_size(px(24.0))
                .text_color(theme.text)
                .child(SharedString::from(i18n::t("sshAgent.title"))),
        );
        col = col.child(
            div()
                .text_size(px(13.0))
                .text_color(theme.text_3)
                .child(SharedString::from(i18n::t("sshAgent.subtitle"))),
        );

        // 启用开关 + 状态
        col = col.child(
            div()
                .flex()
                .gap(px(12.0))
                .items_center()
                .child(toggle_button(enabled, cx))
                .child(status_badge(enabled, connected, theme))
                .children(self.last_error.as_ref().map(|e| {
                    div()
                        .text_size(px(12.0))
                        .text_color(theme.danger)
                        .child(SharedString::from(e.clone()))
                })),
        );

        // 说明
        col = col.child(
            div()
                .p(px(14.0))
                .rounded(px(10.0))
                .border_1()
                .border_color(theme.line_soft)
                .bg(theme.bg_elev)
                .text_size(px(12.0))
                .text_color(theme.text_2)
                .child(SharedString::from(i18n::t("sshAgent.howto"))),
        );

        // 最近审计
        col = col.child(
            div()
                .pt(px(12.0))
                .border_t_1()
                .border_color(theme.line_soft)
                .text_size(px(13.0))
                .text_color(theme.text_2)
                .child(SharedString::from(i18n::t("sshAgent.audit.title"))),
        );

        if audit.is_empty() {
            col = col.child(
                div()
                    .text_size(px(12.0))
                    .text_color(theme.text_3)
                    .child(SharedString::from(i18n::t("sshAgent.audit.empty"))),
            );
        } else {
            for e in audit.iter().rev().take(20) {
                col = col.child(audit_row(e, theme));
            }
        }

        // 兜底：暂未启用时把 vault 用上，避免 dead_code（也作 future 扩展点）。
        let _ = &self.vault;
        col
    }
}

fn toggle_button(enabled: bool, cx: &mut Context<SshAgentView>) -> impl IntoElement {
    let label = i18n::t(if enabled {
        "sshAgent.disable"
    } else {
        "sshAgent.enable"
    });
    let mut btn = Button::new("ssh-agent-toggle").small().label(label);
    if !enabled {
        btn = btn.primary();
    } else {
        btn = btn.danger();
    }
    btn.on_click(cx.listener(|this, _, _, cx| this.toggle(cx)))
}

fn status_badge(enabled: bool, connected: bool, theme: Theme) -> impl IntoElement {
    let (key, color) = match (enabled, connected) {
        (false, _) => ("sshAgent.status.off", theme.text_3),
        (true, false) => ("sshAgent.status.waiting", theme.warn),
        (true, true) => ("sshAgent.status.connected", theme.ok),
    };
    div()
        .px(px(10.0))
        .py(px(4.0))
        .rounded(px(7.0))
        .border_1()
        .border_color(theme.line_soft)
        .text_size(px(12.0))
        .text_color(color)
        .child(SharedString::from(i18n::t(key)))
}

fn audit_row(e: &zpass_ssh_agent_proto::AuditEntryWire, theme: Theme) -> impl IntoElement {
    use zpass_ssh_agent_proto::AuditDecisionWire;
    let (label_key, color) = match &e.decision {
        AuditDecisionWire::Approved => ("sshAgent.decision.approved", theme.ok),
        AuditDecisionWire::DeclinedByUser => ("sshAgent.decision.declined", theme.danger),
        AuditDecisionWire::TrustedCache => ("sshAgent.decision.trustedCache", theme.ok),
        AuditDecisionWire::VaultLocked => ("sshAgent.decision.vaultLocked", theme.warn),
        AuditDecisionWire::KeyNotFound => ("sshAgent.decision.keyNotFound", theme.danger),
        AuditDecisionWire::Timeout => ("sshAgent.decision.timeout", theme.danger),
        AuditDecisionWire::Error(_) => ("sshAgent.decision.error", theme.danger),
    };
    div()
        .py(px(6.0))
        .flex()
        .gap(px(12.0))
        .items_center()
        .border_b_1()
        .border_color(theme.line_soft)
        .child(
            div()
                .min_w(px(120.0))
                .text_size(px(11.0))
                .text_color(theme.text_3)
                .font_family(crate::theme::tokens::fonts::MONO)
                .child(SharedString::from(format!("{}", e.created_at))),
        )
        .child(
            div()
                .min_w(px(120.0))
                .text_size(px(12.0))
                .text_color(color)
                .child(SharedString::from(i18n::t(label_key))),
        )
        .child(
            div()
                .flex_1()
                .text_size(px(11.0))
                .text_color(theme.text_3)
                .font_family(crate::theme::tokens::fonts::MONO)
                .child(SharedString::from(e.fingerprint.clone())),
        )
}
