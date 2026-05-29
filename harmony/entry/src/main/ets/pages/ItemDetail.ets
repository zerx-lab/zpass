// ItemDetail —— 条目详情页（只读视图）
//
// 路由参数：{ id: string }
//
// 与 phone/app/vault/[id].tsx 行为对齐：展示字段 + 复制按钮 + 编辑入口。
// 密码 / cvv / API key / TOTP secret 等敏感字段默认遮蔽，点击眼睛 reveal。

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore } from '../state/VaultStore';
import type { ItemPayload } from '../lib/VaultService';
import { typeLabel, relativeTime, faviconColor, faviconInitials } from '../lib/Format';
import { copyEphemeral, copyText } from '../lib/Clipboard';
import { promptAction, router } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

interface VisibleField {
  key: string;
  label: string;
  value: string;
  /** 是否敏感（默认遮蔽 + ephemeral copy） */
  sensitive: boolean;
}

@Entry
@ComponentV2
struct ItemDetail {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;

  @Local item: ItemPayload | null = null;
  @Local revealed: Record<string, boolean> = JSON.parse('{}') as Record<string, boolean>;
  @Local errorText: string = '';

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object> | null;
    if (params && typeof params.id === 'string') {
      this.load(params.id);
    }
  }

  onPageShow(): void {
    // 从编辑页 back 后刷新一次
    if (this.item) this.load(this.item.id);
  }

  private async load(id: string): Promise<void> {
    try {
      const it = await vaultStore.getItem(id);
      if (!it) {
        this.errorText = '条目不存在';
        return;
      }
      this.item = it;
      this.errorText = '';
    } catch (e) {
      this.errorText = (e as Error).message;
    }
  }

  private buildFields(it: ItemPayload): VisibleField[] {
    const f = it.fields;
    const out: VisibleField[] = [];
    const get = (k: string): string => {
      const v = f[k];
      return typeof v === 'string' ? (v as string) : '';
    };
    const push = (k: string, label: string, sensitive: boolean): void => {
      const v = get(k);
      if (v) out.push({ key: k, label, value: v, sensitive });
    };
    switch (it.type) {
      case 'login':
        push('username', '用户名', false);
        push('password', '密码', true);
        push('url', '网址', false);
        push('totp', 'TOTP 密钥', true);
        break;
      case 'card':
        push('cardholder', '持卡人', false);
        push('number', '卡号', true);
        push('exp', '有效期', false);
        push('cvv', 'CVV', true);
        push('brand', '品牌', false);
        break;
      case 'note':
        push('note', '内容', false);
        break;
      case 'identity':
        push('first', '名', false);
        push('last', '姓', false);
        push('email', '邮箱', false);
        push('phone', '电话', false);
        push('address', '地址', false);
        push('dob', '生日', false);
        push('passport', '护照号', true);
        break;
      case 'ssh':
        push('username', '用户名', false);
        push('keyType', '密钥类型', false);
        push('apiKey', 'API Key', true);
        push('fingerprint', '指纹', false);
        push('publicKey', '公钥', false);
        break;
      case 'passkey':
        push('rpId', 'RP ID', false);
        push('userName', '用户名', false);
        push('credentialId', 'Credential ID', false);
        break;
      case 'totp':
        push('secret', '密钥', true);
        push('issuer', '发行者', false);
        push('account', '账户', false);
        break;
    }
    return out;
  }

  private toggleReveal(key: string): void {
    const next: Record<string, boolean> = JSON.parse('{}') as Record<string, boolean>;
    Object.keys(this.revealed).forEach((k) => {
      next[k] = this.revealed[k];
    });
    next[key] = !next[key];
    this.revealed = next;
  }

  private async onCopy(field: VisibleField): Promise<void> {
    try {
      if (field.sensitive) {
        await copyEphemeral(field.value);
        promptAction.showToast({ message: '已复制（30 秒后清空）', duration: 1500 });
      } else {
        await copyText(field.value);
        promptAction.showToast({ message: '已复制', duration: 1200 });
      }
    } catch (_e) {
      promptAction.showToast({ message: '复制失败', duration: 1200 });
    }
  }

  private async onEdit(): Promise<void> {
    if (!this.item) return;
    await router.pushUrl({
      url: 'pages/ItemEdit',
      params: { mode: 'edit', id: this.item.id },
    });
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // 顶栏
      Row({ space: ZSpacing.sm }) {
        Text('返回')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text2)
          .onClick(() => router.back());
        Text(this.item?.name ?? '')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
        Text('编辑')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.accent)
          .onClick(() => this.onEdit());
      }
      .width('100%')
      .padding({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.sm,
        bottom: ZSpacing.sm,
      });

      if (this.errorText) {
        Text(this.errorText)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.danger)
          .width('100%')
          .padding(ZSpacing.lg);
      }

      Scroll() {
        Column({ space: ZSpacing.md }) {
          if (this.item) {
            // 头部卡
            Column({ space: ZSpacing.sm }) {
              Column() {
                Text(faviconInitials(this.item.name))
                  .fontSize(20)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.zc.faviconInk);
              }
              .width(56)
              .height(56)
              .borderRadius(ZRadius.xl)
              .backgroundColor(faviconColor(this.item.name))
              .justifyContent(FlexAlign.Center)
              .alignItems(HorizontalAlign.Center);

              Text(typeLabel(this.item.type))
                .fontSize(ZType.footnoteSize)
                .fontColor(this.zc.text3);
              Text(`修改于 ${relativeTime(this.item.updatedAt)}`)
                .fontSize(ZType.captionSize)
                .fontColor(this.zc.text3);
            }
            .width('100%')
            .alignItems(HorizontalAlign.Center)
            .padding(ZSpacing.lg);

            // 字段列表
            ForEach(this.buildFields(this.item), (f: VisibleField) => {
              this.fieldRow(f);
            }, (f: VisibleField) => f.key);
          }

          Row().height(40).width('100%');
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

  @Builder
  fieldRow(field: VisibleField) {
    Column({ space: ZSpacing.xs }) {
      Row() {
        Text(field.label)
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .layoutWeight(1);
        if (field.sensitive) {
          Text(this.revealed[field.key] ? '隐藏' : '显示')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text2)
            .onClick(() => this.toggleReveal(field.key));
        }
        Text('复制')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.accent)
          .margin({ left: ZSpacing.md })
          .onClick(() => this.onCopy(field));
      }
      .width('100%');
      Text(
        field.sensitive && !this.revealed[field.key]
          ? '••••••••••••'
          : field.value,
      )
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.text)
        .fontFamily(field.sensitive ? 'HarmonyOS Sans' : 'HarmonyOS Sans')
        .width('100%')
        .copyOption(CopyOptions.LocalDevice);
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(ZSpacing.lg)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }
}
