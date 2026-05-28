// ItemEdit —— 条目编辑页（创建 / 更新）
//
// 路由参数（router.pushUrl({ url: 'pages/ItemEdit', params: {...} })）：
//   { mode: 'create', type?: VaultItemType }
//   { mode: 'edit',   id: string }
//
// 与 phone/app/item/[id].tsx 编辑模式行为对齐：
//   - 所有 7 种类型用同一个表单，按 type 显示不同字段
//   - 保存时序列化为 ItemPayload.fields 透传 vaultService

import { ZColors, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import type { UpdateItemPatch, VaultItemType } from '../lib/VaultService';
import { typeLabel } from '../lib/Format';
import { promptAction, router } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

interface TypeOption {
  key: VaultItemType;
  label: string;
}

const TYPE_OPTIONS: TypeOption[] = [
  { key: 'login', label: '登录凭据' },
  { key: 'card', label: '支付卡' },
  { key: 'note', label: '安全笔记' },
  { key: 'identity', label: '身份信息' },
  { key: 'ssh', label: 'SSH 密钥' },
  { key: 'passkey', label: '通行密钥' },
  { key: 'totp', label: '验证码' },
];

@Entry
@ComponentV2
struct ItemEdit {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local store: VaultStore = vaultStore;

  @Local mode: string = 'create';
  @Local editId: string = '';
  @Local itemType: VaultItemType = 'login';
  @Local itemName: string = '';

  // login
  @Local loginUsername: string = '';
  @Local loginPassword: string = '';
  @Local loginUrl: string = '';

  // card
  @Local cardCardholder: string = '';
  @Local cardNumber: string = '';
  @Local cardExp: string = '';
  @Local cardCvv: string = '';
  @Local cardBrand: string = '';

  // note
  @Local noteText: string = '';

  // identity
  @Local idFirst: string = '';
  @Local idLast: string = '';
  @Local idEmail: string = '';
  @Local idPhone: string = '';

  // ssh
  @Local sshUsername: string = '';
  @Local sshKeyType: string = '';
  @Local sshApiKey: string = '';

  // passkey
  @Local pkRpId: string = '';
  @Local pkUserName: string = '';
  @Local pkCredentialId: string = '';

  // totp
  @Local totpSecret: string = '';
  @Local totpIssuer: string = '';
  @Local totpAccount: string = '';

  @Local errorText: string = '';

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object> | null;
    if (!params) {
      this.mode = 'create';
      return;
    }
    const m = params.mode;
    if (typeof m === 'string') this.mode = m;
    const t = params.type;
    if (typeof t === 'string') this.itemType = t as VaultItemType;
    const id = params.id;
    if (typeof id === 'string') {
      this.editId = id;
      this.loadExisting();
    }
  }

  private async loadExisting(): Promise<void> {
    const item = await this.store.getItem(this.editId);
    if (!item) {
      this.errorText = '条目不存在';
      return;
    }
    this.itemType = item.type;
    this.itemName = item.name;
    const f = item.fields;
    // 按 type 反序列化到本地 state
    this.loginUsername = (f.username as string | undefined) ?? '';
    this.loginPassword = (f.password as string | undefined) ?? '';
    this.loginUrl = (f.url as string | undefined) ?? '';
    this.cardCardholder = (f.cardholder as string | undefined) ?? '';
    this.cardNumber = (f.number as string | undefined) ?? '';
    this.cardExp = (f.exp as string | undefined) ?? '';
    this.cardCvv = (f.cvv as string | undefined) ?? '';
    this.cardBrand = (f.brand as string | undefined) ?? '';
    this.noteText = (f.note as string | undefined) ?? '';
    this.idFirst = (f.first as string | undefined) ?? '';
    this.idLast = (f.last as string | undefined) ?? '';
    this.idEmail = (f.email as string | undefined) ?? '';
    this.idPhone = (f.phone as string | undefined) ?? '';
    this.sshUsername = (f.username as string | undefined) ?? '';
    this.sshKeyType = (f.keyType as string | undefined) ?? '';
    this.sshApiKey = (f.apiKey as string | undefined) ?? '';
    this.pkRpId = (f.rpId as string | undefined) ?? '';
    this.pkUserName = (f.userName as string | undefined) ?? '';
    this.pkCredentialId = (f.credentialId as string | undefined) ?? '';
    this.totpSecret = (f.secret as string | undefined) ?? '';
    this.totpIssuer = (f.issuer as string | undefined) ?? '';
    this.totpAccount = (f.account as string | undefined) ?? '';
  }

  private collectFields(): Record<string, Object> {
    const out: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
    switch (this.itemType) {
      case 'login':
        out.username = this.loginUsername;
        out.password = this.loginPassword;
        out.url = this.loginUrl;
        break;
      case 'card':
        out.cardholder = this.cardCardholder;
        out.number = this.cardNumber;
        out.exp = this.cardExp;
        out.cvv = this.cardCvv;
        out.brand = this.cardBrand;
        break;
      case 'note':
        out.note = this.noteText;
        break;
      case 'identity':
        out.first = this.idFirst;
        out.last = this.idLast;
        out.email = this.idEmail;
        out.phone = this.idPhone;
        break;
      case 'ssh':
        out.username = this.sshUsername;
        out.keyType = this.sshKeyType;
        out.apiKey = this.sshApiKey;
        break;
      case 'passkey':
        out.rpId = this.pkRpId;
        out.userName = this.pkUserName;
        out.credentialId = this.pkCredentialId;
        break;
      case 'totp':
        out.secret = this.totpSecret;
        out.issuer = this.totpIssuer;
        out.account = this.totpAccount;
        break;
    }
    return out;
  }

  private async onSave(): Promise<void> {
    this.errorText = '';
    if (!this.itemName.trim()) {
      this.errorText = '名称不能为空';
      return;
    }
    try {
      if (this.mode === 'edit' && this.editId) {
        const patch: UpdateItemPatch = {
          name: this.itemName,
          type: this.itemType,
          fields: this.collectFields(),
        };
        await this.store.updateItem(this.editId, patch);
      } else {
        await this.store.createItem(this.itemType, this.itemName, this.collectFields());
      }
      promptAction.showToast({ message: '已保存', duration: 1200 });
      router.back();
    } catch (e) {
      this.errorText = (e as Error).message;
    }
  }

  private async onDelete(): Promise<void> {
    if (this.mode !== 'edit' || !this.editId) return;
    const r = await promptAction.showDialog({
      title: '删除条目？',
      message: '将立即移到回收站，可在同步对端找回。',
      buttons: [
        { text: '取消', color: ZColors.text2 },
        { text: '删除', color: ZColors.danger },
      ],
    });
    if (r.index === 1) {
      await this.store.deleteItem(this.editId);
      promptAction.showToast({ message: '已删除', duration: 1200 });
      router.back();
    }
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // 顶栏
      Row({ space: ZSpacing.sm }) {
        Text('取消')
          .fontSize(ZType.bodySize)
          .fontColor(ZColors.text2)
          .onClick(() => router.back());
        Text(this.mode === 'edit' ? '编辑' : '新建')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(ZColors.text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center);
        Text('保存')
          .fontSize(ZType.bodySize)
          .fontColor(ZColors.accent)
          .onClick(() => this.onSave());
      }
      .width('100%')
      .padding({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.sm,
        bottom: ZSpacing.sm,
      });

      Scroll() {
        Column({ space: ZSpacing.md }) {
          // 类型选择（仅 create 模式）
          if (this.mode !== 'edit') {
            Column({ space: ZSpacing.sm }) {
              Text('类型')
                .fontSize(ZType.calloutSize)
                .fontColor(ZColors.text2)
                .width('100%');
              Scroll() {
                Row({ space: ZSpacing.sm }) {
                  ForEach(TYPE_OPTIONS, (opt: TypeOption) => {
                    this.typeChip(opt);
                  }, (opt: TypeOption) => opt.key);
                }
              }
              .scrollable(ScrollDirection.Horizontal)
              .scrollBar(BarState.Off)
              .width('100%');
            }
            .width('100%');
          } else {
            Text(typeLabel(this.itemType))
              .fontSize(ZType.footnoteSize)
              .fontColor(ZColors.text3)
              .width('100%');
          }

          // 名称
          this.field('名称', this.itemName, '必填', (v: string) => { this.itemName = v; });

          // 类型特定字段
          if (this.itemType === 'login') {
            this.field('用户名', this.loginUsername, 'user@example.com', (v: string) => { this.loginUsername = v; });
            this.passwordField('密码', this.loginPassword, (v: string) => { this.loginPassword = v; });
            this.field('网址', this.loginUrl, 'https://example.com', (v: string) => { this.loginUrl = v; });
          } else if (this.itemType === 'card') {
            this.field('持卡人', this.cardCardholder, '', (v: string) => { this.cardCardholder = v; });
            this.field('卡号', this.cardNumber, '4242 4242 4242 4242', (v: string) => { this.cardNumber = v; });
            this.field('有效期', this.cardExp, 'MM/YY', (v: string) => { this.cardExp = v; });
            this.passwordField('CVV', this.cardCvv, (v: string) => { this.cardCvv = v; });
            this.field('品牌', this.cardBrand, 'Visa / Mastercard', (v: string) => { this.cardBrand = v; });
          } else if (this.itemType === 'note') {
            this.multilineField('内容', this.noteText, (v: string) => { this.noteText = v; });
          } else if (this.itemType === 'identity') {
            this.field('名', this.idFirst, '', (v: string) => { this.idFirst = v; });
            this.field('姓', this.idLast, '', (v: string) => { this.idLast = v; });
            this.field('邮箱', this.idEmail, '', (v: string) => { this.idEmail = v; });
            this.field('电话', this.idPhone, '', (v: string) => { this.idPhone = v; });
          } else if (this.itemType === 'ssh') {
            this.field('用户名', this.sshUsername, '', (v: string) => { this.sshUsername = v; });
            this.field('密钥类型', this.sshKeyType, 'ed25519 / rsa', (v: string) => { this.sshKeyType = v; });
            this.passwordField('API Key', this.sshApiKey, (v: string) => { this.sshApiKey = v; });
          } else if (this.itemType === 'passkey') {
            this.field('RP ID', this.pkRpId, '', (v: string) => { this.pkRpId = v; });
            this.field('用户名', this.pkUserName, '', (v: string) => { this.pkUserName = v; });
            this.field('Credential ID', this.pkCredentialId, '', (v: string) => { this.pkCredentialId = v; });
          } else if (this.itemType === 'totp') {
            this.passwordField('密钥（base32）', this.totpSecret, (v: string) => { this.totpSecret = v; });
            this.field('发行者', this.totpIssuer, 'GitHub', (v: string) => { this.totpIssuer = v; });
            this.field('账户', this.totpAccount, 'user@example.com', (v: string) => { this.totpAccount = v; });
          }

          if (this.errorText) {
            Text(this.errorText)
              .fontSize(ZType.footnoteSize)
              .fontColor(ZColors.danger)
              .width('100%');
          }

          if (this.mode === 'edit') {
            Text('删除条目')
              .fontSize(ZType.bodySize)
              .fontColor(ZColors.danger)
              .backgroundColor(ZColors.bgElev)
              .borderRadius(ZRadius.lg)
              .height(48)
              .width('100%')
              .textAlign(TextAlign.Center)
              .margin({ top: ZSpacing.md })
              .onClick(() => this.onDelete());
          }

          Row().height(40).width('100%');
        }
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
      }
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .width('100%');

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%')
    .height('100%')
    .backgroundColor(ZColors.bg)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    .padding({ bottom: this.safeArea.keyboard });
  }

  @Builder
  typeChip(opt: TypeOption) {
    Text(opt.label)
      .fontSize(ZType.subheadSize)
      .fontColor(this.itemType === opt.key ? ZColors.accentInk : ZColors.text2)
      .backgroundColor(this.itemType === opt.key ? ZColors.accent : ZColors.bgElev)
      .borderRadius(ZRadius.md)
      .padding({
        left: ZSpacing.md,
        right: ZSpacing.md,
        top: 6,
        bottom: 6,
      })
      .onClick(() => { this.itemType = opt.key; });
  }

  @Builder
  field(label: string, value: string, placeholder: string, onChange: (v: string) => void) {
    Column({ space: ZSpacing.xs }) {
      Text(label).fontSize(ZType.footnoteSize).fontColor(ZColors.text3);
      TextInput({ placeholder: placeholder, text: value })
        .placeholderColor(ZColors.text3)
        .placeholderFont({ size: ZType.bodySize })
        .fontColor(ZColors.text)
        .fontSize(ZType.bodySize)
        .backgroundColor(ZColors.bgElev)
        .borderRadius(ZRadius.lg)
        .padding({ left: ZSpacing.md, right: ZSpacing.md })
        .height(44)
        .width('100%')
        .onChange((v: string) => onChange(v));
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%');
  }

  @Builder
  passwordField(label: string, value: string, onChange: (v: string) => void) {
    Column({ space: ZSpacing.xs }) {
      Text(label).fontSize(ZType.footnoteSize).fontColor(ZColors.text3);
      TextInput({ placeholder: '', text: value })
        .type(InputType.Password)
        .placeholderColor(ZColors.text3)
        .placeholderFont({ size: ZType.bodySize })
        .fontColor(ZColors.text)
        .fontSize(ZType.bodySize)
        .backgroundColor(ZColors.bgElev)
        .borderRadius(ZRadius.lg)
        .padding({ left: ZSpacing.md, right: ZSpacing.md })
        .height(44)
        .width('100%')
        .onChange((v: string) => onChange(v));
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%');
  }

  @Builder
  multilineField(label: string, value: string, onChange: (v: string) => void) {
    Column({ space: ZSpacing.xs }) {
      Text(label).fontSize(ZType.footnoteSize).fontColor(ZColors.text3);
      TextArea({ placeholder: '', text: value })
        .placeholderColor(ZColors.text3)
        .placeholderFont({ size: ZType.bodySize })
        .fontColor(ZColors.text)
        .fontSize(ZType.bodySize)
        .backgroundColor(ZColors.bgElev)
        .borderRadius(ZRadius.lg)
        .padding(ZSpacing.md)
        .width('100%')
        .height(160)
        .onChange((v: string) => onChange(v));
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%');
  }
}
