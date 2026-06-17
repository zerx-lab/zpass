// AppInfo —— 运行时读取自身安装包信息
//
// 版本号唯一权威来源是 AppScope/app.json5 的 versionName，打包时编进
// bundle；这里通过 bundleManager 读回，UI 展示处不再硬编码版本常量，
// 升版本只改 app.json5 一处。

import { bundleManager } from '@kit.AbilityKit';

/** 真实安装包 versionName；读取失败回退占位符 */
export function appVersionName(): string {
  try {
    const info = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT,
    );
    return info.versionName;
  } catch (_e) {
    return '—';
  }
}

/** 是否 debug/可调试安装包（dev 模式判定，用于放出云服务地址覆盖等开发者入口）。读取失败回退 false。 */
export function appIsDebug(): boolean {
  try {
    const info = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION,
    );
    return info.appInfo.debug === true;
  } catch (_e) {
    return false;
  }
}
