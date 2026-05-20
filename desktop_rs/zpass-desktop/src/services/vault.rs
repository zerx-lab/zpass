//! Vault 服务胶水层（spec/11 § 8）。
//!
//! - `VaultHandle` 包装 `Arc<VaultService<SqliteVaultStore>>`，跨线程共享。
//! - `GpuiEventSink` 实现 `VaultEventSink`，把后端事件**通过 channel
//!   异步**送到一个 GPUI Entity（避免在 vault 写锁内回调 UI 路径而死锁，见
//!   spec/05a § 3.1 反例）。
//! - `VaultSubject` 是该 Entity；上层用 `cx.subscribe(&subject, |...|)` 订阅。

use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use anyhow::{Context as _, Result};
use gpui::{App, AppContext, Entity, EventEmitter};
use parking_lot::Mutex;

use zpass_vault_format::ItemType;
use zpass_vault_service::{
    NewItem, VaultError, VaultEvent, VaultEventSink, VaultService, VaultStatus,
};
use zpass_vault_store::SqliteVaultStore;

/// UI 端事件（与 `VaultEvent` 1:1 但脱了 `Send + ?Sync` 约束）。
///
/// Phase B 当前只在 vault 屏 match `Item*` / `Locked` 三类；其余字段（id / item_type）
/// 留给 Phase C 的 totp / passkey 屏使用，因此暂时挂 `#[allow(dead_code)]`。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum VaultUiEvent {
    Initialized,
    Unlocked,
    Locked,
    MasterPasswordChanged,
    ItemCreated { id: String, item_type: ItemType },
    ItemUpdated { id: String, item_type: ItemType },
    ItemDeleted { id: String },
}

impl VaultUiEvent {
    /// `VaultEvent` 中 Phase B **不**关心的事件转 `None`，避免发到 UI。
    fn from_backend(e: &VaultEvent) -> Option<Self> {
        Some(match e {
            VaultEvent::Initialized => VaultUiEvent::Initialized,
            VaultEvent::Unlocked => VaultUiEvent::Unlocked,
            VaultEvent::Locked => VaultUiEvent::Locked,
            VaultEvent::MasterPasswordChanged => VaultUiEvent::MasterPasswordChanged,
            VaultEvent::ItemCreated { id, item_type } => VaultUiEvent::ItemCreated {
                id: id.clone(),
                item_type: item_type.clone(),
            },
            VaultEvent::ItemUpdated { id, item_type } => VaultUiEvent::ItemUpdated {
                id: id.clone(),
                item_type: item_type.clone(),
            },
            VaultEvent::ItemDeleted { id } => VaultUiEvent::ItemDeleted { id: id.clone() },
            // Phase B 不订阅 SSH / 信任设备事件
            VaultEvent::TrustedDeviceEnabled
            | VaultEvent::TrustedDeviceDisabled
            | VaultEvent::SshKeyDecryptedForSigning { .. } => return None,
        })
    }
}

/// 一个空 Entity，仅用于被 `cx.subscribe(...)` 订阅；不持有数据。
pub struct VaultSubject;
impl EventEmitter<VaultUiEvent> for VaultSubject {}

/// Phase B 的 vault 句柄。所有阻塞调用都同步执行（Phase B vault 操作都是毫秒级 SQLite）。
pub struct VaultHandle {
    inner: Arc<VaultService<SqliteVaultStore>>,
    subject: Mutex<Option<Entity<VaultSubject>>>,
    bridge_started: std::sync::OnceLock<()>,
    event_rx_holder: Mutex<Option<Receiver<VaultUiEvent>>>,
}

impl VaultHandle {
    /// 返回内部 `VaultService` 的 Arc（供后台任务调用）。
    pub fn service(&self) -> Arc<VaultService<SqliteVaultStore>> {
        self.inner.clone()
    }

    pub fn status_blocking(&self) -> Result<VaultStatus, VaultError> {
        self.inner.status()
    }

    /// 取（或初始化）UI 订阅 subject。第一次调用启动一个后台桥任务，把
    /// channel 的事件用 `AsyncApp::update` 投递回 main thread，调用 `cx.emit(...)`。
    pub fn gpui_subject(self: &Arc<Self>, cx: &mut App) -> Entity<VaultSubject> {
        if let Some(s) = self.subject.lock().clone() {
            return s;
        }
        let subject = cx.new(|_| VaultSubject);
        *self.subject.lock() = Some(subject.clone());

        if self.bridge_started.set(()).is_ok() {
            let Some(rx) = self.event_rx_holder.lock().take() else {
                return subject;
            };
            let weak = subject.downgrade();
            // cx.spawn 在 main 线程上执行 async block，闭包内的 AsyncApp 不需要 Send。
            // 阻塞 `rx.recv()` 改成非阻塞 `try_recv` + 让出（Phase B 事件量很小，
            // 简单忙等可接受；真需要时换 `smol::channel`）。
            cx.spawn(async move |async_cx| {
                use std::time::Duration;
                loop {
                    match rx.try_recv() {
                        Ok(event) => {
                            let Some(handle) = weak.upgrade() else {
                                break;
                            };
                            async_cx.update(|cx| {
                                handle.update(cx, |_, cx| {
                                    cx.emit(event.clone());
                                });
                            });
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => {
                            // 让出 ~16ms（一帧）；GPUI 的 timer API。
                            async_cx
                                .background_executor()
                                .timer(Duration::from_millis(16))
                                .await;
                        }
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                    }
                }
            })
            .detach();
        }

        subject
    }
}

/// 内部 sink：通过 channel 把后端事件投递给 UI bridge。
struct GpuiEventSink {
    tx: Sender<VaultUiEvent>,
}

impl VaultEventSink for GpuiEventSink {
    fn on_event(&self, event: &VaultEvent) {
        // 反例（spec/05a § 3.1）：不要在这里回调 vault；只入队。
        if let Some(ui_ev) = VaultUiEvent::from_backend(event) {
            let _ = self.tx.send(ui_ev);
        }
    }
}

/// 用默认路径打开（或创建）vault DB，组装好 service + sink + bridge。
pub fn open_default_vault() -> Result<VaultHandle> {
    let path = zpass_vault_store::default_vault_path().context("resolve default vault path")?;
    let store = SqliteVaultStore::open(&path).context("open SQLite vault store")?;
    let (tx, rx) = channel::<VaultUiEvent>();
    let sink: Box<dyn VaultEventSink> = Box::new(GpuiEventSink { tx });
    let svc = VaultService::new(store, vec![sink]);
    Ok(VaultHandle::wrap(Arc::new(svc), rx))
}

impl VaultHandle {
    /// 内部入口：把已组装的 service + rx 打包。
    fn wrap(inner: Arc<VaultService<SqliteVaultStore>>, rx: Receiver<VaultUiEvent>) -> Self {
        VaultHandle {
            inner,
            subject: Mutex::new(None),
            bridge_started: std::sync::OnceLock::new(),
            event_rx_holder: Mutex::new(Some(rx)),
        }
    }

    /// 测试构造：in-memory SQLite + 弱 KDF 参数。仅在测试编译时可见。
    #[cfg(test)]
    pub fn new_in_memory_for_test() -> Result<Self> {
        use zpass_crypto::Argon2idParams;
        use zpass_vault_service::SystemClock;
        let store = SqliteVaultStore::open_in_memory().context("open in-memory sqlite")?;
        let (tx, rx) = channel::<VaultUiEvent>();
        let sink: Box<dyn VaultEventSink> = Box::new(GpuiEventSink { tx });
        let weak = Argon2idParams {
            memory_kib: 8 * 1024,
            iterations: 1,
            parallelism: 1,
            key_len: 32,
        };
        let svc =
            VaultService::with_clock_and_params(store, vec![sink], Box::new(SystemClock), weak);
        Ok(VaultHandle::wrap(Arc::new(svc), rx))
    }
}

/// 便捷构造：把 `NewItem` 拼出来给 onboarding/vault 屏用。
pub fn new_login(
    name: &str,
    username: &str,
    password: &str,
    url: Option<&str>,
    notes: Option<&str>,
) -> NewItem {
    use std::collections::BTreeMap;
    use zpass_vault_format::FieldValue;
    let mut fields = BTreeMap::new();
    fields.insert("username".to_string(), FieldValue::Text(username.into()));
    fields.insert("password".to_string(), FieldValue::Text(password.into()));
    if let Some(u) = url {
        fields.insert("url".to_string(), FieldValue::Text(u.into()));
    }
    if let Some(n) = notes {
        fields.insert("notes".to_string(), FieldValue::Text(n.into()));
    }
    NewItem {
        r#type: ItemType::Login,
        name: name.to_string(),
        fields,
    }
}

/// 简单密码强度估计（Phase B 用；spec/11 § 9a 的更精细版在 generator 屏，Phase C）。
pub fn password_strength_label(pw: &str) -> &'static str {
    let len = pw.chars().count();
    let mut classes = 0;
    if pw.chars().any(|c| c.is_ascii_lowercase()) {
        classes += 1;
    }
    if pw.chars().any(|c| c.is_ascii_uppercase()) {
        classes += 1;
    }
    if pw.chars().any(|c| c.is_ascii_digit()) {
        classes += 1;
    }
    if pw.chars().any(|c| !c.is_ascii_alphanumeric()) {
        classes += 1;
    }
    match (len, classes) {
        (l, _) if l < 8 => "onboarding.strength.weak",
        (l, c) if l >= 16 && c >= 3 => "onboarding.strength.veryStrong",
        (l, c) if l >= 12 && c >= 3 => "onboarding.strength.strong",
        (_, c) if c >= 2 => "onboarding.strength.fair",
        _ => "onboarding.strength.weak",
    }
}

/// 编译期断言：`Arc<VaultService<SqliteVaultStore>>` 必须是 `Send`，否则
/// `screens/unlock.rs` 与 `screens/onboarding.rs` 把 KDF 调用推到
/// `cx.background_executor().spawn(...)` 的方案就无法编译。
///
/// 此断言挂在 cfg(test) 下零运行时开销，但任何打破 Send 的回归（例如给 VaultService
/// 加一个 `Rc<...>` 字段）都会让 `cargo check --tests` 失败。
#[cfg(test)]
const _: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<std::sync::Arc<VaultService<SqliteVaultStore>>>();
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel as std_channel;

    #[test]
    fn password_strength_weak_for_short() {
        assert_eq!(password_strength_label("abc"), "onboarding.strength.weak");
        assert_eq!(password_strength_label(""), "onboarding.strength.weak");
    }

    #[test]
    fn password_strength_classifies_classes() {
        // 8 chars, 2 classes -> fair
        assert_eq!(
            password_strength_label("abcd1234"),
            "onboarding.strength.fair"
        );
        // 12 chars, 3 classes -> strong
        assert_eq!(
            password_strength_label("Abcdefg12345"),
            "onboarding.strength.strong"
        );
        // 16 chars, 4 classes -> veryStrong
        assert_eq!(
            password_strength_label("Abcdefgh1234!@#$"),
            "onboarding.strength.veryStrong"
        );
    }

    /// 验证 sink → channel 链路：emit 一个 `VaultEvent` 后，channel 必须收到对应 UI 事件。
    /// （emit → entity 这一段需 GPUI 上下文，由 `#[gpui::test]` 覆盖。）
    #[test]
    fn sink_forwards_events_to_channel() {
        let (tx, rx) = std_channel::<VaultUiEvent>();
        let sink = GpuiEventSink { tx };
        sink.on_event(&VaultEvent::Initialized);
        sink.on_event(&VaultEvent::Unlocked);
        sink.on_event(&VaultEvent::ItemCreated {
            id: "abc".into(),
            item_type: ItemType::Login,
        });
        // SSH 事件应被过滤掉
        sink.on_event(&VaultEvent::SshKeyDecryptedForSigning {
            item_id: "xyz".into(),
        });

        let collected: Vec<VaultUiEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert_eq!(collected.len(), 3);
        assert!(matches!(collected[0], VaultUiEvent::Initialized));
        assert!(matches!(collected[1], VaultUiEvent::Unlocked));
        assert!(matches!(
            collected[2],
            VaultUiEvent::ItemCreated { ref id, .. } if id == "abc"
        ));
    }
}
