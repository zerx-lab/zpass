// ItemEdit —— 条目编辑页（创建 / 更新）
//
// 路由参数（router.pushUrl({ url: 'pages/ItemEdit', params: {...} })）：
//   { mode: 'create', type?: VaultItemType }
//   { mode: 'edit',   id: string }
//   { id: 'new', type: 'login', initialPassword: <生成的密码> }   ← 来自生成器
//   { id: 'new', type: 'totp',  initialTotpUri: '<otpauth://...>' } ← 来自扫码
//
// 与 phone/app/item/[id].tsx 编辑模式行为对齐：
//   - 所有 7 种类型用同一个表单，按 type 显示不同字段
//   - 自定义字段 / 标签 / 备注 / 收藏 全量支持
//   - 字段合并：保存时以原始 fields 为底，叠加编辑值，保留 spaceId / otp 元数据 /
//     breached / strength 等未知键，避免编辑回存丢字段
//   - 保存时序列化为 ItemPayload.fields 透传 vaultService

import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType, alpha1f } from '../theme/Tokens';
import { vaultStore, type VaultStore } from '../state/VaultStore';
import type { UpdateItemPatch, VaultItemType } from '../lib/VaultService';
import { typeLabel } from '../lib/Format';
import { promptAction, router } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import {
  parseCustomFields,
  serializeCustomFields,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABEL,
  LINKABLE_FIELDS_BY_TYPE,
  newCustomFieldId,
  CUSTOM_FIELDS_KEY,
  type CustomField,
  type CustomFieldType,
} from '../lib/CustomFields';
import { generatePassword, type GenOptions } from '../lib/PassGen';
import { parseOtpauth } from '../lib/Totp';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';

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

// 生成器默认选项（与 phone item/[id].tsx 内嵌生成一致）
const GEN_DEFAULT_OPTS: GenOptions = {
  upper: true,
  lower: true,
  numbers: true,
  symbols: true,
  avoidAmbiguous: false,
};

@Entry
@ComponentV2
struct ItemEdit {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;

  @Local mode: string = 'create';
  @Local editId: string = '';
  @Local itemType: VaultItemType = 'login';
  @Local itemName: string = '';

  // login
  @Local loginUsername: string = '';
  @Local loginPassword: string = '';
  @Local loginUrl: string = '';
  @Local loginTotp: string = '';

  // card
  @Local cardCardholder: string = '';
  @Local cardNumber: string = '';
  @Local cardExp: string = '';
  @Local cardCvv: string = '';
  @Local cardPin: string = '';
  @Local cardBrand: string = '';

  // note
  @Local noteText: string = '';

  // identity
  @Local idFirst: string = '';
  @Local idLast: string = '';
  @Local idEmail: string = '';
  @Local idPhone: string = '';
  @Local idAddress: string = '';
  @Local idDob: string = '';
  @Local idPassport: string = '';

  // ssh
  @Local sshUsername: string = '';
  @Local sshKeyType: string = '';
  @Local sshFingerprint: string = '';
  @Local sshPublicKey: string = '';
  @Local sshApiKey: string = '';

  // passkey
  @Local pkRpId: string = '';
  @Local pkUserName: string = '';
  @Local pkCredentialId: string = '';

  // totp
  @Local totpSecret: string = '';
  @Local totpIssuer: string = '';
  @Local totpAccount: string = '';

  // tags / notes / favorite / custom fields
  @Local itemTags: string = '';
  @Local itemNotes: string = '';
  @Local isFavorite: boolean = false;
  @Local customFields: CustomField[] = [];

  // scan 状态：当前正在填充的字段 key（'' 表示无扫描进行）
  @Local scanTarget: string = '';

  // 字段合并保真：保存时以原始 fields 为底叠加编辑值
  @Local originalFields: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;

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
      // 仅 edit 模式且非 'new' 哨兵才加载既有条目
      if (this.mode === 'edit' && id && id !== 'new') {
        this.loadExisting();
      }
    }
    // 生成器交接：预填 login 密码
    const ip = params.initialPassword;
    if (typeof ip === 'string' && ip) {
      this.loginPassword = ip;
    }
    // 扫码交接：预填 totp 密钥 + 自动填发行者/账户/名称
    const ut = params.initialTotpUri;
    if (typeof ut === 'string' && ut) {
      this.applyTotpUri(ut);
    }
  }

  // 把 otpauth:// URI 写入 totp 密钥字段，并按解析的 meta 填空白的发行者/账户/名称
  private applyTotpUri(uri: string): void {
    this.totpSecret = uri;
    const parsed = parseOtpauth(uri);
    if (parsed.ok && parsed.meta) {
      const meta = parsed.meta;
      if (!this.totpIssuer && meta.issuer) this.totpIssuer = meta.issuer;
      if (!this.totpAccount && meta.account) this.totpAccount = meta.account;
      if (!this.itemName && meta.issuer) this.itemName = meta.issuer;
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
    this.loginTotp = (f.totp as string | undefined) ?? '';
    this.cardCardholder = (f.cardholder as string | undefined) ?? '';
    this.cardNumber = (f.number as string | undefined) ?? '';
    this.cardExp = (f.exp as string | undefined) ?? '';
    this.cardCvv = (f.cvv as string | undefined) ?? '';
    this.cardPin = (f.pin as string | undefined) ?? '';
    this.cardBrand = (f.brand as string | undefined) ?? '';
    this.noteText = (f.note as string | undefined) ?? '';
    this.idFirst = (f.first as string | undefined) ?? '';
    this.idLast = (f.last as string | undefined) ?? '';
    this.idEmail = (f.email as string | undefined) ?? '';
    this.idPhone = (f.phone as string | undefined) ?? '';
    this.idAddress = (f.address as string | undefined) ?? '';
    this.idDob = (f.dob as string | undefined) ?? '';
    this.idPassport = (f.passport as string | undefined) ?? '';
    this.sshUsername = (f.username as string | undefined) ?? '';
    this.sshKeyType = (f.keyType as string | undefined) ?? '';
    this.sshFingerprint = (f.fingerprint as string | undefined) ?? '';
    this.sshPublicKey = (f.publicKey as string | undefined) ?? '';
    this.sshApiKey = (f.apiKey as string | undefined) ?? '';
    this.pkRpId = (f.rpId as string | undefined) ?? '';
    this.pkUserName = (f.userName as string | undefined) ?? '';
    this.pkCredentialId = (f.credentialId as string | undefined) ?? '';
    this.totpSecret = (f.secret as string | undefined) ?? '';
    this.totpIssuer = (f.issuer as string | undefined) ?? '';
    this.totpAccount = (f.account as string | undefined) ?? '';

    // tags：可能是 string[] 或逗号串
    const rawTags = f.tags;
    if (Array.isArray(rawTags)) {
      this.itemTags = (rawTags as string[]).join(', ');
    } else if (typeof rawTags === 'string') {
      this.itemTags = rawTags;
    } else {
      this.itemTags = '';
    }
    this.itemNotes = (f.notes as string | undefined) ?? '';
    this.isFavorite = (f.favorite as boolean | undefined) ?? false;

    // 自定义字段
    this.customFields = parseCustomFields(item.fields as Record<string, string>);

    // 克隆原始 fields，保存时以此为底叠加，保留未知键
    const clone: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
    for (const k of Object.keys(item.fields)) {
      clone[k] = item.fields[k];
    }
    this.originalFields = clone;
  }

  private collectFields(): Record<string, Object> {
    // 以原始 fields 的新克隆为底（保留 spaceId / otp 元数据 / breached / strength 等未知键）
    const out: Record<string, Object> = JSON.parse('{}') as Record<string, Object>;
    for (const k of Object.keys(this.originalFields)) {
      out[k] = this.originalFields[k];
    }
    switch (this.itemType) {
      case 'login':
        out.username = this.loginUsername;
        out.password = this.loginPassword;
        out.url = this.loginUrl;
        out.totp = this.loginTotp;
        break;
      case 'card':
        out.cardholder = this.cardCardholder;
        out.number = this.cardNumber;
        out.exp = this.cardExp;
        out.cvv = this.cardCvv;
        out.pin = this.cardPin;
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
        out.address = this.idAddress;
        out.dob = this.idDob;
        out.passport = this.idPassport;
        break;
      case 'ssh':
        out.username = this.sshUsername;
        out.keyType = this.sshKeyType;
        out.fingerprint = this.sshFingerprint;
        out.publicKey = this.sshPublicKey;
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
    // 通用字段：备注 / 收藏 / 标签（数组）/ 自定义字段（JSON 串）
    out.notes = this.itemNotes;
    out.favorite = this.isFavorite;
    out.tags = this.itemTags
      .split(',')
      .map((tag: string) => tag.trim())
      .filter((tag: string) => tag.length > 0);
    out[CUSTOM_FIELDS_KEY] = serializeCustomFields(this.customFields);
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
        { text: '取消', color: this.zc.text2 },
        { text: '删除', color: this.zc.danger },
      ],
    });
    if (r.index === 1) {
      await this.store.deleteItem(this.editId);
      promptAction.showToast({ message: '已删除', duration: 1200 });
      router.back();
    }
  }

  // 生成 20 位强密码并写入 login 密码字段
  private generateLoginPassword(): void {
    this.loginPassword = generatePassword(20, GEN_DEFAULT_OPTS);
  }

  // 扫码填入指定字段（系统级 ScanKit UI，无需自定义 overlay）
  private async startScan(fieldKey: string): Promise<void> {
    this.scanTarget = fieldKey;
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.QR_CODE],
      enableMultiMode: false,
      enableAlbum: true,
    };
    try {
      const result = await scanBarcode.startScanForResult(getContext(this) as Context, options);
      const text = result.originalValue;
      if (fieldKey === 'totpSecret') {
        this.applyTotpUri(text);
      } else if (fieldKey === 'loginTotp') {
        this.loginTotp = text;
      }
    } catch (e) {
      const err = e as BusinessError;
      // 1000500002 = 用户取消扫描，静默返回
      if (err.code !== 1000500002) {
        this.errorText = `扫描失败：${err.message}`;
      }
    } finally {
      this.scanTarget = '';
    }
  }

  /* ── 自定义字段：增删改（不可变重赋值触发 V2 重渲）─────────────── */

  private addCustomField(type: CustomFieldType): void {
    let next: CustomField;
    if (type === 'boolean') {
      next = { id: newCustomFieldId(), type, name: '', value: '', boolValue: false };
    } else if (type === 'linked') {
      const linkable = LINKABLE_FIELDS_BY_TYPE.get(this.itemType) ?? [];
      next = { id: newCustomFieldId(), type, name: '', value: linkable.length > 0 ? linkable[0] : '' };
    } else {
      next = { id: newCustomFieldId(), type, name: '', value: '' };
    }
    // ArkTS strict 禁数组 spread，用 concat
    this.customFields = this.customFields.concat(next);
  }

  private removeCustomField(id: string): void {
    this.customFields = this.customFields.filter((f: CustomField) => f.id !== id);
  }

  private cloneCustomField(f: CustomField): CustomField {
    const n: CustomField = { id: f.id, type: f.type, name: f.name, value: f.value };
    if (f.boolValue !== undefined) n.boolValue = f.boolValue;
    return n;
  }

  private updateCustomFieldName(id: string, name: string): void {
    this.customFields = this.customFields.map((f: CustomField) => {
      if (f.id !== id) return f;
      const n = this.cloneCustomField(f);
      n.name = name;
      return n;
    });
  }

  private updateCustomFieldValue(id: string, value: string): void {
    this.customFields = this.customFields.map((f: CustomField) => {
      if (f.id !== id) return f;
      const n = this.cloneCustomField(f);
      n.value = value;
      return n;
    });
  }

  private toggleCustomFieldBool(id: string): void {
    this.customFields = this.customFields.map((f: CustomField) => {
      if (f.id !== id) return f;
      const n = this.cloneCustomField(f);
      n.boolValue = !(f.boolValue ?? false);
      return n;
    });
  }

  private changeCustomFieldType(id: string, nextType: CustomFieldType): void {
    this.customFields = this.customFields.map((f: CustomField) => {
      if (f.id !== id || f.type === nextType) return f;
      const n: CustomField = { id: f.id, type: nextType, name: f.name, value: '' };
      if (nextType === 'boolean') {
        n.boolValue = false;
        n.value = '';
      } else if (nextType === 'linked') {
        const linkable = LINKABLE_FIELDS_BY_TYPE.get(this.itemType) ?? [];
        n.value = linkable.length > 0 ? linkable[0] : '';
      } else {
        n.value = '';
      }
      return n;
    });
  }

  private linkableForType(): string[] {
    return LINKABLE_FIELDS_BY_TYPE.get(this.itemType) ?? [];
  }

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      // 顶栏
      Row({ space: ZSpacing.sm }) {
        Text('取消')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.text2)
          .onClick(() => router.back());
        Text(this.mode === 'edit' ? '编辑条目' : '新建条目')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.zc.text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center);
        Text('保存')
          .fontSize(ZType.bodySize)
          .fontColor(this.zc.info)
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
                .fontColor(this.zc.text2)
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
              .fontColor(this.zc.text3)
              .width('100%');
          }

          // 名称
          this.field('名称', this.itemName, '必填', (v: string) => { this.itemName = v; });

          // 类型特定字段
          if (this.itemType === 'login') {
            this.field('用户名', this.loginUsername, 'user@example.com', (v: string) => { this.loginUsername = v; });
            this.passwordFieldWithGenerate('密码', this.loginPassword, (v: string) => { this.loginPassword = v; });
            this.field('网址', this.loginUrl, 'https://example.com', (v: string) => { this.loginUrl = v; });
            this.scanField('TOTP 密钥', this.loginTotp, 'base32 / otpauth:// 或点扫码', 'loginTotp', (v: string) => { this.loginTotp = v; });
          } else if (this.itemType === 'card') {
            this.field('持卡人', this.cardCardholder, '', (v: string) => { this.cardCardholder = v; });
            this.field('卡号', this.cardNumber, '4242 4242 4242 4242', (v: string) => { this.cardNumber = v; });
            this.field('有效期', this.cardExp, 'MM/YY', (v: string) => { this.cardExp = v; });
            this.passwordField('安全码', this.cardCvv, (v: string) => { this.cardCvv = v; });
            this.passwordField('PIN', this.cardPin, (v: string) => { this.cardPin = v; });
            this.field('卡组织', this.cardBrand, 'Visa / Mastercard', (v: string) => { this.cardBrand = v; });
          } else if (this.itemType === 'note') {
            this.multilineField('内容', this.noteText, (v: string) => { this.noteText = v; });
          } else if (this.itemType === 'identity') {
            this.field('名', this.idFirst, '', (v: string) => { this.idFirst = v; });
            this.field('姓', this.idLast, '', (v: string) => { this.idLast = v; });
            this.field('邮箱', this.idEmail, '', (v: string) => { this.idEmail = v; });
            this.field('电话', this.idPhone, '', (v: string) => { this.idPhone = v; });
            this.multilineField('地址', this.idAddress, (v: string) => { this.idAddress = v; });
            this.field('出生日期', this.idDob, 'YYYY-MM-DD', (v: string) => { this.idDob = v; });
            this.passwordField('护照号', this.idPassport, (v: string) => { this.idPassport = v; });
          } else if (this.itemType === 'ssh') {
            this.field('用户名', this.sshUsername, '', (v: string) => { this.sshUsername = v; });
            this.field('密钥类型', this.sshKeyType, 'ed25519 / rsa', (v: string) => { this.sshKeyType = v; });
            this.multilineField('指纹', this.sshFingerprint, (v: string) => { this.sshFingerprint = v; });
            this.multilineField('公钥', this.sshPublicKey, (v: string) => { this.sshPublicKey = v; });
            this.passwordField('API Token', this.sshApiKey, (v: string) => { this.sshApiKey = v; });
          } else if (this.itemType === 'passkey') {
            this.field('RP ID', this.pkRpId, '', (v: string) => { this.pkRpId = v; });
            this.field('用户名', this.pkUserName, '', (v: string) => { this.pkUserName = v; });
            this.field('Credential ID', this.pkCredentialId, '', (v: string) => { this.pkCredentialId = v; });
          } else if (this.itemType === 'totp') {
            this.field('发行者', this.totpIssuer, 'GitHub', (v: string) => { this.totpIssuer = v; });
            this.field('账户', this.totpAccount, 'user@example.com', (v: string) => { this.totpAccount = v; });
            this.scanField('TOTP 密钥', this.totpSecret, 'base32 / otpauth:// 或点扫码', 'totpSecret', (v: string) => { this.totpSecret = v; });
          }

          // 自定义字段
          this.customFieldsSection();

          // 标签（所有类型）
          this.field('标签', this.itemTags, '用逗号分隔，如 dev, 2fa', (v: string) => { this.itemTags = v; });

          // 备注（note 类型已有内容字段，跳过）
          if (this.itemType !== 'note') {
            this.multilineField('备注', this.itemNotes, (v: string) => { this.itemNotes = v; });
          }

          // 收藏
          this.favoriteRow();

          if (this.errorText) {
            Text(this.errorText)
              .fontSize(ZType.footnoteSize)
              .fontColor(this.zc.danger)
              .width('100%');
          }

          if (this.mode === 'edit') {
            Text('删除条目')
              .fontSize(ZType.bodySize)
              .fontColor(this.zc.danger)
              .backgroundColor(this.zc.bgElev)
              .borderRadius(ZRadius.lg)
              .height(48)
              .width('100%')
              .textAlign(TextAlign.Center)
              .margin({ top: ZSpacing.md })
              .onClick(() => this.onDelete());
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
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    .padding({ bottom: this.safeArea.keyboard });
  }

  @Builder
  typeChip(opt: TypeOption) {
    Text(opt.label)
      .fontSize(ZType.subheadSize)
      .fontColor(this.itemType === opt.key ? this.zc.accentInk : this.zc.text2)
      .backgroundColor(this.itemType === opt.key ? this.zc.accent : this.zc.bgElev)
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
      Text(label).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      TextInput({ placeholder: placeholder, text: value })
        .placeholderColor(this.zc.text3)
        .placeholderFont({ size: ZType.bodySize })
        .fontColor(this.zc.text)
        .fontSize(ZType.bodySize)
        .backgroundColor(this.zc.bgElev)
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
      Text(label).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      TextInput({ placeholder: '', text: value })
        .type(InputType.Password)
        .placeholderColor(this.zc.text3)
        .placeholderFont({ size: ZType.bodySize })
        .fontColor(this.zc.text)
        .fontSize(ZType.bodySize)
        .backgroundColor(this.zc.bgElev)
        .borderRadius(ZRadius.lg)
        .padding({ left: ZSpacing.md, right: ZSpacing.md })
        .height(44)
        .width('100%')
        .onChange((v: string) => onChange(v));
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%');
  }

  // 密码字段 + 行内「重新生成」图标按钮
  @Builder
  passwordFieldWithGenerate(label: string, value: string, onChange: (v: string) => void) {
    Column({ space: ZSpacing.xs }) {
      Text(label).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      Row({ space: ZSpacing.xs }) {
        TextInput({ placeholder: '', text: value })
          .type(InputType.Password)
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .height(44)
          .layoutWeight(1)
          .onChange((v: string) => onChange(v));
        Row() {
          Image($r('app.media.ic_refresh'))
            .width(18).height(18)
            .fillColor(this.zc.text2);
        }
        .width(40).height(44)
        .backgroundColor(this.zc.bgElev)
        .borderRadius(ZRadius.lg)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .onClick(() => this.generateLoginPassword());
      }
      .width('100%')
      .alignItems(VerticalAlign.Center);
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%');
  }

  // 密码字段 + 行内扫码按钮（TOTP 密钥）
  @Builder
  scanField(label: string, value: string, placeholder: string, fieldKey: string, onChange: (v: string) => void) {
    Column({ space: ZSpacing.xs }) {
      Text(label).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      Row({ space: ZSpacing.xs }) {
        TextInput({ placeholder: placeholder, text: value })
          .type(InputType.Password)
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.bodySize })
          .fontColor(this.zc.text)
          .fontSize(ZType.bodySize)
          .fontFamily('HarmonyOS Sans Condensed')
          .backgroundColor(this.zc.bgElev)
          .borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .height(44)
          .layoutWeight(1)
          .onChange((v: string) => onChange(v));
        Row() {
          Image($r('app.media.ic_qr_scan'))
            .width(18).height(18)
            .fillColor(this.zc.text2);
        }
        .width(40).height(44)
        .backgroundColor(this.zc.bgElev)
        .borderRadius(ZRadius.lg)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .onClick(() => this.startScan(fieldKey));
      }
      .width('100%')
      .alignItems(VerticalAlign.Center);
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%');
  }

  @Builder
  multilineField(label: string, value: string, onChange: (v: string) => void) {
    Column({ space: ZSpacing.xs }) {
      Text(label).fontSize(ZType.footnoteSize).fontColor(this.zc.text3);
      TextArea({ placeholder: '', text: value })
        .placeholderColor(this.zc.text3)
        .placeholderFont({ size: ZType.bodySize })
        .fontColor(this.zc.text)
        .fontSize(ZType.bodySize)
        .backgroundColor(this.zc.bgElev)
        .borderRadius(ZRadius.lg)
        .padding(ZSpacing.md)
        .width('100%')
        .height(160)
        .onChange((v: string) => onChange(v));
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%');
  }

  /* ── 自定义字段区块 ─────────────────────────────────────────── */

  @Builder
  customFieldsSection() {
    Column({ space: ZSpacing.sm }) {
      // 表头：标签 + 添加类型按钮（chip）
      Row({ space: ZSpacing.sm }) {
        Text('自定义字段')
          .fontSize(ZType.footnoteSize)
          .fontColor(this.zc.text3)
          .layoutWeight(1);
      }
      .width('100%')
      .alignItems(VerticalAlign.Center);

      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(CUSTOM_FIELD_TYPES, (tp: CustomFieldType) => {
          this.addTypeChip(tp);
        }, (tp: CustomFieldType) => tp);
      }
      .width('100%');

      // 空态 或 字段列表
      if (this.customFields.length === 0) {
        Column({ space: ZSpacing.xs }) {
          Image($r('app.media.ic_notes'))
            .width(20).height(20)
            .fillColor(this.zc.text3);
          Text('可添加文本、隐藏、开关或关联字段')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3);
        }
        .width('100%')
        .height(72)
        .backgroundColor(this.zc.bgElev)
        .borderRadius(ZRadius.xl)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center);
      } else {
        Column({ space: ZSpacing.sm }) {
          ForEach(this.customFields, (cf: CustomField) => {
            this.customFieldRow(cf);
          }, (cf: CustomField) => cf.id);
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start);
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  // 添加新字段的类型 chip（ic_plus 图标 + 标签，禁用 '+' 字符当图标）
  @Builder
  addTypeChip(tp: CustomFieldType) {
    Row({ space: ZSpacing.xs }) {
      Image($r('app.media.ic_plus'))
        .width(12).height(12)
        .fillColor(this.zc.text2);
      Text(CUSTOM_FIELD_TYPE_LABEL.get(tp) ?? tp)
        .fontSize(ZType.footnoteSize)
        .fontColor(this.zc.text2);
    }
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.sm)
    .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: 4, bottom: 4 })
    .margin({ right: ZSpacing.xs, bottom: ZSpacing.xs })
    .opacity(tp === 'linked' && this.linkableForType().length === 0 ? 0.4 : 1.0)
    .onClick(() => {
      if (tp === 'linked' && this.linkableForType().length === 0) return;
      this.addCustomField(tp);
    });
  }

  @Builder
  customFieldRow(cf: CustomField) {
    Column({ space: ZSpacing.sm }) {
      // 头行：类型切换 chip 条 + 删除按钮
      Row({ space: ZSpacing.sm }) {
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(CUSTOM_FIELD_TYPES, (tp: CustomFieldType) => {
            this.typeSwitchChip(cf, tp);
          }, (tp: CustomFieldType) => tp);
        }
        .layoutWeight(1);
        Row() {
          Image($r('app.media.ic_trash'))
            .width(15).height(15)
            .fillColor(this.zc.danger);
        }
        .width(32).height(32)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .onClick(() => this.removeCustomField(cf.id));
      }
      .width('100%')
      .alignItems(VerticalAlign.Center);

      // 字段名
      TextInput({ placeholder: '字段名', text: cf.name })
        .placeholderColor(this.zc.text3)
        .placeholderFont({ size: ZType.subheadSize })
        .fontColor(this.zc.text)
        .fontSize(ZType.subheadSize)
        .backgroundColor(this.zc.bg)
        .borderRadius(ZRadius.lg)
        .padding({ left: ZSpacing.md, right: ZSpacing.md })
        .height(40)
        .width('100%')
        .onChange((v: string) => this.updateCustomFieldName(cf.id, v));

      // 值输入：按类型分支
      if (cf.type === 'text') {
        TextInput({ placeholder: '字段值', text: cf.value })
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.subheadSize })
          .fontColor(this.zc.text)
          .fontSize(ZType.subheadSize)
          .backgroundColor(this.zc.bg)
          .borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .height(40)
          .width('100%')
          .onChange((v: string) => this.updateCustomFieldValue(cf.id, v));
      } else if (cf.type === 'hidden') {
        TextInput({ placeholder: '字段值', text: cf.value })
          .type(InputType.Password)
          .placeholderColor(this.zc.text3)
          .placeholderFont({ size: ZType.subheadSize })
          .fontColor(this.zc.text)
          .fontSize(ZType.subheadSize)
          .fontFamily('HarmonyOS Sans Condensed')
          .backgroundColor(this.zc.bg)
          .borderRadius(ZRadius.lg)
          .padding({ left: ZSpacing.md, right: ZSpacing.md })
          .height(40)
          .width('100%')
          .onChange((v: string) => this.updateCustomFieldValue(cf.id, v));
      } else if (cf.type === 'boolean') {
        Row({ space: ZSpacing.md }) {
          Text(cf.boolValue ? '已开启' : '已关闭')
            .fontSize(ZType.subheadSize)
            .fontColor(this.zc.text)
            .layoutWeight(1);
          this.switchTrack(cf.boolValue ?? false);
        }
        .width('100%')
        .height(44)
        .padding({ left: ZSpacing.md, right: ZSpacing.md })
        .backgroundColor(this.zc.bg)
        .borderRadius(ZRadius.lg)
        .alignItems(VerticalAlign.Center)
        .onClick(() => this.toggleCustomFieldBool(cf.id));
      } else {
        // linked
        if (this.linkableForType().length === 0) {
          Text('当前条目类型没有可关联字段')
            .fontSize(ZType.footnoteSize)
            .fontColor(this.zc.text3)
            .width('100%');
        } else {
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.linkableForType(), (k: string) => {
              this.linkedChip(cf, k);
            }, (k: string) => k);
          }
          .width('100%');
        }
      }
    }
    .width('100%')
    .padding(ZSpacing.md)
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl);
  }

  // 类型切换 chip（自定义字段头部）
  @Builder
  typeSwitchChip(cf: CustomField, tp: CustomFieldType) {
    Text(CUSTOM_FIELD_TYPE_LABEL.get(tp) ?? tp)
      .fontSize(ZType.captionSize)
      .fontColor(cf.type === tp ? this.zc.accentInk : this.zc.text2)
      .backgroundColor(cf.type === tp ? this.zc.accent : this.zc.bg)
      .borderRadius(ZRadius.sm)
      .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: 4, bottom: 4 })
      .margin({ right: ZSpacing.xs, bottom: ZSpacing.xs })
      .opacity(tp === 'linked' && this.linkableForType().length === 0 ? 0.4 : 1.0)
      .onClick(() => {
        if (tp === 'linked' && this.linkableForType().length === 0) return;
        this.changeCustomFieldType(cf.id, tp);
      });
  }

  // linked 字段：可关联字段 chip
  @Builder
  linkedChip(cf: CustomField, k: string) {
    Text(k)
      .fontSize(ZType.captionSize)
      .fontColor(cf.value === k ? this.zc.accentInk : this.zc.text2)
      .backgroundColor(cf.value === k ? this.zc.accent : this.zc.bg)
      .borderRadius(ZRadius.sm)
      .padding({ left: ZSpacing.sm, right: ZSpacing.sm, top: 4, bottom: 4 })
      .margin({ right: ZSpacing.xs, bottom: ZSpacing.xs })
      .onClick(() => this.updateCustomFieldValue(cf.id, k));
  }

  // 自绘开关轨道 + 拨钮（与 phone 一致：禁 Toggle 以贯彻 token）
  @Builder
  switchTrack(on: boolean) {
    Row() {
      Row()
        .width(14).height(14)
        .borderRadius(7)
        .backgroundColor(on ? this.zc.accentInk : this.zc.text3)
        .margin({ left: on ? 14 : 2 });
    }
    .width(32).height(18)
    .borderRadius(9)
    .backgroundColor(on ? this.zc.accent : this.zc.bgActive)
    .alignItems(VerticalAlign.Center);
  }

  /* ── 收藏行 ─────────────────────────────────────────────────── */

  @Builder
  favoriteRow() {
    Row({ space: ZSpacing.md }) {
      Row() {
        Image($r('app.media.ic_star'))
          .width(16).height(16)
          .fillColor(this.isFavorite ? this.zc.warn : this.zc.text3);
      }
      .width(32).height(32)
      .borderRadius(ZRadius.sm)
      .backgroundColor(this.isFavorite ? alpha1f(this.zc.warn) : this.zc.bgActive)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center);

      Text('加入收藏')
        .fontSize(ZType.bodySize)
        .fontColor(this.zc.text)
        .layoutWeight(1);

      this.switchTrack(this.isFavorite);
    }
    .width('100%')
    .padding({
      left: ZSpacing.lg,
      right: ZSpacing.lg,
      top: ZSpacing.md,
      bottom: ZSpacing.md,
    })
    .backgroundColor(this.zc.bgElev)
    .borderRadius(ZRadius.xl)
    .alignItems(VerticalAlign.Center)
    .onClick(() => { this.isFavorite = !this.isFavorite; });
  }
}
