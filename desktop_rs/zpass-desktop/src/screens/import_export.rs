//! 导入 / 导出屏（spec/13 § 3 + design/src/importer.jsx + import-modal.jsx）。
//!
//! Phase C C8：
//! - Export：调 `services::export::export_to_json`，弹 `rfd::FileDialog::save_file`，写盘。
//! - Import：弹 `rfd::FileDialog::pick_file`，读 JSON 调 `services::import::import_from_json`。
//! - 显示上次操作结果（成功 / 错误 / 跳过条目数）。
//!
//! 不在本屏：Bitwarden 导入（spec/00 D10 显式剥离）。

use std::sync::Arc;

use gpui::{Context, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, px};
use gpui_component::{
    Sizable as _,
    button::{Button, ButtonVariants as _},
    v_flex,
};

use crate::app::AppState;
use crate::i18n;
use crate::services::export::export_to_json;
use crate::services::import::{ImportError, ImportSummary, import_from_json};
use crate::services::vault::VaultHandle;
use crate::theme::Theme;

#[derive(Debug, Clone)]
enum LastResult {
    None,
    ExportOk { path: String, item_count: usize },
    ExportErr(String),
    ImportOk(ImportSummary),
    ImportErr(String),
}

pub struct ImportExportView {
    vault: Arc<VaultHandle>,
    last: LastResult,
}

impl ImportExportView {
    pub fn new(_cx: &mut Context<Self>, vault: Arc<VaultHandle>) -> Self {
        Self {
            vault,
            last: LastResult::None,
        }
    }

    fn do_export(&mut self, cx: &mut Context<Self>) {
        // 同步路径：先序列化，再用 rfd 同步弹窗。rfd 在 main thread 同步调用即可。
        let json = match export_to_json(self.vault.service().as_ref()) {
            Ok(s) => s,
            Err(e) => {
                self.last = LastResult::ExportErr(format!("{e:?}"));
                cx.notify();
                return;
            }
        };
        // 估算条目数：以 vault 当前列表为准（与 export 输出一致）。
        let item_count = self
            .vault
            .service()
            .list_items()
            .map(|v| v.len())
            .unwrap_or(0);
        let picked = rfd::FileDialog::new()
            .set_file_name("zpass-export.json")
            .add_filter("JSON", &["json"])
            .save_file();
        let Some(path) = picked else {
            // 用户取消：不更新 last（避免把"成功"覆盖为静默）
            return;
        };
        if let Err(e) = std::fs::write(&path, &json) {
            self.last = LastResult::ExportErr(format!("{e:?}"));
            cx.notify();
            return;
        }
        self.last = LastResult::ExportOk {
            path: path.display().to_string(),
            item_count,
        };
        cx.notify();
    }

    fn do_import(&mut self, cx: &mut Context<Self>) {
        let picked = rfd::FileDialog::new()
            .add_filter("JSON", &["json"])
            .pick_file();
        let Some(path) = picked else {
            return;
        };
        let json = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                self.last = LastResult::ImportErr(format!("{e:?}"));
                cx.notify();
                return;
            }
        };
        match import_from_json(self.vault.service().as_ref(), &json) {
            Ok(s) => {
                self.last = LastResult::ImportOk(s);
            }
            Err(ImportError::UnsupportedExportVersion) => {
                self.last = LastResult::ImportErr(i18n::t("importExport.error.version").into());
            }
            Err(e) => {
                self.last = LastResult::ImportErr(format!("{e:?}"));
            }
        }
        cx.notify();
    }
}

impl Render for ImportExportView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<AppState>().theme;

        let mut col = v_flex().size_full().p(px(32.0)).gap(px(20.0));

        col = col.child(
            div()
                .text_size(px(24.0))
                .text_color(theme.text)
                .child(SharedString::from(i18n::t("importExport.title"))),
        );
        col = col.child(
            div()
                .text_size(px(13.0))
                .text_color(theme.text_3)
                .child(SharedString::from(i18n::t("importExport.subtitle"))),
        );

        // Export / Import 两列卡片
        col = col.child(
            div()
                .flex()
                .gap(px(16.0))
                .child(card_export(theme, cx))
                .child(card_import(theme, cx)),
        );

        // 上次结果区
        col = col.child(render_last(&self.last, theme));

        col
    }
}

fn card_export(theme: Theme, cx: &mut Context<ImportExportView>) -> impl IntoElement {
    v_flex()
        .flex_1()
        .p(px(20.0))
        .gap(px(8.0))
        .rounded(px(10.0))
        .bg(theme.bg_elev)
        .border_1()
        .border_color(theme.line)
        .child(
            div()
                .text_size(px(16.0))
                .text_color(theme.text)
                .child(SharedString::from(i18n::t("importExport.export.title"))),
        )
        .child(
            div()
                .text_size(px(12.0))
                .text_color(theme.text_3)
                .child(SharedString::from(i18n::t("importExport.export.subtitle"))),
        )
        .child(
            div().pt(px(8.0)).child(
                Button::new("ie-export-btn")
                    .primary()
                    .small()
                    .label(i18n::t("importExport.export.action"))
                    .on_click(cx.listener(|this, _, _, cx| this.do_export(cx))),
            ),
        )
}

fn card_import(theme: Theme, cx: &mut Context<ImportExportView>) -> impl IntoElement {
    v_flex()
        .flex_1()
        .p(px(20.0))
        .gap(px(8.0))
        .rounded(px(10.0))
        .bg(theme.bg_elev)
        .border_1()
        .border_color(theme.line)
        .child(
            div()
                .text_size(px(16.0))
                .text_color(theme.text)
                .child(SharedString::from(i18n::t("importExport.import.title"))),
        )
        .child(
            div()
                .text_size(px(12.0))
                .text_color(theme.text_3)
                .child(SharedString::from(i18n::t("importExport.import.subtitle"))),
        )
        .child(
            div().pt(px(8.0)).child(
                Button::new("ie-import-btn")
                    .small()
                    .label(i18n::t("importExport.import.action"))
                    .on_click(cx.listener(|this, _, _, cx| this.do_import(cx))),
            ),
        )
}

fn render_last(last: &LastResult, theme: Theme) -> gpui::AnyElement {
    let text: Option<(String, gpui::Hsla)> = match last {
        LastResult::None => None,
        LastResult::ExportOk { path, item_count } => Some((
            format!(
                "{} → {} ({} items)",
                i18n::t("importExport.last.exportedOk"),
                path,
                item_count
            ),
            theme.ok,
        )),
        LastResult::ExportErr(e) => Some((
            format!("{}: {}", i18n::t("importExport.last.exportErr"), e),
            theme.danger,
        )),
        LastResult::ImportOk(s) => Some((
            format!(
                "{}: {} imported, {} wallet→note, {} skipped",
                i18n::t("importExport.last.importedOk"),
                s.imported,
                s.wallet_migrated,
                s.skipped_unknown_type
            ),
            theme.ok,
        )),
        LastResult::ImportErr(e) => Some((
            format!("{}: {}", i18n::t("importExport.last.importErr"), e),
            theme.danger,
        )),
    };
    match text {
        Some((s, color)) => div()
            .pt(px(8.0))
            .border_t_1()
            .border_color(theme.line_soft)
            .text_color(color)
            .text_size(px(12.0))
            .child(SharedString::from(s))
            .into_any_element(),
        None => div().into_any_element(),
    }
}
