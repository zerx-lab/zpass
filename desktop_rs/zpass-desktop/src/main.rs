//! ZPass 桌面主程序入口。

use gpui_platform::application;

mod app;
mod i18n;
mod screens;
mod services;
mod theme;
mod widgets;

fn main() {
    application().run(|cx| {
        // 字体注册 (`cx.text_system().add_fonts(...)`) 留 Phase C，
        // 当前用 GPUI 默认 sans 字体族。
        app::launch(cx);
    });
}
