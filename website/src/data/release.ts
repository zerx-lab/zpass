// ZPass 当前发布版本的资产清单
// 来源: https://github.com/zerx-lab/zpass/releases/tag/v0.0.2
// 站点下载区块从这里读取数据；新版本发布后只需要更新这一处。

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

export const RELEASE_VERSION = "v0.0.2";
export const RELEASE_TAG_URL =
	"https://github.com/zerx-lab/zpass/releases/tag/v0.0.2";
export const RELEASE_BASE_URL =
	"https://github.com/zerx-lab/zpass/releases/download/v0.0.2";

const dl = (name: string) => `${RELEASE_BASE_URL}/${name}`;

export const PLATFORMS: PlatformGroup[] = [
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
				sizeBytes: 140307968,
				url: dl("ZPass-windows-x64-Setup.exe"),
				recommended: true,
				noteZh: "推荐 · 含自动更新通道",
				noteEn: "Recommended · with auto-update",
			},
			{
				label: "免安装压缩包 (.zip)",
				arch: "x64",
				format: "zip",
				filename: "ZPass-windows-x64.zip",
				sizeBytes: 141983793,
				url: dl("ZPass-windows-x64.zip"),
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
				sizeBytes: 119003640,
				url: dl("ZPass-linux-x64.AppImage"),
				recommended: true,
				noteZh: "通用 · 任何发行版直接运行",
				noteEn: "Universal · runs on any distro",
			},
			{
				label: "Debian / Ubuntu",
				arch: "x64",
				format: "deb",
				filename: "ZPass-linux-x64.deb",
				sizeBytes: 91883922,
				url: dl("ZPass-linux-x64.deb"),
				noteZh: "Debian、Ubuntu、Mint 等系发行版",
				noteEn: "For Debian, Ubuntu, Mint and derivatives",
			},
			{
				label: "Fedora / RHEL",
				arch: "x64",
				format: "rpm",
				filename: "ZPass-linux-x64.rpm",
				sizeBytes: 96057265,
				url: dl("ZPass-linux-x64.rpm"),
				noteZh: "Fedora、RHEL、openSUSE 等系发行版",
				noteEn: "For Fedora, RHEL, openSUSE and derivatives",
			},
			{
				label: "Arch / CachyOS",
				arch: "x64",
				format: "pkg.tar.zst",
				filename: "ZPass-linux-x64.pkg.tar.zst",
				sizeBytes: 113193190,
				url: dl("ZPass-linux-x64.pkg.tar.zst"),
				noteZh: "Arch、Manjaro、CachyOS 等系发行版",
				noteEn: "For Arch, Manjaro, CachyOS and derivatives",
			},
			{
				label: "压缩包",
				arch: "x64",
				format: "zip",
				filename: "ZPass-linux-x64.zip",
				sizeBytes: 116965356,
				url: dl("ZPass-linux-x64.zip"),
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
				sizeBytes: 41911618,
				url: dl("ZPass-android-arm64-v8a.apk"),
				recommended: true,
				noteZh: "推荐 · 适用于近年绝大多数手机",
				noteEn: "Recommended · for nearly all modern phones",
			},
			{
				label: "x86_64",
				arch: "x86_64",
				format: "apk",
				filename: "ZPass-android-x86_64.apk",
				sizeBytes: 44619831,
				url: dl("ZPass-android-x86_64.apk"),
				noteZh: "适用于 x86 架构平板与模拟器",
				noteEn: "For x86 tablets and emulators",
			},
			{
				label: "Universal",
				arch: "all",
				format: "apk",
				filename: "ZPass-android-universal.apk",
				sizeBytes: 115076862,
				url: dl("ZPass-android-universal.apk"),
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
				sizeBytes: 46901,
				url: dl("ZPass-extension-chrome.zip"),
				recommended: true,
				noteZh: "解压后从开发者模式加载",
				noteEn: "Unpack and load via developer mode",
			},
			{
				label: "Firefox",
				arch: "firefox",
				format: "zip",
				filename: "ZPass-extension-firefox.zip",
				sizeBytes: 46876,
				url: dl("ZPass-extension-firefox.zip"),
				noteZh: "通过 about:debugging 临时加载",
				noteEn: "Load temporarily via about:debugging",
			},
			{
				label: "扩展源码",
				arch: "sources",
				format: "zip",
				filename: "ZPass-extension-sources.zip",
				sizeBytes: 184824,
				url: dl("ZPass-extension-sources.zip"),
				noteZh: "可复现构建用 · 商店审核档案",
				noteEn: "For reproducible builds and store review",
			},
		],
	},
];

/** 把字节数格式化为简短可读的体积字符串 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	const mb = bytes / (1024 * 1024);
	if (mb < 100) return `${mb.toFixed(1)} MB`;
	return `${mb.toFixed(0)} MB`;
}
