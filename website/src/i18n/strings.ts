// ZPass 官网 i18n 字符串
// 内容移植自 ZPassDesign/src/site/site-i18n.jsx，扩展为强类型 TS 模块。
// 在页面与组件中通过 `getStrings(locale)` 获取对应语言文案。

/** ZPass 官方 GitHub 仓库（Nav / Footer / README 等多处引用，集中在此避免不一致） */
export const GITHUB_URL = "https://github.com/zerx-lab/zpass";

/** ZPass Web Vault 应用部署地址（登录 / 注册入口指向该独立 SPA）。
 *  默认指向线上发布地址，可用环境变量 APP_URL 覆盖
 *  （本地联调 web_vault dev server 时设为 http://localhost:5173）。 */
export const APP_URL = (
	import.meta.env.APP_URL ?? "https://zpass-app.zerx.dev"
).replace(/\/+$/, "");

/** Web Vault 注册页（新建账户） */
export const APP_REGISTER_URL = `${APP_URL}/register`;

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
	nav_register: string;
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
	download_harmony_title: string;
	download_harmony_subtitle: string;
	download_harmony_note: string;
	download_harmony_tag: string;
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
	mobile_status_harmony: string;
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
	pricing_compare_title: string;
	pricing_compare_yes: string;
	pricing_compare_rows: {
		price_yearly: string;
		max_members: string;
		max_vaults: string;
		max_items: string;
		max_guests: string;
		storage: string;
		trial: string;
		advanced_mfa: string;
		family_sharing: string;
		audit_log: string;
		sso: string;
		scim: string;
	};

	// changelog
	section_changelog: string;
	section_changelog_sub: string;
	changelog_view_on_github: string;
	changelog_view_all_releases: string;

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
	nav_register: "Create account",
	nav_demo: "Preview",
	nav_how: "How it works",
	nav_faq: "FAQ",

	hero_eyebrow: "End-to-end encrypted · Zero-knowledge · Open source (AGPL-3.0)",
	hero_title_1: "One vault. Every device.",
	hero_title_2: "Only you hold the key.",
	hero_sub:
		"ZPass encrypts everything — logins, passkeys, SSH keys, 2FA codes — on your device before it ever touches a network. Argon2id, XChaCha20-Poly1305 and SRP-6a do the work; the server only ever sees ciphertext.",
	hero_cta_primary: "Download {version}",
	hero_availability:
		"Windows · Linux · macOS (preview) · Android · HarmonyOS NEXT · Chrome / Edge / Firefox",

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
	download_harmony_title: "HarmonyOS",
	download_harmony_subtitle: "HarmonyOS NEXT · phone · tablet",
	download_harmony_note:
		"HarmonyOS NEXT build is feature-complete, including cloud sync — still pending verification on physical devices. Reach out through Contact for early access.",
	download_harmony_tag: "in dev",
	download_verify_hint: "Verify SHA-256 before installing",

	section_features: "Features",
	section_features_sub:
		"Everything you need. Nothing you don't. And no shady defaults.",

	f1_title: "Passkeys, not just passwords",
	f1_body:
		"Create and store WebAuthn/FIDO2 passkeys, import existing ones from a Bitwarden export, and sign in through the browser extension without typing a password.",
	f2_title: "TOTP, HOTP and Steam Guard",
	f2_body:
		"All three one-time-code formats live next to the account they unlock, with a readable countdown and one-tap copy — no separate authenticator app required.",
	f3_title: "A real SSH agent",
	f3_body:
		"ZPass manages your SSH keys and runs as a system-level agent — Ed25519 by default, with a UI prompt to approve every signing request.",
	f4_title: "LAN sync, no cloud required",
	f4_body:
		"Pair two devices on the same network with SPAKE2 and sync directly, peer to peer — a second channel that works independently of any server.",
	f5_title: "Breach checks that leak nothing",
	f5_body:
		"ZPass checks your passwords against known breaches using HIBP's k-Anonymity protocol — only the first 5 characters of a SHA-1 hash ever leave your device.",
	f6_title: "Spaces keep things separate",
	f6_body:
		"Split personal, work and shared credentials into isolated Spaces. Each one is its own boundary — nothing crosses over by accident.",

	section_how: "How it works",
	section_how_sub:
		"Three steps between your master password and the network — derivation and encryption both happen on your device; only ciphertext is ever sent.",
	how_1_title: "Derive",
	how_1_body:
		"Your master password is stretched with Argon2id (64 MiB, t=3, p=4) and combined with a locally generated Secret Key via HKDF — this 2SKD scheme means the account key exists only if both pieces are present, and neither ever leaves your device.",
	how_2_title: "Encrypt",
	how_2_body:
		"Every item — and its metadata, folder, timestamps — is sealed individually with XChaCha20-Poly1305. What reaches the server is ciphertext that means nothing without your key.",
	how_3_title: "Sync",
	how_3_body:
		"Encrypted changes push to your other devices over an authenticated channel, or sync directly over the local network via SPAKE2 pairing with no server involved at all. Either way, only ciphertext ever crosses the wire.",
	how_kicker: "STEP",

	section_mobile: "ZPass on mobile",
	section_mobile_sub:
		"HarmonyOS NEXT shares the exact same Rust encryption core as the desktop app — phone, tablet and 2-in-1.",
	mobile_eyebrow: "HARMONYOS NEXT · PHONE · TABLET · 2-IN-1",
	mobile_headline: "Your vault, in your thumb.",
	mobile_body:
		"Unlock with biometrics backed by HUKS, and keep working: 2FA codes, passkeys and the full vault sync end-to-end encrypted across every HarmonyOS device you sign into.",
	mobile_status_ios: "iOS · planned",
	mobile_status_android: "Android · sideload APK",
	mobile_status_harmony: "HarmonyOS NEXT · in development",
	mobile_status_autofill: "biometric unlock (HUKS)",
	mobile_phone_kicker: "VAULT · 412 ITEMS",
	mobile_phone_greeting: "Good evening, Alex",

	live_frame_status: "local · 0ms",

	section_desktop: "ZPass on desktop",
	section_desktop_sub:
		"A focused three-pane workspace that gets out of your way. Native windows on Windows, Linux and macOS (preview) — reading the same end-to-end encrypted vault as HarmonyOS and the browser extension.",
	desktop_eyebrow: "WINDOWS · LINUX · MACOS (PREVIEW) · ⌘K · OFFLINE FIRST",
	desktop_headline: "Your whole vault, one keystroke away.",
	desktop_body:
		"Everything is decrypted locally. ⌘K opens the command palette, ⌘L locks the app instantly, and the full vault stays usable with no network at all. Same Rust encryption core as HarmonyOS — just with more room to breathe.",
	desktop_status_macos: "macOS · preview · {version}",
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
		"Every claim on this page is meant to be checked. The client is AGPL-3.0 open source, the cryptography is a single shared Rust crate, and the server is designed so there's nothing worth stealing.",
	sec_1_k: "Threat model",
	sec_1_v:
		"Server compromise · TLS interception · malicious update · cold-boot recovery on a lost device. We design against all four, and the server never sees your master password or plaintext.",
	sec_2_k: "Key derivation (2SKD)",
	sec_2_v:
		"Your account key is Argon2id(master password) XOR HKDF(Secret Key) — a locally generated, ~128-bit Secret Key that never leaves your device or gets uploaded anywhere.",
	sec_3_k: "Encryption",
	sec_3_v:
		"XChaCha20-Poly1305 seals every item with a 24-byte nonce. Sensitive memory is forced to zero the moment it's no longer needed.",
	sec_4_k: "Zero-knowledge auth",
	sec_4_v:
		"SRP-6a (RFC 5054, 2048-bit group) proves you know your master password without ever sending it. Key exchange to new devices uses X25519 sealed-box (ECDH + HKDF-SHA256).",
	sec_5_k: "One crate, every platform",
	sec_5_v:
		"Desktop, HarmonyOS and the browser extension all call the same Rust cryptocore — byte-for-byte identical behavior, with no per-platform reimplementation to drift or break.",
	sec_6_k: "Trusted algorithms",
	sec_6_v:
		"We don't roll our own crypto. Every algorithm in ZPass is a well-studied standard, used the way its designers recommend.",
	audits_label: "VERIFIABLE",
	audit_1_firm: "Open source",
	audit_1_meta: "AGPL-3.0 · desktop, HarmonyOS, extension, cryptocore and this website",
	audit_2_firm: "Auditable cryptocore",
	audit_2_meta:
		"Every primitive lives in one public Rust crate, shared across all clients",
	audit_3_firm: "Build it yourself",
	audit_3_meta: "Clone a tagged release and compile with your own toolchain",

	section_pricing: "Pricing",
	section_pricing_sub:
		"Simple, transparent pricing — cheaper than 1Password and Bitwarden. Start free, upgrade anytime. All plans are end-to-end encrypted with zero-knowledge architecture.",
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
	pricing_compare_title: "Compare plans",
	pricing_compare_yes: "Yes",
	pricing_compare_rows: {
		price_yearly: "Yearly price",
		max_members: "Members",
		max_vaults: "Vaults",
		max_items: "Items",
		max_guests: "Guests",
		storage: "Encrypted storage",
		trial: "Free trial",
		advanced_mfa: "Advanced MFA",
		family_sharing: "Family sharing",
		audit_log: "Audit log",
		sso: "SSO (SAML, OIDC)",
		scim: "SCIM provisioning",
	},

	section_changelog: "Latest release",
	section_changelog_sub:
		"What changed in the most recent build. Notes are generated straight from the commit log when each version ships.",
	changelog_view_on_github: "View on GitHub",
	changelog_view_all_releases: "All releases",

	section_faq: "FAQ",
	faq_1_q: "What happens if I forget my master password?",
	faq_1_a:
		"Nobody can decrypt your vault without your master password — not you, not us. ZPass derives your account key from your master password and a locally stored Secret Key (2SKD); lose either one and there's no reset, no backdoor, and no recovery. That's the price of zero-knowledge — keep both safe.",
	faq_2_q: "Is ZPass available now?",
	faq_2_a:
		"Yes. Desktop builds for Windows and Linux are stable, macOS is in preview, and the browser extension supports Chrome, Edge and Firefox. Android ships as a sideload APK. The HarmonyOS NEXT client is feature-complete and in internal testing. iOS isn't in active development yet.",
	faq_3_q: "Can I import from other password managers?",
	faq_3_a:
		"Yes, from Bitwarden — JSON export, including passkeys. Import runs entirely on your device; nothing is uploaded during the migration. Support for other formats isn't available yet.",
	faq_4_q: "Do you support passkeys?",
	faq_4_a:
		"Yes. ZPass creates and stores WebAuthn/FIDO2 passkeys, encrypted end-to-end, and the browser extension bridges them into your sign-in flow. You can also import existing passkeys from a Bitwarden export.",
	faq_5_q: "Where is my data stored?",
	faq_5_a:
		"By default, nowhere but your own devices. If you turn on cloud sync, the server only ever stores your SRP verifier, public keys and encrypted ciphertext blobs — never your master password, your Secret Key, or plaintext. Prefer to skip the cloud entirely? LAN sync pairs devices directly over your local network.",

	footer_tagline: "Trusted algorithms. Obsessive details.",
	footer_version: "in active development",
	footer_built: "© 2026 ZPass",
	footer_privacy: "Privacy",

	vault_demo_label: "Live demo — vault",
	vault_demo_hint: "Click a row. Everything runs locally in your browser.",
	demo_local_hint_left: "click a row · everything runs locally",
	demo_local_hint_right: "↑ no data leaves your browser",

	hero_stat_1_n: "AGPL-3.0",
	hero_stat_1_l: "open source, every line auditable",
	hero_stat_2_n: "XChaCha20",
	hero_stat_2_l: "authenticated encryption on every item",
	hero_stat_3_n: "128-bit",
	hero_stat_3_l: "Secret Key entropy, generated locally",
	hero_stat_4_n: "3",
	hero_stat_4_l: "browser extensions — Chrome, Edge, Firefox",

	live_section_label: "LIVE DEMO",
	changelog_section_label: "CHANGELOG",
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
	nav_register: "创建账户",
	nav_demo: "预览",
	nav_how: "工作原理",
	nav_faq: "常见问题",

	hero_eyebrow: "端到端加密 · 零知识 · 开源（AGPL-3.0）",
	hero_title_1: "一个密码库，所有设备。",
	hero_title_2: "钥匙只在你手里。",
	hero_sub:
		"登录信息、通行密钥、SSH 密钥、两步验证码——ZPass 会在数据离开设备之前全部加密。Argon2id、XChaCha20-Poly1305 与 SRP-6a 负责这一切，服务器永远只能看到密文。",
	hero_cta_primary: "下载 {version}",
	hero_availability:
		"Windows · Linux · macOS（预览版）· Android · HarmonyOS NEXT · Chrome / Edge / Firefox",

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
	download_harmony_title: "鸿蒙",
	download_harmony_subtitle: "HarmonyOS NEXT · 手机 · 平板",
	download_harmony_note:
		"HarmonyOS NEXT 客户端功能已开发完成，含云同步，目前仍在等待真机验证。可通过「联系我们」获取内测渠道。",
	download_harmony_tag: "开发中",
	download_verify_hint: "安装前可校验 SHA-256",

	section_features: "功能",
	section_features_sub: "该有的都有，多余的一样没有，默认设置不玩套路。",

	f1_title: "通行密钥，不止密码",
	f1_body:
		"创建并保存 WebAuthn/FIDO2 通行密钥，可从 Bitwarden 导出文件导入已有的通行密钥，并通过浏览器扩展免密登录。",
	f2_title: "TOTP、HOTP 与 Steam 令牌",
	f2_body:
		"三种一次性验证码格式都会显示在对应账号旁边，倒计时清晰可见、一键复制——不需要另外安装验证器 App。",
	f3_title: "真正的 SSH Agent",
	f3_body:
		"ZPass 管理你的 SSH 密钥，并作为系统级 Agent 运行——默认 Ed25519，每一次签名请求都会弹出界面等你批准。",
	f4_title: "局域网同步，无需云端",
	f4_body:
		"同一局域网内的两台设备通过 SPAKE2 配对后直接点对点同步——这是独立于云同步的第二条通道，完全不依赖服务器。",
	f5_title: "泄露检测，密码不外泄",
	f5_body:
		"ZPass 用 HIBP 的 k-匿名协议检测密码是否出现在已知泄露库中——离开设备的只有 SHA-1 哈希的前 5 位。",
	f6_title: "空间隔离，互不干扰",
	f6_body:
		"把个人、工作与共享的凭据拆分到互相隔离的空间（Space）中。每个空间都是独立边界，不会意外混在一起。",

	section_how: "工作原理",
	section_how_sub:
		"从主密码到网络，中间只有三步——派生与加密都在你的设备本地完成，离开设备的只有密文。",
	how_1_title: "派生",
	how_1_body:
		"主密码会用 Argon2id（64 MiB、t=3、p=4）拉伸，再通过 HKDF 与本地生成的 Secret Key 结合——这套 2SKD 方案意味着账户密钥只在两者同时具备时才存在，且两者都不会离开你的设备。",
	how_2_title: "加密",
	how_2_body:
		"每一条记录，连同它的元数据——文件夹、时间戳——都会用 XChaCha20-Poly1305 单独封装。到达服务器的只是一串密文，没有你的密钥，它什么都不是。",
	how_3_title: "同步",
	how_3_body:
		"加密后的变更通过认证通道推送到你的其他设备；也可以完全跳过服务器，通过 SPAKE2 配对在局域网内直接同步。无论哪种方式，在网络上传输的永远只有密文。",
	how_kicker: "步骤",

	section_mobile: "ZPass 移动端",
	section_mobile_sub:
		"HarmonyOS NEXT 与桌面端共用同一套 Rust 加密内核——覆盖手机、平板与二合一设备。",
	mobile_eyebrow: "HARMONYOS NEXT · 手机 · 平板 · 二合一",
	mobile_headline: "你的密码库，握在指尖。",
	mobile_body:
		"通过 HUKS 支持的生物识别解锁，两步验证码、通行密钥与完整密码库会在你登录的每一台 HarmonyOS 设备间端到端加密同步。",
	mobile_status_ios: "iOS · 计划中",
	mobile_status_android: "Android · 直装 APK",
	mobile_status_harmony: "鸿蒙 HarmonyOS NEXT · 开发中",
	mobile_status_autofill: "生物识别解锁（HUKS）",
	mobile_phone_kicker: "密码库 · 412 项",
	mobile_phone_greeting: "晚上好，Alex",

	live_frame_status: "本地 · 0ms",

	section_desktop: "ZPass 桌面端",
	section_desktop_sub:
		"专注的三栏式工作区，用的时候在，不用的时候不打扰。Windows、Linux 与 macOS（预览版）均为原生窗口，读取的密码库与 HarmonyOS、浏览器扩展完全一致。",
	desktop_eyebrow: "WINDOWS · LINUX · MACOS（预览版）· ⌘K · 离线优先",
	desktop_headline: "整个密码库，一次按键就能召唤。",
	desktop_body:
		"所有解密都在本地完成。⌘K 唤出命令面板，⌘L 一键锁定，完全离线也能正常使用整个密码库。与 HarmonyOS 共用同一套 Rust 加密内核——只是屏幕更大、呼吸更从容。",
	desktop_status_macos: "macOS · 预览版 · {version}",
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
		"本页每一条结论都欢迎你亲自核对：客户端以 AGPL-3.0 开源，加密实现集中在同一个 Rust crate 里，服务器从设计上就拿不出任何有价值的东西。",
	sec_1_k: "威胁模型",
	sec_1_v:
		"服务器被攻破 · TLS 中间人 · 带毒更新 · 设备丢失后的冷启动取证——这四种场景是我们从第一天起就在防的，服务器永远看不到你的主密码或明文。",
	sec_2_k: "密钥派生（2SKD）",
	sec_2_v:
		"账户密钥 = Argon2id(主密码) XOR HKDF(Secret Key)——Secret Key 本地生成，约 128 位熵，不会离开设备，更不会上传。",
	sec_3_k: "加密",
	sec_3_v:
		"XChaCha20-Poly1305 用 24 字节 nonce 封装每一条记录。敏感内存在不再需要的瞬间就会被强制清零。",
	sec_4_k: "零知识认证",
	sec_4_v:
		"SRP-6a（RFC 5054，2048 位群）证明你知道主密码，却从不传输它。新设备的密钥分发使用 X25519 sealed-box（ECDH + HKDF-SHA256）。",
	sec_5_k: "一套内核，多端复用",
	sec_5_v:
		"桌面端、HarmonyOS 与浏览器扩展全部调用同一个 Rust cryptocore——字节级一致的行为，不存在各端分别实现、逐渐漂移的风险。",
	sec_6_k: "只用经典算法",
	sec_6_v:
		"我们不自造密码学轮子。ZPass 用到的每一个算法都是业界长期审查过的标准方案，并严格按其作者推荐的方式使用。",
	audits_label: "可验证",
	audit_1_firm: "开源",
	audit_1_meta: "AGPL-3.0 · 桌面端、HarmonyOS、浏览器扩展、cryptocore 与本网站",
	audit_2_firm: "可审计的加密内核",
	audit_2_meta: "所有加密原语集中在同一个公开的 Rust crate 中，全端复用",
	audit_3_firm: "自行编译验证",
	audit_3_meta: "克隆某个发布 tag，用你自己的工具链编译",

	section_pricing: "价格",
	section_pricing_sub:
		"简单透明的定价，比 1Password、Bitwarden 更实惠。免费起步，随时升级。所有套餐均采用端到端加密与零知识架构。",
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
	pricing_compare_title: "套餐对比",
	pricing_compare_yes: "支持",
	pricing_compare_rows: {
		price_yearly: "年付价格",
		max_members: "成员数",
		max_vaults: "保险箱",
		max_items: "条目数",
		max_guests: "访客数",
		storage: "加密存储",
		trial: "免费试用",
		advanced_mfa: "高级多因子认证",
		family_sharing: "家庭共享",
		audit_log: "审计日志",
		sso: "SSO（SAML、OIDC）",
		scim: "SCIM 自动配置",
	},

	section_changelog: "更新日志",
	section_changelog_sub:
		"最近一次发布的改动一览。每次发版时由提交记录自动生成，避免人工漏写。",
	changelog_view_on_github: "在 GitHub 查看",
	changelog_view_all_releases: "查看全部版本",

	section_faq: "常见问题",
	faq_1_q: "如果忘记主密码怎么办？",
	faq_1_a:
		"没有主密码，任何人——包括我们——都无法解密你的密码库。ZPass 的账户密钥由主密码与本地保存的 Secret Key 共同派生（2SKD）：丢失任何一个都没有重置入口、没有后门、也无法恢复。这就是零知识架构的代价——请把两者都妥善保存好。",
	faq_2_q: "ZPass 现在能用吗？",
	faq_2_a:
		"可以。Windows 与 Linux 桌面端已经稳定发布，macOS 处于预览阶段，浏览器扩展支持 Chrome、Edge 与 Firefox。Android 提供直装 APK。HarmonyOS NEXT 客户端功能已开发完成，正在内部测试。iOS 尚未进入开发阶段。",
	faq_3_q: "可以从其他密码管理器迁移过来吗？",
	faq_3_a:
		"可以，支持从 Bitwarden 导出的 JSON 文件导入，包含其中的通行密钥。整个导入过程都在你的设备上完成，迁移期间不会上传任何数据。暂不支持其他格式的导入。",
	faq_4_q: "支持通行密钥（Passkey）吗？",
	faq_4_a:
		"支持。ZPass 会创建并保存 WebAuthn/FIDO2 通行密钥，端到端加密，浏览器扩展会把它们桥接进你的登录流程。你也可以从 Bitwarden 导出文件中导入已有的通行密钥。",
	faq_5_q: "我的数据存在哪里？",
	faq_5_a:
		"默认情况下只存在你自己的设备上。如果开启云同步，服务器只会保存 SRP 验证器、公钥和加密后的密文——永远看不到你的主密码、Secret Key 或任何明文。不想用云同步？也可以通过局域网直接在设备间同步。",

	footer_tagline: "用经典密码学，抠每一个细节。",
	footer_version: "开发中",
	footer_built: "© 2026 ZPass",
	footer_privacy: "隐私协议",

	vault_demo_label: "实时演示 — 密码库",
	vault_demo_hint: "点击任一行。所有运算都在你的浏览器本地完成。",
	demo_local_hint_left: "点击任一行 · 全部本地运行",
	demo_local_hint_right: "↑ 无数据离开浏览器",

	hero_stat_1_n: "AGPL-3.0",
	hero_stat_1_l: "开源协议，每一行代码都能审查",
	hero_stat_2_n: "XChaCha20",
	hero_stat_2_l: "每一条记录都用它做认证加密",
	hero_stat_3_n: "128 位",
	hero_stat_3_l: "Secret Key 熵值，本地生成",
	hero_stat_4_n: "3",
	hero_stat_4_l: "款浏览器扩展 —— Chrome、Edge、Firefox",

	live_section_label: "实时演示",
	changelog_section_label: "更新日志",
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
