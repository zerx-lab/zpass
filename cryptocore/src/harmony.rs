//! HarmonyOS NAPI 桥
//!
//! ArkTS 侧通过 `import cryptocore from 'libcryptocore.so'` 调用本模块导出的
//! 4 个函数 —— 与 android.rs 的 JNI 一一对应：
//!   deriveKek / sealAead / openAead / randomBytes
//!
//! 二进制数据策略：
//!   - 与 phone 端 RN bridge 不同（那边用 base64 string），napi-rs 的
//!     `Buffer` / `Uint8Array` 能零拷贝传到 ArkTS 的 ArrayBuffer，效率更高。
//!   - 密码与 AAD 走 String（UTF-8）；AAD 不走 String 是因为它来源于条目 id
//!     或常量字面量，可能含任意字节，所以仍走 Uint8Array。
//!
//! 错误：统一返回 napi::Error，ArkTS 侧表现为 Promise reject（同步函数则
//! 在调用栈抛 BusinessError）。
//!
//! 线程：Argon2id 派生主路径耗时数百毫秒，必须用 napi-rs 的 `#[napi]`
//! 异步形态（async fn）—— 框架会把执行移到 libuv worker，UI 主线程不阻塞。

use crate::{
    argon2id_raw, derive_kek, open_aead, open_aead_with_nonce, random_bytes, seal_aead,
    seal_aead_with_nonce,
};
use napi_ohos::bindgen_prelude::{AsyncTask, Buffer, Env, Error, Result as NapiResult, Status, Task};
use napi_derive_ohos::napi;

/// 把内部 Error 转 napi::Error；保留 message 便于 ArkTS 端按字符串分支
fn to_napi(e: crate::Error) -> Error {
    Error::new(Status::GenericFailure, e.to_string())
}

/* ----------------------------------------------------------------------------
 * Argon2id 派生 KEK —— 异步形态
 *
 * 用 AsyncTask 把重活搬到 libuv worker；ArkTS 侧 await 即可。
 * -------------------------------------------------------------------------- */

pub struct DeriveKekTask {
    password: String,
    salt: Vec<u8>,
    mem_kib: u32,
    iter: u32,
    par: u32,
    key_len: u32,
}

impl Task for DeriveKekTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        derive_kek(
            &self.password,
            &self.salt,
            self.mem_kib,
            self.iter,
            self.par,
            self.key_len,
        )
        .map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(Buffer::from(output))
    }
}

/// Argon2id 派生 KEK；返回 32 字节 Buffer（ArkTS 侧表现为 ArrayBuffer）
#[napi(js_name = "deriveKek")]
pub fn derive_kek_napi(
    password: String,
    salt: Buffer,
    mem_kib: u32,
    iter: u32,
    par: u32,
    key_len: u32,
) -> AsyncTask<DeriveKekTask> {
    AsyncTask::new(DeriveKekTask {
        password,
        salt: salt.to_vec(),
        mem_kib,
        iter,
        par,
        key_len,
    })
}

/* ----------------------------------------------------------------------------
 * AEAD —— 同步形态（XChaCha20 单帧加密在 µs 级别，无须异步）
 * -------------------------------------------------------------------------- */

/// XChaCha20-Poly1305 加密；输出 = 24-byte nonce ‖ ciphertext ‖ 16-byte tag
#[napi(js_name = "sealAead")]
pub fn seal_aead_napi(key: Buffer, plaintext: Buffer, aad: Buffer) -> NapiResult<Buffer> {
    seal_aead(&key, &plaintext, &aad)
        .map(Buffer::from)
        .map_err(to_napi)
}

/// 解密 seal_aead 输出；认证失败统一返回 GenericFailure，不泄露差异原因
#[napi(js_name = "openAead")]
pub fn open_aead_napi(key: Buffer, sealed: Buffer, aad: Buffer) -> NapiResult<Buffer> {
    open_aead(&key, &sealed, &aad)
        .map(Buffer::from)
        .map_err(to_napi)
}

/* ----------------------------------------------------------------------------
 * 随机数 —— 同步；getrandom 走 OS syscall，无 IO 阻塞
 * -------------------------------------------------------------------------- */

/// OS CSPRNG；n 必须 > 0
#[napi(js_name = "randomBytes")]
pub fn random_bytes_napi(n: u32) -> NapiResult<Buffer> {
    if n == 0 {
        return Err(Error::new(Status::InvalidArg, "invalid random byte count"));
    }
    random_bytes(n as usize).map(Buffer::from).map_err(to_napi)
}

/* ----------------------------------------------------------------------------
 * Sync 专用导出 —— PSK 派生 + 外部 nonce AEAD
 *
 * 与 phone/lib/sync-protocol.ts 一一对应：
 *   - argon2idRaw：sync session key 派生（salt 可任意长度，非 vault 32-byte 限制）
 *   - sealAeadWithNonce / openAeadWithNonce：协议 nonce = [dir(1)][rand(16)][counter(7B)]
 * -------------------------------------------------------------------------- */

pub struct Argon2idRawTask {
    password: Vec<u8>,
    salt: Vec<u8>,
    mem_kib: u32,
    iter: u32,
    par: u32,
    key_len: u32,
}

impl Task for Argon2idRawTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        argon2id_raw(
            &self.password,
            &self.salt,
            self.mem_kib,
            self.iter,
            self.par,
            self.key_len,
        )
        .map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(Buffer::from(output))
    }
}

/// Argon2id 通用派生 —— salt / keyLen 不限，password 走 bytes（与 sync PIN 行为一致）
#[napi(js_name = "argon2idRaw")]
pub fn argon2id_raw_napi(
    password: Buffer,
    salt: Buffer,
    mem_kib: u32,
    iter: u32,
    par: u32,
    key_len: u32,
) -> AsyncTask<Argon2idRawTask> {
    AsyncTask::new(Argon2idRawTask {
        password: password.to_vec(),
        salt: salt.to_vec(),
        mem_kib,
        iter,
        par,
        key_len,
    })
}

/// XChaCha20-Poly1305 加密（外部 nonce）；输出 = ciphertext ‖ 16-byte tag（不含 nonce）
#[napi(js_name = "sealAeadWithNonce")]
pub fn seal_aead_with_nonce_napi(
    key: Buffer,
    plaintext: Buffer,
    aad: Buffer,
    nonce: Buffer,
) -> NapiResult<Buffer> {
    seal_aead_with_nonce(&key, &plaintext, &aad, &nonce)
        .map(Buffer::from)
        .map_err(to_napi)
}

/// 解密 [`seal_aead_with_nonce_napi`] 输出；认证失败统一返回 GenericFailure
#[napi(js_name = "openAeadWithNonce")]
pub fn open_aead_with_nonce_napi(
    key: Buffer,
    ciphertext: Buffer,
    aad: Buffer,
    nonce: Buffer,
) -> NapiResult<Buffer> {
    open_aead_with_nonce(&key, &ciphertext, &aad, &nonce)
        .map(Buffer::from)
        .map_err(to_napi)
}
