//! 与业务 crate 之间的胶水层。
//!
//! 每个 service 在结构上做三件事（spec/11 § 8）：
//! 1. 把同步业务调用包到 `cx.background_spawn(...)`（async 由 GPUI executor 跑）。
//! 2. 把 `VaultEventSink` 转成 `cx.emit(VaultUiEvent)`。
//! 3. 测试时用 `cx.executor().advance_clock(...)` 控制时间。

// Phase C 服务全部就位。clipboard / export / generator / import / vault 已被
// C5-C8 screens 完整消费；otp / passkey / qr 暴露的 API 表面更广（含 Phase E
// 浏览器桥与未来 HOTP 详情按钮所需路径），保留 dead_code 标记直到对应消费点接入。
pub mod clipboard;
pub mod export;
pub mod generator;
pub mod import;
#[allow(dead_code)]
pub mod otp;
#[allow(dead_code)]
pub mod passkey;
#[allow(dead_code)]
pub mod qr;
// Phase D：SSH agent 控制通道 server。D5 screens/ssh_agent.rs 接入后消费。
#[allow(dead_code)]
pub mod ssh_agent_host;
pub mod vault;
