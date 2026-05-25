package expo.modules.zpasscrypto

import android.util.Base64
import com.zerx.zpass.mobilecrypto.Mobilecrypto
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ZpassCrypto —— gomobile-bind 出的 Go 加密原语在 Android 上的 Expo Module 桥。
 *
 * 设计要点：
 *   - 所有方法走 AsyncFunction：Expo Modules 默认把 AsyncFunction 投递到
 *     后台线程，Argon2id 几百毫秒的阻塞不会拖 JS / UI 线程。
 *   - 二进制数据用 base64 在 JS ↔ Kotlin 间往返。
 *     原因：RN bridge 对 Uint8Array 的语义在 Old/New Arch 下不一致；
 *     上层 phone/lib/crypto.ts 已经具备 toB64/fromB64，base64 是最稳的载体。
 *   - 直接调用 gomobile 生成的 com.zerx.zpass.mobilecrypto.Mobilecrypto 静态方法；
 *     Go side 的 error 会被 gomobile 转成 Java Exception，向上抛回 JS Promise reject。
 */
class ZpassCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ZpassCrypto")

    AsyncFunction("deriveKEK") {
        password: String,
        saltB64: String,
        memKiB: Int,
        iter: Int,
        par: Int,
        keyLen: Int ->
      val salt = Base64.decode(saltB64, Base64.NO_WRAP)
      val key = Mobilecrypto.deriveKEK(
        password,
        salt,
        memKiB.toLong(),
        iter.toLong(),
        par.toLong(),
        keyLen.toLong(),
      )
      Base64.encodeToString(key, Base64.NO_WRAP)
    }

    AsyncFunction("sealAEAD") {
        keyB64: String, plaintextB64: String, aadB64: String ->
      val key = Base64.decode(keyB64, Base64.NO_WRAP)
      val pt = Base64.decode(plaintextB64, Base64.NO_WRAP)
      val aad = Base64.decode(aadB64, Base64.NO_WRAP)
      val sealed = Mobilecrypto.sealAEAD(key, pt, aad)
      Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    AsyncFunction("openAEAD") {
        keyB64: String, sealedB64: String, aadB64: String ->
      val key = Base64.decode(keyB64, Base64.NO_WRAP)
      val sealed = Base64.decode(sealedB64, Base64.NO_WRAP)
      val aad = Base64.decode(aadB64, Base64.NO_WRAP)
      val pt = Mobilecrypto.openAEAD(key, sealed, aad)
      Base64.encodeToString(pt, Base64.NO_WRAP)
    }

    AsyncFunction("randomBytes") { n: Int ->
      val bytes = Mobilecrypto.randomBytes(n.toLong())
      Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
  }
}
