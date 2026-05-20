//! GUI 侧 SSH host 的运行时状态。
//!
//! - `enabled`：用户在 settings 屏的开关；false 时 host 线程不启动 / 关闭。
//! - 暂存 agent 推过来的最近一批 AuditEntry，方便 UI 显示。

use std::sync::Arc;

use parking_lot::Mutex;
use zpass_ssh_agent_proto::AuditEntryWire;

/// host 线程与 UI 共享的状态。
#[derive(Clone, Default)]
pub struct SshHostState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    enabled: bool,
    /// 最近 N 条审计（ring buffer；正式存储在 vault DB）。
    recent_audit: Vec<AuditEntryWire>,
    /// 是否有 agent 当前连着。
    agent_connected: bool,
}

const RECENT_AUDIT_CAP: usize = 50;

impl SshHostState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_enabled(&self, v: bool) {
        self.inner.lock().enabled = v;
    }
    pub fn is_enabled(&self) -> bool {
        self.inner.lock().enabled
    }

    pub fn set_agent_connected(&self, v: bool) {
        self.inner.lock().agent_connected = v;
    }
    pub fn is_agent_connected(&self) -> bool {
        self.inner.lock().agent_connected
    }

    pub fn push_audit(&self, e: AuditEntryWire) {
        let mut inner = self.inner.lock();
        inner.recent_audit.push(e);
        let len = inner.recent_audit.len();
        if len > RECENT_AUDIT_CAP {
            inner.recent_audit.drain(0..(len - RECENT_AUDIT_CAP));
        }
    }

    pub fn recent_audit(&self) -> Vec<AuditEntryWire> {
        self.inner.lock().recent_audit.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zpass_ssh_agent_proto::AuditDecisionWire;

    fn entry(i: i64) -> AuditEntryWire {
        AuditEntryWire {
            created_at: i,
            fingerprint: format!("SHA256:{i}"),
            key_comment: "".into(),
            client_pid: None,
            client_exe: None,
            decision: AuditDecisionWire::Approved,
        }
    }

    #[test]
    fn enabled_round_trip() {
        let s = SshHostState::new();
        assert!(!s.is_enabled());
        s.set_enabled(true);
        assert!(s.is_enabled());
    }

    #[test]
    fn audit_ring_caps_at_50() {
        let s = SshHostState::new();
        for i in 0..60 {
            s.push_audit(entry(i));
        }
        let r = s.recent_audit();
        assert_eq!(r.len(), 50);
        // 最早 10 条被丢弃
        assert_eq!(r[0].created_at, 10);
        assert_eq!(r[49].created_at, 59);
    }

    #[test]
    fn agent_connected_round_trip() {
        let s = SshHostState::new();
        assert!(!s.is_agent_connected());
        s.set_agent_connected(true);
        assert!(s.is_agent_connected());
        s.set_agent_connected(false);
        assert!(!s.is_agent_connected());
    }
}
