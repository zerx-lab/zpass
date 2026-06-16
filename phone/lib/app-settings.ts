// 设备本地偏好（非加密）—— 对齐 harmony AppSettings.ets 的"读-改-写整份"策略
//
// 存 AsyncStorage 单 key JSON，多个 store/context 各取所需字段，
// 写入时先读最新整份再合并，避免互相覆盖。

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "zpass-settings-v1";

export interface AppSettings {
  /** 底部标签栏是否展示「安全」页（默认 false，可在外观设置中打开） */
  securityTabEnabled?: boolean;
  /** 主题模式（system / dark / light），缺省 system */
  themeMode?: "system" | "dark" | "light";
}

export async function loadAppSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as AppSettings) : {};
  } catch {
    return {};
  }
}

export async function patchAppSettings(
  patch: Partial<AppSettings>,
): Promise<void> {
  try {
    const current = await loadAppSettings();
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    // 偏好写入失败不影响主流程，静默忽略
  }
}
