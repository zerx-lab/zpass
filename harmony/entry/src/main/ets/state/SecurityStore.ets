// SecurityStore —— 应用保护偏好（后台模糊 / 防窥 / 切后台锁定）
//
// 三项偏好落本地（AppSettings），由 EntryAbility 的前后台生命周期消费：
//   - bgBlurEnabled    切到后台时把 blurActive 置 true，Index 顶层盖隐私遮罩
//   - antiPeepEnabled  开启窗口隐私模式（防截屏 / 录屏），由 onPrivacyChange
//                      回调通知 EntryAbility 即时应用（需系统级 PRIVACY_WINDOW
//                      权限，三方签名下静默降级）
//   - lockOnBackground 切到后台立即 vaultStore.lock()
//
// blurActive 仅为运行态，不持久化。

import { loadSettings, saveSecuritySettings } from '../lib/AppSettings';

type PrivacyChangeCb = () => void;

@ObservedV2
export class SecurityStore {
  @Trace bgBlurEnabled: boolean = false;
  @Trace antiPeepEnabled: boolean = false;
  @Trace lockOnBackground: boolean = false;

  /** 后台隐私遮罩当前是否显示（由 EntryAbility 生命周期驱动，不持久化） */
  @Trace blurActive: boolean = false;

  /** 本次锁定是否由「切到后台」触发 —— 用于回前台再解锁、抑制锁屏页即时弹生物识别 */
  lockedByBackground: boolean = false;

  private onPrivacyChange: PrivacyChangeCb | null = null;

  /** 启动时从持久化恢复（不回写）；恢复后通知一次让窗口隐私模式即时对齐 */
  async hydrate(): Promise<void> {
    const s = await loadSettings();
    this.bgBlurEnabled = s.bgBlurEnabled;
    this.antiPeepEnabled = s.antiPeepEnabled;
    this.lockOnBackground = s.lockOnBackground;
    if (this.onPrivacyChange) this.onPrivacyChange();
  }

  setBgBlurEnabled(v: boolean): void {
    this.bgBlurEnabled = v;
    this.persist();
  }

  setAntiPeepEnabled(v: boolean): void {
    this.antiPeepEnabled = v;
    this.persist();
    if (this.onPrivacyChange) this.onPrivacyChange(); // 防窥需前台即时生效
  }

  setLockOnBackground(v: boolean): void {
    this.lockOnBackground = v;
    this.persist();
  }

  /** EntryAbility 注册：偏好变化时重新应用窗口隐私模式 */
  setOnPrivacyChange(cb: PrivacyChangeCb): void {
    this.onPrivacyChange = cb;
  }

  private persist(): void {
    saveSecuritySettings({
      bgBlurEnabled: this.bgBlurEnabled,
      antiPeepEnabled: this.antiPeepEnabled,
      lockOnBackground: this.lockOnBackground,
    });
  }
}

export const securityStore = new SecurityStore();
