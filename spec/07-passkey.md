# 07 — Passkey（`zpass-passkey`）

## 1. 范围

实现 WebAuthn 中**桌面端 / vault 内的 authenticator 部分**：

- 生成 ES256 私钥（P-256 / ECDSA SHA-256）；
- 把私钥与元数据存到 vault item（`type = passkey`），不离开 vault 进程；
- 暴露注册所需的 `authenticatorData` + `attestationObject`（self attestation）；
- 暴露签名 / 断言；
- 持久化推进 `signCount`。

**不**实现：

- 浏览器内集成（通过 `zpass-native-host` + `zpass-browser-bridge` 在桌面层串联）；
- Windows / macOS 的系统 WebAuthn provider 注册（v2+）。

---

## 2. 算法 / 编码

| 项目              | 选择                               |
| ----------------- | ---------------------------------- |
| 密钥类型          | ECDSA P-256（COSE alg = `-7`）     |
| 公钥编码          | COSE Key（CBOR），同时输出 SPKI    |
| 签名格式          | ECDSA DER（与 WebAuthn 规范一致）  |
| Attestation       | self attestation（attStmt = `{}`）|
| Credential ID     | 32 字节随机                         |
| User Handle       | 调用方传入；为空时 32 字节随机生成 |

CBOR 库统一用 `ciborium`（与 `zpass-vault-format` 一致）。

---

## 3. 公开 API

```rust
pub struct PasskeyKeypair {
    pub private_key_pkcs8: Vec<u8>,  // PKCS#8 DER
    pub public_key_spki: Vec<u8>,    // SubjectPublicKeyInfo DER
    pub public_key_cose: Vec<u8>,    // COSE_Key CBOR
}

pub fn generate_keypair() -> Result<PasskeyKeypair, PasskeyError>;

pub struct RegistrationOutput {
    pub credential_id: Vec<u8>,         // 32 bytes
    pub keypair: PasskeyKeypair,
    pub authenticator_data: Vec<u8>,
    pub attestation_object: Vec<u8>,
    pub user_id: Vec<u8>,
}

pub fn create_registration(
    rp_id: &str,
    user_id: Option<&[u8]>,
    aaguid: &[u8; 16],   // 桌面 ZPass 固定 AAGUID，定义为 const
) -> Result<RegistrationOutput, PasskeyError>;

pub struct AssertionInput<'a> {
    pub rp_id: &'a str,
    pub keypair: &'a PasskeyKeypair,
    pub sign_count: u32,
    pub client_data_hash: &'a [u8; 32],
    pub user_present: bool,
    pub user_verified: bool,
}
pub struct AssertionOutput {
    pub authenticator_data: Vec<u8>,
    pub signature: Vec<u8>,             // ECDSA DER
    pub new_sign_count: u32,
}

pub fn sign_assertion(input: &AssertionInput) -> Result<AssertionOutput, PasskeyError>;

pub fn cose_to_spki(cose: &[u8]) -> Result<Vec<u8>, PasskeyError>;
pub fn spki_to_cose(spki: &[u8]) -> Result<Vec<u8>, PasskeyError>;

pub enum PasskeyError {
    KeyGenerationFailed,
    InvalidKey,
    InvalidCose,
    InvalidUri,
    InvalidLength,
    SigningFailed,
    Internal,
}
```

---

## 4. AAGUID

ZPass 桌面端固定 AAGUID（16 字节，UUID v4 风格，随机一次后写死）。

```rust
pub const ZPASS_DESKTOP_AAGUID: [u8; 16] = [
    /* 16 字节，Phase A 决定后写入；可放 const fn 从 hex 转 */
];
```

> Go 版本 `desktop/passkeyservice.go` 用了运行时常量；Rust 版本固定为编译期 const。

---

## 5. `authenticatorData` 字节布局

按 WebAuthn 规范 § 6.1：

```
[ 32 bytes rpIdHash = SHA256(rp_id) ]
[ 1  byte  flags    ]   // bit 0: UP, bit 2: UV, bit 6: AT, bit 7: ED
[ 4  bytes signCount big-endian ]
[ optional 16 bytes aaguid ]    // 仅 AT=1（注册）时
[ optional 2 bytes credIdLen + N bytes credId ]
[ optional COSE_Key bytes ]
```

实现细节见 `desktop/passkeyservice.go:35-46` 常量定义，与 Rust 完全等价。

---

## 6. `attestationObject`（self attestation）

CBOR map：

```cbor
{
  "fmt": "packed" 或 "none",
  "authData": <authenticator_data bytes>,
  "attStmt": <packed: { alg: -7, sig: <ecdsa der> } 或 none: {}>
}
```

v1 默认 `fmt = "none"` + `attStmt = {}` —— 这是 1Password 等密码管理器的实际选择，避免「self attestation 在某些 relying party 触发额外验证逻辑」。

---

## 7. signCount 持久化

每次 `sign_assertion`：

1. `zpass-passkey::sign_assertion` 输入旧 `sign_count`，输出 `new_sign_count = sign_count + 1`。
2. **调用方**（即桌面层的浏览器桥 handler）持久化新计数到 vault item：
   ```rust
   let mut payload = vault.get_item(item_id)?;
   let new_count = old_count + 1;
   payload.fields.insert("sign_count".into(), FieldValue::Number(new_count as i64));
   vault.update_item(payload)?;
   ```

这是与 HOTP counter 完全平行的设计 —— `zpass-passkey` 不知道 vault，持久化责任在桌面层（不在 vault-service 内置 `advance_sign_count`，因为 vault-service 不应感知 passkey 字段语义）。

---

## 8. ItemPayload `type = passkey` 的字段

（与 `03-vault-format.md` § 6.2 表格中 passkey 行一致）

| 字段                  | 类型           | 说明                                            |
| --------------------- | -------------- | ----------------------------------------------- |
| `rp_id`               | Text           | Relying Party 域名                              |
| `rp_name`             | Text           | RP 显示名（可选）                               |
| `credential_id`       | Text           | base64url 编码                                  |
| `private_key_pkcs8`   | Bytes          | PKCS#8 DER 私钥                                 |
| `public_key_cose`     | Bytes          | COSE_Key CBOR 公钥                              |
| `public_key_spki`     | Bytes          | SPKI DER（冗余，便于浏览器扩展 verify 用）      |
| `algorithm`           | Text           | `"ES256"`                                       |
| `sign_count`          | Number         | 当前签名计数                                    |
| `user_id`             | Bytes          | 用户句柄（注册时确定）                          |
| `user_name`           | Text           | 可选                                            |
| `user_display_name`   | Text           | 可选                                            |
| `transports`          | Bytes (CBOR 数组) | 例如 `["internal"]`                            |
| `aaguid`              | Bytes          | 固定 ZPASS_DESKTOP_AAGUID                       |

---

## 9. 测试

| 测试                                  | 断言                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| `generate_keypair_round_trip`         | 生成 → 签 → 用 SPKI verify 通过                                    |
| `cose_spki_round_trip`                | `cose_to_spki(spki_to_cose(x)) == x`                                |
| `auth_data_layout`                    | 注册输出的前 32 字节 == `SHA256(rp_id)`                             |
| `sign_count_monotonic`                | 连续两次 `sign_assertion` 返回 count, count+1                       |
| `attestation_object_format`           | CBOR map 含 `fmt`/`authData`/`attStmt` 三个 key                     |
| `webauthn_test_vector_register`       | 与浏览器抓包的实际 register 响应对照（用 `ring` 或 `webauthn-rs` 验证签名） |

---

## 10. 与谁衔接

- 上一篇：[`06-otp.md`](./06-otp.md)
- 下一篇：[`08-ssh-agent.md`](./08-ssh-agent.md)
- 相关：[`09-browser-bridge.md`](./09-browser-bridge.md) —— 浏览器扩展集成
