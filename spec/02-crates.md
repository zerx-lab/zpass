# 02 — Crate 清单（权威版）

> 每个 crate 一节，包含：路径 · 一句话职责 · 移动端可复用 · 直接依赖 · 公开 API 摘要 · 禁忌。
>
> **依赖图**已在 `01-architecture.md` § 4 给出，本文聚焦每个 crate 的内部约束。

---

## 1. `zpass-crypto`

- **路径**：`crates/zpass-crypto/`
- **一句话**：把 Argon2id KDF、XChaCha20-Poly1305 AEAD、安全随机、内存抹零等密码学原语包装成上层好用的 API。
- **移动端可复用**：✅ `no_std + alloc`（无 `std`、无文件 IO、无系统调用，仅 `getrandom` 通过 crate feature 适配各平台）
- **直接依赖**：
  - `argon2` (RustCrypto) — `default-features = false`
  - `chacha20poly1305` (RustCrypto) — `default-features = false`，启用 `alloc`
  - `getrandom` — 提供 `OsRng`
  - `zeroize` + `zeroize_derive`
  - `rand_core`
  - **不允许**：`std::*` 路径、任何 IO、任何 sqlite / async
- **公开 API**（详见 `04-crypto-contract.md`）：
  ```rust
  pub const KEY_SIZE: usize = 32;
  pub const NONCE_SIZE: usize = 24;
  pub const SALT_SIZE: usize = 32;

  pub struct Argon2idParams { pub memory_kib: u32, pub iterations: u32, pub parallelism: u8, pub key_len: u32 }
  impl Argon2idParams { pub fn default_desktop() -> Self; pub fn validate(&self) -> Result<(), CryptoError>; }

  pub fn derive_kek(password: &[u8], salt: &[u8], params: &Argon2idParams) -> Result<Zeroizing<[u8; 32]>, CryptoError>;
  pub fn random_bytes(n: usize) -> Result<Vec<u8>, CryptoError>;
  pub fn seal_aead(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError>;
  pub fn open_aead(key: &[u8; 32], sealed: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError>;
  ```
- **禁忌**：
  - 不暴露任何 KDF 「快速参数」常量。测试参数通过 `#[cfg(test)] pub fn test_argon2id_params() -> Argon2idParams` 暴露在本 crate 内部测试。

---

## 2. `zpass-vault-format`

- **路径**：`crates/zpass-vault-format/`
- **一句话**：定义磁盘上的字节布局：`VaultMetaBlob` / `VaultItemPayload` 的 schema，加密 blob 字段顺序，AAD 上下文常量。
- **移动端可复用**：✅ `no_std + alloc`
- **直接依赖**：
  - `serde` (`default-features = false`，启用 `alloc` + `derive`)
  - `serde_cbor` 或 `ciborium`（移动端要 cbor，桌面端 JSON 走 vault-store，二选一，**推荐 ciborium**：积极维护，no_std 友好）
  - `zpass-crypto`
- **公开 API**：
  ```rust
  pub const AAD_DEK: &[u8] = b"zpass:dek";
  pub const AAD_VERIFIER: &[u8] = b"zpass:verifier";
  pub const AAD_AUDIT_PREFIX: &[u8] = b"zpass:audit:";

  pub fn item_aad(item_id: &str) -> Vec<u8>; // = format!("{}", item_id).as_bytes()

  pub struct VaultMetaBlob { /* 字段对应 SQL 列 */ }
  pub struct ItemPayloadV1 { pub id: String, pub r#type: ItemType, pub name: String, pub fields: BTreeMap<String, FieldValue>, pub created_at: i64, pub updated_at: i64 }
  pub fn encode_item_payload(p: &ItemPayloadV1) -> Vec<u8>;     // CBOR
  pub fn decode_item_payload(bytes: &[u8]) -> Result<ItemPayloadV1, FormatError>;
  ```
- **禁忌**：
  - 不感知 SQLite。SQLite schema 在 `zpass-vault-store`。
  - 不感知文件路径。所有 IO 由调用方完成。

---

## 3. `zpass-vault-store`

- **路径**：`crates/zpass-vault-store/`
- **一句话**：把 `VaultMetaBlob` / `VaultItemRow` / `TrustedDeviceRow` / `AuditRow` 落到 SQLite。
- **移动端可复用**：⚠️ 桌面专用（SQLite + std）。移动端复用的是它实现的 `Store` trait，移动端可写另一个 store crate（如 sqlcipher / on-device store）。
- **直接依赖**：
  - `rusqlite`（`features = ["bundled", "blob"]`）— 见 `16-open-questions.md` 讨论
  - `zpass-vault-format`
  - `zpass-platform`（拿到 `~/.config/zpass/vault.db` 路径）
- **公开 API**：
  ```rust
  pub trait VaultStore {
      fn open(path: &Path) -> Result<Self, StoreError>;
      fn has_meta(&self) -> Result<bool, StoreError>;
      fn read_meta(&self) -> Result<Option<VaultMetaBlob>, StoreError>;
      fn write_meta(&self, meta: &VaultMetaBlob) -> Result<(), StoreError>;
      fn list_items(&self) -> Result<Vec<VaultItemRow>, StoreError>;
      fn get_item(&self, id: &str) -> Result<Option<VaultItemRow>, StoreError>;
      fn insert_item(&self, row: &VaultItemRow) -> Result<(), StoreError>;
      fn insert_item_batch(&self, rows: &[VaultItemRow]) -> Result<(), StoreError>;
      fn update_item(&self, row: &VaultItemRow) -> Result<(), StoreError>;
      fn delete_item(&self, id: &str) -> Result<(), StoreError>;
      // trusted device
      fn has_trusted_device(&self) -> Result<bool, StoreError>;
      fn read_trusted_device(&self) -> Result<Option<TrustedDeviceRow>, StoreError>;
      fn write_trusted_device(&self, row: &TrustedDeviceRow) -> Result<(), StoreError>;
      fn delete_trusted_device(&self) -> Result<(), StoreError>;
      // audit
      fn insert_audit(&self, row: &AuditRow) -> Result<i64, StoreError>;
      fn list_audit(&self, limit: usize) -> Result<Vec<AuditRow>, StoreError>;
      fn delete_all_audit(&self) -> Result<(), StoreError>;
      fn prune_audit(&self, keep: usize) -> Result<(), StoreError>;
  }

  pub struct SqliteVaultStore { /* ... */ }
  impl VaultStore for SqliteVaultStore { ... }
  ```
- **禁忌**：
  - 不感知加密。`Payload` 字段全是密文。
  - 不感知 vault 状态机（解锁与否）。

---

## 4. `zpass-vault-service`

- **路径**：`crates/zpass-vault-service/`
- **一句话**：把 crypto + store + 单调时间戳 + 事件总线粘成 `Initialize / Unlock / Lock / CRUD / ChangeMasterPassword / unlock_with_dek` 的对外 API。
- **移动端可复用**：✅ 仅依赖 trait（`VaultStore` + `VaultEventSink`）；不直接依赖 sqlite / trusted-device / browser-bridge / ssh-agent / gpui。
- **直接依赖**：
  - `zpass-crypto`
  - `zpass-vault-format`
  - `zpass-vault-store`（**仅依赖 `VaultStore` trait**；具体实现由调用方注入，移动端可换）
  - `parking_lot`（Mutex / RwLock；`no_std` 不需要时退到 `core::sync`）
  - `zeroize`
- **公开 API**（详见 `05-vault-service-api.md`）：
  ```rust
  pub struct VaultService<S: VaultStore> { /* ... */ }
  impl<S: VaultStore> VaultService<S> {
      pub fn new(store: S, sinks: Vec<Box<dyn VaultEventSink>>) -> Self;
      pub fn status(&self) -> Result<VaultStatus, VaultError>;
      pub fn initialize(&self, password: &str) -> Result<(), VaultError>;
      pub fn unlock(&self, password: &str) -> Result<(), VaultError>;
      pub fn unlock_with_dek(&self, dek: Zeroizing<[u8; 32]>) -> Result<(), VaultError>;
      pub fn lock(&self) -> Result<(), VaultError>;
      pub fn change_master_password(&self, old: &str, new: &str) -> Result<(), VaultError>;
      pub fn list_items(&self) -> Result<Vec<ItemSummary>, VaultError>;
      pub fn get_item(&self, id: &str) -> Result<ItemPayload, VaultError>;
      pub fn create_item(&self, p: NewItem) -> Result<ItemSummary, VaultError>;
      pub fn update_item(&self, p: ItemPayload) -> Result<ItemSummary, VaultError>;
      pub fn delete_item(&self, id: &str) -> Result<(), VaultError>;
      pub fn export_dek_with_master_password(&self, password: &str) -> Result<Zeroizing<[u8; 32]>, VaultError>; // trusted-device 启用专用：必须二次校验主密码，防止已劫持会话恶意启用
      pub fn decrypt_ssh_private_key(&self, item_id: &str) -> Result<Zeroizing<Vec<u8>>, VaultError>; // SSH 签名链路用
      pub fn advance_hotp_counter(&self, item_id: &str) -> Result<u64, VaultError>;
  }
  ```
- **禁忌**：
  - 不 import 任何 `*-trusted-device` / `*-browser-bridge` / `*-ssh-agent-*` / `gpui`。
  - 不 import `tokio` / `async-std`。
  - 不持有 `breachCache`、不引入 HIBP 任何形态的代码。

---

## 5. `zpass-otp`

- **路径**：`crates/zpass-otp/`
- **一句话**：纯计算 TOTP / HOTP / Steam Guard 验证码；**不**碰 vault、不碰文件 IO。
- **移动端可复用**：✅ `no_std + alloc`
- **直接依赖**：
  - `hmac`、`sha1`、`sha2`（RustCrypto，`default-features = false`）
  - `base32`（no_std 友好的实现，如 `data-encoding`）
- **公开 API**：
  ```rust
  pub struct OtpInput<'a> { pub secret_base32: &'a str, pub algorithm: OtpAlgorithm, pub digits: u8, pub period_sec: u32, pub counter: Option<u64> }
  pub fn totp(input: &OtpInput, unix_seconds: u64) -> Result<OtpCode, OtpError>;
  pub fn hotp(input: &OtpInput) -> Result<OtpCode, OtpError>;
  pub fn steam_guard(secret_base32: &str, unix_seconds: u64) -> Result<OtpCode, OtpError>;
  pub fn parse_otpauth_uri(uri: &str) -> Result<OtpInput<'_>, OtpError>;
  ```
- **禁忌**：
  - 不读写 vault。HOTP 计数器递增由 `VaultService::advance_hotp_counter` 负责（详见 `06-otp.md`）。

---

## 6. `zpass-passkey`

- **路径**：`crates/zpass-passkey/`
- **一句话**：WebAuthn ES256 凭据生成、CBOR / COSE 编码、断言签名；私钥材料的输入由调用方提供。
- **移动端可复用**：✅ `no_std + alloc`
- **直接依赖**：
  - `p256`（RustCrypto）— `default-features = false`，启用 `ecdsa` + `alloc`
  - `ciborium`（no_std 友好）
  - `sha2`（RustCrypto）
- **公开 API**：
  ```rust
  pub struct PasskeyKeypair { /* ES256 私钥 + 公钥 */ }
  pub fn generate_keypair() -> Result<PasskeyKeypair, PasskeyError>;
  pub fn cose_public_key(kp: &PasskeyKeypair) -> Vec<u8>;
  pub fn authenticator_data(rp_id_hash: &[u8; 32], sign_count: u32, flags: u8, attested_cred: Option<&AttestedCredential>) -> Vec<u8>;
  pub fn sign_assertion(kp: &PasskeyKeypair, auth_data: &[u8], client_data_hash: &[u8; 32]) -> Result<Vec<u8>, PasskeyError>;
  pub fn self_attestation_object(auth_data: &[u8]) -> Vec<u8>;
  ```
- **禁忌**：
  - 不 import vault crate（vault 调用本 crate）。

---

## 7. `zpass-trusted-device`

- **路径**：`crates/zpass-trusted-device/`
- **一句话**：跨平台「设备绑定密钥」包装 DEK 的能力抽象 + Windows DPAPI 实现 + macOS / Linux 的 `Unsupported` stub。
- **移动端可复用**：❌ 桌面专用
- **直接依赖**：
  - `windows-sys`（`cfg(target_os = "windows")`，启用 `Win32_Security_Cryptography`）
  - 无 macOS / Linux 系统依赖（仅 stub）
- **公开 API**：
  ```rust
  pub trait TrustedDeviceProtector {
      fn available(&self) -> bool;
      fn method(&self) -> &'static str;
      fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, TrustedDeviceError>;
      fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, TrustedDeviceError>;
  }

  pub const METHOD_DPAPI: &str = "dpapi";
  pub const METHOD_KEYCHAIN: &str = "keychain";   // 仅常量，无 v1 impl
  pub const METHOD_LIBSECRET: &str = "libsecret"; // 仅常量，无 v1 impl

  pub fn default_protector() -> Box<dyn TrustedDeviceProtector>;
  ```
- **禁忌**：
  - 不 import `zpass-vault-service` / `zpass-vault-store`。桌面层负责串联两者。

---

## 8. `zpass-ssh-agent-proto`

- **路径**：`crates/zpass-ssh-agent-proto/`
- **一句话**：`zpass-desktop`（控制端）与 `zpass-agent`（守护进程）之间的 wire protocol：消息类型、序列化、HMAC 鉴权 token、socket 路径解析。
- **移动端可复用**：⚠️ 协议本身可复用，但 SSH agent 在 mobile 场景没意义；移动端不实际编译。
- **直接依赖**：
  - `serde` + `serde_json` 或 `ciborium`（推荐 ciborium 与 vault-format 风格一致）
  - `hmac` + `sha2`
- **公开 API**：
  ```rust
  pub enum AgentMessage {
      Hello { token_hmac: Vec<u8> },
      OpState { unlocked: bool },
      PushKeys { keys: Vec<PublicKeyEntry> },
      SignRequest { key_blob: Vec<u8>, data: Vec<u8>, flags: u32, request_id: u64 },
      SignReply { request_id: u64, signature: Result<Vec<u8>, String> },
      AuditEntry { entry: AuditEntry },
  }
  pub fn read_message<R: Read>(r: &mut R) -> io::Result<AgentMessage>;
  pub fn write_message<W: Write>(w: &mut W, m: &AgentMessage) -> io::Result<()>;
  pub fn agent_socket_path() -> PathBuf;
  pub fn control_socket_path() -> PathBuf;
  pub fn load_or_create_capability() -> Result<CapabilityToken, ProtoError>;
  ```

---

## 9. `zpass-browser-bridge`

- **路径**：`crates/zpass-browser-bridge/`
- **一句话**：GUI 进程内的 loopback HTTP 服务（token 鉴权） + 浏览器扩展请求 / 响应类型 + 域名匹配 / 黑名单逻辑。
- **移动端可复用**：❌ 桌面专用
- **直接依赖**：
  - `tiny_http` 或 `axum`（**推荐 `tiny_http`**：极简、零异步、易理解；Go 版本用 `net/http` 也是同步）
  - `serde` + `serde_json`
  - `publicsuffix`（与 Go 的 `golang.org/x/net/publicsuffix` 对齐）
  - `subtle`（恒定时间 token 比较）
- **公开 API**：
  ```rust
  pub struct BrowserBridgeServer { /* ... */ }
  impl BrowserBridgeServer {
      pub fn start(vault: Arc<dyn VaultFacade>) -> Result<Self, BridgeError>;
      pub fn shutdown(self) -> Result<(), BridgeError>;
      pub fn port(&self) -> u16;
      pub fn config_path(&self) -> &Path;
  }

  /// 给 native-host 复用的纯协议类型
  pub mod proto { /* NativeEnvelope, NativeResponse, QueryLoginsResult, ... */ }
  pub mod domain { pub fn matches(saved: &str, current: &str) -> bool; }
  ```
- **禁忌**：
  - 该 crate 暴露的 `VaultFacade` trait **不直接 import** `zpass-vault-service`，由桌面层注入实现，保持桥可独立测试。

---

## 10. `zpass-config`

- **路径**：`crates/zpass-config/`
- **一句话**：原子 JSON 读写 `~/.config/zpass/<ns>.json`：写 tmp + fsync + rename，namespace 校验。
- **移动端可复用**：❌（桌面文件 IO；移动端有自己的设置存储）
- **直接依赖**：
  - `serde_json`（仅用于校验）
  - `zpass-platform`
- **公开 API**：
  ```rust
  pub fn config_dir() -> Result<PathBuf, ConfigError>;
  pub fn read(namespace: &str) -> Result<Option<String>, ConfigError>;
  pub fn write(namespace: &str, value: &str) -> Result<(), ConfigError>;
  pub fn remove(namespace: &str) -> Result<(), ConfigError>;
  ```

---

## 11. `zpass-platform`

- **路径**：`crates/zpass-platform/`
- **一句话**：路径解析、OS 检测、`~/.config/zpass/` 与 `XDG_RUNTIME_DIR/zpass/` 之类的公共常量。
- **移动端可复用**：⚠️ 部分可（OS 检测可），路径解析桌面优先。
- **直接依赖**：仅 `std`（避免 `dirs` / `directories` 把行为包得太死）。
- **公开 API**：
  ```rust
  pub fn config_root() -> Result<PathBuf, PlatformError>; // ~/.config/zpass/
  pub fn runtime_dir() -> Result<PathBuf, PlatformError>; // 平台对应运行时目录
  pub fn current_platform() -> Platform; // Linux | Windows | MacOS
  ```

---

## 12. `zpass-desktop`（bin）

- **路径**：`desktop_rs/zpass-desktop/`
- **一句话**：GPUI GUI 主程序；唯一持有 DEK 的进程；唯一 import GPUI 的 crate。
- **移动端可复用**：❌
- **直接依赖**：上面 1–11 全部（除 `zpass-ssh-agent-proto` 与 `zpass-browser-bridge` 中重复的 wire protocol 部分根据需要选取）
- 内部模块（不导出）：`services/` / `screens/` / `theme/` / `i18n/` / `windows/` 等

---

## 13. `zpass-agent`（bin）

- **路径**：`desktop_rs/zpass-agent/`
- **一句话**：独立 SSH agent 守护进程，监听 `SSH_AUTH_SOCK`，通过控制通道委托给 GUI 解密签名。
- **移动端可复用**：❌
- **直接依赖**：
  - `zpass-ssh-agent-proto`
  - `ssh-encoding` 或自实现的 SSH wire format（RFC 4251 § 5；agent protocol RFC 4256 / `draft-miller-ssh-agent`）
  - `zpass-platform`
- **禁忌**：
  - 不 import `zpass-vault-service` / `zpass-vault-store` / `zpass-crypto` 的解密能力 —— **agent 进程绝不持有 DEK**。仅持有公钥列表（GUI 推过来）。

---

## 14. `zpass-native-host`（bin）

- **路径**：`desktop_rs/zpass-native-host/`
- **一句话**：Chrome / Firefox / Edge stdio native-messaging 桥；把浏览器请求转给 GUI 内的 `zpass-browser-bridge` HTTP server。
- **移动端可复用**：❌
- **直接依赖**：
  - `zpass-browser-bridge::proto`（协议类型）
  - `ureq` 或类似的同步 HTTP 客户端（轻量，无 tokio）
  - `serde_json`
  - `zpass-platform`
- **禁忌**：
  - **不 import `gpui`**（决定性约束：Chrome native messaging 对启动延迟敏感）。
  - **不 import `zpass-vault-*`**。完全是协议转发器。
  - 编译产物体积目标：`< 5 MB`（启用 `lto = "thin"` + `strip = "debuginfo"` + `panic = "abort"`，详见 `14-build-and-validation.md`）。

---

## 总结表

| #   | crate                  | mobile | 直接依赖（除 std）                                  |
| --- | ---------------------- | ------ | --------------------------------------------------- |
| 1   | zpass-crypto           | ✅     | argon2, chacha20poly1305, getrandom, zeroize        |
| 2   | zpass-vault-format     | ✅     | crypto, ciborium, serde                             |
| 3   | zpass-vault-store      | ❌     | vault-format, rusqlite, platform                    |
| 4   | zpass-vault-service    | ✅     | crypto, vault-format, vault-store(trait), parking_lot, zeroize |
| 5   | zpass-otp              | ✅     | hmac, sha1, sha2, data-encoding                     |
| 6   | zpass-passkey          | ✅     | p256, ciborium, sha2                                |
| 7   | zpass-trusted-device   | ❌     | windows-sys (cfg windows)                           |
| 8   | zpass-ssh-agent-proto  | ⚠️     | ciborium, hmac, sha2                                |
| 9   | zpass-browser-bridge   | ❌     | tiny_http, serde_json, publicsuffix, subtle         |
| 10  | zpass-config           | ❌     | serde_json, platform                                |
| 11  | zpass-platform         | ⚠️     | （std only）                                        |
| 12  | zpass-desktop (bin)    | ❌     | gpui (commit pinned), 1–11                          |
| 13  | zpass-agent (bin)      | ❌     | ssh-agent-proto, ssh-encoding, platform             |
| 14  | zpass-native-host (bin)| ❌     | browser-bridge::proto, ureq, serde_json, platform   |

---

## 与谁衔接

- 下一篇：[`03-vault-format.md`](./03-vault-format.md) —— SQLite schema 与加密 blob 字节布局
- 相关：[`04-crypto-contract.md`](./04-crypto-contract.md) —— crypto crate 内部细节
