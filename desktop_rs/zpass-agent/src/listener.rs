//! ssh-client UDS listener + 每连接 handler 线程。
//!
//! 收到的请求按 spec/08 § 4 处理：
//! - REQUEST_IDENTITIES → 用 state.keys() 构造 IDENTITIES_ANSWER
//! - SIGN_REQUEST → 转给控制通道线程 → 等 SignReply → 写 SIGN_RESPONSE
//! - ADD_IDENTITY / REMOVE_* → 一律拒绝 SSH_AGENT_FAILURE

use std::path::Path;
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;

use anyhow::{Context as _, Result};

use crate::agent_proto::{
    self, Identity, SSH_AGENT_FAILURE, SSH_AGENT_IDENTITIES_ANSWER, SSH_AGENT_SIGN_RESPONSE,
    SSH_AGENTC_ADD_IDENTITY, SSH_AGENTC_REMOVE_ALL_IDENTITIES, SSH_AGENTC_REMOVE_IDENTITY,
    SSH_AGENTC_REQUEST_IDENTITIES, SSH_AGENTC_SIGN_REQUEST, build_identities_answer,
    build_sign_response, parse_sign_request,
};
use crate::state::{SharedState, SignDispatch};

/// 在主线程启动 listener，循环 accept；每条连接派一个 handler 线程。
pub fn run_listener(
    agent_sock: &Path,
    state: SharedState,
    sign_tx: Sender<SignDispatch>,
) -> Result<()> {
    // 删除可能的 stale socket
    let _ = std::fs::remove_file(agent_sock);

    #[cfg(unix)]
    let listener = std::os::unix::net::UnixListener::bind(agent_sock)
        .with_context(|| format!("bind {}", agent_sock.display()))?;
    #[cfg(not(unix))]
    compile_error!("Windows named pipe path not in this sub-phase");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(agent_sock, std::fs::Permissions::from_mode(0o600));
    }

    eprintln!("zpass-agent: listening on {}", agent_sock.display());

    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("zpass-agent: accept error: {e}");
                continue;
            }
        };
        let state = state.clone();
        let sign_tx = sign_tx.clone();
        thread::spawn(move || {
            if let Err(e) = handle_connection(stream, state, sign_tx) {
                eprintln!("zpass-agent: connection error: {e:#}");
            }
        });
    }
    Ok(())
}

fn handle_connection(
    mut stream: std::os::unix::net::UnixStream,
    state: SharedState,
    sign_tx: Sender<SignDispatch>,
) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    loop {
        let (op, payload) = match agent_proto::read_message(&mut stream) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        match op {
            SSH_AGENTC_REQUEST_IDENTITIES => {
                let keys = state.keys();
                let ids: Vec<Identity<'_>> = keys
                    .iter()
                    .map(|k| Identity {
                        blob: &k.blob,
                        comment: &k.comment,
                    })
                    .collect();
                let payload = build_identities_answer(&ids);
                agent_proto::write_message(&mut stream, SSH_AGENT_IDENTITIES_ANSWER, &payload)?;
            }
            SSH_AGENTC_SIGN_REQUEST => {
                let sr = parse_sign_request(&payload)?;
                // vault locked → 立即返回 FAILURE
                if !state.is_unlocked() {
                    agent_proto::write_message(&mut stream, SSH_AGENT_FAILURE, &[])?;
                    continue;
                }
                let (request_id, pending) = state.register_pending();
                if sign_tx
                    .send(SignDispatch {
                        request_id,
                        key_blob: sr.key_blob,
                        data: sr.data,
                        flags: sr.flags,
                    })
                    .is_err()
                {
                    // 控制通道断了
                    state.complete_pending(request_id, Err("control channel gone".into()));
                    agent_proto::write_message(&mut stream, SSH_AGENT_FAILURE, &[])?;
                    continue;
                }
                // 等 GUI 回 SignReply（最多 30s）
                let result = state.wait_pending(request_id, pending, Duration::from_secs(30));
                match result {
                    Some(Ok(sig)) => {
                        let resp = build_sign_response(&sig);
                        agent_proto::write_message(&mut stream, SSH_AGENT_SIGN_RESPONSE, &resp)?;
                    }
                    Some(Err(_)) | None => {
                        agent_proto::write_message(&mut stream, SSH_AGENT_FAILURE, &[])?;
                    }
                }
            }
            // 一律拒绝
            SSH_AGENTC_ADD_IDENTITY
            | SSH_AGENTC_REMOVE_IDENTITY
            | SSH_AGENTC_REMOVE_ALL_IDENTITIES => {
                agent_proto::write_message(&mut stream, SSH_AGENT_FAILURE, &[])?;
            }
            _ => {
                agent_proto::write_message(&mut stream, SSH_AGENT_FAILURE, &[])?;
            }
        }
    }
}
