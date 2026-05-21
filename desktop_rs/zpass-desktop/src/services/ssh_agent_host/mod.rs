//! SSH agent 在 GUI 进程一侧的承载（spec/08 § 3）。
//!
//! 拓扑：
//! ```
//! zpass-agent ──connect──> control.sock <──listen── zpass-desktop
//!                                           (本 module)
//! ```
//!
//! 职责：
//! - 监听 `control.sock`，等 agent 连接。
//! - 握手：发 Hello{nonce}，验 HelloReply HMAC。
//! - 推送当前 vault 解锁状态 + SSH 公钥列表。
//! - 接收 SignRequest：根据 key_blob 找 vault item → 解出 SSH 私钥 → 用 ssh-key 签 →
//!   发 SignReply。
//! - 接收 AuditEntry：转 `vault.append_audit`。
//!
//! D3 范围（本 commit）：除"用 ssh-key 签"以外的全套。签名占位返回 Err，D4 补全。

mod control;
mod signer;
mod state;
mod token;

pub use control::start_host_thread;
pub use state::SshHostState;
