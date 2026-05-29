package expo.modules.zpasscrypto

import android.util.Base64
import com.zerx.zpass.cryptocore.RustCryptoCore
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ZpassCrypto —— Rust cryptocore（libcryptocore.so）在 Android 上的 Expo Module 桥。
 *
 * 设计要点：
 *   - 所有方法走 AsyncFunction：Expo Modules 默认把 AsyncFunction 投递到
 *     后台线程，Argon2id 几百毫秒的阻塞不会拖 JS / UI 线程。
 *   - 二进制数据用 base64 在 JS ↔ Kotlin 间往返。
 *     原因：RN bridge 对 Uint8Array 的语义在 Old/New Arch 下不一致；
 *     上层 phone/lib/crypto.ts 已经具备 toB64/fromB64，base64 是最稳的载体。
 *   - 直接调用 RustCryptoCore 的 external fun，JNI 层把 Rust Error 转成
 *     RuntimeException，Expo Modules 自动把异常转成 JS Promise reject。
 */
class ZpassCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ZpassCrypto")

    // 局域网同步服务端：Rust worker → onSyncRequest → 此事件 → JS handleSyncRequest
    Events("onSyncRequest")

    OnCreate {
      // 注册反向回调 sink：Rust worker 线程会调用，这里仅投递 Expo 事件（轻量）。
      // body 走 base64，与本模块既有约定一致（RN bridge 对 ByteArray 语义不稳）。
      RustCryptoCore.syncRequestSink = { reqId, method, path, body ->
        sendEvent(
          "onSyncRequest",
          mapOf(
            "reqId" to reqId.toDouble(), // JS 无 Long，用 Double（reqId 为小计数器，精度安全）
            "method" to method,
            "path" to path,
            "body" to Base64.encodeToString(body, Base64.NO_WRAP),
          ),
        )
      }
    }

    OnDestroy {
      RustCryptoCore.syncRequestSink = null
    }

    AsyncFunction("startSyncServer") {
      // 返回 Rust 给的 JSON 字符串 {"port":...,"hosts":[...]}；JS 侧解析
      RustCryptoCore.startSyncServer()
    }

    AsyncFunction("stopSyncServer") {
      RustCryptoCore.stopSyncServer()
    }

    AsyncFunction("respondSyncRequest") { reqId: Double, status: Int, bodyB64: String ->
      val body = Base64.decode(bodyB64, Base64.NO_WRAP)
      RustCryptoCore.respondSyncRequest(reqId.toLong(), status, body)
    }

    AsyncFunction("deriveKEK") {
        password: String,
        saltB64: String,
        memKiB: Int,
        iter: Int,
        par: Int,
        keyLen: Int ->
      val salt = Base64.decode(saltB64, Base64.NO_WRAP)
      val key = RustCryptoCore.deriveKek(password, salt, memKiB, iter, par, keyLen)
      Base64.encodeToString(key, Base64.NO_WRAP)
    }

    AsyncFunction("sealAEAD") {
        keyB64: String, plaintextB64: String, aadB64: String ->
      val key = Base64.decode(keyB64, Base64.NO_WRAP)
      val pt = Base64.decode(plaintextB64, Base64.NO_WRAP)
      val aad = Base64.decode(aadB64, Base64.NO_WRAP)
      val sealed = RustCryptoCore.sealAead(key, pt, aad)
      Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    AsyncFunction("openAEAD") {
        keyB64: String, sealedB64: String, aadB64: String ->
      val key = Base64.decode(keyB64, Base64.NO_WRAP)
      val sealed = Base64.decode(sealedB64, Base64.NO_WRAP)
      val aad = Base64.decode(aadB64, Base64.NO_WRAP)
      val pt = RustCryptoCore.openAead(key, sealed, aad)
      Base64.encodeToString(pt, Base64.NO_WRAP)
    }

    AsyncFunction("randomBytes") { n: Int ->
      val bytes = RustCryptoCore.randomBytes(n)
      Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
  }
}
