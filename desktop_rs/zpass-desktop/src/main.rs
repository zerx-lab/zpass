//! ZPass 桌面主程序入口。
//!
//! 启动流程：
//! 1. `gpui_platform::application().with_assets(Assets)` 注入 gpui-component 默认资源
//!    （icons / fonts），让 `Button`、`Input` 等组件能在 Phase B 直接渲染图标。
//! 2. `gpui_component::init(cx)` 必须在打开窗口前调用，初始化主题与全局配置。
//! 3. 顶层视图用 `Root::new(workspace, window, cx)` 包装，激活 notification layer。

use gpui_component_assets::Assets;

mod app;
mod i18n;
mod screens;
mod services;
mod theme;
mod widgets;

fn main() {
    let app = gpui_platform::application().with_assets(Assets);
    app.run(|cx| {
        gpui_component::init(cx);
        app::launch(cx);
    });
}
