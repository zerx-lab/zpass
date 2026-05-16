import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";
import path from "node:path";

// Vite 配置 —— ZPass Desktop（Wails 3）
// ---------------------------------------------------------------------------
// 1. `@wailsio/runtime/plugins/vite` 是 Wails 3 提供的 Vite 插件，参数指向
//    Go 侧 `wails3 generate bindings` 输出的目录（这里约定为 `./bindings`），
//    用于注入 dev server 与 webview 之间的运行时桥接、并为 TS 提供绑定别名。
// 2. Tailwind v4 走官方 `@tailwindcss/vite`，与 desktop 子项目保持一致。
// 3. `@` 别名指向 `src/`，与 tsconfig.json 的 paths 一一对应。
// 4. 端口固定 9245（与 Taskfile.yml 中的 WAILS_VITE_PORT 默认值同步）。
//    Wails dev 命令会通过 -port 参数注入；这里写死作为兜底，避免端口漂移。

export default defineConfig({
	plugins: [react(), tailwindcss(), wails("./bindings")],

	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},

	// 防止 Vite 在终端清屏覆盖 Go 侧错误输出
	clearScreen: false,

	// Wails dev 会在 Vite 刚 ready 后立刻创建 WebView。冷启动时如果 Vite
	// 仍在按需发现 React/Radix 等依赖，会触发 "optimized dependencies
	// changed. reloading"，WebView2 可能继续请求已经失效的 .vite/deps
	// chunk，Wails 代理表现为 504 Gateway Timeout，窗口就停在黑屏。
	// 显式预优化首屏和弹窗链路依赖，让 dev server 在 WebView 加载前稳定
	// 产出依赖图。
	optimizeDeps: {
		include: [
			"@radix-ui/react-alert-dialog",
			"@radix-ui/react-dialog",
			"@radix-ui/react-dropdown-menu",
			"@radix-ui/react-popover",
			"@radix-ui/react-select",
			"@wailsio/runtime",
			"cmdk",
			"framer-motion",
			"i18next",
			"lucide-react",
			"react",
			"react-dom",
			"react-dom/client",
			"react-i18next",
			"react-router-dom",
			"tinykeys",
			"zustand",
		],
	},

	server: {
		port: 9245,
		strictPort: true,
		// Wails dev 会监控 frontend/，无需额外 watch 配置；忽略 bindings 自动生成
		// 文件以免触发死循环。
		watch: {
			ignored: ["**/bindings/**"],
		},
	},
});
