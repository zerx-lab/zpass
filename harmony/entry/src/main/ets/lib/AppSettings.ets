// AppSettings —— 设备本地 UI 偏好持久化（非 vault、不参与 sync）
//
// 目前仅存「智感握姿」开关。落到应用沙箱 filesDir 下的小 JSON 文件，
// filesDir 由 EntryAbility.onCreate 写入 AppStorage（与 VaultStorage 同源）。

import { fileIo as fs } from '@kit.CoreFileKit';

const SETTINGS_FILE: string = 'zpass-settings-v1.json';
const FILES_DIR_KEY: string = 'filesDir';

export interface AppSettings {
  gripEnabled: boolean;
}

function settingsPath(): string | null {
  const dir = AppStorage.get<string>(FILES_DIR_KEY);
  if (!dir) return null;
  return `${dir}/${SETTINGS_FILE}`;
}

/** 读取偏好；文件不存在 / 损坏时回退默认（全 false） */
export async function loadSettings(): Promise<AppSettings> {
  const fallback: AppSettings = { gripEnabled: false };
  const path = settingsPath();
  if (!path) return fallback;
  try {
    if (!(await fs.access(path))) return fallback;
    const text = await fs.readText(path);
    const parsed = JSON.parse(text) as AppSettings;
    return { gripEnabled: parsed.gripEnabled === true };
  } catch (_e) {
    return fallback;
  }
}

/** 持久化握姿开关（fire-and-forget；失败静默） */
export async function saveGripEnabled(v: boolean): Promise<void> {
  const path = settingsPath();
  if (!path) return;
  try {
    const data: AppSettings = { gripEnabled: v };
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
