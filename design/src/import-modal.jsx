// 导入对话框：选文件 → 解析预览 → 应用到 items
//
// 复用现有 Edit Modal 的样式（.ef-backdrop / .ef-modal），仅补充少量本组件专属 class
// （.imp-*）。提交时调用父组件传入的 onApply(items, strategy) 完成实际写入。

const { useState: imS, useEffect: imE, useRef: imR, useMemo: imM } = React;

function ImportModal({ existingItems = [], onClose, onApply }) {
	const { t } = window.ZPASS_I18N.useI18n();
	const Im = window.ZPASS_ICONS;
	const [format] = imS("bitwarden"); // 预留：未来加 CXF 时变 useState
	const [fileName, setFileName] = imS("");
	const [result, setResult] = imS(null); // { ok, items, stats, skipped, total } | { ok:false, reason }
	const [strategy, setStrategy] = imS("append"); // 'append' | 'skip-dupe'
	const [busy, setBusy] = imS(false);
	const [dragOver, setDragOver] = imS(false);
	const fileRef = imR(null);

	// ESC 关闭
	imE(() => {
		const onKey = (e) => {
			if (e.key === "Escape") onClose?.();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const readFile = (file) => {
		if (!file) return;
		setFileName(file.name);
		setBusy(true);
		const reader = new FileReader();
		reader.onload = () => {
			const text = String(reader.result || "");
			const r = window.ZPASS_IMPORTER.importBitwardenText(text);
			setResult(r);
			setBusy(false);
		};
		reader.onerror = () => {
			setResult({ ok: false, reason: "parse_error" });
			setBusy(false);
		};
		reader.readAsText(file);
	};

	const onPick = (e) => {
		const f = e.target.files?.[0];
		if (f) readFile(f);
	};

	const onDrop = (e) => {
		e.preventDefault();
		setDragOver(false);
		const f = e.dataTransfer?.files?.[0];
		if (f) readFile(f);
	};

	// 应用导入
	const apply = () => {
		if (!result?.ok) return;
		let toAdd = result.items;
		let droppedDupes = 0;
		if (strategy === "skip-dupe") {
			const r = window.ZPASS_IMPORTER.dedupeByName(existingItems, toAdd);
			toAdd = r.kept;
			droppedDupes = r.dropped.length;
		}
		onApply?.(toAdd, { droppedDupes, strategy });
	};

	const stats = result?.ok ? result.stats : null;
	const skippedN = result?.ok ? result.skipped.length : 0;
	const okN = result?.ok ? result.items.length : 0;
	const totalN = result?.ok ? result.total : 0;
	const previewItems = imM(
		() => (result?.ok ? result.items.slice(0, 5) : []),
		[result],
	);

	// 错误提示文案
	const errMsg = (() => {
		if (!result || result.ok) return null;
		if (result.reason === "encrypted") return t("import_encrypted");
		return t("import_parse_error");
	})();

	return (
		<div className="ef-backdrop" onClick={onClose}>
			<div
				className="ef-modal imp-modal"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
			>
				<div className="ef-head">
					<h3>{t("import_title")}</h3>
					<button
						type="button"
						className="ef-close"
						onClick={onClose}
						title={t("edit_cancel")}
					>
						<Im.X size={14} />
					</button>
				</div>

				<div className="ef-body">
					<p className="ef-hint" style={{ margin: 0 }}>
						{t("import_sub")}
					</p>

					{/* Format 选择（目前只 Bitwarden，CXF 占位） */}
					<section>
						<div className="ef-sec">{t("import_format")}</div>
						<div className="imp-formats">
							<label className={`imp-fmt on`}>
								<input
									type="radio"
									name="imp-fmt"
									checked={format === "bitwarden"}
									readOnly
								/>
								<div className="imp-fmt-body">
									<div className="imp-fmt-name">{t("import_format_bw")}</div>
									<div className="imp-fmt-hint">
										{t("import_format_bw_hint")}
									</div>
								</div>
							</label>
							<label className="imp-fmt disabled">
								<input type="radio" name="imp-fmt" disabled />
								<div className="imp-fmt-body">
									<div className="imp-fmt-name">{t("import_format_cxf")}</div>
								</div>
							</label>
						</div>
					</section>

					{/* 拖拽 / 选择文件 */}
					<section>
						<div
							className={`imp-drop ${dragOver ? "drag" : ""} ${result?.ok ? "ok" : ""} ${result && !result.ok ? "err" : ""}`}
							onDragOver={(e) => {
								e.preventDefault();
								setDragOver(true);
							}}
							onDragLeave={() => setDragOver(false)}
							onDrop={onDrop}
						>
							<div className="imp-drop-icon">
								<Im.Upload size={22} />
							</div>
							<div className="imp-drop-text">
								<button
									type="button"
									className="btn"
									onClick={() => fileRef.current?.click()}
									disabled={busy}
								>
									{t("import_choose")}
								</button>
								<span className="imp-drop-hint">{t("import_drop")}</span>
							</div>
							<div className="imp-drop-file">
								{fileName || (
									<span className="imp-mute">{t("import_no_file")}</span>
								)}
							</div>
							<input
								ref={fileRef}
								type="file"
								accept=".json,application/json"
								style={{ display: "none" }}
								onChange={onPick}
							/>
						</div>
						{errMsg && (
							<div className="imp-err">
								<Im.AlertTriangle size={14} />
								<span>{errMsg}</span>
							</div>
						)}
					</section>

					{/* 统计 + 预览 */}
					{result?.ok && (
						<>
							<section>
								<div className="ef-sec">{t("import_breakdown")}</div>
								<div className="imp-summary">
									{okN > 0
										? t("import_summary", okN, totalN)
										: t("import_summary_zero")}
								</div>
								<div className="imp-stats">
									{stats.login > 0 && (
										<span className="imp-stat">
											<Im.Login size={12} /> {t("import_count_login")}{" "}
											<b>{stats.login}</b>
										</span>
									)}
									{stats.card > 0 && (
										<span className="imp-stat">
											<Im.Card size={12} /> {t("import_count_card")}{" "}
											<b>{stats.card}</b>
										</span>
									)}
									{stats.note > 0 && (
										<span className="imp-stat">
											<Im.Note size={12} /> {t("import_count_note")}{" "}
											<b>{stats.note}</b>
										</span>
									)}
									{stats.identity > 0 && (
										<span className="imp-stat">
											<Im.Id size={12} /> {t("import_count_identity")}{" "}
											<b>{stats.identity}</b>
										</span>
									)}
									{stats.ssh > 0 && (
										<span className="imp-stat">
											<Im.Ssh size={12} /> {t("import_count_ssh")}{" "}
											<b>{stats.ssh}</b>
										</span>
									)}
									{skippedN > 0 && (
										<span className="imp-stat warn">
											<Im.AlertTriangle size={12} />{" "}
											{t("import_count_skipped")} <b>{skippedN}</b>
										</span>
									)}
								</div>
								{skippedN > 0 && (
									<div className="imp-warn">
										{t("import_warning_skipped", skippedN)}
									</div>
								)}
							</section>

							{previewItems.length > 0 && (
								<section>
									<div className="ef-sec">{t("import_preview")}</div>
									<div className="imp-preview">
										{previewItems.map((p) => (
											<div className="imp-prev-row" key={p.id}>
												<span className="imp-prev-type">{p.type}</span>
												<span className="imp-prev-name">{p.name}</span>
												<span className="imp-prev-sub">
													{p.username || p.url || p.cardholder || ""}
												</span>
											</div>
										))}
									</div>
								</section>
							)}

							<section>
								<div className="ef-sec">{t("import_strategy")}</div>
								<div className="imp-strategy">
									<label>
										<input
											type="radio"
											name="imp-strat"
											value="append"
											checked={strategy === "append"}
											onChange={() => setStrategy("append")}
										/>
										<span>{t("import_strategy_append")}</span>
									</label>
									<label>
										<input
											type="radio"
											name="imp-strat"
											value="skip-dupe"
											checked={strategy === "skip-dupe"}
											onChange={() => setStrategy("skip-dupe")}
										/>
										<span>{t("import_strategy_skip_dupe")}</span>
									</label>
								</div>
							</section>
						</>
					)}
				</div>

				<div className="ef-foot">
					<button type="button" className="btn ghost" onClick={onClose}>
						{t("import_cancel")}
					</button>
					<button
						type="button"
						className="btn primary"
						onClick={apply}
						disabled={!result?.ok || okN === 0}
					>
						<Im.Download size={13} /> {t("import_run")}
					</button>
				</div>
			</div>
		</div>
	);
}

window.ZPASS_ImportModal = ImportModal;
