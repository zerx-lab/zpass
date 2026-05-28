// 浏览器 Native Messaging Host manifest 静默装/更新 —— macOS。
//
// ---------------------------------------------------------------------------
// 为什么放在主进程
//
// macOS 没有"安装包写注册表"那一步(Chrome/Edge 在 Windows 走 HKCU,见
// extension/native-host/install-chrome.ps1)。Chrome / Edge / Firefox 在 macOS
// 上只认 ~/Library/Application Support/<browser>/NativeMessagingHosts/<name>.json
// 这一个发现路径。
//
// 用户期望"打开 ZPass 就能用",所以这里把 manifest 写入放在 GUI 启动时,内容
// 不变就跳过,内容变了(典型场景:版本升级换 host binary 路径)就静默覆盖。
//
// ---------------------------------------------------------------------------
// 安全 / 隐私边界
//
//   - 仅当浏览器的用户配置目录已存在时为它写 manifest,避免在没装该浏览器的
//     机器上凭空创建 Google/Chrome 之类的目录树。
//   - manifest 文件 0644:Chrome / Firefox 以当前用户运行,需要可读;扩展不写。
//   - 不在系统级 /Library 下写,只动用户级 ~/Library。无需提权。
//
// ---------------------------------------------------------------------------
// 版本/路径变更触发"自动更新"
//
// 内容比对(字节级 readFile 对照新 JSON)决定是否重写。host binary 路径变化
// (从 dev 切回 .app、Apple Silicon ↔ Intel 迁移、版本升级换 bin 目录)都会
// 反映在 path 字段里,自然触发覆盖。

import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { app } from "electron";

// HOST_NAME 必须与 desktop/internal/nativebridge/config.go 中的 host 名(浏览器
// 端 `chrome.runtime.connectNative("com.zerx_lab.zpass")`)一致。改动需要同步
// 修改 Windows 端的 install-chrome.ps1 注册表 key。
const HOST_NAME = "com.zerx_lab.zpass";

// 与 extension/wxt.config.ts 中 browser_specific_settings.gecko.id 同步。
// Firefox manifest 用 allowed_extensions 限定调用方,该 id 在 wxt 配置里是固定值。
const FIREFOX_EXT_ID = "zpass-extension@zerx-lab.local";

// 与 extension/wxt.config.ts 中 manifest.key 同步。Chrome 从 key (base64 SPKI
// public key)派生固定 extension id:sha256(der) 前 16 字节的 hex,每个 hex 字符
// c (0-f) 映射为字符 'a' + int(c) (a-p)。所以只要 key 不变,扩展无论 unpacked
// 加载还是商店上线,id 都一样,allowed_origins 可以静态算出。
const CHROME_MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArlMje6Tpk7iDCihHmujNEAnNQd3X3eRlwmyOC3jcfY3OTR6o1x0uAOoLGKvilu71hOjwnVLXvekvpQvO/i5cg0NUkqJpgdBOZgGcb9Bd7VUxCiouG5STqJUkzT+0UxYwhUkcxTXcjaeEQ00i1PDlrnISzZVxM2YQQvTtrx4qhOYgsuVA2JlwfQ8Zf0bbSFlreyPwEBUjRd4LFCn2y9qO8MNI3PjoW5WQHXRKJeyg8QBSK+wcNQDChWSlymIYzgRVK5KdCKccGf33i5Q0t9Wy1l2ywQ1PVhST5OYN1FOjoyZf9DrzCnAbBTe4w5sQQJnfxiDyZ5k52A9LzvBKfL85/QIDAQAB";

function chromeExtensionIdFromKey(b64: string): string {
  const der = Buffer.from(b64, "base64");
  const hash = createHash("sha256").update(der).digest();
  const hex = hash.subarray(0, 16).toString("hex");
  let out = "";
  for (const c of hex) out += String.fromCharCode(97 + parseInt(c, 16));
  return out;
}

interface BrowserTarget {
  label: string;
  // probeDir 存在 ⇒ 浏览器已安装(或至少跑过一次)。不存在则跳过,避免在
  // 没装该浏览器的机器上凭空创建一棵 Application Support 子目录。
  probeDir: string;
  manifestDir: string;
  build: (hostPath: string) => Record<string, unknown>;
}

function macTargets(chromeExtId: string): BrowserTarget[] {
  const support = join(homedir(), "Library", "Application Support");
  const chromiumBody = (path: string) => ({
    name: HOST_NAME,
    description: "ZPass native messaging host",
    path,
    type: "stdio",
    allowed_origins: [`chrome-extension://${chromeExtId}/`],
  });
  return [
    {
      label: "Chrome",
      probeDir: join(support, "Google", "Chrome"),
      manifestDir: join(support, "Google", "Chrome", "NativeMessagingHosts"),
      build: chromiumBody,
    },
    {
      label: "Edge",
      probeDir: join(support, "Microsoft Edge"),
      manifestDir: join(support, "Microsoft Edge", "NativeMessagingHosts"),
      build: chromiumBody,
    },
    {
      // Firefox 的数据目录在 Application Support/Firefox/,但 manifest 必须放
      // 到 Application Support/Mozilla/NativeMessagingHosts/(Firefox 官方约定)。
      // 用 Firefox 目录做存在性探测,Mozilla 目录按需 mkdir。
      label: "Firefox",
      probeDir: join(support, "Firefox"),
      manifestDir: join(support, "Mozilla", "NativeMessagingHosts"),
      build: (path) => ({
        name: HOST_NAME,
        description: "ZPass native messaging host",
        path,
        type: "stdio",
        allowed_extensions: [FIREFOX_EXT_ID],
      }),
    },
  ];
}

// 与 backend.ts 的 resolveBinaryPath 同模式:packaged 走 resourcesPath/bin/,
// dev 走 appPath/bin/。host binary 在 task build:nativehost 时落入
// bin/darwin-<arch>/zpass-native-host。
function resolveNativeHostBinary(): string | null {
  const platformDir = `darwin-${process.arch}`;
  const exe = "zpass-native-host";
  const base = app.isPackaged
    ? join(process.resourcesPath, "bin")
    : join(app.getAppPath(), "bin");
  const candidate = join(base, platformDir, exe);
  return existsSync(candidate) ? candidate : null;
}

async function writeIfChanged(
  path: string,
  content: string,
): Promise<"wrote" | "unchanged"> {
  try {
    const current = await fs.readFile(path, "utf8");
    if (current === content) return "unchanged";
  } catch {
    // 文件不存在 / 读失败 — 走 write 路径
  }
  await fs.writeFile(path, content, { mode: 0o644 });
  return "wrote";
}

/**
 * 给装了 Chrome / Edge / Firefox 的 macOS 用户静默写 NMH manifest。
 *
 * 调用约定:
 *   - 非 darwin 平台:直接 return,不报错(Windows 走 install-chrome.ps1,
 *     Linux 暂未实现)。
 *   - host binary 找不到(dev 没跑过 task build:nativehost):log warning 后 return,
 *     不写指向不存在二进制的 manifest。
 *   - 单个浏览器写入失败不影响其它浏览器和 GUI 启动:全程 try/catch。
 *   - 内容字节一致则不写,实现幂等 + 静默更新。
 */
export async function installNativeMessagingHosts(): Promise<void> {
  if (process.platform !== "darwin") return;

  const hostPath = resolveNativeHostBinary();
  if (!hostPath) {
    process.stderr.write(
      "[nmh] zpass-native-host binary not found; skipping NMH manifest install\n",
    );
    return;
  }

  const chromeExtId = chromeExtensionIdFromKey(CHROME_MANIFEST_KEY);
  const targets = macTargets(chromeExtId);

  for (const t of targets) {
    if (!existsSync(t.probeDir)) continue;
    try {
      await fs.mkdir(t.manifestDir, { recursive: true });
      const json = `${JSON.stringify(t.build(hostPath), null, 2)}\n`;
      const dest = join(t.manifestDir, `${HOST_NAME}.json`);
      const result = await writeIfChanged(dest, json);
      process.stderr.write(`[nmh] ${t.label}: ${result} ${dest}\n`);
    } catch (err) {
      process.stderr.write(
        `[nmh] ${t.label}: install failed: ${String(err)}\n`,
      );
    }
  }
}
