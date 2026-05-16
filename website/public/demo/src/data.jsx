// Mock vault data

const NOW = Date.now();
const days = d => NOW - d * 24 * 3600 * 1000;

// Monochrome favicons — just a letter mark per site
const FAVICONS = {
  github: { t: 'GH' },
  google: { t: 'GO' },
  figma:  { t: 'FG' },
  linear: { t: 'LN' },
  notion: { t: 'NT' },
  vercel: { t: 'VC' },
  stripe: { t: 'ST' },
  aws:    { t: 'AW' },
  slack:  { t: 'SL' },
  x:      { t: 'X' },
  cloud:  { t: 'CF' },
  openai: { t: 'OA' },
  anthropic: { t: 'AN' },
  proton: { t: 'PM' },
  digitalocean: { t: 'DO' },
  supabase: { t: 'SB' },
};

const ITEMS = [
  {
    id: 'i1', type: 'login', name: 'GitHub', username: 'alex.rivera@zpass.dev',
    url: 'github.com', password: 'q7!Nv4zB$eRp2xUmK9wY', fav: 'github',
    totp: 'JBSW Y3DP EHPK 3PXP', strength: 94, modified: days(2), folder: 'Work',
    tags: ['dev', '2fa'], notes: 'Primary dev account. Has SSO across Vercel + Linear.',
    pwHistory: 4, breached: false,
    history: [
      { t: days(2),   kind: 'used',     who: 'macbook-pro · Safari',    where: 'github.com/settings',    detail: 'Autofilled' },
      { t: days(9),   kind: 'password', who: 'macbook-pro · ZPass',     where: 'Generated · 20 chars',    detail: 'Rotated from "Nv4zB$...K9w1"' },
      { t: days(14),  kind: 'used',     who: 'iphone 15 pro · Safari',  where: 'github.com/login',        detail: 'Face ID autofill' },
      { t: days(31),  kind: 'shared',   who: 'alex → maria@zpass.dev',  where: 'read-only · 30 days',     detail: 'Expires in 7 days' },
      { t: days(62),  kind: 'totp',     who: 'macbook-pro · ZPass',     where: 'TOTP added',              detail: 'JBSW Y3DP EHPK 3PXP' },
      { t: days(180), kind: 'password', who: 'macbook-pro · ZPass',     where: 'Generated · 18 chars',    detail: 'Rotated from "alex-github-2024"' },
      { t: days(412), kind: 'created',  who: 'macbook-pro · ZPass',     where: 'github.com',              detail: 'Item created from autofill' },
    ],
    travel: 'safe',
  },
  {
    id: 'i2', type: 'login', name: 'Vercel', username: 'alex@zpass.dev',
    url: 'vercel.com', password: 'Ch#7mPs4Lw8nQtZd', fav: 'vercel',
    totp: 'HXDM T3BG JFRT 9WYA', strength: 88, modified: days(6), folder: 'Work',
    tags: ['dev', 'deploy'], notes: '', pwHistory: 2,
    travel: 'safe',
  },
  {
    id: 'i3', type: 'login', name: 'Stripe', username: 'ops@zpass.dev',
    url: 'dashboard.stripe.com', password: 'b9HhJ2xD!pRnE6mQs4Cv', fav: 'stripe',
    totp: 'QWER TYUI OPAS DFGH', strength: 96, modified: days(14), folder: 'Work',
    tags: ['payments'], notes: 'Production dashboard. Handle with care.', pwHistory: 1,
    travel: 'hidden',
  },
  {
    id: 'i4', type: 'login', name: 'Linear', username: 'alex.rivera@zpass.dev',
    url: 'linear.app', password: 'trustno1!', fav: 'linear',
    strength: 28, modified: days(412), folder: 'Work',
    tags: ['dev'], breached: true, reused: true, weak: true,
    notes: 'Needs rotation. Last changed over a year ago.',
    travel: 'safe',
  },
  {
    id: 'i5', type: 'login', name: 'Figma', username: 'alex@zpass.dev',
    url: 'figma.com', password: '8Vc@r2PkN#5tLqWsYbE7', fav: 'figma',
    strength: 92, modified: days(30), folder: 'Work',
    tags: ['design'], notes: '',
    travel: 'safe',
  },
  {
    id: 'i6', type: 'login', name: 'Notion', username: 'alex.rivera@zpass.dev',
    url: 'notion.so', password: 'summer2024!', fav: 'notion',
    strength: 34, modified: days(220), folder: 'Personal',
    tags: [], reused: true, weak: true, notes: '',
    travel: 'safe',
  },
  {
    id: 'i7', type: 'login', name: 'AWS Console', username: 'alex-admin',
    url: 'console.aws.amazon.com', password: 'R3&mKp9qL!x2NvBcF4Hs', fav: 'aws',
    totp: 'AAAA BBBB CCCC DDDD', strength: 98, modified: days(4), folder: 'Work',
    tags: ['infra', 'prod', '2fa'], notes: 'MFA enforced. Do not share.',
    travel: 'hidden',
  },
  {
    id: 'i8', type: 'login', name: 'Slack', username: 'alex@zpass.dev',
    url: 'zpass.slack.com', password: 'Kw3!nPqR8sVxZ2mBfYtG', fav: 'slack',
    strength: 90, modified: days(10), folder: 'Work', tags: ['comms'], notes: '',
    travel: 'safe',
  },
  {
    id: 'i9', type: 'login', name: 'X / Twitter', username: '@alexrivera',
    url: 'x.com', password: 'L9#mQbKs2pXvRwN4ZhJc', fav: 'x',
    strength: 86, modified: days(45), folder: 'Personal', tags: [], notes: '',
    travel: 'safe',
  },
  {
    id: 'i10', type: 'login', name: 'Google', username: 'alex.rivera.zpass@gmail.com',
    url: 'google.com', password: 'P5@kLqR9tSv2nXmBwY8H', fav: 'google',
    totp: 'ZXCV BNMA SDFG HJKL', strength: 93, modified: days(18), folder: 'Personal', tags: ['2fa'], notes: '',
    travel: 'safe',
  },
  {
    id: 'i11', type: 'login', name: 'Cloudflare', username: 'ops@zpass.dev',
    url: 'dash.cloudflare.com', password: 'N8!kPwQ3rLv6mXsBdYcF', fav: 'cloud',
    strength: 91, modified: days(22), folder: 'Work', tags: ['infra', 'dns'], notes: '',
    travel: 'safe',
  },
  {
    id: 'i12', type: 'login', name: 'OpenAI', username: 'alex@zpass.dev',
    url: 'platform.openai.com', password: 'H4#qRpK8mLv2nXwBsTcY', fav: 'openai',
    strength: 89, modified: days(12), folder: 'Work', tags: ['api'], notes: '',
    travel: 'safe',
  },
  {
    id: 'i13', type: 'login', name: 'Anthropic', username: 'alex@zpass.dev',
    url: 'console.anthropic.com', password: 'T6!nPqK3rLv9mXsBwYcH', fav: 'anthropic',
    strength: 93, modified: days(8), folder: 'Work', tags: ['api'], notes: '',
    travel: 'safe',
  },
  {
    id: 'i14', type: 'login', name: 'Proton Mail', username: 'alex.rivera@proton.me',
    url: 'proton.me', password: 'V2#kPqR8mLnXsBwYcH4tF', fav: 'proton',
    strength: 95, modified: days(60), folder: 'Personal', tags: ['mail'], notes: '',
    travel: 'safe',
  },
  {
    id: 'i15', type: 'login', name: 'Supabase', username: 'alex@zpass.dev',
    url: 'supabase.com', password: 'J7!kPqR3mLv8nXsBwYcH', fav: 'supabase',
    strength: 87, modified: days(16), folder: 'Work', tags: ['db'], notes: '',
    travel: 'safe',
  },
  {
    id: 'i16', type: 'login', name: 'Digital Ocean', username: 'alex@zpass.dev',
    url: 'cloud.digitalocean.com', password: 'Z4#nPqK8rLv2mXsBwYcH', fav: 'digitalocean',
    strength: 88, modified: days(90), folder: 'Work', tags: ['infra'], notes: '',
    travel: 'safe',
  },

  // Cards
  {
    id: 'c1', type: 'card', name: 'Chase Sapphire', cardholder: 'Alex Rivera',
    number: '4532 9921 1847 3309', exp: '08/29', cvv: '421', pin: '4921',
    brand: 'Visa', modified: days(90), folder: 'Personal',
    notes: 'Primary travel card.',
    travel: 'hidden',
  },
  {
    id: 'c2', type: 'card', name: 'Amex Platinum', cardholder: 'Alex Rivera',
    number: '3782 822463 10005', exp: '11/27', cvv: '2931',
    brand: 'Amex', modified: days(120), folder: 'Personal',
    travel: 'hidden',
  },
  {
    id: 'c3', type: 'card', name: 'Brex Business', cardholder: 'ZPass Labs Inc',
    number: '5412 7512 8821 4421', exp: '03/28', cvv: '118',
    brand: 'Mastercard', modified: days(40), folder: 'Work',
    travel: 'hidden',
  },

  // Notes
  {
    id: 'n1', type: 'note', name: 'WiFi — Home Office',
    note: 'SSID: rivera-mesh-5g\nPassword: QuietRaven-71-Bench\nGuest: rivera-guest / welcome2024',
    modified: days(180), folder: 'Personal',
    travel: 'safe',
  },
  {
    id: 'n2', type: 'note', name: 'Safe combination',
    note: '◼ ◼ ◼ — ◼ ◼ — ◼ ◼ ◼\nLast rotated 2024-11-03\nEmergency contact: Maria (see identity)',
    modified: days(60), folder: 'Personal',
    travel: 'safe',
  },
  {
    id: 'n3', type: 'note', name: 'Production DB runbook',
    note: 'Primary: db-us-east-1.zpass.internal\nReadonly replicas: 3\nOn-call: pager-duty rotation\nBackup window: 03:00–04:00 UTC',
    modified: days(7), folder: 'Work',
    travel: 'safe',
  },

  // Identities
  {
    id: 'id1', type: 'identity', name: 'Alex Rivera — Primary',
    first: 'Alex', last: 'Rivera',
    email: 'alex.rivera@zpass.dev', phone: '+1 (415) 555-0134',
    address: '228 Valencia St, San Francisco CA 94103',
    dob: '1991-04-22', passport: 'N52901837',
    modified: days(200), folder: 'Personal',
    travel: 'hidden',
  },

  // SSH
  {
    id: 's1', type: 'ssh', name: 'github-ed25519', username: 'alex@ZPass-MBP',
    keyType: 'ed25519', fingerprint: 'SHA256:Ux9mNqV2bPk8rL3nXsBwYcHtJ4FmQp6KdR8vE2aG',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHjfGzJ8mQk2rLnXsBwYcHtF4p alex@ZPass-MBP',
    modified: days(45), folder: 'Work', tags: ['dev'],
    travel: 'safe',
  },
  {
    id: 's2', type: 'ssh', name: 'aws-prod-rsa', username: 'ops@zpass',
    keyType: 'rsa-4096', fingerprint: 'SHA256:Kp4mPqR8nLv2mXsBwYcHtF3Jx6Qz9RdT2vE5aG',
    publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ... ops@zpass-prod',
    modified: days(120), folder: 'Work', tags: ['prod'],
    travel: 'hidden',
  },
  {
    id: 's3', type: 'ssh', name: 'Stripe API token',
    apiKey: 'sk_live_51Nq••••••••••••••••••••••••••••••••••••••••••••••••••',
    modified: days(10), folder: 'Work', tags: ['api', 'prod'],
    travel: 'hidden',
  },

  // Crypto
  {
    id: 'w1', type: 'wallet', name: 'Ledger — Main',
    seedHint: '24 words · BIP39',
    seed: 'brave ocean forest magnet ladder silver glove token crystal wheel echo marble ribbon quiet pyramid orange breeze panel harbor vault lumber emerald velvet kindle',
    modified: days(365), folder: 'Personal', tags: ['hardware'],
    travel: 'hidden',
  },
  {
    id: 'w2', type: 'wallet', name: 'MetaMask — DeFi',
    seedHint: '12 words · BIP39',
    seed: 'lunar pepper island cedar ribbon planet velvet quartz harbor mango ember twilight',
    modified: days(180), folder: 'Personal',
    travel: 'hidden',
  },
];

// Breach feed — live rolling intel stream
const BREACHES = [
  {
    id: 'b0', name: 'linear.app', date: '2026-04-14', affected: 184000, matched: 1,
    severity: 'crit', status: 'new', data: ['email', 'password', 'session token'],
    source: 'HIBP', matchedItem: 'i4', vector: 'OAuth token leak',
    summary: 'Session tokens exposed via misconfigured S3 bucket. Forced logout recommended.',
  },
  {
    id: 'b4', name: 'twitter.com', date: '2026-04-02', affected: 209000000, matched: 1,
    severity: 'crit', status: 'open', data: ['email', 'phone', 'handle'],
    source: 'HIBP', matchedItem: 'i9', vector: 'API scraping',
    summary: 'Scraped account graph reconstructed from API vulnerability CVE-2023-5512.',
  },
  {
    id: 'b1', name: 'notion.so', date: '2026-03-28', affected: 590000, matched: 1,
    severity: 'high', status: 'open', data: ['email', 'workspace'],
    source: 'internal', matchedItem: 'i6', vector: 'Third-party integration',
    summary: 'Zapier connector credential reuse. Your Notion login uses a reused password.',
  },
  {
    id: 'b5', name: 'duolingo.com', date: '2026-02-17', affected: 2600000, matched: 0,
    severity: 'med', status: 'clear', data: ['email', 'name'],
    source: 'HIBP', vector: 'API scraping',
    summary: 'Public API allowed email enumeration. No password data exposed.',
  },
  {
    id: 'b3', name: 'linkedin.com', date: '2025-11-05', affected: 164000000, matched: 1,
    severity: 'med', status: 'resolved', data: ['email', 'hashed password'],
    source: 'HIBP', vector: 'SQL injection',
    summary: 'Legacy breach rehash. Your password was rotated after detection.',
  },
  {
    id: 'b2', name: 'dropbox.com', date: '2024-08-12', affected: 68700000, matched: 0,
    severity: 'low', status: 'resolved', data: ['email'],
    source: 'HIBP', vector: 'Credential stuffing',
    summary: 'Historical breach. Email appears; no ZPass item uses this credential.',
  },
];

// Recent activity
const ACTIVITY = [
  { t: '2 min ago', msg: 'Autofilled GitHub on github.com', color: 'ok' },
  { t: '14 min ago', msg: 'Copied TOTP for AWS Console', color: 'info' },
  { t: '1 hr ago', msg: 'Password rotated for Stripe', color: 'ok' },
  { t: '3 hr ago', msg: 'New device synced: iPad Pro', color: 'warn' },
  { t: 'yesterday', msg: 'Breach detected: twitter.com', color: 'danger' },
  { t: '2 days ago', msg: 'Exported encrypted vault backup', color: 'info' },
];

window.ZPASS_DATA = { ITEMS, BREACHES, ACTIVITY, FAVICONS };
