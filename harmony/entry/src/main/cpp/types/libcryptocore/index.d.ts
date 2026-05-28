// cryptocore napi 模块的 TypeScript 类型声明
//
// 由 cryptocore/src/harmony.rs 的 #[napi] 宏导出。
// 与 phone/modules/zpass-crypto/src/index.ts 的接口语义对齐，
// 但传输形态从 base64 string 换成 ArrayBuffer（napi-rs Buffer → ArkTS ArrayBuffer），
// 少一次编解码。
//
// 调用方：harmony/entry/src/main/ets/lib/RustCryptoCore.ets
//
// 注意：OHOS native module 通过 `napi_set_named_property` 把所有 #[napi] 函数挂在
// exports 对象的属性上。ArkTS 端必须 default import 才能拿到这个对象本身：
//   import cryptocore from 'libcryptocore.so';
//   cryptocore.randomBytes(16);
// 写 `import { randomBytes } from '...'` 会去模块的 ES 命名 export 列表里查，
// 与 exports 对象上的属性是两套，找不到。

interface Cryptocore {
  /**
   * Argon2id 派生 KEK
   *
   * @param password   主密码（UTF-8 字符串）
   * @param salt       Argon2id 盐（32 字节）
   * @param memKib     内存成本（KiB）
   * @param iter       迭代次数
   * @param par        并行度
   * @param keyLen     输出字节数（恒为 32）
   * @returns          32 字节 KEK
   *
   * Argon2id 派生耗时数百毫秒，本函数走 napi-rs AsyncTask，UI 主线程不阻塞。
   */
  deriveKek: (
    password: string,
    salt: ArrayBuffer,
    memKib: number,
    iter: number,
    par: number,
    keyLen: number,
  ) => Promise<ArrayBuffer>;

  /**
   * XChaCha20-Poly1305 加密
   *
   * @param key        32 字节对称密钥
   * @param plaintext  明文
   * @param aad        附加认证数据（不参与加密但参与认证）
   * @returns          24 字节 nonce ‖ ciphertext ‖ 16 字节 tag
   */
  sealAead: (key: ArrayBuffer, plaintext: ArrayBuffer, aad: ArrayBuffer) => ArrayBuffer;

  /**
   * 解密 sealAead 输出
   *
   * 任何认证失败（密钥错 / 密文损坏 / aad 不匹配）统一抛同一种错误，
   * 防侧信道。
   */
  openAead: (key: ArrayBuffer, sealed: ArrayBuffer, aad: ArrayBuffer) => ArrayBuffer;

  /**
   * 操作系统 CSPRNG
   *
   * @param n  字节数；必须 > 0
   */
  randomBytes: (n: number) => ArrayBuffer;
}

declare const cryptocore: Cryptocore;
export default cryptocore;
