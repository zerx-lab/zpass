//! Frameless 风格的标题栏（spec/11 § 7）。
//!
//! Phase B：app 标题 + 主题切换按钮（dark <-> light）。
//! 真正的拖拽区与窗口控制按钮在 Phase G 接入 gpui-component 的 `TitleBar`。

use gpui::{IntoElement, ParentElement, SharedString, Styled, div, px};
use gpui_component::{Sizable as _, button::Button};

use crate::app::toggle_theme;
use crate::i18n;
use crate::theme::Theme;

pub fn titlebar(theme: Theme) -> impl IntoElement {
    div()
        .h(px(40.0))
        .w_full()
        .flex()
        .items_center()
        .justify_between()
        .px(px(16.0))
        .border_b_1()
        .border_color(theme.line)
        .bg(theme.bg_elev)
        .child(
            div()
                .text_size(px(13.0))
                .text_color(theme.text_2)
                .child(SharedString::from(i18n::t("app.title"))),
        )
        .child(
            Button::new("titlebar-theme-toggle")
                .small()
                .label("◐")
                .on_click(|_, _, cx| toggle_theme(cx)),
        )
}
