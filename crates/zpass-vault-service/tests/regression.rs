//! Phase A 退场必过的 16 个回归用例（spec/12 § 2）。
//!
//! - § 2.1 用例 1–9：移植自 Go `desktop/vaultservice_test.go` 的命名测试。
//! - § 2.2 用例 10–16：Rust 新增的安全 / 一致性回归。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use zeroize::Zeroizing;
use zpass_crypto::{Argon2idParams, KEY_SIZE};
use zpass_vault_format::{FieldValue, ItemType};
use zpass_vault_service::{
    Clock, MockClock, NewItem, VaultError, VaultEvent, VaultEventSink, VaultService,
};
use zpass_vault_store::{InMemoryStore, VaultItemRow, VaultStore};

fn weak_params() -> Argon2idParams {
    // 与 spec/04 § 7 + spec/12 § 4.2 一致的弱参数（仅测试用）。
    Argon2idParams {
        memory_kib: 8 * 1024,
        iterations: 1,
        parallelism: 1,
        key_len: 32,
    }
}

fn fresh_service() -> VaultService<InMemoryStore> {
    VaultService::with_clock_and_params(
        InMemoryStore::new(),
        vec![],
        Box::new(zpass_vault_service::SystemClock),
        weak_params(),
    )
}

fn login_item(name: &str, password: &str) -> NewItem {
    let mut fields = BTreeMap::new();
    fields.insert("username".into(), FieldValue::Text("alice".into()));
    fields.insert("password".into(), FieldValue::Text(password.into()));
    NewItem {
        r#type: ItemType::Login,
        name: name.into(),
        fields,
    }
}

// ===================== § 2.1 移植 Go 命名测试 =====================

/// 1. test_status_before_init
#[test]
fn test_status_before_init() {
    let v = fresh_service();
    let s = v.status().unwrap();
    assert!(!s.initialized);
    assert!(!s.unlocked);
    assert_eq!(s.item_count, 0);
}

/// 2. test_initialize_happy_path
#[test]
fn test_initialize_happy_path() {
    let v = fresh_service();
    v.initialize("password 1234").unwrap();
    let s = v.status().unwrap();
    assert!(s.initialized);
    assert!(s.unlocked);
    assert_eq!(s.item_count, 0);

    // 立刻可创建 item
    let summary = v.create_item(login_item("a", "p")).unwrap();
    assert_eq!(summary.name, "a");
    assert_eq!(v.status().unwrap().item_count, 1);
}

/// 3. test_initialize_already_initialized
#[test]
fn test_initialize_already_initialized() {
    let v = fresh_service();
    v.initialize("password 1234").unwrap();
    let err = v.initialize("another password").unwrap_err();
    assert!(matches!(err, VaultError::AlreadyInitialized));
}

/// 4. test_initialize_weak_password
#[test]
fn test_initialize_weak_password() {
    let v = fresh_service();
    let err = v.initialize("short").unwrap_err();
    assert!(matches!(err, VaultError::PasswordTooWeak(_)));
}

/// 5. test_lock_wipes_dek
#[test]
fn test_lock_wipes_dek() {
    let v = fresh_service();
    v.initialize("password 1234").unwrap();
    let summary = v.create_item(login_item("a", "p")).unwrap();
    v.lock().unwrap();

    // 需要 DEK 的方法应返回 Locked
    assert!(matches!(v.list_items(), Err(VaultError::Locked)));
    assert!(matches!(v.get_item(&summary.id), Err(VaultError::Locked)));
    assert!(matches!(
        v.create_item(login_item("b", "p")),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        v.delete_item(&summary.id),
        Err(VaultError::Locked)
    ));
}

/// 6. test_lock_idempotent
#[test]
fn test_lock_idempotent() {
    let v = fresh_service();
    v.initialize("password 1234").unwrap();
    v.lock().unwrap();
    v.lock().unwrap(); // 第二次不应报错
    let s = v.status().unwrap();
    assert!(s.initialized);
    assert!(!s.unlocked);
}

/// 7. test_unlock_wrong_password —— 错密码 → InvalidPassword，且不清空已有 DEK
#[test]
fn test_unlock_wrong_password() {
    let v = fresh_service();
    v.initialize("correct password").unwrap();
    let s_id = v.create_item(login_item("a", "p")).unwrap().id;

    // 在 unlocked 状态下用错密码再 unlock
    let err = v.unlock("wrong password").unwrap_err();
    assert!(matches!(err, VaultError::InvalidPassword));

    // DEK 仍在，原有 item 可读
    assert!(v.is_unlocked());
    assert_eq!(v.get_item(&s_id).unwrap().name, "a");
}

/// 8. test_unlock_correct_password
#[test]
fn test_unlock_correct_password() {
    let v = fresh_service();
    v.initialize("correct password").unwrap();
    let id = v.create_item(login_item("a", "secret")).unwrap().id;
    v.lock().unwrap();
    assert!(!v.is_unlocked());

    v.unlock("correct password").unwrap();
    assert!(v.is_unlocked());
    let item = v.get_item(&id).unwrap();
    assert_eq!(item.name, "a");
    match item.fields.get("password").unwrap() {
        FieldValue::Text(s) => assert_eq!(s, "secret"),
        _ => panic!("password field type"),
    }
}

/// 9. test_change_master_password_dek_preserved
#[test]
fn test_change_master_password_dek_preserved() {
    let v = fresh_service();
    v.initialize("old password 123").unwrap();
    let id = v.create_item(login_item("a", "secret")).unwrap().id;

    v.change_master_password("old password 123", "new password 456")
        .unwrap();

    // 旧密码失败
    v.lock().unwrap();
    assert!(matches!(
        v.unlock("old password 123"),
        Err(VaultError::InvalidPassword)
    ));

    // 新密码成功，且原有 item 仍可解密（DEK 没变）
    v.unlock("new password 456").unwrap();
    let item = v.get_item(&id).unwrap();
    assert_eq!(item.name, "a");
    match item.fields.get("password").unwrap() {
        FieldValue::Text(s) => assert_eq!(s, "secret"),
        _ => panic!(),
    }
}

// ===================== § 2.2 Rust 新增 =====================

/// 10. test_aead_anti_swap —— 手工把 item A 的 payload 写到 item B 的行，应解密失败
#[test]
fn test_aead_anti_swap() {
    // VaultService 不暴露 raw store；用 SharedStore wrapper 让 service 和 test
    // 同时持有 store 的 Arc 引用。
    struct SharedStore(Arc<InMemoryStore>);
    impl VaultStore for SharedStore {
        fn has_meta(&self) -> Result<bool, zpass_vault_store::StoreError> {
            self.0.has_meta()
        }
        fn read_meta(
            &self,
        ) -> Result<Option<zpass_vault_format::VaultMetaBlob>, zpass_vault_store::StoreError>
        {
            self.0.read_meta()
        }
        fn write_meta(
            &self,
            m: &zpass_vault_format::VaultMetaBlob,
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.write_meta(m)
        }
        fn list_items(
            &self,
        ) -> Result<Vec<zpass_vault_store::VaultItemRow>, zpass_vault_store::StoreError> {
            self.0.list_items()
        }
        fn get_item(
            &self,
            id: &str,
        ) -> Result<Option<zpass_vault_store::VaultItemRow>, zpass_vault_store::StoreError>
        {
            self.0.get_item(id)
        }
        fn insert_item(
            &self,
            row: &zpass_vault_store::VaultItemRow,
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.insert_item(row)
        }
        fn insert_item_batch(
            &self,
            rows: &[zpass_vault_store::VaultItemRow],
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.insert_item_batch(rows)
        }
        fn update_item(
            &self,
            row: &zpass_vault_store::VaultItemRow,
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.update_item(row)
        }
        fn delete_item(&self, id: &str) -> Result<(), zpass_vault_store::StoreError> {
            self.0.delete_item(id)
        }
        fn has_trusted_device(&self) -> Result<bool, zpass_vault_store::StoreError> {
            self.0.has_trusted_device()
        }
        fn read_trusted_device(
            &self,
        ) -> Result<Option<zpass_vault_store::TrustedDeviceRow>, zpass_vault_store::StoreError>
        {
            self.0.read_trusted_device()
        }
        fn write_trusted_device(
            &self,
            r: &zpass_vault_store::TrustedDeviceRow,
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.write_trusted_device(r)
        }
        fn delete_trusted_device(&self) -> Result<(), zpass_vault_store::StoreError> {
            self.0.delete_trusted_device()
        }
        fn insert_audit(
            &self,
            payload: &[u8],
            created_at: i64,
        ) -> Result<i64, zpass_vault_store::StoreError> {
            self.0.insert_audit(payload, created_at)
        }
        fn update_audit_payload(
            &self,
            id: i64,
            payload: &[u8],
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.update_audit_payload(id, payload)
        }
        fn list_audit(
            &self,
            limit: usize,
        ) -> Result<Vec<zpass_vault_store::AuditRow>, zpass_vault_store::StoreError> {
            self.0.list_audit(limit)
        }
        fn delete_all_audit(&self) -> Result<(), zpass_vault_store::StoreError> {
            self.0.delete_all_audit()
        }
        fn prune_audit(&self, keep: usize) -> Result<(), zpass_vault_store::StoreError> {
            self.0.prune_audit(keep)
        }
    }

    let raw = Arc::new(InMemoryStore::new());
    let v = VaultService::with_clock_and_params(
        SharedStore(raw.clone()),
        vec![],
        Box::new(zpass_vault_service::SystemClock),
        weak_params(),
    );
    v.initialize("password 1234").unwrap();
    let a = v.create_item(login_item("A", "pa")).unwrap();
    let b = v.create_item(login_item("B", "pb")).unwrap();

    let row_a = raw.get_item(&a.id).unwrap().unwrap();
    let row_b = raw.get_item(&b.id).unwrap().unwrap();

    // 把 A 的 payload 强制写到 B 的 row（保留 B 的 id）—— AAD 应让解密失败
    let tampered = VaultItemRow {
        id: row_b.id.clone(),
        payload: row_a.payload.clone(),
        created_at: row_b.created_at,
        updated_at: row_b.updated_at,
    };
    raw.update_item(&tampered).unwrap();

    let err = v.get_item(&b.id).unwrap_err();
    assert!(
        matches!(err, VaultError::InvalidPassword),
        "AAD 不匹配应返回 InvalidPassword（模糊化），实际：{err:?}"
    );

    // A 仍可正常读
    assert_eq!(v.get_item(&a.id).unwrap().name, "A");
}

/// 11. test_restart_survives —— "重启" 用 SqliteVaultStore 文件 + 重新构造 service 模拟
#[test]
fn test_restart_survives() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("vault.db");

    let id;
    {
        let store = zpass_vault_store::SqliteVaultStore::open(&path).unwrap();
        let v = VaultService::with_clock_and_params(
            store,
            vec![],
            Box::new(zpass_vault_service::SystemClock),
            weak_params(),
        );
        v.initialize("password 1234").unwrap();
        id = v
            .create_item(login_item("persist-me", "secret"))
            .unwrap()
            .id;
        v.lock().unwrap();
    }
    // 重新构造（模拟重启）
    {
        let store = zpass_vault_store::SqliteVaultStore::open(&path).unwrap();
        let v = VaultService::with_clock_and_params(
            store,
            vec![],
            Box::new(zpass_vault_service::SystemClock),
            weak_params(),
        );
        let s = v.status().unwrap();
        assert!(s.initialized);
        assert!(!s.unlocked);
        v.unlock("password 1234").unwrap();
        let item = v.get_item(&id).unwrap();
        assert_eq!(item.name, "persist-me");
    }
}

/// 12. test_no_plaintext_leakage —— DB 中除 id / 时间戳外无明文元数据
#[test]
fn test_no_plaintext_leakage() {
    let raw = InMemoryStore::new();
    // 我们想 unlock 时拿底层 raw 引用，所以用 Arc 包装相同的 trick。
    let raw = Arc::new(raw);
    struct Shared(Arc<InMemoryStore>);
    impl VaultStore for Shared {
        fn has_meta(&self) -> Result<bool, zpass_vault_store::StoreError> {
            self.0.has_meta()
        }
        fn read_meta(
            &self,
        ) -> Result<Option<zpass_vault_format::VaultMetaBlob>, zpass_vault_store::StoreError>
        {
            self.0.read_meta()
        }
        fn write_meta(
            &self,
            m: &zpass_vault_format::VaultMetaBlob,
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.write_meta(m)
        }
        fn list_items(&self) -> Result<Vec<VaultItemRow>, zpass_vault_store::StoreError> {
            self.0.list_items()
        }
        fn get_item(
            &self,
            id: &str,
        ) -> Result<Option<VaultItemRow>, zpass_vault_store::StoreError> {
            self.0.get_item(id)
        }
        fn insert_item(&self, r: &VaultItemRow) -> Result<(), zpass_vault_store::StoreError> {
            self.0.insert_item(r)
        }
        fn insert_item_batch(
            &self,
            rs: &[VaultItemRow],
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.insert_item_batch(rs)
        }
        fn update_item(&self, r: &VaultItemRow) -> Result<(), zpass_vault_store::StoreError> {
            self.0.update_item(r)
        }
        fn delete_item(&self, id: &str) -> Result<(), zpass_vault_store::StoreError> {
            self.0.delete_item(id)
        }
        fn has_trusted_device(&self) -> Result<bool, zpass_vault_store::StoreError> {
            self.0.has_trusted_device()
        }
        fn read_trusted_device(
            &self,
        ) -> Result<Option<zpass_vault_store::TrustedDeviceRow>, zpass_vault_store::StoreError>
        {
            self.0.read_trusted_device()
        }
        fn write_trusted_device(
            &self,
            r: &zpass_vault_store::TrustedDeviceRow,
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.write_trusted_device(r)
        }
        fn delete_trusted_device(&self) -> Result<(), zpass_vault_store::StoreError> {
            self.0.delete_trusted_device()
        }
        fn insert_audit(&self, p: &[u8], c: i64) -> Result<i64, zpass_vault_store::StoreError> {
            self.0.insert_audit(p, c)
        }
        fn update_audit_payload(
            &self,
            id: i64,
            p: &[u8],
        ) -> Result<(), zpass_vault_store::StoreError> {
            self.0.update_audit_payload(id, p)
        }
        fn list_audit(
            &self,
            n: usize,
        ) -> Result<Vec<zpass_vault_store::AuditRow>, zpass_vault_store::StoreError> {
            self.0.list_audit(n)
        }
        fn delete_all_audit(&self) -> Result<(), zpass_vault_store::StoreError> {
            self.0.delete_all_audit()
        }
        fn prune_audit(&self, k: usize) -> Result<(), zpass_vault_store::StoreError> {
            self.0.prune_audit(k)
        }
    }

    let v = VaultService::with_clock_and_params(
        Shared(raw.clone()),
        vec![],
        Box::new(zpass_vault_service::SystemClock),
        weak_params(),
    );
    v.initialize("password 1234").unwrap();
    let sensitive_marker = "SUPER_SECRET_LEAK_CANARY_777";
    let _ = v
        .create_item(login_item("the-name-canary", sensitive_marker))
        .unwrap();

    // 直接拉 row 验证密文不含明文标识
    let rows = raw.list_items().unwrap();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    let payload = &row.payload;

    assert!(
        !payload
            .windows(sensitive_marker.len())
            .any(|w| w == sensitive_marker.as_bytes()),
        "payload 不应包含明文 password"
    );
    assert!(
        !payload
            .windows(b"the-name-canary".len())
            .any(|w| w == b"the-name-canary"),
        "payload 不应包含明文 name"
    );
    assert!(
        !payload.windows(b"username".len()).any(|w| w == b"username"),
        "payload 不应包含明文 field key"
    );

    // meta 不应包含明文密码
    let meta = raw.read_meta().unwrap().unwrap();
    let mut all_meta_bytes = Vec::new();
    all_meta_bytes.extend_from_slice(&meta.kdf_salt);
    all_meta_bytes.extend_from_slice(&meta.wrapped_dek);
    all_meta_bytes.extend_from_slice(&meta.verifier);
    assert!(
        !all_meta_bytes
            .windows(sensitive_marker.len())
            .any(|w| w == sensitive_marker.as_bytes())
    );
}

/// 13. test_now_ms_strictly_monotonic_within_ms
#[test]
fn test_now_ms_strictly_monotonic_within_ms() {
    let clock = Arc::new(MockClock::new(1_000_000));
    // MockClock 不动 -> 模拟同 ms 内连续创建
    let v = VaultService::with_clock_and_params(
        InMemoryStore::new(),
        vec![],
        Box::new(StaticClock(clock.clone())),
        weak_params(),
    );
    v.initialize("password 1234").unwrap();
    let mut last = -1i64;
    for i in 0..100 {
        let s = v.create_item(login_item(&format!("i{i}"), "p")).unwrap();
        assert!(
            s.updated_at > last,
            "iteration {i}: {} ≤ {}",
            s.updated_at,
            last
        );
        last = s.updated_at;
    }
}

/// 14. test_now_ms_handles_clock_rollback
#[test]
fn test_now_ms_handles_clock_rollback() {
    let clock = Arc::new(MockClock::new(10_000));
    let v = VaultService::with_clock_and_params(
        InMemoryStore::new(),
        vec![],
        Box::new(StaticClock(clock.clone())),
        weak_params(),
    );
    v.initialize("password 1234").unwrap();
    let a = v.create_item(login_item("a", "p")).unwrap();
    // 回拨
    clock.set(5_000);
    let b = v.create_item(login_item("b", "p")).unwrap();
    assert!(
        b.updated_at > a.updated_at,
        "时钟回拨后 now_ms 仍必须递增：a={}, b={}",
        a.updated_at,
        b.updated_at
    );
}

// `Clock` 是 trait，`Box<dyn Clock>` 不能 `Clone`，所以用 newtype 包 Arc<MockClock> 提供 `Clock` 实现。
struct StaticClock(Arc<MockClock>);
impl Clock for StaticClock {
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
}

/// 15. test_unlock_with_dek_verifies
#[test]
fn test_unlock_with_dek_verifies() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("vault.db");

    let dek = {
        let store = zpass_vault_store::SqliteVaultStore::open(&path).unwrap();
        let v = VaultService::with_clock_and_params(
            store,
            vec![],
            Box::new(zpass_vault_service::SystemClock),
            weak_params(),
        );
        v.initialize("password 1234").unwrap();
        v.export_dek_with_master_password("password 1234").unwrap()
    };

    // 重新打开，用正确 DEK 解锁
    {
        let store = zpass_vault_store::SqliteVaultStore::open(&path).unwrap();
        let v = VaultService::with_clock_and_params(
            store,
            vec![],
            Box::new(zpass_vault_service::SystemClock),
            weak_params(),
        );
        assert!(!v.is_unlocked());
        let mut copy = Zeroizing::new([0u8; KEY_SIZE]);
        copy.copy_from_slice(dek.as_slice());
        v.unlock_with_dek(copy).unwrap();
        assert!(v.is_unlocked());
    }

    // 错误 DEK
    {
        let store = zpass_vault_store::SqliteVaultStore::open(&path).unwrap();
        let v = VaultService::with_clock_and_params(
            store,
            vec![],
            Box::new(zpass_vault_service::SystemClock),
            weak_params(),
        );
        let bogus = Zeroizing::new([0u8; KEY_SIZE]);
        let err = v.unlock_with_dek(bogus).unwrap_err();
        assert!(matches!(err, VaultError::InvalidPassword));
    }
}

/// 16. test_event_sink_panic_does_not_crash
#[test]
fn test_event_sink_panic_does_not_crash() {
    struct Panicking;
    impl VaultEventSink for Panicking {
        fn on_event(&self, _: &VaultEvent) {
            panic!("intentional panic from sink");
        }
    }
    struct CountingArc(Arc<Mutex<usize>>);
    impl VaultEventSink for CountingArc {
        fn on_event(&self, _: &VaultEvent) {
            *self.0.lock().unwrap() += 1;
        }
    }
    let cnt = Arc::new(Mutex::new(0usize));

    let v = VaultService::with_clock_and_params(
        InMemoryStore::new(),
        vec![Box::new(Panicking), Box::new(CountingArc(cnt.clone()))],
        Box::new(zpass_vault_service::SystemClock),
        weak_params(),
    );
    // 触发 Initialized + Unlocked 两次 emit
    v.initialize("password 1234").unwrap();
    assert!(v.is_unlocked());

    // 触发 ItemCreated
    let _ = v.create_item(login_item("a", "p")).unwrap();

    // Counting sink 收到至少 3 次（Initialized / Unlocked / ItemCreated）
    let n = *cnt.lock().unwrap();
    assert!(n >= 3, "Counting sink 应收到 ≥3 个事件，实际 {n}");
}

// ===================== HOTP counter persistence =====================

/// Pre-C1 回归：`advance_hotp_counter` 使用字段键 `"hotp_counter"`（spec/06 § 4.3，
/// 对应 Go `desktop/totpservice.go:227`）。修复前是 `"counter"`，会导致 counter desync。
#[test]
fn test_advance_hotp_counter_uses_hotp_counter_field() {
    let v = fresh_service();
    v.initialize("password 1234").unwrap();

    // 用 HOTP 类型创建一条，初始 counter = 5（用 hotp_counter 字段）
    let mut fields = BTreeMap::new();
    fields.insert("secret".into(), FieldValue::Text("JBSWY3DPEHPK3PXP".into()));
    fields.insert("hotp_counter".into(), FieldValue::Number(5));
    let new = NewItem {
        r#type: ItemType::Totp, // ItemType::Hotp 未定义；与 Go 一致用 Totp + fields["otp_type"]="hotp"
        name: "HOTP test".into(),
        fields,
    };
    let summary = v.create_item(new).unwrap();
    let id = summary.id;

    // 推进一次：5 → 6
    let next = v.advance_hotp_counter(&id).unwrap();
    assert_eq!(next, 6);

    // 再读 item，确认字段名是 hotp_counter（不是 counter）
    let payload = v.get_item(&id).unwrap();
    match payload.fields.get("hotp_counter") {
        Some(FieldValue::Number(n)) => assert_eq!(*n, 6),
        other => panic!("expected hotp_counter = Number(6), got {other:?}"),
    }
    // 旧的 "counter" 键不应被引入
    assert!(!payload.fields.contains_key("counter"));
}

/// 缺 hotp_counter 字段时从 0 起步、写回也用正确键名。
#[test]
fn test_advance_hotp_counter_initializes_from_zero() {
    let v = fresh_service();
    v.initialize("password 1234").unwrap();

    let mut fields = BTreeMap::new();
    fields.insert("secret".into(), FieldValue::Text("JBSWY3DPEHPK3PXP".into()));
    // 不设 hotp_counter
    let new = NewItem {
        r#type: ItemType::Totp,
        name: "HOTP fresh".into(),
        fields,
    };
    let summary = v.create_item(new).unwrap();
    let next = v.advance_hotp_counter(&summary.id).unwrap();
    assert_eq!(next, 1);

    let payload = v.get_item(&summary.id).unwrap();
    match payload.fields.get("hotp_counter") {
        Some(FieldValue::Number(n)) => assert_eq!(*n, 1),
        other => panic!("expected hotp_counter = Number(1), got {other:?}"),
    }
}
