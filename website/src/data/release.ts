// ZPass 发布资产元数据 + 兜底
// ---------------------------------------------------------------------------
// 站点的版本号 / 资产 URL / 文件大小由 GitHub Releases API 在 SSR 时拉取（见
// src/lib/release-fetcher.ts）。本文件维护两类数据：
//
//   1. 展示元数据（PLATFORM_METAS）—— 手工维护：label / arch / format / note /
//      recommended 等 GitHub 上没有的信息，按 filename 索引。
//   2. 兜底快照（FALLBACK_*）—— 当 GitHub API 不可达时使用，保证页面始终能渲染。
//
// 新增 / 重命名资产文件名时，更新 PLATFORM_METAS；兜底 URL/大小可在每次发版后
// 顺手刷新（不刷新也无伤大雅，只在 API 故障时作降级展示）。

import type { ReleaseData } from "../lib/release-fetcher";

export type PlatformId =
	| "macos"
	| "windows"
	| "linux"
	| "android"
	| "extension";

export interface ReleaseAsset {
	/** 下方"主下载按钮"使用的标签（去掉冗余的产品名）—— 例如 "Installer (.exe)" */
	label: string;
	/** 架构 / 平台短标签，渲染为 mono 字体的彩色 tag —— 例如 "x64"、"arm64-v8a" */
	arch: string;
	/** 安装包格式短名（不带点），渲染在小标签里 —— 例如 "exe"、"deb"、"AppImage" */
	format: string;
	/** GitHub 上传文件名（用于显示原文件名 hint） */
	filename: string;
	/** 字节数，前端格式化为 "134 MB" / "46 KB" */
	sizeBytes: number;
	/** 直接下载 URL（原始 GitHub 地址，代理失败时的最终降级目标） */
	url: string;
	/** 国内加速镜像 URL，客户端探活失败后自动降级到 url */
	mirrorUrl?: string;
	/**
	 * 应用商店链接（如 Chrome 应用商店）。设置后该资产渲染为"前往商店安装"按钮，
	 * 在新标签页打开而非直接下载，且 url 取此值、不参与 GitHub 文件名匹配。
	 */
	storeUrl?: string;
	/** 是否为该平台的"推荐下载"——卡片顶部主按钮使用 */
	recommended?: boolean;
	/** 简短一句说明（zh） */
	noteZh?: string;
	/** 简短一句说明（en） */
	noteEn?: string;
}

export interface PlatformGroup {
	id: PlatformId;
	/** 卡片标题——中文 / 英文 */
	titleZh: string;
	titleEn: string;
	/** 卡片副标题 / 适用场景——中文 / 英文 */
	subtitleZh: string;
	subtitleEn: string;
	/** 资产列表，第一个 recommended 的将作为主按钮 */
	assets: ReleaseAsset[];
}

/** 资产展示元数据（不含 url / sizeBytes，那两项由 GitHub API 提供，兜底见下方）。 */
type AssetMeta = Omit<ReleaseAsset, "url" | "sizeBytes" | "mirrorUrl">;

interface PlatformMeta {
	id: PlatformId;
	titleZh: string;
	titleEn: string;
	subtitleZh: string;
	subtitleEn: string;
	assets: AssetMeta[];
}

const PLATFORM_METAS: PlatformMeta[] = [
	{
		id: "macos",
		titleZh: "macOS",
		titleEn: "macOS",
		subtitleZh: "Apple Silicon · macOS 11 及以上",
		subtitleEn: "Apple Silicon · macOS 11 and above",
		assets: [
			{
				label: "安装包 (.dmg)",
				arch: "arm64",
				format: "dmg",
				filename: "ZPass-darwin-arm64.dmg",
				recommended: true,
				noteZh: "推荐 · 拖入 Applications 即可安装",
				noteEn: "Recommended · drag into Applications to install",
			},
			{
				label: "压缩包 (.zip)",
				arch: "arm64",
				format: "zip",
				filename: "ZPass-darwin-arm64.zip",
				noteZh: "解压即用，适合脚本化部署",
				noteEn: "Portable archive for scripted installs",
			},
		],
	},
	{
		id: "windows",
		titleZh: "Windows",
		titleEn: "Windows",
		subtitleZh: "Windows 10 及以上 · x64",
		subtitleEn: "Windows 10 and above · x64",
		assets: [
			{
				label: "安装程序 (.exe)",
				arch: "x64",
				format: "exe",
				filename: "ZPass-windows-x64-Setup.exe",
				recommended: true,
				noteZh: "推荐 · 含自动更新通道",
				noteEn: "Recommended · with auto-update",
			},
			{
				label: "免安装压缩包 (.zip)",
				arch: "x64",
				format: "zip",
				filename: "ZPass-windows-x64.zip",
				noteZh: "解压即用，适合无管理员权限的环境",
				noteEn: "Portable, no installer or admin rights required",
			},
		],
	},
	{
		id: "linux",
		titleZh: "Linux",
		titleEn: "Linux",
		subtitleZh: "x86_64 · 主流发行版均覆盖",
		subtitleEn: "x86_64 · covering all major distributions",
		assets: [
			{
				label: "AppImage",
				arch: "x64",
				format: "AppImage",
				filename: "ZPass-linux-x64.AppImage",
				recommended: true,
				noteZh: "通用 · 任何发行版直接运行",
				noteEn: "Universal · runs on any distro",
			},
			{
				label: "Debian / Ubuntu",
				arch: "x64",
				format: "deb",
				filename: "ZPass-linux-x64.deb",
				noteZh: "Debian、Ubuntu、Mint 等系发行版",
				noteEn: "For Debian, Ubuntu, Mint and derivatives",
			},
			{
				label: "Fedora / RHEL",
				arch: "x64",
				format: "rpm",
				filename: "ZPass-linux-x64.rpm",
				noteZh: "Fedora、RHEL、openSUSE 等系发行版",
				noteEn: "For Fedora, RHEL, openSUSE and derivatives",
			},
			{
				label: "Arch / CachyOS",
				arch: "x64",
				format: "pkg.tar.zst",
				filename: "ZPass-linux-x64.pkg.tar.zst",
				noteZh: "Arch、Manjaro、CachyOS 等系发行版",
				noteEn: "For Arch, Manjaro, CachyOS and derivatives",
			},
			{
				label: "压缩包",
				arch: "x64",
				format: "zip",
				filename: "ZPass-linux-x64.zip",
				noteZh: "解压即用，适合容器或自定义部署",
				noteEn: "Portable archive for containers or custom setups",
			},
		],
	},
	{
		id: "android",
		titleZh: "Android",
		titleEn: "Android",
		subtitleZh: "Android 8 及以上 · 直装 APK",
		subtitleEn: "Android 8 and above · sideload APK",
		assets: [
			{
				label: "ARM64 (arm64-v8a)",
				arch: "arm64",
				format: "apk",
				filename: "ZPass-android-arm64-v8a.apk",
				recommended: true,
				noteZh: "推荐 · 适用于近年绝大多数手机",
				noteEn: "Recommended · for nearly all modern phones",
			},
			{
				label: "x86_64",
				arch: "x86_64",
				format: "apk",
				filename: "ZPass-android-x86_64.apk",
				noteZh: "适用于 x86 架构平板与模拟器",
				noteEn: "For x86 tablets and emulators",
			},
			{
				label: "Universal",
				arch: "all",
				format: "apk",
				filename: "ZPass-android-universal.apk",
				noteZh: "包含全部架构，不确定时下载这个",
				noteEn: "Contains all architectures—pick this if unsure",
			},
		],
	},
	{
		id: "extension",
		titleZh: "浏览器扩展",
		titleEn: "Browser extension",
		subtitleZh: "Chrome 应用商店一键安装 · 或本地解压加载",
		subtitleEn: "One-click from the Chrome Web Store · or side-load locally",
		assets: [
			{
				label: "Chrome 应用商店",
				arch: "chromium",
				format: "store",
				filename: "chrome-web-store",
				storeUrl:
					"https://chromewebstore.google.com/detail/zpass/dafhkofilckgmnlclnkciddccogpfcdm",
				recommended: true,
				noteZh: "从 Chrome 应用商店安装，随浏览器自动更新（支持 Chrome / Edge / Brave）",
				noteEn:
					"Install from the Chrome Web Store, auto-updates with your browser (Chrome / Edge / Brave)",
			},
			{
				label: "Chrome 手动加载 (.zip)",
				arch: "chromium",
				format: "zip",
				filename: "ZPass-extension-chrome-selfhost.zip",
				noteZh: "解压后从开发者模式加载 · 固定扩展 ID,免配置直连桌面端",
				noteEn:
					"Unpack and load via developer mode · fixed extension ID, connects to desktop out of the box",
			},
			{
				label: "Firefox",
				arch: "firefox",
				format: "zip",
				filename: "ZPass-extension-firefox.zip",
				noteZh: "通过 about:debugging 临时加载",
				noteEn: "Load temporarily via about:debugging",
			},
			{
				label: "扩展源码",
				arch: "sources",
				format: "zip",
				filename: "ZPass-extension-sources.zip",
				noteZh: "可复现构建用 · 商店审核档案",
				noteEn: "For reproducible builds and store review",
			},
		],
	},
];

// ============================================================================
// 兜底数据（GitHub API 不可达时使用）
// ============================================================================

export const FALLBACK_VERSION = "v0.0.6";
export const FALLBACK_TAG_URL =
	"https://github.com/zerx-lab/zpass/releases/tag/v0.0.6";
const FALLBACK_BASE_URL =
	"https://github.com/zerx-lab/zpass/releases/download/v0.0.6";

// GitHub Releases API 不可达时使用的占位 changelog。
// 真实更新日志由 .github/workflows/release-notes.yml 在 tag 发布时通过
// git-cliff 生成并写入 release body，再由 release-fetcher 读取展示。
export const FALLBACK_RELEASE_BODY = `## v0.0.6

### Features

- Cross-platform parity across desktop, mobile, and browser extension
- End-to-end encrypted, local-first vault
- macOS Apple Silicon ad-hoc signed builds

### CI / Build

- Multi-arch Android APK pipeline
- Cross-platform desktop installer pipeline
`;

interface FallbackAsset {
	filename: string;
	sizeBytes: number;
	url: string;
	mirrorUrl: string;
}

const PROXY_PREFIX = "https://ghfast.top/";

const fb = (filename: string, sizeBytes: number): FallbackAsset => {
	const url = `${FALLBACK_BASE_URL}/${filename}`;
	return { filename, sizeBytes, url, mirrorUrl: PROXY_PREFIX + url };
};

export const FALLBACK_ASSETS: FallbackAsset[] = [
	fb("ZPass-darwin-arm64.dmg", 133012367),
	fb("ZPass-darwin-arm64.zip", 119856097),
	fb("ZPass-windows-x64-Setup.exe", 140372992),
	fb("ZPass-windows-x64.zip", 142053094),
	fb("ZPass-linux-x64.AppImage", 119069176),
	fb("ZPass-linux-x64.deb", 91936350),
	fb("ZPass-linux-x64.rpm", 96114141),
	fb("ZPass-linux-x64.pkg.tar.zst", 113276971),
	fb("ZPass-linux-x64.zip", 117033929),
	fb("ZPass-android-arm64-v8a.apk", 42039822),
	fb("ZPass-android-x86_64.apk", 44797184),
	fb("ZPass-extension-chrome.zip", 55392),
	fb("ZPass-extension-chrome-selfhost.zip", 55600),
	fb("ZPass-extension-firefox.zip", 55366),
	fb("ZPass-extension-sources.zip", 588881),
];

// ============================================================================
// 合并：把 release 数据 + 本地元数据 → 给 UI 渲染用的 PlatformGroup[]
// ============================================================================

/**
 * 根据从 GitHub API（或兜底）拿到的 release 数据，结合本地展示元数据生成
 * 平台分组的资产清单。
 *
 * - 资产顺序、label、note、recommended 全部来自本地元数据
 * - url / sizeBytes 优先取 release.assets 中按 filename 匹配的项
 * - 若资产在 release 中缺失，退到兜底快照中按 filename 取（再没有就用占位）
 */
export function buildPlatforms(release: ReleaseData): PlatformGroup[] {
	const fallbackByName = new Map<string, FallbackAsset>(
		FALLBACK_ASSETS.map((a) => [a.filename, a]),
	);

	return PLATFORM_METAS.map((p) => ({
		id: p.id,
		titleZh: p.titleZh,
		titleEn: p.titleEn,
		subtitleZh: p.subtitleZh,
		subtitleEn: p.subtitleEn,
		assets: p.assets.map((meta) => {
			// 商店链接型资产：url 取 storeUrl，不参与文件名匹配，也没有文件体积。
			if (meta.storeUrl) {
				return { ...meta, url: meta.storeUrl, sizeBytes: 0 };
			}
			const fromApi = release.assets.get(meta.filename);
			const fromFallback = fallbackByName.get(meta.filename);
			const url =
				fromApi?.url ??
				fromFallback?.url ??
				`${FALLBACK_BASE_URL}/${meta.filename}`;
			const mirrorUrl =
				fromApi?.mirrorUrl ?? fromFallback?.mirrorUrl ?? undefined;
			const sizeBytes = fromApi?.sizeBytes ?? fromFallback?.sizeBytes ?? 0;
			return { ...meta, url, mirrorUrl, sizeBytes };
		}),
	}));
}

/** 把字节数格式化为简短可读的体积字符串 */
export function formatSize(bytes: number): string {
	if (bytes <= 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	const mb = bytes / (1024 * 1024);
	if (mb < 100) return `${mb.toFixed(1)} MB`;
	return `${mb.toFixed(0)} MB`;
}
