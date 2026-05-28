// ZPass HarmonyOS —— 保险库数据模型
//
// 与 desktop ItemPayload + phone VaultItem 对齐。包含 7 种条目类型：
//   login / card / note / identity / ssh / passkey / totp
//
// 注意：ArkTS strict 禁用 `Object.create(null)` 与 `delete` 运算符，因此原本
// 提供的 emptyFields / cloneFields / setBool 等 helper 已删除。运行时所有
// fields 操作都走 vaultService（其内部直接走 Record<string, Object>）。

import type { CustomField } from '../lib/CustomFields';

export type VaultItemType =
  | 'login'
  | 'card'
  | 'note'
  | 'identity'
  | 'ssh'
  | 'passkey'
  | 'totp';

/** Item fields —— 字符串键值对（仅供类型层引用；ArkTS 下不构造字面量） */
export type ItemFields = Record<string, string>;

export type HistoryKind = 'used' | 'password' | 'shared' | 'totp' | 'created';

export interface HistoryEntry {
  t: number;
  kind: HistoryKind;
  who: string;
  where: string;
  detail: string;
}

export interface BaseItem {
  id: string;
  name: string;
  type: VaultItemType;
  modified: number;
  folder?: string;
  tags?: string[];
  notes?: string;
  favorite?: boolean;
  customFields?: CustomField[];
  spaceId?: string;
  deletedAt?: number;
  revision?: number;
}

export interface LoginItem extends BaseItem {
  type: 'login';
  username: string;
  password: string;
  url?: string;
  totp?: string;
  strength?: number;
  pwHistory?: number;
  breached?: boolean;
  reused?: boolean;
  weak?: boolean;
  history?: HistoryEntry[];
}

export interface CardItem extends BaseItem {
  type: 'card';
  cardholder: string;
  number: string;
  exp: string;
  cvv: string;
  pin?: string;
  brand: string;
}

export interface NoteItem extends BaseItem {
  type: 'note';
  note: string;
}

export interface IdentityItem extends BaseItem {
  type: 'identity';
  first: string;
  last: string;
  email: string;
  phone: string;
  address: string;
  dob: string;
  passport: string;
}

export interface SshItem extends BaseItem {
  type: 'ssh';
  username?: string;
  keyType?: string;
  fingerprint?: string;
  publicKey?: string;
  apiKey?: string;
}

export interface PasskeyItem extends BaseItem {
  type: 'passkey';
  rpId: string;
  userName?: string;
  credentialId: string;
}

export interface TotpItem extends BaseItem {
  type: 'totp';
  secret: string;
  issuer?: string;
  account?: string;
}

export type VaultItem =
  | LoginItem
  | CardItem
  | NoteItem
  | IdentityItem
  | SshItem
  | PasskeyItem
  | TotpItem;
