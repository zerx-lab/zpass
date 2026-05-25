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

use crate::{derive_kek, open_aead, random_bytes, seal_aead};
use jni::JNIEnv;
use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jbyteArray, jint};

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
