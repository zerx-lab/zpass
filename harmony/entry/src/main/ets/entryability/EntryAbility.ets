import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { display, window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { safeAreaState } from '../state/SafeArea';

const DOMAIN = 0xFF00;
const TAG = 'EntryAbility';

// 与 phone/constants/theme.ts 的 dark 主题对齐：bg = #0c0c0d，text = #ececec。
// 状态栏 / 导航栏背景统一透明（#00000000），由窗口背景"渗"上来；
// 图标颜色按当前主题（暗底用白图标）由 setWindowSystemBarProperties 控制。
const STATUS_BAR_CONTENT_DARK = '#ECECEC';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate');
    // 把应用沙箱 filesDir 寫入 AppStorage 供 VaultStorage 等模块读取。
    // OHOS 5+ 沙箱路径可变，避免硬编码。
    try {
      const ctx = this.context;
      AppStorage.setOrCreate<string>('filesDir', ctx.filesDir);
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
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent ok');
      this.applyImmersive(windowStage);
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
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'getMainWindowSync failed: %{public}s', JSON.stringify(e));
      return;
    }

    mainWin.setWindowLayoutFullScreen(true).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'setWindowLayoutFullScreen failed: %{public}s', JSON.stringify(err));
    });

    mainWin.setWindowSystemBarProperties({
      statusBarColor: '#00000000',
      statusBarContentColor: STATUS_BAR_CONTENT_DARK,
      navigationBarColor: '#00000000',
      navigationBarContentColor: STATUS_BAR_CONTENT_DARK,
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'setWindowSystemBarProperties failed: %{public}s', JSON.stringify(err));
    });

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

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
  }
}
