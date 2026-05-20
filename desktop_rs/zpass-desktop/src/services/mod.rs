//! 与业务 crate 之间的胶水层。Phase B 只接 vault。
//!
//! 每个 service 在结构上做三件事（spec/11 § 8）：
//! 1. 把同步业务调用包到 `cx.background_spawn(...)`（async 由 GPUI executor 跑）。
//! 2. 把 `VaultEventSink` 转成 `cx.emit(VaultUiEvent)`。
//! 3. 测试时用 `cx.executor().advance_clock(...)` 控制时间。

pub mod vault;
