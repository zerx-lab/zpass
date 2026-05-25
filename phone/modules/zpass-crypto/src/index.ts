// zpass-crypto —— Rust (cryptocore) Native Bridge
//
// 设计：
//   - 原生模块名固定为 "ZpassCrypto"（Android Kotlin / iOS Swift 注册时同名）
//   - 方法异步（AsyncFunction）：Argon2id 派生需要数百毫秒，必须跳出 JS 线程
//   - 二进制数据用 base64 在 JS ↔ Native 间传输：
//       * RN bridge 对 Uint8Array 无统一支持（New Arch 下 TurboModule 支持，
//         但 Expo Modules 当前在 Android 走 ByteArray ↔ JS string/base64 更稳）
//     上层 crypto.ts 用 toB64/fromB64 已经具备转换工具，桥层只搬字节
//
// 调用方：phone/lib/crypto.ts 在原生可用时 delegate 到这里，否则走 JS 兜底。

import { requireOptionalNativeModule } from "expo-modules-core";

interface ZpassCryptoNative {
  /** Argon2id 派生 KEK；返回 base64 编码的 32 字节 KEK */
  deriveKEK(
    password: string,
    saltB64: string,
    memKiB: number,
    iter: number,
    par: number,
    keyLen: number,
  ): Promise<string>;
  /** XChaCha20-Poly1305 加密；返回 base64 编码的 nonce+ct+tag */
  sealAEAD(keyB64: string, plaintextB64: string, aadB64: string): Promise<string>;
  /** 解密 sealAEAD 输出 */
  openAEAD(keyB64: string, sealedB64: string, aadB64: string): Promise<string>;
  /** CSPRNG；返回 base64 编码的 n 字节 */
  randomBytes(n: number): Promise<string>;
}

/**
 * 原生模块句柄；未编译 / 平台不支持时为 null。
 * 调用方需要做 isNativeCryptoAvailable() 判断后再用。
 */
const native = requireOptionalNativeModule<ZpassCryptoNative>("ZpassCrypto");

export function isNativeCryptoAvailable(): boolean {
  return native != null;
}

/** Argon2id KEK 派生（原生） */
export async function nativeDeriveKEK(
  password: string,
  saltB64: string,
  memKiB: number,
  iter: number,
  par: number,
  keyLen: number,
): Promise<string> {
  if (!native) throw new Error("ZpassCrypto native module not available");
  return native.deriveKEK(password, saltB64, memKiB, iter, par, keyLen);
}

export async function nativeSealAEAD(
  keyB64: string,
  plaintextB64: string,
  aadB64: string,
): Promise<string> {
  if (!native) throw new Error("ZpassCrypto native module not available");
  return native.sealAEAD(keyB64, plaintextB64, aadB64);
}

export async function nativeOpenAEAD(
  keyB64: string,
  sealedB64: string,
  aadB64: string,
): Promise<string> {
  if (!native) throw new Error("ZpassCrypto native module not available");
  return native.openAEAD(keyB64, sealedB64, aadB64);
}

export async function nativeRandomBytes(n: number): Promise<string> {
  if (!native) throw new Error("ZpassCrypto native module not available");
  return native.randomBytes(n);
}
