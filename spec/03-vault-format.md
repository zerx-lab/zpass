# 03 — Vault 数据格式

## 1. 总览

- **磁盘文件**：`~/.config/zpass/vault.db`（SQLite，单文件，WAL 模式）
- **存储原则**：「加密在外、存储在内」—— DB 列只见密文 + 时间戳 + 必要 ID；明文元数据（type / name / url / tag / ...）一律塞进加密 payload。
- **审计日志**：**与 vault 同库同文件**（决策已锁定，见本文 § 5 与 `12-testing-strategy.md`）。
- **与 Go 版兼容**：不兼容。schema 是全新的，但**形态高度近似**——便于熟悉 Go 版的开发者快速对照。

---

## 2. 顶层 schema 版本

```rust
pub const VAULT_SCHEMA_VERSION: u32 = 1;
```

> Rust 版 v1 从 schema_version = 1 开始计数，**不**继承 Go 的 v1/v2/v3。

升版策略：每次新加列 / 表 / 约束 +1，并在 `migrate(from, to)` 中加 case。每个 case 必须幂等（`IF NOT EXISTS`）。

---

## 3. 表清单

### 3.1 `vault_meta`（单例）

```sql
CREATE TABLE vault_meta (
    id              INTEGER PRIMARY KEY CHECK (id = 1),  -- 强制单例
    schema_version  INTEGER NOT NULL,                    -- 当前 = 1
    kdf             TEXT    NOT NULL,                    -- "argon2id"
    kdf_salt        BLOB    NOT NULL,                    -- 32 bytes
    kdf_memory_kib  INTEGER NOT NULL,
    kdf_iterations  INTEGER NOT NULL,
    kdf_parallelism INTEGER NOT NULL,
    wrapped_dek     BLOB    NOT NULL,                    -- AEAD(KEK, DEK, aad="zpass:dek")
    verifier        BLOB    NOT NULL,                    -- AEAD(DEK, "zpass-vault-verifier-v1", aad="zpass:verifier")
    created_at      INTEGER NOT NULL,                    -- unix ms（单调）
    updated_at      INTEGER NOT NULL                     -- unix ms（单调）
);
```

> 「verifier 明文」固定为字面量 `"zpass-vault-verifier-v1"`（39 字节，UTF-8）。升版时换 `-v2`。

### 3.2 `vault_items`

```sql
CREATE TABLE vault_items (
    id          TEXT    PRIMARY KEY,    -- UUID v4 字符串（小写，含连字符）
    payload     BLOB    NOT NULL,       -- AEAD(DEK, CBOR(ItemPayloadV1), aad=id_bytes)
    created_at  INTEGER NOT NULL,       -- unix ms
    updated_at  INTEGER NOT NULL        -- unix ms
);

CREATE INDEX idx_vault_items_updated_at ON vault_items (updated_at DESC);
```

**关键安全属性**：列上**不存** type / name / url / tag。即使整个 DB 被拖走，攻击者除了「有几条记录、每条多大、什么时间创建 / 修改」之外得不到任何明文信息。这一点会被回归测试 `test_no_plaintext_leakage` 锁死（见 `12-testing-strategy.md`）。

### 3.3 `vault_trusted_device`（单例）

```sql
CREATE TABLE vault_trusted_device (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    method      TEXT    NOT NULL,       -- "dpapi" / "keychain" / "libsecret"
    blob        BLOB    NOT NULL,       -- OS device-bound key wraps the raw DEK
    created_at  INTEGER NOT NULL
);
```

> v1 仅 Windows 写入 `method = "dpapi"`。其它平台读到非空行视为「不可解封」失败，按 `10-trusted-device.md` 的策略静默清空 + 回退主密码流程。

### 3.4 `vault_audit`

```sql
CREATE TABLE vault_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    payload     BLOB    NOT NULL,       -- AEAD(DEK, CBOR(AuditEntry), aad=("zpass:audit:" + id_bytes))
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_vault_audit_created_at ON vault_audit (created_at DESC);
```

特别说明 AAD：插入时不能立即知道 `id`，因此采用 **两步写入** 模式：

1. `INSERT INTO vault_audit (payload, created_at) VALUES (?, ?)` 用占位 AAD `b"zpass:audit:pending"`。
2. 读 `last_insert_rowid()`，重新加密 payload（AAD = `format!("zpass:audit:{}", id)`），`UPDATE vault_audit SET payload = ? WHERE id = ?`。

> 两步写入在事务中完成，原子性由 SQLite 保证。

**崩溃恢复**：若进程在 INSERT 与 UPDATE 之间崩溃，对应 row 的 payload 用占位 AAD 加密、用真 id 的 AAD 永远解不开。`list_audit` 在解密失败时**静默跳过**该 row 并记录一条 `tracing::warn!`（best-effort 语义，与 Go 内存 ring buffer 实现「写入失败丢一条审计无伤大雅」的处理风格一致）。同时维护一条 `pub fn prune_corrupt_audit(&self) -> Result<usize, _>` 让 settings 页提供「清理损坏审计」按钮（v2 实现，v1 静默跳过即可）。

---

## 4. AAD 上下文常量（权威清单）

| 场景                  | AAD 字节                                |
| --------------------- | --------------------------------------- |
| Wrap DEK（KEK→DEK）   | `b"zpass:dek"`                          |
| Verifier              | `b"zpass:verifier"`                     |
| Item payload          | item id 的 UTF-8 字节（不加前缀）       |
| Audit entry           | `format!("zpass:audit:{}", id)` 的字节  |
| Trusted device wrap   | `b"zpass:trusted-device:v1"` （DPAPI entropy 等价物） |

`zpass-vault-format::AAD_*` 常量必须与本表完全一致；任何修改都需要写到 schema 升级路径里。

---

## 5. 为什么审计日志和 vault 同库

| 选项                                                           | 优劣                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **审计同库（采用）**                                           | ✅ 单文件可备份；✅ 与 DEK 同 schema 加密；✅ Go v3 已这样做，迁移心智一致                          |
| 审计独立文件 `audit.db`                                        | ❌ 多一份文件需备份；❌ 需要单独的 DEK 包装路径或独立密钥；❌ 与 Go 版本数据形态分歧加大            |
| 仅内存 ring buffer                                             | ❌ 与用户「v1 完整审计」诉求矛盾                                                                  |

> 决策已锁定，本文档与 `02-crates.md` § `zpass-vault-store` 的 `AuditRow` API、`05-vault-service-api.md` 中的审计写入路径 全部对齐。

---

## 6. ItemPayloadV1（密文 payload 的明文结构）

CBOR 编码，外层 `seal_aead(DEK, encoded, aad=item.id)`。

```rust
pub struct ItemPayloadV1 {
    pub id: String,                       // 与外层 row.id 完全一致
    pub r#type: ItemType,                 // "login" / "card" / "note" / "identity" / "ssh" / "passkey" / "totp"
    pub name: String,                     // 列表展示用
    pub fields: BTreeMap<String, FieldValue>,  // 按类型自定义字段；后端不解释
    pub created_at: i64,                  // 与外层 row.created_at 完全一致
    pub updated_at: i64,                  // 与外层 row.updated_at 完全一致
}

pub enum FieldValue {
    Text(String),
    Number(i64),
    Bool(bool),
    Bytes(Vec<u8>),    // SSH 私钥等二进制
    Null,
}
```

> `BTreeMap` 而非 `HashMap`：CBOR 编码可重复，便于不同设备 / 时间得到位级一致的密文 → 测试可断言。

### 6.1 ItemType 枚举

```rust
pub enum ItemType { Login, Card, Note, Identity, Ssh, Passkey, Totp }
```

**没有** `Wallet`。Go 侧的 `legacyWalletType` 在 Rust 导入器里降级为 `Note` 并把 `address` / `seed` 合并到 `notes` 字段（详见 `13-migration-checklist.md`）。

### 6.2 字段命名约定

按 Go 现状对齐（前端 + 浏览器扩展 + 浏览器桥协议已经默认了这套 key）：

| 类型     | 必有字段                                                                 |
| -------- | ------------------------------------------------------------------------ |
| login    | `username`, `password`, `url`, `notes?`, `totp?`                          |
| totp     | `totp`, `issuer?`, `account?`, `notes?`                                  |
| ssh      | `private_key`（OpenSSH PEM）, `public_key`, `passphrase?`, `notes?`       |
| passkey  | `rp_id`, `rp_name`, `credential_id`, `private_key_pkcs8`, `public_key_cose`, `sign_count`, `user_id`, `user_name`, `user_display_name`, `transports[]?` |
| card     | `holder?`, `number`, `expiry_month?`, `expiry_year?`, `cvv?`, `notes?`   |
| note     | `notes`                                                                  |
| identity | `first_name?`, `last_name?`, `email?`, `phone?`, `address?`, `notes?`    |

> v1 后端不强制校验字段存在性（与 Go 一致：后端是「加密保险柜」）。前端表单负责。

---

## 7. 双层密钥拓扑

与 Go 等价（实现见 `04-crypto-contract.md`）：

```
master password (用户输入；从不落盘)
      │
      ▼  Argon2id(salt = vault_meta.kdf_salt, params = vault_meta.kdf_*)
KEK (32 bytes)
      │
      ▼  open_aead(wrapped_dek, aad=b"zpass:dek")
DEK (32 bytes)
      │
      ├──► open_aead(verifier,    aad=b"zpass:verifier")  → "zpass-vault-verifier-v1"
      ├──► open_aead(item.payload, aad=item.id.as_bytes())  → CBOR(ItemPayloadV1)
      └──► open_aead(audit.payload, aad=format!("zpass:audit:{}", id).as_bytes())  → CBOR(AuditEntry)
```

---

## 8. PRAGMA 设置

打开 DB 时同步设置：

```rust
const VAULT_PRAGMAS: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
";
```

不在 rusqlite open URL 里用 query string 形式（不同 driver 兼容性参差），直接 `conn.execute_batch(VAULT_PRAGMAS)?`。

文件权限：首次创建 + chmod 0600（POSIX；Windows os.Chmod 等价无操作，NTFS ACL 默认 cover）。

---

## 9. 单调时间戳契约

所有写路径调用 `VaultService::now_ms() -> i64`（详见 `05-vault-service-api.md` § 单调时间戳）。直接调 `SystemTime::now()` 会在 Windows 计时器分辨率下出现两条 `updated_at` 相同的记录，破坏列表稳定。

---

## 10. 与 Go 版本对照

| Go schema                  | Rust v1 schema             | 差异                                                    |
| -------------------------- | -------------------------- | ------------------------------------------------------- |
| `vault_meta.version`       | `vault_meta.schema_version`| 重命名（更明确）                                        |
| 同名其它列                 | 同名其它列                 | 字段一一对应                                            |
| `vault_items` 同形         | `vault_items` 同形         | id 类型从 `TEXT` 保持 `TEXT`                            |
| `vault_trusted_device` 同形| `vault_trusted_device` 同形| —                                                       |
| `vault_audit` 同形         | `vault_audit` 同形         | AAD 拼装规则在 Rust 侧明确为两步写入（Go 当前未实现）   |

---

## 与谁衔接

- 下一篇：[`04-crypto-contract.md`](./04-crypto-contract.md) —— 加密原语与零化策略
- 相关：[`05-vault-service-api.md`](./05-vault-service-api.md) —— 上层 API 如何调用本 schema
- 相关：[`13-migration-checklist.md`](./13-migration-checklist.md) —— 从 Go JSON 导入时的字段映射
