// ZPass HarmonyOS —— 应用入口路由
//
// 根据全局 vault 状态切换三种顶级界面：
//   1. 未初始化 → OnboardingOverlay（设置主密码）
//   2. 已初始化未解锁 → LockOverlay（输入主密码 / 信任设备解锁）
//   3. 已解锁 → 4 Tab 主界面（密码库 / 生成器 / 安全 / 我的）
//
// 与 phone/app/_layout.tsx 的路由守卫逻辑等价。
//
// 本文件保持轻量；具体页面在 ../views/* 实现。

import { ZColors, ZColorsClass } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { VaultTab } from '../views/VaultTab';
import { GeneratorTab } from '../views/GeneratorTab';
import { SecurityTab } from '../views/SecurityTab';
import { MeTab } from '../views/MeTab';
import { LockOverlay } from '../views/LockOverlay';
import { OnboardingOverlay } from '../views/OnboardingOverlay';

interface TabSpec {
  key: string;
  label: string;
  glyph: string;
}

const TABS: TabSpec[] = [
  { key: 'vault', label: '密码库', glyph: 'V' },
  { key: 'generator', label: '生成器', glyph: 'G' },
  { key: 'security', label: '安全', glyph: 'S' },
  { key: 'me', label: '我的', glyph: 'M' },
];

@Entry
@ComponentV2
struct Index {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;
  @Local activeTab: string = 'vault';

  aboutToAppear(): void {
    // 启动时刷新一次状态；之后由各 Tab / Overlay 自己驱动 refresh
    this.store.refresh();
  }

  private currentTabIndex(): number {
    const i = TABS.findIndex((t) => t.key === this.activeTab);
    return i < 0 ? 0 : i;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column() {
        if (!this.store.status.initialized) {
          // 未初始化 —— 设置主密码
          OnboardingOverlay();
        } else if (!this.store.status.unlocked) {
          // 已初始化未解锁 —— 锁屏
          LockOverlay();
        } else {
          // 已解锁 —— 4 Tab
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
          .scrollable(false)
          .animationDuration(0)
          .onChange((idx: number) => {
            if (idx >= 0 && idx < TABS.length) {
              this.activeTab = TABS[idx].key;
            }
          })
          .width('100%')
          .height('100%');
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

  @Builder
  tabBarItem(tab: TabSpec) {
    Column({ space: 2 }) {
      Text(tab.glyph)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.activeTab === tab.key ? this.zc.text : this.zc.text3);
      Text(tab.label)
        .fontSize(11)
        .fontColor(this.activeTab === tab.key ? this.zc.text : this.zc.text3);
    }
    .width('100%')
    .height(56 + this.safeArea.bottom)
    .justifyContent(FlexAlign.Center)
    .padding({ bottom: this.safeArea.bottom });
  }
}
