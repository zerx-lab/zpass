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
 *
 * 韧性：native 路径瞬时抛错时回退 cryptoFramework（同为 OS CSPRNG，安全等价），
 * 避免生成器因一次偶发 napi/原生异常整体显示「失败」。
 */

// 回退路径的 Random 实例缓存。OHOS createRandom() 在紧循环里反复构造既慢又会
// 偶发抛错（这正是「生成器偶尔无法使用」的根因）；按官方用法复用单个实例。
let cfRandom: cryptoFramework.Random | null = null;

function cryptoFrameworkBytes(len: number): Uint8Array {
  if (cfRandom === null) {
    cfRandom = cryptoFramework.createRandom();
  }
  const blob = cfRandom.generateRandomSync(len);
  return new Uint8Array(blob.data);
}

export function secureRandomBytes(len: number): Uint8Array {
  if (len <= 0 || !Number.isFinite(len)) {
    throw new Error(`secureRandomBytes: invalid length ${len}`);
  }
  if (isNativeCryptoAvailable()) {
    try {
      return nativeRandomBytes(len);
    } catch (_e) {
      // native 偶发失败 → 回退 cryptoFramework（同为 OS CSPRNG），不让生成器整体崩
    }
  }
  try {
    return cryptoFrameworkBytes(len);
  } catch (e) {
    cfRandom = null; // 实例可能已损坏，下次重建
    const err = e as BusinessError;
    throw new Error(`cryptoFramework.Random failed: ${err.code} ${err.message}`);
  }
}

/**
 * 随机字节池 —— 把「每抽一个数就调一次 CSPRNG」摊薄成「每 POOL_SIZE 字节调一次」。
 *
 * 拒绝采样会丢弃部分字节，池只改变取字节的方式（一次批量取、逐字节供给），
 * 消费的仍是同一字节流、拒绝逻辑不变，分布与 phone 完全一致；但底层调用次数
 * 降低约 POOL_SIZE 倍，显著缓解同步逐字节调用带来的卡顿与偶发原生失败。
 */
const POOL_SIZE = 256;
let pool: Uint8Array = new Uint8Array(0);
let poolPos = 0;

function nextRandomByte(): number {
  if (poolPos >= pool.length) {
    pool = secureRandomBytes(POOL_SIZE);
    poolPos = 0;
  }
  return pool[poolPos++];
}

/**
 * 均匀分布的 [0, max) —— 拒绝偏倚法
 *
 * 与 phone generator.tsx 的 secureRandomInt 分布完全一致。
 * 用一次 8-bit 取样；上限 256 - (256 % max) 之外的字节丢弃重试。
 * 字节经由 nextRandomByte() 的池供给，不再每字节直连 CSPRNG。
 */
export function secureRandomInt(max: number): number {
  if (max <= 0) return 0;
  if (max > 256) {
    throw new Error(`secureRandomInt: max=${max} > 256 not supported (would bias)`);
  }
  const limit = 256 - (256 % max);
  // 与 phone 一致的拒绝采样
  while (true) {
    const b = nextRandomByte();
    if (b < limit) return b % max;
  }
}
