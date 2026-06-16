// 云服务环境解析 —— 正式 / 测试环境切换
// ---------------------------------------------------------------------------
// 云同步 server 地址不再由用户在 UI 输入，而是：
//   默认       → 正式环境 PROD_CLOUD_BASE_URL
//   手动切换   → 编辑 ~/.config/zpass/zpass.env.json（应用只读不写）：
//
//     { "env": "test", "testUrl": "http://127.0.0.1:8080" }
//
//   env 为 "test" 且 testUrl 非空时使用 testUrl；其余情况（文件不存在 /
//   JSON 损坏 / env 为 "prod" / testUrl 缺失）一律回落正式环境。
//
// 该文件面向开发与测试人员手工编辑，普通用户无感知。Go 侧另有
// ZPASS_CLOUD_BASE_URL 环境变量可在进程级覆盖（dev/CI 用，优先级更高，
// 见 internal/services/cloudservice.go）。

import { configStorage } from "@/lib/config-storage";

/** 正式环境云同步服务地址。 */
export const PROD_CLOUD_BASE_URL = "https://zpass-app.zerx.dev";

/** zpass.env.json 的内容形状（宽松解析，字段缺失即回落默认）。 */
interface CloudEnvConfig {
	env?: string;
	testUrl?: string;
}

/** 规范化地址：去空白、去尾部斜杠。 */
function normalize(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

// 环境配置在一次会话内不会变（编辑文件后需重启应用生效），只读一次并缓存。
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
