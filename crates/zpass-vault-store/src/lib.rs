//! `zpass-vault-store` —— vault 数据落地层。
//!
//! - 定义 `VaultStore` trait（spec/02 § 3）。
//! - 提供 `SqliteVaultStore`（feature `sqlite`，桌面默认开启）和 `InMemoryStore`
//!   （feature `in-memory`，测试用）。
//! - 不感知加密：所有 payload 列对本 crate 是不透明 BLOB。
//! - 不感知 vault 状态机：解锁与否由 `VaultService` 控制。

use std::path::PathBuf;

use thiserror::Error;
use zpass_vault_format::VaultMetaBlob;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[cfg(feature = "sqlite")]
    #[error("SQLite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("数据损坏（{0}）")]
    Corrupt(&'static str),
    #[error("schema 不支持：当前 = {current}，期望 ≤ {max}")]
    UnsupportedSchema { current: u32, max: u32 },
    #[error("Vault 已损坏：vault_meta 缺失/重复")]
    InvalidMeta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultItemRow {
    pub id: String,
    pub payload: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedDeviceRow {
    pub method: String,
    pub blob: Vec<u8>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRow {
    pub id: i64,
    pub payload: Vec<u8>,
    pub created_at: i64,
}

/// 审计 row 的写入要点：调用方先用占位 AAD 写入，store 返回 `id` 后调用方
/// 用真 id 重加密 payload，再调 `update_audit_payload(id, new_payload)`。
pub trait VaultStore: Send + Sync + 'static {
    // === meta ===
    fn has_meta(&self) -> Result<bool, StoreError>;
    fn read_meta(&self) -> Result<Option<VaultMetaBlob>, StoreError>;
    fn write_meta(&self, meta: &VaultMetaBlob) -> Result<(), StoreError>;

    // === items ===
    fn list_items(&self) -> Result<Vec<VaultItemRow>, StoreError>;
    fn get_item(&self, id: &str) -> Result<Option<VaultItemRow>, StoreError>;
    fn insert_item(&self, row: &VaultItemRow) -> Result<(), StoreError>;
    fn insert_item_batch(&self, rows: &[VaultItemRow]) -> Result<(), StoreError>;
    fn update_item(&self, row: &VaultItemRow) -> Result<(), StoreError>;
    fn delete_item(&self, id: &str) -> Result<(), StoreError>;

    // === trusted device ===
    fn has_trusted_device(&self) -> Result<bool, StoreError>;
    fn read_trusted_device(&self) -> Result<Option<TrustedDeviceRow>, StoreError>;
    fn write_trusted_device(&self, row: &TrustedDeviceRow) -> Result<(), StoreError>;
    fn delete_trusted_device(&self) -> Result<(), StoreError>;

    // === audit ===
    /// 两步写入第一步：用占位 AAD 加密的 payload 写入，返回分配的 id。
    fn insert_audit(&self, payload: &[u8], created_at: i64) -> Result<i64, StoreError>;
    /// 两步写入第二步：用真 id 重加密后写回。
    fn update_audit_payload(&self, id: i64, payload: &[u8]) -> Result<(), StoreError>;
    fn list_audit(&self, limit: usize) -> Result<Vec<AuditRow>, StoreError>;
    fn delete_all_audit(&self) -> Result<(), StoreError>;
    fn prune_audit(&self, keep: usize) -> Result<(), StoreError>;
}

// ===================== Sqlite 实现 =====================

#[cfg(feature = "sqlite")]
pub mod sqlite {
    use std::path::Path;
    use std::sync::Mutex;

    use rusqlite::{Connection, OptionalExtension, params};
    use zpass_vault_format::{KdfKind, KdfParams, VaultMetaBlob};

    use super::*;

    pub const VAULT_PRAGMAS: &str = "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA secure_delete = ON;
    ";

    pub const SCHEMA_V1: &str = "
        CREATE TABLE IF NOT EXISTS vault_meta (
            id              INTEGER PRIMARY KEY CHECK (id = 1),
            schema_version  INTEGER NOT NULL,
            kdf             TEXT    NOT NULL,
            kdf_salt        BLOB    NOT NULL,
            kdf_memory_kib  INTEGER NOT NULL,
            kdf_iterations  INTEGER NOT NULL,
            kdf_parallelism INTEGER NOT NULL,
            wrapped_dek     BLOB    NOT NULL,
            verifier        BLOB    NOT NULL,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS vault_items (
            id          TEXT    PRIMARY KEY,
            payload     BLOB    NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vault_items_updated_at
            ON vault_items (updated_at DESC);

        CREATE TABLE IF NOT EXISTS vault_trusted_device (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            method      TEXT    NOT NULL,
            blob        BLOB    NOT NULL,
            created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS vault_audit (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            payload     BLOB    NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vault_audit_created_at
            ON vault_audit (created_at DESC);
    ";

    pub struct SqliteVaultStore {
        conn: Mutex<Connection>,
    }

    impl SqliteVaultStore {
        /// 打开（或创建）vault DB。新建时初始化 schema v1。
        pub fn open(path: &Path) -> Result<Self, StoreError> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let conn = Connection::open(path)?;
            conn.execute_batch(VAULT_PRAGMAS)?;
            conn.execute_batch(SCHEMA_V1)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(path) {
                    let mut perms = metadata.permissions();
                    perms.set_mode(0o600);
                    let _ = std::fs::set_permissions(path, perms);
                }
            }
            Ok(Self {
                conn: Mutex::new(conn),
            })
        }

        /// 内存 DB（测试用）。
        pub fn open_in_memory() -> Result<Self, StoreError> {
            let conn = Connection::open_in_memory()?;
            conn.execute_batch(VAULT_PRAGMAS)?;
            conn.execute_batch(SCHEMA_V1)?;
            Ok(Self {
                conn: Mutex::new(conn),
            })
        }
    }

    fn map_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<VaultMetaBlob> {
        let schema_version: u32 = row.get("schema_version")?;
        let kdf_str: String = row.get("kdf")?;
        let kdf = KdfKind::parse(&kdf_str).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::other(format!("unknown kdf: {kdf_str}"))),
            )
        })?;
        Ok(VaultMetaBlob {
            schema_version,
            kdf,
            kdf_salt: row.get("kdf_salt")?,
            kdf_params: KdfParams {
                memory_kib: row.get("kdf_memory_kib")?,
                iterations: row.get("kdf_iterations")?,
                parallelism: row.get::<_, u32>("kdf_parallelism")? as u8,
            },
            wrapped_dek: row.get("wrapped_dek")?,
            verifier: row.get("verifier")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    impl VaultStore for SqliteVaultStore {
        fn has_meta(&self) -> Result<bool, StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let cnt: i64 = conn.query_row("SELECT COUNT(*) FROM vault_meta", [], |r| r.get(0))?;
            Ok(cnt > 0)
        }

        fn read_meta(&self) -> Result<Option<VaultMetaBlob>, StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let mut stmt = conn.prepare(
                "SELECT schema_version, kdf, kdf_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism, wrapped_dek, verifier, created_at, updated_at
                 FROM vault_meta WHERE id = 1",
            )?;
            stmt.query_row([], map_meta).optional().map_err(Into::into)
        }

        fn write_meta(&self, meta: &VaultMetaBlob) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            conn.execute(
                "INSERT INTO vault_meta (
                    id, schema_version, kdf, kdf_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism, wrapped_dek, verifier, created_at, updated_at
                 ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    kdf = excluded.kdf,
                    kdf_salt = excluded.kdf_salt,
                    kdf_memory_kib = excluded.kdf_memory_kib,
                    kdf_iterations = excluded.kdf_iterations,
                    kdf_parallelism = excluded.kdf_parallelism,
                    wrapped_dek = excluded.wrapped_dek,
                    verifier = excluded.verifier,
                    updated_at = excluded.updated_at",
                params![
                    meta.schema_version,
                    meta.kdf.as_str(),
                    meta.kdf_salt,
                    meta.kdf_params.memory_kib,
                    meta.kdf_params.iterations,
                    meta.kdf_params.parallelism as u32,
                    meta.wrapped_dek,
                    meta.verifier,
                    meta.created_at,
                    meta.updated_at,
                ],
            )?;
            Ok(())
        }

        fn list_items(&self) -> Result<Vec<VaultItemRow>, StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let mut stmt = conn.prepare(
                "SELECT id, payload, created_at, updated_at FROM vault_items ORDER BY updated_at DESC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(VaultItemRow {
                        id: r.get(0)?,
                        payload: r.get(1)?,
                        created_at: r.get(2)?,
                        updated_at: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        }

        fn get_item(&self, id: &str) -> Result<Option<VaultItemRow>, StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let mut stmt = conn.prepare(
                "SELECT id, payload, created_at, updated_at FROM vault_items WHERE id = ?1",
            )?;
            stmt.query_row([id], |r| {
                Ok(VaultItemRow {
                    id: r.get(0)?,
                    payload: r.get(1)?,
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })
            .optional()
            .map_err(Into::into)
        }

        fn insert_item(&self, row: &VaultItemRow) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            conn.execute(
                "INSERT INTO vault_items (id, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![row.id, row.payload, row.created_at, row.updated_at],
            )?;
            Ok(())
        }

        fn insert_item_batch(&self, rows: &[VaultItemRow]) -> Result<(), StoreError> {
            let mut conn = self.conn.lock().expect("vault store mutex poisoned");
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO vault_items (id, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                )?;
                for row in rows {
                    stmt.execute(params![row.id, row.payload, row.created_at, row.updated_at])?;
                }
            }
            tx.commit()?;
            Ok(())
        }

        fn update_item(&self, row: &VaultItemRow) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            // created_at 不可变，不在 SET 列表中（spec/05 § 6.3）。
            let affected = conn.execute(
                "UPDATE vault_items SET payload = ?1, updated_at = ?2 WHERE id = ?3",
                params![row.payload, row.updated_at, row.id],
            )?;
            if affected == 0 {
                return Err(StoreError::Corrupt("update_item: row not found"));
            }
            Ok(())
        }

        fn delete_item(&self, id: &str) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let affected = conn.execute("DELETE FROM vault_items WHERE id = ?1", params![id])?;
            if affected == 0 {
                return Err(StoreError::Corrupt("delete_item: row not found"));
            }
            Ok(())
        }

        fn has_trusted_device(&self) -> Result<bool, StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let cnt: i64 =
                conn.query_row("SELECT COUNT(*) FROM vault_trusted_device", [], |r| {
                    r.get(0)
                })?;
            Ok(cnt > 0)
        }

        fn read_trusted_device(&self) -> Result<Option<TrustedDeviceRow>, StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let mut stmt = conn.prepare(
                "SELECT method, blob, created_at FROM vault_trusted_device WHERE id = 1",
            )?;
            stmt.query_row([], |r| {
                Ok(TrustedDeviceRow {
                    method: r.get(0)?,
                    blob: r.get(1)?,
                    created_at: r.get(2)?,
                })
            })
            .optional()
            .map_err(Into::into)
        }

        fn write_trusted_device(&self, row: &TrustedDeviceRow) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            conn.execute(
                "INSERT INTO vault_trusted_device (id, method, blob, created_at) VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET method = excluded.method, blob = excluded.blob, created_at = excluded.created_at",
                params![row.method, row.blob, row.created_at],
            )?;
            Ok(())
        }

        fn delete_trusted_device(&self) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            conn.execute("DELETE FROM vault_trusted_device", [])?;
            Ok(())
        }

        fn insert_audit(&self, payload: &[u8], created_at: i64) -> Result<i64, StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            conn.execute(
                "INSERT INTO vault_audit (payload, created_at) VALUES (?1, ?2)",
                params![payload, created_at],
            )?;
            Ok(conn.last_insert_rowid())
        }

        fn update_audit_payload(&self, id: i64, payload: &[u8]) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let affected = conn.execute(
                "UPDATE vault_audit SET payload = ?1 WHERE id = ?2",
                params![payload, id],
            )?;
            if affected == 0 {
                return Err(StoreError::Corrupt("update_audit_payload: row not found"));
            }
            Ok(())
        }

        fn list_audit(&self, limit: usize) -> Result<Vec<AuditRow>, StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            let mut stmt = conn.prepare(
                "SELECT id, payload, created_at FROM vault_audit ORDER BY id DESC LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![limit as i64], |r| {
                    Ok(AuditRow {
                        id: r.get(0)?,
                        payload: r.get(1)?,
                        created_at: r.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        }

        fn delete_all_audit(&self) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            conn.execute("DELETE FROM vault_audit", [])?;
            Ok(())
        }

        fn prune_audit(&self, keep: usize) -> Result<(), StoreError> {
            let conn = self.conn.lock().expect("vault store mutex poisoned");
            conn.execute(
                "DELETE FROM vault_audit WHERE id NOT IN (SELECT id FROM vault_audit ORDER BY id DESC LIMIT ?1)",
                params![keep as i64],
            )?;
            Ok(())
        }
    }
}

#[cfg(feature = "sqlite")]
pub use sqlite::SqliteVaultStore;

// ===================== InMemory 实现（测试用）=====================

#[cfg(feature = "in-memory")]
pub mod memory {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use super::*;
    use zpass_vault_format::VaultMetaBlob;

    #[derive(Default)]
    struct Inner {
        meta: Option<VaultMetaBlob>,
        items: BTreeMap<String, VaultItemRow>,
        trusted_device: Option<TrustedDeviceRow>,
        audit: Vec<AuditRow>,
        next_audit_id: i64,
    }

    #[derive(Default)]
    pub struct InMemoryStore {
        inner: Mutex<Inner>,
    }

    impl InMemoryStore {
        pub fn new() -> Self {
            Self::default()
        }
    }

    impl VaultStore for InMemoryStore {
        fn has_meta(&self) -> Result<bool, StoreError> {
            Ok(self.inner.lock().unwrap().meta.is_some())
        }
        fn read_meta(&self) -> Result<Option<VaultMetaBlob>, StoreError> {
            Ok(self.inner.lock().unwrap().meta.clone())
        }
        fn write_meta(&self, meta: &VaultMetaBlob) -> Result<(), StoreError> {
            self.inner.lock().unwrap().meta = Some(meta.clone());
            Ok(())
        }
        fn list_items(&self) -> Result<Vec<VaultItemRow>, StoreError> {
            let inner = self.inner.lock().unwrap();
            let mut v: Vec<_> = inner.items.values().cloned().collect();
            v.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
            Ok(v)
        }
        fn get_item(&self, id: &str) -> Result<Option<VaultItemRow>, StoreError> {
            Ok(self.inner.lock().unwrap().items.get(id).cloned())
        }
        fn insert_item(&self, row: &VaultItemRow) -> Result<(), StoreError> {
            let mut inner = self.inner.lock().unwrap();
            if inner.items.contains_key(&row.id) {
                return Err(StoreError::Corrupt("insert_item: duplicate id"));
            }
            inner.items.insert(row.id.clone(), row.clone());
            Ok(())
        }
        fn insert_item_batch(&self, rows: &[VaultItemRow]) -> Result<(), StoreError> {
            for r in rows {
                self.insert_item(r)?;
            }
            Ok(())
        }
        fn update_item(&self, row: &VaultItemRow) -> Result<(), StoreError> {
            let mut inner = self.inner.lock().unwrap();
            let entry = inner
                .items
                .get_mut(&row.id)
                .ok_or(StoreError::Corrupt("update_item: row not found"))?;
            entry.payload = row.payload.clone();
            entry.updated_at = row.updated_at;
            // created_at 不可变
            Ok(())
        }
        fn delete_item(&self, id: &str) -> Result<(), StoreError> {
            let mut inner = self.inner.lock().unwrap();
            inner
                .items
                .remove(id)
                .ok_or(StoreError::Corrupt("delete_item: row not found"))?;
            Ok(())
        }
        fn has_trusted_device(&self) -> Result<bool, StoreError> {
            Ok(self.inner.lock().unwrap().trusted_device.is_some())
        }
        fn read_trusted_device(&self) -> Result<Option<TrustedDeviceRow>, StoreError> {
            Ok(self.inner.lock().unwrap().trusted_device.clone())
        }
        fn write_trusted_device(&self, row: &TrustedDeviceRow) -> Result<(), StoreError> {
            self.inner.lock().unwrap().trusted_device = Some(row.clone());
            Ok(())
        }
        fn delete_trusted_device(&self) -> Result<(), StoreError> {
            self.inner.lock().unwrap().trusted_device = None;
            Ok(())
        }
        fn insert_audit(&self, payload: &[u8], created_at: i64) -> Result<i64, StoreError> {
            let mut inner = self.inner.lock().unwrap();
            inner.next_audit_id += 1;
            let id = inner.next_audit_id;
            inner.audit.push(AuditRow {
                id,
                payload: payload.to_vec(),
                created_at,
            });
            Ok(id)
        }
        fn update_audit_payload(&self, id: i64, payload: &[u8]) -> Result<(), StoreError> {
            let mut inner = self.inner.lock().unwrap();
            let row = inner
                .audit
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or(StoreError::Corrupt("update_audit_payload: row not found"))?;
            row.payload = payload.to_vec();
            Ok(())
        }
        fn list_audit(&self, limit: usize) -> Result<Vec<AuditRow>, StoreError> {
            let inner = self.inner.lock().unwrap();
            let mut v: Vec<_> = inner.audit.iter().rev().take(limit).cloned().collect();
            v.sort_by_key(|r| std::cmp::Reverse(r.id));
            Ok(v)
        }
        fn delete_all_audit(&self) -> Result<(), StoreError> {
            self.inner.lock().unwrap().audit.clear();
            Ok(())
        }
        fn prune_audit(&self, keep: usize) -> Result<(), StoreError> {
            let mut inner = self.inner.lock().unwrap();
            if inner.audit.len() > keep {
                let drop_n = inner.audit.len() - keep;
                inner.audit.drain(0..drop_n);
            }
            Ok(())
        }
    }
}

#[cfg(feature = "in-memory")]
pub use memory::InMemoryStore;

// ===================== 默认 DB 路径 =====================

/// 默认 vault DB 路径 = `<config_root>/vault.db`。
pub fn default_vault_path() -> Result<PathBuf, zpass_platform::PlatformError> {
    zpass_platform::config_root().map(|p| p.join("vault.db"))
}

// ===================== 单元测试 =====================

#[cfg(all(test, feature = "in-memory"))]
mod tests_in_memory {
    use super::*;
    use zpass_vault_format::{KdfKind, KdfParams, VaultMetaBlob};

    fn meta_fixture() -> VaultMetaBlob {
        VaultMetaBlob {
            schema_version: 1,
            kdf: KdfKind::Argon2id,
            kdf_salt: vec![1u8; 32],
            kdf_params: KdfParams {
                memory_kib: 8 * 1024,
                iterations: 1,
                parallelism: 1,
            },
            wrapped_dek: vec![2u8; 64],
            verifier: vec![3u8; 64],
            created_at: 100,
            updated_at: 100,
        }
    }

    #[test]
    fn in_memory_round_trip() {
        let s = InMemoryStore::new();
        assert!(!s.has_meta().unwrap());
        s.write_meta(&meta_fixture()).unwrap();
        let back = s.read_meta().unwrap().unwrap();
        assert_eq!(back, meta_fixture());
    }

    #[test]
    fn item_crud() {
        let s = InMemoryStore::new();
        let row = VaultItemRow {
            id: "a".into(),
            payload: vec![1, 2, 3],
            created_at: 10,
            updated_at: 10,
        };
        s.insert_item(&row).unwrap();
        assert_eq!(s.get_item("a").unwrap().unwrap(), row);
        assert!(s.get_item("missing").unwrap().is_none());
        let updated = VaultItemRow {
            id: "a".into(),
            payload: vec![9],
            created_at: 999, // 应被忽略
            updated_at: 20,
        };
        s.update_item(&updated).unwrap();
        let after = s.get_item("a").unwrap().unwrap();
        assert_eq!(after.payload, vec![9]);
        assert_eq!(after.created_at, 10, "created_at 不可变");
        assert_eq!(after.updated_at, 20);
        s.delete_item("a").unwrap();
        assert!(s.get_item("a").unwrap().is_none());
    }

    #[test]
    fn audit_two_step() {
        let s = InMemoryStore::new();
        let id = s.insert_audit(b"placeholder", 100).unwrap();
        assert!(id > 0);
        s.update_audit_payload(id, b"final").unwrap();
        let rows = s.list_audit(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].payload, b"final");
    }

    #[test]
    fn prune_audit_keeps_n_latest() {
        let s = InMemoryStore::new();
        for i in 0..10 {
            s.insert_audit(&[i as u8], i).unwrap();
        }
        s.prune_audit(3).unwrap();
        let rows = s.list_audit(100).unwrap();
        assert_eq!(rows.len(), 3);
        // 应保留最新 3 条（id 8/9/10）
        assert_eq!(rows[0].id, 10);
        assert_eq!(rows[2].id, 8);
    }
}

#[cfg(all(test, feature = "sqlite"))]
mod tests_sqlite {
    use super::*;
    use zpass_vault_format::{KdfKind, KdfParams, VaultMetaBlob};

    fn meta_fixture() -> VaultMetaBlob {
        VaultMetaBlob {
            schema_version: 1,
            kdf: KdfKind::Argon2id,
            kdf_salt: vec![1u8; 32],
            kdf_params: KdfParams {
                memory_kib: 8 * 1024,
                iterations: 1,
                parallelism: 1,
            },
            wrapped_dek: vec![2u8; 64],
            verifier: vec![3u8; 64],
            created_at: 100,
            updated_at: 100,
        }
    }

    #[test]
    fn open_in_memory_initializes_schema() {
        let s = SqliteVaultStore::open_in_memory().unwrap();
        assert!(!s.has_meta().unwrap());
        s.write_meta(&meta_fixture()).unwrap();
        assert!(s.has_meta().unwrap());
        let back = s.read_meta().unwrap().unwrap();
        assert_eq!(back, meta_fixture());
    }

    #[test]
    fn write_meta_upserts() {
        let s = SqliteVaultStore::open_in_memory().unwrap();
        s.write_meta(&meta_fixture()).unwrap();
        let mut m = meta_fixture();
        m.updated_at = 999;
        s.write_meta(&m).unwrap();
        let back = s.read_meta().unwrap().unwrap();
        assert_eq!(back.updated_at, 999);
    }

    #[test]
    fn item_crud_sqlite() {
        let s = SqliteVaultStore::open_in_memory().unwrap();
        let row = VaultItemRow {
            id: "a".into(),
            payload: vec![1, 2, 3],
            created_at: 10,
            updated_at: 10,
        };
        s.insert_item(&row).unwrap();
        let back = s.get_item("a").unwrap().unwrap();
        assert_eq!(back, row);
    }

    #[test]
    fn open_creates_db_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested").join("vault.db");
        let s = SqliteVaultStore::open(&path).unwrap();
        s.write_meta(&meta_fixture()).unwrap();
        drop(s);
        // 重新打开
        let s2 = SqliteVaultStore::open(&path).unwrap();
        assert!(s2.has_meta().unwrap());
    }

    #[test]
    fn audit_pragma_and_pruning_sqlite() {
        let s = SqliteVaultStore::open_in_memory().unwrap();
        for i in 0..5 {
            s.insert_audit(b"x", i).unwrap();
        }
        s.prune_audit(2).unwrap();
        assert_eq!(s.list_audit(10).unwrap().len(), 2);
        s.delete_all_audit().unwrap();
        assert_eq!(s.list_audit(10).unwrap().len(), 0);
    }

    #[test]
    fn trusted_device_round_trip() {
        let s = SqliteVaultStore::open_in_memory().unwrap();
        assert!(!s.has_trusted_device().unwrap());
        let row = TrustedDeviceRow {
            method: "dpapi".into(),
            blob: vec![9; 32],
            created_at: 100,
        };
        s.write_trusted_device(&row).unwrap();
        assert!(s.has_trusted_device().unwrap());
        assert_eq!(s.read_trusted_device().unwrap().unwrap(), row);
        s.delete_trusted_device().unwrap();
        assert!(!s.has_trusted_device().unwrap());
    }
}
