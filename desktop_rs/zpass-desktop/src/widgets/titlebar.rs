//! Frameless 风格的标题栏（spec/11 § 7）。
//!
//! Phase B 仅做最小版本：左侧 app 标题，无窗口控制按钮。
//! 真正的拖拽区与按钮等待 Phase G。

use gpui::{IntoElement, ParentElement, SharedString, Styled, div, px};

use crate::i18n;
use crate::theme::Theme;

pub fn titlebar(theme: Theme) -> impl IntoElement {
    div()
        .h(px(40.0))
        .w_full()
        .flex()
        .items_center()
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
}
