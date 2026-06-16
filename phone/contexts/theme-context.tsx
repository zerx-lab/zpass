import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Appearance, type ColorSchemeName } from "react-native";

import { Colors, type ColorPalette, type ColorScheme } from "@/constants/theme";
import { loadAppSettings, patchAppSettings } from "@/lib/app-settings";

/**
 * 主题模式：
 * - "system"：跟随系统（默认）
 * - "dark" / "light"：手动指定
 */
export type ThemeMode = "system" | "dark" | "light";

interface ThemeContextValue {
  /** 用户选择的模式（system / dark / light） */
  mode: ThemeMode;
  /** 实际生效的配色方案（dark / light），永远不为 system */
  scheme: ColorScheme;
  /** 当前生效的调色板（直接拿到颜色对象，避免每个组件再做 Colors[scheme]） */
  colors: ColorPalette;
  /** 切换到指定模式 */
  setMode: (next: ThemeMode) => void;
  /** dark ↔ light 快速翻转（system 时根据当前生效色翻转） */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 解析一个 ColorSchemeName（可能是 null / undefined）为确定的 ColorScheme。
 * 兜底：null/undefined → "dark"（ZPass 设计以暗色为主）
 */
function resolveSystemScheme(input: ColorSchemeName | null | undefined): ColorScheme {
  return input === "light" ? "light" : "dark";
}

interface ThemeProviderProps {
  children: ReactNode;
  /** 初始模式，默认 "system" */
  initialMode?: ThemeMode;
}

export function ThemeProvider({ children, initialMode = "system" }: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [systemScheme, setSystemScheme] = useState<ColorScheme>(() =>
    resolveSystemScheme(Appearance.getColorScheme()),
  );

  // 启动时恢复上次选择的主题模式（持久化在设备本地偏好）
  useEffect(() => {
    let alive = true;
    loadAppSettings().then((s) => {
      if (alive && (s.themeMode === "dark" || s.themeMode === "light")) {
        setModeState(s.themeMode);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // 监听系统颜色方案变化（仅在 mode === "system" 时影响渲染）
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(resolveSystemScheme(colorScheme));
    });
    return () => sub.remove();
  }, []);

  const scheme: ColorScheme = mode === "system" ? systemScheme : mode;

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void patchAppSettings({ themeMode: next });
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const current = prev === "system" ? resolveSystemScheme(Appearance.getColorScheme()) : prev;
      const next = current === "dark" ? "light" : "dark";
      void patchAppSettings({ themeMode: next });
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      scheme,
      colors: Colors[scheme],
      setMode,
      toggle,
    }),
    [mode, scheme, setMode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 获取主题上下文。必须在 ThemeProvider 内使用。
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return ctx;
}

/**
 * 兼容旧代码：返回当前生效的 ColorScheme（"dark" | "light"），与 RN 的 useColorScheme 接口一致。
 * 但这个 hook 受 ThemeProvider 控制，会响应用户手动切换。
 */
export function useColorScheme(): ColorScheme {
  return useTheme().scheme;
}

/**
 * 便捷 hook：直接拿到当前调色板。
 */
export function useThemeColors(): ColorPalette {
  return useTheme().colors;
}
