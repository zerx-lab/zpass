// ZPass HarmonyOS —— 应用入口路由
//
// 根据全局 vault 状态切换三种顶级界面：
//   1. 未水合（hydrated=false）→ 品牌启动闪屏，防冷启动闪错屏
//   2. 未初始化 → OnboardingOverlay（设置主密码）
//   3. 已初始化未解锁 → LockOverlay（输入主密码 / 信任设备解锁）
//   4. 已解锁 → 4 Tab 主界面（密码库 / 生成器 / 安全 / 我的）
//
// 与 phone/app/_layout.tsx 的路由守卫逻辑等价。
//
// 本文件保持轻量；具体页面在 ../views/* 实现。

import { ZColors, ZColorsClass, ZRadius } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { VaultTab } from '../views/VaultTab';
import { GeneratorTab } from '../views/GeneratorTab';
import { SecurityTab } from '../views/SecurityTab';
import { MeTab } from '../views/MeTab';
import { LockOverlay } from '../views/LockOverlay';
import { OnboardingOverlay } from '../views/OnboardingOverlay';
import { motionStore } from '../state/MotionStore';

interface TabSpec {
  key: string;
  label: string;
  icon: Resource;
}

const TABS: TabSpec[] = [
  { key: 'vault', label: '密码库', icon: $r('app.media.ic_tab_vault') },
  { key: 'generator', label: '生成器', icon: $r('app.media.ic_tab_generator') },
  { key: 'security', label: '安全', icon: $r('app.media.ic_tab_security') },
  { key: 'me', label: '我的', icon: $r('app.media.ic_tab_me') },
];

@Entry
@ComponentV2
struct Index {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;
  @Local activeTab: string = 'vault';

  aboutToAppear(): void {
    // 启动时刷新一次状态；refresh() 完成后 store.hydrated 置 true
    // 之后由各 Tab / Overlay 自己驱动 refresh
    this.store.refresh();
    // 恢复设备本地偏好（握姿开关），filesDir 已由 EntryAbility.onCreate 注入
    motionStore.hydrate();
  }

  private currentTabIndex(): number {
    const i = TABS.findIndex((t) => t.key === this.activeTab);
    return i < 0 ? 0 : i;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        if (!this.store.hydrated) {
          // 首次水合中 —— 品牌启动占位，防止冷启动闪错屏（与 phone BootSplash 对应）
          this.bootSplash();
        } else if (!this.store.status.initialized) {
          // 未初始化 —— 设置主密码
          OnboardingOverlay();
        } else if (!this.store.status.unlocked) {
          // 已初始化未解锁 —— 锁屏
          LockOverlay();
        } else {
          // 已解锁 —— 4 Tab（Tab bar 顶部 1vp 描边，与 phone borderTopWidth:1 对应）
          Column() {
            Tabs({ barPosition: BarPosition.End, index: this.currentTabIndex() }) {
              TabContent() {
                VaultTab();
              }.tabBar(this.tabBarItem(TABS[0]));

              TabContent() {
                GeneratorTab();
              }.tabBar(this.tabBarItem(TABS[1]));

              TabContent() {
                SecurityTab();
              }.tabBar(this.tabBarItem(TABS[2]));

              TabContent() {
                MeTab();
              }.tabBar(this.tabBarItem(TABS[3]));
            }
            .vertical(false)
            .barMode(BarMode.Fixed)
            .barHeight(56 + this.safeArea.bottom)
            .barBackgroundColor(this.zc.bg)
            .scrollable(true)
            .animationDuration(200)
            .onChange((idx: number) => {
              if (idx >= 0 && idx < TABS.length) {
                this.activeTab = TABS[idx].key;
              }
            })
            .layoutWeight(1)
            .width('100%')
            .border({ width: { top: 1 }, color: { top: this.zc.line } });
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Start)
          .alignItems(HorizontalAlign.Start);
        }
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Start)
      .alignItems(HorizontalAlign.Start)
      .align(Alignment.TopStart)
      .backgroundColor(this.zc.bg);
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.zc.bg)
    .expandSafeArea(
      [SafeAreaType.SYSTEM],
      [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM],
    );
  }

  /**
   * 品牌启动闪屏 —— 对应 phone/app/_layout.tsx BootSplash。
   * 等待 store.hydrated=true 后消失，防止冷启动瞬间渲染错误叠加层。
   * 布局：全屏 bg 色背景 + 居中 64x64 文字方块（zc.text 底色 + 'Z' 反色）。
   */
  @Builder
  bootSplash() {
    Column() {
      Column() {
        Text('Z')
          .fontSize(32)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.bg)
          .textAlign(TextAlign.Center)
          .letterSpacing(-0.5);
      }
      .width(64)
      .height(64)
      .borderRadius(ZRadius.xl)
      .backgroundColor(this.zc.text)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center);
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.bg);
  }

  @Builder
  tabBarItem(tab: TabSpec) {
    Column({ space: 2 }) {
      Image(tab.icon)
        .width(22)
        .height(22)
        .fillColor(this.activeTab === tab.key ? this.zc.text : this.zc.text3);
      Text(tab.label)
        .fontSize(10)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.activeTab === tab.key ? this.zc.text : this.zc.text3);
    }
    .width('100%')
    .height(56 + this.safeArea.bottom)
    .justifyContent(FlexAlign.Center)
    .padding({ bottom: this.safeArea.bottom });
  }
}
