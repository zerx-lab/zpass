// Main app composition

const { useState: aS, useEffect: aE, useMemo: aM } = React;
const { ToastProvider } = window.ZPASS_UI;
const Ia = window.ZPASS_ICONS;
const { ITEMS, BREACHES, ACTIVITY } = window.ZPASS_DATA;
const { I18nProvider, useI18n } = window.ZPASS_I18N;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
	theme: "dark",
	accent: "#d4ff3a",
	density: "normal",
	body: "sans",
	lang: "en",
} /*EDITMODE-END*/;

function App() {
	const [theme, setTheme] = aS(TWEAK_DEFAULTS.theme);
	const [accent, setAccent] = aS(TWEAK_DEFAULTS.accent);
	const [density, setDensity] = aS(TWEAK_DEFAULTS.density);
	const [body, setBody] = aS(TWEAK_DEFAULTS.body);
	const [lang, setLang] = aS(() => {
		try {
			return localStorage.getItem("zpass.lang") || TWEAK_DEFAULTS.lang || "en";
		} catch {
			return "en";
		}
	});

	const [locked, setLocked] = aS(() => {
		try {
			return localStorage.getItem("zpass.locked") !== "0";
		} catch {
			return true;
		}
	});
	const [section, setSection] = aS(() => {
		try {
			return localStorage.getItem("zpass.section") || "vault";
		} catch {
			return "vault";
		}
	});
	const [selectedId, setSelectedId] = aS("i1");
	const [filter, setFilter] = aS("all");
	const [query, setQuery] = aS("");
	const [cmdk, setCmdk] = aS(false);
	const [travel, setTravel] = aS(() => {
		try {
			return localStorage.getItem("zpass.travel") === "1";
		} catch {
			return false;
		}
	});

	aE(() => {
		document.documentElement.setAttribute("data-theme", theme);
		document.documentElement.setAttribute("data-density", density);
		document.documentElement.setAttribute("data-body", body);
		document.documentElement.setAttribute(
			"lang",
			lang === "zh" ? "zh-CN" : "en",
		);
	}, [theme, accent, density, body, lang]);

	aE(() => {
		try {
			localStorage.setItem("zpass.lang", lang);
		} catch {}
	}, [lang]);
	aE(() => {
		try {
			localStorage.setItem("zpass.locked", locked ? "1" : "0");
		} catch {}
	}, [locked]);
	aE(() => {
		try {
			localStorage.setItem("zpass.section", section);
		} catch {}
	}, [section]);
	aE(() => {
		try {
			localStorage.setItem("zpass.travel", travel ? "1" : "0");
		} catch {}
	}, [travel]);

	aE(() => {
		const onKey = (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setCmdk((c) => !c);
			} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
				e.preventDefault();
				setLocked(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Apply travel-mode filter — hide everything not marked 'safe'
	const visibleItems = aM(() => {
		if (!travel) return ITEMS;
		return ITEMS.filter((i) => i.travel !== "hidden");
	}, [travel]);

	const selected = aM(
		() => visibleItems.find((i) => i.id === selectedId) || visibleItems[0],
		[visibleItems, selectedId],
	);
	const filteredVaultItems = aM(() => {
		let xs = visibleItems;
		if (filter !== "all" && filter !== "fav") {
			xs = xs.filter((x) => x.type === filter);
		}
		if (filter === "fav") {
			xs = xs.filter((x) => x.fav);
		}
		if (query) {
			const q = query.toLowerCase();
			xs = xs.filter((x) =>
				(
					x.name +
					" " +
					(x.username || "") +
					" " +
					(x.url || "") +
					" " +
					(x.tags || []).join(" ")
				)
					.toLowerCase()
					.includes(q),
			);
		}
		return xs;
	}, [visibleItems, filter, query]);
	const selectedVaultItem = aM(
		() =>
			filteredVaultItems.find((i) => i.id === selectedId) ||
			filteredVaultItems[0],
		[filteredVaultItems, selectedId],
	);
	const hiddenCount = ITEMS.length - visibleItems.length;

	const openItem = (id) => {
		setSelectedId(id);
		setSection("vault");
	};
	const handleJump = (s) => {
		if (s === "lock") setLocked(true);
		else setSection(s);
	};

	const tweaks = (
		<window.ZPASS_Tweaks
			theme={theme}
			setTheme={setTheme}
			accent={accent}
			setAccent={setAccent}
			density={density}
			setDensity={setDensity}
			body={body}
			setBody={setBody}
			lang={lang}
			setLang={setLang}
		/>
	);

	return (
		<I18nProvider lang={lang} setLang={setLang}>
			<ToastProvider>
				{locked ? (
					<>
						<window.ZPASS_Unlock onUnlock={() => setLocked(false)} />
						{tweaks}
					</>
				) : (
					<>
						<div className="app">
							<Sidebar
								section={section}
								setSection={setSection}
								items={ITEMS}
								onLock={() => setLocked(true)}
								travel={travel}
								setTravel={setTravel}
								filter={filter}
								setFilter={setFilter}
							/>
							<Topbar
								section={section}
								selected={selected}
								onOpenCmdk={() => setCmdk(true)}
								theme={theme}
								setTheme={setTheme}
							/>
							<div className="main">
								{travel && (
									<div className="travel-banner">
										<span className="icon">
											<Ia.Shield size={14} />
										</span>
										<span>
											{(useI18nRaw(lang).t("travel_banner") || "").replace(
												"{n}",
												hiddenCount,
											)}
										</span>
										<span className="spacer" />
										<button
											type="button"
											className="btn sm"
											onClick={() => setTravel(false)}
										>
											{useI18nRaw(lang).t("travel_banner_restore")}
										</button>
									</div>
								)}
								{section === "vault" && (
									<div className="vault">
										<window.ZPASS_VaultList
											items={visibleItems}
											selectedId={selectedVaultItem?.id}
											onSelect={setSelectedId}
											filter={filter}
											setFilter={setFilter}
											query={query}
											setQuery={setQuery}
										/>
										<window.ZPASS_Detail item={selectedVaultItem} travel={travel} />
									</div>
								)}
								{section === "generator" && <window.ZPASS_Generator />}
								{section === "health" && (
									<window.ZPASS_Health
										items={visibleItems}
										breaches={BREACHES}
										activity={ACTIVITY}
										onOpenItem={openItem}
									/>
								)}
								{section === "settings" && <SettingsView />}
							</div>
						</div>
						<window.ZPASS_CmdK
							open={cmdk}
							onClose={() => setCmdk(false)}
							items={visibleItems}
							onJump={handleJump}
							onItem={openItem}
						/>
						{tweaks}
					</>
				)}
			</ToastProvider>
		</I18nProvider>
	);
}

// tiny helper so the banner string can be rendered outside a provider scope
function useI18nRaw(lang) {
	return {
		t: (k, ...a) => {
			const d = window.ZPASS_I18N.STRINGS[lang] || window.ZPASS_I18N.STRINGS.en;
			const v = d[k];
			if (typeof v === "function") return v(...a);
			return v ?? k;
		},
	};
}

function Sidebar({ section, setSection, items, onLock, travel, setTravel, filter, setFilter }) {
	const { t } = useI18n();
	const counts = aM(() => {
		const c = {
			login: 0,
			card: 0,
			note: 0,
			identity: 0,
			ssh: 0,
			wallet: 0,
			fav: 3,
		};
		items.forEach((i) => {
			c[i.type] = (c[i.type] || 0) + 1;
		});
		return c;
	}, [items]);
	const safeCount = items.filter((i) => i.travel !== "hidden").length;
	const openVaultFilter = (nextFilter) => {
		setSection("vault");
		setFilter(nextFilter);
	};
	const Nav = ({ k, icon: IconC, label, count, badge }) => (
		<button
			type="button"
			className={
				"nav-item " +
				(section === k && (k !== "vault" || filter === "all") ? "active" : "")
			}
			onClick={() => {
				if (k === "vault") openVaultFilter("all");
				else setSection(k);
			}}
		>
			<IconC size={14} />
			<span>{label}</span>
			{count != null && <span className="count">{count}</span>}
			{badge && (
				<span className="sev crit" style={{ marginLeft: "auto" }}>
					{badge}
				</span>
			)}
		</button>
	);
	return (
		<aside className="sidebar">
			<div className="brand">
				<div className="logo">Z</div>
				<div className="name">ZPass</div>
				<span className="tag">{t("brand_tag")}</span>
			</div>

			<div className="nav-section">{t("nav_workspace")}</div>
			<Nav
				k="vault"
				icon={Ia.Vault}
				label={t("nav_all_items")}
				count={items.length}
			/>
			<Nav k="generator" icon={Ia.Gen} label={t("nav_generator")} />
			<Nav k="health" icon={Ia.Health} label={t("nav_security")} badge="3" />

			<div className="nav-section">{t("nav_categories")}</div>
			<button
				type="button"
				className={
					"nav-item " +
					(section === "vault" && filter === "login" ? "active" : "")
				}
				onClick={() => openVaultFilter("login")}
			>
				<Ia.Login size={14} />
				<span>{t("nav_logins")}</span>
				<span className="count">{counts.login}</span>
			</button>
			<button
				type="button"
				className={
					"nav-item " +
					(section === "vault" && filter === "card" ? "active" : "")
				}
				onClick={() => openVaultFilter("card")}
			>
				<Ia.Card size={14} />
				<span>{t("nav_cards")}</span>
				<span className="count">{counts.card}</span>
			</button>
			<button
				type="button"
				className={
					"nav-item " +
					(section === "vault" && filter === "note" ? "active" : "")
				}
				onClick={() => openVaultFilter("note")}
			>
				<Ia.Note size={14} />
				<span>{t("nav_notes")}</span>
				<span className="count">{counts.note}</span>
			</button>
			<button
				type="button"
				className={
					"nav-item " +
					(section === "vault" && filter === "identity" ? "active" : "")
				}
				onClick={() => openVaultFilter("identity")}
			>
				<Ia.Id size={14} />
				<span>{t("nav_identities")}</span>
				<span className="count">{counts.identity}</span>
			</button>
			<button
				type="button"
				className={
					"nav-item " +
					(section === "vault" && filter === "ssh" ? "active" : "")
				}
				onClick={() => openVaultFilter("ssh")}
			>
				<Ia.Ssh size={14} />
				<span>{t("nav_ssh")}</span>
				<span className="count">{counts.ssh}</span>
			</button>
			<button
				type="button"
				className={
					"nav-item " +
					(section === "vault" && filter === "wallet" ? "active" : "")
				}
				onClick={() => openVaultFilter("wallet")}
			>
				<Ia.Wallet size={14} />
				<span>{t("nav_wallets")}</span>
				<span className="count">{counts.wallet}</span>
			</button>

			<div className="nav-section">{t("nav_folders")}</div>
			<button type="button" className="nav-item">
				<Ia.Folder size={14} />
				<span>{t("nav_work")}</span>
				<span className="count">12</span>
			</button>
			<button type="button" className="nav-item">
				<Ia.Folder size={14} />
				<span>{t("nav_personal")}</span>
				<span className="count">8</span>
			</button>
			<button
				type="button"
				className="nav-item"
				style={{ color: "var(--text-3)" }}
			>
				<Ia.Plus size={14} />
				<span>{t("nav_new_folder")}</span>
			</button>

			<div className={"travel-sb " + (travel ? "on" : "")}>
				<div className="row">
					<div className="ttl">
						{travel && <span className="pulse" />}
						<Ia.Shield size={12} /> {t("travel_title")}
					</div>
					<div
						className={"travel-switch " + (travel ? "on" : "")}
						onClick={() => setTravel(!travel)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								setTravel(!travel);
							}
						}}
						role="switch"
						aria-checked={travel}
						tabIndex={0}
					/>
				</div>
				<div className="sub">
					{travel
						? t("travel_sb_sub", safeCount, items.length)
						: t("travel_hint")}
				</div>
			</div>

			<div className="sidebar-footer">
				<div className="avatar">AR</div>
				<div className="user-meta">
					<span className="n">Alex Rivera</span>
					<span className="m">{t("nav_tier")}</span>
				</div>
				<button
					type="button"
					className="btn icon sm"
					onClick={onLock}
					title={t("nav_lock_title")}
				>
					<Ia.Lock size={13} />
				</button>
			</div>
		</aside>
	);
}

function Topbar({ section, selected, onOpenCmdk, theme, setTheme }) {
	const { t } = useI18n();
	const crumbs = {
		vault: selected ? (
			<>
				<span>{t("topbar_vault")}</span> <Ia.Chevron size={12} />{" "}
				<b>{selected.name}</b>
			</>
		) : (
			<b>{t("topbar_vault")}</b>
		),
		generator: <b>{t("topbar_generator")}</b>,
		health: <b>{t("topbar_security")}</b>,
		settings: <b>{t("topbar_settings")}</b>,
	}[section];
	return (
		<header className="topbar">
			<div className="crumbs">{crumbs}</div>
			<div className="spacer" />
			<button type="button" className="search" onClick={onOpenCmdk}>
				<Ia.Search size={14} />
				<span>{t("topbar_search")}</span>
				<div style={{ flex: 1 }} />
				<span className="kbd">⌘</span>
				<span className="kbd">K</span>
			</button>
			<button
				type="button"
				className="icon-btn"
				title={
					theme === "dark" ? t("topbar_theme_light") : t("topbar_theme_dark")
				}
				onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
			>
				{theme === "dark" ? <Ia.Sun size={14} /> : <Ia.Moon size={14} />}
			</button>
			<button
				type="button"
				className="icon-btn"
				title={t("topbar_notifications")}
			>
				<Ia.Bell size={14} />
			</button>
			<button type="button" className="btn primary">
				<Ia.Plus size={14} /> {t("topbar_new")}
			</button>
		</header>
	);
}

function SettingsView() {
	const { t } = useI18n();
	return <div className="empty">{t("topbar_settings")}</div>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
