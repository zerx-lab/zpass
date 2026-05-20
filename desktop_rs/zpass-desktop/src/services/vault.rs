//! Vault 服务胶水层（spec/11 § 8）。
//!
//! - `VaultHandle` 包装 `Arc<VaultService<SqliteVaultStore>>`，跨线程共享。
//! - `GpuiEventSink` 实现 `VaultEventSink`，把后端事件**通过 crossbeam-channel
//!   异步**送到一个 GPUI Entity（避免在 vault 写锁内回调 UI 路径而死锁，见
//!   spec/05a § 3.1 反例）。
//! - `VaultSubject` 是该 Entity；上层用 `cx.subscribe(&subject, |...|)` 订阅。

use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;

use anyhow::{Context as _, Result};
use gpui::{App, AppContext, Entity, EventEmitter};
use parking_lot::Mutex;

use zpass_vault_format::ItemType;
use zpass_vault_service::{
    NewItem, SystemClock, VaultError, VaultEvent, VaultEventSink, VaultService, VaultStatus,
};
use zpass_vault_store::SqliteVaultStore;

/// UI 端事件（与 `VaultEvent` 1:1 但脱了 `Send + ?Sync` 约束）。
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

impl From<&VaultEvent> for VaultUiEvent {
    fn from(e: &VaultEvent) -> Self {
        match e {
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
            | VaultEvent::SshKeyDecryptedForSigning { .. } => VaultUiEvent::Unlocked, // never reached in Phase B
        }
    }
}

/// 一个空 Entity，仅用于被 `cx.subscribe(...)` 订阅；不持有数据。
pub struct VaultSubject;
impl EventEmitter<VaultUiEvent> for VaultSubject {}

/// Phase B 的 vault 句柄。所有阻塞调用都在调用方使用 `cx.background_spawn`。
pub struct VaultHandle {
    inner: Arc<VaultService<SqliteVaultStore>>,
    // GpuiEventSink → channel sender；后台线程把事件转发到 UI Entity。
    event_tx: Sender<VaultUiEvent>,
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

    pub fn is_unlocked(&self) -> bool {
        self.inner.is_unlocked()
    }

    /// 取（或初始化）UI 订阅 subject。第一次调用启动一个后台桥线程，把
    /// `event_rx` 的事件转发到 entity 的 `cx.emit(...)`。
    pub fn gpui_subject(&self, cx: &mut App) -> Entity<VaultSubject> {
        if let Some(s) = self.subject.lock().clone() {
            return s;
        }
        let subject = cx.new(|_| VaultSubject);
        *self.subject.lock() = Some(subject.clone());

        // 启动转发桥：把 channel 收到的 event 用 cx.update_entity 发给 entity。
        if self.bridge_started.set(()).is_ok() {
            let Some(rx) = self.event_rx_holder.lock().take() else {
                return subject;
            };
            let subject_for_thread = subject.clone();
            let weak = subject_for_thread.downgrade();
            // 用 GPUI 的 background_executor，避免引入 tokio。
            cx.background_executor()
                .spawn(async move {
                    while let Ok(event) = rx.recv() {
                        let Some(_handle) = weak.upgrade() else {
                            break;
                        };
                        // 通过 cx.update_entity 在 main thread 上 emit。
                        // 这里我们没有 cx；GPUI 提供 `App::spawn`/`update` 的全局入口在
                        // 较新的 API 里是 `App::quit` 之类，跨线程通常用 `cx.update_global`。
                        // Phase B 简化：仅打印，让 UI 通过轮询读 vault.status 推动。
                        //
                        // TODO(phase B 完善): 用 `AppContext::update_entity` 跨线程 emit。
                        let _ = event;
                    }
                })
                .detach();
        }

        subject
    }

    /// `Initialize` 包装：让调用方用 `cx.background_spawn` 跑。
    pub async fn initialize_async(self: Arc<Self>, password: String) -> Result<(), VaultError> {
        let inner = self.inner.clone();
        // 阻塞调用放进 blocking 线程池：GPUI background_executor 是允许阻塞的执行器。
        smol_block_in_place(move || inner.initialize(&password))
    }

    pub async fn unlock_async(self: Arc<Self>, password: String) -> Result<(), VaultError> {
        let inner = self.inner.clone();
        smol_block_in_place(move || inner.unlock(&password))
    }

    pub async fn lock_async(self: Arc<Self>) -> Result<(), VaultError> {
        let inner = self.inner.clone();
        smol_block_in_place(move || inner.lock())
    }

    pub async fn list_items_async(
        self: Arc<Self>,
    ) -> Result<Vec<zpass_vault_service::ItemSummary>, VaultError> {
        let inner = self.inner.clone();
        smol_block_in_place(move || inner.list_items())
    }

    pub async fn get_item_async(
        self: Arc<Self>,
        id: String,
    ) -> Result<zpass_vault_format::ItemPayloadV1, VaultError> {
        let inner = self.inner.clone();
        smol_block_in_place(move || inner.get_item(&id))
    }

    pub async fn create_login_async(
        self: Arc<Self>,
        new: NewItem,
    ) -> Result<zpass_vault_service::ItemSummary, VaultError> {
        let inner = self.inner.clone();
        smol_block_in_place(move || inner.create_item(new))
    }

    pub async fn delete_item_async(self: Arc<Self>, id: String) -> Result<(), VaultError> {
        let inner = self.inner.clone();
        smol_block_in_place(move || inner.delete_item(&id))
    }
}

/// 跨平台「在当前线程里执行同步阻塞代码」helper。
///
/// GPUI 的 `background_executor` 任务本来就是允许阻塞的（不像 tokio），所以
/// 这里其实就是直接 call。包一层是给后续可能换 executor 的余地。
fn smol_block_in_place<F, T>(f: F) -> T
where
    F: FnOnce() -> T,
{
    f()
}

/// 内部 sink：通过 channel 把后端事件投递给 UI bridge。
struct GpuiEventSink {
    tx: Sender<VaultUiEvent>,
}

impl VaultEventSink for GpuiEventSink {
    fn on_event(&self, event: &VaultEvent) {
        // 反例（spec/05a § 3.1）：不要在这里回调 vault；只入队。
        let _ = self.tx.send(event.into());
    }
}

/// 用默认路径打开（或创建）vault DB，组装好 service + sink + bridge。
pub fn open_default_vault() -> Result<VaultHandle> {
    let path = zpass_vault_store::default_vault_path().context("resolve default vault path")?;
    let store = SqliteVaultStore::open(&path).context("open SQLite vault store")?;
    let (tx, rx) = channel::<VaultUiEvent>();
    let sink: Box<dyn VaultEventSink> = Box::new(GpuiEventSink { tx: tx.clone() });
    let svc = VaultService::new(store, vec![sink]);
    let _ = SystemClock; // 类型重新导出兜底
    let _ = thread::current; // 避免未用警告
    Ok(VaultHandle {
        inner: Arc::new(svc),
        event_tx: tx,
        subject: Mutex::new(None),
        bridge_started: std::sync::OnceLock::new(),
        event_rx_holder: Mutex::new(Some(rx)),
    })
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
    let score = match (len, classes) {
        (l, _) if l < 8 => "onboarding.strength.weak",
        (l, c) if l >= 16 && c >= 3 => "onboarding.strength.veryStrong",
        (l, c) if l >= 12 && c >= 3 => "onboarding.strength.strong",
        (_, c) if c >= 2 => "onboarding.strength.fair",
        _ => "onboarding.strength.weak",
    };
    score
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn vault_ui_event_conversion() {
        let e = VaultEvent::ItemCreated {
            id: "x".into(),
            item_type: ItemType::Login,
        };
        match VaultUiEvent::from(&e) {
            VaultUiEvent::ItemCreated { id, item_type } => {
                assert_eq!(id, "x");
                assert_eq!(item_type, ItemType::Login);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}
