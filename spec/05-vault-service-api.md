# 05 — VaultService API

## 1. 角色定位

`zpass-vault-service` 是 vault 的**高层 API**。它：

- 不 import `gpui` / `rusqlite` / `windows-sys` / `tokio` / `reqwest` / `breach*`。
- 通过 `VaultStore` trait 持有底层存储；通过 `Vec<Box<dyn VaultEventSink>>` 持有事件订阅者。
- 是同步、阻塞、线程安全（内部用 `parking_lot::RwLock` 保护 DEK + 单调时间戳）。

---

## 2. 公开类型

```rust
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub item_count: usize,  // 仅 unlocked = true 时有意义；locked 永远 0
}

pub enum VaultError {
    NotInitialized,
    AlreadyInitialized,
    Locked,
    InvalidPassword,          // 主密码错误（所有 AEAD/KDF 失败统一翻译为此）
    PasswordTooWeak,          // < 8 字符
    ItemNotFound,
    InvalidItemType,
    InvalidItemId,
    Storage(StoreError),      // 透传
    Crypto(CryptoError),      // 仅在内部错误（如 random 失败）时出现
    Internal(String),
}

pub struct ItemSummary {
    pub id: String,
    pub r#type: ItemType,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_totp: bool,
}

pub struct NewItem {
    pub r#type: ItemType,
    pub name: String,
    pub fields: BTreeMap<String, FieldValue>,
}
```

---

## 3. 方法清单

```rust
impl<S: VaultStore> VaultService<S> {
    pub fn new(store: S, sinks: Vec<Box<dyn VaultEventSink>>) -> Self;

    // 状态查询
    pub fn status(&self) -> Result<VaultStatus, VaultError>;
    pub fn is_unlocked(&self) -> bool;

    // 初始化与解锁
    pub fn initialize(&self, password: &str) -> Result<(), VaultError>;
    pub fn unlock(&self, password: &str) -> Result<(), VaultError>;
    pub fn unlock_with_dek(&self, dek: Zeroizing<[u8; 32]>) -> Result<(), VaultError>;
    pub fn lock(&self) -> Result<(), VaultError>;
    pub fn change_master_password(&self, old: &str, new: &str) -> Result<(), VaultError>;

    // Trusted-device 启用专用（导出 DEK 给桌面层包装）
    pub fn export_dek_with_master_password(&self, password: &str) -> Result<Zeroizing<[u8; 32]>, VaultError>;

    // CRUD
    pub fn list_items(&self) -> Result<Vec<ItemSummary>, VaultError>;
    pub fn get_item(&self, id: &str) -> Result<ItemPayloadV1, VaultError>;
    pub fn create_item(&self, item: NewItem) -> Result<ItemSummary, VaultError>;
    pub fn update_item(&self, item: ItemPayloadV1) -> Result<ItemSummary, VaultError>;
    pub fn delete_item(&self, id: &str) -> Result<(), VaultError>;

    // 子系统 hook（不暴露 DEK，返回解密后的密钥字节）
    pub fn decrypt_ssh_private_key(&self, item_id: &str) -> Result<Zeroizing<Vec<u8>>, VaultError>;
    pub fn advance_hotp_counter(&self, item_id: &str) -> Result<u64, VaultError>;
    pub fn append_audit(&self, entry: AuditEntry) -> Result<i64, VaultError>;
    pub fn list_audit(&self, limit: usize) -> Result<Vec<AuditEntry>, VaultError>;
}
```

---

## 4. 关键流程

### 4.1 `initialize`

> 与 Go `VaultService.Initialize` 等价（`desktop/vaultservice.go:515`）

```
取 write lock
检查 store.has_meta() == false 否则 → AlreadyInitialized
随机生成 salt(32) + dek(32)
params = Argon2idParams::default_desktop()
kek = derive_kek(password.as_bytes(), &salt, &params)
wrapped_dek = seal_aead(&kek, &dek, AAD_DEK)
verifier = seal_aead(&dek, b"zpass-vault-verifier-v1", AAD_VERIFIER)
now = self.now_ms()
store.write_meta(VaultMetaBlob { schema_version: 1, kdf: "argon2id", salt, params, wrapped_dek, verifier, created_at: now, updated_at: now })
self.dek = Some(dek)
emit VaultEvent::Unlocked
```

### 4.2 `unlock`

> 与 Go `VaultService.Unlock` 等价（`desktop/vaultservice.go:634`），**包括「永不走 dek != None 的幂等捷径」的安全要求**。

```
取 write lock
meta = store.read_meta()? .ok_or(NotInitialized)
kek = derive_kek(password.as_bytes(), &meta.salt, &meta.params)  // 失败 → InvalidPassword（模糊）
dek_bytes = open_aead(&kek, &meta.wrapped_dek, AAD_DEK)?           // 失败 → InvalidPassword
verifier_plain = open_aead(&dek_bytes, &meta.verifier, AAD_VERIFIER)?  // 失败 → InvalidPassword
if verifier_plain != b"zpass-vault-verifier-v1": → InvalidPassword
old_dek = self.dek.take()
self.dek = Some(dek_bytes.into_array())
drop(old_dek)  // Zeroize 自动抹零
emit VaultEvent::Unlocked
```

**注意**：合法用户在已解锁状态下再次调用 unlock 时输错密码，**不**清掉现有 `self.dek` —— 错误尝试不应打断已建立的会话。

### 4.3 `unlock_with_dek`（trusted-device 入口）

```
取 write lock
meta = store.read_meta()? .ok_or(NotInitialized)
// 必须用 verifier 验证 DEK 正确
verifier_plain = open_aead(&dek, &meta.verifier, AAD_VERIFIER)?
if verifier_plain != b"zpass-vault-verifier-v1": → InvalidPassword（即便来源是 trusted-device blob，也应模糊化失败）
self.dek = Some(dek)
emit VaultEvent::Unlocked
```

> 这是桌面层在 trusted-device 自动解锁路径上调的；详见 `10-trusted-device.md`。

### 4.4 `change_master_password`

> 与 Go 一致：仅重派生 KEK 并重新包装 DEK，所有 `vault_items.payload` 完全不动。

```
取 write lock
meta = store.read_meta()?
old_kek = derive_kek(old_password, &meta.salt, &meta.params)
dek_bytes = open_aead(&old_kek, &meta.wrapped_dek, AAD_DEK)?   // 失败 → InvalidPassword
verify(dek_bytes 解 verifier)
// 切换到当前推荐参数 + 新 salt
new_salt = random_bytes(SALT_SIZE)
new_params = Argon2idParams::default_desktop()
new_kek = derive_kek(new_password, &new_salt, &new_params)
new_wrapped = seal_aead(&new_kek, &dek_bytes, AAD_DEK)
new_verifier = seal_aead(&dek_bytes, b"zpass-vault-verifier-v1", AAD_VERIFIER)
store.write_meta(VaultMetaBlob { ...new_salt, new_params, new_wrapped, new_verifier, updated_at: self.now_ms(), created_at: meta.created_at })
// dek 不变，self.dek 不动
emit VaultEvent::MasterPasswordChanged  // 让 SSH agent 等清缓存
```

> 由于 DEK 不变，所有现有 SSH 公钥 / passkey / passwords 仍能解密。

### 4.5 `lock`

```
取 write lock
if let Some(mut dek) = self.dek.take() {
    dek.zeroize();
}
emit VaultEvent::Locked
```

---

## 5. 单调时间戳（`now_ms`）

> 与 Go `nowMs()` 等价（`desktop/vaultservice.go:434-442`）

```rust
struct VaultServiceInner {
    last_ts_ms: i64,  // 受 write lock 保护
    // ...
}

fn now_ms(&self) -> i64 {
    let wall = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let next = wall.max(self.inner.last_ts_ms + 1);
    self.inner.last_ts_ms = next;
    next
}
```

调用方约束：**所有写路径**（initialize / create_item / update_item / change_master_password / append_audit）都用 `now_ms()`，不直接调 `SystemTime::now()`。

测试：`test_now_ms_strictly_monotonic_within_same_ms`（连续 100 次调用，每次结果 > 前一次）。

---

## 6. CRUD 实现细节

### 6.1 `create_item`

```
取 read lock 验证 dek != None；释放
... 计算 id = Uuid::new_v4().to_string()
payload_plain = ItemPayloadV1 { id, type, name, fields, created_at: now, updated_at: now }
encoded = ciborium::ser::into_vec(&payload_plain)
encrypted = seal_aead(self.dek_ref(), &encoded, id.as_bytes())
store.insert_item(VaultItemRow { id, payload: encrypted, created_at: now, updated_at: now })
emit VaultEvent::ItemCreated { id, item_type: type }
return ItemSummary { ... }
```

### 6.2 `get_item` / `list_items`

`list_items` 必须解密所有 row 才能给出 `name + type + has_totp`。这是「全列加密」决策的必然代价。性能预算见 `12-testing-strategy.md` § 性能基线。

### 6.3 `update_item`

```
现有 row = store.get_item(id)? .ok_or(ItemNotFound)
new_payload = ItemPayloadV1 { id, ...input, created_at: 现有 row.created_at(不可变), updated_at: now }
encrypted = seal_aead(dek, encoded, id.as_bytes())
store.update_item(VaultItemRow { id, payload: encrypted, updated_at: now, /* created_at 不传 */ })
emit VaultEvent::ItemUpdated { id }
```

> 与 Go 一致：`created_at` 是不可变事实，UPDATE 时不在 SQL SET 列表里出现。

### 6.4 `delete_item`

```
store.delete_item(id)?  // 失败 ItemNotFound 透传
emit VaultEvent::ItemDeleted { id }
```

---

## 7. `decrypt_ssh_private_key`（SSH agent 签名链路用）

```rust
pub fn decrypt_ssh_private_key(&self, item_id: &str) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let payload = self.get_item(item_id)?;
    if payload.r#type != ItemType::Ssh {
        return Err(VaultError::InvalidItemType);
    }
    match payload.fields.get("private_key") {
        Some(FieldValue::Text(s)) => Ok(Zeroizing::new(s.as_bytes().to_vec())),
        Some(FieldValue::Bytes(b)) => Ok(Zeroizing::new(b.clone())),
        _ => Err(VaultError::ItemNotFound),
    }
}
```

返回 `Zeroizing<Vec<u8>>`：SSH agent host 拿到后立即用来 sign，sign 完 drop 即抹零。**不**把 DEK 暴露给 SSH agent。

---

## 8. `advance_hotp_counter`

详见 [`06-otp.md`](./06-otp.md) § HOTP 计数器持久化。注意点：

- 需要 read-modify-write 原子性：vault 的写锁内部完成。
- HOTP 没有「未达到目标 counter 跳过」的概念；每次调用 += 1。

---

## 9. 错误模糊化（与 Go 一致）

| 内部失败              | 对外错误                  |
| --------------------- | ------------------------- |
| Argon2id 派生失败     | `InvalidPassword`         |
| 解 `wrapped_dek` 失败 | `InvalidPassword`         |
| 解 `verifier` 失败    | `InvalidPassword`         |
| verifier 明文不匹配   | `InvalidPassword`         |
| store 读 io 失败      | `Storage(StoreError::Io)` |
| meta 不存在           | `NotInitialized`          |

---

## 10. 锁与并发

```rust
pub struct VaultService<S> {
    store: S,
    inner: RwLock<Inner>,   // parking_lot::RwLock
    sinks: Vec<Box<dyn VaultEventSink>>,
    hotp_advance_mu: Mutex<()>,   // 与 inner 锁互不嵌套；锁顺序：先 hotp_advance_mu，再 inner
}

struct Inner {
    dek: Option<Zeroizing<[u8; 32]>>,
    last_ts_ms: i64,
}
```

锁约定：

- 读路径（`status / list_items / get_item / decrypt_ssh_private_key`）取 `inner.read()`。
- 写路径取 `inner.write()`。
- `advance_hotp_counter` 先锁 `hotp_advance_mu`，再正常走读 + 写（内部锁顺序：先 outer mutex、再 inner RwLock）。

> 这与 Go 的 `s.mu sync.RWMutex` + `hotpAdvanceMu sync.Mutex` 设计完全等价。

---

## 11. 与谁衔接

- 上一篇：[`04-crypto-contract.md`](./04-crypto-contract.md)
- 下一篇：[`05a-vault-event-model.md`](./05a-vault-event-model.md) —— `VaultEventSink` 的 trait 与订阅者
- 相关：[`06-otp.md`](./06-otp.md) / [`08-ssh-agent.md`](./08-ssh-agent.md)
