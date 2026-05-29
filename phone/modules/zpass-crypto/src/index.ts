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

import {
  requireOptionalNativeModule,
  type EventSubscription,
} from "expo-modules-core";

/**
 * 局域网同步服务端的入站请求事件。Rust worker → Kotlin onSyncRequest → 此事件。
 * body 是 base64 编码的请求体；JS 侧 handleSyncRequest 算完调 respondSyncRequest 回传。
 */
export interface SyncRequestEvent {
  reqId: number;
  method: string;
  path: string;
  body: string; // base64
}

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

  // ---- 局域网同步服务端（仅 Android 编入；其他平台为 undefined）----
  /** 启动监听，返回 JSON 字符串 {"port":number,"hosts":string[]} */
  startSyncServer(): Promise<string>;
  /** 停止监听；幂等 */
  stopSyncServer(): Promise<void>;
  /** 回传 JS 计算好的响应（status = HTTP 状态码，bodyB64 = 响应体 base64） */
  respondSyncRequest(reqId: number, status: number, bodyB64: string): Promise<void>;
  /** 订阅入站请求事件 */
  addListener(
    eventName: "onSyncRequest",
    listener: (event: SyncRequestEvent) => void,
  ): EventSubscription;
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

/* ----------------------------------------------------------------------------
 * 局域网同步服务端（手机作为 server）—— 仅 Android 原生可用
 * -------------------------------------------------------------------------- */

/** 原生是否支持作为同步服务端监听（Android 已编入；iOS / web 为 false） */
export function isNativeSyncServerAvailable(): boolean {
  return native != null && typeof native.startSyncServer === "function";
}

/** 启动监听，返回绑定端口与本机 LAN IPv4 列表 */
export async function nativeStartSyncServer(): Promise<{
  port: number;
  hosts: string[];
}> {
  if (!native) throw new Error("ZpassCrypto sync server not available");
  const json = await native.startSyncServer();
  return JSON.parse(json) as { port: number; hosts: string[] };
}

/** 停止监听；未启动 / 不支持时为 no-op */
export async function nativeStopSyncServer(): Promise<void> {
  if (!native?.stopSyncServer) return;
  await native.stopSyncServer();
}

/** 回传 JS 计算好的响应给 Rust worker */
export async function nativeRespondSyncRequest(
  reqId: number,
  status: number,
  bodyB64: string,
): Promise<void> {
  if (!native) throw new Error("ZpassCrypto sync server not available");
  await native.respondSyncRequest(reqId, status, bodyB64);
}

/** 订阅入站请求事件；返回的订阅需在停服时 remove() */
export function addSyncRequestListener(
  listener: (event: SyncRequestEvent) => void,
): EventSubscription {
  if (!native) throw new Error("ZpassCrypto sync server not available");
  return native.addListener("onSyncRequest", listener);
}
