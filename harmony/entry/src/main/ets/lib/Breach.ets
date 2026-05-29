// HIBP 密码泄露检测 —— k-anonymity 客户端
//
// 与 phone/lib/breach.ts 行为对齐：
//   - 计算密码 SHA-1（大写十六进制 40 字符）
//   - 取前 5 位发给 HIBP `range/{prefix}` API
//   - 本地匹配剩余 35 位后缀；Add-Padding 填充行（count=0）过滤掉
//   - 缓存键是密码 SHA-1，进程内有效；锁屏 / 重载会丢
//   - 节流：连续网络请求间 100ms 间隔；缓存命中不计数
//   - 单条失败不中断；错误写到 result.error 字段不入缓存（下次重试）
//
// 隐私：HIBP 仅看到 5 位前缀，无法还原完整哈希更无法还原密码。
//
// 网络：@ohos.net.http；需要 ohos.permission.INTERNET（已在 module.json5 申请）。
// 8s 超时由 connectTimeout / readTimeout 控制。

import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { utf8 } from './Crypto';

export interface BreachResult {
  itemId: string;
  itemName: string;
  pwned: boolean;
  /** 在泄露库中出现的次数（pwned=false 时为 0） */
  count: number;
  /** 单条检测失败时的错误信息 */
  error?: string;
  /** 本条结果生成时间（Unix 毫秒） */
  checkedAt: number;
}

interface CacheEntry {
  pwned: boolean;
  count: number;
  checkedAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

/** 清空缓存 —— vault 锁定 / 用户点重新扫描时调用 */
export function clearBreachCache(): void {
  cache.clear();
}

/** 计算密码的大写十六进制 SHA-1（40 字符） */
function hashPassword(password: string): string {
  const md = cryptoFramework.createMd('SHA1');
  md.updateSync({ data: utf8(password) });
  const out = md.digestSync();
  const bytes = new Uint8Array(out.data);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}

interface HibpResult {
  pwned: boolean;
  count: number;
}

/** 查询单个密码哈希是否出现在 HIBP 泄露库 */
async function queryHibp(hash: string): Promise<HibpResult> {
  if (hash.length !== 40) {
    throw new Error(`invalid sha-1 hash length: got ${hash.length}, want 40`);
  }
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const request = http.createHttp();
  try {
    const resp = await request.request(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      {
        method: http.RequestMethod.GET,
        // HIBP 不强制特定 UA；不设置 User-Agent，避免与系统默认冲突
        header: {
          'Add-Padding': 'true',
        },
        connectTimeout: 8_000,
        readTimeout: 8_000,
      },
    );
    if (resp.responseCode !== 200) {
      throw new Error(`hibp returned status ${resp.responseCode}`);
    }
    const body = typeof resp.result === 'string' ? resp.result : '';
    return parseHibpBody(body, suffix);
  } catch (e) {
    const err = e as BusinessError;
    throw new Error(`hibp request: ${err.code ?? ''} ${err.message ?? String(e)}`.trim());
  } finally {
    request.destroy();
  }
}

function parseHibpBody(body: string, suffix: string): HibpResult {
  const upperSuffix = suffix.toUpperCase();
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const lineSuffix = line.slice(0, idx).trim().toUpperCase();
    const lineCountStr = line.slice(idx + 1).trim();
    if (lineSuffix !== upperSuffix) continue;
    const n = Number.parseInt(lineCountStr, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`parse count "${lineCountStr}" failed`);
    }
    // padding 行 count=0 视为未泄露
    if (n === 0) return { pwned: false, count: 0 };
    return { pwned: true, count: n };
  }
  return { pwned: false, count: 0 };
}

export interface BreachableItem {
  id: string;
  name: string;
  password?: string;
}

interface BatchOptions {
  /** 跳过缓存重扫；与 phone batchCheckBreaches({ force: true }) 一致 */
  force?: boolean;
}

/**
 * 批量扫描 —— 对传入条目逐条检测，缓存命中直接复用。
 *
 * 调用方负责筛出带 password 的 login 条目（与 phone 行为一致）；
 * 无 password 字段或为空字符串的条目跳过，不会出现在结果集中。
 */
export async function batchCheckBreaches(
  items: BreachableItem[],
  opts: BatchOptions = {},
): Promise<BreachResult[]> {
  if (opts.force) clearBreachCache();
  const results: BreachResult[] = [];
  let networkCalls = 0;

  for (const item of items) {
    const password = item.password ?? '';
    if (!password) continue;

    const result: BreachResult = {
      itemId: item.id,
      itemName: item.name,
      pwned: false,
      count: 0,
      checkedAt: 0,
    };

    const hash = hashPassword(password);
    const cached = cache.get(hash);
    if (cached) {
      result.pwned = cached.pwned;
      result.count = cached.count;
      result.checkedAt = cached.checkedAt;
      results.push(result);
      continue;
    }

    if (networkCalls > 0) {
      await sleep(100);
    }
    networkCalls += 1;

    try {
      const r = await queryHibp(hash);
      const now = Date.now();
      result.pwned = r.pwned;
      result.count = r.count;
      result.checkedAt = now;
      cache.set(hash, { pwned: r.pwned, count: r.count, checkedAt: now });
    } catch (e) {
      result.error = e instanceof Error ? `breach check: ${e.message}` : String(e);
    }
    results.push(result);
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
