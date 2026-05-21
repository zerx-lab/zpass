//! GUI 侧控制通道：listen on `control.sock`，accept agent，握手，循环处理消息。
//!
//! 关键设计（spec/08 § 3）：
//! - GUI 是 server；agent 重连免去 GUI 重启 = ssh-agent 失效的 UX 痛点
//! - 通过 channel 把 SignRequest 派到 vault 操作，签完再回写 SignReply
//! - 任一侧 EOF / error → close connection；agent 自己会按 backoff 重连

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow};
use zpass_ssh_agent_proto::{
    AgentMessage, AuditDecisionWire, AuditEntryWire, CapabilityToken, PublicKeyEntry, decode_frame,
    encode_frame,
};
use zpass_vault_format::{AuditEntry as VaultAuditEntry, FieldValue};
use zpass_vault_service::VaultService;
use zpass_vault_store::SqliteVaultStore;

use super::signer::sign_with_vault_key;
use super::state::SshHostState;
use super::token::{control_sock_path, load_or_create_token, token_path};

/// 启动 host 监听线程；调用者通常在 settings 屏 toggle ON 时调一次。
///
/// 真正的幂等保证（reviewer finding #3 修复）：用 `OnceLock` 锁住"已启动"flag，
/// 第二次调用直接 short-circuit，不会再删 socket / 不会再 spawn 线程。
pub fn start_host_thread(
    vault: Arc<VaultService<SqliteVaultStore>>,
    state: SshHostState,
) -> Result<()> {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.get().is_some() {
        // 已经启动过；直接成功返回（UI 会通过 SshHostState 看到正确的状态）。
        return Ok(());
    }
    let token_p = token_path()?;
    let sock_p = control_sock_path()?;
    let token = load_or_create_token(&token_p)?;
    // 第一次：删 stale sock（前一次进程崩了留下的），然后 spawn 唯一一个线程。
    let _ = std::fs::remove_file(&sock_p);
    let _ = STARTED.set(());

    thread::spawn(move || {
        if let Err(e) = run_accept_loop(sock_p, token, vault, state) {
            eprintln!("ssh-agent-host: accept loop exited: {e:#}");
        }
    });
    Ok(())
}

fn run_accept_loop(
    sock_p: PathBuf,
    token: CapabilityToken,
    vault: Arc<VaultService<SqliteVaultStore>>,
    state: SshHostState,
) -> Result<()> {
    #[cfg(unix)]
    let listener = std::os::unix::net::UnixListener::bind(&sock_p)
        .with_context(|| format!("bind {}", sock_p.display()))?;
    #[cfg(not(unix))]
    compile_error!("Windows named pipe in this sub-phase not wired");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&sock_p, std::fs::Permissions::from_mode(0o600));
    }

    eprintln!(
        "ssh-agent-host: listening on {} (waiting for agent)",
        sock_p.display()
    );

    for incoming in listener.incoming() {
        let stream = match incoming {
            Ok(s) => s,
            Err(e) => {
                eprintln!("ssh-agent-host: accept error: {e}");
                continue;
            }
        };
        let token = token.clone();
        let vault = vault.clone();
        let state = state.clone();
        thread::spawn(move || {
            state.set_agent_connected(true);
            if let Err(e) = handle_agent(stream, token, vault.clone(), state.clone()) {
                eprintln!("ssh-agent-host: agent session error: {e:#}");
            }
            state.set_agent_connected(false);
        });
    }
    Ok(())
}

fn handle_agent(
    mut stream: std::os::unix::net::UnixStream,
    token: CapabilityToken,
    vault: Arc<VaultService<SqliteVaultStore>>,
    state: SshHostState,
) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();

    // 1) 发 Hello{nonce}
    let mut nonce = [0u8; 32];
    getrandom::getrandom(&mut nonce).map_err(|e| anyhow!("CSPRNG: {e}"))?;
    write_msg(&mut stream, &AgentMessage::Hello { nonce })?;

    // 2) 等 HelloReply{nonce, hmac}
    let reply = read_msg(&mut stream)?;
    let (reply_nonce, hmac) = match reply {
        AgentMessage::HelloReply { nonce: rn, hmac: h } => (rn, h),
        other => return Err(anyhow!("expected HelloReply, got {other:?}")),
    };
    if reply_nonce != nonce {
        return Err(anyhow!("HelloReply nonce mismatch"));
    }
    if !token.verify_hmac(&nonce, &hmac) {
        return Err(anyhow!("HelloReply HMAC verification failed"));
    }
    eprintln!("ssh-agent-host: handshake ok");

    // 3) 推 OpState + PushKeys
    let unlocked = vault.is_unlocked();
    write_msg(&mut stream, &AgentMessage::OpState { unlocked })?;
    let keys = collect_ssh_public_keys(&vault);
    write_msg(&mut stream, &AgentMessage::PushKeys { keys })?;

    // 主循环：阻塞读，每条消息分发。
    stream
        .set_read_timeout(Some(Duration::from_secs(300))) // 5min idle 后断
        .ok();
    loop {
        let msg = match read_msg(&mut stream) {
            Ok(m) => m,
            Err(e) => {
                // EOF / timeout → 退出此 session（agent 会自动重连）
                eprintln!("ssh-agent-host: read end: {e}");
                return Ok(());
            }
        };
        match msg {
            AgentMessage::SignRequest {
                request_id,
                key_blob,
                data,
                flags,
            } => {
                let reply = sign_for_agent(&vault, &key_blob, &data, flags, &state);
                write_msg(
                    &mut stream,
                    &AgentMessage::SignReply {
                        request_id,
                        signature: reply,
                    },
                )?;
            }
            AgentMessage::AuditEntry { entry } => {
                state.push_audit(entry.clone());
                if let Err(e) = persist_audit(&vault, entry) {
                    eprintln!("ssh-agent-host: failed to persist audit: {e}");
                }
            }
            AgentMessage::Bye => {
                eprintln!("ssh-agent-host: agent sent Bye");
                return Ok(());
            }
            other => {
                eprintln!("ssh-agent-host: unexpected message: {other:?}");
            }
        }
    }
}

/// 给 agent 的 sign request 实际做签名 + 审计字段。
fn sign_for_agent(
    vault: &VaultService<SqliteVaultStore>,
    key_blob: &[u8],
    data: &[u8],
    flags: u32,
    state: &SshHostState,
) -> Result<Vec<u8>, String> {
    // vault 锁定状态：拒签 + 记审计
    if !vault.is_unlocked() {
        record_local_audit(vault, key_blob, AuditDecisionWire::VaultLocked, state);
        return Err("vault locked".into());
    }
    // 在 vault 中找匹配 key_blob 的 SSH item
    let item_id = match find_item_id_for_key_blob(vault, key_blob) {
        Some(id) => id,
        None => {
            record_local_audit(vault, key_blob, AuditDecisionWire::KeyNotFound, state);
            return Err("key not found".into());
        }
    };
    // D4：调 sign_with_vault_key 用 ssh-key 签名
    match sign_with_vault_key(vault, &item_id, data, flags) {
        Ok(sig) => {
            record_local_audit(vault, key_blob, AuditDecisionWire::Approved, state);
            Ok(sig)
        }
        Err(e) => {
            let msg = format!("{e}");
            record_local_audit(
                vault,
                key_blob,
                AuditDecisionWire::Error(msg.clone()),
                state,
            );
            Err(msg)
        }
    }
}

/// 提取 vault SSH item 的 public_key wire bytes。
///
/// 支持两种存储形态（reviewer finding #2 修复）：
/// - `FieldValue::Bytes(b)` —— 直接 OpenSSH wire blob（vault 内部创建路径）
/// - `FieldValue::Text(s)` —— OpenSSH 文本公钥 `"ssh-ed25519 AAAA... [comment]"`
///   （JSON 导入路径，spec/13 § 3 把字符串映射成 Text）；用 ssh-key crate 解析
///   为 wire bytes
///
/// **不**支持裸 base64（无算法前缀）形态：JSON 导入路径写入完整 OpenSSH 文本即可
/// 命中路径 A；如果用户存裸 base64 需要在 import.rs 侧规范化。
fn extract_pubkey_bytes(payload: &zpass_vault_format::ItemPayloadV1) -> Option<Vec<u8>> {
    use ssh_encoding::Encode as _;
    use zpass_vault_format::FieldValue;
    match payload.fields.get("public_key") {
        Some(FieldValue::Bytes(b)) => Some(b.clone()),
        Some(FieldValue::Text(s)) => {
            let trimmed = s.trim();
            let pk = trimmed.parse::<ssh_key::PublicKey>().ok()?;
            let mut wire = Vec::new();
            pk.key_data().encode(&mut wire).ok()?;
            Some(wire)
        }
        _ => None,
    }
}

/// 用 OpenSSH 公钥 blob 在 vault 中找对应 SSH item。
fn find_item_id_for_key_blob(
    vault: &VaultService<SqliteVaultStore>,
    blob: &[u8],
) -> Option<String> {
    use zpass_vault_format::ItemType;
    let summaries = vault.list_items().ok()?;
    for s in summaries {
        if s.r#type != ItemType::Ssh {
            continue;
        }
        if let Ok(payload) = vault.get_item(&s.id)
            && let Some(pk) = extract_pubkey_bytes(&payload)
            && pk == blob
        {
            return Some(s.id);
        }
    }
    None
}

/// 收集 vault 中所有 SSH item 作为 PublicKeyEntry 推给 agent。
fn collect_ssh_public_keys(vault: &VaultService<SqliteVaultStore>) -> Vec<PublicKeyEntry> {
    use zpass_vault_format::{FieldValue, ItemType};
    let mut out = Vec::new();
    let Ok(summaries) = vault.list_items() else {
        return out;
    };
    for s in summaries {
        if s.r#type != ItemType::Ssh {
            continue;
        }
        let Ok(payload) = vault.get_item(&s.id) else {
            continue;
        };
        let Some(blob) = extract_pubkey_bytes(&payload) else {
            continue;
        };
        let comment = match payload.fields.get("comment") {
            Some(FieldValue::Text(c)) => c.clone(),
            _ => s.name.clone(),
        };
        out.push(PublicKeyEntry {
            item_id: s.id,
            blob,
            comment,
        });
    }
    out
}

/// GUI 侧自己也记一份审计（避免完全依赖 agent → GUI 这条链路）。
fn record_local_audit(
    vault: &VaultService<SqliteVaultStore>,
    _key_blob: &[u8],
    decision: AuditDecisionWire,
    state: &SshHostState,
) {
    let entry = AuditEntryWire {
        created_at: now_ms(),
        fingerprint: "<unknown>".into(),
        key_comment: "".into(),
        client_pid: None,
        client_exe: None,
        decision,
    };
    state.push_audit(entry.clone());
    let _ = persist_audit(vault, entry);
}

/// 把 AuditEntryWire 落到 vault-format::AuditEntry 的 `{kind, timestamp_ms, details}` 结构。
///
/// vault-format 的 schema 是通用 K/V details map（spec/03 § 3.4）；本函数把 SSH
/// 审计的具体字段塞进 details，kind 固定为 "ssh-sign"。
fn persist_audit(vault: &VaultService<SqliteVaultStore>, e: AuditEntryWire) -> Result<()> {
    let mut details: std::collections::BTreeMap<String, FieldValue> = Default::default();
    details.insert("fingerprint".into(), FieldValue::Text(e.fingerprint));
    if !e.key_comment.is_empty() {
        details.insert("key_comment".into(), FieldValue::Text(e.key_comment));
    }
    if let Some(pid) = e.client_pid {
        details.insert("client_pid".into(), FieldValue::Number(pid as i64));
    }
    if let Some(exe) = e.client_exe {
        details.insert("client_exe".into(), FieldValue::Text(exe));
    }
    details.insert(
        "decision".into(),
        FieldValue::Text(decision_to_str(e.decision)),
    );
    let entry = VaultAuditEntry {
        kind: "ssh-sign".into(),
        timestamp_ms: e.created_at,
        details,
    };
    vault
        .append_audit(entry)
        .map(|_id| ())
        .map_err(|e| anyhow!("append_audit: {e:?}"))
}

fn decision_to_str(d: AuditDecisionWire) -> String {
    match d {
        AuditDecisionWire::Approved => "approved".into(),
        AuditDecisionWire::DeclinedByUser => "declined-by-user".into(),
        AuditDecisionWire::TrustedCache => "trusted-cache".into(),
        AuditDecisionWire::VaultLocked => "vault-locked".into(),
        AuditDecisionWire::KeyNotFound => "key-not-found".into(),
        AuditDecisionWire::Timeout => "timeout".into(),
        AuditDecisionWire::Error(s) => format!("error:{s}"),
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn write_msg(w: &mut impl Write, msg: &AgentMessage) -> Result<()> {
    let bytes = encode_frame(msg).map_err(|e| anyhow!("encode: {e}"))?;
    w.write_all(&bytes).context("write frame")?;
    w.flush().context("flush frame")?;
    Ok(())
}

fn read_msg(r: &mut impl Read) -> Result<AgentMessage> {
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
