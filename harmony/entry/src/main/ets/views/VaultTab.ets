// VaultTab —— 密码库主屏（仪表盘 / 启动器式首页）
//
// 重构（参考用户提供的分类启动器布局）：首页不再是「chip 筛选 + 平铺列表」，
// 而是分区入口看板，点击各入口跳到 pages/VaultList 对应筛选列表 /
// pages/Authenticator 验证器实时码页 / pages/Trash 回收站。
//
// 结构：
//   顶栏：密码库标题 + 同步 / 锁定 / 新建 图标按钮
//   全部项目 大卡（总数）
//   验证器 / 收藏 并排卡
//   文件夹 分区（spaces，映射现有空间；管理在「我的 → 空间」）
//   类型 分区（有数量的类型分组卡）
//   回收站 卡
//   右下角搜索 FAB（握姿自适应，跳全部项目列表搜索）
//
// 计数与列表共用 store.countScope / scopedItems 同一谓词，口径一致。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import { motionStore, MotionStore } from '../state/MotionStore';
import { itemHasTotp, type VaultItemType } from '../lib/VaultService';
import { DEFAULT_SPACE_ID, type Space } from '../lib/Spaces';
import { SpaceAvatar } from '../components/SpaceAvatar';
import { promptAction, router } from '@kit.ArkUI';

interface TypeSpec {
  type: VaultItemType;
  label: string;
  icon: Resource;
}

/** 首页各入口计数快照 —— 单个 @Computed 一次算全，随 store.items 变化重算 */
interface DashCounts {
  total: number;
  fav: number;
  totp: number;
  byType: Map<string, number>;
  bySpace: Map<string, number>;
}

// 类型分区候选（顺序对齐参考图）；'totp' 不在此，独立验证器卡承载
const TYPE_SPECS: TypeSpec[] = [
  { type: 'login', label: '登录', icon: $r('app.media.ic_lock') },
  { type: 'card', label: '支付卡', icon: $r('app.media.ic_credit_card') },
  { type: 'identity', label: '身份', icon: $r('app.media.ic_person') },
  { type: 'note', label: '安全笔记', icon: $r('app.media.ic_note_text') },
  { type: 'ssh', label: 'SSH Key', icon: $r('app.media.ic_terminal') },
  { type: 'passkey', label: '密钥', icon: $r('app.media.ic_key') },
];

@ComponentV2
export struct VaultTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;
  @Local ms: MotionStore = motionStore;

  aboutToAppear(): void {
    this.store.refresh();
    if (motionStore.gripEnabled) {
      motionStore.subscribe();
    }
  }

  aboutToDisappear(): void {
    motionStore.unsubscribe();
  }

  onPageShow(): void {
    this.store.refreshItems();
  }

  /* ---------------- 计数（反应式） ---------------- */

  // 直接在 getter 内读 this.store.items（@Trace）建立订阅；items 变化（刷新/同步/
  // 增删）即重算并触发依赖处重渲。计数与 VaultList 列表共用 store.matchesScope 口径。
  @Computed
  get counts(): DashCounts {
    const items = this.store.items;
    const byType = new Map<string, number>();
    const bySpace = new Map<string, number>();
    let fav = 0;
    let totp = 0;
    for (const it of items) {
      byType.set(it.type, (byType.get(it.type) ?? 0) + 1);
      const sid = it.fields.spaceId;
      const sp = typeof sid === 'string' && sid.length > 0 ? sid : DEFAULT_SPACE_ID;
      bySpace.set(sp, (bySpace.get(sp) ?? 0) + 1);
      if (it.fields.favorite === true) fav++;
      if (itemHasTotp(it)) totp++;
    }
    return { total: items.length, fav, totp, byType, bySpace };
  }

  /* ---------------- 导航 ---------------- */

  private async go(scope: string, value: string, title: string): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/VaultList', params: { scope, value, title } });
    } catch (_e) {
      // 路由未注册时忽略
    }
  }

  // 搜索 FAB：进全部项目并自动聚焦搜索框
  private async goSearch(): Promise<void> {
    try {
      await router.pushUrl({
        url: 'pages/VaultList',
        params: { scope: 'all', value: '', title: '全部项目', focus: '1' },
      });
    } catch (_e) {
      // 忽略
    }
  }

  private async goAuthenticator(): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/Authenticator' });
    } catch (_e) {
      // 忽略
    }
  }

  private async goTrash(): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/Trash' });
    } catch (_e) {
      // 忽略
    }
  }

  private async onTapNew(): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/ItemEdit', params: { mode: 'create' } });
    } catch (_e) {
      // 忽略
    }
  }

  private async onTapSync(): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/Sync' });
    } catch (_e) {
      // 忽略
    }
  }

  private onTapLock(): void {
    this.store.lock();
    promptAction.showToast({ message: '已锁定', duration: 1200 });
  }

  /* ---------------- 颜色 ---------------- */

  private colorForType(t: VaultItemType): string {
    if (t === 'identity') return this.zc.ok;
    if (t === 'note') return this.zc.warn;
    if (t === 'ssh') return this.zc.text2;
    return this.zc.info; // login / card / passkey
  }

  private visibleTypes(): TypeSpec[] {
    const c = this.counts;
    return TYPE_SPECS.filter((s) => (c.byType.get(s.type) ?? 0) > 0);
  }

  build() {
    Stack({ alignContent: (this.ms.gripEnabled && this.ms.holdingLeft) ? Alignment.BottomStart : Alignment.BottomEnd }) {
      Column() {
        Row().height(this.safeArea.top).width('100%');

        // ── 顶栏 ──
        Row({ space: ZSpacing.xs }) {
          Text('密码库')
            .fontSize(ZType.largeTitleSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text)
            .layoutWeight(1);

          this.topAction($r('app.media.ic_refresh'), () => this.onTapSync());
          this.topAction($r('app.media.ic_lock'), () => this.onTapLock());
          this.topAction($r('app.media.ic_plus'), () => this.onTapNew());
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.xs, bottom: ZSpacing.sm });

        // ── 滚动内容 ──
        Scroll() {
          Column({ space: ZSpacing.lg }) {
            // 全部项目 大卡
            this.bigCard(
              $r('app.media.ic_grid'),
              this.zc.info,
              '全部项目',
              () => `${this.counts.total} 个项目`,
              () => this.go('all', '', '全部项目'),
            );

            // 验证器 / 收藏 并排
            Row({ space: ZSpacing.md }) {
              this.dualCard(
                $r('app.media.ic_shield'),
                this.zc.text,
                '验证器',
                () => `${this.counts.totp} 个令牌`,
                () => this.goAuthenticator(),
              );
              this.dualCard(
                $r('app.media.ic_star'),
                this.zc.warn,
                '收藏',
                () => `${this.counts.fav} 项`,
                () => this.go('fav', '', '收藏'),
              );
            }
            .width('100%');

            // 空间 分区
            if (this.store.spaces.length > 0) {
              this.sectionTitle('空间');
              Column() {
                ForEach(this.store.spaces, (sp: Space, idx: number) => {
                  this.folderRow(sp, idx < this.store.spaces.length - 1);
                // key 编入 name：同 key 复用不重绘，重命名后行内名称需刷新
                }, (sp: Space) => `${sp.id}:${sp.name}`);
              }
              .width('100%')
              .backgroundColor(this.zc.bgElev)
              .borderRadius(ZRadius.xl)
              .clip(true);
            }

            // 类型 分区
            if (this.visibleTypes().length > 0) {
              this.sectionTitle('类型');
              Column() {
                ForEach(this.visibleTypes(), (s: TypeSpec, idx: number) => {
                  this.typeRow(s, idx < this.visibleTypes().length - 1);
                }, (s: TypeSpec) => s.type);
              }
              .width('100%')
              .backgroundColor(this.zc.bgElev)
              .borderRadius(ZRadius.xl)
              .clip(true);
            }

            // 回收站
            this.bigCard(
              $r('app.media.ic_trash'),
              this.zc.danger,
              '回收站',
              () => '已删除的条目',
              () => this.goTrash(),
            );

            Row().height(80 + ZSpacing.xl + this.safeArea.bottom).width('100%');
          }
          .width('100%')
          .constraintSize({ minHeight: '100%' })
          .justifyContent(FlexAlign.Start)
          .alignItems(HorizontalAlign.Start)
          .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
        }
        .scrollBar(BarState.Off)
        .layoutWeight(1)
        .width('100%')
        .align(Alignment.TopStart);
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Start)
      .alignItems(HorizontalAlign.Start)
      .align(Alignment.TopStart)
      .backgroundColor(this.zc.bg);

      // 搜索 FAB —— 握姿自适应
      Column() {
        Image($r('app.media.ic_search'))
          .width(22)
          .height(22)
          .fillColor(this.zc.accentInk);
      }
      .width(56)
      .height(56)
      .borderRadius(28)
      .backgroundColor(this.zc.accent)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin((this.ms.gripEnabled && this.ms.holdingLeft)
        ? { left: ZSpacing.xl, bottom: ZSpacing.xl + 8 + this.safeArea.bottom }
        : { right: ZSpacing.xl, bottom: ZSpacing.xl + 8 + this.safeArea.bottom })
      .onClick(() => this.goSearch());
    }
    .width('100%')
    .height('100%');
  }

  /* ---------------- Builders ---------------- */

  @Builder
  topAction(icon: Resource, onTap: () => void) {
    Column() {
      Image(icon)
        .width(18)
        .height(18)
        .fillColor(this.zc.text2);
    }
    .width(38)
    .height(38)
    .borderRadius(19)
    .backgroundColor(this.zc.bgElev)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .onClick(() => onTap());
  }

  // 圆形彩色图标
  @Builder
  iconCircle(icon: Resource, bg: string, size: number) {
    Column() {
      Image(icon)
        .width(Math.round(size * 0.5))
        .height(Math.round(size * 0.5))
        .fillColor('#ffffff');
    }
    .width(size)
    .height(size)
    .borderRadius(size / 2)
    .backgroundColor(bg)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .flexShrink(0);
  }

  // 整宽大卡（全部项目 / 回收站）
  // subtitle 取 getter 而非 string：在 @Builder 体内调用，使对 counts 的反应式读
  // 发生在 builder 渲染作用域内，items 异步加载完成后能正确刷新（by-value 形参不刷新）。
  @Builder
  bigCard(icon: Resource, iconBg: string, title: string, subtitle: () => string, onTap: () => void) {
    Row({ space: ZSpacing.md }) {
      this.iconCircle(icon, iconBg, 48);
      Column({ space: 3 }) {
        Text(title)
          .fontSize(ZType.headlineSize)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);
        Text(subtitle())
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Image($r('app.media.ic_chevron_right'))
        .width(18)
        .height(18)
        .fillColor(this.zc.text4);
    }
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .alignItems(VerticalAlign.Center)
    .onClick(() => onTap());
  }

  // 半宽卡（验证器 / 收藏）—— subtitle 同 bigCard 取 getter 以保证反应式刷新
  @Builder
  dualCard(icon: Resource, iconBg: string, title: string, subtitle: () => string, onTap: () => void) {
    Column({ space: ZSpacing.sm }) {
      this.iconCircle(icon, iconBg, 44);
      Column({ space: 2 }) {
        Text(title)
          .fontSize(ZType.headlineSize)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text);
        Text(subtitle())
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3);
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%');
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .onClick(() => onTap());
  }

  @Builder
  sectionTitle(title: string) {
    Text(title)
      .fontSize(ZType.subheadSize)
      .fontWeight(FontWeight.Medium)
      .fontColor(this.zc.text3)
      .margin({ top: ZSpacing.xs, left: ZSpacing.xs });
  }

  @Builder
  folderRow(sp: Space, withDivider: boolean) {
    Column() {
      Row({ space: ZSpacing.md }) {
        SpaceAvatar({
          avatarName: sp.name,
          avatarSize: 30,
          avatarBg: this.zc.info,
          avatarFg: '#ffffff',
          avatarFontSize: 14,
          avatarRadius: ZRadius.md,
        });
        Text(sp.name)
          .fontSize(ZType.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1);
        Text(`${this.counts.bySpace.get(sp.id) ?? 0}`)
          .fontSize(ZType.subheadSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed');
        Image($r('app.media.ic_chevron_right'))
          .width(16)
          .height(16)
          .fillColor(this.zc.text4);
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md });

      if (withDivider) {
        Divider()
          .strokeWidth(0.5)
          .color(this.zc.lineSoft)
          .margin({ left: ZSpacing.lg + 30 + ZSpacing.md, right: 0 });
      }
    }
    .width('100%')
    .onClick(() => this.go('space', sp.id, sp.name));
  }

  @Builder
  typeRow(s: TypeSpec, withDivider: boolean) {
    Column() {
      Row({ space: ZSpacing.md }) {
        Image(s.icon)
          .width(22)
          .height(22)
          .fillColor(this.colorForType(s.type))
          .flexShrink(0);
        Text(s.label)
          .fontSize(ZType.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.text)
          .layoutWeight(1);
        Text(`${this.counts.byType.get(s.type) ?? 0}`)
          .fontSize(ZType.subheadSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed');
        Image($r('app.media.ic_chevron_right'))
          .width(16)
          .height(16)
          .fillColor(this.zc.text4);
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md });

      if (withDivider) {
        Divider()
          .strokeWidth(0.5)
          .color(this.zc.lineSoft)
          .margin({ left: ZSpacing.lg + 22 + ZSpacing.md, right: 0 });
      }
    }
    .width('100%')
    .onClick(() => this.go('type', s.type, s.label));
  }
}
