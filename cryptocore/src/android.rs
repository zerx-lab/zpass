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
use jni::JavaVM;
use jni::objects::{GlobalRef, JValue};
use jni::sys::{jlong, jstring};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tiny_http::{Header, Response, Server};

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

/// TS 侧计算单个响应的最长等待时间。
///
/// 需覆盖 phone 端 noble Argon2id 在 Hermes 上派生 session key 的最坏耗时
/// （m=8MiB,t=2，实测数秒），并与 client 的 30s HTTP 超时对齐。超时后回 504，
/// 避免 worker 线程被永久阻塞。
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

/// accept 轮询间隔。stopSyncServer 把 running 置 false 后，worker 最多在此延迟内
/// 退出（用 recv_timeout 而非 unblock，关闭路径更确定）。
const ACCEPT_POLL: Duration = Duration::from_millis(400);

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
static SERVER: OnceLock<Mutex<Option<SyncServerState>>> = OnceLock::new();

/// 单个入站请求的响应通道：worker 等在 rx，respondSyncRequest 送 (HTTP status, body)。
type Responder = Sender<(u16, Vec<u8>)>;

/// reqId → 响应通道。worker 插入，respondSyncRequest 取出并送 (status, body)。
struct Pending {
    next_id: AtomicU64,
    map: Mutex<HashMap<u64, Responder>>,
}

/// 运行中的服务端句柄。监听套接字的存活由 worker 自持的 Arc<Server> 维持，
/// worker join 后该 Arc 落地、套接字关闭，故此处不再单独存 server。
struct SyncServerState {
    pending: Arc<Pending>,
    running: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    port: u16,
    hosts: Vec<String>,
}

fn server_slot() -> &'static Mutex<Option<SyncServerState>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// 取锁；panic=abort 下 Mutex 不会真正中毒，into_inner 仅为防御性恢复。
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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

/// 枚举本机可路由 LAN IPv4，跳过 loopback 与 link-local（169.254/16）。
/// 对齐 desktop syncservice.go::detectLanHosts。
fn enumerate_lan_ipv4() -> Vec<String> {
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for iface in ifaces {
        if iface.is_loopback() {
            continue;
        }
        if let std::net::IpAddr::V4(v4) = iface.ip() {
            if v4.is_link_local() {
                continue;
            }
            out.push(v4.to_string());
        }
    }
    out
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

/// 单 worker accept 循环。client 请求流本质串行（pair→confirm→manifest→fetch→
/// push→report→poll 轮询），单线程足够；poll-resolutions 每次是立即返回的短请求。
fn worker_loop(server: Arc<Server>, pending: Arc<Pending>, running: Arc<AtomicBool>) {
    let Some(jvm) = JVM.get() else {
        return;
    };
    while running.load(Ordering::Relaxed) {
        let mut request = match server.recv_timeout(ACCEPT_POLL) {
            Ok(Some(r)) => r,
            Ok(None) => continue, // 超时：重新检查 running
            Err(_) => break,
        };
        // 关闭窗口内到达的请求直接 503
        if !running.load(Ordering::Relaxed) {
            let _ = request.respond(Response::empty(503));
            break;
        }
        let method = request.method().to_string();
        let path = request.url().to_owned();
        let mut body = Vec::new();
        if request.as_reader().read_to_end(&mut body).is_err() {
            let _ = request.respond(Response::empty(400));
            continue;
        }
        let req_id = pending.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel::<(u16, Vec<u8>)>();
        lock(&pending.map).insert(req_id, tx);

        if !emit_request(jvm, req_id, &method, &path, &body) {
            lock(&pending.map).remove(&req_id);
            let _ = request.respond(Response::empty(500));
            continue;
        }
        match rx.recv_timeout(RESPONSE_TIMEOUT) {
            Ok((status, data)) => {
                let mut resp = Response::from_data(data).with_status_code(status);
                if let Ok(h) =
                    Header::from_bytes(&b"Content-Type"[..], &b"application/octet-stream"[..])
                {
                    resp.add_header(h);
                }
                let _ = request.respond(resp);
            }
            Err(_) => {
                lock(&pending.map).remove(&req_id);
                let _ = request.respond(Response::empty(504));
            }
        }
    }
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
    if let Some(state) = guard.as_ref() {
        // 已在运行：幂等返回
        return match env.new_string(status_json(state.port, &state.hosts)) {
            Ok(s) => s.into_raw(),
            Err(e) => throw(&mut env, &format!("new_string: {e}")),
        };
    }

    let server = match Server::http("0.0.0.0:0") {
        Ok(s) => Arc::new(s),
        Err(e) => return throw(&mut env, &format!("bind: {e}")),
    };
    let port = server
        .server_addr()
        .to_ip()
        .map_or(0, |addr| addr.port());
    let hosts = enumerate_lan_ipv4();

    let pending = Arc::new(Pending {
        next_id: AtomicU64::new(1),
        map: Mutex::new(HashMap::new()),
    });
    let running = Arc::new(AtomicBool::new(true));

    let w_server = Arc::clone(&server);
    let w_pending = Arc::clone(&pending);
    let w_running = Arc::clone(&running);
    let worker = thread::Builder::new()
        .name("zpass-sync-server".to_owned())
        .spawn(move || worker_loop(w_server, w_pending, w_running))
        .ok();
    if worker.is_none() {
        return throw(&mut env, "spawn sync worker failed");
    }

    let json = status_json(port, &hosts);
    // 本地 server Arc 在函数结束时落地，但 worker 已 clone 一份持有，套接字保持绑定
    *guard = Some(SyncServerState {
        pending,
        running,
        worker,
        port,
        hosts,
    });
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
    // 先 take 出 state 释放 SERVER 锁，避免持锁 join 与 respondSyncRequest 死等
    let state = lock(server_slot()).take();
    if let Some(state) = state {
        state.running.store(false, Ordering::Relaxed);
        // 唤醒所有在等响应的 worker（送 503），让其立即收尾
        for (_, tx) in lock(&state.pending.map).drain() {
            let _ = tx.send((503, Vec::new()));
        }
        if let Some(worker) = state.worker {
            let _ = worker.join();
        }
        // drop(state) 释放最后一个 Arc<Server>，关闭监听套接字
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
    let tx = {
        let guard = lock(server_slot());
        guard
            .as_ref()
            .and_then(|state| lock(&state.pending.map).remove(&(req_id as u64)))
    };
    if let Some(tx) = tx {
        let _ = tx.send((status, bytes));
    }
}
