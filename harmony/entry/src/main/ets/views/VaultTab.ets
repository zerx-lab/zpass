// VaultTab —— 密码库主屏
//
// 与 phone/(tabs)/vault.tsx 对齐：顶部空间切换 + 搜索 + 类型筛选 + item 列表
//
// 数据源：state/VaultStore.ets 的全局单例 vaultStore。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, type VaultStore, type VaultFilterType } from '../state/VaultStore';
import type { ItemPayload } from '../lib/VaultService';
import { faviconColor, faviconInitials, relativeTime, typeLabel } from '../lib/Format';
import { router } from '@kit.ArkUI';
import { deriveGlyph } from '../lib/Spaces';
import type { Space } from '../lib/Spaces';

interface FilterChip {
  key: VaultFilterType;
  label: string;
}

const FILTER_CHIPS: FilterChip[] = [
  { key: 'all', label: '全部' },
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

  /** 顶部空间面板是否展开 */
  @Local showSpacePicker: boolean = false;

  aboutToAppear(): void {
    // 进入页面时刷新一次；解锁后 store 的状态可能已 ready
    this.store.refresh();
  }

  private activeSpaceName(): string {
    const id = this.store.activeSpaceId;
    if (!id) return '默认';
    return this.store.spaces.find((s) => s.id === id)?.name ?? '默认';
  }

  private async onTapItem(item: ItemPayload): Promise<void> {
    // 跳转 item 详情；param 通过 router 传 id
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

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // ── 顶栏：空间选择 + 项数 + 新建 ──
      Row({ space: ZSpacing.sm }) {
        // 空间头像 + 名字（点击展开切换）
        Row({ space: ZSpacing.sm }) {
          Column() {
            Text(deriveGlyph(this.activeSpaceName()))
              .fontSize(14)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.zc.text);
          }
          .width(28)
          .height(28)
          .borderRadius(14)
          .backgroundColor(this.zc.bgElev)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center);

          Column({ space: 2 }) {
            Text(this.activeSpaceName())
              .fontSize(ZType.title2Size)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.zc.text);
            Text(`${this.store.items.length} 项`)
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3);
          }
          .alignItems(HorizontalAlign.Start);
        }
        .layoutWeight(1)
        .onClick(() => {
          this.showSpacePicker = !this.showSpacePicker;
        });

        // 新建按钮
        Text('＋')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .width(36)
          .height(36)
          .textAlign(TextAlign.Center)
          .borderRadius(18)
          .backgroundColor(this.zc.bgElev)
          .onClick(() => this.onTapNew());
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
      Row({ space: ZSpacing.sm }) {
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
      .borderRadius(ZRadius.lg)
      .margin({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.xs,
        bottom: ZSpacing.xs,
      });

      // ── 类型筛选 chip ──
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
        List({ space: 1 }) {
          ForEach(this.store.filteredItems, (it: ItemPayload) => {
            ListItem() {
              this.itemRow(it);
            }
            .onClick(() => this.onTapItem(it));
          }, (it: ItemPayload) => it.id);
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .divider({ strokeWidth: 0.5, color: this.zc.lineSoft });
      }
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Start)
    .align(Alignment.TopStart)
    .backgroundColor(this.zc.bg)
    .padding({ bottom: this.safeArea.keyboard });
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
      .fontColor(this.store.filterType === chip.key ? this.zc.accentInk : this.zc.text2)
      .backgroundColor(this.store.filterType === chip.key ? this.zc.accent : this.zc.bgElev)
      .borderRadius(ZRadius.md)
      .padding({
        left: ZSpacing.md,
        right: ZSpacing.md,
        top: ZSpacing.xs + 2,
        bottom: ZSpacing.xs + 2,
      })
      .onClick(() => {
        this.store.filterType = chip.key;
      });
  }

  @Builder
  itemRow(item: ItemPayload) {
    Row({ space: ZSpacing.md }) {
      // 字形 favicon
      Column() {
        Text(faviconInitials(item.name))
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.faviconInk);
      }
      .width(40)
      .height(40)
      .borderRadius(ZRadius.lg)
      .backgroundColor(faviconColor(item.name))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center);

      Column({ space: 2 }) {
        Row() {
          Text(item.name)
            .fontSize(ZType.bodySize)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.zc.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1);
          Text(relativeTime(item.updatedAt))
            .fontSize(ZType.captionSize)
            .fontColor(this.zc.text3);
        }
        .width('100%');

        Text(this.getSubtitle(item))
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .backgroundColor(this.zc.bg);
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
        return '•••• ' + n.replace(/\s/g, '').slice(-4);
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

  @Builder
  emptyState() {
    Column({ space: ZSpacing.sm }) {
      Column() {
        Text('K')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text3);
      }
      .width(56)
      .height(56)
      .borderRadius(ZRadius.xl)
      .backgroundColor(this.zc.bgElev)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .margin({ bottom: ZSpacing.sm });

      Text(this.store.items.length === 0 ? '保险库为空' : '没有匹配的条目')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text);
      Text(this.store.items.length === 0 ? '点击右上角 + 创建第一个条目' : '调整搜索或筛选条件')
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
