//! `VaultEventSink` trait + 安全的 emit 函数（panic 兜底）。
//!
//! 见 `spec/05a-vault-event-model.md`。

use zpass_vault_format::ItemType;

pub trait VaultEventSink: Send + Sync {
    fn on_event(&self, event: &VaultEvent);
}

#[derive(Debug, Clone)]
pub enum VaultEvent {
    Initialized,
    Unlocked,
    Locked,
    MasterPasswordChanged,
    ItemCreated { id: String, item_type: ItemType },
    ItemUpdated { id: String, item_type: ItemType },
    ItemDeleted { id: String },
    TrustedDeviceEnabled,
    TrustedDeviceDisabled,
    SshKeyDecryptedForSigning { item_id: String },
}

/// 遍历 sink 调用 `on_event`，每个 sink 独立 `catch_unwind`，
/// 单 sink panic 不影响其它 sink 或 vault 主路径。
///
/// **注意**：本函数通常在 VaultService 持有锁的临界区**末尾**调用（spec/05a § 3.2）。
/// 即便 sink panic 被捕获，Rust 栈展开 + drop 顺序仍会让锁正确释放
/// （parking_lot 不 poisoning）。
pub fn emit_safe(sinks: &[Box<dyn VaultEventSink>], event: &VaultEvent) {
    for sink in sinks {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sink.on_event(event);
        }));
    }
}
