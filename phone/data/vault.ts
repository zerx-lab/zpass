// ZPass Phone —— 保险库数据模型与种子数据
//
// 数据结构与 desktop/frontend/src/data/vault.ts 严格对齐：
// 同一套 VaultItem 判别联合（login / card / note / identity / ssh / passkey），
// 同一套 Breach / Activity 模型，保证桌面端与移动端在条目语义上完全一致。
//
// ⚠️ 种子数据为演示用途；接入真实加密后端后由后端下发。

/* ----------------------------------------------------------------------------
 * 类型定义
 * -------------------------------------------------------------------------- */

/** 条目类型 —— 对应分类筛选 */
export type VaultItemType =
  | "login"
  | "card"
  | "note"
  | "identity"
  | "ssh"
  | "passkey";

/** 历史事件类型 */
export type HistoryKind = "used" | "password" | "shared" | "totp" | "created";

export interface HistoryEntry {
  /** 时间戳（毫秒） */
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
}

export interface LoginItem extends BaseItem {
  type: "login";
  username: string;
  password: string;
  url?: string;
  /** TOTP 密钥（base32，可含空格） */
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

export type VaultItem =
  | LoginItem
  | CardItem
  | NoteItem
  | IdentityItem
  | SshItem
  | PasskeyItem;

/** 泄露事件严重等级 */
export type BreachSeverity = "crit" | "high" | "med" | "low";
/** 泄露事件状态 */
export type BreachStatus = "new" | "open" | "clear" | "resolved";

export interface Breach {
  id: string;
  name: string;
  date: string;
  affected: number;
  matched: number;
  severity: BreachSeverity;
  status: BreachStatus;
  data: string[];
  source: string;
  vector: string;
  summary: string;
  /** 匹配到的 vault 条目 id（若无则为 undefined） */
  matchedItem?: string;
}

export type ActivityColor = "ok" | "info" | "warn" | "danger";

export interface ActivityEntry {
  t: string;
  msg: string;
  color: ActivityColor;
}

/* ----------------------------------------------------------------------------
 * 时间工具
 * -------------------------------------------------------------------------- */

const NOW = Date.now();
const days = (d: number) => NOW - d * 24 * 3600 * 1000;

/* ----------------------------------------------------------------------------
 * 条目种子数据（与 desktop ITEMS 对齐）
 * -------------------------------------------------------------------------- */

export const SEED_ITEMS: VaultItem[] = [
  // ----- Logins -----
  {
    id: "i1",
    type: "login",
    name: "GitHub",
    username: "alex.rivera@zpass.dev",
    url: "github.com",
    password: "q7!Nv4zB$eRp2xUmK9wY",
    totp: "JBSW Y3DP EHPK 3PXP",
    strength: 94,
    modified: days(2),
    folder: "Work",
    tags: ["dev", "2fa"],
    notes: "主开发账户，跨 Vercel + Linear SSO。",
    pwHistory: 4,
    breached: false,
    favorite: true,
  },
  {
    id: "i2",
    type: "login",
    name: "Vercel",
    username: "alex@zpass.dev",
    url: "vercel.com",
    password: "Ch#7mPs4Lw8nQtZd",
    totp: "HXDM T3BG JFRT 9WYA",
    strength: 88,
    modified: days(6),
    folder: "Work",
    tags: ["dev", "deploy"],
    pwHistory: 2,
  },
  {
    id: "i3",
    type: "login",
    name: "Stripe",
    username: "ops@zpass.dev",
    url: "dashboard.stripe.com",
    password: "b9HhJ2xD!pRnE6mQs4Cv",
    totp: "QWER TYUI OPAS DFGH",
    strength: 96,
    modified: days(14),
    folder: "Work",
    tags: ["payments"],
    notes: "生产仪表盘，谨慎操作。",
    pwHistory: 1,
  },
  {
    id: "i4",
    type: "login",
    name: "Linear",
    username: "alex.rivera@zpass.dev",
    url: "linear.app",
    password: "trustno1!",
    strength: 28,
    modified: days(412),
    folder: "Work",
    tags: ["dev"],
    breached: true,
    reused: true,
    weak: true,
    notes: "需要轮换，上次修改在一年前。",
  },
  {
    id: "i5",
    type: "login",
    name: "Figma",
    username: "alex@zpass.dev",
    url: "figma.com",
    password: "8Vc@r2PkN#5tLqWsYbE7",
    strength: 92,
    modified: days(30),
    folder: "Work",
    tags: ["design"],
  },
  {
    id: "i6",
    type: "login",
    name: "Notion",
    username: "alex.rivera@zpass.dev",
    url: "notion.so",
    password: "summer2024!",
    strength: 34,
    modified: days(220),
    folder: "Personal",
    tags: [],
    reused: true,
    weak: true,
  },
  {
    id: "i7",
    type: "login",
    name: "AWS Console",
    username: "alex-admin",
    url: "console.aws.amazon.com",
    password: "R3&mKp9qL!x2NvBcF4Hs",
    totp: "AAAA BBBB CCCC DDDD",
    strength: 98,
    modified: days(4),
    folder: "Work",
    tags: ["infra", "prod", "2fa"],
    notes: "强制 MFA，禁止共享。",
    favorite: true,
  },
  {
    id: "i8",
    type: "login",
    name: "Slack",
    username: "alex@zpass.dev",
    url: "zpass.slack.com",
    password: "Kw3!nPqR8sVxZ2mBfYtG",
    strength: 90,
    modified: days(10),
    folder: "Work",
    tags: ["comms"],
  },
  {
    id: "i9",
    type: "login",
    name: "X / Twitter",
    username: "@alexrivera",
    url: "x.com",
    password: "L9#mQbKs2pXvRwN4ZhJc",
    strength: 86,
    modified: days(45),
    folder: "Personal",
    tags: [],
  },
  {
    id: "i10",
    type: "login",
    name: "Google",
    username: "alex.rivera.zpass@gmail.com",
    url: "google.com",
    password: "P5@kLqR9tSv2nXmBwY8H",
    totp: "ZXCV BNMA SDFG HJKL",
    strength: 93,
    modified: days(18),
    folder: "Personal",
    tags: ["2fa"],
  },
  {
    id: "i11",
    type: "login",
    name: "Cloudflare",
    username: "ops@zpass.dev",
    url: "dash.cloudflare.com",
    password: "N8!kPwQ3rLv6mXsBdYcF",
    strength: 91,
    modified: days(22),
    folder: "Work",
    tags: ["infra", "dns"],
  },
  {
    id: "i12",
    type: "login",
    name: "OpenAI",
    username: "alex@zpass.dev",
    url: "platform.openai.com",
    password: "H4#qRpK8mLv2nXwBsTcY",
    strength: 89,
    modified: days(12),
    folder: "Work",
    tags: ["api"],
  },
  {
    id: "i13",
    type: "login",
    name: "Anthropic",
    username: "alex@zpass.dev",
    url: "console.anthropic.com",
    password: "T6!nPqK3rLv9mXsBwYcH",
    strength: 93,
    modified: days(8),
    folder: "Work",
    tags: ["api"],
  },
  {
    id: "i14",
    type: "login",
    name: "Proton Mail",
    username: "alex.rivera@proton.me",
    url: "proton.me",
    password: "V2#kPqR8mLnXsBwYcH4tF",
    strength: 95,
    modified: days(60),
    folder: "Personal",
    tags: ["mail"],
  },
  {
    id: "i15",
    type: "login",
    name: "Supabase",
    username: "alex@zpass.dev",
    url: "supabase.com",
    password: "J7!kPqR3mLv8nXsBwYcH",
    strength: 87,
    modified: days(16),
    folder: "Work",
    tags: ["db"],
  },
  {
    id: "i16",
    type: "login",
    name: "Digital Ocean",
    username: "alex@zpass.dev",
    url: "cloud.digitalocean.com",
    password: "Z4#nPqK8rLv2mXsBwYcH",
    strength: 88,
    modified: days(90),
    folder: "Work",
    tags: ["infra"],
  },

  // ----- Cards -----
  {
    id: "c1",
    type: "card",
    name: "Chase Sapphire",
    cardholder: "Alex Rivera",
    number: "4532 9921 1847 3309",
    exp: "08/29",
    cvv: "421",
    pin: "4921",
    brand: "Visa",
    modified: days(90),
    folder: "Personal",
    notes: "主力旅行卡。",
  },
  {
    id: "c2",
    type: "card",
    name: "Amex Platinum",
    cardholder: "Alex Rivera",
    number: "3782 822463 10005",
    exp: "11/27",
    cvv: "2931",
    brand: "Amex",
    modified: days(120),
    folder: "Personal",
  },
  {
    id: "c3",
    type: "card",
    name: "Brex Business",
    cardholder: "ZPass Labs Inc",
    number: "5412 7512 8821 4421",
    exp: "03/28",
    cvv: "118",
    brand: "Mastercard",
    modified: days(40),
    folder: "Work",
  },

  // ----- Notes -----
  {
    id: "n1",
    type: "note",
    name: "WiFi — 家庭办公",
    note: "SSID: rivera-mesh-5g\n密码: QuietRaven-71-Bench\n访客: rivera-guest / welcome2024",
    modified: days(180),
    folder: "Personal",
  },
  {
    id: "n2",
    type: "note",
    name: "保险箱密码",
    note: "◼ ◼ ◼ — ◼ ◼ — ◼ ◼ ◼\n上次轮换 2024-11-03\n紧急联系人: Maria（见身份信息）",
    modified: days(60),
    folder: "Personal",
  },
  {
    id: "n3",
    type: "note",
    name: "生产数据库手册",
    note: "主库: db-us-east-1.zpass.internal\n只读副本: 3\n值班: pager-duty 轮换\n备份窗口: 03:00–04:00 UTC",
    modified: days(7),
    folder: "Work",
  },

  // ----- Identities -----
  {
    id: "id1",
    type: "identity",
    name: "Alex Rivera — 主身份",
    first: "Alex",
    last: "Rivera",
    email: "alex.rivera@zpass.dev",
    phone: "+1 (415) 555-0134",
    address: "228 Valencia St, San Francisco CA 94103",
    dob: "1991-04-22",
    passport: "N52901837",
    modified: days(200),
    folder: "Personal",
  },

  // ----- SSH / API tokens -----
  {
    id: "s1",
    type: "ssh",
    name: "github-ed25519",
    username: "alex@ZPass-MBP",
    keyType: "ed25519",
    fingerprint: "SHA256:Ux9mNqV2bPk8rL3nXsBwYcHtJ4FmQp6KdR8vE2aG",
    publicKey:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHjfGzJ8mQk2rLnXsBwYcHtF4p alex@ZPass-MBP",
    modified: days(45),
    folder: "Work",
    tags: ["dev"],
  },
  {
    id: "s2",
    type: "ssh",
    name: "aws-prod-rsa",
    username: "ops@zpass",
    keyType: "rsa-4096",
    fingerprint: "SHA256:Kp4mPqR8nLv2mXsBwYcHtF3Jx6Qz9RdT2vE5aG",
    publicKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ... ops@zpass-prod",
    modified: days(120),
    folder: "Work",
    tags: ["prod"],
  },
  {
    id: "s3",
    type: "ssh",
    name: "Stripe API token",
    apiKey: "sk_live_51Nq••••••••••••••••••••••••••••••••••••••••••••••••••",
    modified: days(10),
    folder: "Work",
    tags: ["api", "prod"],
  },

  // ----- Passkeys -----
  {
    id: "pk1",
    type: "passkey",
    name: "GitHub Passkey",
    rpId: "github.com",
    userName: "alex.rivera@zpass.dev",
    credentialId: "AQID-credential-z9k2",
    modified: days(20),
    folder: "Work",
    tags: ["dev"],
  },
];

/* ----------------------------------------------------------------------------
 * Breach feed —— 泄露事件情报流
 * -------------------------------------------------------------------------- */

export const SEED_BREACHES: Breach[] = [
  {
    id: "b0",
    name: "linear.app",
    date: "2026-04-14",
    affected: 184000,
    matched: 1,
    severity: "crit",
    status: "new",
    data: ["email", "password", "session token"],
    source: "HIBP",
    matchedItem: "i4",
    vector: "OAuth token leak",
    summary: "S3 配置错误导致会话令牌泄露，建议强制登出。",
  },
  {
    id: "b4",
    name: "twitter.com",
    date: "2026-04-02",
    affected: 209_000_000,
    matched: 1,
    severity: "crit",
    status: "open",
    data: ["email", "phone", "handle"],
    source: "HIBP",
    matchedItem: "i9",
    vector: "API scraping",
    summary: "通过 API 漏洞 CVE-2023-5512 重建账户关系图。",
  },
  {
    id: "b1",
    name: "notion.so",
    date: "2026-03-28",
    affected: 590000,
    matched: 1,
    severity: "high",
    status: "open",
    data: ["email", "workspace"],
    source: "internal",
    matchedItem: "i6",
    vector: "Third-party integration",
    summary: "Zapier 连接器凭据复用，你的 Notion 登录使用了重复密码。",
  },
  {
    id: "b5",
    name: "duolingo.com",
    date: "2026-02-17",
    affected: 2_600_000,
    matched: 0,
    severity: "med",
    status: "clear",
    data: ["email", "name"],
    source: "HIBP",
    vector: "API scraping",
    summary: "公开 API 允许邮箱枚举，未泄露密码数据。",
  },
  {
    id: "b3",
    name: "linkedin.com",
    date: "2025-11-05",
    affected: 164_000_000,
    matched: 1,
    severity: "med",
    status: "resolved",
    data: ["email", "hashed password"],
    source: "HIBP",
    vector: "SQL injection",
    summary: "历史泄露重现，检测后密码已轮换。",
  },
  {
    id: "b2",
    name: "dropbox.com",
    date: "2024-08-12",
    affected: 68_700_000,
    matched: 0,
    severity: "low",
    status: "resolved",
    data: ["email"],
    source: "HIBP",
    vector: "Credential stuffing",
    summary: "历史泄露，邮箱出现，但无 ZPass 条目使用此凭据。",
  },
];

/* ----------------------------------------------------------------------------
 * 近期活动
 * -------------------------------------------------------------------------- */

export const SEED_ACTIVITY: ActivityEntry[] = [
  { t: "2 分钟前", msg: "在 github.com 自动填充 GitHub", color: "ok" },
  { t: "14 分钟前", msg: "复制 AWS Console 的验证码", color: "info" },
  { t: "1 小时前", msg: "为 Stripe 轮换密码", color: "ok" },
  { t: "3 小时前", msg: "新设备已同步：iPad Pro", color: "warn" },
  { t: "昨天", msg: "检测到泄露：twitter.com", color: "danger" },
  { t: "2 天前", msg: "已导出加密保险库备份", color: "info" },
];
