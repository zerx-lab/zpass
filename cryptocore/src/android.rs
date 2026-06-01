//! Android JNI 绑定
//!
//! Kotlin 侧对应：phone/android/app/src/main/java/com/zerx/zpass/cryptocore/RustCryptoCore.kt
//! 命名约定：JNI 符号 `Java_<package>_<class>_<method>`，所以函数名必须严格按
//! `Java_com_zerx_zpass_cryptocore_RustCryptoCore_*` 拼。
//!
//! 字节传输策略：
//!   - 密码、AAD：String（UTF-8）—— Java String → modified UTF-8，jni 0.21 帮我们转
//!   - 二进制：jbyteArray —— 比 base64 字符串少一次编解码，零拷贝最大化
//!
//! 错误统一抛 Java RuntimeException；Kotlin 侧在协程里 catch 转 Expo 端 Promise.reject
//
// Rust guideline compliant 2026-02-21

use crate::{derive_kek, open_aead, random_bytes, seal_aead};
use jni::JNIEnv;
use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jbyteArray, jint};

// ---- 局域网同步服务端（手机作为 server）所需 ----
use crate::lan_transport::{self, Inbound, Listener};
use jni::JavaVM;
use jni::objects::{GlobalRef, JValue};
use jni::sys::{jlong, jstring};
use std::sync::{Mutex, OnceLock};

/// 错误转 Java 异常 + 返回 null
fn throw(env: &mut JNIEnv, msg: &str) -> jbyteArray {
    let _ = env.throw_new("java/lang/RuntimeException", msg);
    std::ptr::null_mut()
}

/// 把 Result<Vec<u8>> 转成 jbyteArray，错误转 Java 异常 + 返回 null
fn vec_to_jbytearray(env: &mut JNIEnv, r: crate::Result<Vec<u8>>) -> jbyteArray {
    match r {
        Ok(bytes) => match env.byte_array_from_slice(&bytes) {
            Ok(arr) => arr.into_raw(),
            Err(e) => throw(env, &format!("jni byte_array_from_slice: {e}")),
        },
        Err(e) => throw(env, &e.to_string()),
    }
}

fn jbytes_to_vec(env: &mut JNIEnv, arr: &JByteArray) -> std::result::Result<Vec<u8>, String> {
    env.convert_byte_array(arr)
        .map_err(|e| format!("jni convert_byte_array: {e}"))
}

fn jstring_to_string(env: &mut JNIEnv, s: &JString) -> std::result::Result<String, String> {
    env.get_string(s)
        .map(|js| js.into())
        .map_err(|e| format!("jni get_string: {e}"))
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zerx_zpass_cryptocore_RustCryptoCore_deriveKek<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    password: JString<'local>,
    salt: JByteArray<'local>,
    mem_kib: jint,
    iter: jint,
    par: jint,
    key_len: jint,
) -> jbyteArray {
    let password = match jstring_to_string(&mut env, &password) {
        Ok(s) => s,
        Err(e) => return throw(&mut env, &e),
    };
    let salt = match jbytes_to_vec(&mut env, &salt) {
        Ok(v) => v,
        Err(e) => return throw(&mut env, &e),
    };
    // jint = i32；若调用方传负数说明 Kotlin 侧没做转换，直接拒绝
    if mem_kib < 0 || iter < 0 || par < 0 || key_len < 0 {
        return throw(&mut env, "argon2id parameter cannot be negative");
    }
    let r = derive_kek(
        &password,
        &salt,
        mem_kib as u32,
        iter as u32,
        par as u32,
        key_len as u32,
    );
    vec_to_jbytearray(&mut env, r)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zerx_zpass_cryptocore_RustCryptoCore_sealAead<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    key: JByteArray<'local>,
    plaintext: JByteArray<'local>,
    aad: JByteArray<'local>,
) -> jbyteArray {
    let key = match jbytes_to_vec(&mut env, &key) {
        Ok(v) => v,
        Err(e) => return throw(&mut env, &e),
    };
    let pt = match jbytes_to_vec(&mut env, &plaintext) {
        Ok(v) => v,
        Err(e) => return throw(&mut env, &e),
    };
    let aad = match jbytes_to_vec(&mut env, &aad) {
        Ok(v) => v,
        Err(e) => return throw(&mut env, &e),
    };
    vec_to_jbytearray(&mut env, seal_aead(&key, &pt, &aad))
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zerx_zpass_cryptocore_RustCryptoCore_openAead<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    key: JByteArray<'local>,
    sealed: JByteArray<'local>,
    aad: JByteArray<'local>,
) -> jbyteArray {
    let key = match jbytes_to_vec(&mut env, &key) {
        Ok(v) => v,
        Err(e) => return throw(&mut env, &e),
    };
    let sealed = match jbytes_to_vec(&mut env, &sealed) {
        Ok(v) => v,
        Err(e) => return throw(&mut env, &e),
    };
    let aad = match jbytes_to_vec(&mut env, &aad) {
        Ok(v) => v,
        Err(e) => return throw(&mut env, &e),
    };
    vec_to_jbytearray(&mut env, open_aead(&key, &sealed, &aad))
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zerx_zpass_cryptocore_RustCryptoCore_randomBytes<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    n: jint,
) -> jbyteArray {
    if n <= 0 {
        return throw(&mut env, "invalid random byte count");
    }
    vec_to_jbytearray(&mut env, random_bytes(n as usize))
}

// ===========================================================================
// 局域网同步服务端（手机作为 server）
//
// RN/JS 无法监听入站连接，所以由 Rust 在同一 libcryptocore.so 内起一个最小
// tiny_http 监听；协议 / vault / crypto 逻辑全部仍在 TS 侧。每个入站请求：
//   1. worker 线程分配 reqId，把响应通道存入 pending 表
//   2. JNI 反向回调 RustCryptoCore.onSyncRequest(reqId, method, path, body) 给 Kotlin
//      → Kotlin sendEvent → JS handleSyncRequest 计算响应
//   3. JS 调 respondSyncRequest(reqId, status, body) → 经 pending 通道唤醒 worker
//   4. worker 把 (status, body) 写回该 HTTP 连接
//
// 明文 HTTP：局域网内由 PSK 配对 + 会话 AEAD 保证机密性，与 desktop server 同构。
// 仅 feature=android（整个本模块都在 #[cfg(feature="android")] 下）。
// ===========================================================================

// 传输层（tiny_http worker + pending 表 + LAN IPv4 枚举 + 超时常量）已抽到
// crate::lan_transport，android / harmony 两座桥共用。本模块只保留 JNI 特有的
// 反向回调（emit_request）与 JNI 导出。

/// onSyncRequest 的 JNI 方法签名：(long reqId, String method, String path, byte[] body) -> void
const ON_SYNC_REQUEST_SIG: &str = "(JLjava/lang/String;Ljava/lang/String;[B)V";

// JNI 自由函数无法持有实例状态，服务端单例只能放 static。整个 .so 由单个 app
// 进程加载，不跨 DLL 共享，故 M-ISOLATE-DLL-STATE 不适用。
//
/// 缓存的 JavaVM，供 worker 线程 attach 后反向回调。首次 startSyncServer 时写入。
static JVM: OnceLock<JavaVM> = OnceLock::new();
/// 缓存的 RustCryptoCore jclass（GlobalRef）。在持有 app classloader 的 JNI 线程上
/// 解析后缓存，规避 worker 线程 find_class 找不到 app 类的坑。
static CALLBACK_CLASS: OnceLock<GlobalRef> = OnceLock::new();
/// 当前服务端实例；None = 未运行。stopSyncServer 后置回 None 使 start 幂等。
static SERVER: OnceLock<Mutex<Option<Listener>>> = OnceLock::new();

fn server_slot() -> &'static Mutex<Option<Listener>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// 把 {port, hosts} 渲染成 JSON（IPv4 字符串无需转义）。
fn status_json(port: u16, hosts: &[String]) -> String {
    let hosts_json = hosts
        .iter()
        .map(|h| format!("\"{h}\""))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"port\":{port},\"hosts\":[{hosts_json}]}}")
}

/// 反向回调 Kotlin RustCryptoCore.onSyncRequest。worker 线程调用，scoped attach。
/// 返回 false 表示桥不可用（调用方应直接回错而非阻塞等响应）。
fn emit_request(jvm: &JavaVM, req_id: u64, method: &str, path: &str, body: &[u8]) -> bool {
    let Some(class_ref) = CALLBACK_CLASS.get() else {
        return false;
    };
    let Ok(mut env) = jvm.attach_current_thread() else {
        return false;
    };
    let Ok(local_class) = env.new_local_ref(class_ref.as_obj()) else {
        return false;
    };
    let class = JClass::from(local_class);
    let Ok(j_method) = env.new_string(method) else {
        return false;
    };
    let Ok(j_path) = env.new_string(path) else {
        return false;
    };
    let Ok(j_body) = env.byte_array_from_slice(body) else {
        return false;
    };
    let args = [
        JValue::Long(req_id as jlong),
        JValue::Object(&j_method),
        JValue::Object(&j_path),
        JValue::Object(&j_body),
    ];
    match env.call_static_method(&class, "onSyncRequest", ON_SYNC_REQUEST_SIG, &args) {
        Ok(_) => true,
        Err(_) => {
            // Kotlin 回调若抛异常，清掉 pending 异常避免跨 JNI 边界传播
            let _ = env.exception_clear();
            false
        }
    }
}

/// 取锁；panic=abort 下 Mutex 不会真正中毒，into_inner 仅为防御性恢复。
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 启动局域网同步服务端，绑定 0.0.0.0 的 OS 分配端口。
///
/// 返回 JSON 字符串 `{"port":<u16>,"hosts":["<ipv4>",...]}`。已在运行则幂等地返回
/// 当前 port/hosts。绑定失败抛 Java RuntimeException 并返回 null。
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zerx_zpass_cryptocore_RustCryptoCore_startSyncServer<'local>(
    mut env: JNIEnv<'local>,
    class: JClass<'local>,
) -> jstring {
    // 在当前（持有 app classloader 的）JNI 线程上缓存 JavaVM 与 jclass
    if JVM.get().is_none() {
        match env.get_java_vm() {
            Ok(vm) => {
                let _ = JVM.set(vm);
            }
            Err(e) => return throw(&mut env, &format!("get_java_vm: {e}")),
        }
    }
    if CALLBACK_CLASS.get().is_none() {
        match env.new_global_ref(&class) {
            Ok(g) => {
                let _ = CALLBACK_CLASS.set(g);
            }
            Err(e) => return throw(&mut env, &format!("new_global_ref: {e}")),
        }
    }

    let mut guard = lock(server_slot());
    if let Some(listener) = guard.as_ref() {
        // 已在运行：幂等返回
        return match env.new_string(status_json(listener.port(), listener.hosts())) {
            Ok(s) => s.into_raw(),
            Err(e) => throw(&mut env, &format!("new_string: {e}")),
        };
    }

    // emit 在 tiny_http worker 线程上跑：取缓存的 JavaVM，反向回调 Kotlin。
    // JVM 已在上面缓存（缺失说明 JNI 线程尚未握过，直接回 false → worker 回 500）。
    let emit = |inbound: Inbound<'_>| -> bool {
        let Some(jvm) = JVM.get() else {
            return false;
        };
        emit_request(jvm, inbound.req_id, inbound.method, inbound.path, inbound.body)
    };

    let listener = match lan_transport::start(emit) {
        Ok(l) => l,
        Err(e) => return throw(&mut env, &format!("bind: {e}")),
    };
    let json = status_json(listener.port(), listener.hosts());
    *guard = Some(listener);
    drop(guard);

    match env.new_string(json) {
        Ok(s) => s.into_raw(),
        Err(e) => throw(&mut env, &format!("new_string: {e}")),
    }
}

/// 停止局域网同步服务端。幂等。
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zerx_zpass_cryptocore_RustCryptoCore_stopSyncServer<'local>(
    _env: JNIEnv<'local>,
    _class: JClass<'local>,
) {
    // 先 take 出 listener 释放 SERVER 锁，避免持锁 join 与 respondSyncRequest 死等。
    // lan_transport::stop 内部翻 running、送 503 唤醒 worker、join、关闭套接字。
    let listener = lock(server_slot()).take();
    if let Some(listener) = listener {
        lan_transport::stop(listener);
    }
}

/// JS 侧算完响应后回传。reqId 未知（已超时/已停止）则静默丢弃。
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zerx_zpass_cryptocore_RustCryptoCore_respondSyncRequest<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    req_id: jlong,
    status: jint,
    body: JByteArray<'local>,
) {
    let bytes = env.convert_byte_array(&body).unwrap_or_default();
    let status = if (100..=599).contains(&status) {
        status as u16
    } else {
        500
    };
    let guard = lock(server_slot());
    if let Some(listener) = guard.as_ref() {
        lan_transport::respond(lan_transport::pending(listener), req_id as u64, status, bytes);
    }
}
