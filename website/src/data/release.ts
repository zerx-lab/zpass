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

export type PlatformId = "windows" | "linux" | "android" | "extension";

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
	/** 直接下载 URL */
	url: string;
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
type AssetMeta = Omit<ReleaseAsset, "url" | "sizeBytes">;

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
		subtitleZh: "本地解压安装 · 商店上架前的早期版本",
		subtitleEn: "Side-load locally · pre-store-listing build",
		assets: [
			{
				label: "Chrome / Edge / Brave",
				arch: "chromium",
				format: "zip",
				filename: "ZPass-extension-chrome.zip",
				recommended: true,
				noteZh: "解压后从开发者模式加载",
				noteEn: "Unpack and load via developer mode",
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

export const FALLBACK_VERSION = "v0.0.2";
export const FALLBACK_TAG_URL =
	"https://github.com/zerx-lab/zpass/releases/tag/v0.0.2";
const FALLBACK_BASE_URL =
	"https://github.com/zerx-lab/zpass/releases/download/v0.0.2";

interface FallbackAsset {
	filename: string;
	sizeBytes: number;
	url: string;
}

const fb = (filename: string, sizeBytes: number): FallbackAsset => ({
	filename,
	sizeBytes,
	url: `${FALLBACK_BASE_URL}/${filename}`,
});

export const FALLBACK_ASSETS: FallbackAsset[] = [
	fb("ZPass-windows-x64-Setup.exe", 140307968),
	fb("ZPass-windows-x64.zip", 141983793),
	fb("ZPass-linux-x64.AppImage", 119003640),
	fb("ZPass-linux-x64.deb", 91883922),
	fb("ZPass-linux-x64.rpm", 96057265),
	fb("ZPass-linux-x64.pkg.tar.zst", 113193190),
	fb("ZPass-linux-x64.zip", 116965356),
	fb("ZPass-android-arm64-v8a.apk", 41911618),
	fb("ZPass-android-x86_64.apk", 44619831),
	fb("ZPass-android-universal.apk", 115076862),
	fb("ZPass-extension-chrome.zip", 46901),
	fb("ZPass-extension-firefox.zip", 46876),
	fb("ZPass-extension-sources.zip", 184824),
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
			const fromApi = release.assets.get(meta.filename);
			const fromFallback = fallbackByName.get(meta.filename);
			const url =
				fromApi?.url ??
				fromFallback?.url ??
				`${FALLBACK_BASE_URL}/${meta.filename}`;
			const sizeBytes =
				fromApi?.sizeBytes ?? fromFallback?.sizeBytes ?? 0;
			return { ...meta, url, sizeBytes };
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
