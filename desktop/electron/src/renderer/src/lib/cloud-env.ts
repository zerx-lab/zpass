// 云服务环境解析 —— 正式 / 测试环境切换
// ---------------------------------------------------------------------------
// 云同步 server 地址不由普通用户输入，而是：
//   默认       → 正式环境 PROD_CLOUD_BASE_URL
//   手动切换   → ~/.config/zpass/zpass.env.json：
//
//     { "env": "test", "testUrl": "http://localhost:8080" }
//
//   env 为 "test" 且 testUrl 非空时使用 testUrl；其余情况（文件不存在 /
//   JSON 损坏 / env 为 "prod" / testUrl 缺失）一律回落正式环境。
//
// 该文件面向开发与测试人员。dev 构建的设置页提供「开发者 · 云服务地址」
// 快速切换（import.meta.env.DEV 门控），通过 setCloudBaseUrlOverride 写入
// 本文件；普通用户无感知。Go 侧另有 ZPASS_CLOUD_BASE_URL 环境变量可在进程
// 级覆盖（dev/CI 用，见 internal/services/cloudservice.go）。

import { configStorage } from "@/lib/config-storage";

/** 正式环境云同步服务地址。 */
export const PROD_CLOUD_BASE_URL = "https://zpass-app.zerx.dev";

/** 本地调试云同步服务地址（dev 快速切换用）。 */
export const LOCAL_CLOUD_BASE_URL = "http://localhost:8080";

/** zpass.env.json 的内容形状（宽松解析，字段缺失即回落默认）。 */
interface CloudEnvConfig {
	env?: string;
	testUrl?: string;
}

/** 规范化地址：去空白、去尾部斜杠。 */
function normalize(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

// 环境配置一次会话内不变（手动编辑文件需重启生效），只读一次并缓存。dev
// 快速切换走 setCloudBaseUrlOverride，会同步刷新该缓存，免重启即时生效。
let cached: Promise<string> | null = null;

/**
 * 解析当前应使用的云服务地址（异步，结果缓存）。
 *
 * 非 Wails 环境（vite preview / 测试）直接返回正式环境地址。
 */
export function resolveCloudBaseUrl(): Promise<string> {
	if (!cached) cached = doResolve();
	return cached;
}

async function doResolve(): Promise<string> {
	// configStorage.read 已做错误降级：文件不存在 / IO 失败均返回 null。
	const raw = await configStorage.read("zpass.env");
	if (raw == null) return PROD_CLOUD_BASE_URL;
	try {
		const cfg = JSON.parse(raw) as CloudEnvConfig;
		if (cfg.env === "test" && typeof cfg.testUrl === "string") {
			const url = normalize(cfg.testUrl);
			if (url) return url;
		}
	} catch (err) {
		console.error("[cloud-env] malformed zpass.env.json, using prod:", err);
	}
	return PROD_CLOUD_BASE_URL;
}

/**
 * 持久化云服务地址覆盖到 zpass.env.json（dev「开发者 · 云服务地址」快速切换）。
 *
 * - 规范化后等于正式环境地址 → 写 { env: "prod" }（回落 PROD，随版本更新）；
 * - 否则 → 写 { env: "test", testUrl: <url> }。
 *
 * 同步刷新进程内缓存，使后续 resolveCloudBaseUrl() 立即返回新值（免重启）。
 * 返回最终生效（已规范化）的地址，供调用方下发给后端与展示。
 */
export async function setCloudBaseUrlOverride(url: string): Promise<string> {
	const next = normalize(url) || PROD_CLOUD_BASE_URL;
	const cfg: CloudEnvConfig =
		next === PROD_CLOUD_BASE_URL ? { env: "prod" } : { env: "test", testUrl: next };
	await configStorage.write("zpass.env", JSON.stringify(cfg, null, 2));
	cached = Promise.resolve(next);
	return next;
}
