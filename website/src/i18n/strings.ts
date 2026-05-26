// ZPass 官网 i18n 字符串
// 内容移植自 ZPassDesign/src/site/site-i18n.jsx，扩展为强类型 TS 模块。
// 在页面与组件中通过 `getStrings(locale)` 获取对应语言文案。

/** ZPass 官方 GitHub 仓库（Nav / Footer / README 等多处引用，集中在此避免不一致） */
export const GITHUB_URL = "https://github.com/zerx-lab/zpass";

export type Locale = "en" | "zh";

export interface PriceTier {
	name: string;
	price: string;
	unit: string;
	bullets: string[];
	cta: string;
}

export interface SiteStrings {
	// nav
	nav_features: string;
	nav_security: string;
	nav_download: string;
	nav_pricing: string;
	nav_docs: string;
	nav_signin: string;
	nav_demo: string;
	nav_how: string;
	nav_faq: string;

	// hero
	hero_eyebrow: string;
	hero_title_1: string;
	hero_title_2: string;
	hero_sub: string;
	hero_cta_primary: string;
	hero_availability: string;

	// release / download（取代原 “即将发布” 状态卡）
	release_eyebrow: string;
	release_title: string;
	release_sub: string;
	release_note: string;

	// 下载卡片通用文案
	download_section_label: string;
	download_recommended: string;
	download_more_variants: string;
	download_release_notes: string;
	download_ios_title: string;
	download_ios_note: string;
	download_verify_hint: string;

	// features
	section_features: string;
	section_features_sub: string;
	f1_title: string;
	f1_body: string;
	f2_title: string;
	f2_body: string;
	f3_title: string;
	f3_body: string;
	f4_title: string;
	f4_body: string;
	f5_title: string;
	f5_body: string;
	f6_title: string;
	f6_body: string;

	// how
	section_how: string;
	section_how_sub: string;
	how_1_title: string;
	how_1_body: string;
	how_2_title: string;
	how_2_body: string;
	how_3_title: string;
	how_3_body: string;
	how_kicker: string;

	// mobile
	section_mobile: string;
	section_mobile_sub: string;
	mobile_eyebrow: string;
	mobile_headline: string;
	mobile_body: string;
	mobile_status_ios: string;
	mobile_status_android: string;
	mobile_status_autofill: string;
	mobile_phone_kicker: string;
	mobile_phone_greeting: string;

	// live demo 框头部
	live_frame_status: string;

	// desktop（PC 客户端演示区块）
	section_desktop: string;
	section_desktop_sub: string;
	desktop_eyebrow: string;
	desktop_headline: string;
	desktop_body: string;
	desktop_status_macos: string;
	desktop_status_windows: string;
	desktop_status_linux: string;
	desktop_status_extra: string;
	desktop_section_label: string;
	// 客户端 UI 内嵌静态文案
	desktop_ui_brand_tag: string;
	desktop_ui_workspace: string;
	desktop_ui_categories: string;
	desktop_ui_folders: string;
	desktop_ui_nav_all: string;
	desktop_ui_nav_generator: string;
	desktop_ui_nav_health: string;
	desktop_ui_nav_logins: string;
	desktop_ui_nav_cards: string;
	desktop_ui_nav_notes: string;
	desktop_ui_nav_identity: string;
	desktop_ui_nav_ssh: string;
	desktop_ui_nav_wallet: string;
	desktop_ui_nav_work: string;
	desktop_ui_nav_personal: string;
	desktop_ui_crumb_root: string;
	desktop_ui_search_placeholder: string;
	desktop_ui_new_item: string;
	desktop_ui_list_title: string;
	desktop_ui_list_recent: string;
	desktop_ui_chip_all: string;
	desktop_ui_chip_logins: string;
	desktop_ui_chip_cards: string;
	desktop_ui_chip_notes: string;
	desktop_ui_chip_identity: string;
	desktop_ui_meta_username: string;
	desktop_ui_meta_password: string;
	desktop_ui_meta_website: string;
	desktop_ui_section_credentials: string;
	desktop_ui_section_strength: string;
	desktop_ui_section_totp: string;
	desktop_ui_strength_length: string;
	desktop_ui_strength_entropy: string;
	desktop_ui_strength_crack: string;
	desktop_ui_strength_reuse: string;
	desktop_ui_strength_crack_value: string;
	desktop_ui_strength_reuse_value: string;
	desktop_ui_strength_label: string;
	desktop_ui_btn_fav: string;
	desktop_ui_btn_share: string;
	desktop_ui_btn_edit: string;
	desktop_ui_row_2d_ago: string;
	desktop_ui_row_6d_ago: string;
	desktop_ui_row_14d_ago: string;
	desktop_ui_row_1y_ago: string;

	// security
	section_security: string;
	section_security_sub: string;
	sec_1_k: string;
	sec_1_v: string;
	sec_2_k: string;
	sec_2_v: string;
	sec_3_k: string;
	sec_3_v: string;
	sec_4_k: string;
	sec_4_v: string;
	sec_5_k: string;
	sec_5_v: string;
	sec_6_k: string;
	sec_6_v: string;
	audits_label: string;
	audit_1_firm: string;
	audit_1_meta: string;
	audit_2_firm: string;
	audit_2_meta: string;
	audit_3_firm: string;
	audit_3_meta: string;

	// pricing
	section_pricing: string;
	section_pricing_sub: string;
	pricing_solo: PriceTier;
	pricing_personal: PriceTier;
	pricing_family: PriceTier;
	pricing_team: PriceTier;

	// changelog / roadmap
	section_changelog: string;
	section_changelog_sub: string;
	// 路线图标签文案（按语义键复用,顺序对应 Changelog.astro 中的 build/plan/next）
	roadmap_tag_building: string;
	roadmap_tag_planned: string;
	roadmap_tag_review: string;
	roadmap_tag_later: string;
	// 时间窗口短语
	roadmap_window_in_progress: string;
	roadmap_window_next: string;
	roadmap_window_before_launch: string;
	roadmap_window_later: string;
	// 路线图各阶段说明（M01..M06）
	roadmap_m01_notes: string;
	roadmap_m02_notes: string;
	roadmap_m03_notes: string;
	roadmap_m04_notes: string;
	roadmap_m05_notes: string;
	roadmap_m06_notes: string;

	// faq
	section_faq: string;
	faq_1_q: string;
	faq_1_a: string;
	faq_2_q: string;
	faq_2_a: string;
	faq_3_q: string;
	faq_3_a: string;
	faq_4_q: string;
	faq_4_a: string;
	faq_5_q: string;
	faq_5_a: string;

	// footer（精简版：仅保留品牌 tagline + 版权 + 开发状态 + 隐私协议入口）
	footer_tagline: string;
	footer_version: string;
	footer_built: string;
	footer_privacy: string;

	// demo
	vault_demo_label: string;
	vault_demo_hint: string;
	demo_local_hint_left: string;
	demo_local_hint_right: string;

	// hero stats
	hero_stat_1_n: string;
	hero_stat_1_l: string;
	hero_stat_2_n: string;
	hero_stat_2_l: string;
	hero_stat_3_n: string;
	hero_stat_3_l: string;
	hero_stat_4_n: string;
	hero_stat_4_l: string;

	// 通用
	live_section_label: string;
	changelog_section_label: string;
	mobile_section_label: string;

	// theme toggle
	theme_label: string;
	theme_dark: string;
	theme_light: string;
	theme_auto: string;

	// 开源 / GitHub
	github_aria: string;
	footer_oss: string;

	// contact dialog（联系我们对话框）
	contact_trigger: string;
	contact_title: string;
	contact_name_label: string;
	contact_name_placeholder: string;
	contact_email_label: string;
	contact_email_placeholder: string;
	contact_type_label: string;
	contact_type_general: string;
	contact_type_business: string;
	contact_type_security: string;
	contact_type_press: string;
	contact_message_label: string;
	contact_message_placeholder: string;
	contact_submit: string;
	contact_pending: string;
	contact_success: string;
	contact_error: string;
	contact_invalid_name: string;
	contact_invalid_email: string;
	contact_invalid_message: string;
	contact_close: string;
}

const en: SiteStrings = {
	nav_features: "Features",
	nav_security: "Security",
	nav_download: "Download",
	nav_pricing: "Pricing",
	nav_docs: "Docs",
	nav_signin: "Sign in",
	nav_demo: "Preview",
	nav_how: "How it works",
	nav_faq: "FAQ",

	hero_eyebrow: "End-to-end encrypted · Open protocol · Local-first",
	hero_title_1: "Every password, every device.",
	hero_title_2: "Only you hold the key.",
	hero_sub:
		"ZPass keeps your logins, passkeys and 2FA codes encrypted on your own devices. We never see them in plain text — not in transit, not at rest, not anywhere on our servers. Native apps for every platform you use.",
	hero_cta_primary: "Download {version}",
	hero_availability: "Windows · Linux · Android · Chrome / Firefox · macOS / iOS soon",

	release_eyebrow: "AVAILABLE NOW · {version}",
	release_title: "Download ZPass",
	release_sub:
		"Native builds for every platform you use, all sharing the same end-to-end encrypted vault format. Pick the package that fits your machine — your data stays sealed in transit and at rest.",
	release_note:
		"Every asset on the GitHub release page ships with its own SHA-256 hash, so you can verify what you downloaded before installing it.",

	download_section_label: "DOWNLOAD",
	download_recommended: "Recommended",
	download_more_variants: "Other variants",
	download_release_notes: "Full release notes on GitHub",
	download_ios_title: "iOS",
	download_ios_note:
		"TestFlight beta is in preparation. Reach out through Contact if you'd like early access — or watch this page for the public link.",
	download_verify_hint: "Verify SHA-256 before installing",

	section_features: "Features",
	section_features_sub:
		"Everything you need. Nothing you don't. And no shady defaults.",

	f1_title: "End-to-end encrypted",
	f1_body:
		"Your master password never leaves your device. Every item is sealed with modern authenticated encryption (XChaCha20-Poly1305, Argon2id) before it syncs — so even we can't read what's inside.",
	f2_title: "2FA codes, right where you need them",
	f2_body:
		"TOTP codes live next to the account they unlock, with a big, readable countdown and one-tap copy. Works offline, so a missing signal never locks you out.",
	f3_title: "Passkeys and hardware keys",
	f3_body:
		"First-class support for passkeys and FIDO2 security keys. Sign in without typing a password at all — or pair a YubiKey as a second factor on the accounts that matter most.",
	f4_title: "Share with family and teammates",
	f4_body:
		"Give the right people access to the right folders, with permissions you can revoke in one click. Sharing is end-to-end encrypted — the server never handles the keys.",
	f5_title: "Breach alerts, without the leaks",
	f5_body:
		"ZPass watches the public breach databases for you and warns you the moment one of your accounts shows up. Your passwords never leave your device during the check.",
	f6_title: "At home on every platform",
	f6_body:
		"Native apps for macOS, Windows, Linux, iOS and Android. System-level autofill on mobile, browser extensions for Chrome, Firefox and Safari. One vault, wherever you're signed in.",

	section_how: "How it works",
	section_how_sub:
		"Three steps between your master password and the server — and only the first one runs on your device.",
	how_1_title: "Derive",
	how_1_body:
		"Your master password is combined with a per-user salt and stretched with Argon2id into two separate keys — one to unlock the app, one to decrypt your vault. The unlock key is hashed again before it's ever allowed near the network.",
	how_2_title: "Encrypt",
	how_2_body:
		"Every item — and its metadata, folder, icon, timestamps — is sealed individually with XChaCha20-Poly1305. What reaches the server is a string of ciphertext that means nothing without your key.",
	how_3_title: "Sync",
	how_3_body:
		"Edits merge through a CRDT, so you can update items offline on your phone and your laptop at the same time without conflicts. Sync is incremental, authenticated end-to-end, and never blocks you.",
	how_kicker: "STEP",

	section_mobile: "ZPass on mobile",
	section_mobile_sub:
		"Your full vault, one hand, no compromises. iOS and Android share the exact same encrypted core as the desktop app.",
	mobile_eyebrow: "IOS · ANDROID · FACE ID · AUTOFILL",
	mobile_headline: "Your vault, in your thumb.",
	mobile_body:
		"Sign in to apps and websites with a single tap through the iOS and Android system keyboard. 2FA codes surface on the lock screen when you're about to use them — and stay out of sight the rest of the time.",
	mobile_status_ios: "iOS · in development",
	mobile_status_android: "Android · {version} available",
	mobile_status_autofill: "system autofill",
	mobile_phone_kicker: "VAULT · 412 ITEMS",
	mobile_phone_greeting: "Good evening, Alex",

	live_frame_status: "local · 0ms",

	section_desktop: "ZPass on desktop",
	section_desktop_sub:
		"A focused three-pane workspace that gets out of your way. Native windows on macOS, Windows and Linux — all reading the same end-to-end encrypted vault as the mobile apps.",
	desktop_eyebrow: "MACOS · WINDOWS · LINUX · ⌘K · OFFLINE FIRST",
	desktop_headline: "Your whole vault, one keystroke away.",
	desktop_body:
		"Everything is decrypted locally. ⌘K opens the command palette, ⌘L locks the app instantly, and the full vault stays usable with no network at all. Same encrypted core as the mobile app — just with more room to breathe.",
	desktop_status_macos: "macOS · in development",
	desktop_status_windows: "Windows · {version} available",
	desktop_status_linux: "Linux · {version} available",
	desktop_status_extra: "⌘K command palette · offline-first",
	desktop_section_label: "DESKTOP",
	desktop_ui_brand_tag: "v2.4",
	desktop_ui_workspace: "WORKSPACE",
	desktop_ui_categories: "CATEGORIES",
	desktop_ui_folders: "FOLDERS",
	desktop_ui_nav_all: "All items",
	desktop_ui_nav_generator: "Generator",
	desktop_ui_nav_health: "Security center",
	desktop_ui_nav_logins: "Logins",
	desktop_ui_nav_cards: "Cards",
	desktop_ui_nav_notes: "Secure notes",
	desktop_ui_nav_identity: "Identity",
	desktop_ui_nav_ssh: "SSH · tokens",
	desktop_ui_nav_wallet: "Wallet",
	desktop_ui_nav_work: "Work",
	desktop_ui_nav_personal: "Personal",
	desktop_ui_crumb_root: "Vault",
	desktop_ui_search_placeholder: "Search vault, run command…",
	desktop_ui_new_item: "New item",
	desktop_ui_list_title: "Vault",
	desktop_ui_list_recent: "Recent",
	desktop_ui_chip_all: "All",
	desktop_ui_chip_logins: "Logins",
	desktop_ui_chip_cards: "Cards",
	desktop_ui_chip_notes: "Notes",
	desktop_ui_chip_identity: "Identity",
	desktop_ui_meta_username: "Username",
	desktop_ui_meta_password: "Password",
	desktop_ui_meta_website: "Website",
	desktop_ui_section_credentials: "CREDENTIALS",
	desktop_ui_section_strength: "PASSWORD STRENGTH",
	desktop_ui_section_totp: "ONE-TIME CODE",
	desktop_ui_strength_length: "length",
	desktop_ui_strength_entropy: "entropy",
	desktop_ui_strength_crack: "crack",
	desktop_ui_strength_reuse: "reuse",
	desktop_ui_strength_crack_value: "centuries",
	desktop_ui_strength_reuse_value: "none",
	desktop_ui_strength_label: "Excellent",
	desktop_ui_btn_fav: "Favorite",
	desktop_ui_btn_share: "Share",
	desktop_ui_btn_edit: "Edit",
	desktop_ui_row_2d_ago: "2d ago",
	desktop_ui_row_6d_ago: "6d ago",
	desktop_ui_row_14d_ago: "14d ago",
	desktop_ui_row_1y_ago: "1y ago",

	section_security: "Security architecture",
	section_security_sub:
		"Every claim on this page is meant to be checked. The protocol will be documented, reproducible builds are on the roadmap, and the server is designed so there's nothing worth stealing.",
	sec_1_k: "Threat model",
	sec_1_v:
		"Server compromise · TLS interception · malicious update · cold-boot recovery on a lost device. We design against all four.",
	sec_2_k: "Cryptography",
	sec_2_v:
		"Argon2id (m=64MiB, t=3, p=4) · XChaCha20-Poly1305 · X25519 ECDH · Ed25519 · HKDF-SHA512.",
	sec_3_k: "Audits",
	sec_3_v:
		"An independent third-party audit is scheduled before public release. The threat model and protocol spec will be published for external review well ahead of launch.",
	sec_4_k: "Reproducible builds",
	sec_4_v:
		"Deterministic, reproducible builds are on the roadmap before public release — so you'll be able to rebuild from a tagged commit and bit-for-bit compare against the binary you downloaded.",
	sec_5_k: "Openly documented",
	sec_5_v:
		"The protocol spec and threat model will be published before public release. Every algorithm choice and every data flow is being written down — nothing in the path between you and your data should be hand-waved.",
	sec_6_k: "Trusted algorithms",
	sec_6_v:
		"We don't roll our own crypto. Every algorithm in ZPass is a well-studied standard, used the way its designers recommend.",
	audits_label: "PLANNED",
	audit_1_firm: "Threat model",
	audit_1_meta: "Vault path · sync protocol · in progress",
	audit_2_firm: "Cryptographic review",
	audit_2_meta: "Pre-launch external review · planned",
	audit_3_firm: "Independent audit",
	audit_3_meta: "Full client + protocol audit · before public release",

	section_pricing: "Pricing",
	section_pricing_sub:
		"Indicative pricing — final numbers will be confirmed at launch. ZPass is shipping soon; reach out if you need details before then.",
	pricing_solo: {
		name: "Free",
		price: "$0",
		unit: "for individuals",
		bullets: [
			"Unlimited items",
			"All platforms",
			"TOTP, passkeys, hardware keys",
			"Local-first encrypted vault",
		],
		cta: "Get notified",
	},
	pricing_personal: {
		name: "Personal",
		price: "$3",
		unit: "/month · hosted sync",
		bullets: [
			"Everything in Free",
			"Regional hosted sync",
			"Unlimited devices",
			"Encrypted file attachments (1 GB)",
			"Emergency access",
		],
		cta: "Get notified",
	},
	pricing_family: {
		name: "Family",
		price: "$5",
		unit: "/month · up to 6 people",
		bullets: [
			"Everything in Personal",
			"Shared family folders",
			"Per-member permissions",
			"50 GB pooled storage",
		],
		cta: "Get notified",
	},
	pricing_team: {
		name: "Team",
		price: "$4",
		unit: "/user/month",
		bullets: [
			"SSO (SAML, OIDC)",
			"SCIM provisioning",
			"Audit log export",
			"Centralized policy controls",
		],
		cta: "Talk to us",
	},

	section_changelog: "Roadmap",
	section_changelog_sub:
		"What we're building, and roughly when. Dates will move — we'd rather ship this right than ship it early.",

	roadmap_tag_building: "Building",
	roadmap_tag_planned: "Planned",
	roadmap_tag_review: "Review",
	roadmap_tag_later: "Later",

	roadmap_window_in_progress: "in progress",
	roadmap_window_next: "next",
	roadmap_window_before_launch: "before launch",
	roadmap_window_later: "later",

	roadmap_m01_notes:
		"Vault core: Argon2id key derivation, XChaCha20-Poly1305 record sealing, encrypted on-disk store. Local-only for now — no network path yet.",
	roadmap_m02_notes:
		"Desktop app for macOS, Windows and Linux. Keyboard-first, single-window, biometric unlock wherever the OS supports it.",
	roadmap_m03_notes:
		"iOS and Android apps with system-level autofill on both. Exactly the same encrypted core as the desktop build.",
	roadmap_m04_notes:
		"End-to-end encrypted sync across the public internet. CRDT-based merging means offline edits from multiple devices never clash.",
	roadmap_m05_notes:
		"Extensions for Chrome, Firefox and Safari. Protocol spec and threat model go public for external review at the same time.",
	roadmap_m06_notes:
		"Final QA pass and audit follow-up. Public release rolls out once the audit completes and any critical findings are resolved.",

	section_faq: "FAQ",
	faq_1_q: "What happens if I forget my master password?",
	faq_1_a:
		"Without your master password, nobody — including us — can decrypt your vault. That's the whole point of zero-knowledge. To cover that case, ZPass gives you three safety nets: a trusted emergency contact, a printable recovery kit you can store offline, and the option to enroll a hardware key as a second unlock factor.",
	faq_2_q: "When will ZPass be available?",
	faq_2_a:
		"Very soon. Desktop, mobile and the browser extension are all in their final QA pass — the public release is just around the corner. If you need an exact timeline for a partnership or integration, reach out through the contact form.",
	faq_3_q: "Can I import from 1Password, Bitwarden or LastPass?",
	faq_3_a:
		"Yes. The importer supports 1PUX, Bitwarden JSON, LastPass CSV, Chrome / Firefox / Safari browser exports, and KeePass KDBX. Everything runs locally on your device — nothing is uploaded during the migration.",
	faq_4_q: "Do you support passkeys?",
	faq_4_a:
		"Yes. ZPass stores WebAuthn passkeys and syncs them across your devices, encrypted end-to-end. You can also use a hardware security key as your unlock factor if you want an extra layer.",
	faq_5_q: "Where is my data stored on the hosted plan?",
	faq_5_a:
		"We run regional clusters and route you to the closest one automatically, for low latency and local compliance. Either way, the server only ever sees ciphertext — we never hold the keys that can open it.",

	footer_tagline: "Trusted algorithms. Obsessive details.",
	footer_version: "in active development",
	footer_built: "© 2026 ZPass",
	footer_privacy: "Privacy",

	vault_demo_label: "Live demo — vault",
	vault_demo_hint: "Click a row. Everything runs locally in your browser.",
	demo_local_hint_left: "click a row · everything runs locally",
	demo_local_hint_right: "↑ no data leaves your browser",

	hero_stat_1_n: "zero",
	hero_stat_1_l: "bytes of plaintext on our servers",
	hero_stat_2_n: "< 80ms",
	hero_stat_2_l: "to unlock on a 5-year-old phone",
	hero_stat_3_n: "XChaCha20",
	hero_stat_3_l: "authenticated encryption, the standard way",
	hero_stat_4_n: "2026",
	hero_stat_4_l: "first public release this year",

	live_section_label: "LIVE DEMO",
	changelog_section_label: "ROADMAP",
	mobile_section_label: "MOBILE",

	theme_label: "Theme",
	theme_dark: "Dark",
	theme_light: "Light",
	theme_auto: "Auto",
	github_aria: "View ZPass on GitHub",
	footer_oss: "Open source · AGPL-3.0",
	contact_trigger: "Contact",
	contact_title: "Get in touch",
	contact_name_label: "Name",
	contact_name_placeholder: "Your name",
	contact_email_label: "Email",
	contact_email_placeholder: "you@example.com",
	contact_type_label: "Topic",
	contact_type_general: "General",
	contact_type_business: "Business",
	contact_type_security: "Security",
	contact_type_press: "Press",
	contact_message_label: "Message",
	contact_message_placeholder: "Tell us what's on your mind…",
	contact_submit: "Send message",
	contact_pending: "Sending…",
	contact_success: "Message sent! We'll get back to you soon.",
	contact_error: "Something went wrong. Please try again.",
	contact_invalid_name: "Please enter your name.",
	contact_invalid_email: "Please enter a valid email address.",
	contact_invalid_message: "Please enter a message (max 2000 characters).",
	contact_close: "Close",
};

const zh: SiteStrings = {
	nav_features: "功能",
	nav_security: "安全",
	nav_download: "下载",
	nav_pricing: "价格",
	nav_docs: "文档",
	nav_signin: "登录",
	nav_demo: "预览",
	nav_how: "工作原理",
	nav_faq: "常见问题",

	hero_eyebrow: "端到端加密 · 开放协议 · 本地优先",
	hero_title_1: "你的所有密码，所有设备。",
	hero_title_2: "只有你拿得到钥匙。",
	hero_sub:
		"ZPass 把你的登录信息、通行密钥和两步验证码统一加密存放在本地设备。未经加密的明文不会进入网络、不会落到磁盘、也不会出现在我们的服务器上——我们看不到，任何第三方也看不到。覆盖你日常使用的每一个平台。",
	hero_cta_primary: "下载 {version}",
	hero_availability: "Windows · Linux · Android · Chrome / Firefox · macOS / iOS 即将到来",

	release_eyebrow: "现已发布 · {version}",
	release_title: "下载 ZPass",
	release_sub:
		"覆盖你日常使用的每一个平台，全部共用同一份端到端加密的密码库格式。挑选适合你设备的安装包即可——无论传输还是落盘，你的数据都全程加密封装。",
	release_note:
		"GitHub 发布页每个安装包都附 SHA-256 哈希——可在安装前比对哈希，确认下载内容未被篡改。",

	download_section_label: "下载",
	download_recommended: "推荐版本",
	download_more_variants: "其他版本",
	download_release_notes: "查看完整版本说明",
	download_ios_title: "iOS",
	download_ios_note:
		"TestFlight 测试通道筹备中。如需提前体验，欢迎通过页面右上角「联系我们」与我们联系，或关注本页等待公开链接。",
	download_verify_hint: "安装前可校验 SHA-256",

	section_features: "功能",
	section_features_sub: "该有的都有，多余的一样没有，默认设置不玩套路。",

	f1_title: "端到端加密",
	f1_body:
		"主密码全程不离开你的设备。每一条记录都会在同步前用业界主流的认证加密算法（XChaCha20-Poly1305 与 Argon2id）单独封装——所以连我们也看不到你存了什么。",
	f2_title: "两步验证码，用的时候就在手边",
	f2_body:
		"TOTP 验证码就显示在对应账号旁边，倒计时看得清、一键即可复制。离线也能用，没网络的地方不会把你锁在门外。",
	f3_title: "通行密钥与硬件密钥",
	f3_body:
		"原生支持 Passkey 与 FIDO2 安全密钥。你可以完全不用输入密码登录，也可以给重要账号额外配上一把 YubiKey 作为二次保障。",
	f4_title: "与家人、同事安全共享",
	f4_body:
		"按文件夹精细授权，权限可以随时一键收回。整个共享流程端到端加密，服务器全程接触不到任何密钥。",
	f5_title: "泄露预警，但不会泄露你的密码",
	f5_body:
		"ZPass 会持续比对公开的泄露数据库，一旦你的账号出现在其中立刻提醒你。查询全程在本地完成，你的密码不会被发送到任何地方。",
	f6_title: "每一个平台都像原生应用",
	f6_body:
		"macOS、Windows、Linux、iOS、Android 全部提供原生应用。移动端接入系统级自动填充，桌面端提供 Chrome、Firefox、Safari 扩展。一个密码库，所有登录都能用上。",

	section_how: "工作原理",
	section_how_sub:
		"从你输入主密码到数据抵达服务器，中间只有三步，而且仅第一步会在你的设备上完成。",
	how_1_title: "派生",
	how_1_body:
		"主密码与每个用户独有的盐混合后，通过 Argon2id 拉伸为两把独立的密钥：一把用于解锁应用，另一把用于解密密码库。解锁密钥在离开设备之前还会再做一次哈希，网络上永远看不到它的原始形态。",
	how_2_title: "加密",
	how_2_body:
		"每一条记录，连同它的元数据——所属文件夹、图标、时间戳——都会用 XChaCha20-Poly1305 单独封装。到达服务器的只是一串密文，没有你的密钥，它什么都不是。",
	how_3_title: "同步",
	how_3_body:
		"变更通过 CRDT 合并，所以你可以在手机和电脑上同时离线编辑，再也不会出现版本冲突。同步按增量推送、全程端到端认证，也不会因此卡住你的操作。",
	how_kicker: "步骤",

	section_mobile: "ZPass 移动端",
	section_mobile_sub:
		"完整功能，单手可用，毫不妥协。iOS 与 Android 共用一套与桌面端完全一致的加密内核。",
	mobile_eyebrow: "IOS · ANDROID · FACE ID · 自动填充",
	mobile_headline: "你的密码库，握在指尖。",
	mobile_body:
		"通过 iOS 与 Android 系统级键盘，在 App 和网页里一键完成登录。两步验证码只在你将要使用时浮现在锁屏上，其余时间安静待在密码库里。",
	mobile_status_ios: "iOS · 开发中",
	mobile_status_android: "Android · 已发布 {version}",
	mobile_status_autofill: "系统自动填充",
	mobile_phone_kicker: "密码库 · 412 项",
	mobile_phone_greeting: "晚上好，Alex",

	live_frame_status: "本地 · 0ms",

	section_desktop: "ZPass 桌面端",
	section_desktop_sub:
		"专注的三栏式工作区，用的时候在，不用的时候不打扰。macOS、Windows、Linux 均为原生窗口，读取的密码库与移动端完全一致。",
	desktop_eyebrow: "MACOS · WINDOWS · LINUX · ⌘K · 离线优先",
	desktop_headline: "整个密码库，一次按键就能召唤。",
	desktop_body:
		"所有解密都在本地完成。⌘K 唤出命令面板，⌘L 一键锁定，完全离线也能正常使用整个密码库。与移动端共用同一套加密内核——只是屏幕更大、呼吸更从容。",
	desktop_status_macos: "macOS · 开发中",
	desktop_status_windows: "Windows · 已发布 {version}",
	desktop_status_linux: "Linux · 已发布 {version}",
	desktop_status_extra: "⌘K 命令面板 · 离线优先",
	desktop_section_label: "桌面端",
	desktop_ui_brand_tag: "v2.4",
	desktop_ui_workspace: "工作区",
	desktop_ui_categories: "分类",
	desktop_ui_folders: "文件夹",
	desktop_ui_nav_all: "全部项目",
	desktop_ui_nav_generator: "生成器",
	desktop_ui_nav_health: "安全中心",
	desktop_ui_nav_logins: "登录",
	desktop_ui_nav_cards: "银行卡",
	desktop_ui_nav_notes: "安全笔记",
	desktop_ui_nav_identity: "身份信息",
	desktop_ui_nav_ssh: "SSH · 令牌",
	desktop_ui_nav_wallet: "钱包",
	desktop_ui_nav_work: "工作",
	desktop_ui_nav_personal: "个人",
	desktop_ui_crumb_root: "保险库",
	desktop_ui_search_placeholder: "搜索密码库、执行命令…",
	desktop_ui_new_item: "新建项目",
	desktop_ui_list_title: "保险库",
	desktop_ui_list_recent: "最近使用",
	desktop_ui_chip_all: "全部",
	desktop_ui_chip_logins: "登录",
	desktop_ui_chip_cards: "银行卡",
	desktop_ui_chip_notes: "笔记",
	desktop_ui_chip_identity: "身份",
	desktop_ui_meta_username: "用户名",
	desktop_ui_meta_password: "密码",
	desktop_ui_meta_website: "网站",
	desktop_ui_section_credentials: "凭据",
	desktop_ui_section_strength: "密码强度",
	desktop_ui_section_totp: "一次性验证码",
	desktop_ui_strength_length: "长度",
	desktop_ui_strength_entropy: "随机性",
	desktop_ui_strength_crack: "破解耗时",
	desktop_ui_strength_reuse: "是否复用",
	desktop_ui_strength_crack_value: "数百年",
	desktop_ui_strength_reuse_value: "未复用",
	desktop_ui_strength_label: "非常强",
	desktop_ui_btn_fav: "收藏",
	desktop_ui_btn_share: "共享",
	desktop_ui_btn_edit: "编辑",
	desktop_ui_row_2d_ago: "2 天前",
	desktop_ui_row_6d_ago: "6 天前",
	desktop_ui_row_14d_ago: "14 天前",
	desktop_ui_row_1y_ago: "1 年前",

	section_security: "安全架构",
	section_security_sub:
		"本页每一条结论都欢迎你亲自核对：协议会有公开文档、客户端可复现构建已列入路线图、服务器从设计上就拿不出任何有价值的东西。",
	sec_1_k: "威胁模型",
	sec_1_v:
		"服务器被攻破 · TLS 中间人 · 带毒更新 · 设备丢失后的冷启动取证——这四种场景是我们从第一天起就在防的。",
	sec_2_k: "所用算法",
	sec_2_v:
		"Argon2id (m=64MiB, t=3, p=4) · XChaCha20-Poly1305 · X25519 ECDH · Ed25519 · HKDF-SHA512。",
	sec_3_k: "第三方审计",
	sec_3_v:
		"公开发布前会完成独立的第三方安全审计。威胁模型与协议规范也会提前公开，供外部研究者评审。",
	sec_4_k: "可复现构建",
	sec_4_v:
		"可复现构建已列入公开发布前的路线图——届时你可以用同一个 tag 自行编译，与官方下载的二进制逐字节比对。",
	sec_5_k: "公开文档",
	sec_5_v:
		"协议规范与威胁模型会在公开发布前一并放出。每一个算法选择、每一条数据流转路径都在写明——你和密码之间不该有任何「黑盒环节」。",
	sec_6_k: "只用经典算法",
	sec_6_v:
		"我们不自造密码学轮子。ZPass 用到的每一个算法都是业界长期审查过的标准方案，并严格按其作者推荐的方式使用。",
	audits_label: "已规划",
	audit_1_firm: "威胁模型",
	audit_1_meta: "密码库路径 · 同步协议 · 进行中",
	audit_2_firm: "密码学评审",
	audit_2_meta: "上线前外部评审 · 已计划",
	audit_3_firm: "独立审计",
	audit_3_meta: "完整客户端 + 协议审计 · 公开发布前完成",

	section_pricing: "价格",
	section_pricing_sub:
		"以下为预估价格，最终以正式发布时公布的为准。ZPass 即将发布，如需提前了解请通过页面上的「联系我们」与我们沟通。",
	pricing_solo: {
		name: "免费版",
		price: "¥0",
		unit: "面向个人用户",
		bullets: [
			"无限条目",
			"全平台支持",
			"TOTP、通行密钥、硬件密钥",
			"本地优先的加密密码库",
		],
		cta: "了解发布",
	},
	pricing_personal: {
		name: "个人版",
		price: "¥22",
		unit: "/月 · 托管同步",
		bullets: [
			"包含免费版全部",
			"托管同步（中国大陆）",
			"无限设备",
			"加密文件附件（1 GB）",
			"应急访问",
		],
		cta: "了解发布",
	},
	pricing_family: {
		name: "家庭版",
		price: "¥38",
		unit: "/月 · 至多 6 人",
		bullets: ["包含个人版全部", "家庭共享文件夹", "成员权限", "50 GB 共享存储"],
		cta: "了解发布",
	},
	pricing_team: {
		name: "团队版",
		price: "¥30",
		unit: "/用户/月",
		bullets: [
			"SSO（SAML、OIDC）",
			"SCIM 自动配置",
			"审计日志导出",
			"集中策略管控",
		],
		cta: "联系我们",
	},

	section_changelog: "路线图",
	section_changelog_sub:
		"我们在做什么，以及大致什么时候能用上。时间节点会变——比起赶进度，我们更在乎把它做对。",

	roadmap_tag_building: "进行中",
	roadmap_tag_planned: "已规划",
	roadmap_tag_review: "待审阅",
	roadmap_tag_later: "后续",

	roadmap_window_in_progress: "进行中",
	roadmap_window_next: "下一步",
	roadmap_window_before_launch: "发布前",
	roadmap_window_later: "稍后",

	roadmap_m01_notes:
		"密码库核心：Argon2id 密钥派生、XChaCha20-Poly1305 记录封装、本地加密存储。现阶段仅在本地运行，尚不涉及任何网络同步。",
	roadmap_m02_notes:
		"macOS、Windows、Linux 桌面应用。键盘优先、单窗口设计，在支持的系统上启用生物识别解锁。",
	roadmap_m03_notes:
		"iOS 与 Android 应用，两端均接入系统级自动填充，与桌面端共用完全相同的加密内核。",
	roadmap_m04_notes:
		"基于公网的端到端加密同步。采用 CRDT 合并策略，即使多台设备离线编辑也不会出现冲突。",
	roadmap_m05_notes:
		"Chrome、Firefox、Safari 浏览器扩展上线。协议规范与威胁模型同步公开，接受外部研究者审阅。",
	roadmap_m06_notes:
		"发布前的最后一轮 QA 与审计复测。安全审计完成、关键问题修复之后，正式公开发布。",

	section_faq: "常见问题",
	faq_1_q: "如果忘记主密码怎么办？",
	faq_1_a:
		"没有主密码，任何人——包括我们——都无法解密你的密码库，这正是零知识架构的代价，也是它存在的意义。为此 ZPass 提供了三道保险：指定一位可信联系人作为应急联系人、导出一份可离线打印保存的恢复套件、或把硬件密钥注册为第二解锁因素。",
	faq_2_q: "ZPass 什么时候发布？",
	faq_2_a:
		"即将发布。桌面端、移动端与浏览器扩展都已进入发布前的最后一轮 QA——首个公开版本就在眼前。如果你是合作者或集成方，需要一个准确的时间表，欢迎通过页面上的「联系我们」表单联系我们。",
	faq_3_q: "可以从 1Password、Bitwarden、LastPass 迁移过来吗？",
	faq_3_a:
		"可以。导入器支持 1PUX、Bitwarden JSON、LastPass CSV、Chrome / Firefox / Safari 浏览器导出以及 KeePass KDBX 等常见格式。整个导入过程都在你的设备上完成，迁移期间不会有任何数据被上传。",
	faq_4_q: "支持通行密钥（Passkey）吗？",
	faq_4_a:
		"支持。ZPass 会保存你的 WebAuthn 通行密钥，并以端到端加密的方式同步到你的所有设备。如果你希望再加一层保险，也可以把硬件安全密钥作为解锁因素。",
	faq_5_q: "使用云同步时，我的数据存在哪里？",
	faq_5_a:
		"我们在多个区域部署了就近接入的节点，会根据你的位置自动路由到延迟最低、合规要求匹配的那一个。无论接入哪个节点，服务端看到的都只有加密后的密文——能打开它的那把钥匙，从不在我们手里。",

	footer_tagline: "用经典密码学，抠每一个细节。",
	footer_version: "开发中",
	footer_built: "© 2026 ZPass",
	footer_privacy: "隐私协议",

	vault_demo_label: "实时演示 — 密码库",
	vault_demo_hint: "点击任一行。所有运算都在你的浏览器本地完成。",
	demo_local_hint_left: "点击任一行 · 全部本地运行",
	demo_local_hint_right: "↑ 无数据离开浏览器",

	hero_stat_1_n: "零",
	hero_stat_1_l: "字节明文进入我们的服务器",
	hero_stat_2_n: "< 80 毫秒",
	hero_stat_2_l: "在五年前的旧手机上完成解锁",
	hero_stat_3_n: "XChaCha20",
	hero_stat_3_l: "严格按标准使用的认证加密算法",
	hero_stat_4_n: "2026",
	hero_stat_4_l: "年内首个公开版本发布",

	live_section_label: "实时演示",
	changelog_section_label: "路线图",
	mobile_section_label: "移动端",

	theme_label: "主题",
	theme_dark: "深色",
	theme_light: "浅色",
	theme_auto: "跟随系统",
	github_aria: "在 GitHub 查看 ZPass",
	footer_oss: "开源 · AGPL-3.0",
	contact_trigger: "联系我们",
	contact_title: "联系我们",
	contact_name_label: "姓名",
	contact_name_placeholder: "你的名字",
	contact_email_label: "邮箱",
	contact_email_placeholder: "you@example.com",
	contact_type_label: "类型",
	contact_type_general: "一般咨询",
	contact_type_business: "商务合作",
	contact_type_security: "安全披露",
	contact_type_press: "媒体报道",
	contact_message_label: "内容",
	contact_message_placeholder: "告诉我们你的想法……",
	contact_submit: "发送消息",
	contact_pending: "发送中…",
	contact_success: "消息已发送！我们会尽快回复你。",
	contact_error: "出现了问题，请稍后再试。",
	contact_invalid_name: "请填写你的姓名。",
	contact_invalid_email: "请填写有效的邮箱地址。",
	contact_invalid_message: "请填写消息内容（最多 2000 字）。",
	contact_close: "关闭",
};

// ——— 导出 ———
export const STRINGS: Record<Locale, SiteStrings> = { en, zh };

/**
 * 根据 locale 获取对应字符串集合，若 locale 缺失则回落到英文。
 */
export function getStrings(locale: Locale | string | undefined): SiteStrings {
	if (locale === "zh") return STRINGS.zh;
	return STRINGS.en;
}

/**
 * 把字符串集合中所有 `{version}` 占位符替换为给定版本号。
 * 文案里的版本号统一通过占位符表达，由 SSR 拉到的最新 release 在渲染前注入，
 * 避免文案与版本耦合。
 */
export function applyVersion(t: SiteStrings, version: string): SiteStrings {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(t) as [string, unknown][]) {
		if (typeof value === "string" && value.includes("{version}")) {
			out[key] = value.replaceAll("{version}", version);
		} else {
			out[key] = value;
		}
	}
	return out as unknown as SiteStrings;
}

/**
 * 在两种 locale 之间切换，返回另一种语言。
 */
export function otherLocale(locale: Locale): Locale {
	return locale === "zh" ? "en" : "zh";
}

/**
 * 给定当前 locale 与目标 locale，将一个站内路径转换为另一种语言版本。
 * - en 路径不带前缀（例如 `/`、`/security`）
 * - zh 路径带 `/zh` 前缀（例如`/zh/`、`/zh/security`）
 */
export function localizePath(path: string, target: Locale): string {
	// 规整 path
	let p = path || "/";
	if (!p.startsWith("/")) p = "/" + p;

	// 去除已有的 zh 前缀
	if (p === "/zh" || p === "/zh/") {
		p = "/";
	} else if (p.startsWith("/zh/")) {
		p = p.slice(3); // 去掉 "/zh"
	}

	if (target === "zh") {
		return p === "/" ? "/zh/" : "/zh" + p;
	}
	return p;
}
