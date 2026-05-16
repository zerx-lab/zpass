/**
 * useColorScheme (web) —— 桥接到 ZPass ThemeContext
 *
 * 历史上 web 版独立实现，用于处理 SSR hydration 时机问题（避免 server / client
 * 颜色不一致导致闪烁）。现在改为统一转发到 `@/contexts/theme-context`，
 * 与原生平台保持一致，使所有旧 import 自动响应用户的手动主题切换。
 *
 * SSR/Hydration 说明：
 * - ThemeProvider 默认 `initialMode = "system"`，首屏 scheme 由
 *   Appearance.getColorScheme() 决定；在浏览器端这通常是同步可得的，
 *   不会引入额外的 hydration 闪烁。
 * - 如未来需要 SSR 兼容（例如服务端渲染默认走 light），可在 ThemeProvider
 *   层处理，hook 本身保持薄转发即可。
 */
export { useColorScheme } from "@/contexts/theme-context";
