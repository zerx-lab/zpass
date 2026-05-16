// Main app composition

const { useState: aS, useEffect: aE, useMemo: aM, useCallback: aCB } = React;
const { ToastProvider } = window.ZPASS_UI;
const Ia = window.ZPASS_ICONS;
const { ITEMS: INITIAL_ITEMS, BREACHES, ACTIVITY } = window.ZPASS_DATA;
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

	// items 提升为 state，供编辑模态框写回
	const [items, setItems] = aS(INITIAL_ITEMS);
	const updateItem = aCB((id, patch) => {
		setItems((prev) =>
			prev.map((i) => (i.id === id ? { ...i, ...patch, modified: Date.now() } : i)),
		);
	}, []);
	// 批量追加（用于导入）
	const addItems = aCB((newItems) => {
		if (!Array.isArray(newItems) || newItems.length === 0) return;
		setItems((prev) => [...newItems, ...prev]);
	}, []);
	// 导入对话框开关
	const [importOpen, setImportOpen] = aS(false);

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
		if (!travel) return items;
		return items.filter((i) => i.travel !== "hidden");
	}, [travel, items]);

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
	const hiddenCount = items.length - visibleItems.length;

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
							items={items}
							onLock={() => setLocked(true)}
							onImport={() => setImportOpen(true)}
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
										<window.ZPASS_Detail
										item={selectedVaultItem}
										travel={travel}
										onUpdate={updateItem}
									/>
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
						{importOpen && window.ZPASS_ImportModal && (
							<ImportHost
								items={items}
								addItems={addItems}
								onClose={() => setImportOpen(false)}
							/>
						)}
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

function Sidebar({ section, setSection, items, onLock, onImport, travel, setTravel, filter, setFilter }) {
	const { t } = useI18n();
	const [menuOpen, setMenuOpen] = aS(false);
	const menuRef = React.useRef(null);

	// 点击外部关闭菜单
	aE(() => {
		if (!menuOpen) return;
		const onDoc = (e) => {
			if (menuRef.current && !menuRef.current.contains(e.target)) {
				setMenuOpen(false);
			}
		};
		const onKey = (e) => {
			if (e.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onKey);
		};
	}, [menuOpen]);
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

			<div className="sidebar-footer" ref={menuRef}>
				<button
					type="button"
					className={"avatar avatar-btn " + (menuOpen ? "open" : "")}
					onClick={() => setMenuOpen((v) => !v)}
					title={t("nav_menu_title")}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
				>
					AR
				</button>
				<button
					type="button"
					className="user-meta user-meta-btn"
					onClick={() => setMenuOpen((v) => !v)}
				>
					<span className="n">Alex Rivera</span>
					<span className="m">{t("nav_tier")}</span>
				</button>
				<button
					type="button"
					className="btn icon sm"
					onClick={onLock}
					title={t("nav_lock_title")}
				>
					<Ia.Lock size={13} />
				</button>
				{menuOpen && (
					<div className="user-menu" role="menu">
						<button
							type="button"
							className="user-menu-item"
							onClick={() => {
								setMenuOpen(false);
								setSection("settings");
							}}
						>
							<Ia.User size={14} />
							<span>{t("menu_account")}</span>
						</button>
						<button
							type="button"
							className="user-menu-item"
							onClick={() => {
								setMenuOpen(false);
								setSection("settings");
							}}
						>
							<Ia.Settings size={14} />
							<span>{t("menu_settings")}</span>
						</button>
						<div className="user-menu-sep" />
						<button
							type="button"
							className="user-menu-item"
							onClick={() => {
								setMenuOpen(false);
								onImport?.();
							}}
						>
							<Ia.Upload size={14} />
							<span>{t("menu_import")}</span>
						</button>
						<button
							type="button"
							className="user-menu-item disabled"
							disabled
							title="Coming soon"
						>
							<Ia.Download size={14} />
							<span>{t("menu_export")}</span>
						</button>
						<div className="user-menu-sep" />
						<button
							type="button"
							className="user-menu-item"
							onClick={() => {
								setMenuOpen(false);
								onLock();
							}}
						>
							<Ia.Lock size={14} />
							<span>{t("menu_lock")}</span>
						</button>
					</div>
				)}
			</div>
		</aside>
	);
}

// 导入宿主：负责把 ImportModal 与 toast / addItems 接起来
function ImportHost({ items, addItems, onClose }) {
	const { t } = useI18n();
	const toast = window.ZPASS_UI.useToast();
	const handleApply = (newItems, info) => {
		addItems(newItems);
		const droppedDupes = info?.droppedDupes || 0;
		if (droppedDupes > 0) {
			toast?.(t("import_done_some", newItems.length, droppedDupes));
		} else {
			toast?.(t("import_done", newItems.length));
		}
		onClose();
	};
	return (
		<window.ZPASS_ImportModal
			existingItems={items}
			onClose={onClose}
			onApply={handleApply}
		/>
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
	const toast = window.ZPASS_UI.useToast();
	const [spaces, setSpaces] = aS([
		{ id: "sp1", name: "Personal", items: 14, current: true },
		{ id: "sp2", name: "Work", items: 23, current: false },
		{ id: "sp3", name: "Shared — Team", items: 8, current: false },
	]);
	const [lockTimeout, setLockTimeout] = aS("5m");
	const [trigSleep, setTrigSleep] = aS(true);
	const [trigSwitch, setTrigSwitch] = aS(false);
	const [trigClose, setTrigClose] = aS(true);

	// Modal state
	const [modal, setModal] = aS(null); // { type: 'delete'|'rename'|'never', spaceId?, value? }

	const openDelete = (sp) => setModal({ type: "delete", spaceId: sp.id, name: sp.name });
	const openRename = (sp) => setModal({ type: "rename", spaceId: sp.id, value: sp.name });

	const confirmDelete = () => {
		setSpaces((s) => s.filter((x) => x.id !== modal.spaceId));
		toast?.(t("set_space_delete") + " ✓");
		setModal(null);
	};
	const confirmRename = () => {
		if (!modal.value?.trim()) return;
		setSpaces((s) =>
			s.map((x) =>
				x.id === modal.spaceId ? { ...x, name: modal.value.trim() } : x,
			),
		);
		toast?.(t("set_space_rename") + " ✓");
		setModal(null);
	};
	const confirmNever = () => {
		setLockTimeout("never");
		setModal(null);
	};
	const handleLockChange = (v) => {
		if (v === "never") {
			setModal({ type: "never" });
		} else {
			setLockTimeout(v);
		}
	};
	const addSpace = () => {
		const id = "sp" + Date.now();
		setSpaces((s) => [...s, { id, name: t("set_space_new"), items: 0, current: false }]);
		// immediately open rename
		setModal({ type: "rename", spaceId: id, value: "" });
	};

	const lockOpts = [
		{ v: "1m", l: t("set_lock_1m") },
		{ v: "5m", l: t("set_lock_5m") },
		{ v: "15m", l: t("set_lock_15m") },
		{ v: "30m", l: t("set_lock_30m") },
		{ v: "1h", l: t("set_lock_1h") },
		{ v: "4h", l: t("set_lock_4h") },
		{ v: "never", l: t("set_lock_never") },
	];

	return (
		<div className="settings">
			<h1>{t("set_title")}</h1>

			{/* ── Spaces ── */}
			<div className="set-section">
				<div className="set-section-head">
					<Ia.Spaces size={16} />
					<h2>{t("set_spaces")}</h2>
				</div>
				<p className="set-section-desc">{t("set_spaces_desc")}</p>
				<div className="space-list">
					{spaces.map((sp) => (
						<div className="space-row" key={sp.id}>
							<div className="space-icon">{sp.name[0]?.toUpperCase()}</div>
							<div className="space-info">
								<span className="space-name">{sp.name}</span>
								<span className="space-meta">{t("set_space_items", sp.items)}</span>
							</div>
							{sp.current && (
								<span className="space-badge">{t("set_space_current")}</span>
							)}
							<div className="space-actions">
								<button type="button" title={t("set_space_rename")} onClick={() => openRename(sp)}>
									<Ia.Pen size={13} />
								</button>
								{!sp.current && (
									<button type="button" className="del" title={t("set_space_delete")} onClick={() => openDelete(sp)}>
										<Ia.Trash size={13} />
									</button>
								)}
							</div>
						</div>
					))}
					<button type="button" className="space-new-btn" onClick={addSpace}>
						<Ia.Plus size={14} /> {t("set_space_new")}
					</button>
				</div>
			</div>

			{/* ── Auto-lock ── */}
			<div className="set-section">
				<div className="set-section-head">
					<Ia.Timer size={16} />
					<h2>{t("set_lock")}</h2>
				</div>
				<p className="set-section-desc">{t("set_lock_desc")}</p>
				<div className="lock-options">
					<div className="lock-group">
						<div className="lock-group-label">{t("set_lock_timeout")}</div>
						{lockOpts.map((o) => (
							<div
								key={o.v}
								className={
									"lock-row" +
									(lockTimeout === o.v ? " active" : "") +
									(o.v === "never" ? " never" : "")
								}
								onClick={() => handleLockChange(o.v)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										handleLockChange(o.v);
									}
								}}
								role="radio"
								aria-checked={lockTimeout === o.v}
								tabIndex={0}
							>
								<span className="radio" />
								<span>{o.l}</span>
							</div>
						))}
					</div>
					<div className="lock-group">
						<div className="lock-group-label">{t("set_lock_trigger")}</div>
						<div className="lock-trigger-row">
							<span>{t("set_lock_sleep")}</span>
							<div
								className={"switch" + (trigSleep ? " on" : "")}
								onClick={() => setTrigSleep(!trigSleep)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										setTrigSleep(!trigSleep);
									}
								}}
								role="switch"
								aria-checked={trigSleep}
								tabIndex={0}
							/>
						</div>
						<div className="lock-trigger-row">
							<span>{t("set_lock_switch")}</span>
							<div
								className={"switch" + (trigSwitch ? " on" : "")}
								onClick={() => setTrigSwitch(!trigSwitch)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										setTrigSwitch(!trigSwitch);
									}
								}}
								role="switch"
								aria-checked={trigSwitch}
								tabIndex={0}
							/>
						</div>
						<div className="lock-trigger-row">
							<span>{t("set_lock_close")}</span>
							<div
								className={"switch" + (trigClose ? " on" : "")}
								onClick={() => setTrigClose(!trigClose)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										setTrigClose(!trigClose);
									}
								}}
								role="switch"
								aria-checked={trigClose}
								tabIndex={0}
							/>
						</div>
					</div>
				</div>
			</div>

			{/* ── Modals ── */}
			{modal && (
				<div className="set-modal-backdrop" onClick={() => setModal(null)}>
					<div className="set-modal" onClick={(e) => e.stopPropagation()}>
						{modal.type === "delete" && (
							<>
								<h3>{t("set_space_delete_title")}</h3>
								<p>{t("set_space_delete_msg", modal.name)}</p>
								<div className="actions">
									<button type="button" className="btn ghost" onClick={() => setModal(null)}>
										{t("set_space_delete_cancel")}
									</button>
									<button type="button" className="btn danger" onClick={confirmDelete}>
										<Ia.Trash size={13} /> {t("set_space_delete_confirm")}
									</button>
								</div>
							</>
						)}
						{modal.type === "rename" && (
							<>
								<h3>{t("set_space_rename_title")}</h3>
								<input
									type="text"
									value={modal.value || ""}
									onChange={(e) => setModal({ ...modal, value: e.target.value })}
									onKeyDown={(e) => {
										if (e.key === "Enter") confirmRename();
										if (e.key === "Escape") setModal(null);
									}}
									placeholder={t("set_space_rename_placeholder")}
									autoFocus
								/>
								<div className="actions">
									<button type="button" className="btn ghost" onClick={() => setModal(null)}>
										{t("set_space_delete_cancel")}
									</button>
									<button type="button" className="btn primary" onClick={confirmRename}>
										{t("set_space_rename_confirm")}
									</button>
								</div>
							</>
						)}
						{modal.type === "never" && (
							<>
								<h3>{t("set_lock_never_title")}</h3>
								<div className="warn-banner">
									<Ia.AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
									<span>{t("set_lock_never_msg")}</span>
								</div>
								<div className="actions">
									<button type="button" className="btn ghost" onClick={() => setModal(null)}>
										{t("set_lock_never_cancel")}
									</button>
									<button type="button" className="btn danger" onClick={confirmNever}>
										{t("set_lock_never_confirm")}
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
