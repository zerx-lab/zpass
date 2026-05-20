//! 全局 AppState 装配 + 主窗口创建 + 屏幕路由。
//!
//! 路由模型：屏幕通过 [`dispatch`] 投递 [`RouteIntent`] 到一个进程级 queue；
//! `WorkspaceView` 在每帧 render 前 drain queue 应用切屏。这避开了在 GPUI
//! 子组件中直接拿 root view 句柄的复杂 API（Phase B 简化）。

use std::sync::{Arc, Mutex, OnceLock};

use gpui::{
    App, AppContext, Bounds, Context, Entity, IntoElement, ParentElement, Render, SharedString,
    Styled, Window, WindowBounds, WindowKind, WindowOptions, div, prelude::*, px,
};

use crate::i18n;
use crate::screens::{OnboardingView, UnlockView, VaultView, WelcomeView};
use crate::services::vault::{VaultHandle, open_default_vault};
use crate::theme::Theme;

/// 高层屏幕枚举。Phase B 只有 4 个屏。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Welcome,
    Onboarding,
    Unlock,
    Vault,
}

/// 屏幕间的"切屏意图"。其它字段（如错误提示）通过 AppState 传。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteIntent {
    GoWelcome,
    GoOnboarding,
    GoUnlock,
    GoVault,
    /// 锁定 vault（vault 屏「锁定」按钮）。
    LockVault,
}

/// 全局只读上下文。修改通过 [`update_state`]。
pub struct AppState {
    pub vault: Arc<VaultHandle>,
    pub locale: i18n::Locale,
    pub theme: Theme,
    /// onboarding / unlock 屏的实时错误提示（在表单本地复制后清除）。
    pub last_error_key: Option<&'static str>,
}

impl gpui::Global for AppState {}

pub fn update_state(cx: &mut App, mutate: impl FnOnce(&mut AppState)) {
    cx.update_global::<AppState, _>(|state, _| mutate(state));
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
}

impl WorkspaceView {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        let initial = initial_screen(&vault);
        let welcome = cx.new(|cx| WelcomeView::new(cx, vault.clone()));
        let onboarding = cx.new(|cx| OnboardingView::new(cx, vault.clone()));
        let unlock = cx.new(|cx| UnlockView::new(cx, vault.clone()));
        let vault_view = cx.new(|cx| VaultView::new(cx, vault.clone()));
        Self {
            screen: initial,
            welcome,
            onboarding,
            unlock,
            vault: vault_view,
        }
    }

    fn apply_intent(&mut self, intent: RouteIntent, cx: &mut Context<Self>) {
        match intent {
            RouteIntent::GoWelcome => self.screen = Screen::Welcome,
            RouteIntent::GoOnboarding => self.screen = Screen::Onboarding,
            RouteIntent::GoUnlock => self.screen = Screen::Unlock,
            RouteIntent::GoVault => self.screen = Screen::Vault,
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
        };

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.bg)
            .text_color(theme.text)
            .font_family(SharedString::from(crate::theme::tokens::fonts::SANS))
            .text_size(px(14.0))
            .child(crate::widgets::titlebar::titlebar(theme))
            .child(div().flex_1().w_full().child(body))
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
pub fn launch(cx: &mut App) {
    let vault = match open_default_vault() {
        Ok(handle) => Arc::new(handle),
        Err(err) => panic!("vault open failed: {err:?}"),
    };

    let locale = i18n::default_locale();
    i18n::set_current_locale(locale);
    cx.set_global(AppState {
        vault: vault.clone(),
        locale,
        theme: Theme::dark(),
        last_error_key: None,
    });

    let bounds = Bounds::centered(None, gpui::size(px(960.0), px(640.0)), cx);
    let _ = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_background: gpui::WindowBackgroundAppearance::Opaque,
            window_min_size: Some(gpui::size(px(720.0), px(480.0))),
            kind: WindowKind::Normal,
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| WorkspaceView::new(window, cx, vault.clone())),
    );

    cx.activate(true);
}
