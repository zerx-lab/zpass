// VaultList —— 通用筛选条目列表页
//
// 仪表盘首页(VaultTab)各入口跳转到此，按 scope 展示对应条目集合。
// 路由参数：{ scope: ScopeKind, value?: string, title: string }
//   scope='all'   全部条目
//   scope='fav'   收藏
//   scope='type'  指定类型(value=VaultItemType)
//   scope='space' 指定空间(value=spaceId)
//   （scope='totp' 用独立的 Authenticator 页，不走这里）
//
// 列表内容 = store.scopedItems(scope, value, query)，与首页卡片计数同口径。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, type VaultStore, type ScopeKind } from '../state/VaultStore';
import type { ItemPayload } from '../lib/VaultService';
import { ItemRow } from '../components/ItemRow';
import { promptAction, router } from '@kit.ArkUI';

@Entry
@ComponentV2
struct VaultList {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local scope: ScopeKind = 'all';
  @Local value: string = '';
  @Local title: string = '全部项目';
  @Local query: string = '';
  /** 进入即聚焦搜索框（来自首页搜索 FAB 的 focus 参数） */
  @Local autoFocus: boolean = false;

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object> | null;
    if (params) {
      const s = params.scope;
      if (typeof s === 'string') this.scope = s as ScopeKind;
      const v = params.value;
      if (typeof v === 'string') this.value = v;
      const t = params.title;
      if (typeof t === 'string') this.title = t;
      const focus = params.focus;
      if (typeof focus === 'string' && focus === '1') this.autoFocus = true;
    }
    this.store.refresh();
  }

  onPageShow(): void {
    // 从详情 / 编辑页返回后刷新，反映改动
    this.store.refreshItems();
  }

  // 直接读 this.store.items（@Trace）建立订阅，items 变化（增删/收藏/刷新）即重算重渲
  @Computed
  get rows(): ItemPayload[] {
    const items = this.store.items;
    const q = this.query.trim().toLowerCase();
    return items.filter((it) => {
      if (!this.store.matchesScope(it, this.scope, this.value)) return false;
      if (q.length > 0 && !this.haystack(it).includes(q)) return false;
      return true;
    });
  }

  private haystack(it: ItemPayload): string {
    const parts: string[] = [it.name];
    const f = it.fields;
    const keys: string[] = ['username', 'email', 'url', 'rpId', 'issuer', 'account', 'first', 'last'];
    for (const k of keys) {
      const v = f[k];
      if (typeof v === 'string') parts.push(v);
    }
    return parts.join(' ').toLowerCase();
  }

  private async onTapItem(item: ItemPayload): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/ItemDetail', params: { id: item.id } });
    } catch (_e) {
      // 路由未注册时忽略
    }
  }

  private async onTapNew(): Promise<void> {
    try {
      if (this.scope === 'type' && this.value) {
        await router.pushUrl({ url: 'pages/ItemEdit', params: { mode: 'create', type: this.value } });
      } else {
        await router.pushUrl({ url: 'pages/ItemEdit', params: { mode: 'create' } });
      }
    } catch (_e) {
      // 静默忽略
    }
  }

  private async onEditItem(item: ItemPayload): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/ItemEdit', params: { mode: 'edit', id: item.id } });
    } catch (_e) {
      // 静默忽略
    }
  }

  private async onToggleFavorite(item: ItemPayload): Promise<void> {
    // 取翻转前的状态，用于提示文案（已收藏 / 已取消收藏）
    const willFavorite = !this.isFavorite(item);
    try {
      await this.store.toggleFavorite(item.id);
      promptAction.showToast({
        message: willFavorite ? '已收藏' : '已取消收藏',
        duration: 1200,
      });
    } catch (e) {
      promptAction.showToast({ message: (e as Error).message, duration: 1500 });
    }
  }

  private async onDeleteItem(item: ItemPayload): Promise<void> {
    const r = await promptAction.showDialog({
      title: '删除条目',
      message: `确认删除「${item.name}」？可在回收站恢复。`,
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

  build() {
    Stack({ alignContent: Alignment.BottomEnd }) {
      Column() {
        Row().height(this.safeArea.top).width('100%');

        // ── 顶栏：返回 + 标题 + 新建 ──
        Row() {
          Column() {
            Image($r('app.media.ic_chevron_left'))
              .width(20)
              .height(20)
              .fillColor(this.zc.text2);
          }
          .width(36)
          .height(36)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => router.back());

          Text(this.title)
            .fontSize(ZType.titleSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text)
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ left: ZSpacing.xs });

          Column() {
            Image($r('app.media.ic_plus'))
              .width(20)
              .height(20)
              .fillColor(this.zc.text2);
          }
          .width(36)
          .height(36)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => this.onTapNew());
        }
        .width('100%')
        .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: ZSpacing.xs, bottom: ZSpacing.sm })
        .alignItems(VerticalAlign.Center);

        // ── 搜索 ──
        Column() {
          Row({ space: ZSpacing.sm }) {
            Image($r('app.media.ic_search'))
              .width(16)
              .height(16)
              .fillColor(this.zc.text3);
            TextInput({ placeholder: '搜索', text: this.query })
              .placeholderColor(this.zc.text3)
              .placeholderFont({ size: ZType.bodySize })
              .fontColor(this.zc.text)
              .fontSize(ZType.bodySize)
              .backgroundColor('#00000000')
              .borderRadius(0)
              .padding(0)
              .layoutWeight(1)
              .defaultFocus(this.autoFocus)
              .onChange((v: string) => {
                this.query = v;
              });
          }
          .width('100%')
          .height(38)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.lg);
        }
        .width('100%')
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.xs, bottom: ZSpacing.sm });

        // ── 列表 / 空状态 ──
        if (this.rows.length === 0) {
          this.emptyState();
        } else {
          Column() {
            List({ space: 0 }) {
              ForEach(this.rows, (it: ItemPayload, idx: number) => {
                ListItem() {
                  Column() {
                    ItemRow({ item: it });
                    if (idx < this.rows.length - 1) {
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

              ListItem() {
                Row().height(ZSpacing.xl + 8 + this.safeArea.bottom).width('100%');
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
      .padding({ bottom: this.safeArea.keyboard })
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);

      // 新建 FAB
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
      .margin({ right: ZSpacing.xl, bottom: ZSpacing.xl + this.safeArea.bottom })
      .onClick(() => this.onTapNew());
    }
    .width('100%')
    .height('100%');
  }

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

      Text(this.query.trim() !== '' ? '无匹配项' : '这里还没有条目')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text(this.query.trim() !== '' ? '调整搜索条件' : '点击右下角按钮新建条目')
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3);
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Center)
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl, top: ZSpacing.xxxl });
  }
}
