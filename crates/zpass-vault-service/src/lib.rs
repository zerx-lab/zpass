//! `zpass-vault-service` —— vault 高层 API。
//!
//! 见 `spec/05-vault-service-api.md` 与 `spec/05a-vault-event-model.md`。
//!
//! 设计原则：
//! - **同步、阻塞、线程安全**：`parking_lot::RwLock` 保护内部状态。
//! - **不**依赖 `gpui` / `rusqlite` / `tokio` / 任何具体 store 实现。
//! - **错误模糊化**：所有解锁失败统一返回 `InvalidPassword`。
//! - **事件总线**：通过 `VaultEventSink` trait 解耦 SSH agent / 浏览器桥 / UI。

mod clock;
mod events;

use std::collections::BTreeMap;

use parking_lot::{Mutex, RwLock};
use thiserror::Error;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use zpass_crypto::{
    Argon2idParams, CryptoError, KEY_SIZE, SALT_SIZE, derive_kek, open_aead, random_bytes,
    random_key, seal_aead,
};
use zpass_vault_format::{
    AAD_AUDIT_PENDING, AAD_DEK, AAD_VERIFIER, AuditEntry, FieldValue, ItemPayloadV1, ItemType,
    KdfKind, KdfParams, VAULT_SCHEMA_VERSION, VERIFIER_PLAINTEXT, VaultMetaBlob, audit_final_aad,
    decode_item_payload, encode_item_payload, item_aad,
};
use zpass_vault_store::{StoreError, VaultItemRow, VaultStore};

pub use clock::{Clock, MockClock, SystemClock};
pub use events::{VaultEvent, VaultEventSink};
pub use zpass_vault_format::{
    FieldValue as VaultFieldValue, ItemPayloadV1 as VaultItemPayload, ItemType as VaultItemType,
};

const MIN_PASSWORD_LEN: usize = 8;

// ===================== 公开类型 =====================

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    /// locked 时永远 0；unlocked 时为 store.list_items().len()。
    pub item_count: usize,
}

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("vault 未初始化")]
    NotInitialized,
    #[error("vault 已初始化")]
    AlreadyInitialized,
    #[error("vault 已锁定")]
    Locked,
    #[error("主密码错误")]
    InvalidPassword,
    #[error("密码强度不足（至少 {0} 字符）")]
    PasswordTooWeak(usize),
    #[error("条目不存在")]
    ItemNotFound,
    #[error("条目类型不匹配")]
    InvalidItemType,
    #[error("条目 ID 非法")]
    InvalidItemId,
    #[error("存储错误：{0}")]
    Storage(#[from] StoreError),
    #[error("加密错误")]
    Crypto(CryptoError),
    #[error("内部错误：{0}")]
    Internal(String),
}

impl From<CryptoError> for VaultError {
    fn from(e: CryptoError) -> Self {
        // 与 spec/05 § 9 对齐：所有解密 / KDF 失败 → InvalidPassword（模糊）。
        match e {
            CryptoError::AuthFailed => VaultError::InvalidPassword,
            other => VaultError::Crypto(other),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemSummary {
    pub id: String,
    pub r#type: ItemType,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_totp: bool,
}

#[derive(Debug, Clone)]
pub struct NewItem {
    pub r#type: ItemType,
    pub name: String,
    pub fields: BTreeMap<String, FieldValue>,
}

// ===================== VaultService =====================

struct Inner {
    dek: Option<Zeroizing<[u8; 32]>>,
    last_ts_ms: i64,
}

pub struct VaultService<S: VaultStore> {
    store: S,
    inner: RwLock<Inner>,
    sinks: Vec<Box<dyn VaultEventSink>>,
    /// HOTP advance 锁，顺序：先 hotp，再 inner（spec/05 § 10）。
    hotp_advance_mu: Mutex<()>,
    clock: Box<dyn Clock>,
    /// 生产路径用 default_desktop；`#[cfg(test)] new_with_params` 允许注入弱参数。
    initial_kdf_params: Argon2idParams,
}

impl<S: VaultStore> VaultService<S> {
    /// 生产入口。
    pub fn new(store: S, sinks: Vec<Box<dyn VaultEventSink>>) -> Self {
        Self::build(
            store,
            sinks,
            Box::new(SystemClock),
            Argon2idParams::default_desktop(),
        )
    }

    /// 测试入口：允许注入 Clock + 弱 KDF 参数。**不可**用于生产。
    ///
    /// 仅在 cargo feature `test-helpers` 启用时可见（spec/04 § 7 + spec/12 § 4.2）。
    /// 生产 binary 不应在 `[dependencies]` 中启用此 feature。
    #[doc(hidden)]
    #[cfg(any(test, feature = "test-helpers"))]
    pub fn with_clock_and_params(
        store: S,
        sinks: Vec<Box<dyn VaultEventSink>>,
        clock: Box<dyn Clock>,
        kdf_params: Argon2idParams,
    ) -> Self {
        Self::build(store, sinks, clock, kdf_params)
    }

    fn build(
        store: S,
        sinks: Vec<Box<dyn VaultEventSink>>,
        clock: Box<dyn Clock>,
        kdf_params: Argon2idParams,
    ) -> Self {
        Self {
            store,
            inner: RwLock::new(Inner {
                dek: None,
                last_ts_ms: 0,
            }),
            sinks,
            hotp_advance_mu: Mutex::new(()),
            clock,
            initial_kdf_params: kdf_params,
        }
    }

    // ===================== 状态 =====================

    pub fn status(&self) -> Result<VaultStatus, VaultError> {
        let initialized = self.store.has_meta()?;
        let unlocked = self.is_unlocked();
        let item_count = if unlocked {
            self.store.list_items()?.len()
        } else {
            0
        };
        Ok(VaultStatus {
            initialized,
            unlocked,
            item_count,
        })
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner.read().dek.is_some()
    }

    // ===================== 单调时间戳 =====================

    fn next_ts(&self, inner: &mut Inner) -> i64 {
        let wall = self.clock.now_ms();
        let next = wall.max(inner.last_ts_ms.saturating_add(1));
        inner.last_ts_ms = next;
        next
    }

    // ===================== Initialize =====================

    pub fn initialize(&self, password: &str) -> Result<(), VaultError> {
        if password.chars().count() < MIN_PASSWORD_LEN {
            return Err(VaultError::PasswordTooWeak(MIN_PASSWORD_LEN));
        }
        let mut inner = self.inner.write();
        if self.store.has_meta()? {
            return Err(VaultError::AlreadyInitialized);
        }

        let salt = random_bytes(SALT_SIZE).map_err(VaultError::from)?;
        let dek = random_key().map_err(VaultError::from)?;
        let params = self.initial_kdf_params;

        let kek = derive_kek(password.as_bytes(), &salt, &params)?;
        let wrapped_dek = seal_aead(&kek, dek.as_slice(), AAD_DEK)?;
        let verifier = seal_aead(&dek, VERIFIER_PLAINTEXT, AAD_VERIFIER)?;

        let now = self.next_ts(&mut inner);
        let meta = VaultMetaBlob {
            schema_version: VAULT_SCHEMA_VERSION,
            kdf: KdfKind::Argon2id,
            kdf_salt: salt,
            kdf_params: KdfParams {
                memory_kib: params.memory_kib,
                iterations: params.iterations,
                parallelism: params.parallelism,
            },
            wrapped_dek,
            verifier,
            created_at: now,
            updated_at: now,
        };
        self.store.write_meta(&meta)?;
        inner.dek = Some(dek);
        drop(inner);

        events::emit_safe(&self.sinks, &VaultEvent::Initialized);
        events::emit_safe(&self.sinks, &VaultEvent::Unlocked);
        Ok(())
    }

    // ===================== Unlock =====================

    pub fn unlock(&self, password: &str) -> Result<(), VaultError> {
        let mut inner = self.inner.write();
        let meta = self.store.read_meta()?.ok_or(VaultError::NotInitialized)?;
        let params = Argon2idParams {
            memory_kib: meta.kdf_params.memory_kib,
            iterations: meta.kdf_params.iterations,
            parallelism: meta.kdf_params.parallelism,
            key_len: KEY_SIZE as u32,
        };
        let kek = derive_kek(password.as_bytes(), &meta.kdf_salt, &params)?;
        let dek_bytes = open_aead(&kek, &meta.wrapped_dek, AAD_DEK)?;
        if dek_bytes.len() != KEY_SIZE {
            return Err(VaultError::InvalidPassword);
        }
        let mut dek_arr = Zeroizing::new([0u8; KEY_SIZE]);
        dek_arr.copy_from_slice(&dek_bytes);
        let verifier_plain = open_aead(&dek_arr, &meta.verifier, AAD_VERIFIER)?;
        if verifier_plain.as_slice() != VERIFIER_PLAINTEXT {
            return Err(VaultError::InvalidPassword);
        }

        // 替换；旧 DEK Zeroize 在 drop 时抹零。
        let _old = inner.dek.replace(dek_arr);
        drop(inner);
        events::emit_safe(&self.sinks, &VaultEvent::Unlocked);
        Ok(())
    }

    /// trusted-device 路径：直接喂 DEK 解锁，仍走 verifier 校验。
    pub fn unlock_with_dek(&self, dek: Zeroizing<[u8; KEY_SIZE]>) -> Result<(), VaultError> {
        let mut inner = self.inner.write();
        let meta = self.store.read_meta()?.ok_or(VaultError::NotInitialized)?;
        let verifier_plain = open_aead(&dek, &meta.verifier, AAD_VERIFIER)?;
        if verifier_plain.as_slice() != VERIFIER_PLAINTEXT {
            return Err(VaultError::InvalidPassword);
        }
        inner.dek = Some(dek);
        drop(inner);
        events::emit_safe(&self.sinks, &VaultEvent::Unlocked);
        Ok(())
    }

    pub fn lock(&self) -> Result<(), VaultError> {
        let mut inner = self.inner.write();
        if let Some(mut dek) = inner.dek.take() {
            dek.zeroize();
        }
        drop(inner);
        events::emit_safe(&self.sinks, &VaultEvent::Locked);
        Ok(())
    }

    // ===================== Change master password =====================

    pub fn change_master_password(&self, old: &str, new: &str) -> Result<(), VaultError> {
        if new.chars().count() < MIN_PASSWORD_LEN {
            return Err(VaultError::PasswordTooWeak(MIN_PASSWORD_LEN));
        }

        let mut inner = self.inner.write();
        let meta = self.store.read_meta()?.ok_or(VaultError::NotInitialized)?;
        let old_params = Argon2idParams {
            memory_kib: meta.kdf_params.memory_kib,
            iterations: meta.kdf_params.iterations,
            parallelism: meta.kdf_params.parallelism,
            key_len: KEY_SIZE as u32,
        };
        let old_kek = derive_kek(old.as_bytes(), &meta.kdf_salt, &old_params)?;
        let dek_bytes = open_aead(&old_kek, &meta.wrapped_dek, AAD_DEK)?;
        if dek_bytes.len() != KEY_SIZE {
            return Err(VaultError::InvalidPassword);
        }
        let mut dek_arr = Zeroizing::new([0u8; KEY_SIZE]);
        dek_arr.copy_from_slice(&dek_bytes);
        let verifier_plain = open_aead(&dek_arr, &meta.verifier, AAD_VERIFIER)?;
        if verifier_plain.as_slice() != VERIFIER_PLAINTEXT {
            return Err(VaultError::InvalidPassword);
        }

        // 重新派生 KEK，但**保持 DEK 不变**，所以 items 不需要重新加密。
        let new_salt = random_bytes(SALT_SIZE).map_err(VaultError::from)?;
        let new_params = self.initial_kdf_params;
        let new_kek = derive_kek(new.as_bytes(), &new_salt, &new_params)?;
        let new_wrapped = seal_aead(&new_kek, dek_arr.as_slice(), AAD_DEK)?;
        let new_verifier = seal_aead(&dek_arr, VERIFIER_PLAINTEXT, AAD_VERIFIER)?;

        let now = self.next_ts(&mut inner);
        let new_meta = VaultMetaBlob {
            schema_version: VAULT_SCHEMA_VERSION,
            kdf: KdfKind::Argon2id,
            kdf_salt: new_salt,
            kdf_params: KdfParams {
                memory_kib: new_params.memory_kib,
                iterations: new_params.iterations,
                parallelism: new_params.parallelism,
            },
            wrapped_dek: new_wrapped,
            verifier: new_verifier,
            created_at: meta.created_at,
            updated_at: now,
        };
        self.store.write_meta(&new_meta)?;
        // self.dek 不动（DEK 没变；调用方原先 unlock 后的会话继续）。
        // dek_arr 是 Zeroizing<[u8;32]>，显式 drop 立刻抹零本函数栈上副本。
        drop(dek_arr);
        drop(inner);
        events::emit_safe(&self.sinks, &VaultEvent::MasterPasswordChanged);
        Ok(())
    }

    // ===================== Export DEK（trusted-device 启用专用）=====================

    pub fn export_dek_with_master_password(
        &self,
        password: &str,
    ) -> Result<Zeroizing<[u8; KEY_SIZE]>, VaultError> {
        let inner = self.inner.read();
        let meta = self.store.read_meta()?.ok_or(VaultError::NotInitialized)?;
        let params = Argon2idParams {
            memory_kib: meta.kdf_params.memory_kib,
            iterations: meta.kdf_params.iterations,
            parallelism: meta.kdf_params.parallelism,
            key_len: KEY_SIZE as u32,
        };
        let kek = derive_kek(password.as_bytes(), &meta.kdf_salt, &params)?;
        let dek_bytes = open_aead(&kek, &meta.wrapped_dek, AAD_DEK)?;
        if dek_bytes.len() != KEY_SIZE {
            return Err(VaultError::InvalidPassword);
        }
        let mut out = Zeroizing::new([0u8; KEY_SIZE]);
        out.copy_from_slice(&dek_bytes);
        let verifier_plain = open_aead(&out, &meta.verifier, AAD_VERIFIER)?;
        if verifier_plain.as_slice() != VERIFIER_PLAINTEXT {
            return Err(VaultError::InvalidPassword);
        }
        // 即便 vault 已经 unlocked，也强制重新校验密码（防劫持会话恶意启用）。
        drop(inner);
        Ok(out)
    }

    // ===================== CRUD =====================

    /// 返回 DEK 的 zeroizing 副本。调用方持有期间任何 panic / 提前 return
    /// 都会触发 `Drop` 抹零，避免栈上残留。
    fn require_dek(&self, inner: &Inner) -> Result<Zeroizing<[u8; KEY_SIZE]>, VaultError> {
        let dek = inner.dek.as_ref().ok_or(VaultError::Locked)?;
        let mut out = Zeroizing::new([0u8; KEY_SIZE]);
        out.copy_from_slice(dek.as_slice());
        Ok(out)
    }

    pub fn list_items(&self) -> Result<Vec<ItemSummary>, VaultError> {
        let inner = self.inner.read();
        let dek = self.require_dek(&inner)?;
        let rows = self.store.list_items()?;
        drop(inner);

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let pt = open_aead(&dek, &row.payload, item_aad(&row.id))?;
            let payload =
                decode_item_payload(&pt).map_err(|_| VaultError::Internal("cbor decode".into()))?;
            out.push(ItemSummary {
                id: payload.id.clone(),
                r#type: payload.r#type.clone(),
                name: payload.name.clone(),
                created_at: row.created_at,
                updated_at: row.updated_at,
                has_totp: payload.fields.contains_key("totp"),
            });
        }
        // dek 是 Zeroizing<[u8;32]>，函数返回时自动抹零
        Ok(out)
    }

    pub fn get_item(&self, id: &str) -> Result<ItemPayloadV1, VaultError> {
        let inner = self.inner.read();
        let dek = self.require_dek(&inner)?;
        let row = self.store.get_item(id)?.ok_or(VaultError::ItemNotFound)?;
        drop(inner);
        let pt = open_aead(&dek, &row.payload, item_aad(&row.id))?;
        let payload =
            decode_item_payload(&pt).map_err(|_| VaultError::Internal("cbor decode".into()))?;
        Ok(payload)
    }

    pub fn create_item(&self, item: NewItem) -> Result<ItemSummary, VaultError> {
        let mut inner = self.inner.write();
        let dek = self.require_dek(&inner)?;
        let id = Uuid::new_v4().to_string();
        let now = self.next_ts(&mut inner);
        let payload = ItemPayloadV1 {
            id: id.clone(),
            r#type: item.r#type.clone(),
            name: item.name.clone(),
            fields: item.fields,
            created_at: now,
            updated_at: now,
        };
        let encoded = encode_item_payload(&payload)
            .map_err(|_| VaultError::Internal("cbor encode".into()))?;
        let encrypted = seal_aead(&dek, &encoded, item_aad(&id))?;
        self.store.insert_item(&VaultItemRow {
            id: id.clone(),
            payload: encrypted,
            created_at: now,
            updated_at: now,
        })?;
        let summary = ItemSummary {
            id: id.clone(),
            r#type: payload.r#type.clone(),
            name: payload.name.clone(),
            created_at: now,
            updated_at: now,
            has_totp: payload.fields.contains_key("totp"),
        };
        drop(inner);
        events::emit_safe(
            &self.sinks,
            &VaultEvent::ItemCreated {
                id,
                item_type: payload.r#type,
            },
        );
        Ok(summary)
    }

    pub fn update_item(&self, payload: ItemPayloadV1) -> Result<ItemSummary, VaultError> {
        let mut inner = self.inner.write();
        let dek = self.require_dek(&inner)?;
        let existing = self
            .store
            .get_item(&payload.id)?
            .ok_or(VaultError::ItemNotFound)?;
        let now = self.next_ts(&mut inner);
        // created_at 来自现有 row（不可变）
        let final_payload = ItemPayloadV1 {
            id: payload.id.clone(),
            r#type: payload.r#type.clone(),
            name: payload.name.clone(),
            fields: payload.fields,
            created_at: existing.created_at,
            updated_at: now,
        };
        let encoded = encode_item_payload(&final_payload)
            .map_err(|_| VaultError::Internal("cbor encode".into()))?;
        let encrypted = seal_aead(&dek, &encoded, item_aad(&final_payload.id))?;
        self.store.update_item(&VaultItemRow {
            id: final_payload.id.clone(),
            payload: encrypted,
            created_at: existing.created_at,
            updated_at: now,
        })?;
        let summary = ItemSummary {
            id: final_payload.id.clone(),
            r#type: final_payload.r#type.clone(),
            name: final_payload.name.clone(),
            created_at: existing.created_at,
            updated_at: now,
            has_totp: final_payload.fields.contains_key("totp"),
        };
        drop(inner);
        events::emit_safe(
            &self.sinks,
            &VaultEvent::ItemUpdated {
                id: final_payload.id,
                item_type: final_payload.r#type,
            },
        );
        Ok(summary)
    }

    pub fn delete_item(&self, id: &str) -> Result<(), VaultError> {
        let inner = self.inner.write();
        // 确认 vault 已解锁（delete 不需要 DEK，但维持「锁状态拒服务」语义）
        let _ = self.require_dek(&inner)?;
        match self.store.delete_item(id) {
            Ok(()) => {}
            Err(StoreError::Corrupt(_)) => return Err(VaultError::ItemNotFound),
            Err(e) => return Err(VaultError::Storage(e)),
        }
        drop(inner);
        events::emit_safe(&self.sinks, &VaultEvent::ItemDeleted { id: id.to_string() });
        Ok(())
    }

    // ===================== SSH 子系统 hook =====================

    pub fn decrypt_ssh_private_key(&self, item_id: &str) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let payload = self.get_item(item_id)?;
        if payload.r#type != ItemType::Ssh {
            return Err(VaultError::InvalidItemType);
        }
        let key = match payload.fields.get("private_key") {
            Some(FieldValue::Text(s)) => Zeroizing::new(s.as_bytes().to_vec()),
            Some(FieldValue::Bytes(b)) => Zeroizing::new(b.clone()),
            _ => return Err(VaultError::ItemNotFound),
        };
        // 仅在成功解密后通知审计 sink；失败路径不发事件。
        events::emit_safe(
            &self.sinks,
            &VaultEvent::SshKeyDecryptedForSigning {
                item_id: item_id.to_string(),
            },
        );
        Ok(key)
    }

    // ===================== HOTP =====================

    /// HOTP advance：读取 `hotp_counter` 字段、+1、写回。
    ///
    /// 字段键固定为 `"hotp_counter"`（spec/06 § 4.3，与 Go `desktop/totpservice.go:227`
    /// 字段命名一致）。返回类型 v1 = 新计数；C1b 在 zpass-otp 接入后会扩展为
    /// `HotpAdvanceResult { code, new_counter, item_summary }`（spec/06 § 4.2）。
    ///
    /// 锁顺序：先 `hotp_advance_mu`，再内部锁——`get_item` / `update_item` 各自取
    /// `inner` 读/写锁；外层 hotp 锁仅保证多个并发 advance 在 vault 视图层串行化。
    pub fn advance_hotp_counter(&self, item_id: &str) -> Result<u64, VaultError> {
        let _guard = self.hotp_advance_mu.lock();
        let mut payload = self.get_item(item_id)?;
        let counter = match payload.fields.get("hotp_counter") {
            Some(FieldValue::Number(n)) if *n >= 0 => *n as u64,
            _ => 0,
        };
        let next = counter.wrapping_add(1);
        payload
            .fields
            .insert("hotp_counter".into(), FieldValue::Number(next as i64));
        self.update_item(payload)?;
        Ok(next)
    }

    // ===================== 审计 =====================

    pub fn append_audit(&self, entry: AuditEntry) -> Result<i64, VaultError> {
        let mut inner = self.inner.write();
        let dek = self.require_dek(&inner)?;
        let now = self.next_ts(&mut inner);
        let encoded = zpass_vault_format::encode_audit(&entry)
            .map_err(|_| VaultError::Internal("cbor encode audit".into()))?;
        // 第一步：占位 AAD 加密。
        let pending = seal_aead(&dek, &encoded, AAD_AUDIT_PENDING)?;
        let id = self.store.insert_audit(&pending, now)?;
        // 第二步：用真 id 的 AAD 重加密。
        let aad = audit_final_aad(id);
        let final_blob = seal_aead(&dek, &encoded, &aad)?;
        self.store.update_audit_payload(id, &final_blob)?;
        Ok(id)
    }

    pub fn list_audit(&self, limit: usize) -> Result<Vec<AuditEntry>, VaultError> {
        let inner = self.inner.read();
        let dek = self.require_dek(&inner)?;
        let rows = self.store.list_audit(limit)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let aad = audit_final_aad(row.id);
            match open_aead(&dek, &row.payload, &aad) {
                Ok(pt) => {
                    if let Ok(entry) = zpass_vault_format::decode_audit(&pt) {
                        out.push(entry);
                    }
                    // best-effort：解码失败静默跳过（spec/03 § 3.4）
                }
                Err(_) => {
                    // 解密失败（可能是占位 AAD 残留 row）静默跳过
                }
            }
        }
        Ok(out)
    }
}

// ===================== 重新导出（方便外部 use 一处）=====================

pub use zpass_crypto::Argon2idParams as CryptoArgon2idParams;
pub use zpass_vault_format::AuditEntry as VaultAuditEntry;
