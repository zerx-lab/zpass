// Item detail pane — renders based on item.type
const { useState: dS, useEffect: dE, useMemo: dM } = React;
const {
	Favicon: Fv,
	typeLabel: tLb,
	fmtRel: fR,
	useToast: uT,
	copyText: cT,
	pwStrength,
} = window.ZPASS_UI;
const Id_ = window.ZPASS_ICONS;
const { useI18n: dUseI18n } = window.ZPASS_I18N;

const HIST_KIND_ICON = {
	used: "Check",
	password: "Refresh",
	shared: "Share",
	created: "Plus",
	totp: "Shield",
};
const HIST_KINDS = ["all", "used", "password", "shared", "totp", "created"];

function synthHistory(item) {
	const m = item.modified || 0;
	const d = (days) => m - days * 86400;
	const where = (item.url || "zpass.app").replace(/^https?:\/\//, "");
	const base = [
		{
			t: m,
			kind: "used",
			who: "macbook-pro · Safari",
			where: where + "/login",
			detail: "Autofilled",
		},
		{
			t: d(3),
			kind: "used",
			who: "iphone 15 pro · Safari",
			where: where,
			detail: "Face ID autofill",
		},
	];
	if (item.type === "login") {
		base.push({
			t: d(Math.max(30, Math.floor((Date.now() / 1000 - m) / 86400))),
			kind: "password",
			who: "macbook-pro · ZPass",
			where: "Generated · " + (item.password?.length || 16) + " chars",
			detail: "Password rotated",
		});
	}
	if (item.totp)
		base.push({
			t: d(90),
			kind: "totp",
			who: "macbook-pro · ZPass",
			where: "TOTP added",
			detail: "6-digit · 30s",
		});
	base.push({
		t: d(365),
		kind: "created",
		who: "macbook-pro · ZPass",
		where: where,
		detail: "Item created",
	});
	return base;
}

function HistoryTimeline({ item }) {
	const { t, lang } = dUseI18n();
	const [kind, setKind] = dS("all");
	const [showAll, setShowAll] = dS(false);
	const events = dM(
		() => (item.history?.length ? item.history : synthHistory(item)),
		[item],
	);
	if (!events.length)
		return (
			<div
				style={{
					color: "var(--text-3)",
					fontFamily: "var(--font-mono)",
					fontSize: 12,
					padding: 8,
				}}
			>
				{t("hist_empty")}
			</div>
		);

	const counts = events.reduce((a, e) => {
		a[e.kind] = (a[e.kind] || 0) + 1;
		a.all = (a.all || 0) + 1;
		return a;
	}, {});
	const filtered =
		kind === "all" ? events : events.filter((e) => e.kind === kind);
	const shown = showAll ? filtered : filtered.slice(0, 4);

	return (
		<div>
			<div className="tl-tabs">
				{HIST_KINDS.map((k) => (
					<button
						type="button"
						key={k}
						className={kind === k ? "on" : ""}
						onClick={() => setKind(k)}
					>
						{t("hist_" + k)} <span className="c">{counts[k] || 0}</span>
					</button>
				))}
			</div>
			<div className="timeline">
				{shown.map((e, i) => {
					const Icon = Id_[HIST_KIND_ICON[e.kind]] || Id_.Clock;
					return (
						<div key={i} className={"tl-item kind-" + e.kind}>
							<div className="node">
								<Icon size={8} />
							</div>
							<div className="tl-head">
								<span className="tl-kind">{t("hist_kind_" + e.kind)}</span>
							</div>
							<span className="tl-time">
								{fR(e.t, lang)}
								{lang === "zh" ? "" : t("ago")}
							</span>
							<div className="tl-who">
								{e.who}
								<span className="sep">·</span>
								{e.where}
							</div>
							{e.detail && <div className="tl-detail mono">{e.detail}</div>}
						</div>
					);
				})}
			</div>
			{!showAll && filtered.length > 4 && (
				<button
					type="button"
					className="tl-more"
					onClick={() => setShowAll(true)}
				>
					{t("hist_load_more")} ({filtered.length - 4})
				</button>
			)}
		</div>
	);
}

function StrengthBlock({ pw, strength }) {
	const { t } = dUseI18n();
	const s = strength != null ? strength : pwStrength(pw || "");
	const cls = s < 40 ? "weak" : s < 70 ? "med" : "";
	const label =
		s < 40
			? t("strength_weak")
			: s < 70
				? t("strength_fair")
				: s < 85
					? t("strength_strong")
					: t("strength_excellent");
	// crude entropy estimate
	const pool =
		(/[a-z]/.test(pw || "") ? 26 : 0) +
		(/[A-Z]/.test(pw || "") ? 26 : 0) +
		(/[0-9]/.test(pw || "") ? 10 : 0) +
		(/[^a-z0-9]/i.test(pw || "") ? 12 : 0);
	const entropy = pw ? Math.round(pw.length * Math.log2(pool || 26)) : 0;
	return (
		<div className="strength">
			<div className="row">
				<div className="score mono">
					{s}
					<span style={{ color: "var(--text-3)", fontSize: 16 }}>/100</span>
				</div>
				<div className={"bar " + cls}>
					<span style={{ width: s + "%" }} />
				</div>
				<div
					className="mono"
					style={{
						fontSize: 12,
						color: "var(--text-2)",
						minWidth: 64,
						textAlign: "right",
					}}
				>
					{label}
				</div>
			</div>
			<div className="meta">
				<span>
					{t("meta_length")} <b>{pw?.length || 0}</b>
				</span>
				<span>
					{t("meta_entropy")} <b>{entropy} bits</b>
				</span>
				<span>
					{t("meta_crack")}{" "}
					<b>
						{s > 90
							? t("crack_centuries")
							: s > 70
								? t("crack_years")
								: s > 40
									? t("crack_weeks")
									: t("crack_minutes")}
					</b>
				</span>
				<span>
					{t("meta_reused")}{" "}
					<b style={{ color: s < 40 ? "var(--danger)" : "var(--text)" }}>
						{s < 40 ? t("reused_yes") : t("reused_no")}
					</b>
				</span>
			</div>
		</div>
	);
}

function Totp({ seed }) {
	const { t: tt } = dUseI18n();
	const [t, setT] = dS(() => 30 - (Math.floor(Date.now() / 1000) % 30));
	const [code, setCode] = dS(() => genCode(seed));
	dE(() => {
		const iv = setInterval(() => {
			const remain = 30 - (Math.floor(Date.now() / 1000) % 30);
			setT(remain);
			if (remain === 30) setCode(genCode(seed));
		}, 500);
		return () => clearInterval(iv);
	}, [seed]);
	const p = ((30 - t) / 30) * 360;
	const toast = uT();
	return (
		<div className="totp">
			<div className="timer" style={{ "--p": p + "deg" }}>
				<span>{t}</span>
			</div>
			<button
				type="button"
				className="code"
				onClick={() => cT(code, toast, tt("sec_totp"))}
			>
				{code.slice(0, 3)} {code.slice(3)}
			</button>
			<div
				style={{
					marginLeft: "auto",
					display: "flex",
					flexDirection: "column",
					gap: 2,
				}}
			>
				<div className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
					TOTP · SHA1 · 30s
				</div>
				<div className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>
					{seed}
				</div>
			</div>
			<button
				type="button"
				className="btn icon sm"
				onClick={() => cT(code, toast, tt("sec_totp"))}
			>
				<Id_.Copy size={14} />
			</button>
		</div>
	);
}
function genCode(seed) {
	// deterministic per 30-sec window from seed string
	const window = Math.floor(Date.now() / 30000);
	let h = 0;
	const s = (seed || "") + window;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return String(Math.abs(h) % 1000000).padStart(6, "0");
}

function Field({ label, value, mono = true, masked, copy, action, mult }) {
	const [show, setShow] = dS(!masked);
	const toast = uT();
	const display =
		masked && !show
			? "•".repeat(Math.min(20, (value || "").length || 12))
			: value;
	return (
		<div
			className="field"
			style={
				mult
					? { gridTemplateColumns: "140px 1fr", alignItems: "flex-start" }
					: null
			}
		>
			<div className="label">{label}</div>
			<div
				className={
					"value " + (masked && !show ? "masked" : "") + (mono ? "" : " ")
				}
				style={
					mult
						? {
								whiteSpace: "pre-wrap",
								fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
							}
						: null
				}
			>
				{display}
			</div>
			{!mult && (
				<div className="tools">
					{masked && (
						<button type="button" onClick={() => setShow((s) => !s)}>
							{show ? <Id_.EyeOff size={14} /> : <Id_.Eye size={14} />}
						</button>
					)}
					{copy !== false && (
						<button type="button" onClick={() => cT(value, toast, label)}>
							<Id_.Copy size={14} />
						</button>
					)}
					{action}
				</div>
			)}
		</div>
	);
}

// 自定义字段渲染（详情态，只读）
function CustomFieldRow({ field, item, t }) {
	const toast = uT();
	const [show, setShow] = dS(false);
	if (field.type === "boolean") {
		return (
			<div className="field">
				<div className="label">{field.name || ""}</div>
				<div className="value" style={{ display: "flex", alignItems: "center" }}>
					<span className={"cf-bool " + (field.value ? "on" : "")}>
						{field.value ? <Id_.Check size={12} /> : null}
					</span>
				</div>
				<div className="tools" />
			</div>
		);
	}
	if (field.type === "linked") {
		const linkedKey = field.value;
		const display = linkedKey
			? `${t("cf_link_to")} → ${linkedKey}`
			: t("cf_link_none");
		return (
			<div className="field">
				<div className="label">{field.name || ""}</div>
				<div className="value" style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<Id_.Ext size={12} />
					<span style={{ fontFamily: "var(--font-mono)" }}>{display}</span>
				</div>
				<div className="tools" />
			</div>
		);
	}
	const masked = field.type === "hidden";
	const v = field.value || "";
	const display = masked && !show ? "•".repeat(Math.min(20, v.length || 12)) : v;
	return (
		<div className="field">
			<div className="label">{field.name || ""}</div>
			<div className={"value " + (masked && !show ? "masked" : "")}>{display}</div>
			<div className="tools">
				{masked && (
					<button type="button" onClick={() => setShow((s) => !s)}>
						{show ? <Id_.EyeOff size={14} /> : <Id_.Eye size={14} />}
					</button>
				)}
				<button type="button" onClick={() => cT(v, toast, field.name || "field")}>
					<Id_.Copy size={14} />
				</button>
			</div>
		</div>
	);
}

function Detail({ item, onUpdate }) {
	const toast = uT();
	const { t, lang } = dUseI18n();
	const [editOpen, setEditOpen] = dS(false);
	if (!item) return <div className="empty">{t("detail_empty")}</div>;
	const customFields = item.customFields || [];

	return (
		<div className="detail-pane">
			<div className="detail-head">
				<Fv item={item} size={44} />
				<div>
					<h1>{item.name}</h1>
					<div className="url">
						<span>
							{item.url ||
								(item.type === "wallet" ? item.seedHint : tLb(item.type, lang))}
						</span>
						{item.url && (
							<button
								type="button"
								onClick={() => cT(item.url, toast, t("lbl_website"))}
							>
								<Id_.Ext size={12} />
							</button>
						)}
					</div>
					<div
						style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}
					>
						{item.folder && (
							<span className="tag">
								<Id_.Folder size={10} />
								{item.folder}
							</span>
						)}
						{(item.tags || []).map((tg) => (
							<span className="tag" key={tg}>
								<span className="dot" />
								{tg}
							</span>
						))}
						{item.breached && (
							<span className="sev crit">{t("breach_detected")}</span>
						)}
					</div>
				</div>
				<div className="actions">
					<button type="button" className="btn">
						<Id_.Star size={14} /> {t("act_favorite")}
					</button>
					<button type="button" className="btn">
						<Id_.Share size={14} /> {t("act_share")}
					</button>
					<button
						type="button"
						className="btn primary"
						onClick={() => setEditOpen(true)}
					>
						<Id_.Edit size={14} /> {t("act_edit")}
					</button>
					<button type="button" className="btn icon">
						<Id_.More size={16} />
					</button>
				</div>
			</div>

			<div className="detail-body">
				{item.type === "login" && (
					<>
						<section>
							<h3 className="section-title">{t("sec_credentials")}</h3>
							<div className="field-group">
								<Field label={t("lbl_username")} value={item.username} />
								<Field
									label={t("lbl_password")}
									value={item.password}
									masked
									action={
										<button type="button">
											<Id_.Refresh size={14} />
										</button>
									}
								/>
								<Field
									label={t("lbl_website")}
									value={item.url}
									mono={false}
									action={
										<button type="button">
											<Id_.Ext size={14} />
										</button>
									}
								/>
							</div>
						</section>

						<section>
							<h3 className="section-title">{t("sec_strength")}</h3>
							<StrengthBlock pw={item.password} strength={item.strength} />
						</section>

						{item.totp && (
							<section>
								<h3 className="section-title">{t("sec_totp")}</h3>
								<Totp seed={item.totp} />
							</section>
						)}

						<section>
							<h3 className="section-title">{t("sec_history")}</h3>
							<HistoryTimeline item={item} />
						</section>

						<section>
							<h3 className="section-title">{t("sec_meta")}</h3>
							<div className="field-group">
								<Field
									label={t("lbl_created")}
									value={new Date(item.modified - 3600 * 24 * 400 * 1000)
										.toISOString()
										.slice(0, 10)}
									copy={false}
								/>
								<Field
									label={t("lbl_last_used")}
									value={
										fR(item.modified, lang) + (lang === "zh" ? "" : t("ago"))
									}
									copy={false}
								/>
								<Field
									label={t("lbl_history")}
									value={t("prev_passwords", item.pwHistory || 0)}
									copy={false}
								/>
								<Field
									label={t("lbl_autofill")}
									value={t("lbl_autofill_value")}
									copy={false}
									mono={false}
								/>
							</div>
						</section>

						{item.notes && (
							<section>
								<h3 className="section-title">{t("sec_notes")}</h3>
								<div className="field-group">
									<Field
										label={t("lbl_notes")}
										value={item.notes}
										mono={false}
										mult
										copy={false}
									/>
								</div>
							</section>
						)}
					</>
				)}

				{item.type === "card" && (
					<>
						<section>
							<h3 className="section-title">{t("sec_card")}</h3>
							<div
								style={{
									border: "1px solid var(--line)",
									borderRadius: 10,
									padding: 24,
									background: "var(--bg-elev)",
									marginBottom: 16,
									fontFamily: "var(--font-mono)",
									color: "var(--text)",
								}}
							>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										marginBottom: 24,
									}}
								>
									<div
										style={{
											fontSize: 11,
											color: "#888",
											letterSpacing: "0.1em",
											textTransform: "uppercase",
										}}
									>
										{item.brand}
									</div>
									<div style={{ fontSize: 11, color: "#888" }}>
										{item.folder}
									</div>
								</div>
								<div
									style={{
										fontSize: 20,
										letterSpacing: "0.14em",
										marginBottom: 24,
									}}
								>
									{item.number}
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										fontSize: 11,
									}}
								>
									<div>
										<div
											style={{
												color: "#888",
												fontSize: 9,
												textTransform: "uppercase",
												letterSpacing: "0.1em",
											}}
										>
											{t("lbl_holder")}
										</div>
										{item.cardholder}
									</div>
									<div>
										<div
											style={{
												color: "#888",
												fontSize: 9,
												textTransform: "uppercase",
												letterSpacing: "0.1em",
											}}
										>
											{t("lbl_expiry")}
										</div>
										{item.exp}
									</div>
									<div>
										<div
											style={{
												color: "#888",
												fontSize: 9,
												textTransform: "uppercase",
												letterSpacing: "0.1em",
											}}
										>
											{t("lbl_cvv")}
										</div>
										•••
									</div>
								</div>
							</div>
							<div className="field-group">
								<Field label={t("lbl_card_number")} value={item.number} />
								<Field
									label={t("lbl_holder")}
									value={item.cardholder}
									mono={false}
								/>
								<Field label={t("lbl_expiry")} value={item.exp} />
								<Field label={t("lbl_cvv")} value={item.cvv} masked />
								{item.pin && (
									<Field label={t("lbl_pin")} value={item.pin} masked />
								)}
							</div>
						</section>
					</>
				)}

				{item.type === "note" && (
					<section>
						<h3 className="section-title">{t("sec_note")}</h3>
						<div className="field-group">
							<Field
								label={t("lbl_content")}
								value={item.note}
								mult
								mono={false}
							/>
						</div>
					</section>
				)}

				{item.type === "identity" && (
					<section>
						<h3 className="section-title">{t("sec_identity")}</h3>
						<div className="field-group">
							<Field label={t("lbl_first")} value={item.first} mono={false} />
							<Field label={t("lbl_last")} value={item.last} mono={false} />
							<Field label={t("lbl_email")} value={item.email} />
							<Field label={t("lbl_phone")} value={item.phone} />
							<Field
								label={t("lbl_address")}
								value={item.address}
								mono={false}
							/>
							<Field label={t("lbl_dob")} value={item.dob} />
							<Field label={t("lbl_passport")} value={item.passport} masked />
						</div>
					</section>
				)}

				{item.type === "ssh" && (
					<section>
						<h3 className="section-title">
							{item.keyType ? t("sec_ssh") : t("sec_token")}
						</h3>
						<div className="field-group">
							{item.username && (
								<Field
									label={t("lbl_comment")}
									value={item.username}
									mono={false}
								/>
							)}
							{item.keyType && (
								<Field label={t("lbl_algo")} value={item.keyType} />
							)}
							{item.fingerprint && (
								<Field label={t("lbl_fingerprint")} value={item.fingerprint} />
							)}
							{item.publicKey && (
								<Field label={t("lbl_pubkey")} value={item.publicKey} mult />
							)}
							{item.apiKey && (
								<Field label={t("lbl_secret")} value={item.apiKey} masked />
							)}
						</div>
					</section>
				)}

				{item.type === "wallet" && (
					<section>
						<h3 className="section-title">{t("sec_seed")}</h3>
						<div
							style={{
								padding: 14,
								border: "1px solid var(--line)",
								borderRadius: 10,
								background:
									"color-mix(in oklab, var(--danger) 8%, transparent)",
								marginBottom: 14,
								display: "flex",
								gap: 10,
								alignItems: "flex-start",
							}}
						>
							<Id_.Alert size={14} />
							<div style={{ fontSize: 12, color: "var(--text-2)" }}>
								{t("seed_warn")}
							</div>
						</div>
						<div className="field-group">
							<Field label={t("lbl_hint")} value={item.seedHint} mono={false} />
							<Field label={t("lbl_seed")} value={item.seed} masked mult />
						</div>
					</section>
				)}

				{customFields.length > 0 && (
					<section>
						<h3 className="section-title">{t("sec_custom_fields")}</h3>
						<div className="field-group">
							{customFields.map((f) => (
								<CustomFieldRow key={f.id} field={f} item={item} t={t} />
							))}
						</div>
					</section>
				)}
			</div>

			{editOpen && window.ZPASS_EditModal && (
				<window.ZPASS_EditModal
					item={item}
					onClose={() => setEditOpen(false)}
					onSave={(patch) => {
						if (onUpdate) onUpdate(item.id, patch);
						setEditOpen(false);
						toast?.(t("edit_saved"));
					}}
				/>
			)}
		</div>
	);
}

window.ZPASS_Detail = Detail;
