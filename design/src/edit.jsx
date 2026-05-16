// 编辑模态框 —— 原生字段 + 自定义字段（参考 Bitwarden）
const { useState: eS, useEffect: eE, useMemo: eM, useRef: eR } = React;
const { useToast: eUT } = window.ZPASS_UI;
const Ie_ = window.ZPASS_ICONS;
const { useI18n: eI18n } = window.ZPASS_I18N;
const { TYPE_SCHEMA, CUSTOM_FIELD_TYPES, LINKABLE_FIELDS } = window.ZPASS_DATA;

// 生成唯一 id（仅 mock 用途）
function cfid() {
	return "cf-" + Math.random().toString(36).slice(2, 9);
}

// 单个原生字段输入控件
function NativeFieldInput({ field, value, onChange, t }) {
	const label = t(field.labelKey);
	if (field.input === "multiline") {
		return (
			<label className="ef-row col">
				<span className="ef-lbl">{label}</span>
				<textarea
					value={value || ""}
					onChange={(e) => onChange(e.target.value)}
					rows={field.key === "publicKey" || field.key === "seed" ? 4 : 3}
					className={field.mono === false ? "" : "mono"}
				/>
			</label>
		);
	}
	const isMasked = field.input === "password";
	return (
		<label className="ef-row col">
			<span className="ef-lbl">{label}</span>
			<input
				type={isMasked ? "password" : "text"}
				value={value || ""}
				onChange={(e) => onChange(e.target.value)}
				className={field.mono === false ? "" : "mono"}
				autoComplete="off"
			/>
		</label>
	);
}

// 自定义字段编辑行
function CustomFieldEditor({ field, onChange, onRemove, linkable, t }) {
	const setName = (v) => onChange({ ...field, name: v });
	const setValue = (v) => onChange({ ...field, value: v });
	const setType = (v) => {
		// 切换类型时重置 value 形态
		const reset =
			v === "boolean"
				? false
				: v === "linked"
					? linkable[0] || ""
					: "";
		onChange({ ...field, type: v, value: reset });
	};

	return (
		<div className="cf-edit">
			<div className="cf-edit-head">
				<select
					className="cf-type"
					value={field.type}
					onChange={(e) => setType(e.target.value)}
					title={t("cf_type_" + field.type)}
				>
					{CUSTOM_FIELD_TYPES.map((tp) => (
						<option key={tp} value={tp}>
							{t("cf_type_" + tp)}
						</option>
					))}
				</select>
				<input
					type="text"
					className="cf-name"
					placeholder={t("cf_name_placeholder")}
					value={field.name || ""}
					onChange={(e) => setName(e.target.value)}
				/>
				<button
					type="button"
					className="cf-del"
					onClick={onRemove}
					title={t("cf_remove")}
				>
					<Ie_.Trash size={13} />
				</button>
			</div>
			<div className="cf-edit-body">
				{field.type === "text" && (
					<input
						type="text"
						placeholder={t("cf_value_placeholder")}
						value={field.value || ""}
						onChange={(e) => setValue(e.target.value)}
					/>
				)}
				{field.type === "hidden" && (
					<input
						type="password"
						placeholder={t("cf_value_placeholder")}
						value={field.value || ""}
						onChange={(e) => setValue(e.target.value)}
						autoComplete="new-password"
					/>
				)}
				{field.type === "boolean" && (
					<div
						className={"ef-switch " + (field.value ? "on" : "")}
						onClick={() => setValue(!field.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								setValue(!field.value);
							}
						}}
						role="switch"
						aria-checked={!!field.value}
						tabIndex={0}
					/>
				)}
				{field.type === "linked" && (
					<>
						{linkable.length === 0 ? (
							<div className="ef-hint">{t("cf_no_linkable")}</div>
						) : (
							<select
								value={field.value || ""}
								onChange={(e) => setValue(e.target.value)}
							>
								<option value="">{t("cf_link_none")}</option>
								{linkable.map((k) => (
									<option key={k} value={k}>
										{k}
									</option>
								))}
							</select>
						)}
					</>
				)}
			</div>
		</div>
	);
}

// 主模态框
function EditModal({ item, onClose, onSave }) {
	const { t } = eI18n();
	const schema = TYPE_SCHEMA[item.type] || { fields: [] };
	const linkable = LINKABLE_FIELDS[item.type] || [];

	// 把 item 拷贝到 draft
	const [draft, setDraft] = eS(() => {
		const d = { ...item };
		// 标签转字符串方便编辑
		d._tagsStr = (item.tags || []).join(", ");
		d.customFields = (item.customFields || []).map((f) => ({ ...f }));
		return d;
	});

	const setField = (k, v) => setDraft((p) => ({ ...p, [k]: v }));

	// ESC 关闭
	eE(() => {
		const onKey = (e) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// 自定义字段操作
	const addCF = (type) => {
		const initialValue =
			type === "boolean"
				? false
				: type === "linked"
					? linkable[0] || ""
					: "";
		setDraft((p) => ({
			...p,
			customFields: [
				...(p.customFields || []),
				{ id: cfid(), type, name: "", value: initialValue },
			],
		}));
	};
	const updateCF = (idx, next) => {
		setDraft((p) => {
			const arr = [...(p.customFields || [])];
			arr[idx] = next;
			return { ...p, customFields: arr };
		});
	};
	const removeCF = (idx) => {
		setDraft((p) => {
			const arr = [...(p.customFields || [])];
			arr.splice(idx, 1);
			return { ...p, customFields: arr };
		});
	};

	const submit = () => {
		const tags = (draft._tagsStr || "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const patch = { ...draft, tags };
		// 清理临时键
		delete patch._tagsStr;
		// 清理空名称的自定义字段
		patch.customFields = (patch.customFields || []).filter(
			(f) => (f.name || "").trim() || f.type === "boolean",
		);
		onSave(patch);
	};

	return (
		<div className="ef-backdrop" onClick={onClose}>
			<div
				className="ef-modal"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
			>
				<div className="ef-head">
					<h3>{t("edit_title")}</h3>
					<button
						type="button"
						className="ef-close"
						onClick={onClose}
						aria-label={t("edit_cancel")}
					>
						<span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
					</button>
				</div>

				<div className="ef-body">
					{/* 基础信息 */}
					<section>
						<h4 className="ef-sec">{t("edit_section_basic")}</h4>
						<label className="ef-row col">
							<span className="ef-lbl">{t("lbl_item_name")}</span>
							<input
								type="text"
								value={draft.name || ""}
								onChange={(e) => setField("name", e.target.value)}
								autoFocus
							/>
						</label>
					</section>

					{/* 原生字段 */}
					{schema.fields.length > 0 && (
						<section>
							<h4 className="ef-sec">{t("edit_section_native")}</h4>
							<div className="ef-fields">
								{schema.fields.map((f) => (
									<NativeFieldInput
										key={f.key}
										field={f}
										value={draft[f.key]}
										onChange={(v) => setField(f.key, v)}
										t={t}
									/>
								))}
							</div>
						</section>
					)}

					{/* 自定义字段 */}
					<section>
						<div className="ef-sec-row">
							<h4 className="ef-sec">{t("edit_section_custom")}</h4>
							<div className="ef-add-group">
								<button
									type="button"
									className="btn sm"
									onClick={() => addCF("text")}
								>
									<Ie_.Plus size={12} /> {t("cf_add_text")}
								</button>
								<button
									type="button"
									className="btn sm"
									onClick={() => addCF("hidden")}
								>
									<Ie_.Plus size={12} /> {t("cf_add_hidden")}
								</button>
								<button
									type="button"
									className="btn sm"
									onClick={() => addCF("boolean")}
								>
									<Ie_.Plus size={12} /> {t("cf_add_boolean")}
								</button>
								<button
									type="button"
									className="btn sm"
									onClick={() => addCF("linked")}
									disabled={linkable.length === 0}
								>
									<Ie_.Plus size={12} /> {t("cf_add_linked")}
								</button>
							</div>
						</div>
						{(!draft.customFields || draft.customFields.length === 0) ? (
							<div className="ef-empty">{t("cf_empty")}</div>
						) : (
							<div className="cf-list">
								{draft.customFields.map((f, idx) => (
									<CustomFieldEditor
										key={f.id}
										field={f}
										linkable={linkable}
										t={t}
										onChange={(next) => updateCF(idx, next)}
										onRemove={() => removeCF(idx)}
									/>
								))}
							</div>
						)}
					</section>

					{/* 备注 */}
					<section>
						<h4 className="ef-sec">{t("edit_section_notes")}</h4>
						<label className="ef-row col">
							<span className="ef-lbl">{t("lbl_notes")}</span>
							<textarea
								rows={3}
								value={draft.notes || ""}
								onChange={(e) => setField("notes", e.target.value)}
							/>
						</label>
					</section>

					{/* 组织 */}
					<section>
						<h4 className="ef-sec">{t("edit_section_meta")}</h4>
						<label className="ef-row col">
							<span className="ef-lbl">{t("lbl_folder")}</span>
							<input
								type="text"
								value={draft.folder || ""}
								onChange={(e) => setField("folder", e.target.value)}
							/>
						</label>
						<label className="ef-row col">
							<span className="ef-lbl">{t("lbl_tags")}</span>
							<input
								type="text"
								placeholder={t("tags_placeholder")}
								value={draft._tagsStr || ""}
								onChange={(e) => setField("_tagsStr", e.target.value)}
							/>
						</label>
					</section>
				</div>

				<div className="ef-foot">
					<button type="button" className="btn ghost" onClick={onClose}>
						{t("edit_cancel")}
					</button>
					<button type="button" className="btn primary" onClick={submit}>
						<Ie_.Check size={13} /> {t("edit_save")}
					</button>
				</div>
			</div>
		</div>
	);
}

window.ZPASS_EditModal = EditModal;
