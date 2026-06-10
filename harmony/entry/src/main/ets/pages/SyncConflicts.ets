// SyncConflicts —— 解决冲突（server 模式，全屏单条流）
//
// 与 phone/app/sync-conflicts.tsx 行为对齐：
//   - 连入端把检测到的冲突上报到本机，本机用户在此逐条决策：
//     用本机 / 用对端 / 两者都留 / 跳过
//   - 进场按 suggestedRemote 预选默认决策（建议→对端，否则本机）
//   - 全部决策完成后「应用全部」写本机 vault，对端轮询取走 action 列表
//
// 本页不碰网络：只消费 @ObservedV2 syncServer 单例的 @Trace pendingConflicts，
// 并调用 resolveConflict / applyMerge。敏感字段点按展开（禁 unicode，6 圆点遮罩）。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore } from '../state/VaultStore';
import { promptAction, router } from '@kit.ArkUI';
import { syncServer, SyncServer, ServerConflict, ConflictChoice } from '../lib/SyncServer';
import { ItemPayload } from '../lib/VaultService';

/** 字段展示项 —— ForEach 需稳定类型；用接口而非 tuple（与 ItemDetail VisibleField 同范式） */
interface FieldEntry {
  key: string;
  value: string;
}

const SENSITIVE_RE: RegExp = /password|secret|cvv|pin|token|apikey|seed|private|key/i;
const HIDDEN_KEYS: string[] = ['spaceId'];
const MASK_RANGE: number[] = [0, 1, 2, 3, 4, 5];

@Entry
@ComponentV2
struct SyncConflictsPage {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local server: SyncServer = syncServer;

  @Local index: number = 0;
  @Local applying: boolean = false;
  // 已展开的敏感字段，key 形如 `${side}:${fieldKey}`（同字段两侧各一份）
  @Local revealed: Record<string, boolean> = JSON.parse('{}') as Record<string, boolean>;

  private seeded: boolean = false;

  /* ---------------------------------------------------------------------- */
  /* 纯函数 / 标签映射                                                       */
  /* ---------------------------------------------------------------------- */

  private kindLabel(kind: string): string {
    if (kind === 'concurrent_edit') return '并发编辑';
    if (kind === 'divergent_content') return '内容分叉';
    if (kind === 'delete_vs_edit') return '一方删除一方修改';
    return kind;
  }

  private fieldLabel(k: string): string {
    switch (k) {
      case 'username': return '用户名';
      case 'password': return '密码';
      case 'url': return '网址';
      case 'notes': return '备注';
      case 'totp': return 'TOTP';
      case 'number': return '卡号';
      case 'cvv': return '安全码';
      case 'pin': return 'PIN';
      case 'expiry': return '有效期';
      case 'cardholder': return '持卡人';
      case 'email': return '邮箱';
      case 'phone': return '电话';
      case 'apiKey': return 'Token';
      case 'secret': return '密钥';
      case 'privateKey': return '私钥';
      case 'publicKey': return '公钥';
      case 'host': return '主机';
      case 'passport': return '护照号';
      default: return k;
    }
  }

  private isSensitive(k: string): boolean {
    return SENSITIVE_RE.test(k.toLowerCase());
  }

  private fmtTime(ms: number): string {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** payload.fields → 有序展示项：跳过隐藏键 / 空值，非字符串 JSON 化 */
  private fieldEntries(p: ItemPayload | null): FieldEntry[] {
    const out: FieldEntry[] = [];
    if (!p) return out;
    const fields = p.fields;
    for (const k of Object.keys(fields)) {
      if (HIDDEN_KEYS.indexOf(k) >= 0) continue;
      const raw: Object = fields[k];
      if (raw === null || raw === undefined) continue;
      const v: string = typeof raw === 'string' ? raw as string : JSON.stringify(raw);
      if (v === '') continue;
      out.push({ key: k, value: v });
    }
    return out;
  }

  /** 在另一侧字段集中找同名值，用于 diff 高亮 */
  private otherValue(other: FieldEntry[], k: string): string | undefined {
    for (const e of other) {
      if (e.key === k) return e.value;
    }
    return undefined;
  }

  /* ---------------------------------------------------------------------- */
  /* 派生状态                                                                */
  /* ---------------------------------------------------------------------- */

  @Computed
  get conflicts(): ServerConflict[] {
    return this.server.pendingConflicts;
  }

  @Computed
  get safeIndex(): number {
    return Math.min(this.index, Math.max(0, this.conflicts.length - 1));
  }

  @Computed
  get current(): ServerConflict | null {
    const a = this.conflicts;
    return a.length > 0 ? a[this.safeIndex] : null;
  }

  @Computed
  get allResolved(): boolean {
    const a = this.conflicts;
    return a.length > 0 && a.every((x: ServerConflict) => !!x.resolution);
  }

  @Computed
  get localNewer(): boolean {
    const c = this.current;
    if (!c) return true;
    return (c.localManifest.updatedAt ?? 0) >= (c.remoteManifest.updatedAt ?? 0);
  }

  @Computed
  get localEntries(): FieldEntry[] {
    const c = this.current;
    return this.fieldEntries(c ? c.local : null);
  }

  @Computed
  get remoteEntries(): FieldEntry[] {
    const c = this.current;
    return this.fieldEntries(c ? c.remote : null);
  }

  /* ---------------------------------------------------------------------- */
  /* 生命周期 —— 进场预选默认决策                                            */
  /* ---------------------------------------------------------------------- */

  aboutToAppear(): void {
    if (this.seeded || this.conflicts.length === 0) return;
    this.seeded = true;
    for (const c of this.conflicts) {
      if (!c.resolution) {
        this.server.resolveConflict(c.id, c.suggestedRemote ? 'remote' : 'local');
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 交互动作                                                                */
  /* ---------------------------------------------------------------------- */

  private onChoose(choice: ConflictChoice): void {
    const c = this.current;
    if (!c) return;
    this.server.resolveConflict(c.id, choice);
    // 自动跳到下一条未决（若有）
    const arr = this.conflicts;
    const start = this.safeIndex;
    for (let i = start + 1; i < arr.length; i++) {
      if (!arr[i].resolution) {
        this.index = i;
        break;
      }
    }
  }

  private onBulkRemote(): void {
    for (const c of this.conflicts) {
      this.server.resolveConflict(c.id, 'remote');
    }
  }

  private onPrev(): void {
    this.index = Math.max(0, this.safeIndex - 1);
  }

  private onNext(): void {
    this.index = Math.min(this.conflicts.length - 1, this.safeIndex + 1);
  }

  private toggleReveal(key: string): void {
    const next: Record<string, boolean> = JSON.parse('{}') as Record<string, boolean>;
    Object.keys(this.revealed).forEach((k: string) => {
      next[k] = this.revealed[k];
    });
    next[key] = !next[key];
    this.revealed = next;
  }

  private async onApply(): Promise<void> {
    this.applying = true;
    try {
      const n = await this.server.applyMerge();
      try {
        await vaultStore.refresh();
      } catch (_e) {
        // UI 刷新失败不影响合并结果
      }
      promptAction.showToast({ message: `已解决 · ${n} 项已应用，对端将自动收到`, duration: 2000 });
      router.back();
    } catch (e) {
      promptAction.showToast({ message: `无法应用 · ${(e instanceof Error ? e.message : String(e))}`, duration: 2500 });
      this.applying = false;
    }
  }

  private iconRes(name: string): Resource {
    switch (name) {
      case 'ic_check': return $r('app.media.ic_check');
      case 'ic_plus': return $r('app.media.ic_plus');
      case 'ic_minus': return $r('app.media.ic_minus');
      case 'ic_chevron_left': return $r('app.media.ic_chevron_left');
      case 'ic_chevron_right': return $r('app.media.ic_chevron_right');
      case 'ic_arrow_up_right': return $r('app.media.ic_arrow_up_right');
      default: return $r('app.media.ic_check');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* build                                                                   */
  /* ---------------------------------------------------------------------- */

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      this.navBar();

      if (!this.current) {
        this.emptyState();
      } else {
        Scroll() {
          Column({ space: ZSpacing.md }) {
            this.titleBlock();
            this.sideCard('local');
            this.sideCard('remote');
            this.choiceGrid();
            Row().height(120).width('100%');
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

        this.footerBar();
      }

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Start)
    .align(Alignment.TopStart)
    .backgroundColor(this.zc.bg);
  }

  @Builder
  navBar() {
    Row({ space: ZSpacing.sm }) {
      Row() {
        Image($r('app.media.ic_chevron_left'))
          .width(20)
          .height(20)
          .fillColor(this.zc.text2);
      }
      .width(36)
      .height(36)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => router.back());

      Text(this.conflicts.length > 0
        ? `解决冲突  ${this.safeIndex + 1} / ${this.conflicts.length}`
        : '解决冲突')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text)
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });

      Row().width(36);
    }
    .width('100%')
    .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: ZSpacing.xs, bottom: ZSpacing.xs });
  }

  @Builder
  emptyState() {
    Column({ space: ZSpacing.md }) {
      Image($r('app.media.ic_check_circle'))
        .width(40)
        .height(40)
        .fillColor(this.zc.ok);
      Text('没有待解决的冲突')
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.text3);
    }
    .layoutWeight(1)
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center);
  }

  @Builder
  titleBlock() {
    Column({ space: 2 }) {
      Text(this.current!.local?.name ?? this.current!.remote?.name ?? this.current!.id)
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
      Text(this.kindLabel(this.current!.kind))
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text3);
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .margin({ top: ZSpacing.xs });
  }

  @Builder
  sideCard(side: string) {
    Column({ space: 4 }) {
      // 头部：标签 + 徽标
      Row() {
        Text(side === 'local' ? '本机（此设备）' : '对端（连入设备）')
          .fontSize(ZType.headlineSize)
          .fontColor(this.zc.text2)
          .layoutWeight(1);
        Row({ space: ZSpacing.xs }) {
          if (side === 'remote' && this.current!.suggestedRemote) {
            this.badge('建议', 'info', false);
          }
          if (side === 'local' ? this.localNewer : !this.localNewer) {
            this.badge('较新', 'ok', true);
          }
        }
      }
      .width('100%');

      Text('更新于 ' + this.fmtTime(
        side === 'local'
          ? (this.current!.localManifest.updatedAt ?? 0)
          : (this.current!.remoteManifest.updatedAt ?? 0)))
        .fontSize(ZType.captionSize)
        .fontColor(this.zc.text3)
        .fontFamily('HarmonyOS Sans Condensed');

      // 主体
      if (!(side === 'local' ? this.current!.local : this.current!.remote)) {
        Text('（已删除）')
          .fontSize(ZType.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.danger)
          .margin({ top: ZSpacing.xs });
      } else if ((side === 'local' ? this.localEntries : this.remoteEntries).length === 0) {
        Text('（无可显示字段）')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text3)
          .margin({ top: ZSpacing.xs });
      } else {
        Column({ space: ZSpacing.sm }) {
          ForEach(
            side === 'local' ? this.localEntries : this.remoteEntries,
            (e: FieldEntry) => {
              this.fieldRow(side, e.key, e.value, side === 'local' ? this.remoteEntries : this.localEntries);
            },
            (e: FieldEntry) => e.key,
          );
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .margin({ top: ZSpacing.xs });
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  @Builder
  fieldRow(side: string, k: string, v: string, other: FieldEntry[]) {
    Row({ space: ZSpacing.sm }) {
      Text(this.fieldLabel(k))
        .width(64)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.otherValue(other, k) !== v ? this.zc.warn : this.zc.text3)
        .textCase(TextCase.UpperCase)
        .letterSpacing(0.3)
        .textAlign(TextAlign.Start);
      Column() {
        this.maskedValue(side, k, v);
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start);
    }
    .width('100%')
    .alignItems(VerticalAlign.Top);
  }

  @Builder
  maskedValue(side: string, k: string, v: string) {
    Row() {
      if (!this.isSensitive(k) || this.revealed[`${side}:${k}`]) {
        Text(v)
          .fontSize(ZType.subheadSize)
          .fontColor(this.zc.text)
          .fontFamily(this.isSensitive(k) ? 'HarmonyOS Sans Condensed' : 'HarmonyOS Sans')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1);
      } else {
        Row({ space: 4 }) {
          ForEach(MASK_RANGE, (_v: number, i: number) => {
            Row()
              .width(6)
              .height(6)
              .borderRadius(3)
              .backgroundColor(this.zc.text3);
          }, (_v: number, i: number) => i.toString());
        }
        .height(16)
        .layoutWeight(1)
        .alignItems(VerticalAlign.Center);
      }
    }
    .width('100%')
    .onClick(() => {
      if (this.isSensitive(k)) this.toggleReveal(`${side}:${k}`);
    });
  }

  @Builder
  badge(label: string, tone: string, withIcon: boolean) {
    Row({ space: 2 }) {
      if (withIcon) {
        Image(this.iconRes('ic_arrow_up_right'))
          .width(10)
          .height(10)
          .fillColor(tone === 'ok' ? this.zc.ok : this.zc.info);
      }
      Text(label)
        .fontSize(ZType.captionSize)
        .fontWeight(FontWeight.Medium)
        .fontColor(tone === 'info' ? this.zc.info : this.zc.okText);
    }
    .padding({ left: ZSpacing.xs, right: ZSpacing.xs, top: 2, bottom: 2 })
    .borderRadius(ZRadius.sm)
    .backgroundColor(alpha1f(tone === 'info' ? this.zc.info : this.zc.ok))
    .alignItems(VerticalAlign.Center);
  }

  @Builder
  choiceGrid() {
    Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.SpaceBetween }) {
      this.choiceBtn('用本机', 'ic_check', this.current!.resolution === 'local', () => this.onChoose('local'));
      this.choiceBtn(
        this.current!.suggestedRemote ? '用对端 · 建议' : '用对端',
        'ic_check',
        this.current!.resolution === 'remote',
        () => this.onChoose('remote'),
      );
      this.choiceBtn('两者都留', 'ic_plus', this.current!.resolution === 'duplicate', () => this.onChoose('duplicate'));
      this.choiceBtn('跳过', 'ic_minus', this.current!.resolution === 'skip', () => this.onChoose('skip'));
    }
    .width('100%')
    .margin({ top: ZSpacing.xs });
  }

  @Builder
  choiceBtn(label: string, iconName: string, active: boolean, cb: () => void) {
    Row({ space: ZSpacing.xs }) {
      if (active) {
        Image(this.iconRes(iconName))
          .width(15)
          .height(15)
          .fillColor(this.zc.accentInk);
      }
      Text(label)
        .fontSize(ZType.bodySize)
        .fontWeight(FontWeight.Medium)
        .fontColor(active ? this.zc.accentInk : this.zc.text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
    }
    .width('47%')
    .height(48)
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .borderRadius(ZRadius.lg)
    .backgroundColor(active ? this.zc.accent : this.zc.bgElev)
    .margin({ bottom: ZSpacing.sm })
    .onClick(cb);
  }

  @Builder
  footerBar() {
    Column({ space: ZSpacing.sm }) {
      Row() {
        Text('全部用对端')
          .fontSize(ZType.subheadSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.info)
          .onClick(() => this.onBulkRemote());

        Row({ space: ZSpacing.sm }) {
          this.pagerBtn('ic_chevron_left', this.safeIndex === 0, () => this.onPrev());
          Text(`${this.safeIndex + 1}/${this.conflicts.length}`)
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3)
            .fontFamily('HarmonyOS Sans Condensed');
          this.pagerBtn('ic_chevron_right', this.safeIndex >= this.conflicts.length - 1, () => this.onNext());
        }
        .alignItems(VerticalAlign.Center);
      }
      .width('100%')
      .justifyContent(FlexAlign.SpaceBetween)
      .alignItems(VerticalAlign.Center);

      Text(this.applying ? '应用中…' : '应用全部')
        .width('100%')
        .height(52)
        .borderRadius(ZRadius.lg)
        .textAlign(TextAlign.Center)
        .fontSize(ZType.headlineSize)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.zc.accentInk)
        .backgroundColor(this.zc.accent)
        .opacity((!this.allResolved || this.applying) ? 0.4 : 1)
        .enabled(this.allResolved && !this.applying)
        .onClick(() => this.onApply());
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.sm, bottom: ZSpacing.md })
    .backgroundColor(this.zc.bg)
    .border({ width: { top: 0.5 }, color: { top: this.zc.lineSoft } });
  }

  @Builder
  pagerBtn(iconName: string, disabled: boolean, cb: () => void) {
    Column() {
      Image(this.iconRes(iconName))
        .width(16)
        .height(16)
        .fillColor(disabled ? this.zc.text4 : this.zc.text2);
    }
    .width(32)
    .height(32)
    .borderRadius(ZRadius.md)
    .backgroundColor(this.zc.bgActive)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .opacity(disabled ? 0.4 : 1)
    .enabled(!disabled)
    .onClick(cb);
  }
}
