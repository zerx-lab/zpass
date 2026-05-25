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
}
