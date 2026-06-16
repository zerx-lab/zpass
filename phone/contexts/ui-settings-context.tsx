// UI 布局偏好 —— 对齐 harmony UiStore：目前只管「安全页」标签可见性
//
// 与安全偏好/主题分离，持久化走 lib/app-settings（读-改-写整份）。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { loadAppSettings, patchAppSettings } from "@/lib/app-settings";

interface UiSettingsValue {
  /** 底部标签栏是否展示「安全」页（默认隐藏，可选打开） */
  securityTabEnabled: boolean;
  setSecurityTabEnabled: (next: boolean) => void;
}

const UiSettingsContext = createContext<UiSettingsValue | null>(null);

export function UiSettingsProvider({ children }: { children: ReactNode }) {
  const [securityTabEnabled, setSecurityTabEnabledState] = useState(false);

  useEffect(() => {
    let alive = true;
    loadAppSettings().then((s) => {
      if (alive && s.securityTabEnabled === true) {
        setSecurityTabEnabledState(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const setSecurityTabEnabled = useCallback((next: boolean) => {
    setSecurityTabEnabledState(next);
    void patchAppSettings({ securityTabEnabled: next });
  }, []);

  const value = useMemo(
    () => ({ securityTabEnabled, setSecurityTabEnabled }),
    [securityTabEnabled, setSecurityTabEnabled],
  );

  return (
    <UiSettingsContext.Provider value={value}>
      {children}
    </UiSettingsContext.Provider>
  );
}

export function useUiSettings(): UiSettingsValue {
  const ctx = useContext(UiSettingsContext);
  if (!ctx) {
    throw new Error("useUiSettings must be used within <UiSettingsProvider>");
  }
  return ctx;
}
