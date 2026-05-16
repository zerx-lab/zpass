// ZPass marketing site — single-file React app

const { useState, useEffect, useRef, useMemo } = React;
const S = window.ZPASS_SITE_STRINGS;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
	theme: "dark",
	accent: "#d4ff3a",
	body: "sans",
	lang: "en",
	heroVariant: "terminal",
	showDemo: true,
} /*EDITMODE-END*/;

const ACCENTS = [
	{ name: "lime", v: "#d4ff3a" },
	{ name: "amber", v: "#f0b72c" },
	{ name: "cyan", v: "#6fd3e8" },
	{ name: "rose", v: "#f06b7e" },
	{ name: "violet", v: "#b38cff" },
];

// ——— Reveal on scroll ———
function useReveal() {
	useEffect(() => {
		const els = document.querySelectorAll(".reveal");
		// Mark off-screen below as pending; elements already visible or above stay visible.
		const vh = window.innerHeight;
		els.forEach((el) => {
			const r = el.getBoundingClientRect();
			if (r.top > vh * 0.9) el.classList.add("pending");
			else el.classList.add("in");
		});
		const io = new IntersectionObserver(
			(entries) => {
				entries.forEach((e) => {
					if (e.isIntersecting) {
						e.target.classList.add("in");
						e.target.classList.remove("pending");
					}
				});
			},
			{ threshold: 0.05, rootMargin: "0px 0px -5% 0px" },
		);
		els.forEach((el) => io.observe(el));
		return () => io.disconnect();
	});
}

// ——— Typing effect for terminal ———
function Typer({ text, speed = 18, delay = 0, onDone }) {
	const [out, setOut] = useState("");
	useEffect(() => {
		let i = 0,
			timer;
		const start = setTimeout(function tick() {
			if (i <= text.length) {
				setOut(text.slice(0, i));
				i++;
				timer = setTimeout(tick, speed);
			} else {
				onDone && onDone();
			}
		}, delay);
		return () => {
			clearTimeout(start);
			clearTimeout(timer);
		};
	}, [text]);
	return <span>{out}</span>;
}

// ——— Nav ———
function Nav({ lang, setLang, t }) {
	return (
		<nav className="nav">
			<div className="wrap nav-inner">
				<a href="#top" className="brand">
					<span className="logo">Z</span>
					<span>ZPass</span>
					{/* 前期开发期：版本徽标显示 preview 而非具体版本号 */}
					<span className="tag mono">preview</span>
				</a>
				<div className="nav-links">
					<a href="#features">{t.nav_features}</a>
					<a href="#how">{t.section_how}</a>
					<a href="#security">{t.nav_security}</a>
					<a href="#download">{t.nav_download}</a>
					<a href="#faq">FAQ</a>
				</div>
				<div className="nav-spacer" />
				<div className="nav-right">
					<div className="lang-toggle">
						<button
							className={lang === "en" ? "on" : ""}
							onClick={() => setLang("en")}
						>
							EN
						</button>
						<button
							className={lang === "zh" ? "on" : ""}
							onClick={() => setLang("zh")}
						>
							中文
						</button>
					</div>
					{/* 前期开发期：移除 Sign in,主 CTA 统一为订阅 */}
					<a href="#download" className="btn primary">
						✉ {t.nav_download} <span className="arrow">→</span>
					</a>
				</div>
			</div>
		</nav>
	);
}

// ——— HERO Variant A: Terminal ———
function HeroTerminal({ t }) {
	const [step, setStep] = useState(0);
	return (
		<div className="hero-panel">
			<div className="hero-panel-head">
				<span className="dots">
					<i />
					<i />
					<i />
				</span>
				<span className="title">— zsh · ~/zpass · preview</span>
				<span className="spacer" />
				<span className="tag">in development</span>
			</div>
			<div className="terminal">
				<div>
					<span className="prompt">$</span>
					<span className="cmd">
						<Typer
							text="curl -fsSL get.zpass.dev | sh"
							onDone={() => setStep(1)}
						/>
					</span>
				</div>
				{step >= 1 && (
					<>
						<div className="out">
							&gt; fetching zpass-cli v3.2.0 (darwin-arm64, 14.2 MB)
						</div>
						<div className="out">
							&gt; verifying signature ... <span className="ok">ok</span>
						</div>
						<div className="out">
							&gt; verifying reproducible hash ...{" "}
							<span className="ok">ok</span>
						</div>
						<div className="out">&gt; installed to /usr/local/bin/zpass</div>
						<div>
							<span className="prompt">$</span>
							<span className="cmd">
								<Typer
									text="zpass init"
									delay={300}
									onDone={() => setStep(2)}
								/>
							</span>
						</div>
					</>
				)}
				{step >= 2 && (
					<>
						<div className="out">&gt; generating X25519 keypair ...</div>
						<div className="out">
							&gt; deriving vault key (Argon2id, m=64MiB, t=3, p=4) ...
						</div>
						<div className="ok">&gt; vault ready · 0 items</div>
						<div>
							<span className="prompt">$</span>
							<span className="caret" />
						</div>
					</>
				)}
			</div>
		</div>
	);
}

// ——— HERO Variant B: Crypto Diagram ———
function HeroCrypto({ t }) {
	return (
		<div className="hero-panel">
			<div className="hero-panel-head">
				<span className="dots">
					<i />
					<i />
					<i />
				</span>
				<span className="title">— encryption flow</span>
				<span className="spacer" />
				<span className="tag">zero-knowledge</span>
			</div>
			<div className="cryptopanel">
				<svg
					className="crypto-svg"
					viewBox="0 0 900 320"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<defs>
						<marker
							id="arr"
							viewBox="0 0 10 10"
							refX="8"
							refY="5"
							markerWidth="6"
							markerHeight="6"
							orient="auto"
						>
							<path d="M0,0 L10,5 L0,10 Z" fill="currentColor" />
						</marker>
					</defs>
					<g stroke="var(--line)" strokeWidth="1">
						<rect
							x="20"
							y="70"
							width="200"
							height="180"
							rx="8"
							fill="var(--bg-elev-2)"
						/>
						<rect
							x="350"
							y="30"
							width="200"
							height="80"
							rx="8"
							fill="var(--bg-elev-2)"
						/>
						<rect
							x="350"
							y="130"
							width="200"
							height="80"
							rx="8"
							fill="var(--bg-elev-2)"
						/>
						<rect
							x="350"
							y="230"
							width="200"
							height="80"
							rx="8"
							fill="var(--bg-elev-2)"
						/>
						<rect
							x="680"
							y="130"
							width="200"
							height="80"
							rx="8"
							fill="var(--bg-elev-2)"
						/>
					</g>
					<g fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-2)">
						<text x="40" y="100">
							DEVICE
						</text>
						<text x="40" y="130" fill="var(--text)" fontSize="13">
							master password
						</text>
						<text x="40" y="155" fill="var(--text-3)">
							+ per-user salt
						</text>
						<text x="40" y="195" fill="var(--accent)" fontWeight="500">
							Argon2id
						</text>
						<text x="40" y="215" fill="var(--text-3)">
							m=64MiB · t=3 · p=4
						</text>

						<text x="370" y="55" fill="var(--text-3)">
							unlock key
						</text>
						<text x="370" y="80" fill="var(--text)" fontSize="13">
							K_unlock
						</text>
						<text x="370" y="100" fill="var(--text-3)">
							SHA-512 hashed before send
						</text>

						<text x="370" y="155" fill="var(--text-3)">
							vault key
						</text>
						<text x="370" y="180" fill="var(--text)" fontSize="13">
							K_vault (never leaves device)
						</text>

						<text x="370" y="255" fill="var(--text-3)">
							identity key
						</text>
						<text x="370" y="280" fill="var(--text)" fontSize="13">
							Ed25519 · X25519
						</text>

						<text x="700" y="155" fill="var(--text-3)">
							SERVER SEES
						</text>
						<text x="700" y="180" fill="var(--text)" fontSize="13">
							ciphertext only
						</text>
						<text x="700" y="200" fill="var(--text-3)">
							+ opaque timestamps
						</text>
					</g>
					<g
						stroke="var(--text-3)"
						fill="none"
						markerEnd="url(#arr)"
						color="var(--text-3)"
					>
						<path d="M220 140 L350 70" />
						<path d="M220 160 L350 170" />
						<path d="M220 180 L350 270" />
						<path d="M550 170 L680 170" />
					</g>
				</svg>
				<div className="crypto-legend">
					<span>
						<i className="sw" style={{ background: "var(--accent)" }} />
						derivation
					</span>
					<span>
						<i className="sw" style={{ background: "var(--text-2)" }} />
						keys (local only)
					</span>
					<span>
						<i className="sw" style={{ background: "var(--text-3)" }} />
						server-visible
					</span>
				</div>
			</div>
		</div>
	);
}

// ——— HERO Variant C: Live demo ———
function HeroDemo() {
	return (
		<div className="hero-panel">
			<div className="hero-panel-head">
				<span className="dots">
					<i />
					<i />
					<i />
				</span>
				<span className="title">— zpass.dev / vault</span>
				<span className="spacer" />
				<span className="tag">live · in your browser</span>
			</div>
			<iframe className="demo-frame" src="ZPass.html" title="ZPass live" />
			<div className="demo-hint">
				<span>click a row · everything runs locally</span>
				<span>↑ no data leaves your browser</span>
			</div>
		</div>
	);
}

function Hero({ t, variant, lang }) {
	return (
		<section className="hero" id="top">
			<div className="hero-grid-bg" />
			<div className="wrap" style={{ position: "relative" }}>
				<span className="cross" style={{ left: -5, top: -5 }} />
				<span className="cross" style={{ right: -5, top: -5 }} />
				<div className="eyebrow">
					<span className="dot" />
					{t.hero_eyebrow}
				</div>
				<h1>
					<span>{t.hero_title_1}</span>{" "}
					<span className="dim">{t.hero_title_2}</span>
				</h1>
				<p className="lede">{t.hero_sub}</p>
				<div className="hero-cta">
					{/* 前期开发期：仅保留主 CTA(订阅发布通知),移除原"查看源代码"副 CTA */}
					<a href="#download" className="btn primary">
						✉ {t.hero_cta_primary}
					</a>
				</div>
				<div className="hero-availability mono">{t.hero_availability}</div>

				{variant === "terminal" && <HeroTerminal t={t} />}
				{variant === "crypto" && <HeroCrypto t={t} />}
				{variant === "demo" && <HeroDemo />}

				<div className="hero-stats mono">
					{[1, 2, 3, 4].map((n) => (
						<div key={n}>
							<div className="n">{t[`hero_stat_${n}_n`]}</div>
							<div className="l">{t[`hero_stat_${n}_l`]}</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

// ——— Install ———
// 前期开发期:用 Subscribe(邮件订阅)替代原 Install(curl 安装命令)
// 产品尚未发布,无可下载二进制,改为收集邮箱、发布时通知。
function Install({ t }) {
	const [email, setEmail] = useState("");
	const [status, setStatus] = useState(""); // "" | "ok" | "err"
	const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	const submit = (e) => {
		e.preventDefault();
		const v = (email || "").trim();
		if (!EMAIL_RE.test(v)) {
			setStatus("err");
			return;
		}
		// 真实后端尚未接入——前期演示阶段,本地直接置成功态。
		setStatus("ok");
		setEmail("");
	};

	return (
		<section className="install" id="download">
			<div className="wrap">
				<div className="install-grid">
					{/* ===== 卡片 1：邮件订阅表单 ===== */}
					<div className="install-card reveal">
						<div className="head">
							<span className="n">✉</span>
							<span className="t">{t.subscribe_title}</span>
							<span className="tag">{t.subscribe_eyebrow}</span>
						</div>
						<div className="body">
							<p
								style={{
									color: "var(--text-2)",
									fontSize: 14,
									lineHeight: 1.55,
									margin: "0 0 16px",
								}}
							>
								{t.subscribe_sub}
							</p>
							<form
								onSubmit={submit}
								style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
							>
								<input
									className="mono"
									type="email"
									required
									placeholder={t.subscribe_placeholder}
									value={email}
									onChange={(e) => {
										setEmail(e.target.value);
										setStatus("");
									}}
									style={{
										flex: "1 1 220px",
										minWidth: 0,
										background: "var(--bg-elev-2)",
										border:
											"1px solid " +
											(status === "err" ? "#ff6b6b" : "var(--line)"),
										color: "var(--text)",
										borderRadius: 10,
										padding: "12px 14px",
										fontSize: 13,
										outline: "none",
									}}
								/>
								<button
									type="submit"
									className="btn primary"
									style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}
								>
									{t.subscribe_cta} <span className="arrow">→</span>
								</button>
							</form>
							<div
								className="mono"
								style={{
									marginTop: 12,
									fontSize: 12,
									minHeight: 16,
									color:
										status === "ok"
											? "var(--accent)"
											: status === "err"
												? "#ff6b6b"
												: "var(--text-3)",
								}}
							>
								{status === "ok"
									? "✓ subscribed"
									: status === "err"
										? "× please enter a valid email"
										: ""}
							</div>
						</div>
						<div className="desc">{t.subscribe_note}</div>
					</div>

					{/* ===== 卡片 2：构建状态(静态) ===== */}
					<div className="install-card reveal">
						<div className="head">
							<span className="n">●</span>
							<span className="t">build status</span>
							<span className="tag">live</span>
						</div>
						<div className="body">
							<div className="comment">// desktop client</div>
							<div className="cmd">
								<span style={{ color: "var(--accent)" }}>●</span> macOS · in
								development
							</div>
							<div className="cmd">
								<span style={{ color: "var(--accent)" }}>●</span> Windows · in
								development
							</div>
							<div className="cmd">
								<span style={{ color: "var(--accent)" }}>●</span> Linux · in
								development
							</div>
							<div className="comment" style={{ marginTop: 8 }}>
								// mobile
							</div>
							<div className="cmd">
								<span style={{ color: "var(--accent)" }}>●</span>{" "}
								{t.mobile_status_ios}
							</div>
							<div className="cmd">
								<span style={{ color: "var(--accent)" }}>●</span>{" "}
								{t.mobile_status_android}
							</div>
						</div>
						<div className="desc">{t.subscribe_eyebrow}</div>
					</div>
				</div>
			</div>
		</section>
	);
}

// ——— Features ———
function FeatIcon({ kind }) {
	const p = {
		stroke: "currentColor",
		fill: "none",
		strokeWidth: 1.4,
		strokeLinecap: "round",
		strokeLinejoin: "round",
	};
	if (kind === "enc")
		return (
			<svg width="16" height="16" viewBox="0 0 24 24" {...p}>
				<rect x="5" y="11" width="14" height="9" rx="2" />
				<path d="M8 11V7a4 4 0 0 1 8 0v4" />
			</svg>
		);
	if (kind === "totp")
		return (
			<svg width="16" height="16" viewBox="0 0 24 24" {...p}>
				<circle cx="12" cy="12" r="8" />
				<path d="M12 8v4l3 2" />
			</svg>
		);
	if (kind === "key")
		return (
			<svg width="16" height="16" viewBox="0 0 24 24" {...p}>
				<circle cx="8" cy="12" r="4" />
				<path d="M12 12h10M18 12v3M22 12v3" />
			</svg>
		);
	if (kind === "team")
		return (
			<svg width="16" height="16" viewBox="0 0 24 24" {...p}>
				<circle cx="9" cy="10" r="3" />
				<circle cx="17" cy="11" r="2.5" />
				<path d="M3 20c0-3 3-5 6-5s6 2 6 5M14 20c0-2 2-3.5 4-3.5s4 1.5 4 3.5" />
			</svg>
		);
	if (kind === "breach")
		return (
			<svg width="16" height="16" viewBox="0 0 24 24" {...p}>
				<path d="M3 18l9-14 9 14H3z" />
				<path d="M12 10v4M12 16v.5" />
			</svg>
		);
	if (kind === "self")
		return (
			<svg width="16" height="16" viewBox="0 0 24 24" {...p}>
				<rect x="3" y="5" width="18" height="6" rx="1" />
				<rect x="3" y="13" width="18" height="6" rx="1" />
				<circle cx="7" cy="8" r="0.8" fill="currentColor" />
				<circle cx="7" cy="16" r="0.8" fill="currentColor" />
			</svg>
		);
	return null;
}
function Features({ t }) {
	const items = [
		["enc", t.f1_title, t.f1_body],
		["totp", t.f2_title, t.f2_body],
		["key", t.f3_title, t.f3_body],
		["team", t.f4_title, t.f4_body],
		["breach", t.f5_title, t.f5_body],
		["self", t.f6_title, t.f6_body],
	];
	return (
		<section className="section" id="features">
			<div className="wrap">
				<div className="sec-head reveal">
					<div className="index mono">
						<b>01</b> / {t.section_features}
					</div>
					<div>
						<h2>{t.section_features}</h2>
						<div className="sec-sub">{t.section_features_sub}</div>
					</div>
				</div>
				<div className="features">
					{items.map(([k, title, body], i) => (
						<div className="feature reveal" key={k}>
							<div className="num">F.0{i + 1}</div>
							<h3>{title}</h3>
							<p>{body}</p>
							<div className="icon">
								<FeatIcon kind={k} />
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

// ——— How it works ———
function HowDiagram({ step }) {
	return (
		<svg viewBox="0 0 460 420" width="100%" height="auto" fill="none">
			<defs>
				<marker
					id="hm"
					viewBox="0 0 10 10"
					refX="8"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto"
				>
					<path d="M0,0 L10,5 L0,10 Z" fill="currentColor" />
				</marker>
			</defs>
			{/* device */}
			<g>
				<rect
					x="30"
					y="30"
					width="180"
					height="360"
					rx="10"
					fill="var(--bg-elev-2)"
					stroke="var(--line)"
				/>
				<text
					x="50"
					y="58"
					fill="var(--text-3)"
					fontSize="11"
					fontFamily="var(--font-mono)"
				>
					DEVICE
				</text>
				<text
					x="50"
					y="80"
					fill="var(--text)"
					fontSize="13"
					fontFamily="var(--font-mono)"
				>
					alex@zpass
				</text>

				{/* step 1 */}
				<g opacity={step >= 0 ? 1 : 0.35}>
					<rect
						x="48"
						y="100"
						width="144"
						height="68"
						rx="6"
						fill={step === 0 ? "var(--bg-active)" : "var(--bg)"}
						stroke={step === 0 ? "var(--accent)" : "var(--line)"}
					/>
					<text
						x="60"
						y="120"
						fill="var(--text-3)"
						fontSize="10"
						fontFamily="var(--font-mono)"
					>
						1 · DERIVE
					</text>
					<text
						x="60"
						y="140"
						fill="var(--text)"
						fontSize="12"
						fontFamily="var(--font-mono)"
					>
						Argon2id
					</text>
					<text
						x="60"
						y="158"
						fill="var(--text-3)"
						fontSize="11"
						fontFamily="var(--font-mono)"
					>
						→ K_vault
					</text>
				</g>
				{/* step 2 */}
				<g opacity={step >= 1 ? 1 : 0.35}>
					<rect
						x="48"
						y="190"
						width="144"
						height="68"
						rx="6"
						fill={step === 1 ? "var(--bg-active)" : "var(--bg)"}
						stroke={step === 1 ? "var(--accent)" : "var(--line)"}
					/>
					<text
						x="60"
						y="210"
						fill="var(--text-3)"
						fontSize="10"
						fontFamily="var(--font-mono)"
					>
						2 · ENCRYPT
					</text>
					<text
						x="60"
						y="230"
						fill="var(--text)"
						fontSize="12"
						fontFamily="var(--font-mono)"
					>
						XChaCha20-
					</text>
					<text
						x="60"
						y="246"
						fill="var(--text)"
						fontSize="12"
						fontFamily="var(--font-mono)"
					>
						Poly1305
					</text>
				</g>
				{/* step 3 */}
				<g opacity={step >= 2 ? 1 : 0.35}>
					<rect
						x="48"
						y="280"
						width="144"
						height="68"
						rx="6"
						fill={step === 2 ? "var(--bg-active)" : "var(--bg)"}
						stroke={step === 2 ? "var(--accent)" : "var(--line)"}
					/>
					<text
						x="60"
						y="300"
						fill="var(--text-3)"
						fontSize="10"
						fontFamily="var(--font-mono)"
					>
						3 · SYNC
					</text>
					<text
						x="60"
						y="320"
						fill="var(--text)"
						fontSize="12"
						fontFamily="var(--font-mono)"
					>
						CRDT merge
					</text>
					<text
						x="60"
						y="338"
						fill="var(--text-3)"
						fontSize="11"
						fontFamily="var(--font-mono)"
					>
						E2E auth
					</text>
				</g>
			</g>
			{/* arrow */}
			<g
				stroke={step === 2 ? "var(--accent)" : "var(--text-3)"}
				color={step === 2 ? "var(--accent)" : "var(--text-3)"}
				markerEnd="url(#hm)"
			>
				<path d="M210 314 L 280 314" />
			</g>
			{/* server */}
			<g opacity={step >= 2 ? 1 : 0.5}>
				<rect
					x="290"
					y="270"
					width="140"
					height="80"
					rx="8"
					fill="var(--bg-elev-2)"
					stroke="var(--line)"
				/>
				<text
					x="306"
					y="294"
					fill="var(--text-3)"
					fontSize="10"
					fontFamily="var(--font-mono)"
				>
					SERVER
				</text>
				<text
					x="306"
					y="314"
					fill="var(--text)"
					fontSize="12"
					fontFamily="var(--font-mono)"
				>
					ciphertext
				</text>
				<text
					x="306"
					y="332"
					fill="var(--text-3)"
					fontSize="11"
					fontFamily="var(--font-mono)"
				>
					+ opaque meta
				</text>
			</g>
		</svg>
	);
}
function How({ t }) {
	const [step, setStep] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setStep((s) => (s + 1) % 3), 2800);
		return () => clearInterval(id);
	}, []);
	const steps = [
		[t.how_1_title, t.how_1_body],
		[t.how_2_title, t.how_2_body],
		[t.how_3_title, t.how_3_body],
	];
	return (
		<section className="section" id="how">
			<div className="wrap">
				<div className="sec-head reveal">
					<div className="index mono">
						<b>02</b> / {t.section_how}
					</div>
					<div>
						<h2>{t.section_how}</h2>
						<div className="sec-sub">{t.section_how_sub}</div>
					</div>
				</div>
				<div className="how">
					<div className="how-diagram reveal">
						<HowDiagram step={step} />
					</div>
					<div className="how-steps">
						{steps.map(([title, body], i) => (
							<button
								className={"how-step reveal " + (step === i ? "active" : "")}
								onClick={() => setStep(i)}
								key={i}
							>
								<div className="kicker mono">
									<span className="k">{i + 1}</span> PRIMITIVE · 0{i + 1}
								</div>
								<h3>{title}</h3>
								<p>{body}</p>
							</button>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

// ——— Live demo ———
// 前期开发期:Live 区块默认关闭(show=false),不对外展示可交互预览,
// 避免误导用户以为产品已可立即试用。
function Live({ t, show }) {
	if (!show) return null;
	return (
		<section className="live" id="demo">
			<div className="wrap">
				<div className="sec-head reveal">
					<div className="index mono">
						<b>03</b> / PREVIEW
					</div>
					<div>
						<h2>{t.vault_demo_label}</h2>
						<div className="sec-sub">{t.vault_demo_hint}</div>
					</div>
				</div>
				<div className="live-frame-wrap reveal">
					<div className="live-head">
						<span className="dots" style={{ display: "flex", gap: 6 }}>
							<i
								style={{
									width: 10,
									height: 10,
									borderRadius: "50%",
									background: "#3a3a3f",
									display: "inline-block",
								}}
							/>
							<i
								style={{
									width: 10,
									height: 10,
									borderRadius: "50%",
									background: "#3a3a3f",
									display: "inline-block",
								}}
							/>
							<i
								style={{
									width: 10,
									height: 10,
									borderRadius: "50%",
									background: "#3a3a3f",
									display: "inline-block",
								}}
							/>
						</span>
						<div className="url">
							<span>preview.zpass.dev</span>
						</div>
						<span style={{ color: "var(--text-3)" }}>local · 0ms</span>
					</div>
					<iframe src="ZPass.html" title="ZPass vault" />
				</div>
			</div>
		</section>
	);
}

// ——— Mobile ———
function Mobile({ t }) {
	return (
		<section className="section" id="mobile">
			<div className="wrap">
				<div className="sec-head reveal">
					<div className="index mono">
						<b>04</b> / MOBILE
					</div>
					<div>
						<h2>{t.section_mobile}</h2>
						<div className="sec-sub">{t.section_mobile_sub}</div>
					</div>
				</div>
				<div className="mobile-row">
					<div className="mobile-copy reveal">
						<div
							className="mono"
							style={{
								color: "var(--text-3)",
								fontSize: 11,
								letterSpacing: "0.08em",
							}}
						>
							IOS · ANDROID · FACE ID · AUTOFILL
						</div>
						<h2 style={{ marginTop: 18 }}>Your vault, in your thumb.</h2>
						<p
							style={{
								color: "var(--text-2)",
								maxWidth: "48ch",
								marginTop: 18,
								fontSize: 15,
							}}
						>
							The mobile client uses the same crypto core as the desktop build.
							Autofill into iOS and Android system keyboards. TOTP codes surface
							on the lock screen when you need them, nowhere else.
						</p>
						<div
							style={{
								marginTop: 28,
								display: "flex",
								gap: 10,
								flexWrap: "wrap",
							}}
						>
							{/* 前期开发期：移除"打开原型 / App Store / Google Play"等
							    已发布产品才有的入口,改为统一指向邮件订阅区块 */}
							<a href="#download" className="btn primary">
								✉ {t.hero_cta_primary}
							</a>
						</div>
						{/* 前期开发期：移除 F-Droid/TestFlight 等已发布渠道字样,改为开发状态 */}
						<div
							className="mono"
							style={{
								marginTop: 28,
								color: "var(--text-3)",
								fontSize: 11,
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 10,
								maxWidth: 360,
							}}
						>
							<div>{t.mobile_status_ios}</div>
							<div>{t.mobile_status_android}</div>
							<div>Face ID · Touch ID</div>
							<div>system autofill</div>
						</div>
					</div>
					<div className="mobile-stage reveal">
						<div className="phone-bezel">
							<div
								className="phone-screen"
								style={{
									display: "flex",
									flexDirection: "column",
									background: "#0c0c0d",
									color: "#ececec",
									padding: "0",
									fontFamily: "var(--font-sans)",
								}}
							>
								{/* Status bar */}
								<div
									style={{
										padding: "16px 22px 0",
										display: "flex",
										justifyContent: "space-between",
										fontFamily: "var(--font-mono)",
										fontSize: 12,
										color: "#ececec",
									}}
								>
									<span>9:41</span>
									<span
										style={{
											display: "inline-flex",
											gap: 4,
											alignItems: "center",
										}}
									>
										<span
											style={{
												width: 14,
												height: 8,
												border: "1px solid #ececec",
												borderRadius: 2,
												display: "inline-block",
												position: "relative",
											}}
										>
											<span
												style={{
													position: "absolute",
													inset: 1,
													right: 4,
													background: "#ececec",
													borderRadius: 1,
												}}
											/>
										</span>
									</span>
								</div>
								{/* header */}
								<div style={{ padding: "40px 22px 14px" }}>
									<div
										style={{
											fontFamily: "var(--font-mono)",
											fontSize: 10,
											color: "#6e6e73",
											letterSpacing: "0.1em",
											textTransform: "uppercase",
										}}
									>
										VAULT · 412 ITEMS
									</div>
									<div
										style={{
											fontSize: 26,
											fontWeight: 500,
											letterSpacing: "-0.02em",
											marginTop: 4,
										}}
									>
										Good evening, Alex
									</div>
								</div>
								{/* search */}
								<div
									style={{
										margin: "0 16px",
										padding: "10px 14px",
										background: "#16161a",
										border: "1px solid #232328",
										borderRadius: 10,
										fontFamily: "var(--font-mono)",
										fontSize: 12,
										color: "#6e6e73",
										display: "flex",
										alignItems: "center",
										gap: 10,
									}}
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
									>
										<circle cx="11" cy="11" r="7" />
										<path d="M21 21l-4-4" />
									</svg>
									Search vault…
								</div>
								{/* rows */}
								<div
									style={{
										padding: "14px 16px 0",
										display: "flex",
										flexDirection: "column",
										gap: 8,
										flex: 1,
									}}
								>
									{[
										["GH", "GitHub", "alex.rivera@…", "482 917"],
										["VC", "Vercel", "alex@zpass.dev", "061 284"],
										["AW", "AWS Console", "alex-admin", "309 117"],
										["ST", "Stripe", "ops@zpass.dev", "—"],
									].map(([m, n, u, code]) => (
										<div
											key={n}
											style={{
												display: "flex",
												alignItems: "center",
												gap: 12,
												padding: "10px 12px",
												background: "#16161a",
												border: "1px solid #232328",
												borderRadius: 10,
											}}
										>
											<div
												style={{
													width: 30,
													height: 30,
													borderRadius: 5,
													background: "#1d1d22",
													border: "1px solid #232328",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													fontFamily: "var(--font-mono)",
													fontSize: 10,
													color: "#a8a8ac",
												}}
											>
												{m}
											</div>
											<div style={{ flex: 1, minWidth: 0 }}>
												<div style={{ fontSize: 13, fontWeight: 500 }}>{n}</div>
												<div
													style={{
														fontFamily: "var(--font-mono)",
														fontSize: 10,
														color: "#6e6e73",
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}
												>
													{u}
												</div>
											</div>
											<div
												style={{
													fontFamily: "var(--font-mono)",
													fontSize: 13,
													color: code === "—" ? "#45454a" : "#d4ff3a",
													letterSpacing: "0.1em",
												}}
											>
												{code}
											</div>
										</div>
									))}
								</div>
								{/* tab bar */}
								<div
									style={{
										marginTop: "auto",
										padding: "12px 0 24px",
										borderTop: "1px solid #1a1a1e",
										display: "grid",
										gridTemplateColumns: "repeat(4,1fr)",
										background: "#0c0c0d",
									}}
								>
									{[
										["Vault", true],
										["Generator", false],
										["Security", false],
										["Settings", false],
									].map(([l, on]) => (
										<div
											key={l}
											style={{
												textAlign: "center",
												fontFamily: "var(--font-mono)",
												fontSize: 10,
												color: on ? "#ececec" : "#6e6e73",
												letterSpacing: "0.04em",
											}}
										>
											<div
												style={{
													width: 4,
													height: 4,
													borderRadius: 2,
													background: on ? "#d4ff3a" : "transparent",
													margin: "0 auto 6px",
												}}
											/>
											{l}
										</div>
									))}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

// ——— Security ———
function Security({ t }) {
	const cells = [1, 2, 3, 4, 5, 6].map((n) => [
		t[`sec_${n}_k`],
		t[`sec_${n}_v`],
	]);
	// 前期开发期:尚未进行真实第三方审计,卡片展示为"已规划"占位
	const audits = [
		{
			firm: "Threat model",
			scope: "Vault path · sync protocol",
			date: "in progress",
		},
		{
			firm: "Cryptographic review",
			scope: "Pre-launch external review",
			date: "planned",
		},
		{
			firm: "Independent audit",
			scope: "Full client + protocol audit",
			date: "before public release",
		},
	];
	return (
		<section className="section" id="security">
			<div className="wrap">
				<div className="sec-head reveal">
					<div className="index mono">
						<b>05</b> / {t.section_security}
					</div>
					<div>
						<h2>{t.section_security}</h2>
						<div className="sec-sub">{t.section_security_sub}</div>
					</div>
				</div>
				<div className="sec-grid">
					{cells.map(([k, v], i) => (
						<div className="sec-cell reveal" key={i}>
							<div className="k mono">S.0{i + 1}</div>
							<h4>{k}</h4>
							<div className="v">{v}</div>
						</div>
					))}
				</div>
				<div className="audits">
					{audits.map((a) => (
						<div className="audit-card reveal" key={a.firm}>
							<div className="firm mono">PLANNED</div>
							<h5>{a.firm}</h5>
							<div className="meta mono">
								{a.scope} · {a.date}
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

// ——— Changelog ———
// 前期开发期:Changelog 改为 Roadmap 路线图
// 不再展示已发布版本号,而是用阶段编号(M01...) + 时间窗口表达
// "正在做什么 / 计划做什么",避免出现 v3.x 已发布、Sigstore 签名、
// Cure53 审计等"已完成"措辞。
function Changelog() {
	const items = [
		{
			phase: "M01",
			window: "in progress",
			tags: [["feat", "Building"]],
			notes:
				"Vault core: Argon2id key derivation, XChaCha20-Poly1305 record sealing, on-disk encrypted store. Local-only — no sync yet.",
		},
		{
			phase: "M02",
			window: "in progress",
			tags: [["feat", "Building"]],
			notes:
				"Desktop client for macOS, Windows and Linux. Single window, keyboard-first, biometric unlock where the OS supports it.",
		},
		{
			phase: "M03",
			window: "next",
			tags: [["feat", "Planned"]],
			notes:
				"iOS and Android clients. System keyboard autofill on both platforms. Same encrypted core as desktop.",
		},
		{
			phase: "M04",
			window: "next",
			tags: [["feat", "Planned"]],
			notes:
				"End-to-end encrypted sync over the public network. CRDT-based merge so simultaneous offline edits never conflict.",
		},
		{
			phase: "M05",
			window: "before launch",
			tags: [
				["feat", "Planned"],
				["sec", "Review"],
			],
			notes:
				"Browser extensions for Chrome, Firefox and Safari. Public protocol spec and threat model published for external review.",
		},
		{
			phase: "M06",
			window: "later",
			tags: [["fix", "Later"]],
			notes:
				"Closed beta opens to waitlist subscribers. Public release follows once the audit window closes and critical findings are resolved.",
		},
	];
	return (
		<section className="section" id="changelog">
			<div className="wrap">
				<div className="sec-head reveal">
					<div className="index mono">
						<b>06</b> / ROADMAP
					</div>
					<div>
						<h2>Roadmap</h2>
						<div className="sec-sub">
							What we're building, and roughly when. Dates may shift — quality
							and security come first.
						</div>
					</div>
				</div>
				<div className="changelog-list">
					{items.map((it, i) => (
						<div className="change reveal" key={i}>
							<div className="ver mono">
								<span>{it.phase}</span>
								<span className="d">{it.window}</span>
							</div>
							<div className="notes">
								{it.tags.map(([k, l]) => (
									<span className={"tag mono " + k} key={k}>
										{l}
									</span>
								))}
								<p>{it.notes}</p>
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

// ——— FAQ ———
function Faq({ t }) {
	const [open, setOpen] = useState(0);
	const items = [1, 2, 3, 4, 5].map((n) => [t[`faq_${n}_q`], t[`faq_${n}_a`]]);
	return (
		<section className="section" id="faq">
			<div className="wrap">
				<div className="sec-head reveal">
					<div className="index mono">
						<b>07</b> / FAQ
					</div>
					<div>
						<h2>{t.section_faq}</h2>
					</div>
				</div>
				<div className="faq-list">
					{items.map(([q, a], i) => (
						<div
							className={"faq-item reveal " + (open === i ? "open" : "")}
							key={i}
						>
							<button
								className="faq-q"
								onClick={() => setOpen(open === i ? -1 : i)}
							>
								<span
									className="mono"
									style={{ color: "var(--text-3)", fontSize: 12, minWidth: 32 }}
								>
									0{i + 1}
								</span>
								<span>{q}</span>
								<span className="i">+</span>
							</button>
							<div className="faq-a">{a}</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

// ——— Footer ———
function Foot({ t }) {
	const col = (title, links, keys) => (
		<div className="foot-col">
			<h6>{title}</h6>
			{keys.map((k) => (
				<a key={k} href="#">
					{t[k]}
				</a>
			))}
		</div>
	);
	return (
		<footer className="foot">
			<div className="wrap">
				<div className="foot-top">
					<div>
						<div className="brand" style={{ marginBottom: 2 }}>
							<span className="logo">Z</span>
							<span>ZPass</span>
						</div>
						<div className="foot-tagline">{t.footer_tagline}</div>
						{/* 前期开发期：移除"MIT · built in the open"标语,改为版权占位 */}
						<div
							className="mono"
							style={{ marginTop: 24, fontSize: 11, color: "var(--text-3)" }}
						>
							{t.footer_built}
						</div>
					</div>
					{col(t.footer_product, null, [
						"l_product_download",
						"l_product_extension",
						"l_product_mobile",
						"l_product_cli",
						"l_product_changelog",
					])}
					{col(t.footer_resources, null, [
						"l_res_docs",
						"l_res_protocol",
						"l_res_api",
						"l_res_status",
						"l_res_security",
					])}
					{col(t.footer_company, null, [
						"l_co_about",
						"l_co_blog",
						"l_co_careers",
						"l_co_contact",
					])}
					{col(t.footer_legal, null, [
						"l_legal_privacy",
						"l_legal_terms",
						"l_legal_dpa",
						"l_legal_subprocessors",
					])}
				</div>
				{/* 前期开发期：移除 MIT 许可与 SHA256 构建哈希,只保留版本与版权 */}
				<div className="foot-bottom">
					<span>{t.footer_version}</span>
					<span>{t.footer_built}</span>
				</div>
			</div>
		</footer>
	);
}

// ——— Tweaks panel ———
function Tweaks({ state, setState, active, onClose }) {
	if (!active) return null;
	const set = (patch) => {
		setState((s) => ({ ...s, ...patch }));
		try {
			window.parent.postMessage(
				{ type: "__edit_mode_set_keys", edits: patch },
				"*",
			);
		} catch {}
	};
	return (
		<div className={"tweaks-panel " + (active ? "on" : "")}>
			<div className="t-head">
				<h6>Tweaks</h6>
				<button onClick={onClose}>close ×</button>
			</div>
			<div className="tweak-row">
				<span className="k">Theme</span>
				<span className="segs">
					{["dark", "light"].map((v) => (
						<button
							key={v}
							className={state.theme === v ? "on" : ""}
							onClick={() => set({ theme: v })}
						>
							{v}
						</button>
					))}
				</span>
			</div>
			<div className="tweak-row">
				<span className="k">Font</span>
				<span className="segs">
					{["sans", "mono"].map((v) => (
						<button
							key={v}
							className={state.body === v ? "on" : ""}
							onClick={() => set({ body: v })}
						>
							{v}
						</button>
					))}
				</span>
			</div>
			<div className="tweak-row">
				<span className="k">Accent</span>
				<span className="swatches">
					{ACCENTS.map((a) => (
						<button
							key={a.v}
							className={state.accent === a.v ? "on" : ""}
							style={{ background: a.v }}
							onClick={() => set({ accent: a.v })}
						/>
					))}
				</span>
			</div>
			<div className="tweak-row">
				<span className="k">Hero</span>
				<span className="segs">
					{["terminal", "crypto", "demo"].map((v) => (
						<button
							key={v}
							className={state.heroVariant === v ? "on" : ""}
							onClick={() => set({ heroVariant: v })}
						>
							{v}
						</button>
					))}
				</span>
			</div>
			<div className="tweak-row">
				<span className="k">Live demo</span>
				<span className="segs">
					{[
						["on", true],
						["off", false],
					].map(([l, v]) => (
						<button
							key={l}
							className={state.showDemo === v ? "on" : ""}
							onClick={() => set({ showDemo: v })}
						>
							{l}
						</button>
					))}
				</span>
			</div>
		</div>
	);
}

// ——— App ———
function App() {
	const [state, setState] = useState(TWEAK_DEFAULTS);
	const [editMode, setEditMode] = useState(false);
	const t = S[state.lang] || S.en;
	useReveal();

	useEffect(() => {
		const r = document.documentElement;
		r.setAttribute("data-theme", state.theme);
		r.setAttribute("data-body", state.body);
		r.setAttribute("lang", state.lang === "zh" ? "zh-CN" : "en");
		r.style.setProperty("--accent", state.accent);
	}, [state]);

	useEffect(() => {
		const onMsg = (e) => {
			if (!e || !e.data) return;
			if (e.data.type === "__activate_edit_mode") setEditMode(true);
			else if (e.data.type === "__deactivate_edit_mode") setEditMode(false);
		};
		window.addEventListener("message", onMsg);
		try {
			window.parent.postMessage({ type: "__edit_mode_available" }, "*");
		} catch {}
		return () => window.removeEventListener("message", onMsg);
	}, []);

	const setLang = (l) => setState((s) => ({ ...s, lang: l }));

	return (
		<>
			<Nav lang={state.lang} setLang={setLang} t={t} />
			<Hero t={t} variant={state.heroVariant} lang={state.lang} />
			<Install t={t} />
			<Features t={t} />
			<How t={t} />
			<Live t={t} show={state.showDemo} />
			<Mobile t={t} />
			<Security t={t} />
			<Changelog />
			<Faq t={t} />
			<Foot t={t} />
			<Tweaks
				state={state}
				setState={setState}
				active={editMode}
				onClose={() => setEditMode(false)}
			/>
		</>
	);
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
