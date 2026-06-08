// Favicon —— 网站 icon 获取 + 磁盘缓存
//
// 参考 desktop/electron/.../components/ItemIcon.tsx（仅对 login / passkey 这类
// 「可联网」类型从 host 取站点图标，其余回退字形）。
//
// 【icon 源：直取站点自己的 /favicon.ico】
//   桌面端走 DuckDuckGo、之前试过 Google faviconV2，但两者在国内都被 GFW 封、
//   国内用户拿不到图。改为直接请求站点本身的 https://<host>/favicon.ico：
//     - 国内可用：用户能登录该站，该站必然可达，不依赖任何第三方 CDN。
//     - 隐私最优：不向任何第三方泄露 host（比桌面端的 DuckDuckGo 方案更彻底，
//       符合 zero-knowledge 产品取向）。
//   代价：部分站点 /favicon.ico 返 404/HTML（如 jd/163）或只有小图，此时回退字形。
//
// 【解码】实测主流站点的 /favicon.ico 多为含 BMP/DIB 的 Windows ICO，而 HarmonyOS 的
//   image 解码器不保证支持 ICO。因此采用两档策略：
//     1) 先试原生解码 createImageSource（覆盖 PNG / JPEG / BMP / SVG，以及若支持则 ICO）。
//     2) 原生失败且字节是 ICO 时，本地解包：取最大一帧；PNG-inside 直接解切片；
//        32bpp 的 BMP/DIB 则手动翻转行 + BGRA→RGBA，用 image.createPixelMap(裸像素)
//        生成 PixelMap——绕过解码器格式支持与 32bpp alpha 歧义，结果确定。
//
// 缓存（满足「避免下次频繁获取」）：
//   - 内存：host → PixelMap（成功）/ host ∈ failed（失败负缓存，本会话内不重试网络）
//   - 磁盘：原始字节落 <cacheDir>/favicons/<host>.bin；命中即跳过网络，仅本地解码。
//     cacheDir 由 EntryAbility.onCreate 写入 AppStorage；系统清缓存时随之回收。
//
// 网络：@ohos.net.http（需 ohos.permission.INTERNET，已在 module.json5 申请）。
// 解码：@kit.ImageKit。

import { http } from '@kit.NetworkKit';
import { image } from '@kit.ImageKit';
import { fileIo as fs } from '@kit.CoreFileKit';

const CACHE_DIR_KEY: string = 'cacheDir';

/** 仅这两类「可联网」条目尝试取 favicon —— 与 desktop FAVICON_TYPES 对齐 */
const FAVICON_TYPES: ReadonlySet<string> = new Set<string>(['login', 'passkey']);

/* ----------------------------------------------------------------------------
 * host 解析 —— 与 desktop extractHost 行为对齐
 * -------------------------------------------------------------------------- */

/**
 * 从 url / host / rpId 字符串解析规范 host：
 *   "https://github.com/login" → "github.com"
 *   "GitHub.com/foo"           → "github.com"
 *   空 / 无点 / IP             → null
 */
export function extractHost(input?: string | null): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '');
  const cut = s.search(/[\/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  s = s.trim().toLowerCase();
  // host 至少含一个点（排除 "localhost" / 裸词）
  if (!s || !s.includes('.')) return null;
  // IPv4 直接拒绝：裸 IP 无站点 favicon 约定
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  return s;
}

/** 从条目派生可用于取 favicon 的原始 host 串（login.url / passkey.rpId） */
export function faviconSourceForItem(type: string, fields: Record<string, Object>): string | null {
  if (!FAVICON_TYPES.has(type)) return null;
  if (type === 'login') return (fields.url as string | undefined) ?? null;
  if (type === 'passkey') return (fields.rpId as string | undefined) ?? null;
  return null;
}

/* ----------------------------------------------------------------------------
 * 缓存
 * -------------------------------------------------------------------------- */

const resolved: Map<string, PixelMap> = new Map();
const failed: Set<string> = new Set();
// 同一 host 的并发请求去重：第一个发起，其余共享同一 Promise
const inflight: Map<string, Promise<PixelMap | undefined>> = new Map();

function faviconUrl(host: string): string {
  // 直取站点本身的 favicon：国内可达、不经第三方。多数站点即使 HTML 里
  // 引用了别的路径，也会在 /favicon.ico 提供（浏览器默认约定）。
  return `https://${host}/favicon.ico`;
}

function cacheDir(): string | null {
  const dir = AppStorage.get<string>(CACHE_DIR_KEY);
  return typeof dir === 'string' && dir.length > 0 ? dir : null;
}

function sanitize(host: string): string {
  return host.replace(/[^a-z0-9.\-]/g, '_');
}

/**
 * 解析 host 对应的 favicon PixelMap；命中内存 / 磁盘缓存则不发网络。
 * 失败（含解码失败 / 网络失败 / 非可联网）返回 undefined。
 */
export async function resolveFavicon(host: string): Promise<PixelMap | undefined> {
  const cached = resolved.get(host);
  if (cached) return cached;
  if (failed.has(host)) return undefined;

  const pending = inflight.get(host);
  if (pending) return pending;

  const task = loadFavicon(host);
  inflight.set(host, task);
  try {
    return await task;
  } finally {
    inflight.delete(host);
  }
}

async function loadFavicon(host: string): Promise<PixelMap | undefined> {
  const dir = cacheDir();
  const filePath = dir ? `${dir}/favicons/${sanitize(host)}.bin` : null;

  // 1) 磁盘缓存命中：仅本地读取 + 解码
  if (filePath && (await exists(filePath))) {
    const buf = await readBytes(filePath);
    const pm = buf ? await decode(buf) : undefined;
    if (pm) {
      resolved.set(host, pm);
      return pm;
    }
    // 磁盘文件损坏 / 解码失败：删除坏文件，继续走网络兜底
    await unlinkQuiet(filePath);
  }

  // 2) 网络获取
  const bytes = await fetchBytes(host);
  if (!bytes) {
    failed.add(host);
    return undefined;
  }

  const pm = await decode(bytes);
  if (!pm) {
    failed.add(host);
    return undefined;
  }

  // 解码成功才落盘（避免缓存无法解码的垃圾字节）
  if (dir && filePath) {
    await ensureDir(`${dir}/favicons`);
    await writeBytes(filePath, bytes);
  }
  resolved.set(host, pm);
  return pm;
}

/* ----------------------------------------------------------------------------
 * 网络 / 解码 / IO
 * -------------------------------------------------------------------------- */

async function fetchBytes(host: string): Promise<ArrayBuffer | undefined> {
  let url = faviconUrl(host);
  // 站点 /favicon.ico 常会 30x 跳转（http→https / 跳 CDN），手动跟最多 3 跳
  for (let hop = 0; hop < 4; hop++) {
    const request = http.createHttp();
    try {
      const resp = await request.request(url, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        // 部分 CDN 对空 UA 返 403，给个浏览器型 UA
        header: { 'User-Agent': 'Mozilla/5.0' } as Record<string, string>,
        connectTimeout: 8_000,
        readTimeout: 8_000,
      });
      const code = resp.responseCode;
      if (code >= 300 && code < 400) {
        const loc = redirectLocation(resp.header);
        if (!loc) return undefined;
        url = absoluteUrl(url, loc);
        continue;
      }
      if (code !== 200) return undefined;
      const r = resp.result;
      if (r instanceof ArrayBuffer && r.byteLength > 0) return r;
      return undefined;
    } catch (_e) {
      return undefined;
    } finally {
      request.destroy();
    }
  }
  return undefined;
}

function redirectLocation(header: Object): string | undefined {
  const h = header as Record<string, Object>;
  const v = h['location'] ?? h['Location'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function absoluteUrl(base: string, loc: string): string {
  if (/^https?:\/\//i.test(loc)) return loc;
  if (loc.startsWith('//')) return `https:${loc}`;
  const m = base.match(/^(https?:\/\/[^\/]+)/i);
  const origin = m ? m[1] : '';
  return loc.startsWith('/') ? `${origin}${loc}` : `${origin}/${loc}`;
}

async function decode(buf: ArrayBuffer): Promise<PixelMap | undefined> {
  // 1) 先试原生解码（PNG / JPEG / BMP / SVG，以及若系统支持则 ICO）
  const native = await decodeNative(buf);
  if (native) return native;
  // 2) 原生失败且是 ICO → 本地解包
  return await decodeIco(buf);
}

async function decodeNative(buf: ArrayBuffer): Promise<PixelMap | undefined> {
  let src: image.ImageSource | undefined;
  try {
    src = image.createImageSource(buf);
    return await src.createPixelMap();
  } catch (_e) {
    return undefined;
  } finally {
    if (src) {
      try {
        src.release();
      } catch (_e) {
        // 忽略
      }
    }
  }
}

/* ----------------------------------------------------------------------------
 * 本地 ICO 解包 —— HarmonyOS image 解码器不保证支持 ICO，手动取最大一帧。
 * PNG-inside 直接原生解切片；32bpp BMP/DIB 翻转行 + BGRA→RGBA 后裸像素造 PixelMap。
 * 低于 32bpp 的 DIB（调色板 / 24bpp）罕见于 favicon，不支持时回退字形。
 * -------------------------------------------------------------------------- */

interface IcoEntry {
  offset: number;
  size: number;
  width: number;
}

async function decodeIco(buf: ArrayBuffer): Promise<PixelMap | undefined> {
  const entry = pickBestIcoEntry(buf);
  if (!entry) return undefined;
  const u8 = new Uint8Array(buf);
  // PNG-inside 帧 → 原生解切片
  if (entry.offset + 4 <= buf.byteLength && u8[entry.offset] === 0x89 && u8[entry.offset + 1] === 0x50) {
    const end = Math.min(entry.offset + entry.size, buf.byteLength);
    return await decodeNative(buf.slice(entry.offset, end));
  }
  // BMP/DIB 32bpp → 手动转 RGBA
  const rgba = dibToRgba(buf, entry.offset);
  if (!rgba) return undefined;
  try {
    const sz: image.Size = { width: rgba.width, height: rgba.height };
    const opts: image.InitializationOptions = {
      size: sz,
      srcPixelFormat: image.PixelMapFormat.RGBA_8888,
      pixelFormat: image.PixelMapFormat.RGBA_8888,
    };
    return await image.createPixelMap(rgba.data, opts);
  } catch (_e) {
    return undefined;
  }
}

function pickBestIcoEntry(buf: ArrayBuffer): IcoEntry | undefined {
  if (buf.byteLength < 6) return undefined;
  const dv = new DataView(buf);
  // ICONDIR: reserved=0, type ∈ {1 icon, 2 cursor}
  if (dv.getUint16(0, true) !== 0) return undefined;
  const type = dv.getUint16(2, true);
  if (type !== 1 && type !== 2) return undefined;
  const count = dv.getUint16(4, true);
  if (count === 0) return undefined;
  let best: IcoEntry | undefined;
  let p = 6;
  for (let i = 0; i < count; i++) {
    if (p + 16 > buf.byteLength) break;
    let w = dv.getUint8(p);
    if (w === 0) w = 256; // 0 表示 256
    const size = dv.getUint32(p + 8, true);
    const offset = dv.getUint32(p + 12, true);
    if (offset > 0 && size > 0 && offset + size <= buf.byteLength) {
      if (!best || w > best.width) {
        const e: IcoEntry = { offset: offset, size: size, width: w };
        best = e;
      }
    }
    p += 16;
  }
  return best;
}

interface RgbaImage {
  data: ArrayBuffer;
  width: number;
  height: number;
}

function dibToRgba(buf: ArrayBuffer, offset: number): RgbaImage | undefined {
  if (offset + 40 > buf.byteLength) return undefined;
  const dv = new DataView(buf);
  const biSize = dv.getUint32(offset, true);
  const biW = dv.getInt32(offset + 4, true);
  const biH = dv.getInt32(offset + 8, true);
  const biBpp = dv.getUint16(offset + 14, true);
  if (biBpp !== 32 || biW <= 0 || biH <= 0) return undefined;
  // ICO 的 DIB 高度含 XOR 色面 + AND 掩码，取一半为真实高度
  const realH = Math.floor(biH / 2);
  if (realH <= 0) return undefined;
  const pxStart = offset + biSize; // 32bpp 无调色板，像素紧跟头后
  if (pxStart + biW * realH * 4 > buf.byteLength) return undefined;
  const u8 = new Uint8Array(buf);
  const out = new Uint8Array(biW * realH * 4);
  for (let y = 0; y < realH; y++) {
    // BMP 自底向上：目标第 y 行取源第 (realH-1-y) 行
    const srcRow = pxStart + (realH - 1 - y) * biW * 4;
    const dstRow = y * biW * 4;
    for (let x = 0; x < biW; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      out[d] = u8[s + 2];     // B 位 → R
      out[d + 1] = u8[s + 1]; // G
      out[d + 2] = u8[s];     // R 位 → B
      out[d + 3] = u8[s + 3]; // A
    }
  }
  const ab: ArrayBuffer = out.buffer as ArrayBuffer;
  const result: RgbaImage = { data: ab, width: biW, height: realH };
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    return await fs.access(path);
  } catch (_e) {
    return false;
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    if (!(await fs.access(dir))) {
      await fs.mkdir(dir);
    }
  } catch (_e) {
    // 已存在 / 并发创建：忽略
  }
}

async function readBytes(path: string): Promise<ArrayBuffer | undefined> {
  try {
    const stat = await fs.stat(path);
    if (stat.size <= 0) return undefined;
    const buf = new ArrayBuffer(stat.size);
    const handle = await fs.open(path, fs.OpenMode.READ_ONLY);
    try {
      await fs.read(handle.fd, buf);
    } finally {
      await fs.close(handle.fd);
    }
    return buf;
  } catch (_e) {
    return undefined;
  }
}

async function writeBytes(path: string, buf: ArrayBuffer): Promise<void> {
  try {
    const handle = await fs.open(
      path,
      fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC,
    );
    try {
      await fs.write(handle.fd, buf);
    } finally {
      await fs.close(handle.fd);
    }
  } catch (_e) {
    // 落盘失败不影响本次展示（内存已有 PixelMap）
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (_e) {
    // 忽略
  }
}
