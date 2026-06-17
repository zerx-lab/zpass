// 浏览器 Native Messaging Host manifest 静默装/更新 —— macOS + Windows。
//
// ---------------------------------------------------------------------------
// 为什么放在主进程
//
// 两个平台的 NMH 发现机制不同,但都不需要提权,可以在 GUI 启动时静默完成:
//
//   - macOS:Chrome / Edge / Firefox 只认
//     ~/Library/Application Support/<browser>/NativeMessagingHosts/<name>.json
//     这一个发现路径,直接写文件。
//   - Windows:浏览器从 HKCU\Software\<vendor>\NativeMessagingHosts\<name>
//     注册表键的默认值读 manifest 的绝对路径。manifest 本体可以放任意稳定
//     位置(我们放 userData/NativeMessagingHosts/<browser>/),写完文件后用
//     系统自带的 reg.exe 把 HKCU 键指过去。HKCU 无需 UAC 提权。
//
// 用户期望"打开 ZPass 就能用",所以这里把 manifest 写入放在 GUI 启动时,内容
// 不变就跳过,内容变了(典型场景:版本升级换 host binary 路径)就静默覆盖。
//
// ---------------------------------------------------------------------------
// 安全 / 隐私边界
//
//   - 仅当浏览器的用户配置目录已存在时为它写 manifest,避免在没装该浏览器的
//     机器上凭空创建 Google/Chrome 之类的目录树 / 注册表键。
//   - manifest 文件 0644:Chrome / Firefox 以当前用户运行,需要可读;扩展不写。
//   - 不动系统级路径(/Library、HKLM),只写用户级 ~/Library / HKCU。无需提权。
//
// ---------------------------------------------------------------------------
// 版本/路径变更触发"自动更新"
//
// 内容比对(字节级 readFile 对照新 JSON)决定是否重写。host binary 路径变化
// (从 dev 切回 .app、Apple Silicon ↔ Intel 迁移、版本升级换 bin 目录)都会
// 反映在 path 字段里,自然触发覆盖。Windows 注册表键用 reg.exe add /f 无条件
// 覆写 —— 本身幂等,且比先 query 再 add 少一次进程开销。

import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";

const execFileAsync = promisify(execFile);

// HOST_NAME 必须与 desktop/internal/nativebridge/config.go 中的 host 名(浏览器
// 端 `chrome.runtime.connectNative("com.zerx_lab.zpass")`)一致。改动需要同步
// 修改 extension/native-host/install-chrome.ps1(开发者手动安装脚本)的注册表 key。
const HOST_NAME = "com.zerx_lab.zpass";

// 与 extension/wxt.config.ts 中 browser_specific_settings.gecko.id 同步。
// Firefox manifest 用 allowed_extensions 限定调用方,该 id 在 wxt 配置里是固定值。
const FIREFOX_EXT_ID = "zpass-extension@zerx-lab.local";

// 与 extension/wxt.config.ts 中【开发(unpacked)构建】注入的 manifest.key 同步。
// Chrome 从 key (base64 SPKI public key)派生固定 extension id:sha256(der) 前
// 16 字节的 hex,每个 hex 字符 c (0-f) 映射为字符 'a' + int(c) (a-p)。
//
// 两类安装来源 id 不同,allowed_origins 必须同时收两者:
//   - unpacked / dev:带 CHROME_MANIFEST_KEY → id = chromeExtensionIdFromKey(key)。
//   - 上架包:不带 key,商店用自己注册的公钥重签 → id = CHROME_STORE_EXT_ID。
const CHROME_MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArlMje6Tpk7iDCihHmujNEAnNQd3X3eRlwmyOC3jcfY3OTR6o1x0uAOoLGKvilu71hOjwnVLXvekvpQvO/i5cg0NUkqJpgdBOZgGcb9Bd7VUxCiouG5STqJUkzT+0UxYwhUkcxTXcjaeEQ00i1PDlrnISzZVxM2YQQvTtrx4qhOYgsuVA2JlwfQ8Zf0bbSFlreyPwEBUjRd4LFCn2y9qO8MNI3PjoW5WQHXRKJeyg8QBSK+wcNQDChWSlymIYzgRVK5KdCKccGf33i5Q0t9Wy1l2ywQ1PVhST5OYN1FOjoyZf9DrzCnAbBTe4w5sQQJnfxiDyZ5k52A9LzvBKfL85/QIDAQAB";

// Chrome Web Store 给本 item 分配的固定 extension id(发布者后台「文件包 → ID」)。
// 商店用自己注册的公钥决定 id,与上面 CHROME_MANIFEST_KEY 派生的 dev id 不同。
const CHROME_STORE_EXT_ID = "dafhkofilckgmnlclnkciddccogpfcdm";

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
  // Windows 专用:manifest 写盘后要把这个 HKCU 键的默认值指向 manifest 路径,
  // 浏览器才能发现它。macOS 靠固定目录发现,留空。
  registryKey?: string;
}

function macTargets(chromeExtIds: string[]): BrowserTarget[] {
  const support = join(homedir(), "Library", "Application Support");
  const chromiumBody = (path: string) => ({
    name: HOST_NAME,
    description: "ZPass native messaging host",
    path,
    type: "stdio",
    allowed_origins: chromeExtIds.map((id) => `chrome-extension://${id}/`),
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

function winTargets(chromeExtIds: string[]): BrowserTarget[] {
  // LOCALAPPDATA / APPDATA 理论上一定有值;拿不到就放弃探测(返回空列表),
  // 不要猜路径。
  const localAppData = process.env.LOCALAPPDATA;
  const roamingAppData = process.env.APPDATA;
  if (!localAppData || !roamingAppData) return [];

  // manifest 放在 userData(%APPDATA%/zpass)下,跨版本路径稳定,卸载器
  // 清理 userData 时顺带带走。每个浏览器一个子目录:Chromium 系用
  // allowed_origins、Firefox 用 allowed_extensions,内容不同,而文件名又
  // 必须保持 <HOST_NAME>.json 的惯例,所以用目录区分。
  const manifestRoot = join(app.getPath("userData"), "NativeMessagingHosts");

  const chromiumBody = (path: string) => ({
    name: HOST_NAME,
    description: "ZPass native messaging host",
    path,
    type: "stdio",
    allowed_origins: chromeExtIds.map((id) => `chrome-extension://${id}/`),
  });
  return [
    {
      label: "Chrome",
      probeDir: join(localAppData, "Google", "Chrome", "User Data"),
      manifestDir: join(manifestRoot, "chrome"),
      build: chromiumBody,
      registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    },
    {
      label: "Edge",
      probeDir: join(localAppData, "Microsoft", "Edge", "User Data"),
      manifestDir: join(manifestRoot, "edge"),
      build: chromiumBody,
      registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    },
    {
      label: "Firefox",
      probeDir: join(roamingAppData, "Mozilla", "Firefox"),
      manifestDir: join(manifestRoot, "firefox"),
      build: (path) => ({
        name: HOST_NAME,
        description: "ZPass native messaging host",
        path,
        type: "stdio",
        allowed_extensions: [FIREFOX_EXT_ID],
      }),
      registryKey: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`,
    },
  ];
}

// 与 backend.ts 的 resolveBinaryPath 同模式:packaged 走 resourcesPath/bin/,
// dev 走 appPath/bin/。host binary 在 task build:nativehost 时落入
// bin/<platform>-<arch>/zpass-native-host[.exe]。
function resolveNativeHostBinary(): string | null {
  const platformDir = `${process.platform}-${process.arch}`;
  const exe =
    process.platform === "win32"
      ? "zpass-native-host.exe"
      : "zpass-native-host";
  const base = app.isPackaged
    ? join(process.resourcesPath, "bin")
    : join(app.getAppPath(), "bin");
  const candidate = join(base, platformDir, exe);
  return existsSync(candidate) ? candidate : null;
}

// reg.exe add:把 keyPath 的默认值 (REG_SZ) 设为 manifest 绝对路径。/f 覆写,
// 幂等。execFile(非 shell)拼参,路径含空格也安全。reg.exe 是系统组件,
// 永远在 System32 且在 PATH 上,不引入任何依赖。
async function setRegistryDefaultValue(
  keyPath: string,
  value: string,
): Promise<void> {
  await execFileAsync("reg.exe", [
    "add",
    keyPath,
    "/ve",
    "/t",
    "REG_SZ",
    "/d",
    value,
    "/f",
  ]);
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
 * 给装了 Chrome / Edge / Firefox 的 macOS / Windows 用户静默装 NMH。
 *
 * 调用约定:
 *   - 不支持的平台(Linux 暂未实现):直接 return,不报错。
 *   - host binary 找不到(dev 没跑过 task build:nativehost):log warning 后 return,
 *     不写指向不存在二进制的 manifest。
 *   - 单个浏览器写入失败不影响其它浏览器和 GUI 启动:全程 try/catch。
 *   - manifest 内容字节一致则不写;Windows 注册表 add /f 本身幂等。
 */
export async function installNativeMessagingHosts(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "win32") return;

  const hostPath = resolveNativeHostBinary();
  if (!hostPath) {
    process.stderr.write(
      "[nmh] zpass-native-host binary not found; skipping NMH manifest install\n",
    );
    return;
  }

  const chromeExtIds = [
    chromeExtensionIdFromKey(CHROME_MANIFEST_KEY),
    CHROME_STORE_EXT_ID,
  ];
  const targets =
    process.platform === "darwin"
      ? macTargets(chromeExtIds)
      : winTargets(chromeExtIds);

  for (const t of targets) {
    if (!existsSync(t.probeDir)) continue;
    try {
      await fs.mkdir(t.manifestDir, { recursive: true });
      const json = `${JSON.stringify(t.build(hostPath), null, 2)}\n`;
      const dest = join(t.manifestDir, `${HOST_NAME}.json`);
      const result = await writeIfChanged(dest, json);
      if (t.registryKey) {
        await setRegistryDefaultValue(t.registryKey, dest);
      }
      process.stderr.write(`[nmh] ${t.label}: ${result} ${dest}\n`);
    } catch (err) {
      process.stderr.write(
        `[nmh] ${t.label}: install failed: ${String(err)}\n`,
      );
    }
  }
}
