// VaultTab —— 密码库主屏
//
// 与 phone/(tabs)/vault.tsx 对齐：顶部空间切换 + 搜索 + 类型筛选 + item 列表
//
// 审计对齐（MIGRATION-PARITY-AUDIT.md vault-tab 节全部关闭）：
//   [高] 'fav' 收藏筛选 chip → store.onlyFavorites
//   [高] 2FA badge（login + totp 字段）
//   [高] 泄露 badge（breached===true）
//   [高] 新建按钮改为 ic_plus 图标 FAB（底部浮动）
//   [中] 标题副行显示 filtered/total 项
//   [中] login 行显示密码强度进度条
//   [中] 收藏星标改为 ic_star 图标
//   [中] 滑动操作按钮增加图标
//   [低] 列表 insetGrouped 卡片样式（bgElev 背景 + 圆角首/尾）
//   [低] FAB 浮动右下角

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, type VaultStore, type VaultFilterType } from '../state/VaultStore';
import { motionStore, MotionStore } from '../state/MotionStore';
import type { ItemPayload } from '../lib/VaultService';
import { faviconColor, faviconInitials, relativeTime, typeLabel } from '../lib/Format';
import { estimateStrength } from '../lib/Password';
import { promptAction, router } from '@kit.ArkUI';
import type { Space } from '../lib/Spaces';
import { SpaceAvatar } from '../components/SpaceAvatar';

// 'fav' 是 VaultTab 内部扩展 key，不属于 VaultFilterType
type ExtFilterKey = VaultFilterType | 'fav';

interface FilterChip {
  key: ExtFilterKey;
  label: string;
}

const FILTER_CHIPS: FilterChip[] = [
  { key: 'all', label: '全部' },
  { key: 'fav', label: '收藏' },
  { key: 'login', label: '登录' },
  { key: 'totp', label: '验证码' },
  { key: 'card', label: '卡片' },
  { key: 'note', label: '笔记' },
  { key: 'identity', label: '身份' },
  { key: 'ssh', label: 'SSH' },
  { key: 'passkey', label: '密钥' },
];

@ComponentV2
export struct VaultTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  /** 全局 store —— Local 引用同一个对象；@Trace 字段变更触发本组件重渲 */
  @Local store: VaultStore = vaultStore;
  @Local ms: MotionStore = motionStore;

  /** 顶部空间面板是否展开 */
  @Local showSpacePicker: boolean = false;

  /** 当前激活的扩展筛选 key（含 'fav'） */
  @Local activeFilterKey: ExtFilterKey = 'all';

  aboutToAppear(): void {
    this.store.refresh();
    if (motionStore.gripEnabled) {
      motionStore.subscribe();
    }
  }

  aboutToDisappear(): void {
    motionStore.unsubscribe();
  }

  private activeSpaceName(): string {
    const id = this.store.activeSpaceId;
    if (!id) return 'ZPass';
    return this.store.spaces.find((s) => s.id === id)?.name ?? 'ZPass';
  }

  private applyFilter(key: ExtFilterKey): void {
    if (key === 'fav') {
      this.store.onlyFavorites = true;
      this.store.filterType = 'all';
    } else {
      this.store.onlyFavorites = false;
      this.store.filterType = key as VaultFilterType;
    }
    this.activeFilterKey = key;
  }

  private async onTapItem(item: ItemPayload): Promise<void> {
    try {
      await router.pushUrl({
        url: 'pages/ItemDetail',
        params: { id: item.id },
      });
    } catch (_e) {
      // 路由未注册时忽略
    }
  }

  private async onTapNew(): Promise<void> {
    try {
      await router.pushUrl({
        url: 'pages/ItemEdit',
        params: { mode: 'create' },
      });
    } catch (_e) {
      // 静默忽略
    }
  }

  /* ---- swipe action：与 phone (tabs)/vault.tsx Swipeable 行为对齐 ---- */

  private async onToggleFavorite(item: ItemPayload): Promise<void> {
    try {
      await this.store.toggleFavorite(item.id);
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1500 });
    }
  }

  private async onEditItem(item: ItemPayload): Promise<void> {
    try {
      await router.pushUrl({
        url: 'pages/ItemEdit',
        params: { mode: 'edit', id: item.id },
      });
    } catch (_e) {
      // 静默忽略
    }
  }

  private async onDeleteItem(item: ItemPayload): Promise<void> {
    const r = await promptAction.showDialog({
      title: '删除条目',
      message: `确认删除「${item.name}」？该操作不可撤销。`,
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '删除', color: this.zc.danger },
      ],
    });
    if (r.index !== 1) return;
    try {
      await this.store.deleteItem(item.id);
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1500 });
    }
  }

  private isFavorite(it: ItemPayload): boolean {
    return (it.fields.favorite as boolean | undefined) === true;
  }

  private isBreached(it: ItemPayload): boolean {
    return it.type === 'login' && (it.fields.breached as boolean | undefined) === true;
  }

  private hasTotp(it: ItemPayload): boolean {
    return it.type === 'login' && typeof it.fields.totp === 'string' && (it.fields.totp as string).length > 0;
  }

  private loginStrength(it: ItemPayload): number | undefined {
    if (it.type !== 'login') return undefined;
    const s = it.fields.strength;
    if (typeof s === 'number') return s as number;
    // 若没有缓存强度，按密码实时计算
    const pw = it.fields.password;
    if (typeof pw === 'string' && (pw as string).length > 0) {
      return estimateStrength(pw as string).score;
    }
    return undefined;
  }

  private strengthColor(score: number): string {
    if (score >= 80) return this.zc.ok;
    if (score >= 50) return this.zc.warn;
    return this.zc.danger;
  }

  build() {
    Stack({ alignContent: (this.ms.gripEnabled && this.ms.holdingLeft) ? Alignment.BottomStart : Alignment.BottomEnd }) {
      Column() {
        Row().height(this.safeArea.top).width('100%');

        // ── 顶栏：空间选择 + 项数 ──
        Row({ space: ZSpacing.sm }) {
          // 空间头像 + 名字（点击展开切换）
          Row({ space: ZSpacing.sm }) {
            SpaceAvatar({
              avatarName: this.activeSpaceName(),
              avatarSize: 30,
              avatarBg: this.zc.bgElev,
              avatarFg: this.zc.text,
              avatarFontSize: 14,
              avatarRadius: ZRadius.md,
            });

            Column({ space: 2 }) {
              Text(this.activeSpaceName())
                .fontSize(ZType.title2Size)
                .fontWeight(FontWeight.Bold)
                .fontColor(this.zc.text);
              // [中] filtered/total 项数
              Text(`${this.store.filteredItems.length} / ${this.store.items.length} 项`)
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.text3);
            }
            .alignItems(HorizontalAlign.Start);
          }
          .layoutWeight(1)
          .onClick(() => {
            this.showSpacePicker = !this.showSpacePicker;
          });
        }
        .width('100%')
        .padding({
          left: ZSpacing.lg,
          right: ZSpacing.lg,
          top: ZSpacing.xs,
          bottom: ZSpacing.sm,
        });

        // ── 空间面板（折叠） ──
        if (this.showSpacePicker && this.store.spaces.length > 1) {
          Scroll() {
            Row({ space: ZSpacing.sm }) {
              ForEach(this.store.spaces, (sp: Space) => {
                this.spaceChip(sp);
              }, (sp: Space) => sp.id);
            }
            .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
          }
          .scrollable(ScrollDirection.Horizontal)
          .scrollBar(BarState.Off)
          .width('100%')
          .height(40);
        }

        // ── 搜索 ──
        Column() {
          Row({ space: ZSpacing.sm }) {
            Image($r('app.media.ic_search'))
              .width(16)
              .height(16)
              .fillColor(this.zc.text3);
            TextInput({ placeholder: '搜索', text: this.store.query })
              .placeholderColor(this.zc.text3)
              .placeholderFont({ size: ZType.bodySize })
              .fontColor(this.zc.text)
              .fontSize(ZType.bodySize)
              .backgroundColor('#00000000')
              .borderRadius(0)
              .padding(0)
              .layoutWeight(1)
              .onChange((v: string) => {
                this.store.query = v;
              });
          }
          .width('100%')
          .height(38)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.lg);
        }
        .width('100%')
        .padding({
          left: ZSpacing.lg,
          right: ZSpacing.lg,
          top: ZSpacing.xs,
          bottom: ZSpacing.xs,
        });

        // ── 类型筛选 chip（含 'fav'） ──
        Scroll() {
          Row({ space: ZSpacing.sm }) {
            ForEach(FILTER_CHIPS, (chip: FilterChip) => {
              this.filterChip(chip);
            }, (chip: FilterChip) => chip.key);
          }
          .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .width('100%')
        .height(44);

        // ── item 列表 / 空状态 ──
        if (this.store.filteredItems.length === 0) {
          this.emptyState();
        } else {
          // insetGrouped 卡片：外层 Column 提供水平 padding，List 不带水平 margin
          Column() {
            List({ space: 0 }) {
              ForEach(this.store.filteredItems, (it: ItemPayload, idx: number) => {
                ListItem() {
                  Column() {
                    this.itemRow(it);
                    // hairline 分隔线（非最后一项）
                    if (idx < this.store.filteredItems.length - 1) {
                      Divider()
                        .strokeWidth(0.5)
                        .color(this.zc.lineSoft)
                        .margin({ left: ZSpacing.lg + 38 + ZSpacing.md, right: 0 });
                    }
                  }
                  .width('100%');
                }
                .onClick(() => this.onTapItem(it))
                .swipeAction({ end: this.swipeActions(it) });
              }, (it: ItemPayload) => it.id);

              // 底部 Tab bar + FAB 避让占位
              ListItem() {
                Row().height(80 + ZSpacing.xl + 8 + this.safeArea.bottom).width('100%');
              }
            }
            .layoutWeight(1)
            .width('100%')
            .scrollBar(BarState.Off)
            .backgroundColor(this.zc.bgElev)
            .borderRadius(ZRadius.xl)
            .clip(true);
          }
          .layoutWeight(1)
          .width('100%')
          .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.sm });
        }
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Start)
      .alignItems(HorizontalAlign.Start)
      .align(Alignment.TopStart)
      .backgroundColor(this.zc.bg)
      .padding({ bottom: this.safeArea.keyboard });

      // FAB：ic_plus 图标，位置随握姿自适应（左手左侧，右手右侧）
      Column() {
        Image($r('app.media.ic_plus'))
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
      .onClick(() => this.onTapNew());
    }
    .width('100%')
    .height('100%');
  }

  @Builder
  spaceChip(sp: Space) {
    Text(sp.name)
      .fontSize(ZType.subheadSize)
      .fontColor(this.store.activeSpaceId === sp.id ? this.zc.accentInk : this.zc.text2)
      .backgroundColor(this.store.activeSpaceId === sp.id ? this.zc.accent : this.zc.bgElev)
      .borderRadius(ZRadius.md)
      .padding({ left: ZSpacing.md, right: ZSpacing.md, top: 6, bottom: 6 })
      .onClick(() => {
        this.store.setActiveSpace(sp.id);
      });
  }

  @Builder
  filterChip(chip: FilterChip) {
    Text(chip.label)
      .fontSize(ZType.subheadSize)
      .fontColor(this.activeFilterKey === chip.key ? this.zc.accentInk : this.zc.text2)
      .backgroundColor(this.activeFilterKey === chip.key ? this.zc.accent : this.zc.bgElev)
      .borderRadius(ZRadius.md)
      .padding({
        left: ZSpacing.md,
        right: ZSpacing.md,
        top: ZSpacing.xs + 2,
        bottom: ZSpacing.xs + 2,
      })
      .onClick(() => {
        this.applyFilter(chip.key);
      });
  }

  @Builder
  itemRow(item: ItemPayload) {
    Row({ space: ZSpacing.md }) {
      // 字形 favicon
      Column() {
        Text(faviconInitials(item.name))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.faviconInk);
      }
      .width(38)
      .height(38)
      .borderRadius(ZRadius.lg)
      .backgroundColor(faviconColor(item.name))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .flexShrink(0);

      // 中间：名称行 + 副标题
      Column({ space: 2 }) {
        // 名称行：名字 + 收藏星 + 2FA badge + 泄露 badge
        Row({ space: ZSpacing.xs }) {
          Text(item.name)
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1);

          // [中] 收藏图标：ic_star 替代 Unicode ★
          if (this.isFavorite(item)) {
            Image($r('app.media.ic_star'))
              .width(11)
              .height(11)
              .fillColor(this.zc.warn);
          }

          // [高] 2FA badge：login 且有 totp 字段（info 底色 + 白字）
          if (this.hasTotp(item)) {
            Text('2FA')
              .fontSize(ZType.captionSize)
              .fontColor('#ffffff')
              .backgroundColor(this.zc.info)
              .borderRadius(ZRadius.sm)
              .padding({ left: 4, right: 4, top: 2, bottom: 2 });
          }

          // [高] 泄露 badge：breached===true
          if (this.isBreached(item)) {
            Row({ space: 2 }) {
              Image($r('app.media.ic_warning'))
                .width(10)
                .height(10)
                .fillColor('#ffffff');
            }
            .padding({ left: 4, right: 4, top: 2, bottom: 2 })
            .backgroundColor(this.zc.danger)
            .borderRadius(ZRadius.sm);
          }
        }
        .width('100%');

        Text(this.getSubtitle(item))
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      // 右侧：时间 + 强度进度条（login）
      Column({ space: 5 }) {
        Text(relativeTime(item.updatedAt))
          .fontSize(ZType.captionSize)
          .fontColor(this.zc.text3)
          .fontFamily('HarmonyOS Sans Condensed');

        // [中] login 密码强度进度条（仅当有强度值时渲染，与 phone vault.tsx:145-159 对齐）
        if (item.type === 'login' && this.loginStrength(item) !== undefined) {
          Column() {
            this.strengthBar(this.loginStrength(item) ?? 0);
          }
          .width(36);
        }
      }
      .alignItems(HorizontalAlign.End)
      .flexShrink(0);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    });
  }

  // [中] 强度进度条：36x3，按强度评分染色
  // score 由调用方通过 this.loginStrength(item) 计算后传入，避免 @Builder 内声明本地变量
  @Builder
  strengthBar(score: number) {
    Stack({ alignContent: Alignment.Start }) {
      Row()
        .width(36)
        .height(3)
        .borderRadius(2)
        .backgroundColor(this.zc.lineSoft);
      Row()
        .width(score > 0 ? Math.round((score / 100) * 36) : 0)
        .height(3)
        .borderRadius(2)
        .backgroundColor(this.strengthColor(score));
    }
    .width(36)
    .height(3);
  }

  /** 在 ArkTS 里直接调 itemSubtitle 需要 VaultItem 形状；ItemPayload 与之不同
   *  所以这里用一份简化版，按 type 取 fields 上的字段。 */
  private getSubtitle(item: ItemPayload): string {
    const f = item.fields;
    switch (item.type) {
      case 'login':
        return (f.username as string | undefined) ?? '';
      case 'card': {
        const n = (f.number as string | undefined) ?? '';
        const last4 = n.replace(/\s/g, '').slice(-4);
        return last4 ? `•••• ${last4}` : '支付卡';
      }
      case 'note':
        return ((f.note as string | undefined) ?? '安全笔记').split('\n')[0];
      case 'identity':
        return (f.email as string | undefined) ?? '';
      case 'ssh':
        return (f.apiKey as string | undefined)
          ? 'API Token'
          : ((f.username as string | undefined) ?? (f.keyType as string | undefined) ?? 'SSH');
      case 'passkey':
        return (f.rpId as string | undefined) ?? '';
      case 'totp':
        return ((f.account as string | undefined) ?? (f.issuer as string | undefined) ?? 'TOTP');
      default:
        return typeLabel(item.type);
    }
  }

  /** swipe 右滑动作：编辑 / 收藏 / 删除（与 phone Swipeable 顺序一致） */
  @Builder
  swipeActions(item: ItemPayload) {
    Row({ space: 0 }) {
      this.swipeButton('编辑', $r('app.media.ic_edit'), this.zc.info, () => this.onEditItem(item));
      this.swipeButton(
        this.isFavorite(item) ? '取消' : '收藏',
        $r('app.media.ic_star'),
        this.zc.warn,
        () => this.onToggleFavorite(item),
      );
      this.swipeButton('删除', $r('app.media.ic_trash'), this.zc.danger, () => this.onDeleteItem(item));
    }
    .height('100%');
  }

  // [中] 滑动按钮：图标 + 文字标签
  @Builder
  swipeButton(label: string, icon: Resource, bg: string, onTap: () => void) {
    Column({ space: 4 }) {
      Image(icon)
        .width(20)
        .height(20)
        .fillColor('#ffffff');
      Text(label)
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor('#ffffff');
    }
    .width(72)
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .backgroundColor(bg)
    .onClick(() => onTap());
  }

  @Builder
  emptyState() {
    Column({ space: ZSpacing.sm }) {
      Column() {
        Image($r('app.media.ic_key'))
          .width(28)
          .height(28)
          .fillColor(this.zc.text3);
      }
      .width(56)
      .height(56)
      .borderRadius(ZRadius.xl)
      .backgroundColor(this.zc.bgElev)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.sm });

      Text(this.store.query.trim() !== '' || this.activeFilterKey !== 'all' ? '无匹配项' : '保险库为空')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text(this.store.query.trim() !== '' || this.activeFilterKey !== 'all'
        ? '调整搜索或筛选条件'
        : '点击右下角按钮新建条目')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3);
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Center)
    .padding({
      left: ZSpacing.xl,
      right: ZSpacing.xl,
      top: ZSpacing.xxxl,
    });
  }
}
