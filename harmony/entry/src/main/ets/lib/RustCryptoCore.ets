// ArkTS 侧 cryptocore 封装
//
// 把 cryptocore/src/harmony.rs 通过 napi 暴露出的原始接口包装成
// 与 phone/lib/crypto.ts 对齐的、面向业务的 API。
//
// 调用方：lib/Crypto.ets —— 不应跨过本封装直接 import libcryptocore.so。
//
// 模块名 `libcryptocore.so` 在 entry/oh-package.json5 的 dependencies 中
// 通过 `file:./src/main/cpp/types/libcryptocore` 指向类型声明；运行时由
// 系统 napi loader 解析到 entry/libs/<arch>/libcryptocore.so。
//
// OHOS native module 的导入必须走 default 形式：napi-derive-ohos 的 ctor 用
// `napi_set_named_property(exports, "randomBytes", fn)` 把每个 #[napi] 函数挂到
// exports 对象上。ArkTS 端只有 default import 才会拿到这个 exports 对象本身；
// 写 `import { randomBytes } from 'libcryptocore.so'` 会让 OHOS loader 在
// 模块的"具名 export"表（与 exports 对象上的字段是两套）里找，自然找不到。

import cryptocore from 'libcryptocore.so';

/** 单个入站 LAN 同步请求（napi 下发；body 为零拷贝 Uint8Array）。 */
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

/** napi srpRegister 原生返回形态（ArrayBuffer 字段）。 */
interface CloudSrpRegistrationNative {
  salt: ArrayBuffer;
  verifier: ArrayBuffer;
}

interface CloudSrpClientStartNative {
  secretA: ArrayBuffer;
  aPub: ArrayBuffer;
}

interface CloudSrpClientFinishNative {
  m1: ArrayBuffer;
  k: ArrayBuffer;
}

interface CloudKeysetPairNative {
  publicKey: ArrayBuffer;
  privateKey: ArrayBuffer;
}

interface CryptocoreNative {
  deriveKek: (
    password: string,
    salt: ArrayBuffer,
    memKib: number,
    iter: number,
    par: number,
    keyLen: number,
  ) => Promise<ArrayBuffer>;
  sealAead: (key: ArrayBuffer, plaintext: ArrayBuffer, aad: ArrayBuffer) => ArrayBuffer;
  openAead: (key: ArrayBuffer, sealed: ArrayBuffer, aad: ArrayBuffer) => ArrayBuffer;
  randomBytes: (n: number) => ArrayBuffer;
  argon2idRaw: (
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memKib: number,
    iter: number,
    par: number,
    keyLen: number,
  ) => Promise<ArrayBuffer>;
  sealAeadWithNonce: (
    key: ArrayBuffer,
    plaintext: ArrayBuffer,
    aad: ArrayBuffer,
    nonce: ArrayBuffer,
  ) => ArrayBuffer;
  openAeadWithNonce: (
    key: ArrayBuffer,
    ciphertext: ArrayBuffer,
    aad: ArrayBuffer,
    nonce: ArrayBuffer,
  ) => ArrayBuffer;
  isSyncServerAvailable: () => boolean;
  // napi ThreadsafeFunction(CalleeHandled) 以 error-first 形态回调 JS：第一个实参
  // 是 err，第二个才是请求体。声明成两参以如实反映原生调用约定。
  registerSyncRequestHandler: (
    handler: (first: SyncRequest | null, second?: SyncRequest) => void,
  ) => void;
  startSyncServer: () => SyncServerInfo;
  stopSyncServer: () => void;
  respondSyncRequest: (reqId: number, status: number, body: Uint8Array) => void;
  deriveAuk: (
    password: string,
    saltEnc: ArrayBuffer,
    secretKeyRaw: ArrayBuffer,
    accountId: ArrayBuffer,
    memKib: number,
    iter: number,
    par: number,
  ) => Promise<ArrayBuffer>;
  deriveSrpX: (
    password: string,
    saltAuth: ArrayBuffer,
    secretKeyRaw: ArrayBuffer,
    accountId: ArrayBuffer,
    memKib: number,
    iter: number,
    par: number,
  ) => Promise<ArrayBuffer>;
  srpRegister: (xBytes: ArrayBuffer, salt: ArrayBuffer) => CloudSrpRegistrationNative;
  srpClientStart: () => CloudSrpClientStartNative;
  srpClientFinish: (
    secretA: ArrayBuffer,
    aPub: ArrayBuffer,
    bPub: ArrayBuffer,
    xBytes: ArrayBuffer,
    salt: ArrayBuffer,
    identity: ArrayBuffer,
  ) => CloudSrpClientFinishNative;
  keysetGenerate: () => CloudKeysetPairNative;
  sealToPubkey: (recipientPub: ArrayBuffer, plaintext: ArrayBuffer) => ArrayBuffer;
  openWithPrivkey: (privKey: ArrayBuffer, sealed: ArrayBuffer) => ArrayBuffer;
}

const native: CryptocoreNative = cryptocore as CryptocoreNative;
const nativeDeriveKek = native.deriveKek;
const nativeSealAead = native.sealAead;
const nativeOpenAead = native.openAead;
const nativeRandomBytesRaw = native.randomBytes;
const nativeArgon2idRaw = native.argon2idRaw;
const nativeSealAeadWithNonce = native.sealAeadWithNonce;
const nativeOpenAeadWithNonce = native.openAeadWithNonce;
const nativeIsSyncServerAvailable = native.isSyncServerAvailable;
const nativeRegisterSyncRequestHandler = native.registerSyncRequestHandler;
const nativeStartSyncServerRaw = native.startSyncServer;
const nativeStopSyncServerRaw = native.stopSyncServer;
const nativeRespondSyncRequestRaw = native.respondSyncRequest;
const nativeDeriveAuk = native.deriveAuk;
const nativeDeriveSrpX = native.deriveSrpX;
const nativeSrpRegister = native.srpRegister;
const nativeSrpClientStart = native.srpClientStart;
const nativeSrpClientFinish = native.srpClientFinish;
const nativeKeysetGenerate = native.keysetGenerate;
const nativeSealToPubkey = native.sealToPubkey;
const nativeOpenWithPrivkey = native.openWithPrivkey;

/* ----------------------------------------------------------------------------
 * 模块可用性探测
 * -------------------------------------------------------------------------- */

let nativeAvailable: boolean | null = null;

export function isNativeCryptoAvailable(): boolean {
  if (nativeAvailable !== null) return nativeAvailable;
  try {
    const probe: ArrayBuffer = nativeRandomBytesRaw(1);
    nativeAvailable = probe.byteLength === 1;
  } catch (_e) {
    nativeAvailable = false;
  }
  return nativeAvailable;
}

/* ----------------------------------------------------------------------------
 * Uint8Array ↔ ArrayBuffer
 * -------------------------------------------------------------------------- */

function toAB(u8: Uint8Array): ArrayBuffer {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
    return u8.buffer.slice(0);
  }
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function fromAB(ab: ArrayBuffer): Uint8Array {
  return new Uint8Array(ab);
}

/* ----------------------------------------------------------------------------
 * 业务封装
 * -------------------------------------------------------------------------- */

export async function deriveKek(
  password: string,
  salt: Uint8Array,
  memKib: number,
  iter: number,
  par: number,
  keyLen: number,
): Promise<Uint8Array> {
  const out: ArrayBuffer = await nativeDeriveKek(
    password, toAB(salt), memKib, iter, par, keyLen,
  );
  return fromAB(out);
}

export function sealAead(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  const out: ArrayBuffer = nativeSealAead(toAB(key), toAB(plaintext), toAB(aad));
  return fromAB(out);
}

export function openAead(
  key: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  const out: ArrayBuffer = nativeOpenAead(toAB(key), toAB(sealed), toAB(aad));
  return fromAB(out);
}

export function randomBytes(n: number): Uint8Array {
  const out: ArrayBuffer = nativeRandomBytesRaw(n);
  return fromAB(out);
}

/* ----------------------------------------------------------------------------
 * Sync 专用 —— PSK 派生 + 外部 nonce AEAD
 *
 * 与 phone/lib/sync-protocol.ts 一一对应。
 * -------------------------------------------------------------------------- */

/** Argon2id 通用派生（salt 任意长度；password 走 bytes） */
export async function argon2idRaw(
  password: Uint8Array,
  salt: Uint8Array,
  memKib: number,
  iter: number,
  par: number,
  keyLen: number,
): Promise<Uint8Array> {
  const out: ArrayBuffer = await nativeArgon2idRaw(
    toAB(password), toAB(salt), memKib, iter, par, keyLen,
  );
  return fromAB(out);
}

/** XChaCha20-Poly1305 加密；调用方提供 24 字节 nonce；输出 ct ‖ 16-byte tag（不含 nonce） */
export function sealAeadWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const out: ArrayBuffer = nativeSealAeadWithNonce(
    toAB(key), toAB(plaintext), toAB(aad), toAB(nonce),
  );
  return fromAB(out);
}

/** 解密 sealAeadWithNonce 输出 */
export function openAeadWithNonce(
  key: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const out: ArrayBuffer = nativeOpenAeadWithNonce(
    toAB(key), toAB(ciphertext), toAB(aad), toAB(nonce),
  );
  return fromAB(out);
}

/* ----------------------------------------------------------------------------
 * 局域网同步服务端桥 —— 设备作为 LAN 同步 server
 *
 * 与 phone/modules/zpass-crypto 的 nativeStartSyncServer / addSyncRequestListener /
 * nativeRespondSyncRequest 语义对齐，但：
 *   - 入站请求经 napi ThreadsafeFunction 直接回调（非 Expo 事件发射器），
 *     SyncServer.ets 注册一次 handler，每个请求被调用一次。
 *   - body 走原始 Uint8Array（零拷贝），不像 phone 端走 base64。
 * 调用方（SyncServer.ets）须先 addSyncRequestListener，再 await nativeStartSyncServer。
 * -------------------------------------------------------------------------- */

let syncServerAvailable: boolean | null = null;

export function isNativeSyncServerAvailable(): boolean {
  if (syncServerAvailable !== null) return syncServerAvailable;
  try {
    syncServerAvailable = nativeIsSyncServerAvailable();
  } catch (_e) {
    syncServerAvailable = false;
  }
  return syncServerAvailable;
}

/** 注册每个入站同步请求的 handler。须在 nativeStartSyncServer 之前调用一次。 */
export function addSyncRequestListener(handler: (req: SyncRequest) => void): void {
  // 关键：cryptocore/src/harmony.rs 的 SYNC_TSFN 是默认 CalleeHandled 策略的
  // ThreadsafeFunction，反向回调以 error-first (err, req) 两参触发 JS，Rust 端恒以
  // Ok(req) 调用 → err 恒为 null、真正的请求体是第二个实参。
  // 若把单参 handler 直接透传，handler 的 req 会绑定到 err(null)，导致每个入站请求都
  // 拿不到 body、never 调用 respondSyncRequest，Rust worker park 至 504，对端表现为
  // 「开启服务端后无法连接」。这里取真正的请求对象再转交上层。
  // second 缺省的兜底分支同时兼容潜在的单参(Fatal)实现，避免约定再变时回归。
  nativeRegisterSyncRequestHandler(
    (first: SyncRequest | null, second?: SyncRequest) => {
      const req: SyncRequest | null = second !== undefined ? second : first;
      if (req !== null && req !== undefined) {
        handler(req);
      }
    },
  );
}

/** 启动同步服务端，返回绑定端口与可路由 LAN IPv4。原生为同步，包成 Promise。 */
export async function nativeStartSyncServer(): Promise<SyncServerInfo> {
  return nativeStartSyncServerRaw();
}

/** 停止同步服务端。幂等。 */
export async function nativeStopSyncServer(): Promise<void> {
  nativeStopSyncServerRaw();
}

/** 回传被 park 的请求的响应。reqId 取自 SyncRequest，body 为原始字节。 */
export async function nativeRespondSyncRequest(
  reqId: number,
  status: number,
  body: Uint8Array,
): Promise<void> {
  nativeRespondSyncRequestRaw(reqId, status, body);
}

/* ----------------------------------------------------------------------------
 * 云同步专用 —— 2SKD（AUK / SRP-x）+ SRP-6a 握手 + X25519 keyset
 *
 * 与 desktop internal/cloudcrypto/* 及服务端字节级一致；ArkTS 侧只做
 * Uint8Array ↔ ArrayBuffer 转换，不复写任何密码学逻辑（缺 .so 直接抛错）。
 * -------------------------------------------------------------------------- */

/** SRP-6a 注册产物：认证盐 + verifier（256B PAD）。 */
export interface SrpRegistration {
  salt: Uint8Array;
  verifier: Uint8Array;
}

/** SRP-6a 客户端 start：一次性私钥 a + 公开 A（256B PAD）。 */
export interface SrpClientStart {
  secretA: Uint8Array;
  aPub: Uint8Array;
}

/** SRP-6a 客户端 finish：证明 M1 + 会话密钥 K。 */
export interface SrpClientFinish {
  m1: Uint8Array;
  k: Uint8Array;
}

/** 账户 X25519 keyset 对（pub32 / priv32）。 */
export interface KeysetPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** 2SKD 派生 AUK；password 走原始串（规范化由原生完成），Argon2id 重活异步。 */
export async function deriveAuk(
  password: string,
  saltEnc: Uint8Array,
  secretKeyRaw: Uint8Array,
  accountId: Uint8Array,
  memKib: number,
  iter: number,
  par: number,
): Promise<Uint8Array> {
  const out: ArrayBuffer = await nativeDeriveAuk(
    password, toAB(saltEnc), toAB(secretKeyRaw), toAB(accountId), memKib, iter, par,
  );
  return fromAB(out);
}

/** 2SKD 派生 SRP-x（32B）；slow_salt = srp_salt，info="zpass-srpx-v1"。 */
export async function deriveSrpX(
  password: string,
  saltAuth: Uint8Array,
  secretKeyRaw: Uint8Array,
  accountId: Uint8Array,
  memKib: number,
  iter: number,
  par: number,
): Promise<Uint8Array> {
  const out: ArrayBuffer = await nativeDeriveSrpX(
    password, toAB(saltAuth), toAB(secretKeyRaw), toAB(accountId), memKib, iter, par,
  );
  return fromAB(out);
}

/** SRP-6a 注册：x = big-endian(32B SRP-x)，返回 verifier = g^x mod N。 */
export function srpRegister(xBytes: Uint8Array, salt: Uint8Array): SrpRegistration {
  const r: CloudSrpRegistrationNative = nativeSrpRegister(toAB(xBytes), toAB(salt));
  return { salt: fromAB(r.salt), verifier: fromAB(r.verifier) };
}

/** SRP-6a 客户端 start：生成一次性 a 与 A = g^a mod N。 */
export function srpClientStart(): SrpClientStart {
  const r: CloudSrpClientStartNative = nativeSrpClientStart();
  return { secretA: fromAB(r.secretA), aPub: fromAB(r.aPub) };
}

/** SRP-6a 客户端 finish：算 S/K/M1。identity = 小写邮箱的 UTF-8 字节。 */
export function srpClientFinish(
  secretA: Uint8Array,
  aPub: Uint8Array,
  bPub: Uint8Array,
  xBytes: Uint8Array,
  salt: Uint8Array,
  identity: Uint8Array,
): SrpClientFinish {
  const r: CloudSrpClientFinishNative = nativeSrpClientFinish(
    toAB(secretA), toAB(aPub), toAB(bPub), toAB(xBytes), toAB(salt), toAB(identity),
  );
  return { m1: fromAB(r.m1), k: fromAB(r.k) };
}

/** 生成账户 X25519 keyset 对（pub32 / priv32）。 */
export function keysetGenerate(): KeysetPair {
  const r: CloudKeysetPairNative = nativeKeysetGenerate();
  return { publicKey: fromAB(r.publicKey), privateKey: fromAB(r.privateKey) };
}

/** X25519 sealed-box 封装：eph_pub(32) ‖ AEAD（aad="zpass-vaultkey-v1"）。 */
export function sealToPubkey(recipientPub: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return fromAB(nativeSealToPubkey(toAB(recipientPub), toAB(plaintext)));
}

/** 用账户私钥解封 sealToPubkey 输出。 */
export function openWithPrivkey(privKey: Uint8Array, sealed: Uint8Array): Uint8Array {
  return fromAB(nativeOpenWithPrivkey(toAB(privKey), toAB(sealed)));
}
