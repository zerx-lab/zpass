// HIBP 密码泄露检测 —— k-anonymity 客户端
//
// 与 desktop/internal/services/breachcheck.go 对齐：
//   - 计算密码 SHA-1（大写十六进制 40 字符）
//   - 取前 5 位发给 HIBP `range/{prefix}` API
//   - 本地匹配剩余 35 位后缀，Add-Padding 填充行（count=0）过滤掉
//   - 缓存键是密码 SHA-1（同一密码多条目复用，密码改了自动 miss）
//
// 隐私：HIBP 仅看到 5 位前缀，无法还原完整哈希更无法还原密码。
//
// 缓存：内存级，进程内有效；锁屏 / 重载会丢。snapshot 持久化目前不接入
// （等 vaultService 提供 plaintext 通道再补），与 desktop 的 SaveBreachSnapshot
// 不同 —— 移动端首次启动每次都要重扫，但用户主动点扫描按钮才会触发。
//
// 节流：连续网络请求间 100ms 间隔，对 HIBP 友好；缓存命中不计数。

import { sha1 } from "@noble/hashes/legacy.js";

import { utf8 } from "./crypto";

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

/** 内存缓存：密码 SHA-1 → 检测结果 */
const cache = new Map<string, CacheEntry>();

/** 清空缓存 —— vault 锁定 / 用户点重新扫描时调用 */
export function clearBreachCache(): void {
  cache.clear();
}

/** 计算密码的大写十六进制 SHA-1（40 字符） */
function hashPassword(password: string): string {
  const bytes = sha1(utf8(password));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex.toUpperCase();
}

/**
 * 查询单个密码哈希是否出现在 HIBP 泄露库
 *
 * 入参是已算好的大写 SHA-1 哈希；调用方负责算哈希以便缓存层共用同一份。
 */
async function queryHibp(
  hash: string,
): Promise<{ pwned: boolean; count: number }> {
  if (hash.length !== 40) {
    throw new Error(`invalid sha-1 hash length: got ${hash.length}, want 40`);
  }
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const ctrl =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl
    ? setTimeout(() => ctrl.abort(), 8_000)
    : null;

  let resp: Response;
  try {
    resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      method: "GET",
      headers: {
        // 不显式设 User-Agent —— RN 网络层会忽略业务 UA 并打 warning，
        // 留给原生默认（okhttp / CFNetwork）即可。HIBP 不强制特定 UA。
        "Add-Padding": "true",
      },
      signal: ctrl?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`hibp returned status ${resp.status}`);
  }
  const body = await resp.text();
  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const lineSuffix = line.slice(0, idx).trim();
    const lineCountStr = line.slice(idx + 1).trim();
    if (lineSuffix.toUpperCase() !== suffix.toUpperCase()) continue;
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

/** 提取条目的密码字段，非字符串或空一律返回空 */
function extractPassword(item: { password?: unknown }): string {
  return typeof item.password === "string" ? item.password : "";
}

export interface BreachableItem {
  id: string;
  name: string;
  password?: string;
}

/**
 * 批量扫描 —— 对所有 login 条目逐条检测，缓存命中直接复用。
 *
 * - force=true 时先清缓存再扫
 * - 单条失败不中断，错误写到 result.error 字段（不入缓存，下次重试）
 * - 网络请求之间 100ms 节流；缓存命中不算请求
 */
export async function batchCheckBreaches(
  items: BreachableItem[],
  opts: { force?: boolean } = {},
): Promise<BreachResult[]> {
  if (opts.force) clearBreachCache();
  const results: BreachResult[] = [];
  let networkCalls = 0;

  for (const item of items) {
    const result: BreachResult = {
      itemId: item.id,
      itemName: item.name,
      pwned: false,
      count: 0,
      checkedAt: 0,
    };

    const password = extractPassword(item);
    if (!password) {
      // 无密码字段：跳过（不入结果，与 desktop 行为一致）
      continue;
    }

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
      const { pwned, count } = await queryHibp(hash);
      const now = Date.now();
      result.pwned = pwned;
      result.count = count;
      result.checkedAt = now;
      cache.set(hash, { pwned, count, checkedAt: now });
    } catch (e) {
      result.error =
        e instanceof Error ? `breach check: ${e.message}` : String(e);
    }
    results.push(result);
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
