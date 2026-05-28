// ZPass HarmonyOS —— 加密原语
//
// 与 phone/lib/crypto.ts 一一对齐：
//   - Argon2id 派生 KEK（默认 64 MiB / 3 iter / 4 lanes，与 desktop 完全一致）
//   - XChaCha20-Poly1305 AEAD（24 字节随机 nonce + Poly1305 tag）
//   - 双层密钥：KEK 仅用于包装 DEK；DEK 用于加密每条 item
//   - aad 绑定上下文（"zpass:dek" / "zpass:verifier" / item.id）
//
// 实现：所有加密走 cryptocore (Rust napi-rs)；
// 鸿蒙端不再引入 noble / hash-wasm 之类的 JS 兜底
// —— 缺 .so 直接报错，让用户先 `task crypto`。

import {
  deriveKek as nativeDeriveKek,
  isNativeCryptoAvailable,
  openAead as nativeOpenAead,
  randomBytes as nativeRandomBytes,
  sealAead as nativeSealAead,
} from './RustCryptoCore';
import { util } from '@kit.ArkTS';

/* ----------------------------------------------------------------------------
 * 常量（与 desktop / phone 对齐）
 * -------------------------------------------------------------------------- */

/** KEK / DEK 长度（XChaCha20 密钥长度） */
export const KEY_SIZE: number = 32;
/** XChaCha20-Poly1305 nonce 长度 */
export const NONCE_SIZE: number = 24;
/** Argon2id salt 长度 */
export const SALT_SIZE: number = 32;

/** verifier 明文：解锁时用 DEK 解开后必须等于此串 */
export const VERIFIER_PLAINTEXT: string = 'zpass-vault-verifier-v1';

/** AAD 上下文标识 —— 防止密文跨上下文挪用 */
export const AAD_DEK: string = 'zpass:dek';
export const AAD_VERIFIER: string = 'zpass:verifier';
/** 信任设备包装 DEK 的 AAD —— 与 desktop trusteddevice entropy 同义 */
export const AAD_TRUSTED_DEVICE: string = 'zpass:trusted-device:v1';

/* ----------------------------------------------------------------------------
 * Argon2id 参数
 * -------------------------------------------------------------------------- */

export interface Argon2idParams {
  /** 内存成本（KiB） */
  memoryKiB: number;
  /** 时间成本（pass 数） */
  iterations: number;
  /** 并行度（lane 数） */
  parallelism: number;
  /** 输出长度（字节） */
  keyLen: number;
}

/**
 * 默认参数 —— 鸿蒙端永远走 cryptocore，所以恒为 64MiB/3/4 配置，
 * 与 desktop cryptoutil.DefaultArgon2id 字节级对齐。
 *
 * 解锁时永远使用 vault_meta 内记录的参数，不读本函数 —— 保证旧 vault
 * 文件参数升级后仍可解。
 */
export function defaultArgon2idParams(): Argon2idParams {
  return {
    memoryKiB: 64 * 1024,
    iterations: 3,
    parallelism: 4,
    keyLen: KEY_SIZE,
  };
}

/** 校验从持久化层读出的参数处于合理范围 */
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

/** 生成 n 字节加密安全随机数 */
export function randomBytes(n: number): Uint8Array {
  if (n <= 0) throw new Error(`invalid random byte count: ${n}`);
  return nativeRandomBytes(n);
}

/* ----------------------------------------------------------------------------
 * 内存抹零（best-effort）
 * -------------------------------------------------------------------------- */

export function wipeBytes(b: Uint8Array | null | undefined): void {
  if (!b) return;
  b.fill(0);
}

/* ----------------------------------------------------------------------------
 * KDF：Argon2id
 * -------------------------------------------------------------------------- */

/** 异步派生 KEK —— UI 路径，cryptocore 内部走 napi-rs AsyncTask 不阻塞主线程 */
export async function deriveKEKAsync(
  password: string,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  if (!password) throw new Error('master password cannot be empty');
  if (salt.length !== SALT_SIZE) {
    throw new Error(`salt length must be ${SALT_SIZE}, got ${salt.length}`);
  }
  validateArgon2idParams(params);
  if (!isNativeCryptoAvailable()) {
    throw new Error(
      'cryptocore (libcryptocore.so) 未加载；请先 `task crypto` 编译并安装。',
    );
  }
  return nativeDeriveKek(
    password,
    salt,
    params.memoryKiB,
    params.iterations,
    params.parallelism,
    params.keyLen,
  );
}

/** 当前进程是否有原生 KDF 加速（鸿蒙端永远应当为 true） */
export function isNativeKDF(): boolean {
  return isNativeCryptoAvailable();
}

/* ----------------------------------------------------------------------------
 * AEAD：XChaCha20-Poly1305
 * -------------------------------------------------------------------------- */

/**
 * 封装格式：[24-byte nonce][ciphertext + 16-byte tag]
 *
 * - aad 不参与加密但参与认证
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
  return nativeSealAead(key, plaintext, aad);
}

/** 解封：cryptocore 校验失败统一返回 GenericFailure */
export function openAEAD(
  key: Uint8Array,
  envelope: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_SIZE) {
    throw new Error(`aead key length must be ${KEY_SIZE}, got ${key.length}`);
  }
  if (envelope.length < NONCE_SIZE + 16) {
    throw new Error('aead envelope too short');
  }
  return nativeOpenAead(key, envelope, aad);
}

/* ----------------------------------------------------------------------------
 * Base64（Uint8Array ↔ string，用于 JSON 持久化）
 *
 * ArkTS 没有 btoa/atob 全局函数；用 @ohos.util 的 Base64Helper。
 * -------------------------------------------------------------------------- */

const base64 = new util.Base64Helper();

/** Uint8Array → base64（标准字母表） */
export function toB64(bytes: Uint8Array): string {
  // encodeToStringSync 用标准 base64 字母表（含 padding =）
  return base64.encodeToStringSync(bytes);
}

/** base64 → Uint8Array */
export function fromB64(s: string): Uint8Array {
  // decodeSync 返回 Uint8Array
  return base64.decodeSync(s);
}

/* ----------------------------------------------------------------------------
 * UTF-8（字符串 ↔ 字节）
 * -------------------------------------------------------------------------- */

const textEnc = new util.TextEncoder('utf-8');
const textDec = util.TextDecoder.create('utf-8');

export function utf8(s: string): Uint8Array {
  return textEnc.encodeInto(s);
}

export function utf8Decode(b: Uint8Array): string {
  return textDec.decodeToString(b);
}

/* ----------------------------------------------------------------------------
 * 常量时间比较
 * -------------------------------------------------------------------------- */

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/* ----------------------------------------------------------------------------
 * 主密码强度校验
 * -------------------------------------------------------------------------- */

export function validatePasswordStrength(password: string): void {
  if (!password) throw new Error('主密码不能为空');
  if (password.length < 8) throw new Error('主密码至少 8 位字符');
}
