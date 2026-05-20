//! 与业务 crate 之间的胶水层。
//!
//! 每个 service 在结构上做三件事（spec/11 § 8）：
//! 1. 把同步业务调用包到 `cx.background_spawn(...)`（async 由 GPUI executor 跑）。
//! 2. 把 `VaultEventSink` 转成 `cx.emit(VaultUiEvent)`。
//! 3. 测试时用 `cx.executor().advance_clock(...)` 控制时间。

// Phase C 服务先就位、screens 在 C4-C8 才挂入；先放宽 dead_code 让 crate 层 API
// 完整暴露而不阻塞 clippy gate。C9 final pass 时再收紧。
#[allow(dead_code)]
pub mod clipboard;
#[allow(dead_code)]
pub mod export;
#[allow(dead_code)]
pub mod generator;
#[allow(dead_code)]
pub mod import;
#[allow(dead_code)]
pub mod otp;
#[allow(dead_code)]
pub mod passkey;
#[allow(dead_code)]
pub mod qr;
pub mod vault;
