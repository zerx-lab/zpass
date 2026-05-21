//! 系统剪贴板写入（spec/11 § 9 + design/src/ui.jsx 的 copyText UX）。
//!
//! 使用 `arboard`：跨平台（X11 / Wayland / macOS / Windows）。
//! 注意：写入剪贴板的字符串会被 `arboard` 内部 clone；上层若需要抹零，
//! 调用前自己 `Zeroizing::new(s.clone())` 即可。

use arboard::Clipboard;

#[derive(Debug)]
pub enum ClipboardError {
    Init,
    Write,
}

pub fn copy_text(text: &str) -> Result<(), ClipboardError> {
    let mut cb = Clipboard::new().map_err(|_| ClipboardError::Init)?;
    cb.set_text(text.to_string())
        .map_err(|_| ClipboardError::Write)
}
