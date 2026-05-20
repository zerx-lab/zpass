//! 全局 AppState 装配 + 主窗口创建 + 屏幕路由。
//!
//! 路由模型：屏幕通过 [`dispatch`] 投递 [`RouteIntent`] 到一个进程级 queue；
//! `WorkspaceView` 在每帧 render 前 drain queue 应用切屏。这避开了在 GPUI
//! 子组件中直接拿 root view 句柄的复杂 API（Phase B 简化）。

use std::sync::{Arc, Mutex, OnceLock};

use gpui::{
    App, AppContext, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled, Window,
    WindowBounds, WindowKind, WindowOptions, div, prelude::*, px,
};
use gpui_component::{ActiveTheme as _, Root, ThemeMode};

use crate::i18n;
use crate::screens::{
    GeneratorView, ImportExportView, OnboardingView, TotpView, UnlockView, VaultView, WelcomeView,
};
use crate::services::vault::{VaultHandle, open_default_vault};
use crate::theme::Theme;
use crate::widgets::sidebar::{NavTarget, sidebar};

/// 高层屏幕枚举。Phase C 终态 7 个屏（其中 3 个由 sidebar 触达）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Welcome,
    Onboarding,
    Unlock,
    Vault,
    Totp,
    Generator,
    ImportExport,
}

impl Screen {
    /// 是否为 sidebar 顶级屏（解锁后才可见）。
    pub fn is_top_level(&self) -> bool {
        matches!(
            self,
            Screen::Vault | Screen::Totp | Screen::Generator | Screen::ImportExport
        )
    }
}

/// 屏幕间的"切屏意图"。其它字段（如错误提示）通过 AppState 传。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteIntent {
    GoWelcome,
    GoOnboarding,
    GoUnlock,
    GoVault,
    GoTotp,
    GoGenerator,
    GoImportExport,
    /// 锁定 vault（vault 屏「锁定」按钮）。
    LockVault,
}

/// 全局只读上下文。修改通过 [`set_theme`] / Phase C 的 settings 屏。
///
/// `locale` 当前未用（i18n 通过模块内静态 `CURRENT` 路由）；Phase C 接入 settings
/// 切换语言时会读它，留作位 placeholder。
#[allow(dead_code)]
pub struct AppState {
    pub vault: Arc<VaultHandle>,
    pub locale: i18n::Locale,
    pub theme: Theme,
}

impl gpui::Global for AppState {}

/// 切换主题。`mode` 为 None 则在 dark / light 之间切换。
///
/// 同时联动 gpui-component 的 ActiveTheme（让 Input/Button 等组件的颜色跟随）。
pub fn set_theme(cx: &mut App, mode: ThemeMode) {
    let new_theme = if mode == ThemeMode::Light {
        Theme::light()
    } else {
        Theme::dark()
    };
    cx.update_global::<AppState, _>(|state, _| {
        state.theme = new_theme;
    });
    // gpui-component 的 Theme 也同步切换，让 Input/Button 跟随。
    gpui_component::Theme::change(mode, None, cx);
    cx.refresh_windows();
}

/// 切换到下一个主题（dark <-> light）。供 titlebar 按钮使用。
pub fn toggle_theme(cx: &mut App) {
    let current_mode = gpui_component::Theme::global(cx).mode;
    let next = if current_mode == ThemeMode::Light {
        ThemeMode::Dark
    } else {
        ThemeMode::Light
    };
    set_theme(cx, next);
}

/// 路由队列。
fn route_queue() -> &'static Mutex<Vec<RouteIntent>> {
    static Q: OnceLock<Mutex<Vec<RouteIntent>>> = OnceLock::new();
    Q.get_or_init(|| Mutex::new(Vec::new()))
}

/// 子屏调用以投递切屏意图。`WorkspaceView` 在每帧 render 前 drain。
pub fn dispatch(cx: &mut App, intent: RouteIntent) {
    route_queue()
        .lock()
        .expect("route queue poisoned")
        .push(intent);
    cx.refresh_windows();
}

pub fn drain_intents() -> Vec<RouteIntent> {
    std::mem::take(&mut *route_queue().lock().expect("route queue poisoned"))
}

/// 主窗口顶层视图。
pub struct WorkspaceView {
    screen: Screen,
    welcome: Entity<WelcomeView>,
    onboarding: Entity<OnboardingView>,
    unlock: Entity<UnlockView>,
    vault: Entity<VaultView>,
    totp: Entity<TotpView>,
    generator: Entity<GeneratorView>,
    import_export: Entity<ImportExportView>,
}

impl WorkspaceView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        let initial = initial_screen(&vault);
        let welcome = cx.new(|cx| WelcomeView::new(cx, vault.clone()));
        let onboarding = cx.new(|cx| OnboardingView::new(window, cx, vault.clone()));
        let unlock = cx.new(|cx| UnlockView::new(window, cx, vault.clone()));
        let vault_view = cx.new(|cx| VaultView::new(window, cx, vault.clone()));
        let totp = cx.new(|cx| TotpView::new(cx, vault.clone()));
        let generator = cx.new(|cx| GeneratorView::new(window, cx));
        let import_export = cx.new(|cx| ImportExportView::new(cx, vault.clone()));
        Self {
            screen: initial,
            welcome,
            onboarding,
            unlock,
            vault: vault_view,
            totp,
            generator,
            import_export,
        }
    }

    fn apply_intent(&mut self, intent: RouteIntent, cx: &mut Context<Self>) {
        match intent {
            RouteIntent::GoWelcome => self.screen = Screen::Welcome,
            RouteIntent::GoOnboarding => self.screen = Screen::Onboarding,
            RouteIntent::GoUnlock => self.screen = Screen::Unlock,
            RouteIntent::GoVault => self.screen = Screen::Vault,
            RouteIntent::GoTotp => self.screen = Screen::Totp,
            RouteIntent::GoGenerator => self.screen = Screen::Generator,
            RouteIntent::GoImportExport => self.screen = Screen::ImportExport,
            RouteIntent::LockVault => {
                let vault = cx.global::<AppState>().vault.clone();
                let _ = vault.service().lock();
                self.screen = Screen::Unlock;
            }
        }
        cx.notify();
    }
}

impl Render for WorkspaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 每帧 drain 路由意图。
        for intent in drain_intents() {
            self.apply_intent(intent, cx);
        }

        let theme = cx.global::<AppState>().theme;
        let body: gpui::AnyView = match self.screen {
            Screen::Welcome => self.welcome.clone().into(),
            Screen::Onboarding => self.onboarding.clone().into(),
            Screen::Unlock => self.unlock.clone().into(),
            Screen::Vault => self.vault.clone().into(),
            Screen::Totp => self.totp.clone().into(),
            Screen::Generator => self.generator.clone().into(),
            Screen::ImportExport => self.import_export.clone().into(),
        };

        // notification layer 由 Root 渲染；本视图只负责 titlebar + 当前屏。
        let notification_layer = Root::render_notification_layer(window, cx);

        // 解锁后的顶级屏才显示 sidebar；welcome/onboarding/unlock 用全宽布局。
        let show_sidebar = self.screen.is_top_level();
        let active_nav = match self.screen {
            Screen::Vault => Some(NavTarget::Vault),
            Screen::Totp => Some(NavTarget::Totp),
            Screen::Generator => Some(NavTarget::Generator),
            Screen::ImportExport => Some(NavTarget::ImportExport),
            _ => None,
        };

        let content_row = if show_sidebar {
            div()
                .flex()
                .flex_row()
                .size_full()
                .child(sidebar(theme, active_nav))
                .child(div().flex_1().h_full().child(body))
        } else {
            div().flex_1().w_full().child(body)
        };

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.bg)
            .text_color(theme.text)
            .font_family(crate::theme::tokens::fonts::SANS)
            .text_size(px(14.0))
            .child(crate::widgets::titlebar::titlebar(theme))
            .child(content_row)
            .children(notification_layer)
    }
}

fn initial_screen(vault: &VaultHandle) -> Screen {
    match vault.status_blocking() {
        Ok(status) => {
            if !status.initialized {
                Screen::Welcome
            } else if status.unlocked {
                Screen::Vault
            } else {
                Screen::Unlock
            }
        }
        Err(_) => Screen::Welcome,
    }
}

/// 进程启动入口（`application().run(|cx| launch(cx))`）。
///
/// 这里必须用 `cx.spawn(...)` 异步打开窗口，因为 `WorkspaceView` 的构造需要 `Window`
/// 与 gpui-component 内部状态的初始化（[`gpui_component::init`] 已在 main 里同步调用）。
pub fn launch(cx: &mut App) {
    let vault = match open_default_vault() {
        Ok(handle) => Arc::new(handle),
        Err(err) => panic!("vault open failed: {err:?}"),
    };

    let locale = i18n::default_locale();
    i18n::set_current_locale(locale);

    // 默认 dark 主题；gpui-component 的 Theme 也对齐到 Dark。
    cx.set_global(AppState {
        vault: vault.clone(),
        locale,
        theme: Theme::dark(),
    });
    gpui_component::Theme::change(ThemeMode::Dark, None, cx);

    let bounds = Bounds::centered(None, gpui::size(px(960.0), px(640.0)), cx);
    let window_options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_background: gpui::WindowBackgroundAppearance::Opaque,
        window_min_size: Some(gpui::size(px(720.0), px(480.0))),
        kind: WindowKind::Normal,
        ..Default::default()
    };

    cx.spawn(async move |cx| {
        cx.open_window(window_options, |window, cx| {
            let workspace = cx.new(|cx| WorkspaceView::new(window, cx, vault.clone()));
            // Root 提供 notification layer 与 dialog 容器；必须是窗口第一级子节点。
            cx.new(|cx| Root::new(workspace, window, cx).bg(cx.theme().background))
        })
        .expect("Failed to open window");
    })
    .detach();

    cx.activate(true);
}
