package com.zerx.zpass.cryptocore

/**
 * 对 libcryptocore.so（Rust + jni-rs 实现）的 JNI 入口。
 *
 * 与 Rust 端 cryptocore/src/android.rs 严格对应：
 *   - 包名 com.zerx.zpass.cryptocore 决定了 JNI 符号 Java_com_zerx_zpass_cryptocore_RustCryptoCore_*
 *   - 类名 RustCryptoCore 不能改，否则 dlsym 找不到符号
 *
 * .so 由 cryptocore/scripts/build-android.sh 产出，
 * 由 phone/plugins/with-cryptocore.js 在 expo prebuild 时复制进
 * phone/android/app/src/main/jniLibs/<abi>/libcryptocore.so。
 */
object RustCryptoCore {
  init {
    // System.loadLibrary("cryptocore") 会从 APK 的 lib/<abi>/ 解析 libcryptocore.so
    System.loadLibrary("cryptocore")
  }

  /** Argon2id 派生 KEK；失败抛 RuntimeException */
  @JvmStatic
  external fun deriveKek(
    password: String,
    salt: ByteArray,
    memKib: Int,
    iter: Int,
    par: Int,
    keyLen: Int,
  ): ByteArray

  /** XChaCha20-Poly1305 加密；输出 = nonce(24) || ct || tag(16) */
  @JvmStatic
  external fun sealAead(key: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray

  /** XChaCha20-Poly1305 解密；认证失败抛 RuntimeException("aead authentication failed") */
  @JvmStatic
  external fun openAead(key: ByteArray, sealed: ByteArray, aad: ByteArray): ByteArray

  /** OS CSPRNG；n <= 0 抛 RuntimeException */
  @JvmStatic
  external fun randomBytes(n: Int): ByteArray

  // ---- 局域网同步服务端（手机作为 server）----
  // RN/JS 无法监听入站连接，故由 Rust 在同一 .so 内起最小 tiny_http 监听；
  // 协议 / vault / crypto 逻辑仍在 TS。Rust worker 收到请求后通过反向回调
  // onSyncRequest 把请求交给 JS，JS 算完调 respondSyncRequest 回传。

  /** 启动同步服务端，返回 JSON 字符串 {"port":<int>,"hosts":["<ipv4>",...]}；失败抛 RuntimeException */
  @JvmStatic
  external fun startSyncServer(): String

  /** 停止同步服务端；幂等 */
  @JvmStatic
  external fun stopSyncServer()

  /** JS 算完响应后回传给 Rust worker；status 为 HTTP 状态码，body 为响应体 */
  @JvmStatic
  external fun respondSyncRequest(reqId: Long, status: Int, body: ByteArray)

  /**
   * Rust worker 线程的反向回调入口（JNI call_static_method 调用）。
   * 转发到 ZpassCryptoModule 注册的 sink（投递 Expo 事件给 JS）。
   * 注意：在 Rust worker 线程上调用，sink 内不可做重活，只 sendEvent。
   */
  @JvmStatic
  fun onSyncRequest(reqId: Long, method: String, path: String, body: ByteArray) {
    syncRequestSink?.invoke(reqId, method, path, body)
  }

  /** ZpassCryptoModule 在 OnCreate 时注册、OnDestroy 时清空 */
  @Volatile
  @JvmStatic
  var syncRequestSink: ((Long, String, String, ByteArray) -> Unit)? = null
}
