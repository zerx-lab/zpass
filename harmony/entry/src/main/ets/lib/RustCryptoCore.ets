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
}

const native: CryptocoreNative = cryptocore as CryptocoreNative;
const nativeDeriveKek = native.deriveKek;
const nativeSealAead = native.sealAead;
const nativeOpenAead = native.openAead;
const nativeRandomBytesRaw = native.randomBytes;
const nativeArgon2idRaw = native.argon2idRaw;
const nativeSealAeadWithNonce = native.sealAeadWithNonce;
const nativeOpenAeadWithNonce = native.openAeadWithNonce;

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
