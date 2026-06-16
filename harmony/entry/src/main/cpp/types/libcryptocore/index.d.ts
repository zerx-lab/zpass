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

/** 单个入站 LAN 同步请求。body 是原始请求体（零拷贝 Uint8Array）。 */
export interface SyncRequest {
  reqId: number;
  method: string;
  path: string;
  body: Uint8Array;
}

/** startSyncServer 的返回：绑定端口 + 可路由 LAN IPv4 列表。 */
export interface SyncServerInfo {
  port: number;
  hosts: string[];
}

/** SRP-6a 注册产物：认证盐 + verifier（256B PAD）。 */
export interface CloudSrpRegistration {
  salt: ArrayBuffer;
  verifier: ArrayBuffer;
}

/** SRP-6a 客户端 start：一次性私钥 a + 公开 A（256B PAD）。 */
export interface CloudSrpClientStart {
  secretA: ArrayBuffer;
  aPub: ArrayBuffer;
}

/** SRP-6a 客户端 finish：证明 M1 + 会话密钥 K。 */
export interface CloudSrpClientFinish {
  m1: ArrayBuffer;
  k: ArrayBuffer;
}

/** 账户 X25519 keyset 对（pub32 / priv32）。 */
export interface CloudKeysetPair {
  publicKey: ArrayBuffer;
  privateKey: ArrayBuffer;
}

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

  /**
   * Argon2id 通用派生 —— sync session key 路径
   *
   * 与 deriveKek 的区别：salt 与 keyLen 不限定长度；password 走 bytes。
   * 与 phone/lib/sync-protocol.ts deriveSyncSessionKey 一一对应。
   */
  argon2idRaw: (
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memKib: number,
    iter: number,
    par: number,
    keyLen: number,
  ) => Promise<ArrayBuffer>;

  /**
   * XChaCha20-Poly1305 加密（外部 nonce）
   * 输出 = ciphertext ‖ 16-byte tag（**不含 nonce**）
   *
   * sync-protocol 用此 API 把协议规定的 24-byte nonce
   * [dir(1)][rand(16)][counter(7-byte BE)] 喂进来。
   */
  sealAeadWithNonce: (
    key: ArrayBuffer,
    plaintext: ArrayBuffer,
    aad: ArrayBuffer,
    nonce: ArrayBuffer,
  ) => ArrayBuffer;

  /** 解密 sealAeadWithNonce 输出 */
  openAeadWithNonce: (
    key: ArrayBuffer,
    ciphertext: ArrayBuffer,
    aad: ArrayBuffer,
    nonce: ArrayBuffer,
  ) => ArrayBuffer;

  /**
   * 本设备是否可作为 LAN 同步服务端。HarmonyOS 上恒为 true（传输层已编译进 .so）。
   */
  isSyncServerAvailable: () => boolean;

  /**
   * 注册每个入站同步请求触发的 handler。
   *
   * 必须在 startSyncServer 之前调用一次。handler 收到 SyncRequest 后须最终调用
   * respondSyncRequest(reqId, status, body) 回传。底层走 napi ThreadsafeFunction，
   * handler 在 ArkTS（JS）线程上被调用。
   */
  registerSyncRequestHandler: (handler: (req: SyncRequest) => void) => void;

  /**
   * 启动 LAN 同步服务端（绑定 0.0.0.0 的 OS 分配端口）。幂等。
   * 返回绑定端口与可路由 LAN IPv4 列表。
   */
  startSyncServer: () => SyncServerInfo;

  /** 停止 LAN 同步服务端。幂等。 */
  stopSyncServer: () => void;

  /**
   * 回传被 park 的请求的响应。
   * reqId 未知（已超时 / 已停止）则忽略；status 不在 100..599 归一为 500。
   */
  respondSyncRequest: (reqId: number, status: number, body: Uint8Array) => void;

  /* -- 云同步：2SKD / SRP-6a / X25519 keyset（由 cryptocore harmony.rs 导出） -- */

  /**
   * 2SKD 派生 Account Unlock Key（AUK）。
   *
   * out = Argon2id(NFKD(trim(password)), saltEnc) XOR
   *       HKDF-SHA256(ikm=secretKeyRaw, salt=accountId, info="zpass-auk-v1")
   *
   * password 走原始串（规范化 trim+NFKD 由原生完成）；Argon2id 重活走 AsyncTask。
   */
  deriveAuk: (
    password: string,
    saltEnc: ArrayBuffer,
    secretKeyRaw: ArrayBuffer,
    accountId: ArrayBuffer,
    memKib: number,
    iter: number,
    par: number,
  ) => Promise<ArrayBuffer>;

  /** 2SKD 派生 SRP-x（32 字节）—— slow_salt = srp_salt，info="zpass-srpx-v1"。 */
  deriveSrpX: (
    password: string,
    saltAuth: ArrayBuffer,
    secretKeyRaw: ArrayBuffer,
    accountId: ArrayBuffer,
    memKib: number,
    iter: number,
    par: number,
  ) => Promise<ArrayBuffer>;

  /** SRP-6a 注册：x = big-endian(32B SRP-x)，返回 verifier = g^x mod N（256B PAD）。 */
  srpRegister: (xBytes: ArrayBuffer, salt: ArrayBuffer) => CloudSrpRegistration;

  /** SRP-6a 客户端 start：生成一次性 a 与 A = g^a mod N（256B PAD）。 */
  srpClientStart: () => CloudSrpClientStart;

  /**
   * SRP-6a 客户端 finish：算 S / K / M1。identity = 小写邮箱的 UTF-8 字节。
   * 服务端 M2 校验在 ArkTS 侧用 SHA-256(PAD(A)‖M1‖K) 重算后常数时间比较。
   */
  srpClientFinish: (
    secretA: ArrayBuffer,
    aPub: ArrayBuffer,
    bPub: ArrayBuffer,
    xBytes: ArrayBuffer,
    salt: ArrayBuffer,
    identity: ArrayBuffer,
  ) => CloudSrpClientFinish;

  /** 生成账户 X25519 keyset 对（pub32 / priv32）。 */
  keysetGenerate: () => CloudKeysetPair;

  /**
   * X25519 sealed-box 封装：输出 = eph_pub(32) ‖ AEAD（aad="zpass-vaultkey-v1"）。
   * 用账户公钥包裹 per-vault key。
   */
  sealToPubkey: (recipientPub: ArrayBuffer, plaintext: ArrayBuffer) => ArrayBuffer;

  /** 用账户私钥解封 sealToPubkey 输出。 */
  openWithPrivkey: (privKey: ArrayBuffer, sealed: ArrayBuffer) => ArrayBuffer;
}

declare const cryptocore: Cryptocore;
export default cryptocore;
