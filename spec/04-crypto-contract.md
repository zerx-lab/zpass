# 04 — 加密契约（`zpass-crypto`）

## 1. 算法选型（不容妥协）

| 用途              | 算法                       | crate                          | features                          |
| ----------------- | -------------------------- | ------------------------------ | --------------------------------- |
| 密码派生（KDF）   | Argon2id                   | `argon2` (RustCrypto)          | `default-features = false`，`alloc` |
| AEAD              | XChaCha20-Poly1305         | `chacha20poly1305` (RustCrypto)| `default-features = false`，`alloc` |
| 安全随机          | OS CSPRNG                  | `getrandom`                    | 默认                              |
| 内存抹零          | `Zeroize` trait            | `zeroize`                      | `derive`                          |
| HKDF（仅本 crate 内部，如需要） | HKDF-SHA256       | `hkdf` (RustCrypto)            | `no_std`                          |

> 与 Go 版（`golang.org/x/crypto/argon2` + `golang.org/x/crypto/chacha20poly1305`）算法层完全等价；migrtion 不必跨算法重派生。

---

## 2. `no_std + alloc` 硬约束

`zpass-crypto` crate 的 `lib.rs` 顶部：

```rust
#![no_std]
extern crate alloc;
```

**禁止**出现：

- `use std::*`
- `std::fs::*` / `std::io::*` / `std::path::*`
- `tokio::*` / 任何异步运行时
- 任何 `println!` / `eprintln!`

CI 必须包含一条命令验证：

```
cargo check -p zpass-crypto --target thumbv7em-none-eabihf --no-default-features
```

> 选 `thumbv7em-none-eabihf` 是因为它是常见的 no_std 嵌入式 target；只要 crate 在它上面能 `check`，就足以证明没有意外 std 依赖。Android / iOS target 本身是 std target，无法用同样的方法验证「不依赖 std」。

---

## 3. 参数默认值与边界

```rust
pub struct Argon2idParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u8,
    pub key_len: u32,
}

impl Argon2idParams {
    pub fn default_desktop() -> Self {
        Self {
            memory_kib: 64 * 1024,  // 64 MiB
            iterations: 3,
            parallelism: 4,
            key_len: 32,
        }
    }
}
```

`validate()` 拒绝条件（与 Go 一致，防御被外部篡改写入弱参数）：

| 字段          | 拒绝条件                |
| ------------- | ----------------------- |
| `memory_kib`  | `< 8 * 1024`（< 8 MiB） |
| `iterations`  | `< 1`                   |
| `parallelism` | `< 1`                   |
| `key_len`     | `!= 32`                 |

---

## 4. AEAD 输出布局

`seal_aead` 输出：

```
[ 24 bytes nonce ] [ ciphertext ] [ 16 bytes Poly1305 tag ]
```

nonce 由 `getrandom` 生成。**禁止**计数器风格 nonce —— XChaCha20 的 24 字节 nonce 设计就是为了「每次随机」的统计安全。

`open_aead` 反向：取前 24 字节为 nonce、剩余整体喂给 `chacha20poly1305::XChaCha20Poly1305::decrypt`。

---

## 5. 错误模糊化

任何解密失败都返回**同一个**错误：

```rust
pub enum CryptoError {
    Internal,                // 真正的内部错误（不应在生产路径出现）
    InvalidLength { what: &'static str, expected: usize, got: usize },
    AuthFailed,              // 所有 AEAD 失败 / Argon2 派生失败 / 参数非法 → 统一为此
}
```

上层 `VaultService::unlock` 把 `AuthFailed` 翻译为 `VaultError::InvalidPassword`，对前端**永远**返回相同的「主密码错误」错误信息。`unlock` 流程内的所有失败路径（`derive_kek` 失败 / wrap-dek 解密失败 / verifier 解密失败 / verifier 明文不匹配）都不区分。

---

## 6. 零化策略

| 数据                          | 何时抹零                                              |
| ----------------------------- | ----------------------------------------------------- |
| **KEK**（每次解锁派生）       | 解锁流程结束时 `drop(Zeroizing<[u8;32]>)`             |
| **DEK**（解锁后驻留 `VaultService`） | `Lock()` 调用时显式 `dek.zeroize()`；进程退出由 `Drop` 兜底 |
| **明文 password 字符串**      | 调用方应在调用 `unlock(&str)` 后立即 drop；本 crate 仅作为 `&[u8]` 接收 |
| **解密返回的 `Vec<u8>`**       | 函数返回 `Zeroizing<Vec<u8>>`，调用方使用完自动抹零   |
| **CBOR 反序列化中间结构**     | 仅在调用方持有的栈上；调用方负责 drop                 |

> **注意**：Rust 的 `Zeroizing<T>` 不保证编译器不做拷贝优化（特别是 `String` 与 `Vec` 的扩容场景）。`zpass-crypto` 在涉及密钥的 buffer 一律采用 `Zeroizing<[u8; 32]>` 固定栈数组 + 显式 `.clone_from_slice()`，**不**让 buffer 在堆上扩容。

---

## 7. 弱 KDF 测试用法（关键安全设计）

**不**使用 cargo feature `weak-kdf`（cargo features 是加性的，下游意外启用会污染生产）。

替代方案 ① — `pub fn` 仅 `#[cfg(test)]` 可见：

```rust
// crates/zpass-crypto/src/argon2id.rs

#[cfg(test)]
pub fn test_params_unsafe_do_not_use_in_production() -> Argon2idParams {
    Argon2idParams {
        memory_kib: 8 * 1024,   // 8 MiB（仍然过 validate 的下限）
        iterations: 1,
        parallelism: 1,
        key_len: 32,
    }
}
```

> 因为函数名包含 `_unsafe_do_not_use_in_production`，跨 crate 测试时一眼能在 review 中看出问题。

替代方案 ② —— 让 `Argon2idParams` 是 pub 字段的简单 struct，外部测试可以自由构造（如 `crates/zpass-vault-service/tests/restart_survives.rs` 就直接 literal 构造）。

**禁止**：
- 在 `Cargo.toml` 加 `[features] weak-kdf = []`。
- 在 `lib.rs` 加 `#[cfg(feature = "weak-kdf")]` 分支。

---

## 8. `Zeroizing<T>` 与 Rust 编译器的边界

Rust / LLVM 在某些情况下会复制 buffer（`vec.clone()`、`String::push_str` 扩容、await point 跨线程保存）。`Zeroize` trait 只能保证**显式 drop 时**抹零；中间副本无法触及。

减缓措施：

1. 密钥 buffer 一律用栈上 `[u8; 32]`，不用 `Vec<u8>`。
2. 解锁 / 解密的密钥参数走借用（`&[u8; 32]`），不 clone。
3. **不**在 vault-service 路径上引入 `async`，避免跨 await 点保存的密钥副本被 stack 拷贝。
4. 进程级 `mlock` / `VirtualLock` 不做（跨平台代价高、对 Wails / GPUI 进程的 webview 共享内存场景无意义；Go 版本同样未做）。

---

## 9. CSPRNG 失败处理

`getrandom` 在主流桌面 OS 上几乎不可能失败。一旦失败：

- **不**回退到 `rand::thread_rng()`（PRNG 不是 CSPRNG）。
- **不**重试。
- 返回 `CryptoError::Internal`，让上层把 vault 初始化 / 解锁 / 加密路径直接失败。

---

## 10. 测试矩阵（在本 crate 内）

| 测试                                  | 断言                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `argon2id_known_vector`               | RFC 9106 测试向量逐位匹配                                                             |
| `argon2id_params_validate_rejects_weak`| `memory_kib = 4 * 1024` / `iterations = 0` 等被 `validate()` 拒绝                     |
| `aead_round_trip`                     | 任意 plaintext + aad，`open(seal(p, aad), aad) == p`                                  |
| `aead_aad_mismatch_fails`             | `open(seal(p, aad_a), aad_b)` 返回 `AuthFailed`                                       |
| `aead_tampered_ct_fails`              | 翻转密文一字节后 `open` 返回 `AuthFailed`                                             |
| `aead_truncated_fails`                | sealed 少于 24+16 字节直接报错                                                        |
| `random_bytes_nonzero`                | 100 次调用，结果集去重后 size > 90                                                    |
| `zeroize_after_drop`                  | 用 unsafe transmute 后断言底层字节为 0（仅在 Linux + 非优化模式跑，用 `#[ignore]` 默认关）|

详细的「跨 crate」回归用例（AEAD 防搬移、change-password 后 DEK 不变等）在 `zpass-vault-service` 的 tests 目录，见 `12-testing-strategy.md`。

---

## 与谁衔接

- 上一篇：[`03-vault-format.md`](./03-vault-format.md) —— AAD 常量与 schema
- 下一篇：[`05-vault-service-api.md`](./05-vault-service-api.md) —— 谁调用 crypto crate
