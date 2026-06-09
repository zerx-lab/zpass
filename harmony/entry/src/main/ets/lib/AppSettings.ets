// AppSettings —— 设备本地 UI / 安全偏好持久化（非 vault、不参与 sync）
//
// 落到应用沙箱 filesDir 下的小 JSON 文件，filesDir 由 EntryAbility.onCreate
// 写入 AppStorage（与 VaultStorage 同源）。
//
// 字段：
//   - gripEnabled       智感握姿（MotionStore 消费）
//   - bgBlurEnabled     后台模糊保护：切到后台时盖隐私遮罩
//   - antiPeepEnabled   防窥保护：开启窗口隐私模式（防截屏 / 录屏）
//   - lockOnBackground  切到后台立即锁定保险库
//
// 多个 store 各存各的字段，写入一律「读-改-写」整份，避免互相覆盖。

import { fileIo as fs } from '@kit.CoreFileKit';

const SETTINGS_FILE: string = 'zpass-settings-v1.json';
const FILES_DIR_KEY: string = 'filesDir';

export interface AppSettings {
  gripEnabled: boolean;
  bgBlurEnabled: boolean;
  antiPeepEnabled: boolean;
  lockOnBackground: boolean;
}

/** 安全相关三项，供 SecurityStore 一次性写回 */
export interface SecuritySettings {
  bgBlurEnabled: boolean;
  antiPeepEnabled: boolean;
  lockOnBackground: boolean;
}

function settingsPath(): string | null {
  const dir = AppStorage.get<string>(FILES_DIR_KEY);
  if (!dir) return null;
  return `${dir}/${SETTINGS_FILE}`;
}

/** 读取偏好；文件不存在 / 损坏时回退默认（全 false） */
export async function loadSettings(): Promise<AppSettings> {
  const fallback: AppSettings = {
    gripEnabled: false,
    bgBlurEnabled: false,
    antiPeepEnabled: false,
    lockOnBackground: false,
  };
  const path = settingsPath();
  if (!path) return fallback;
  try {
    if (!(await fs.access(path))) return fallback;
    const text = await fs.readText(path);
    const parsed = JSON.parse(text) as AppSettings;
    return {
      gripEnabled: parsed.gripEnabled === true,
      bgBlurEnabled: parsed.bgBlurEnabled === true,
      antiPeepEnabled: parsed.antiPeepEnabled === true,
      lockOnBackground: parsed.lockOnBackground === true,
    };
  } catch (_e) {
    return fallback;
  }
}

/** 写整份偏好（fire-and-forget；失败静默） */
async function writeSettings(data: AppSettings): Promise<void> {
  const path = settingsPath();
  if (!path) return;
  try {
    const handle = await fs.open(
      path,
      fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC,
    );
    try {
      await fs.write(handle.fd, JSON.stringify(data));
    } finally {
      await fs.close(handle.fd);
    }
  } catch (_e) {
    // 静默
  }
}

/** 持久化握姿开关（读-改-写，保留其余字段） */
export async function saveGripEnabled(v: boolean): Promise<void> {
  const s = await loadSettings();
  s.gripEnabled = v;
  await writeSettings(s);
}

/** 持久化安全三项（读-改-写，保留 gripEnabled） */
export async function saveSecuritySettings(patch: SecuritySettings): Promise<void> {
  const s = await loadSettings();
  s.bgBlurEnabled = patch.bgBlurEnabled;
  s.antiPeepEnabled = patch.antiPeepEnabled;
  s.lockOnBackground = patch.lockOnBackground;
  await writeSettings(s);
}
