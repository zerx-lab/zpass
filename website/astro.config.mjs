// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// ZPass 官网 Astro 配置
// - 启用 i18n（en 为默认，zh 为备选语言）
// - en 路由不带前缀（prefixDefaultLocale: false），中文走 /zh/* 前缀
// - 混合模式：默认 output: "static"（整站预渲染），仅个别端点
//   （如 /api/subscribe）通过 `export const prerender = false` 切换为
//   按需 SSR。@astrojs/node 适配器以 standalone 模式打包出独立 Node
//   server（dist/server/entry.mjs），部署时直接 `node ./dist/server/entry.mjs`
//   即可同时托管静态资源与动态端点。
export default defineConfig({
	site: "https://zpass.dev",
	trailingSlash: "ignore",
	adapter: node({
		mode: "standalone",
	}),
	i18n: {
		defaultLocale: "en",
		locales: ["en", "zh"],
		routing: {
			prefixDefaultLocale: false,
			redirectToDefaultLocale: false,
		},
		fallback: {
			zh: "en",
		},
	},
	build: {
		assets: "assets",
	},
	vite: {
		css: {
			devSourcemap: true,
		},
	},
});
