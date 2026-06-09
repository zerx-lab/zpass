import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { display, mediaquery, window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { safeAreaState } from '../state/SafeArea';
import { themeStore, type ColorMode } from '../state/ThemeStore';
import { securityStore } from '../state/SecurityStore';
import { vaultStore } from '../state/VaultStore';

const DOMAIN = 0xFF00;
const TAG = 'EntryAbility';

// 系统栏前景色（图标 / 时间）：暗底用白前景，亮底用黑前景。
// 与 phone/constants/theme.ts 保持对齐。
const STATUS_FG_FOR_DARK = '#ECECEC';
const STATUS_FG_FOR_LIGHT = '#0C0C0D';

export default class EntryAbility extends UIAbility {
  private darkModeListener?: mediaquery.MediaQueryListener;
  private mainWin?: window.Window;

  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate');
    // 把应用沙箱 filesDir 寫入 AppStorage 供 VaultStorage 等模块读取。
    // OHOS 5+ 沙箱路径可变，避免硬编码。
    try {
      const ctx = this.context;
      AppStorage.setOrCreate<string>('filesDir', ctx.filesDir);
      // cacheDir 供 Favicon 等可重建的派生数据落盘（系统清缓存时随之回收）。
      AppStorage.setOrCreate<string>('cacheDir', ctx.cacheDir);
      hilog.info(DOMAIN, TAG, 'filesDir=%{public}s', ctx.filesDir);
    } catch (e) {
      hilog.error(
        DOMAIN,
        TAG,
        'persist filesDir failed: %{public}s',
        JSON.stringify(e),
      );
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onDestroy');
    this.darkModeListener?.off('change');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent ok');
      this.applyImmersive(windowStage);
      this.bindSystemColorMode();
      this.bindWindowStageEvent(windowStage);
    });
  }

  /**
   * 沉浸式 + 边到边：
   *   1. setWindowLayoutFullScreen(true)         — 窗口扩展到状态栏 / 导航栏区域
   *   2. setWindowSystemBarProperties(transparent)— 系统栏背景透明，露出页面 bg
   *   3. 把 systemBar / navigationIndicator 的 avoidArea 高度写进 AppStorage，
   *      供页面用 .padding() / .margin() 精确避让
   *   4. 订阅 avoidAreaChange，处理横竖屏 / 折叠态切换
   */
  private applyImmersive(windowStage: window.WindowStage): void {
    let mainWin: window.Window;
    try {
      mainWin = windowStage.getMainWindowSync();
      this.mainWin = mainWin;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'getMainWindowSync failed: %{public}s', JSON.stringify(e));
      return;
    }

    mainWin.setWindowLayoutFullScreen(true).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'setWindowLayoutFullScreen failed: %{public}s', JSON.stringify(err));
    });

    this.applySystemBar(themeStore.effective);

    this.publishAvoidArea(mainWin, window.AvoidAreaType.TYPE_SYSTEM);
    this.publishAvoidArea(mainWin, window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);

    mainWin.on('avoidAreaChange', (data) => {
      if (
        data.type === window.AvoidAreaType.TYPE_SYSTEM ||
        data.type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR
      ) {
        this.writeAvoidArea(data.type, data.area);
      } else if (data.type === window.AvoidAreaType.TYPE_KEYBOARD) {
        // 沉浸式窗口下 ArkUI 默认 KeyboardAvoidMode 不一定生效 ——
        // 把键盘占据高度（vp）写进 safeAreaState，让密码输入页主动避让。
        const density = display.getDefaultDisplaySync().densityPixels || 1;
        safeAreaState.keyboard = data.area.bottomRect.height / density;
      }
    });
  }

  /**
   * 跟随系统的 dark-mode 切换：
   *   - matchMediaSync 拿初始值并写回 themeStore
   *   - 注册 change 回调持续同步
   *   - themeStore 在 effective 变化时回调本端，重新刷新系统栏前景色
   */
  private bindSystemColorMode(): void {
    try {
      const listener = mediaquery.matchMediaSync('(dark-mode: true)');
      this.darkModeListener = listener;
      themeStore.setSystemColorMode(listener.matches ? 'dark' : 'light');
      listener.on('change', (result: mediaquery.MediaQueryResult) => {
        themeStore.setSystemColorMode(result.matches ? 'dark' : 'light');
      });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'mediaquery bind failed: %{public}s', JSON.stringify(e));
    }

    themeStore.setOnEffectiveChange((m: ColorMode) => {
      this.applySystemBar(m);
    });

    // 防窥偏好变化时即时重应用窗口隐私模式（hydrate 完成 / 用户切换开关）
    securityStore.setOnPrivacyChange(() => {
      this.applyPrivacyMode();
    });
    this.applyPrivacyMode();
  }

  /**
   * 防窥保护：开启窗口隐私模式后，截屏 / 录屏 / 多任务预览均不可见。
   * 需系统级 ohos.permission.PRIVACY_WINDOW；三方签名拿不到时静默降级。
   */
  private applyPrivacyMode(): void {
    if (!this.mainWin) return;
    this.mainWin.setWindowPrivacyMode(securityStore.antiPeepEnabled)
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'setWindowPrivacyMode failed: %{public}s', JSON.stringify(err));
      });
  }

  private applySystemBar(effective: ColorMode): void {
    if (!this.mainWin) return;
    const fg = effective === 'dark' ? STATUS_FG_FOR_DARK : STATUS_FG_FOR_LIGHT;
    this.mainWin.setWindowSystemBarProperties({
      statusBarColor: '#00000000',
      statusBarContentColor: fg,
      navigationBarColor: '#00000000',
      navigationBarContentColor: fg,
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'setWindowSystemBarProperties failed: %{public}s', JSON.stringify(err));
    });
  }

  private publishAvoidArea(win: window.Window, type: window.AvoidAreaType): void {
    try {
      const area = win.getWindowAvoidArea(type);
      this.writeAvoidArea(type, area);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'getWindowAvoidArea(%{public}d) failed: %{public}s',
        type, JSON.stringify(e));
    }
  }

  private writeAvoidArea(type: window.AvoidAreaType, area: window.AvoidArea): void {
    // ArkUI 距离单位为 vp，window API 返回 px；用 display 像素密度换算
    const density = display.getDefaultDisplaySync().densityPixels || 1;
    if (type === window.AvoidAreaType.TYPE_SYSTEM) {
      safeAreaState.top = area.topRect.height / density;
    } else if (type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR) {
      safeAreaState.bottom = area.bottomRect.height / density;
    }
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy');
  }

  /**
   * 后台模糊保护（对齐华为官方「退后台新增蒙层保护隐私」方案）：
   * 监听 windowStageEvent，退到后台（PAUSED）时置 blurActive，Index 对内容做
   * foregroundBlurStyle 模糊；PAUSED 是官方推荐信号，早于多任务卡片快照。
   */
  private bindWindowStageEvent(windowStage: window.WindowStage): void {
    try {
      windowStage.on('windowStageEvent', (event: window.WindowStageEventType) => {
        if (event === window.WindowStageEventType.PAUSED) {
          securityStore.blurActive = securityStore.bgBlurEnabled;
        } else {
          securityStore.blurActive = false;
        }
      });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'windowStageEvent bind failed: %{public}s', JSON.stringify(e));
    }
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground');
    // 切后台锁定后回到前台：此时才尝试生物解锁（避免切后台瞬间弹人脸）
    if (securityStore.lockedByBackground) {
      securityStore.lockedByBackground = false;
      if (
        vaultStore.status.initialized &&
        !vaultStore.isUnlocked() &&
        vaultStore.trustedSupported &&
        vaultStore.trustedEnabled
      ) {
        vaultStore.tryAutoUnlock().catch(() => {
          // tryAutoUnlock 内部已吞错
        });
      }
    }
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
    // 切后台锁定：立即锁定；标记由后台触发，供回前台再解锁并抑制锁屏页即时弹生物识别
    if (securityStore.lockOnBackground && vaultStore.isUnlocked()) {
      securityStore.lockedByBackground = true;
      vaultStore.lock();
    }
  }
}
