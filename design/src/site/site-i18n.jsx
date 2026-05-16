// ZPass website strings — EN + ZH
// 注:前期开发期版本——
//   - 全部去掉 "open source / MIT / self-host / 开源 / 自托管 / 原型 / Sigstore" 措辞
//   - 已发布版本号 v3.2.0 与具体审计公司(Cure53 / Trail of Bits)替换为开发期占位
//   - 主要 CTA 由 "下载 / 查看源代码 / 打开原型" 改为 "订阅发布通知 / 加入候补"
//   - Hero 第 3 项统计从 "MIT" 改为 "XChaCha20"(密码学原语)
const SITE_STRINGS = {
	en: {
		nav_features: "Features",
		nav_security: "Security",
		nav_download: "Subscribe",
		nav_pricing: "Pricing",
		nav_docs: "Docs",
		nav_signin: "Sign in",

		hero_eyebrow:
			"End-to-end encrypted · Zero-knowledge · In active development",
		hero_title_1: "A password vault",
		hero_title_2: "that stays out of your way.",
		hero_sub:
			"ZPass is a cross-platform credential manager built on zero-knowledge architecture. Your secrets never leave your device in the clear — not in transit, not at rest, not on our servers.",
		hero_cta_primary: "Get release updates",
		hero_availability: "macOS · Windows · Linux · iOS · Android · Browser ext.",

		// 替代原 install / config 区块的订阅文案
		subscribe_eyebrow: "EARLY ACCESS",
		subscribe_title: "ZPass is in active development.",
		subscribe_sub:
			"We're putting the finishing touches on the first public release. Leave your email and we'll let you know the moment it's ready — no other mail, ever.",
		subscribe_placeholder: "you@example.com",
		subscribe_cta: "Notify me",
		subscribe_note:
			"One-tap unsubscribe. We never share your address. No marketing.",

		section_features: "Features",
		section_features_sub: "Small tools, serious encryption, no dark patterns.",

		f1_title: "End-to-end encrypted",
		f1_body:
			"XChaCha20-Poly1305 with Argon2id key derivation. Your master password never touches the wire. Even we can't read your vault.",

		f2_title: "TOTP built in",
		f2_body:
			"Your authenticator codes live next to the accounts they unlock. A giant countdown, copy with one tap, works offline.",

		f3_title: "Passkeys & hardware keys",
		f3_body:
			"First-class FIDO2 / WebAuthn support. Pair a YubiKey or Passkey for accounts that deserve more than a password.",

		f4_title: "Family & team sharing",
		f4_body:
			"Per-folder access with per-recipient public keys. Revoke in one click. No re-encryption round-trips.",

		f5_title: "Breach monitoring",
		f5_body:
			"Continuous k-anonymous checks against Have I Been Pwned. Never send a password hash; get notified the moment a domain leaks.",

		f6_title: "Built for everyday use",
		f6_body:
			"Native apps on every major OS. System keyboard autofill on iOS and Android. Browser extensions for Chrome, Firefox and Safari. One vault, everywhere.",

		section_how: "How it works",
		section_how_sub: "Three primitives. Everything else is layering.",

		how_1_title: "Derive",
		how_1_body:
			"Your master password plus a per-user salt is stretched with Argon2id into two keys: one for unlock, one for vault decryption. The unlock key is hashed again before it ever leaves the device.",

		how_2_title: "Encrypt",
		how_2_body:
			"Every record is individually sealed with XChaCha20-Poly1305. Metadata — folder, favicon, modified time — is also encrypted. The server sees opaque ciphertext and a timestamp.",

		how_3_title: "Sync",
		how_3_body:
			"Changes are merged with a CRDT so you can edit offline on your phone and laptop simultaneously. No conflicts, no central lock. Sync is incremental and end-to-end authenticated.",

		section_mobile: "ZPass on mobile",
		section_mobile_sub:
			"The full vault, one hand, zero compromises. iOS and Android share the same encrypted core.",
		mobile_cta: "Get release updates →",
		mobile_status_ios: "iOS · in development",
		mobile_status_android: "Android · in development",

		section_security: "Security architecture",
		section_security_sub:
			"Every claim on this page is verifiable. The protocol is documented, the client is reproducible, the server has nothing to give up.",

		sec_1_k: "Threat model",
		sec_1_v:
			"Server compromise · TLS interception · Malicious update · Cold-boot recovery on lost device.",
		sec_2_k: "Cryptography",
		sec_2_v:
			"Argon2id (m=64MiB, t=3, p=4) · XChaCha20-Poly1305 · X25519 ECDH · Ed25519 · HKDF-SHA512.",
		sec_3_k: "Audits",
		sec_3_v:
			"Independent third-party audit planned before public release. Threat model and protocol spec will be published for review ahead of launch.",
		sec_4_k: "Reproducible",
		sec_4_v:
			"Deterministic release builds. Verify the binary you run matches the tagged commit.",
		sec_5_k: "Documented",
		sec_5_v:
			"Public protocol spec and threat model. Every cryptographic choice and data flow is explained — nothing in the vault path is hand-waved.",
		sec_6_k: "Boring",
		sec_6_v:
			"We don't invent cryptography. We use well-reviewed primitives in the way their authors intended.",

		section_pricing: "Pricing",
		section_pricing_sub:
			"Final prices will be confirmed at launch. Join the waitlist to lock in early-access pricing.",

		price_solo_name: "Free",
		price_solo_price: "$0",
		price_solo_unit: "for individuals",
		price_solo_bullets: [
			"Unlimited items",
			"All platforms",
			"TOTP, passkeys, hardware keys",
			"Local-first encrypted vault",
		],
		price_solo_cta: "Join waitlist",

		price_personal_name: "Personal",
		price_personal_price: "$3",
		price_personal_unit: "/month · hosted sync",
		price_personal_bullets: [
			"Everything in Free",
			"Hosted sync (EU / US)",
			"Unlimited devices",
			"Encrypted file attachments (1 GB)",
			"Emergency access",
		],
		price_personal_cta: "Join waitlist",

		price_family_name: "Family",
		price_family_price: "$5",
		price_family_unit: "/month · up to 6 people",
		price_family_bullets: [
			"Everything in Personal",
			"Shared family folders",
			"Per-member permissions",
			"50 GB pooled storage",
		],
		price_family_cta: "Join waitlist",

		price_team_name: "Team",
		price_team_price: "$4",
		price_team_unit: "/user/month",
		price_team_bullets: [
			"SSO (SAML, OIDC)",
			"SCIM provisioning",
			"Audit log export",
			"Centralized policy controls",
		],
		price_team_cta: "Talk to us",

		section_faq: "FAQ",
		faq_1_q: "What happens if I forget my master password?",
		faq_1_a:
			"Without the master key we cannot decrypt your vault — that's the point. You can configure emergency access with a trusted contact, export a recovery kit to print, or enroll a hardware key as a second factor for unlock.",
		faq_2_q: "When will ZPass be available?",
		faq_2_a:
			"We're in active development right now. The desktop and mobile clients are well underway, and we'll begin a closed beta with waitlist subscribers ahead of the public launch. Subscribe with your email to be notified the moment it ships.",
		faq_3_q: "Can I import from 1Password / Bitwarden / LastPass?",
		faq_3_a:
			"Yes. The importer supports 1PUX, Bitwarden JSON, LastPass CSV, Chrome/Firefox/Safari exports, and KeePass KDBX. Import runs locally — no data uploads during migration.",
		faq_4_q: "Do you support passkeys?",
		faq_4_a:
			"Yes. ZPass stores WebAuthn credentials and syncs them across your devices, encrypted end-to-end. You can also use a hardware key as your unlock factor.",
		faq_5_q: "Where is my data stored on the hosted plan?",
		faq_5_a:
			"Your choice of EU (Frankfurt) or US (Virginia). Ciphertext only — we never hold your keys.",

		footer_tagline: "Boring cryptography. Careful design.",
		footer_product: "Product",
		footer_resources: "Resources",
		footer_company: "Company",
		footer_legal: "Legal",
		footer_version: "ZPass · in active development",
		footer_built: "© 2026 ZPass",

		l_product_download: "Subscribe",
		l_product_extension: "Browser extension",
		l_product_mobile: "Mobile app",
		l_product_cli: "CLI",
		l_product_changelog: "Roadmap",
		l_res_docs: "Docs",
		l_res_protocol: "Protocol spec",
		l_res_api: "API reference",
		l_res_status: "Status",
		l_res_security: "Security page",
		l_co_about: "About",
		l_co_blog: "Blog",
		l_co_careers: "Careers",
		l_co_contact: "Contact",
		l_legal_privacy: "Privacy",
		l_legal_terms: "Terms",
		l_legal_dpa: "DPA",
		l_legal_subprocessors: "Sub-processors",

		vault_demo_label: "Preview — vault",
		vault_demo_hint: "Click a row. Everything runs locally in your browser.",
		recent_label: "Recent",
		pinned_label: "Pinned",
		copied_toast: "Copied to clipboard",

		hero_stat_1_n: "zero",
		hero_stat_1_l: "Bytes of plaintext on our servers",
		hero_stat_2_n: "< 80ms",
		hero_stat_2_l: "Vault unlock on a 5-year-old phone",
		hero_stat_3_n: "XChaCha20",
		hero_stat_3_l: "Modern, audit-grade primitives",
		hero_stat_4_n: "2026",
		hero_stat_4_l: "Public release this year",
	},

	zh: {
		nav_features: "功能",
		nav_security: "安全",
		nav_download: "订阅",
		nav_pricing: "价格",
		nav_docs: "文档",
		nav_signin: "登录",

		hero_eyebrow: "端到端加密 · 零知识架构 · 开发中",
		hero_title_1: "一个不打扰你的",
		hero_title_2: "密码保险库。",
		hero_sub:
			"ZPass 是一款基于零知识架构的跨平台凭据管理器。你的数据以明文形式从不离开设备——无论传输中、存储时，还是我们的服务器上。",
		hero_cta_primary: "订阅发布通知",
		hero_availability: "macOS · Windows · Linux · iOS · Android · 浏览器扩展",

		// 替代原 install / config 区块的订阅文案
		subscribe_eyebrow: "抢先体验",
		subscribe_title: "ZPass 正在紧张研发中。",
		subscribe_sub:
			"我们正在为首个公开版本做最后打磨。留下你的邮箱，发布时第一时间通知你——除此之外不会发任何邮件。",
		subscribe_placeholder: "you@example.com",
		subscribe_cta: "通知我",
		subscribe_note: "一键退订。我们绝不分享你的地址，绝无营销邮件。",

		section_features: "功能",
		section_features_sub: "精简工具，严肃加密，没有暗黑模式。",

		f1_title: "端到端加密",
		f1_body:
			"采用 XChaCha20-Poly1305 与 Argon2id 密钥派生。你的主密码从不上线。连我们也无法解密你的保险库。",

		f2_title: "内置双因素验证",
		f2_body: "TOTP 验证码与账号并排显示。巨大的倒计时、一键复制、离线可用。",

		f3_title: "通行密钥与硬件密钥",
		f3_body:
			"一流的 FIDO2 / WebAuthn 支持。为值得更多保护的账号配对 YubiKey 或 Passkey。",

		f4_title: "家庭与团队共享",
		f4_body: "按文件夹、按收件人公钥授权。一键撤销。无需重新加密往返。",

		f5_title: "泄露监控",
		f5_body:
			"持续对 Have I Been Pwned 进行 k-匿名查询。永不发送密码哈希；域名泄露后第一时间提醒。",

		f6_title: "为日常使用而打造",
		f6_body:
			"主流操作系统均提供原生应用。iOS 与 Android 系统键盘自动填充。Chrome、Firefox、Safari 浏览器扩展。一个保险库，处处可用。",

		section_how: "工作原理",
		section_how_sub: "三个原语。其余都是叠加。",

		how_1_title: "派生",
		how_1_body:
			"主密码加上每用户盐，使用 Argon2id 拉伸为两个密钥：一个用于解锁，一个用于保险库解密。解锁密钥在离开设备前会再次哈希。",

		how_2_title: "加密",
		how_2_body:
			"每条记录使用 XChaCha20-Poly1305 独立封装。元数据——文件夹、图标、修改时间——也会被加密。服务器只看到不透明的密文与时间戳。",

		how_3_title: "同步",
		how_3_body:
			"使用 CRDT 合并变更，你可以同时在手机和电脑离线编辑。无冲突、无中心锁。同步是增量且端到端认证的。",

		section_mobile: "ZPass 移动端",
		section_mobile_sub:
			"完整保险库，单手操作，毫不妥协。iOS 与 Android 共用同一加密内核。",
		mobile_cta: "订阅发布通知 →",
		mobile_status_ios: "iOS · 开发中",
		mobile_status_android: "Android · 开发中",

		section_security: "安全架构",
		section_security_sub:
			"本页每一项声明皆可验证。协议有文档、客户端可复现、服务器无可交出。",

		sec_1_k: "威胁模型",
		sec_1_v: "服务器入侵 · TLS 中间人 · 恶意更新 · 设备丢失冷启动恢复。",
		sec_2_k: "密码学",
		sec_2_v:
			"Argon2id (m=64MiB, t=3, p=4) · XChaCha20-Poly1305 · X25519 ECDH · Ed25519 · HKDF-SHA512。",
		sec_3_k: "审计",
		sec_3_v:
			"公开发布前已规划独立第三方审计。威胁模型与协议规范将在上线前公开，接受外部评审。",
		sec_4_k: "可复现",
		sec_4_v: "确定性发布构建。验证你运行的二进制与标签提交一致。",
		sec_5_k: "公开记录",
		sec_5_v:
			"协议规范与威胁模型公开发布。每一项密码学选择、每一条数据流都有详尽说明——保险库路径中没有任何含糊其辞。",
		sec_6_k: "保守",
		sec_6_v: "我们不发明密码学。我们按作者原意使用经过充分审查的原语。",

		section_pricing: "价格",
		section_pricing_sub:
			"最终价格将在正式发布时确认。加入候补名单可锁定早期体验价。",

		price_solo_name: "免费版",
		price_solo_price: "¥0",
		price_solo_unit: "面向个人用户",
		price_solo_bullets: [
			"无限条目",
			"全平台支持",
			"TOTP、通行密钥、硬件密钥",
			"本地优先加密保险库",
		],
		price_solo_cta: "加入候补",

		price_personal_name: "个人版",
		price_personal_price: "¥22",
		price_personal_unit: "/月 · 托管同步",
		price_personal_bullets: [
			"包含免费版全部",
			"托管同步（欧 / 美）",
			"无限设备",
			"加密文件附件（1 GB）",
			"应急访问",
		],
		price_personal_cta: "加入候补",

		price_family_name: "家庭版",
		price_family_price: "¥38",
		price_family_unit: "/月 · 至多 6 人",
		price_family_bullets: [
			"包含个人版全部",
			"家庭共享文件夹",
			"成员权限",
			"50 GB 共享存储",
		],
		price_family_cta: "加入候补",

		price_team_name: "团队版",
		price_team_price: "¥30",
		price_team_unit: "/用户/月",
		price_team_bullets: [
			"SSO（SAML、OIDC）",
			"SCIM 自动配置",
			"审计日志导出",
			"集中策略管控",
		],
		price_team_cta: "联系我们",

		section_faq: "常见问题",
		faq_1_q: "如果忘记主密码怎么办？",
		faq_1_a:
			"没有主密钥我们无法解密你的保险库——这正是重点。你可以配置可信联系人的应急访问、导出可打印的恢复套件，或启用硬件密钥作为解锁的第二因素。",
		faq_2_q: "ZPass 什么时候发布？",
		faq_2_a:
			"目前正在紧张研发中。桌面端与移动端均已具备相当进度，我们会在公开发布前面向候补名单用户开放封闭测试。订阅邮箱，第一时间收到通知。",
		faq_3_q: "可以从 1Password / Bitwarden / LastPass 导入吗？",
		faq_3_a:
			"可以。导入器支持 1PUX、Bitwarden JSON、LastPass CSV、Chrome/Firefox/Safari 导出及 KeePass KDBX。导入在本地完成——迁移期间无数据上传。",
		faq_4_q: "支持通行密钥吗？",
		faq_4_a:
			"支持。ZPass 会存储 WebAuthn 凭据并端到端加密同步至你的所有设备。你也可以将硬件密钥作为解锁因素。",
		faq_5_q: "托管方案的数据存放在哪里？",
		faq_5_a:
			"你可选择欧盟（法兰克福）或美国（弗吉尼亚）。仅存储密文——我们从不持有你的密钥。",

		footer_tagline: "保守的密码学。细心的设计。",
		footer_product: "产品",
		footer_resources: "资源",
		footer_company: "公司",
		footer_legal: "法律",
		footer_version: "ZPass · 开发中",
		footer_built: "© 2026 ZPass",

		l_product_download: "订阅",
		l_product_extension: "浏览器扩展",
		l_product_mobile: "移动端",
		l_product_cli: "命令行",
		l_product_changelog: "路线图",
		l_res_docs: "文档",
		l_res_protocol: "协议规范",
		l_res_api: "API 参考",
		l_res_status: "状态",
		l_res_security: "安全页",
		l_co_about: "关于",
		l_co_blog: "博客",
		l_co_careers: "招聘",
		l_co_contact: "联系",
		l_legal_privacy: "隐私",
		l_legal_terms: "条款",
		l_legal_dpa: "数据处理",
		l_legal_subprocessors: "子处理者",

		vault_demo_label: "预览 — 保险库",
		vault_demo_hint: "点击任一行。所有运算都在你的浏览器本地完成。",
		recent_label: "最近",
		pinned_label: "置顶",
		copied_toast: "已复制",

		hero_stat_1_n: "零",
		hero_stat_1_l: "我们服务器上的明文字节",
		hero_stat_2_n: "< 80 毫秒",
		hero_stat_2_l: "五年老机上的解锁耗时",
		hero_stat_3_n: "XChaCha20",
		hero_stat_3_l: "现代审计级密码学原语",
		hero_stat_4_n: "2026",
		hero_stat_4_l: "年内首次公开发布",
	},
};

window.ZPASS_SITE_STRINGS = SITE_STRINGS;
