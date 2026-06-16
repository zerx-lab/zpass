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
//!
//! 局域网同步服务端：设备作为 LAN 同步 server 时，由 crate::lan_transport 起一个
//! 阻塞式 tiny_http 监听（独立 OS 线程）。每个入站请求经 napi ThreadsafeFunction
//! 反向回调到 ArkTS 线程处理，再由 respondSyncRequest 唤醒被 park 的 worker。
//! 协议状态机全部在 ArkTS（SyncServer.ets），与 android.rs 的 JNI 反向回调同构。
//
// Rust guideline compliant 2026-02-21

use crate::lan_transport::{self, Inbound, Listener};
use crate::{
    argon2id_raw, derive_kek, open_aead, open_aead_with_nonce, random_bytes, seal_aead,
    seal_aead_with_nonce,
};
use crate::keyset;
use crate::kdf2::{self, Argon2Params};
use crate::srp;
use napi_derive_ohos::napi;
use napi_ohos::bindgen_prelude::{
    AsyncTask, Buffer, Env, Error, Result as NapiResult, Status, Task, Uint8Array,
};
use napi_ohos::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::sync::{Mutex, OnceLock};

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

/* ----------------------------------------------------------------------------
 * 云同步专用导出 —— 2SKD（AUK / SRP-x）+ SRP-6a 握手 + X25519 keyset sealed-box
 *
 * 全部薄包装 crate::kdf2 / crate::srp / crate::keyset 的字节权威实现，让 ArkTS
 * 云同步层（lib/CloudCrypto.ets）产出与 desktop / web_vault / 服务端完全一致的
 * 认证物与密文。此处任何字节分叉都是 P0 互通 bug —— 故只搬运字节，不复写逻辑。
 *
 *   - deriveAuk / deriveSrpX：2SKD 派生（Argon2id 重活 → AsyncTask，UI 不阻塞）
 *   - srpRegister / srpClientStart / srpClientFinish：SRP-6a 客户端三步
 *     （M2 校验在 ArkTS 侧做 SHA-256(PAD(A)‖M1‖K)，无须额外原生函数）
 *   - keysetGenerate / sealToPubkey / openWithPrivkey：账户 X25519 keyset +
 *     per-vault key sealed-box；keyset 私钥包裹复用 sealAead，aad=zpass-keyset-priv-v1
 * -------------------------------------------------------------------------- */

/// 2SKD 派生任务（AUK 或 SRP-x，按 `is_auk` 切换 slow_salt 与 HKDF info）。
/// Argon2id 重活搬到 libuv worker，ArkTS 侧 await 即可。
pub struct Derive2skdTask {
    password: String,
    slow_salt: Vec<u8>,
    secret_key_raw: Vec<u8>,
    account_id: Vec<u8>,
    mem_kib: u32,
    iter: u32,
    par: u32,
    is_auk: bool,
}

impl Task for Derive2skdTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        let params = Argon2Params::new(self.mem_kib, self.iter, self.par);
        let out = if self.is_auk {
            kdf2::derive_auk(
                &self.password,
                &self.slow_salt,
                &self.secret_key_raw,
                &self.account_id,
                params,
            )
        } else {
            kdf2::derive_srp_x(
                &self.password,
                &self.slow_salt,
                &self.secret_key_raw,
                &self.account_id,
                params,
            )
        };
        out.map(|k| k.to_vec()).map_err(to_napi)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(Buffer::from(output))
    }
}

/// 派生 Account Unlock Key（AUK）—— 2SKD，slow_salt = salt_enc，info = zpass-auk-v1。
/// `password` 走原始串，规范化（trim + NFKD）由 kdf2 内部完成。
#[napi(js_name = "deriveAuk")]
pub fn derive_auk_napi(
    password: String,
    salt_enc: Buffer,
    secret_key_raw: Buffer,
    account_id: Buffer,
    mem_kib: u32,
    iter: u32,
    par: u32,
) -> AsyncTask<Derive2skdTask> {
    AsyncTask::new(Derive2skdTask {
        password,
        slow_salt: salt_enc.to_vec(),
        secret_key_raw: secret_key_raw.to_vec(),
        account_id: account_id.to_vec(),
        mem_kib,
        iter,
        par,
        is_auk: true,
    })
}

/// 派生 SRP-x（32 字节）—— 2SKD，slow_salt = srp_salt（salt_auth），info = zpass-srpx-v1。
#[napi(js_name = "deriveSrpX")]
pub fn derive_srp_x_napi(
    password: String,
    salt_auth: Buffer,
    secret_key_raw: Buffer,
    account_id: Buffer,
    mem_kib: u32,
    iter: u32,
    par: u32,
) -> AsyncTask<Derive2skdTask> {
    AsyncTask::new(Derive2skdTask {
        password,
        slow_salt: salt_auth.to_vec(),
        secret_key_raw: secret_key_raw.to_vec(),
        account_id: account_id.to_vec(),
        mem_kib,
        iter,
        par,
        is_auk: false,
    })
}

/// SRP 注册产物：salt（认证盐）+ verifier（v = g^x mod N，PAD 256 字节）。
#[napi(object)]
pub struct SrpRegistrationResult {
    pub salt: Buffer,
    pub verifier: Buffer,
}

/// SRP 注册：x = big-endian(32B SRP-x)，返回 verifier = g^x mod N（256B PAD）。
#[napi(js_name = "srpRegister")]
pub fn srp_register_napi(x_bytes: Buffer, salt: Buffer) -> NapiResult<SrpRegistrationResult> {
    let reg = srp::srp_register(&x_bytes, &salt).map_err(to_napi)?;
    Ok(SrpRegistrationResult {
        salt: Buffer::from(reg.salt),
        verifier: Buffer::from(reg.verifier),
    })
}

/// SRP 客户端 start 输出：一次性私钥 a + 公开 A = g^a mod N（256B PAD）。
#[napi(object)]
pub struct SrpClientStartResult {
    pub secret_a: Buffer,
    pub a_pub: Buffer,
}

/// SRP 客户端 start：生成一次性 a 与 A。a 须用后即焚（ArkTS 侧 wipeBytes）。
#[napi(js_name = "srpClientStart")]
pub fn srp_client_start_napi() -> NapiResult<SrpClientStartResult> {
    let start = srp::srp_client_start().map_err(to_napi)?;
    Ok(SrpClientStartResult {
        secret_a: Buffer::from(start.secret_a().to_vec()),
        a_pub: Buffer::from(start.a_pub.clone()),
    })
}

/// SRP 客户端 finish 输出：证明 M1 + 共享会话密钥 K（= H(PAD(S))）。
#[napi(object)]
pub struct SrpClientFinishResult {
    pub m1: Buffer,
    pub k: Buffer,
}

/// SRP 客户端 finish：算 S / K / M1。`identity` = 小写邮箱的 UTF-8 字节。
/// 服务端 M2 校验在 ArkTS 侧用 SHA-256(PAD(A)‖M1‖K) 重算后常数时间比较。
#[napi(js_name = "srpClientFinish")]
pub fn srp_client_finish_napi(
    secret_a: Buffer,
    a_pub: Buffer,
    b_pub: Buffer,
    x_bytes: Buffer,
    salt: Buffer,
    identity: Buffer,
) -> NapiResult<SrpClientFinishResult> {
    let proof = srp::srp_client_finish(&secret_a, &a_pub, &b_pub, &x_bytes, &salt, &identity)
        .map_err(to_napi)?;
    Ok(SrpClientFinishResult {
        m1: Buffer::from(proof.m1.to_vec()),
        k: Buffer::from(proof.session_key.to_vec()),
    })
}

/// 账户 X25519 keyset 对（pub32 / priv32）。priv 须用后即焚。
#[napi(object)]
pub struct KeysetPair {
    pub public_key: Buffer,
    pub private_key: Buffer,
}

/// 生成账户 keyset：X25519 (pub32, priv32)。
#[napi(js_name = "keysetGenerate")]
pub fn keyset_generate_napi() -> NapiResult<KeysetPair> {
    let (pk, sk) = keyset::keyset_generate().map_err(to_napi)?;
    Ok(KeysetPair {
        public_key: Buffer::from(pk.to_vec()),
        private_key: Buffer::from(sk.to_vec()),
    })
}

/// 用收件人公钥封装明文（X25519 sealed-box）：输出 = eph_pub(32) ‖ AEAD 密文。
#[napi(js_name = "sealToPubkey")]
pub fn seal_to_pubkey_napi(recipient_pub: Buffer, plaintext: Buffer) -> NapiResult<Buffer> {
    keyset::seal_to_pubkey(&recipient_pub, &plaintext)
        .map(Buffer::from)
        .map_err(to_napi)
}

/// 用私钥解封 [`seal_to_pubkey_napi`] 输出。
#[napi(js_name = "openWithPrivkey")]
pub fn open_with_privkey_napi(priv_key: Buffer, sealed: Buffer) -> NapiResult<Buffer> {
    keyset::open_with_privkey(&priv_key, &sealed)
        .map(Buffer::from)
        .map_err(to_napi)
}

/* ----------------------------------------------------------------------------
 * 局域网同步服务端桥 —— 设备作为 LAN 同步 server
 *
 * 与 android.rs 的 JNI 反向回调同构，仅把 JNI 换成 napi ThreadsafeFunction：
 *   1. lan_transport worker 分配 reqId，把响应通道存入 pending 表
 *   2. 经 SYNC_TSFN 反向回调 ArkTS handler，下发 {reqId, method, path, body}
 *   3. ArkTS 计算响应后调 respondSyncRequest(reqId, status, body) 唤醒 worker
 *   4. worker 把 (status, body) 写回该 HTTP 连接
 *
 * 协议 / vault / crypto 逻辑全部在 ArkTS（SyncServer.ets）。明文 HTTP（局域网内由
 * PSK + 会话 AEAD 保证机密性，与 desktop server 同构），不需要 TLS。
 * -------------------------------------------------------------------------- */

/// 下发给 ArkTS handler 的单个入站同步请求。镜像 phone 端 `SyncRequestEvent`。
///
/// `body` 走 `Uint8Array`（ArkTS 侧零拷贝 ArrayBuffer），与本桥其余函数一致；
/// base64 仅在 RN/phone 端使用（Expo 对字节传输支持弱）。`reqId` 用 `u32`：
/// ArkTS 的 `number` 能无损往返 u32，2^32 个请求/服务端生命周期远超实际需要，
/// respondSyncRequest 在边界处同样按 u32 取，两端一致。
#[napi(object)]
pub struct SyncRequest {
    pub req_id: u32,
    pub method: String,
    pub path: String,
    pub body: Uint8Array,
}

/// `startSyncServer` 返回的 `{port, hosts}`。
#[napi(object)]
pub struct SyncServerInfo {
    pub port: u32,
    pub hosts: Vec<String>,
}

// napi 自由函数无法持有实例状态，服务端单例只能放 static。整个 .so 由单个 app
// 进程加载，不跨 DLL 共享，故 M-ISOLATE-DLL-STATE 不适用。
//
/// ArkTS 请求 handler，由 registerSyncRequestHandler 注册一次。
///
/// `ThreadsafeFunction` 由 napi-ohos 本身 `unsafe impl Send + Sync`（不是本模块
/// 临时 `unsafe impl`），所以放进 static 并从 tiny_http worker 线程 `call` 是
/// 安全的。CalleeHandled 取默认 true → 用 `Ok(req)` 调用，JS 侧按 error-first
/// 收到 `(null, req)`。
static SYNC_TSFN: OnceLock<ThreadsafeFunction<SyncRequest>> = OnceLock::new();

/// 当前运行中的 listener；None = 未运行。stopSyncServer 后置回 None 使 start 幂等。
static SERVER: OnceLock<Mutex<Option<Listener>>> = OnceLock::new();

fn server_slot() -> &'static Mutex<Option<Listener>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// 取锁；panic=abort 下 Mutex 不会真正中毒，into_inner 仅为防御性恢复。
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 注册每个入站同步请求触发的 ArkTS handler。
///
/// 必须在 [`start_sync_server`] 之前调用一次。handler 收到 [`SyncRequest`] 后须
/// 最终调用 `respondSyncRequest(reqId, ...)` 回传响应。首次注册生效（OnceLock
/// 黏住），后续重复注册被忽略，以保证 worker 线程缓存的 TSFN 句柄稳定。
#[napi(js_name = "registerSyncRequestHandler")]
pub fn register_sync_request_handler(
    handler: ThreadsafeFunction<SyncRequest>,
) -> NapiResult<()> {
    // 黏住：首次注册胜出；若已注册，新传入的 TSFN 在此被 drop 并释放。
    let _ = SYNC_TSFN.set(handler);
    Ok(())
}

/// 本设备是否可作为 LAN 同步服务端。feature=harmony 下恒为 true（传输层已编译进
/// 来），仅为与 phone 桥对称地探测而存在。
#[napi(js_name = "isSyncServerAvailable")]
pub fn is_sync_server_available() -> bool {
    true
}

/// 启动局域网同步服务端，绑定 0.0.0.0 的 OS 分配端口。
///
/// 幂等：已在运行则返回当前 `{port, hosts}`。ArkTS handler 须已通过
/// [`register_sync_request_handler`] 注册，否则入站请求一律回 500。
///
/// # Errors
///
/// 套接字绑定失败或 worker 线程派生失败时返回 `GenericFailure`。
#[napi(js_name = "startSyncServer")]
pub fn start_sync_server() -> NapiResult<SyncServerInfo> {
    let mut guard = lock(server_slot());
    if let Some(listener) = guard.as_ref() {
        return Ok(SyncServerInfo {
            port: u32::from(listener.port()),
            hosts: listener.hosts().to_vec(),
        });
    }

    // emit 在 tiny_http worker 线程上跑：取缓存的 TSFN，NonBlocking 反向回调 ArkTS
    // —— 绝不让 worker 阻塞在 JS 队列上（worker 随后 park 在自己的 mpsc 通道，直到
    // respondSyncRequest 唤醒或 RESPONSE_TIMEOUT 超时回 504）。
    let emit = |inbound: Inbound<'_>| -> bool {
        let Some(tsfn) = SYNC_TSFN.get() else {
            return false; // handler 从未注册 → worker 回 500
        };
        let req = SyncRequest {
            req_id: inbound.req_id as u32,
            method: inbound.method.to_owned(),
            path: inbound.path.to_owned(),
            // 拷贝成 owned Uint8Array：ArkTS 线程的生命周期长于此栈帧。
            body: Uint8Array::new(inbound.body.to_vec()),
        };
        let status = tsfn.call(Ok(req), ThreadsafeFunctionCallMode::NonBlocking);
        status == Status::Ok
    };

    let listener = lan_transport::start(emit)
        .map_err(|e| Error::new(Status::GenericFailure, format!("bind: {e}")))?;
    let info = SyncServerInfo {
        port: u32::from(listener.port()),
        hosts: listener.hosts().to_vec(),
    };
    *guard = Some(listener);
    Ok(info)
}

/// 停止局域网同步服务端。幂等。
///
/// 唤醒所有 park 的 worker（送 503）、join worker 线程、关闭监听套接字。
/// SYNC_TSFN 故意保留注册（黏住），后续 start 复用；TSFN 仅在 .so 卸载时释放。
#[napi(js_name = "stopSyncServer")]
pub fn stop_sync_server() {
    // 先 take 出 listener 释放 SERVER 锁，避免持锁 join 与 respondSyncRequest 死等。
    let listener = lock(server_slot()).take();
    if let Some(listener) = listener {
        lan_transport::stop(listener);
    }
}

/// ArkTS 侧算完响应后回传给被 park 的请求。
///
/// reqId 未知（已超时 / 已停止）则静默丢弃。status 不在 100..=599 归一为 500。
#[napi(js_name = "respondSyncRequest")]
pub fn respond_sync_request(req_id: u32, status: u32, body: Uint8Array) {
    let status = if (100..=599).contains(&status) {
        status as u16
    } else {
        500
    };
    let guard = lock(server_slot());
    if let Some(listener) = guard.as_ref() {
        lan_transport::respond(
            lan_transport::pending(listener),
            u64::from(req_id),
            status,
            body.to_vec(),
        );
    }
}
