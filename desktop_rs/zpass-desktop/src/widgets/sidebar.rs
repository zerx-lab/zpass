//! 左侧导航 sidebar（spec/11 § 5 顶级屏幕集合）。
//!
//! 设计：纯路由触发，**通过 `RouteIntent` 投递**（Planner finding #13：与 Phase F 的
//! Cmd+K 共享同一导航层，不引入第二套路由）。
//!
//! 视觉对齐 design/src/app.css 的 `.sidebar`：固定宽 80 px、上下排列图标 + 标签。

use gpui::{
    App, ClickEvent, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::*, px,
};
use gpui_component::v_flex;

use crate::app::{RouteIntent, dispatch};
use crate::i18n;
use crate::theme::Theme;

/// sidebar 上的顶级目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavTarget {
    Vault,
    Totp,
    Generator,
    ImportExport,
    SshAgent,
}

impl NavTarget {
    fn label_key(&self) -> &'static str {
        match self {
            NavTarget::Vault => "nav.vault",
            NavTarget::Totp => "nav.totp",
            NavTarget::Generator => "nav.generator",
            NavTarget::ImportExport => "nav.importExport",
            NavTarget::SshAgent => "nav.sshAgent",
        }
    }
    /// 单字符 icon 占位（design/src 用 Lucide；此处暂用 Unicode 字符直到接入 svg）。
    fn icon(&self) -> &'static str {
        match self {
            NavTarget::Vault => "🔒",
            NavTarget::Totp => "⏱",
            NavTarget::Generator => "⚡",
            NavTarget::ImportExport => "↔",
            NavTarget::SshAgent => "🔑",
        }
    }
    pub fn intent(self) -> RouteIntent {
        match self {
            NavTarget::Vault => RouteIntent::GoVault,
            NavTarget::Totp => RouteIntent::GoTotp,
            NavTarget::Generator => RouteIntent::GoGenerator,
            NavTarget::ImportExport => RouteIntent::GoImportExport,
            NavTarget::SshAgent => RouteIntent::GoSshAgent,
        }
    }
}

const TARGETS: &[NavTarget] = &[
    NavTarget::Vault,
    NavTarget::Totp,
    NavTarget::Generator,
    NavTarget::ImportExport,
    NavTarget::SshAgent,
];

/// 渲染左侧 sidebar；`active` 是当前活动 target（用来高亮）。
pub fn sidebar(theme: Theme, active: Option<NavTarget>) -> impl IntoElement {
    let mut col = v_flex()
        .w(px(80.0))
        .h_full()
        .border_r_1()
        .border_color(theme.line)
        .bg(theme.bg_elev)
        .py(px(12.0))
        .gap(px(4.0));
    for t in TARGETS {
        col = col.child(item(theme, *t, active == Some(*t)));
    }
    col
}

fn item(theme: Theme, target: NavTarget, is_active: bool) -> impl IntoElement {
    let (bg, fg) = if is_active {
        (theme.bg_hover, theme.text)
    } else {
        (gpui::transparent_black(), theme.text_3)
    };
    let id = SharedString::from(format!("sidebar-{:?}", target));
    div()
        .id(id)
        .w_full()
        .py(px(10.0))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(2.0))
        .bg(bg)
        .text_color(fg)
        .cursor_pointer()
        .hover(|s| s.bg(theme.bg_hover))
        .on_click(move |_ev: &ClickEvent, _: &mut Window, cx: &mut App| {
            dispatch(cx, target.intent());
        })
        .child(
            div()
                .text_size(px(18.0))
                .child(SharedString::from(target.icon())),
        )
        .child(
            div()
                .text_size(px(10.0))
                .child(SharedString::from(i18n::t(target.label_key()))),
        )
}
