/**
 * useColorScheme —— 桥接到 ZPass ThemeContext
 *
 * 历史上这个 hook 直接 re-export 自 react-native，仅跟随系统色。
 * 现在改为转发到 `@/contexts/theme-context`，使所有旧代码（无需修改 import）
 * 自动响应用户在「我的 → 主题」中的手动切换（system / dark / light）。
 *
 * 注意：
 * - 返回值类型从 `ColorSchemeName`（可能为 null）收窄为 `"dark" | "light"`，
 *   旧代码里的 `useColorScheme() ?? "dark"` 仍然兼容（?? 不会触发）。
 * - 必须在 <ThemeProvider> 子树内调用，否则会抛错。
 */
export { useColorScheme } from "@/contexts/theme-context";
