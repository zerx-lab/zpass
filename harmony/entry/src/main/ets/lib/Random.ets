import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { isNativeCryptoAvailable, randomBytes as nativeRandomBytes } from './RustCryptoCore';

/**
 * 安全随机字节 —— 优先走 cryptocore (Rust)，未加载时回退 cryptoFramework
 *
 * 与 phone/lib/crypto.ts 的 randomBytes 对齐：
 *  - 失败抛异常（非降级到 Math.random）
 *  - 调用方应捕获并提示用户
 *
 * 为什么双路径：生成器页在未初始化 vault（.so 不一定装上）之前就要用，
 * 而在有 .so 后所有 vault 加密路径都走 cryptocore —— 全端随机源一致。
 */
export function secureRandomBytes(len: number): Uint8Array {
  if (len <= 0 || !Number.isFinite(len)) {
    throw new Error(`secureRandomBytes: invalid length ${len}`);
  }
  if (isNativeCryptoAvailable()) {
    return nativeRandomBytes(len);
  }
  // 回退：@ohos.security.cryptoFramework 同样是 OS CSPRNG，安全保证一致
  const rng = cryptoFramework.createRandom();
  try {
    const blob = rng.generateRandomSync(len);
    return new Uint8Array(blob.data);
  } catch (e) {
    const err = e as BusinessError;
    throw new Error(`cryptoFramework.Random failed: ${err.code} ${err.message}`);
  }
}

/**
 * 均匀分布的 [0, max) —— 拒绝偏倚法
 *
 * 与 phone generator.tsx 的 secureRandomInt 实现完全对齐。
 * 用一次 8-bit 取样；上限 256 - (256 % max) 之外的字节丢弃重试。
 */
export function secureRandomInt(max: number): number {
  if (max <= 0) return 0;
  if (max > 256) {
    throw new Error(`secureRandomInt: max=${max} > 256 not supported (would bias)`);
  }
  const limit = 256 - (256 % max);
  // 与 phone 一致的拒绝采样
  while (true) {
    const b = secureRandomBytes(1)[0];
    if (b < limit) return b % max;
  }
}
