# 06 — OTP（`zpass-otp`）

## 1. 范围

支持 RFC 6238 TOTP、RFC 4226 HOTP、Steam Guard 三种一次性密码，与 Go 版（`desktop/totpservice.go`）功能等价。

`zpass-otp` **是纯计算 crate**：

- 输入：`secret_base32`、算法参数、时间或计数器；
- 输出：`OtpCode`（数字字符串 + 剩余秒 / 计数器）；
- **不**访问 vault、**不**访问文件系统、**不**异步、**不**`std`。

HOTP 计数器持久化由 `VaultService::advance_hotp_counter` 负责（详见本文 § 4）。

---

## 2. 公开 API

```rust
pub enum OtpAlgorithm { Sha1, Sha256, Sha512 }
pub enum OtpType { Totp, Hotp, Steam }

pub struct OtpInput<'a> {
    pub secret_base32: &'a str,
    pub algorithm: OtpAlgorithm,
    pub digits: u8,        // TOTP/HOTP 默认 6；Steam 默认 5
    pub period_sec: u32,   // 仅 TOTP / Steam 使用
    pub counter: Option<u64>,  // 仅 HOTP 使用
}

pub struct OtpCode {
    pub code: String,
    pub r#type: OtpType,
    pub period: u32,        // HOTP 此字段 0
    pub remaining: u32,     // HOTP 此字段 0；TOTP/Steam: period - (now_sec % period)
    pub counter: u64,       // TOTP/Steam 此字段 0
    pub algorithm: OtpAlgorithm,
    pub digits: u8,
}

pub fn totp(input: &OtpInput, unix_seconds: u64) -> Result<OtpCode, OtpError>;
pub fn hotp(input: &OtpInput) -> Result<OtpCode, OtpError>;
pub fn steam_guard(secret_base32: &str, unix_seconds: u64) -> Result<OtpCode, OtpError>;
pub fn parse_otpauth_uri(uri: &str) -> Result<ParsedOtp, OtpError>;

pub struct ParsedOtp {
    pub r#type: OtpType,
    pub secret_base32: String,
    pub algorithm: OtpAlgorithm,
    pub digits: u8,
    pub period_sec: u32,
    pub counter: Option<u64>,
    pub issuer: Option<String>,
    pub account: Option<String>,
}

pub enum OtpError {
    InvalidSecret,          // base32 解码失败
    InvalidDigits,          // 不在 6..=10
    InvalidPeriod,          // 0
    InvalidUri,             // otpauth:// 解析失败
    UnsupportedAlgorithm,
}
```

---

## 3. 输入宽容处理

Base32 secret 接受：

- 大小写混合 → 统一转大写
- 含空格 → 去除
- 含等号填充 → 去除（再依赖 `data-encoding` 的 `BASE32_NOPAD`）

```rust
fn normalize_base32(input: &str) -> String {
    input.chars().filter(|c| !c.is_whitespace() && *c != '=').map(|c| c.to_ascii_uppercase()).collect()
}
```

---

## 4. HOTP 计数器持久化（关键设计）

> 这是 v1 唯一跨 crate 的细节，必须读懂避免设计错。

### 4.1 问题

HOTP 每次生成验证码后**必须**把 counter 持久化 +1，否则下次按钮没反应（同 counter 永远生成同 code）。

### 4.2 分工

| crate                                | 责任                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `zpass-otp`                          | 提供纯计算函数 `hotp(input)`；不知道 counter 从哪儿来 / 存到哪去                                |
| `zpass-vault-service`                | 提供 `advance_hotp_counter(item_id) -> Result<u64, _>`：在持有 `hotp_advance_mu` 的串行临界区内完成「读 item → 取 counter → +1 → 写回 item」，返回**新 counter** 给调用方。**不**调用 `zpass-otp` —— 保持 vault-service 对 OTP crate 零依赖（spec/02 § 4）。 |
| 调用方（桌面 `services/otp.rs`、native bridge） | 串行流程：先调 `vault.advance_hotp_counter(id)` 拿 `new_counter`，再调 `vault.get_item(id)` 读 secret/algorithm/digits 等字段，最后用 `zpass_otp::hotp(...)` 计算 `OtpCode`。两次调用之间另一个并发 advance 可能把 counter 推得更高——这对 UI 仅是「显示的可能不是自己刚 advance 那一拍的 code」，不会破坏 vault 状态。 |

> **设计取舍**：早期 spec 草案让 `advance_hotp_counter` 直接返回 `HotpAdvanceResult { OtpCode, new_counter, ItemSummary }`，避免上层第二次 `get_item`。改回 `u64` 是为了：
> 1. 让 `zpass-vault-service` 严格无 `zpass-otp` 依赖（spec/02 § 4 列出的 5 个直接依赖不含 otp）。
> 2. 让 vault-service 保持 `no_std + alloc` 友好，移动端可复用度更高。
> 3. spec/02 是更早确立的依赖底线（README 第 2 条：编号更小的文档优先）。

### 4.3 `advance_hotp_counter` 锁顺序

> 与 Go `desktop/vaultservice.go:317-336` 等价。

```rust
pub fn advance_hotp_counter(&self, item_id: &str) -> Result<u64, VaultError> {
    let _hotp_guard = self.hotp_advance_mu.lock();  // 串行所有 HOTP advance
    // 此时不持有 inner.write()
    let mut payload = self.get_item(item_id)?;     // 内部取 inner.read()
    let counter = payload.fields.get("hotp_counter")
        .and_then(|v| if let FieldValue::Number(n) = v { Some(*n as u64) } else { None })
        .unwrap_or(0);
    let next = counter.checked_add(1).ok_or(VaultError::InvalidItemType)?;
    payload.fields.insert("hotp_counter".into(), FieldValue::Number(next as i64));
    self.update_item(payload)?;                    // 内部取 inner.write()
    Ok(next)
}
```

> 锁顺序：先 `hotp_advance_mu`，再 inner 锁（顺序由 vault-service 内部统一控制）。

### 4.4 为什么不让 `zpass-otp` 直接持有 store？

- 会让 `zpass-otp` 拉进 SQLite 依赖，移动端 / no_std 全废。
- 计数器持久化是 vault 的事务范畴，应该和「修改 item」走同一条原子写路径。
- 满足分工原则：纯计算与业务编排分离。

---

## 5. Steam Guard

字母表：`23456789BCDFGHJKMNPQRTVWXY`（25 字符，去除易混淆字符）。

```rust
fn steam_guard_truncate(hmac_bytes: &[u8]) -> String {
    let offset = (hmac_bytes[hmac_bytes.len() - 1] & 0x0F) as usize;
    let bin_code = u32::from_be_bytes([
        hmac_bytes[offset] & 0x7F,
        hmac_bytes[offset + 1],
        hmac_bytes[offset + 2],
        hmac_bytes[offset + 3],
    ]);
    let alphabet = b"23456789BCDFGHJKMNPQRTVWXY";
    let mut code = String::with_capacity(5);
    let mut x = bin_code;
    for _ in 0..5 {
        code.push(alphabet[(x as usize) % alphabet.len()] as char);
        x /= alphabet.len() as u32;
    }
    code
}
```

---

## 6. `otpauth://` URI 解析

格式：
```
otpauth://TYPE/LABEL?secret=BASE32&issuer=NAME&algorithm=SHA1&digits=6&period=30&counter=0
```

| 字段        | 来源                                                                          |
| ----------- | ----------------------------------------------------------------------------- |
| `type`      | URI 第一段（`totp` / `hotp` / `steam`；后者非标准但常见）                     |
| `secret`    | query `secret`（必填）                                                         |
| `algorithm` | query `algorithm`（默认 SHA1）                                                |
| `digits`    | query `digits`（默认 6）                                                      |
| `period`    | query `period`（默认 30）                                                     |
| `counter`   | query `counter`（仅 HOTP 必填）                                               |
| `issuer`    | query `issuer` 优先；否则 LABEL 的 `Issuer:Account` 前段                       |
| `account`   | LABEL 的 `Account` 部分                                                       |

---

## 7. 测试

| 测试                                  | 来源                                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| `totp_rfc6238_vectors`                | RFC 6238 Appendix B 标准向量（T0=0, T=59 / 1111111109 / ...）         |
| `hotp_rfc4226_vectors`                | RFC 4226 Appendix D 标准向量（0–9）                                   |
| `steam_known_vector`                  | 与 Steam Mobile Authenticator 比对的开源向量                          |
| `base32_normalize_strips_whitespace`  | `"AABB CCDD\t"` → `"AABBCCDD"`                                        |
| `parse_otpauth_uri_login`             | 完整 query 解析                                                       |
| `parse_otpauth_uri_hotp_with_counter` | `counter` 必填校验                                                    |
| `digits_8_round_trip`                 | digits = 8 时输出确为 8 位                                            |

---

## 8. 与谁衔接

- 上一篇：[`05a-vault-event-model.md`](./05a-vault-event-model.md)
- 下一篇：[`07-passkey.md`](./07-passkey.md)
- 相关：[`05-vault-service-api.md`](./05-vault-service-api.md) `advance_hotp_counter`
