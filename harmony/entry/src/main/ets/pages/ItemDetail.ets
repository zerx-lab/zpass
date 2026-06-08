// ItemDetail —— 条目详情页（只读视图）
//
// 路由参数：{ id: string }
//
// 与 phone/app/vault/[id].tsx 行为对齐：
//   - 顶栏：返回 / 收藏星 / 编辑（图标按钮）
//   - Hero：favicon + 大标题名 + 类型徽标
//   - 分组卡片字段（凭据 / 卡片信息 / ...），行间发丝分隔线
//   - 密码强度面板、实时 TOTP 验证码（倒计时进度条）、自定义字段、标签、备注
//   - 底部删除条目 + 最后修改时间
// 敏感字段默认遮蔽（6 个圆点，非 unicode），点眼睛 reveal；复制走 ephemeral。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore } from '../state/VaultStore';
import type { ItemPayload } from '../lib/VaultService';
import { typeLabel, relativeTime, faviconColor, faviconInitials } from '../lib/Format';
import { copyEphemeral, copyText } from '../lib/Clipboard';
import { generateTotp, formatTotpCode, totpRemaining, TOTP_PERIOD } from '../lib/Totp';
import { estimateStrength, strengthLabel, crackTime } from '../lib/Password';
import { parseCustomFields, CustomField } from '../lib/CustomFields';
import { floatingBall, promptAction, router } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

interface VisibleField {
  key: string;
  label: string;
  value: string;
  /** 是否敏感（默认遮蔽 + ephemeral copy） */
  sensitive: boolean;
  /** 等宽字体（密码 / 卡号 / 密钥 / 日期等） */
  mono: boolean;
  /** 多行显示（地址 / 公钥 / 指纹 / 笔记） */
  multiline: boolean;
}

function makeField(
  key: string,
  label: string,
  value: string,
  sensitive: boolean,
  mono: boolean,
  multiline: boolean,
): VisibleField {
  return { key, label, value, sensitive, mono, multiline };
}

@Entry
@ComponentV2
struct ItemDetail {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  @Local item: ItemPayload | null = null;
  @Local revealed: Record<string, boolean> = JSON.parse('{}') as Record<string, boolean>;
  @Local errorText: string = '';
  @Local routeId: string = '';

  /** 收藏态 —— 驱动顶栏星填充 */
  @Local isFavorite: boolean = false;

  /* ----- 实时 TOTP 状态 ----- */
  @Local totpCode: string = '';
  @Local totpRemainingSecs: number = TOTP_PERIOD;
  @Local totpUrgent: boolean = false;
  private totpTimerId: number = -1;

  /** 遮蔽圆点索引（避免在 build 内写数组字面量） */
  private maskRange: number[] = [0, 1, 2, 3, 4, 5];

  /** 悬浮球控制器（仅 login 类型且有密码时创建） */
  private fbCtrl: floatingBall.FloatingBallController | null = null;

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object> | null;
    if (params && typeof params.id === 'string') {
      this.routeId = params.id as string;
      this.load(this.routeId);
    }
  }

  onPageShow(): void {
    // 从编辑页 back 后刷新一次
    if (this.item) this.load(this.item.id);
  }

  aboutToDisappear(): void {
    this.stopTotpTicker();
    this.stopFloatingBall();
  }

  private startFloatingBall(password: string): void {
    if (!floatingBall.isFloatingBallEnabled()) return;
    if (this.fbCtrl) return;
    const preview = password.length > 10 ? password.substring(0, 10) + '...' : password;
    floatingBall.create({ context: getContext(this) })
      .then((ctrl: floatingBall.FloatingBallController) => {
        this.fbCtrl = ctrl;
        return ctrl.startFloatingBall({
          template: floatingBall.FloatingBallTemplate.EMPHATIC,
          title: preview,
          content: '复制密码',
          backgroundColor: '#FFFFFF',
        });
      })
      .then(() => {
        if (!this.fbCtrl) return;
        this.fbCtrl.on('click', (): void => {
          copyEphemeral(password).catch(() => {});
        });
      })
      .catch(() => {
        this.fbCtrl = null;
      });
  }

  private stopFloatingBall(): void {
    if (!this.fbCtrl) return;
    const ctrl = this.fbCtrl;
    this.fbCtrl = null;
    try {
      ctrl.off('click');
    } catch (_e) {}
    ctrl.stopFloatingBall().catch(() => {});
  }

  private async load(id: string): Promise<void> {
    try {
      const it = await vaultStore.getItem(id);
      if (!it) {
        this.item = null;
        this.errorText = '条目不存在';
        this.stopTotpTicker();
        return;
      }
      this.item = it;
      this.errorText = '';
      this.isFavorite = it.fields.favorite === true;
      this.maybeStartTotpTicker();
      // 首次加载 login 且有密码时启动悬浮球（onPageShow 再次调用时 fbCtrl 已存在，跳过）
      if (it.type === 'login' && !this.fbCtrl) {
        const pw = (it.fields.password as string | undefined) ?? '';
        if (pw.length > 0) {
          this.startFloatingBall(pw);
        }
      }
    } catch (e) {
      this.errorText = (e as Error).message;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* TOTP ticker                                                               */
  /* ------------------------------------------------------------------------ */

  private totpSecret(): string {
    const it = this.item;
    if (!it) return '';
    if (it.type === 'totp') {
      const s = it.fields.secret;
      return typeof s === 'string' ? s as string : '';
    }
    const t = it.fields.totp;
    return typeof t === 'string' ? t as string : '';
  }

  private maybeStartTotpTicker(): void {
    this.stopTotpTicker();
    if (this.totpSecret()) {
      this.startTotpTicker();
    }
  }

  private startTotpTicker(): void {
    const secret = this.totpSecret();
    const tick = (): void => {
      const r = totpRemaining();
      this.totpRemainingSecs = r;
      this.totpUrgent = r <= 5;
      this.totpCode = formatTotpCode(generateTotp(secret));
    };
    tick();
    this.totpTimerId = setInterval(tick, 1000);
  }

  private stopTotpTicker(): void {
    if (this.totpTimerId !== -1) {
      clearInterval(this.totpTimerId);
      this.totpTimerId = -1;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 字段构造                                                                  */
  /* ------------------------------------------------------------------------ */

  private fieldStr(k: string): string {
    const it = this.item;
    if (!it) return '';
    const v = it.fields[k];
    return typeof v === 'string' ? v as string : '';
  }

  /** 类型相关主字段（不含通用 notes / 自定义 / 标签） */
  private detailFieldsFor(it: ItemPayload): VisibleField[] {
    const out: VisibleField[] = [];
    const get = (k: string): string => {
      const v = it.fields[k];
      return typeof v === 'string' ? v as string : '';
    };
    const push = (k: string, label: string, sensitive: boolean, mono: boolean, multiline: boolean): void => {
      const v = get(k);
      if (v) out.push(makeField(k, label, v, sensitive, mono, multiline));
    };
    switch (it.type) {
      case 'login':
        push('username', '用户名', false, false, false);
        push('password', '密码', true, true, false);
        push('url', '网址', false, false, false);
        // totp 不作为明文字段：TotpSection 显示实时验证码
        break;
      case 'card':
        push('cardholder', '持卡人', false, false, false);
        push('number', '卡号', true, true, false);
        push('exp', '有效期', false, true, false);
        push('cvv', '安全码', true, true, false);
        push('pin', 'PIN', true, true, false);
        push('brand', '卡组织', false, false, false);
        break;
      case 'note':
        // 笔记内容单独渲染
        break;
      case 'identity':
        push('first', '名', false, false, false);
        push('last', '姓', false, false, false);
        push('email', '邮箱', false, false, false);
        push('phone', '电话', false, false, false);
        push('address', '地址', false, false, true);
        push('dob', '出生日期', false, true, false);
        push('passport', '护照号', true, true, false);
        break;
      case 'ssh':
        if (get('apiKey')) {
          push('apiKey', 'Token', true, true, false);
        } else {
          push('username', '用户', false, false, false);
          push('keyType', '算法', false, true, false);
          push('fingerprint', '指纹', false, true, true);
          push('publicKey', '公钥', false, true, true);
        }
        break;
      case 'passkey':
        push('rpId', '依赖方 (RP)', false, false, false);
        push('userName', '用户名', false, false, false);
        push('credentialId', '凭据 ID', true, true, false);
        break;
      case 'totp':
        push('issuer', '发行者', false, false, false);
        push('account', '账户', false, false, false);
        push('secret', 'TOTP 密钥', true, true, false);
        break;
    }
    return out;
  }

  /* ----- 派生 getter（供 build() 直接引用，避免 build 内 let/const） ----- */

  @Computed
  get sectionTitle(): string {
    const it = this.item;
    if (!it) return '';
    switch (it.type) {
      case 'login': return '凭据';
      case 'card': return '卡片信息';
      case 'note': return '笔记内容';
      case 'identity': return '身份信息';
      case 'ssh': return this.fieldStr('apiKey') ? 'API Token' : 'SSH 密钥';
      case 'passkey': return '通行密钥';
      case 'totp': return '验证器';
      default: return '';
    }
  }

  @Computed
  get detailFields(): VisibleField[] {
    return this.item ? this.detailFieldsFor(this.item) : [];
  }

  @Computed
  get loginPassword(): string {
    return this.item?.type === 'login' ? this.fieldStr('password') : '';
  }

  @Computed
  get itemName(): string {
    return this.item ? this.item.name : '';
  }

  @Computed
  get itemTypeLabel(): string {
    return this.item ? typeLabel(this.item.type) : '';
  }

  @Computed
  get itemUpdatedLabel(): string {
    return this.item ? relativeTime(this.item.updatedAt) : '';
  }

  @Computed
  get strengthScore(): number {
    const pw = this.loginPassword;
    return pw ? estimateStrength(pw).score : 0;
  }

  @Computed
  get strengthEntropy(): number {
    const pw = this.loginPassword;
    return pw ? estimateStrength(pw).entropy : 0;
  }

  @Computed
  get strengthColor(): string {
    const s = this.strengthScore;
    if (s >= 80) return this.zc.ok;
    if (s >= 50) return this.zc.warn;
    return this.zc.danger;
  }

  @Computed
  get parsedCustomFields(): CustomField[] {
    return this.item ? parseCustomFields(this.item.fields as Record<string, string>) : [];
  }

  @Computed
  get itemTags(): string[] {
    const it = this.item;
    if (!it) return [];
    const raw = it.fields.tags;
    if (Array.isArray(raw)) {
      return (raw as Object[]).map((t) => String(t)).filter((t) => !!t);
    }
    if (typeof raw === 'string' && raw) {
      return (raw as string).split(',').map((t) => t.trim()).filter((t) => !!t);
    }
    return [];
  }

  @Computed
  get itemNotes(): string {
    const it = this.item;
    if (!it) return '';
    const v = it.fields.notes;
    return typeof v === 'string' ? v as string : '';
  }

  @Computed
  get noteContent(): string {
    const it = this.item;
    if (!it || it.type !== 'note') return '';
    return this.fieldStr('note');
  }

  /* ------------------------------------------------------------------------ */
  /* 交互                                                                      */
  /* ------------------------------------------------------------------------ */

  private toggleReveal(key: string): void {
    const next: Record<string, boolean> = JSON.parse('{}') as Record<string, boolean>;
    Object.keys(this.revealed).forEach((k) => {
      next[k] = this.revealed[k];
    });
    next[key] = !next[key];
    this.revealed = next;
  }

  private async onCopyValue(value: string, sensitive: boolean): Promise<void> {
    try {
      if (sensitive) {
        await copyEphemeral(value);
        promptAction.showToast({ message: '已复制（30 秒后清空）', duration: 1500 });
      } else {
        await copyText(value);
        promptAction.showToast({ message: '已复制', duration: 1200 });
      }
    } catch (_e) {
      promptAction.showToast({ message: '复制失败', duration: 1200 });
    }
  }

  private async onToggleFavorite(): Promise<void> {
    const it = this.item;
    if (!it) return;
    const prev = this.isFavorite;
    this.isFavorite = !this.isFavorite;
    try {
      await vaultStore.toggleFavorite(it.id);
    } catch (e) {
      this.isFavorite = prev;
      promptAction.showToast({ message: '收藏失败：' + (e instanceof Error ? e.message : String(e)), duration: 2000 });
    }
  }

  private async onEdit(): Promise<void> {
    if (!this.item) return;
    await router.pushUrl({
      url: 'pages/ItemEdit',
      params: { mode: 'edit', id: this.item.id },
    });
  }

  private onDelete(): void {
    const it = this.item;
    if (!it) return;
    promptAction.showDialog({
      title: '删除条目',
      message: `确认删除「${it.name}」？此操作不可撤销。`,
      buttons: [
        { text: '取消', color: this.zc.text2 },
        { text: '删除', color: this.zc.danger },
      ],
    }).then((result) => {
      if (result.index === 1) {
        vaultStore.deleteItem(it.id).then(() => {
          router.back();
        }).catch((e: Object) => promptAction.showToast({ message: '删除失败：' + (e instanceof Error ? e.message : String(e)), duration: 2000 }));
      }
    });
  }

  /* ------------------------------------------------------------------------ */
  /* build                                                                     */
  /* ------------------------------------------------------------------------ */

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      this.navBar();

      Scroll() {
        Column({ space: 0 }) {
          if (this.item) {
            this.heroSection();
            this.bodySection();
            if (this.parsedCustomFields.length > 0) {
              this.customFieldsSection(this.parsedCustomFields);
            }
            if (this.itemTags.length > 0) {
              this.tagsSection(this.itemTags);
            }
            if (this.itemNotes) {
              this.notesSection(this.itemNotes);
            }
            this.deleteSection();
            this.footerSection();
          } else {
            this.errorView();
          }
          Row().height(40).width('100%');
        }
        .width('100%')
        .constraintSize({ minHeight: '100%' })
        .justifyContent(FlexAlign.Start)
        .alignItems(HorizontalAlign.Start);
      }
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart);

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Start)
    .alignItems(HorizontalAlign.Start)
    .align(Alignment.TopStart)
    .backgroundColor(this.zc.bg)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);
  }

  /* ----- 顶栏 ----- */

  @Builder
  navBar() {
    Row() {
      // 返回
      Row() {
        Image($r('app.media.ic_chevron_left'))
          .width(22)
          .height(22)
          .fillColor(this.zc.text2);
      }
      .width(44)
      .height(44)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => router.back());

      // 标题
      Text(this.item ? this.item.name : '未找到')
        .fontSize(ZType.title2Size)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text)
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });

      // 右侧：收藏 + 编辑（无 item 时占位平衡布局）
      if (this.item) {
        Row({ space: ZSpacing.xs }) {
          Row() {
            Image($r('app.media.ic_star'))
              .width(20)
              .height(20)
              .fillColor(this.isFavorite ? this.zc.warn : this.zc.text3);
          }
          .width(44)
          .height(44)
          .justifyContent(FlexAlign.Center)
          .alignItems(VerticalAlign.Center)
          .onClick(() => this.onToggleFavorite());

          Row() {
            Image($r('app.media.ic_edit'))
              .width(20)
              .height(20)
              .fillColor(this.zc.text2);
          }
          .width(44)
          .height(44)
          .justifyContent(FlexAlign.Center)
          .alignItems(VerticalAlign.Center)
          .onClick(() => this.onEdit());
        }
      } else {
        Row().width(44).height(44);
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: ZSpacing.xs, bottom: ZSpacing.xs });
  }

  /* ----- Hero ----- */

  @Builder
  heroSection() {
    Column({ space: ZSpacing.sm }) {
      Column() {
        Text(faviconInitials(this.itemName))
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.faviconInk);
      }
      .width(64)
      .height(64)
      .borderRadius(ZRadius.xl)
      .backgroundColor(faviconColor(this.itemName))
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center);

      Text(this.itemName)
        .fontSize(ZType.titleSize)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.zc.text)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.Center);

      Row() {
        Text(this.itemTypeLabel)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text2);
      }
      .padding({ left: ZSpacing.md, right: ZSpacing.md, top: 3, bottom: 3 })
      .backgroundColor(this.zc.bgActive)
      .borderRadius(ZRadius.md);
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
    .padding({ top: ZSpacing.xxxl, bottom: ZSpacing.xl });
  }

  /* ----- 主体（按类型分组） ----- */

  @Builder
  bodySection() {
    if (this.item?.type === 'note') {
      // 笔记内容直接整块文本
      this.sectionHeader('笔记内容');
      Column() {
        Text(this.noteContent)
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text)
          .lineHeight(22)
          .width('100%')
          .copyOption(CopyOptions.LocalDevice);
      }
      .width('100%')
      .padding(ZSpacing.lg)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
      this.sectionFooterPad();
    } else if (this.detailFields.length > 0) {
      this.sectionHeader(this.sectionTitle);
      this.fieldCard(this.detailFields);
      this.sectionFooterPad();
    }

    // login：密码强度 + 实时 TOTP
    if (this.item?.type === 'login') {
      if (this.loginPassword) {
        this.strengthSection();
      }
      if (this.totpSecret()) {
        this.totpSection();
      }
    }
    // totp：实时验证码
    if (this.item?.type === 'totp' && this.totpSecret()) {
      this.totpSection();
    }
  }

  /* ----- 分组卡片骨架 ----- */

  @Builder
  sectionHeader(title: string) {
    Text(title)
      .fontSize(ZType.footnoteSize)
      .fontColor(this.zc.text3)
      .textCase(TextCase.UpperCase)
      .letterSpacing(0.4)
      .width('100%')
      .padding({ left: ZSpacing.lg + ZSpacing.xs, bottom: ZSpacing.sm });
  }

  /** 段落之间的左右留白由各 section 自身 padding 处理；此处补底部间距 */
  @Builder
  sectionFooterPad() {
    Row().height(ZSpacing.lg).width('100%');
  }

  @Builder
  fieldCard(fields: VisibleField[]) {
    Column() {
      Column({ space: 0 }) {
        ForEach(fields, (f: VisibleField, idx: number) => {
          this.fieldRow(f, idx === fields.length - 1);
        }, (f: VisibleField) => f.key);
      }
      .width('100%')
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl)
      .clip(true);
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
  }

  /* ----- 遮蔽圆点（6 个，禁 unicode） ----- */

  @Builder
  maskDots() {
    Row({ space: 4 }) {
      ForEach(this.maskRange, (_v: number, i: number) => {
        Row()
          .width(6)
          .height(6)
          .borderRadius(3)
          .backgroundColor(this.zc.text3);
      }, (_v: number, i: number) => i.toString());
    }
    .height(16)
    .alignItems(VerticalAlign.Center);
  }

  /* ----- 字段行 ----- */

  @Builder
  fieldRow(field: VisibleField, isLast: boolean) {
    Column({ space: 0 }) {
      Row({ space: ZSpacing.sm }) {
        Column({ space: 4 }) {
          Text(field.label)
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3)
            .textCase(TextCase.UpperCase)
            .letterSpacing(0.4)
            .width('100%');
          if (field.sensitive && !this.revealed[field.key]) {
            this.maskDots();
          } else {
            Text(field.value)
              .fontSize(ZType.bodySize)
              .fontColor(this.zc.text)
              .fontFamily(field.sensitive || field.mono ? 'HarmonyOS Sans Condensed' : 'HarmonyOS Sans')
              .maxLines(field.multiline ? 6 : 1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
              .copyOption(CopyOptions.LocalDevice);
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start);

        Row({ space: ZSpacing.xs }) {
          if (field.sensitive) {
            this.iconButton(
              this.revealed[field.key] ? $r('app.media.ic_eye_off') : $r('app.media.ic_eye'),
              34,
              16,
              () => this.toggleReveal(field.key),
            );
          }
          this.iconButton($r('app.media.ic_copy'), 34, 16, () => this.onCopyValue(field.value, field.sensitive));
        }
      }
      .width('100%')
      .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md })
      .alignItems(VerticalAlign.Center);

      if (!isLast) {
        Divider()
          .color(this.zc.lineSoft)
          .strokeWidth(1)
          .margin({ left: ZSpacing.lg });
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  /** 圆形浅底图标按钮（接收已构造的 Resource，避免 $r(变量)） */
  @Builder
  iconButton(media: Resource, size: number, iconSize: number, onTap: () => void) {
    Column() {
      Image(media)
        .width(iconSize)
        .height(iconSize)
        .fillColor(this.zc.text2);
    }
    .width(size)
    .height(size)
    .borderRadius(size / 2)
    .backgroundColor(this.zc.bgActive)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .onClick(() => onTap());
  }

  /* ----- 密码强度 ----- */

  @Builder
  strengthSection() {
    Column() {
      this.sectionHeader('密码强度');
      Column({ space: ZSpacing.md }) {
        Row({ space: ZSpacing.xs }) {
          Text(this.strengthScore.toString())
            .fontSize(44)
            .fontWeight(FontWeight.Bold)
            .fontFamily('HarmonyOS Sans Condensed')
            .fontColor(this.strengthColor);
          Text('/100')
            .fontSize(16)
            .fontColor(this.zc.text3)
            .margin({ bottom: 6 });
          Text(strengthLabel(this.strengthScore))
            .fontSize(ZType.footnoteSize)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.strengthColor)
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .backgroundColor(this.zc.bgActive)
            .borderRadius(ZRadius.sm)
            .margin({ bottom: 6 });
        }
        .width('100%')
        .alignItems(VerticalAlign.Bottom);

        Stack({ alignContent: Alignment.Start }) {
          Row().width('100%').height(6).borderRadius(3).backgroundColor(this.zc.bgActive);
          Row()
            .width(`${this.strengthScore}%`)
            .height(6)
            .borderRadius(3)
            .backgroundColor(this.strengthColor);
        }
        .width('100%')
        .height(6);

        Row() {
          this.metaItem('长度', this.loginPassword.length.toString());
          Divider().vertical(true).height(28).color(this.zc.lineSoft);
          this.metaItem('熵值', `${this.strengthEntropy}b`);
          Divider().vertical(true).height(28).color(this.zc.lineSoft);
          this.metaItem('破解时间', crackTime(this.strengthScore));
        }
        .width('100%')
        .padding({ top: ZSpacing.sm });
      }
      .width('100%')
      .padding(ZSpacing.lg)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, bottom: ZSpacing.lg });
  }

  @Builder
  metaItem(label: string, value: string) {
    Column({ space: 2 }) {
      Text(label)
        .fontSize(ZType.captionSize)
        .fontColor(this.zc.text3)
        .textCase(TextCase.UpperCase)
        .letterSpacing(0.6);
      Text(value)
        .fontSize(ZType.subheadSize)
        .fontWeight(FontWeight.Bold)
        .fontFamily('HarmonyOS Sans Condensed')
        .fontColor(this.zc.text);
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Center);
  }

  /* ----- 实时 TOTP ----- */

  @Builder
  totpSection() {
    Column() {
      this.sectionHeader('TOTP 验证码');
      Row({ space: ZSpacing.md }) {
        Column({ space: 6 }) {
          Text(this.totpCode)
            .fontSize(32)
            .fontWeight(FontWeight.Bold)
            .fontFamily('HarmonyOS Sans Condensed')
            .letterSpacing(6)
            .fontColor(this.totpUrgent ? this.zc.danger : this.zc.text);

          Stack({ alignContent: Alignment.Start }) {
            Row().width('100%').height(4).borderRadius(2).backgroundColor(this.zc.bgActive);
            Row()
              .width(`${Math.round(this.totpRemainingSecs / TOTP_PERIOD * 100)}%`)
              .height(4)
              .borderRadius(2)
              .backgroundColor(this.totpUrgent ? this.zc.danger : this.zc.info)
              .animation({ duration: 900, curve: Curve.Linear });
          }
          .width('100%')
          .height(4);

          Text(`${this.totpRemainingSecs} 秒后刷新`)
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3);
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start);

        this.iconButton($r('app.media.ic_copy'), 44, 18, () => {
          copyEphemeral(this.totpCode.replace(' ', ''));
          promptAction.showToast({ message: '验证码已复制（30 秒后清空）', duration: 1500 });
        });
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding(ZSpacing.lg)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, bottom: ZSpacing.lg });
  }

  /* ----- 自定义字段 ----- */

  @Builder
  customFieldsSection(fields: CustomField[]) {
    Column() {
      this.sectionHeader('自定义字段');
      Column({ space: 0 }) {
        ForEach(fields, (cf: CustomField, idx: number) => {
          this.customFieldRow(cf, idx === fields.length - 1);
        }, (cf: CustomField) => cf.id);
      }
      .width('100%')
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl)
      .clip(true);
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, bottom: ZSpacing.lg });
  }

  @Builder
  customFieldRow(cf: CustomField, isLast: boolean) {
    Column({ space: 0 }) {
      if (cf.type === 'boolean') {
        Row({ space: ZSpacing.sm }) {
          Column({ space: 4 }) {
            Text(cf.name ? cf.name : '(未命名)')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .textCase(TextCase.UpperCase)
              .letterSpacing(0.4)
              .width('100%');
            Text(cf.boolValue ? '已开启' : '已关闭')
              .fontSize(ZType.bodySize)
              .fontColor(this.zc.text);
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start);

          // 只读视觉开关
          Stack({ alignContent: cf.boolValue ? Alignment.End : Alignment.Start }) {
            Row()
              .width(14)
              .height(14)
              .borderRadius(7)
              .backgroundColor(cf.boolValue ? this.zc.accentInk : this.zc.text3)
              .margin({ left: 2, right: 2 });
          }
          .width(32)
          .height(18)
          .borderRadius(9)
          .backgroundColor(cf.boolValue ? this.zc.accent : this.zc.bgActive);
        }
        .width('100%')
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md })
        .alignItems(VerticalAlign.Center);
      } else if (cf.type === 'linked') {
        Row() {
          Column({ space: 4 }) {
            Text(cf.name ? cf.name : '(未命名)')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .textCase(TextCase.UpperCase)
              .letterSpacing(0.4)
              .width('100%');
            Row({ space: 5 }) {
              Image($r('app.media.ic_link'))
                .width(13)
                .height(13)
                .fillColor(this.zc.text3);
              Text(cf.value ? cf.value : '(未关联)')
                .fontSize(ZType.bodySize)
                .fontColor(this.zc.text2)
                .fontFamily('HarmonyOS Sans Condensed')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1);
            }
            .width('100%')
            .alignItems(VerticalAlign.Center);
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start);
        }
        .width('100%')
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md })
        .alignItems(VerticalAlign.Center);
      } else if (cf.value || cf.type === 'hidden') {
        // text / hidden
        Row({ space: ZSpacing.sm }) {
          Column({ space: 4 }) {
            Text(cf.name ? cf.name : '(未命名)')
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.text3)
              .textCase(TextCase.UpperCase)
              .letterSpacing(0.4)
              .width('100%');
            if (cf.type === 'hidden' && !this.revealed[`cf_${cf.id}`]) {
              this.maskDots();
            } else {
              Text(cf.value)
                .fontSize(ZType.bodySize)
                .fontColor(this.zc.text)
                .fontFamily(cf.type === 'hidden' ? 'HarmonyOS Sans Condensed' : 'HarmonyOS Sans')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
                .copyOption(CopyOptions.LocalDevice);
            }
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start);

          Row({ space: ZSpacing.xs }) {
            if (cf.type === 'hidden') {
              this.iconButton(
                this.revealed[`cf_${cf.id}`] ? $r('app.media.ic_eye_off') : $r('app.media.ic_eye'),
                34,
                16,
                () => this.toggleReveal(`cf_${cf.id}`),
              );
            }
            this.iconButton($r('app.media.ic_copy'), 34, 16, () => this.onCopyValue(cf.value, cf.type === 'hidden'));
          }
        }
        .width('100%')
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md })
        .alignItems(VerticalAlign.Center);
      }

      if (!isLast) {
        Divider()
          .color(this.zc.lineSoft)
          .strokeWidth(1)
          .margin({ left: ZSpacing.lg });
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  /* ----- 标签 ----- */

  @Builder
  tagsSection(tags: string[]) {
    Column() {
      this.sectionHeader('标签');
      Flex({ wrap: FlexWrap.Wrap, direction: FlexDirection.Row }) {
        ForEach(tags, (tag: string) => {
          Text(`#${tag}`)
            .fontSize(ZType.subheadSize)
            .fontFamily('HarmonyOS Sans Condensed')
            .fontColor(this.zc.text2)
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .backgroundColor(this.zc.bgActive)
            .borderRadius(ZRadius.md)
            .margin({ right: 6, bottom: 6 });
        }, (tag: string) => tag);
      }
      .width('100%')
      .padding(ZSpacing.lg)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, bottom: ZSpacing.lg });
  }

  /* ----- 备注（非 note 类型的通用 notes） ----- */

  @Builder
  notesSection(notes: string) {
    Column() {
      this.sectionHeader('备注');
      Column() {
        Text(notes)
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text)
          .lineHeight(22)
          .width('100%')
          .copyOption(CopyOptions.LocalDevice);
      }
      .width('100%')
      .padding(ZSpacing.lg)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl);
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, bottom: ZSpacing.lg });
  }

  /* ----- 删除 ----- */

  @Builder
  deleteSection() {
    Column() {
      Row({ space: ZSpacing.sm }) {
        Image($r('app.media.ic_trash'))
          .width(16)
          .height(16)
          .fillColor(this.zc.danger);
        Text('删除条目')
          .fontSize(ZType.bodySize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.danger);
      }
      .width('100%')
      .height(50)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl)
      .onClick(() => this.onDelete());
    }
    .width('100%')
    .padding({ left: ZSpacing.lg, right: ZSpacing.lg, bottom: ZSpacing.md });
  }

  /* ----- 底部：最后修改 ----- */

  @Builder
  footerSection() {
    Row() {
      Text(`最后修改 · ${this.itemUpdatedLabel}`)
        .fontSize(ZType.captionSize)
        .fontColor(this.zc.text3);
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ top: ZSpacing.xs, bottom: ZSpacing.lg });
  }

  /* ----- 未找到 ----- */

  @Builder
  errorView() {
    Column({ space: ZSpacing.md }) {
      Text(this.errorText ? this.errorText : '条目不存在')
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.text3);
      Text(`id: ${this.routeId}`)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text4)
        .fontFamily('HarmonyOS Sans Condensed');
    }
    .width('100%')
    .height(360)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center);
  }
}
