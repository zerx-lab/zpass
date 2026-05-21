//! Phase B 退场必过的 6 个 `#[gpui::test]`（spec/15 § 3）。
//!
//! 这些测试通过 `TestAppContext` 打开真窗口、实例化 View entity，模拟设置 Input 值 +
//! 调用提交方法 —— 走的是 *与生产相同* 的 render / event 路径，但通过 in-memory vault +
//! 弱 KDF 把单次解锁缩到毫秒级。
//!
//! 断言落在 View 的字段上（`error_key`、`items`、`strength_key` 等），而不是
//! rendered tree 的字符串匹配 —— 后者在 GPUI 里没有便利 API。

use std::sync::Arc;

use gpui::{AppContext as _, Entity, TestAppContext, WindowHandle};
use gpui_component::Root;

use crate::app::AppState;
use crate::i18n;
use crate::screens::{OnboardingView, UnlockView, VaultView, WelcomeView};
use crate::services::vault::VaultHandle;
use crate::theme::Theme;

/// 在测试窗口里以 `Root` 包裹一个子视图（与生产 main 流程一致），返回 root + 子视图 handle。
fn add_window_with_root<V, F>(cx: &mut TestAppContext, build: F) -> (WindowHandle<Root>, Entity<V>)
where
    V: 'static + gpui::Render,
    F: FnOnce(&mut gpui::Window, &mut gpui::Context<V>) -> V,
{
    // 用 Cell 把内层 entity 从闭包里"逃出来"。
    let inner_cell = std::rc::Rc::new(std::cell::RefCell::new(None));
    let cell_clone = inner_cell.clone();
    let window = cx.add_window(move |window, cx| {
        let view = cx.new(|cx| build(window, cx));
        *cell_clone.borrow_mut() = Some(view.clone());
        Root::new(view, window, cx)
    });
    let inner = inner_cell.borrow().clone().expect("inner entity");
    (window, inner)
}

/// 在指定的 root window 上下文中，update 内层 view。供 `add_window_with_root` 返回值后使用。
///
/// 注意：不能用 `root_window.update(...)`，那会锁住 Root entity 导致内部 `push_notification`
/// 调用的 `Root::update` 卡住。改用 `cx.update_window(any_handle, |_root_view, window, cx| ...)`
/// 拿到 window 引用，而不锁 Root。
fn update_in_window<V, R>(
    cx: &mut TestAppContext,
    root_window: &WindowHandle<Root>,
    view: &Entity<V>,
    f: impl FnOnce(&mut V, &mut gpui::Window, &mut gpui::Context<V>) -> R,
) -> R
where
    V: 'static,
{
    let any_handle: gpui::AnyWindowHandle = (*root_window).into();
    cx.update(|cx| {
        cx.update_window(any_handle, |_root_view, window, cx| {
            view.update(cx, |v, cx| f(v, window, cx))
        })
        .unwrap()
    })
}

/// 公共 fixture：初始化 gpui-component + 注入 AppState + 创建 in-memory vault。
fn setup(cx: &mut TestAppContext) -> Arc<VaultHandle> {
    cx.update(|cx| {
        gpui_component::init(cx);
        i18n::set_current_locale(i18n::Locale::En);
        let vault = Arc::new(VaultHandle::new_in_memory_for_test().expect("in-memory vault"));
        cx.set_global(AppState {
            vault: vault.clone(),
            locale: i18n::Locale::En,
            theme: Theme::dark(),
            ssh_host: crate::services::ssh_agent_host::SshHostState::new(),
        });
        gpui_component::Theme::change(gpui_component::ThemeMode::Dark, None, cx);
        vault
    })
}

/// 1. welcome 渲染：视图持有的 vault 与 AppState 的 vault 是同一份 Arc，
///    确保入口 wiring 没有把 vault 句柄换成别的实例。
#[gpui::test]
fn welcome_renders(cx: &mut TestAppContext) {
    let vault = setup(cx);
    let window: WindowHandle<WelcomeView> =
        cx.add_window(|_window, cx| WelcomeView::new(cx, vault.clone()));
    cx.run_until_parked();
    let same_vault = window
        .read_with(cx, |v, _| std::sync::Arc::ptr_eq(v.vault_arc(), &vault))
        .unwrap();
    assert!(
        same_vault,
        "WelcomeView 必须持有 setup() 传入的同一份 vault Arc"
    );
}

/// 2. onboarding 主密码强度提示：输入弱密码 → strength_key = weak；输入强密码 → veryStrong。
#[gpui::test]
fn onboarding_strength_updates(cx: &mut TestAppContext) {
    let vault = setup(cx);
    let window = cx.add_window(|window, cx| OnboardingView::new(window, cx, vault.clone()));

    // 输入弱密码 'abc'
    window
        .update(cx, |v, window, cx| {
            v.password_state.update(cx, |s, cx| {
                s.set_value("abc", window, cx);
            });
        })
        .unwrap();
    cx.run_until_parked();
    let strength = window.update(cx, |v, _, cx| v.strength_key(cx)).unwrap();
    assert_eq!(strength, "onboarding.strength.weak", "短密码应分类为 weak");

    // 输入强密码 'Abcdefgh1234!@#$'
    window
        .update(cx, |v, window, cx| {
            v.password_state.update(cx, |s, cx| {
                s.set_value("Abcdefgh1234!@#$", window, cx);
            });
        })
        .unwrap();
    cx.run_until_parked();
    let strength = window.update(cx, |v, _, cx| v.strength_key(cx)).unwrap();
    assert_eq!(
        strength, "onboarding.strength.veryStrong",
        "长 + 4 字符类应为 veryStrong"
    );
}

/// 3. unlock 错密码：异步 KDF 跑完后触发 `error_key = unlock.error.invalid`
///    并把 `submitting` 复位为 `false`（红色 error label 渲染由 i18n 键覆盖）。
#[gpui::test]
fn unlock_wrong_password_shows_error(cx: &mut TestAppContext) {
    let vault = setup(cx);
    vault
        .service()
        .initialize("correct-horse-battery-staple")
        .expect("init");
    vault.service().lock().expect("lock");

    // 用 Root 包裹（保留：异步路径未来若再加 toast，Root 是必需的）。
    let (root_window, view) = add_window_with_root::<UnlockView, _>(cx, |window, cx| {
        UnlockView::new(window, cx, vault.clone())
    });

    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.password_state.update(cx, |s, cx| {
            s.set_value("wrong-password", window, cx);
        });
    });
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.submit(window, cx)
    });
    // submit 返回后是异步 task，需要把执行器跑到 parked 才能看到结果。
    cx.run_until_parked();

    let (err, submitting) = view.read_with(cx, |v, _| (v.error_key, v.submitting));
    assert_eq!(
        err,
        Some("unlock.error.invalid"),
        "错密码必须把 error_key 设为 unlock.error.invalid"
    );
    assert!(!submitting, "异步任务完成后 submitting 必须复位为 false");
}

/// 3b. unlock submit 中间态：submit 调用后、KDF 完成前，
///     `submitting == true`，确保 UI 能立刻把 Button 切到 loading 状态。
///
/// 测试做法：用 `update_in_window` 同步调 submit 但**不**调 run_until_parked —
/// 此时异步 task 已经 spawn 出去但还没跑，view state 必须已经反映 submitting=true。
#[gpui::test]
fn unlock_submit_shows_submitting_state(cx: &mut TestAppContext) {
    let vault = setup(cx);
    vault
        .service()
        .initialize("test-password-123")
        .expect("init");
    vault.service().lock().expect("lock");

    let (root_window, view) = add_window_with_root::<UnlockView, _>(cx, |window, cx| {
        UnlockView::new(window, cx, vault.clone())
    });

    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.password_state.update(cx, |s, cx| {
            s.set_value("test-password-123", window, cx);
        });
    });

    // 调 submit 但故意不 run_until_parked。
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.submit(window, cx);
    });

    let (submitting, err) = view.read_with(cx, |v, _| (v.submitting, v.error_key));
    assert!(submitting, "submit 调用返回时 submitting 必须立刻为 true");
    assert_eq!(err, None, "进入 submitting 时必须先清除旧 error_key");

    // 把后续异步收尾，避免影响后续测试：跑完整流程后 submitting 应该回到 false。
    cx.run_until_parked();
    let submitting_after = view.read_with(cx, |v, _| v.submitting);
    assert!(
        !submitting_after,
        "run_until_parked 后异步 task 应已完成，submitting 复位"
    );
}

/// 3c. unlock submit 重入 guard：在 submitting=true 期间再次调 submit
///     必须 no-op（不消费新密码值，不再次触发 KDF）。
///
/// 验证方法：第一次 submit 用错误密码进入 submitting；不 run_until_parked；
/// 然后把输入改成正确密码并再次 submit。run_until_parked 后必须仍然得到
/// error_key（第一次的 KDF 结果），证明第二次 submit 没起效。
#[gpui::test]
fn unlock_submit_reentry_blocked(cx: &mut TestAppContext) {
    let vault = setup(cx);
    vault
        .service()
        .initialize("correct-pw-12345")
        .expect("init");
    vault.service().lock().expect("lock");

    let (root_window, view) = add_window_with_root::<UnlockView, _>(cx, |window, cx| {
        UnlockView::new(window, cx, vault.clone())
    });

    // 第一次：错密码触发 submit，立刻进 submitting。
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.password_state.update(cx, |s, cx| {
            s.set_value("wrong-pw", window, cx);
        });
    });
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.submit(window, cx);
    });
    assert!(view.read_with(cx, |v, _| v.submitting));

    // 第二次（重入）：现在把密码改成正确的，再 submit。guard 应当让这次成为 no-op。
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.password_state.update(cx, |s, cx| {
            s.set_value("correct-pw-12345", window, cx);
        });
    });
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.submit(window, cx);
    });

    // 重入 guard 起效的**直接**证据：第二次 submit 之后 submitting 仍是 true，
    // 意味着没有新 task 被 spawn（否则状态机会被搅乱）。这比依赖 executor
    // 调度顺序的 error_key 断言更直接，独立于 task 完成顺序。
    assert!(
        view.read_with(cx, |v, _| v.submitting),
        "第二次 submit 必须被 guard 早返回阻止，submitting 保持 true"
    );

    // 跑完：第一次 KDF（错密码）结果应当 win，error_key 被设上。
    cx.run_until_parked();
    let (err, submitting) = view.read_with(cx, |v, _| (v.error_key, v.submitting));
    assert_eq!(
        err,
        Some("unlock.error.invalid"),
        "重入 guard 必须让第二次 submit no-op，第一次错密码 KDF 结果应胜出"
    );
    assert!(!submitting);
}

/// 3e. onboarding 同步校验失败时**不**进入 submitting：
///     防止有人不小心把 `self.submitting = true` 移到校验之前的回归。
#[gpui::test]
fn onboarding_sync_validation_does_not_enter_submitting(cx: &mut TestAppContext) {
    let vault = setup(cx);
    let (root_window, view) = add_window_with_root::<OnboardingView, _>(cx, |window, cx| {
        OnboardingView::new(window, cx, vault.clone())
    });

    // 案例 A：密码过短（< 8 字符）。
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.password_state.update(cx, |s, cx| {
            s.set_value("short", window, cx);
        });
        v.confirm_state.update(cx, |s, cx| {
            s.set_value("short", window, cx);
        });
    });
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.submit(window, cx);
    });
    let (submitting, err) = view.read_with(cx, |v, _| (v.submitting, v.error_key));
    assert!(
        !submitting,
        "短密码校验失败时不应进入 submitting（否则 Button 永远 loading）"
    );
    assert_eq!(err, Some("onboarding.error.tooShort"));

    // 案例 B：两次输入不一致。
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.password_state.update(cx, |s, cx| {
            s.set_value("Abcdefgh1234", window, cx);
        });
        v.confirm_state.update(cx, |s, cx| {
            s.set_value("DIFFERENT12345", window, cx);
        });
    });
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.submit(window, cx);
    });
    let (submitting, err) = view.read_with(cx, |v, _| (v.submitting, v.error_key));
    assert!(!submitting, "密码不一致校验失败时不应进入 submitting");
    assert_eq!(err, Some("onboarding.error.mismatch"));
}

/// 3d. onboarding submit 异步完成：正确强密码 → KDF 完成 → submitting 复位、
///     vault.initialized 变为 true、error_key 为 None（路由跳转由 dispatch 处理，
///     非本测试断言对象 — 跨 view 路由测试见 vault_lists_items）。
#[gpui::test]
fn onboarding_submit_async_completes(cx: &mut TestAppContext) {
    let vault = setup(cx);
    let (root_window, view) = add_window_with_root::<OnboardingView, _>(cx, |window, cx| {
        OnboardingView::new(window, cx, vault.clone())
    });

    // 强密码（长度 ≥ 8 且通过 strength）。
    let pw = "Abcdefgh1234!@#$";
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.password_state.update(cx, |s, cx| {
            s.set_value(pw, window, cx);
        });
        v.confirm_state.update(cx, |s, cx| {
            s.set_value(pw, window, cx);
        });
    });

    // 提交：同步校验过 → 进入 submitting → spawn KDF。
    update_in_window(cx, &root_window, &view, |v, window, cx| {
        v.submit(window, cx);
    });
    assert!(
        view.read_with(cx, |v, _| v.submitting),
        "校验通过后必须立刻进入 submitting"
    );

    // 跑完异步：KDF 完成、vault 初始化、submitting 复位。
    cx.run_until_parked();

    let (submitting, err) = view.read_with(cx, |v, _| (v.submitting, v.error_key));
    assert!(!submitting, "异步完成后 submitting 必须复位");
    assert_eq!(err, None, "成功初始化不应留下 error_key");
    assert!(
        vault.service().status().expect("status").initialized,
        "异步 initialize 必须真的把 vault 标记为已初始化"
    );
}

/// 4. vault 列表渲染：初始化 + 直接 service.create → 视图刷新到 1 行。
#[gpui::test]
fn vault_lists_items(cx: &mut TestAppContext) {
    let vault = setup(cx);
    vault
        .service()
        .initialize("test-password-123")
        .expect("init");
    let new = crate::services::vault::new_login(
        "Example",
        "alice",
        "secret",
        Some("https://example.com"),
        None,
    );
    vault.service().create_item(new).expect("create");

    let window = cx.add_window(|window, cx| VaultView::new(window, cx, vault.clone()));
    cx.run_until_parked();

    let count = window.update(cx, |v, _, _| v.items.len()).unwrap();
    assert_eq!(count, 1, "vault 视图应立即列出 1 条 service 已创建的条目");
}

/// 5. 创建 login 后列表立即出现该条：通过 UI 表单路径。
#[gpui::test]
fn vault_create_login_appears_immediately(cx: &mut TestAppContext) {
    let vault = setup(cx);
    vault
        .service()
        .initialize("test-password-123")
        .expect("init");

    let window = cx.add_window(|window, cx| VaultView::new(window, cx, vault.clone()));
    cx.run_until_parked();
    assert_eq!(
        window.update(cx, |v, _, _| v.items.len()).unwrap(),
        0,
        "初始为空"
    );

    // 打开表单
    window.update(cx, |v, _, cx| v.open_form(cx)).unwrap();
    cx.run_until_parked();

    // 填字段
    window
        .update(cx, |v, window, cx| {
            v.name_state.update(cx, |s, cx| {
                s.set_value("My Login", window, cx);
            });
            v.username_state.update(cx, |s, cx| {
                s.set_value("alice", window, cx);
            });
            v.password_state.update(cx, |s, cx| {
                s.set_value("hunter2", window, cx);
            });
        })
        .unwrap();

    // 保存
    window.update(cx, |v, _, cx| v.save_form(cx)).unwrap();
    cx.run_until_parked();

    let items = window.update(cx, |v, _, _| v.items.clone()).unwrap();
    assert_eq!(items.len(), 1, "save_form 后列表必须立即有 1 条");
    assert_eq!(items[0].name, "My Login");
}

/// 7. **事件桥**端到端：直接走 `service.create_item()`（不经 UI 表单），
///    `gpui_subject` 的 channel→emit 桥必须把 `ItemCreated` 转回订阅，触发 view 重刷。
///
/// 这条测试与 `vault_create_login_appears_immediately` 互补：后者只验同步 `refresh` 路径；
/// 本测覆盖 spec/05a § 3.1 的事件链。
#[gpui::test]
fn vault_event_bridge_refreshes_on_external_create(cx: &mut TestAppContext) {
    let vault = setup(cx);
    vault
        .service()
        .initialize("test-password-123")
        .expect("init");

    // 此测试不调 push_notification，所以不需要 Root 包裹（与 vault_lists_items 对齐）。
    let window = cx.add_window(|window, cx| VaultView::new(window, cx, vault.clone()));
    cx.run_until_parked();
    let initial_count = window.update(cx, |v, _, _| v.items.len()).unwrap();
    assert_eq!(initial_count, 0, "起始为空");

    // 绕过 UI 表单，直接调 service.create_item — 必须让事件桥触发 view 刷新。
    let new = crate::services::vault::new_login("Bridge Test", "alice", "secret", None, None);
    vault.service().create_item(new).expect("create");

    // 事件桥用 16ms 轮询；必须 advance_clock 把 timer 推过去再让出。
    // 多推几次以覆盖：(create -> tx) -> bridge timer fire -> try_recv ok -> update -> emit -> subscribe handler。
    for _ in 0..5 {
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(20));
        cx.run_until_parked();
        let has_items = window.update(cx, |v, _, _| !v.items.is_empty()).unwrap();
        if has_items {
            break;
        }
    }
    let items_after = window.update(cx, |v, _, _| v.items.clone()).unwrap();
    assert_eq!(
        items_after.len(),
        1,
        "事件桥必须在 service 外部创建后刷新 view（确认 services/vault.rs:97 的 cx.spawn 桥工作）"
    );
    assert_eq!(items_after[0].name, "Bridge Test");
}

/// 6. 主题切换：调用 set_theme(Light) 后 AppState.theme 切到 light tokens。
#[gpui::test]
fn theme_switch_updates_tokens(cx: &mut TestAppContext) {
    let _vault = setup(cx);

    // 起始 dark。
    cx.update(|cx| {
        let bg = cx.global::<AppState>().theme.bg;
        assert_eq!(bg, Theme::dark().bg, "起始必须是 dark token");
    });

    // 切到 light。
    cx.update(|cx| {
        crate::app::set_theme(cx, gpui_component::ThemeMode::Light);
    });

    cx.update(|cx| {
        let bg = cx.global::<AppState>().theme.bg;
        assert_eq!(
            bg,
            Theme::light().bg,
            "set_theme(Light) 后必须使用 light token"
        );
        assert_eq!(
            gpui_component::Theme::global(cx).mode,
            gpui_component::ThemeMode::Light,
            "gpui-component Theme 必须跟随"
        );
    });
}
