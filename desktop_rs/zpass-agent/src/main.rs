//! ZPass SSH agent 守护进程（spec/08）。
//!
//! 进程结构：
//! - **主线程**：UDS listener，accept ssh-client 连接 → 派 handler 线程
//! - **控制通道线程**：connect 到 GUI 的 UDS server，握手，循环收发消息；
//!   断开后按指数 backoff 重连
//!
//! 不持有 DEK。SIGN_REQUEST 转发给 GUI；本地从不解密任何密钥。

mod agent_proto;
mod config;
mod control;
mod listener;
mod state;

use std::sync::mpsc;
use std::thread;

use anyhow::{Context as _, Result};

use crate::config::{load_or_create_token, remove_stale_socket, resolve_paths};
use crate::state::{SharedState, SignDispatch};

fn main() -> Result<()> {
    let paths = resolve_paths().context("resolve paths")?;
    let token = load_or_create_token(&paths.token_path).context("load token")?;
    remove_stale_socket(&paths.agent_sock).ok();

    eprintln!("zpass-agent starting:");
    eprintln!("  agent_sock   = {}", paths.agent_sock.display());
    eprintln!("  control_sock = {}", paths.control_sock.display());

    let state = SharedState::new();
    let (sign_tx, sign_rx) = mpsc::channel::<SignDispatch>();

    // 控制通道线程
    {
        let state = state.clone();
        let control_sock = paths.control_sock.clone();
        thread::spawn(move || {
            if let Err(e) = control::run_control_loop(&control_sock, token, state, sign_rx) {
                eprintln!("zpass-agent: control loop exited with error: {e:#}");
            }
        });
    }

    // listener：阻塞主线程
    listener::run_listener(&paths.agent_sock, state, sign_tx)
}
