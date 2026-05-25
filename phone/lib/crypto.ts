// ZPass Phone —— 加密原语
//
// 与 desktop/internal/services/cryptoutil.go 一一对齐：
//   - Argon2id 派生 KEK（默认 64 MiB / 3 iter / 4 lanes）
//   - XChaCha20-Poly1305 AEAD（24 字节随机 nonce + Poly1305 tag）
//   - 双层密钥：KEK 仅用于包装 DEK；DEK 用于加密每条 item
//   - aad 绑定上下文（"zpass:dek" / "zpass:verifier" / item.id）
//
// 实现：纯 JS @noble/hashes + @noble/ciphers，
// 随机数走 expo-crypto（CSPRNG，原生 secure random）。

import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import * as ExpoCrypto from "expo-crypto";
import { argon2id as wasmArgon2id } from "hash-wasm";

import {
  isNativeCryptoAvailable,
  nativeDeriveKEK,
} from "../modules/zpass-crypto";

/* hash-wasm 用 WebAssembly 实现 argon2id，比 noble 纯 JS 快 50-100×。
 * Hermes 默认不暴露 WebAssembly 全局；环境探测一次，缺失时回退 noble。
 * Web / JSC 等支持 WASM 的平台直接走原生 WASM 路径。 */
const HAS_WASM = typeof globalThis.WebAssembly !== "undefined";

/* gomobile bind 出来的 Go 加密原语；Android / iOS 真机上可用。
 * 不可用时（Web、未编译 AAR、Hermes 无原生模块）回退到 hash-wasm / noble。 */
const HAS_NATIVE = isNativeCryptoAvailable();

/* ----------------------------------------------------------------------------
 * 常量（与 desktop 对齐）
 * -------------------------------------------------------------------------- */

/** 对称密钥长度：KEK / DEK 都是 32 字节，匹配 XChaCha20-Poly1305 */
export const KEY_SIZE = 32;
/** XChaCha20-Poly1305 nonce 长度 */
export const NONCE_SIZE = 24;
/** Argon2id salt 长度 */
export const SALT_SIZE = 32;

/** verifier 明文：解锁时用 DEK 解开后必须等于此串 */
export const VERIFIER_PLAINTEXT = "zpass-vault-verifier-v1";

/** AAD 上下文标识 —— 防止密文跨上下文挪用 */
export const AAD_DEK = "zpass:dek";
export const AAD_VERIFIER = "zpass:verifier";

/* ----------------------------------------------------------------------------
 * Argon2id 参数
 * -------------------------------------------------------------------------- */

export interface Argon2idParams {
  /** 内存成本，单位 KiB */
  memoryKiB: number;
  /** 时间成本，pass 数 */
  iterations: number;
  /** 并行度，lane 数 */
  parallelism: number;
  /** 输出长度（字节） */
  keyLen: number;
}

/**
 * 默认参数 —— 在 Initialize 时根据运行环境选择，写入 vault_meta 后永久绑定。
 *
 *   - 原生 Rust (cryptocore .so/.a)：64 MiB / 3 iter / 4 lanes
 *     与 desktop cryptoutil.DefaultArgon2id 完全对齐；单次 ~200-400ms。
 *   - WASM 可用（web / JSC）：32 MiB / 3 iter / 2 lanes
 *     hash-wasm 实现 ~300-600ms。攻击者每核每秒仍只能尝试 ~2 次。
 *   - WASM 不可用（Hermes 默认）：8 MiB / 2 iter / 1 lane
 *     noble 纯 JS 实现 ~3-6s。仍守住 OWASP 最低线（≥ 8 MiB 内存抗 GPU）。
 *
 * 解锁路径**永远**使用 vault_meta 中记录的参数，与本函数无关 ——
 * 这是双层密钥设计的基本不变量，不能因为环境变化破坏旧 vault 的可解性。
 */
export function defaultArgon2idParams(): Argon2idParams {
  if (HAS_NATIVE) {
    return {
      memoryKiB: 64 * 1024,
      iterations: 3,
      parallelism: 4,
      keyLen: KEY_SIZE,
    };
  }
  if (HAS_WASM) {
    return {
      memoryKiB: 32 * 1024,
      iterations: 3,
      parallelism: 2,
      keyLen: KEY_SIZE,
    };
  }
  return {
    memoryKiB: 8 * 1024,
    iterations: 2,
    parallelism: 1,
    keyLen: KEY_SIZE,
  };
}

/** 校验从持久化层读出的参数处于合理范围内 */
export function validateArgon2idParams(p: Argon2idParams): void {
  if (p.memoryKiB < 8 * 1024) {
    throw new Error(`argon2id memory too low: ${p.memoryKiB} KiB (min 8192)`);
  }
  if (p.iterations < 1) {
    throw new Error(`argon2id iterations too low: ${p.iterations}`);
  }
  if (p.parallelism < 1) {
    throw new Error(`argon2id parallelism too low: ${p.parallelism}`);
  }
  if (p.keyLen !== KEY_SIZE) {
    throw new Error(`argon2id keyLen must be ${KEY_SIZE}, got ${p.keyLen}`);
  }
}

/* ----------------------------------------------------------------------------
 * 随机数
 * -------------------------------------------------------------------------- */

/** 生成 n 字节加密安全随机数（n ≤ 1024 由 expo-crypto 限制） */
export function randomBytes(n: number): Uint8Array {
  if (n <= 0) throw new Error(`invalid random byte count: ${n}`);
  // getRandomBytes 是原生 CSPRNG，单次最多 1024 字节；vault 用的最大就是
  // 32 字节 DEK，足够覆盖。如需更长 buffer 改成循环填充即可。
  return ExpoCrypto.getRandomBytes(n);
}

/* ----------------------------------------------------------------------------
 * 字节内存抹零（best-effort，JS 没有真正手动 free）
 * -------------------------------------------------------------------------- */

export function wipeBytes(b: Uint8Array | null | undefined): void {
  if (!b) return;
  b.fill(0);
}

/* ----------------------------------------------------------------------------
 * KDF：Argon2id
 * -------------------------------------------------------------------------- */

/** 同步派生（仅 noble 路径；测试与 hash-wasm 不可用时兜底） */
export function deriveKEK(
  password: string,
  salt: Uint8Array,
  params: Argon2idParams,
): Uint8Array {
  if (!password) throw new Error("master password cannot be empty");
  if (salt.length !== SALT_SIZE) {
    throw new Error(`salt length must be ${SALT_SIZE}, got ${salt.length}`);
  }
  validateArgon2idParams(params);
  return nobleArgon2id(password, salt, {
    m: params.memoryKiB,
    t: params.iterations,
    p: params.parallelism,
    dkLen: params.keyLen,
  });
}

/**
 * 异步派生 —— UI 路径使用，避免阻塞主线程
 *
 * 派生路径优先级（高 → 低）：
 *   1. 原生 Rust (cryptocore)：Android/iOS 真机上的最优路径，约 200-400ms
 *   2. hash-wasm：Web / JSC 上的 WASM 实现，约 300-600ms
 *   3. noble 纯 JS：Hermes 无原生模块时兜底，约 3-6s
 *
 * 所有路径都严格使用传入的 params —— 不能根据当前环境 downscale 参数，
 * 否则会派生出错误的 KEK 让旧 vault 解不开。
 */
export async function deriveKEKAsync(
  password: string,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  if (!password) throw new Error("master password cannot be empty");
  if (salt.length !== SALT_SIZE) {
    throw new Error(`salt length must be ${SALT_SIZE}, got ${salt.length}`);
  }
  validateArgon2idParams(params);

  if (HAS_NATIVE) {
    const keyB64 = await nativeDeriveKEK(
      password,
      toB64(salt),
      params.memoryKiB,
      params.iterations,
      params.parallelism,
      params.keyLen,
    );
    return fromB64(keyB64);
  }
  if (HAS_WASM) {
    return await wasmArgon2id({
      password,
      salt,
      iterations: params.iterations,
      parallelism: params.parallelism,
      memorySize: params.memoryKiB,
      hashLength: params.keyLen,
      outputType: "binary",
    });
  }
  return nobleArgon2id(password, salt, {
    m: params.memoryKiB,
    t: params.iterations,
    p: params.parallelism,
    dkLen: params.keyLen,
  });
}

/** 当前进程是否有原生 KDF 加速 */
export function isNativeKDF(): boolean {
  return HAS_NATIVE;
}

/** 当前进程是否走 WASM 加速路径（用于 UI 提示派生大致时长） */
export function isWasmKDF(): boolean {
  return HAS_WASM;
}

/* ----------------------------------------------------------------------------
 * AEAD：XChaCha20-Poly1305
 * -------------------------------------------------------------------------- */

/**
 * 封装格式：[24-byte nonce][ciphertext+16-byte tag]
 *
 * - aad 不参与加密但参与认证，解密时必须给出完全相同的 aad
 * - 我们用 aad 绑定上下文：包装 DEK = "zpass:dek"，verifier = "zpass:verifier"，
 *   item 加密 = item.id —— 防御密文跨上下文挪用
 */
export function sealAEAD(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_SIZE) {
    throw new Error(`aead key length must be ${KEY_SIZE}, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_SIZE);
  const cipher = xchacha20poly1305(key, nonce, aad);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(NONCE_SIZE + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_SIZE);
  return out;
}

/** 解封：从 [nonce][ct+tag] 中分离 nonce 并验证 + 解密 */
export function openAEAD(
  key: Uint8Array,
  envelope: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_SIZE) {
    throw new Error(`aead key length must be ${KEY_SIZE}, got ${key.length}`);
  }
  if (envelope.length < NONCE_SIZE + 16) {
    throw new Error("aead envelope too short");
  }
  const nonce = envelope.subarray(0, NONCE_SIZE);
  const ct = envelope.subarray(NONCE_SIZE);
  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ct);
}

/* ----------------------------------------------------------------------------
 * Base64（Uint8Array 与字符串互转，用于 JSON 持久化）
 * -------------------------------------------------------------------------- */

/** Uint8Array → base64（标准字母表） */
export function toB64(bytes: Uint8Array): string {
  // 字节 → 二进制字符串 → btoa；RN 全局 btoa 存在（Hermes 提供）
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

/** base64 → Uint8Array */
export function fromB64(s: string): Uint8Array {
  const binary = globalThis.atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ----------------------------------------------------------------------------
 * UTF-8（字符串 ↔ 字节，用于明文 / AAD）
 * -------------------------------------------------------------------------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return dec.decode(b);
}

/* ----------------------------------------------------------------------------
 * 常量时间比较（防止时序攻击）
 * -------------------------------------------------------------------------- */

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ----------------------------------------------------------------------------
 * 主密码强度校验
 * -------------------------------------------------------------------------- */

export function validatePasswordStrength(password: string): void {
  if (!password) throw new Error("主密码不能为空");
  if (password.length < 8)
    throw new Error("主密码至少 8 位字符");
}
