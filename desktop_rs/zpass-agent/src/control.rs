//! 控制通道 client：connect 到 GUI（`control.sock`），握手，循环收发消息。
//!
//! 设计要点（spec/08 § 3）：
//! - GUI 是 listener，agent 是 connector（让 GUI 重启时 agent 自动重连）。
//! - 握手：GUI 发 Hello{nonce}，agent 回 HelloReply{nonce, hmac}。
//! - 后续：GUI 推 OpState / PushKeys；agent 推 SignRequest / AuditEntry。
//! - 任一侧 EOF / 异常 → agent 退回 backoff 重连循环。

use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow};
use zpass_ssh_agent_proto::{AgentMessage, CapabilityToken, decode_frame, encode_frame};

use crate::state::{Backoff, SharedState, SignDispatch};

/// 控制通道线程的入口；阻塞执行，仅在进程退出时返回。
pub fn run_control_loop(
    control_sock: &Path,
    token: CapabilityToken,
    state: SharedState,
    sign_rx: Receiver<SignDispatch>,
) -> Result<()> {
    let mut backoff = Backoff::new();
    loop {
        match connect_once(control_sock, &token, &state, &sign_rx) {
            Ok(()) => {
                // Bye 正常退出：重置 backoff，立刻重连。
                backoff.reset();
            }
            Err(e) => {
                eprintln!("zpass-agent: control channel error: {e:#}");
                state.set_unlocked(false);
                state.set_keys(vec![]);
                state.cancel_all_pending("GUI disconnected");
            }
        }
        let d = backoff.next();
        std::thread::sleep(d);
    }
}

fn connect_once(
    control_sock: &Path,
    token: &CapabilityToken,
    state: &SharedState,
    sign_rx: &Receiver<SignDispatch>,
) -> Result<()> {
    #[cfg(unix)]
    let mut stream = std::os::unix::net::UnixStream::connect(control_sock)
        .with_context(|| format!("connect {}", control_sock.display()))?;
    #[cfg(not(unix))]
    let mut stream: std::io::Empty = unimplemented!("Windows pipes not in this sub-phase");

    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .context("set read timeout")?;

    // 1) GUI 发 Hello
    let hello = read_msg(&mut stream)?;
    let nonce = match hello {
        AgentMessage::Hello { nonce } => nonce,
        other => return Err(anyhow!("expected Hello, got {other:?}")),
    };
    // 2) 回 HelloReply
    let hmac = token.hmac(&nonce);
    write_msg(&mut stream, &AgentMessage::HelloReply { nonce, hmac })?;

    eprintln!("zpass-agent: control channel handshake ok");

    // 主循环：select() 风格用 stream non-blocking + sign_rx try_recv。
    // 简化：read 设短超时（200ms）轮询；sign_rx 也 try_recv。
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .ok();
    loop {
        // 1. 尝试 read 一帧（短超时）
        match try_read_msg(&mut stream) {
            Ok(Some(msg)) => handle_incoming(msg, state)?,
            Ok(None) => {} // timeout
            Err(e) => return Err(e),
        }
        // 2. 尝试取一个 SignDispatch 转发出去
        match sign_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(d) => {
                write_msg(
                    &mut stream,
                    &AgentMessage::SignRequest {
                        request_id: d.request_id,
                        key_blob: d.key_blob,
                        data: d.data,
                        flags: d.flags,
                    },
                )?;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                // handler 端断了；正常退出。
                let _ = write_msg(&mut stream, &AgentMessage::Bye);
                return Ok(());
            }
        }
    }
}

fn handle_incoming(msg: AgentMessage, state: &SharedState) -> Result<()> {
    match msg {
        AgentMessage::OpState { unlocked } => {
            state.set_unlocked(unlocked);
        }
        AgentMessage::PushKeys { keys } => {
            state.set_keys(keys);
        }
        AgentMessage::SignReply {
            request_id,
            signature,
        } => {
            state.complete_pending(request_id, signature);
        }
        AgentMessage::Bye => {
            return Err(anyhow!("GUI sent Bye"));
        }
        // Hello / HelloReply 不应在握手后再出现
        other => {
            eprintln!("zpass-agent: unexpected message after handshake: {other:?}");
        }
    }
    Ok(())
}

fn write_msg<W: Write>(w: &mut W, msg: &AgentMessage) -> Result<()> {
    let bytes = encode_frame(msg).map_err(|e| anyhow!("encode: {e}"))?;
    w.write_all(&bytes).context("write frame")?;
    w.flush().context("flush frame")?;
    Ok(())
}

/// 阻塞读取一帧；只在 io error 时返回 Err。
fn read_msg<R: Read>(r: &mut R) -> Result<AgentMessage> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).context("read frame length")?;
    let len = u32::from_be_bytes(len_buf);
    if len > 16 * 1024 * 1024 {
        return Err(anyhow!("frame too large: {len}"));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body).context("read frame body")?;
    let mut full = Vec::with_capacity(4 + body.len());
    full.extend_from_slice(&len_buf);
    full.extend_from_slice(&body);
    decode_frame(&full).map_err(|e| anyhow!("decode: {e}"))
}

/// 非阻塞读取一帧；timeout 时返回 Ok(None)。
fn try_read_msg<R: Read>(r: &mut R) -> Result<Option<AgentMessage>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e)
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut =>
        {
            return Ok(None);
        }
        Err(e) => return Err(anyhow!("read len: {e}")),
    }
    let len = u32::from_be_bytes(len_buf);
    if len > 16 * 1024 * 1024 {
        return Err(anyhow!("frame too large: {len}"));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body).context("read frame body")?;
    let mut full = Vec::with_capacity(4 + body.len());
    full.extend_from_slice(&len_buf);
    full.extend_from_slice(&body);
    Ok(Some(
        decode_frame(&full).map_err(|e| anyhow!("decode: {e}"))?,
    ))
}
