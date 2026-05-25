// ZPass Phone —— 保险库数据模型
//
// 模型与 desktop ItemPayload + 前端 VaultItem 对齐。包含 7 种条目类型：
//   login / card / note / identity / ssh / passkey / totp
//
// 无任何种子数据 —— 真实加密 vault 由用户首次设置主密码后产生。

import type { CustomField } from "@/lib/custom-fields";

/* ----------------------------------------------------------------------------
 * 条目类型
 * -------------------------------------------------------------------------- */

export type VaultItemType =
  | "login"
  | "card"
  | "note"
  | "identity"
  | "ssh"
  | "passkey"
  | "totp";

/** 历史事件类型 —— 当前未持久化，留作未来扩展 */
export type HistoryKind = "used" | "password" | "shared" | "totp" | "created";

export interface HistoryEntry {
  t: number;
  kind: HistoryKind;
  who: string;
  where: string;
  detail: string;
}

/** 条目共有字段 */
export interface BaseItem {
  id: string;
  name: string;
  type: VaultItemType;
  /** 最后修改时间（毫秒时间戳） */
  modified: number;
  folder?: string;
  tags?: string[];
  notes?: string;
  /** 是否收藏 */
  favorite?: boolean;
  /**
   * 自定义字段 —— 与 desktop `_customFields` 约定对齐：
   * 持久化到 fields["_customFields"]，反序列化时回填到此处。
   */
  customFields?: CustomField[];
  /**
   * 所属空间 id —— 与 lib/spaces.ts 中的 Space.id 对应。
   * 兼容性：未持久化该字段的旧 item 视为属于 DEFAULT_SPACE_ID。
   */
  spaceId?: string;
}

export interface LoginItem extends BaseItem {
  type: "login";
  username: string;
  password: string;
  url?: string;
  /** 兼容字段：login 也可携带 totp 密钥（与独立 totp 条目共存） */
  totp?: string;
  strength?: number;
  pwHistory?: number;
  breached?: boolean;
  reused?: boolean;
  weak?: boolean;
  history?: HistoryEntry[];
}

export interface CardItem extends BaseItem {
  type: "card";
  cardholder: string;
  number: string;
  exp: string;
  cvv: string;
  pin?: string;
  brand: string;
}

export interface NoteItem extends BaseItem {
  type: "note";
  note: string;
}

export interface IdentityItem extends BaseItem {
  type: "identity";
  first: string;
  last: string;
  email: string;
  phone: string;
  address: string;
  dob: string;
  passport: string;
}

export interface SshItem extends BaseItem {
  type: "ssh";
  username?: string;
  keyType?: string;
  fingerprint?: string;
  publicKey?: string;
  /** 仅 API token 条目使用 */
  apiKey?: string;
}

export interface PasskeyItem extends BaseItem {
  type: "passkey";
  rpId: string;
  userName?: string;
  credentialId: string;
}

/**
 * 独立验证器条目（不与 login 耦合的 TOTP 账户）
 *
 * 与 login.totp 的关系：
 *   - login 类型可携带 totp 密钥（密码 + 二步一站式管理）
 *   - totp 类型用于"仅扫码登录 / 密码托管在别处"的纯 OTP 场景
 *   - "验证码"视图同时呈现两类来源
 */
export interface TotpItem extends BaseItem {
  type: "totp";
  /** TOTP 密钥（base32，可含空格） */
  secret: string;
  /** 发行者（可选，如 GitHub / Google） */
  issuer?: string;
  /** 账户标识（可选，邮箱 / 用户名） */
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
