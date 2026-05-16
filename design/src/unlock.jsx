// Unlock screen
const { useState: uS, useEffect: uE, useRef: uR } = React;
const I_u = window.ZPASS_ICONS;
const { useI18n: uUseI18n } = window.ZPASS_I18N;

function Unlock({ onUnlock }) {
	const [pw, setPw] = uS("");
	const [show, setShow] = uS(false);
	const [focus, setFocus] = uS(false);
	const [loading, setLoading] = uS(false);
	const ref = uR();
	const { t } = uUseI18n();
	uE(() => {
		ref.current?.focus();
	}, []);

	const submit = (e) => {
		e?.preventDefault();
		if (!pw) return;
		setLoading(true);
		setTimeout(onUnlock, 600);
	};

	return (
		<div className="unlock">
			<div className="unlock-card">
				<div className="unlock-logo">
					<div className="logo">Z</div>
					<div>
						<div style={{ fontWeight: 600, fontSize: 15 }}>ZPass</div>
						<div
							className="mono"
							style={{ fontSize: 11, color: "var(--text-3)" }}
						>
							{t("unlock_brand_sub")}
						</div>
					</div>
				</div>

				<h1>{t("unlock_greeting")}</h1>
				<p className="sub">{t("unlock_sub")}</p>

				<form onSubmit={submit}>
					<div className={"master-input " + (focus ? "focus" : "")}>
						<I_u.Lock size={16} />
						<input
							ref={ref}
							type={show ? "text" : "password"}
							value={pw}
							onChange={(e) => setPw(e.target.value)}
							onFocus={() => setFocus(true)}
							onBlur={() => setFocus(false)}
							placeholder={t("unlock_placeholder")}
							autoComplete="current-password"
						/>
						<button
							type="button"
							className="reveal"
							onClick={() => setShow((s) => !s)}
							aria-label="Toggle visibility"
						>
							{show ? <I_u.EyeOff size={16} /> : <I_u.Eye size={16} />}
						</button>
					</div>

					<div className="unlock-meta">
						<span>alex.rivera@zpass.dev</span>
						<button type="button" className="link-btn" onClick={() => {}}>
							{t("unlock_forgot")}
						</button>
					</div>

					<div className="biometric">
						<span className="dot"></span>
						<I_u.Fingerprint size={14} />
						<span>{t("unlock_bio")}</span>
					</div>

					<div className="unlock-foot">
						<button type="button" className="btn">
							{t("unlock_switch")}
						</button>
						<button
							type="submit"
							className="btn primary"
							disabled={loading || !pw}
						>
							{loading ? t("unlock_loading") : t("unlock_btn")}
							{!loading && <I_u.Chevron size={14} />}
						</button>
					</div>
				</form>
			</div>

			<div
				style={{
					position: "absolute",
					bottom: 20,
					left: 0,
					right: 0,
					textAlign: "center",
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					color: "var(--text-3)",
					zIndex: 1,
				}}
			>
				{t("unlock_foot")}
			</div>
		</div>
	);
}

window.ZPASS_Unlock = Unlock;
