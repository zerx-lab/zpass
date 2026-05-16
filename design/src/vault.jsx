// Vault 3-pane: list + detail
const { useMemo: vM } = React;
const { Favicon, typeLabel, fmtRel } = window.ZPASS_UI;
const Iv = window.ZPASS_ICONS;
const { useI18n: vUseI18n } = window.ZPASS_I18N;

const FILTERS = [
  { k: "all", tk: "filter_all" },
  { k: "login", tk: "filter_login" },
  { k: "card", tk: "filter_card" },
  { k: "note", tk: "filter_note" },
  { k: "identity", tk: "filter_identity" },
  { k: "ssh", tk: "filter_ssh" },
  { k: "wallet", tk: "filter_wallet" },
  { k: "fav", tk: "filter_fav" },
];

function VaultList({
  items,
  selectedId,
  onSelect,
  filter,
  setFilter,
  query,
  setQuery,
}) {
	// setQuery 暂未在该组件内使用，保留参数以维持外部 API 兼容
	void setQuery;
	const { t, lang } = vUseI18n();
	const filtered = vM(() => {
		let xs = items;
		if (filter !== "all" && filter !== "fav")
			xs = xs.filter((x) => x.type === filter);
		if (filter === "fav")
			xs = xs.filter((x) => x.fav);
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
	}, [items, filter, query]);

  const counts = vM(() => {
    const c = { all: items.length };
    for (const it of items) c[it.type] = (c[it.type] || 0) + 1;
    return c;
  }, [items]);

	return (
		<div className="list-pane">
			<div className="list-head">
				<h2>{t("vault_title")}</h2>
				<span className="count mono">{filtered.length}</span>
				<div className="spacer" />
				<button type="button" className="btn sm" title="Sort">
					<Iv.Filter size={12} /> {t("vault_sort_recent")}
				</button>
			</div>
			<div className="list-filters">
				{FILTERS.map((f) => (
					<button
						type="button"
						key={f.k}
						className={"chip " + (filter === f.k ? "active" : "")}
						onClick={() => setFilter(f.k)}
					>
						{t(f.tk)}
						{counts[f.k] != null && <span className="n">{counts[f.k]}</span>}
					</button>
				))}
			</div>
			<div className="list">
				{filtered.map((it) => (
					<button
						type="button"
						key={it.id}
						className={"list-row " + (selectedId === it.id ? "active" : "")}
						onClick={() => onSelect(it.id)}
					>
						<Favicon item={it} size={32} />
						<div className="meta">
							<div className="title">
								{it.name}
								{it.breached && (
									<span className="sev crit" title="Breach">
										{t("sev_breach")}
									</span>
								)}
								{!it.breached && it.weak && (
									<span className="sev high" title="Weak">
										{t("sev_weak")}
									</span>
								)}
								{it.totp && (
									<span
										className="tag"
										style={{ padding: "0 5px", fontSize: 10 }}
									>
										TOTP
									</span>
								)}
							</div>
							<div className="sub">
								{it.username ||
									it.url ||
									it.cardholder ||
									it.fingerprint?.slice(0, 32) + "…" ||
									typeLabel(it.type, lang)}
							</div>
						</div>
						<div className="side">
							<span className="type-badge">{typeLabel(it.type, lang)}</span>
							<span>{fmtRel(it.modified, lang)}</span>
						</div>
					</button>
				))}
				{!filtered.length && (
					<div className="empty" style={{ padding: 40 }}>
						{t("vault_empty")}
					</div>
				)}
			</div>
		</div>
	);
}

window.ZPASS_VaultList = VaultList;
