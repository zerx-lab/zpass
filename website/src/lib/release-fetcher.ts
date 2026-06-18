// 从 GitHub Releases API 拉取最新版本元数据
// ---------------------------------------------------------------------------
// 站点不再把版本号写死，而是在 SSR 时调用 /repos/zerx-lab/zpass/releases/latest，
// 拿到 tag_name 与 assets 列表后由 data/release.ts 合并展示元数据。
// 通过模块级内存缓存做 24 小时 TTL，避免每次请求都打 GitHub —— 进程重启即重新拉取。
// 网络失败 / 限流时回退到 data/release.ts 中的兜底数据，保证页面始终可渲染。

import {
	FALLBACK_ASSETS,
	FALLBACK_RELEASE_BODY,
	FALLBACK_TAG_URL,
	FALLBACK_VERSION,
} from "../data/release";

// 国内加速镜像代理前缀，格式：代理域名 + 原始 GitHub 下载 URL
// 当代理不可用时，客户端会自动降级到原始 GitHub 地址（见 Release.astro 的 initDownloadFallback）
const PROXY_PREFIX = "https://ghfast.top/";

const RELEASE_API_URL =
	"https://api.github.com/repos/zerx-lab/zpass/releases/latest";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface ReleaseAssetData {
	/** 原始 GitHub 下载地址 */
	url: string;
	/** 国内加速镜像地址（ghfast.top 代理），客户端探活失败后降级到 url */
	mirrorUrl: string;
	sizeBytes: number;
}

export interface ReleaseData {
	version: string;
	tagUrl: string;
	/** filename → { url, sizeBytes } */
	assets: Map<string, ReleaseAssetData>;
	/** GitHub Release body —— 由 .github/workflows/release-notes.yml 用 git-cliff 生成 */
	body: string;
	/** 数据来源，便于调试时判断是命中 API 还是兜底 */
	source: "api" | "fallback" | "cache";
	fetchedAt: number;
}

interface CacheEntry {
	data: ReleaseData;
	fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<ReleaseData> | null = null;

function makeMirror(ghUrl: string): string {
	return PROXY_PREFIX + ghUrl;
}

function buildFallback(): ReleaseData {
	const assets = new Map<string, ReleaseAssetData>();
	for (const a of FALLBACK_ASSETS) {
		assets.set(a.filename, {
			url: a.url,
			mirrorUrl: makeMirror(a.url),
			sizeBytes: a.sizeBytes,
		});
	}
	return {
		version: FALLBACK_VERSION,
		tagUrl: FALLBACK_TAG_URL,
		assets,
		body: FALLBACK_RELEASE_BODY,
		source: "fallback",
		fetchedAt: Date.now(),
	};
}

interface GhAsset {
	name: string;
	size: number;
	browser_download_url: string;
}

interface GhRelease {
	tag_name: string;
	html_url: string;
	body: string | null;
	assets: GhAsset[];
}

async function fetchFromGithub(): Promise<ReleaseData> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(RELEASE_API_URL, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "zpass-website",
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`GitHub API ${res.status}`);
		}
		const json = (await res.json()) as GhRelease;
		const assets = new Map<string, ReleaseAssetData>();
		for (const a of json.assets ?? []) {
			assets.set(a.name, {
				url: a.browser_download_url,
				mirrorUrl: makeMirror(a.browser_download_url),
				sizeBytes: a.size,
			});
		}
		return {
			version: json.tag_name,
			tagUrl: json.html_url,
			assets,
			// API 偶尔会返回 body 为 null（早期手工创建的 release），降级到兜底文案
			body: json.body?.trim() ? json.body : FALLBACK_RELEASE_BODY,
			source: "api",
			fetchedAt: Date.now(),
		};
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * 获取最新 release 数据 —— 命中缓存（24h 内）直接返回，否则触发一次拉取；
 * 拉取失败时降级使用本地兜底，保证站点永远不会因为外部 API 故障而无法渲染。
 */
export async function getLatestRelease(): Promise<ReleaseData> {
	const now = Date.now();
	if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
		return { ...cache.data, source: "cache" };
	}
	if (inflight) return inflight;

	inflight = (async () => {
		try {
			const data = await fetchFromGithub();
			cache = { data, fetchedAt: data.fetchedAt };
			return data;
		} catch (err) {
			console.warn(
				"[release-fetcher] GitHub API fetch failed, using fallback:",
				err instanceof Error ? err.message : err,
			);
			const fallback = buildFallback();
			// 兜底也写入缓存，避免在 GitHub 持续故障时每次请求都重试外网。
			cache = { data: fallback, fetchedAt: fallback.fetchedAt };
			return fallback;
		} finally {
			inflight = null;
		}
	})();

	return inflight;
}
