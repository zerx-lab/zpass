// UiStore —— 设备本地界面布局偏好（外观与交互页消费）
//
//   - securityTabEnabled  是否展示底栏「安全」页。默认关闭：安全评分 / 泄露
//                         检测等功能仅在用户主动开启后才出现在底部标签栏。
//
// 偏好落本地（AppSettings），与握姿 / 应用保护偏好同一份文件。

import { loadSettings, saveSecurityTabEnabled } from '../lib/AppSettings';

@ObservedV2
export class UiStore {
  @Trace securityTabEnabled: boolean = false;

  /** 启动时从持久化恢复（不回写） */
  async hydrate(): Promise<void> {
    const s = await loadSettings();
    this.securityTabEnabled = s.securityTabEnabled;
  }

  setSecurityTabEnabled(v: boolean): void {
    this.securityTabEnabled = v;
    saveSecurityTabEnabled(v);
  }
}

export const uiStore = new UiStore();
