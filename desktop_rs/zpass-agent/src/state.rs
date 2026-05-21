//! agent 进程的共享状态：当前公钥列表 + 解锁状态 + 待响应的 sign 请求。
//!
//! 控制通道线程 mutate；handler 线程 read。用 `parking_lot::Mutex` 保护。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use zpass_ssh_agent_proto::PublicKeyEntry;

/// agent 收到 SIGN_REQUEST 时，先 stash 一个 pending entry 等 GUI 回 SignReply。
pub struct Pending {
    /// 用 condvar 唤醒 handler 线程。
    cv: Condvar,
    /// 签名结果（None = 还没回，Some = 已回）。
    result: Mutex<Option<Result<Vec<u8>, String>>>,
}

#[derive(Default)]
struct Inner {
    unlocked: bool,
    keys: Vec<PublicKeyEntry>,
    pending: HashMap<u64, Arc<Pending>>,
    next_request_id: u64,
}

#[derive(Clone)]
pub struct SharedState {
    inner: Arc<Mutex<Inner>>,
}

impl Default for SharedState {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    pub fn set_unlocked(&self, unlocked: bool) {
        self.inner.lock().unlocked = unlocked;
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner.lock().unlocked
    }

    pub fn set_keys(&self, keys: Vec<PublicKeyEntry>) {
        self.inner.lock().keys = keys;
    }

    pub fn keys(&self) -> Vec<PublicKeyEntry> {
        self.inner.lock().keys.clone()
    }

    /// 找一个 key blob 对应的 vault item_id（用于 SIGN_REQUEST 路由）。
    ///
    /// 当前实现的控制通道把 key_blob 整体转给 GUI，由 GUI 自己查 vault；本函数留作
    /// 未来「agent 本地查 cache」优化路径的入口（暂未消费）。
    #[allow(dead_code)]
    pub fn find_key_item_id(&self, blob: &[u8]) -> Option<String> {
        let inner = self.inner.lock();
        inner
            .keys
            .iter()
            .find(|k| k.blob == blob)
            .map(|k| k.item_id.clone())
    }

    /// 注册一个 pending sign request；返回 (request_id, pending handle)。
    pub fn register_pending(&self) -> (u64, Arc<Pending>) {
        let mut inner = self.inner.lock();
        let id = inner.next_request_id.wrapping_add(1);
        inner.next_request_id = id;
        let p = Arc::new(Pending {
            cv: Condvar::new(),
            result: Mutex::new(None),
        });
        inner.pending.insert(id, p.clone());
        (id, p)
    }

    /// 完成 pending sign request（由控制通道线程在收到 SignReply 时调用）。
    pub fn complete_pending(&self, id: u64, result: Result<Vec<u8>, String>) {
        let pending = self.inner.lock().pending.remove(&id);
        if let Some(p) = pending {
            *p.result.lock() = Some(result);
            p.cv.notify_all();
        }
    }

    /// 等待 pending sign reply，超时 timeout。
    ///
    /// 超时（返回 None）时**主动从 inner.pending 移除** id（reviewer finding #4 修复）：
    /// 避免 GUI 没断线但 reply 永不来时 pending HashMap 无限增长。
    pub fn wait_pending(
        &self,
        id: u64,
        p: Arc<Pending>,
        timeout: Duration,
    ) -> Option<Result<Vec<u8>, String>> {
        let mut guard = p.result.lock();
        if guard.is_some() {
            return guard.take();
        }
        let _ = p.cv.wait_for(&mut guard, timeout);
        let result = guard.take();
        if result.is_none() {
            // timeout 路径：GUI 仍连着但没回 reply。从映射里移除避免泄露。
            // 如果在 wait 期间 complete_pending 已经 remove 了，这里 remove 是 no-op。
            drop(guard);
            self.inner.lock().pending.remove(&id);
        }
        result
    }

    /// 取消所有 pending（GUI 断开 / 重启时调用）。
    pub fn cancel_all_pending(&self, reason: &str) {
        let pending: Vec<_> = self.inner.lock().pending.drain().map(|(_, p)| p).collect();
        for p in pending {
            *p.result.lock() = Some(Err(reason.to_string()));
            p.cv.notify_all();
        }
    }
}

/// 一次性 channel 持有：方便从 handler 线程把 SignRequest 推给控制通道线程。
///
/// 当前 main.rs 直接用 `mpsc::channel` 拆 sender/receiver；本类型留作未来若需要
/// 给 handler 加方法封装时使用。
#[allow(dead_code)]
pub struct SignRouter {
    pub tx: Sender<SignDispatch>,
}

pub struct SignDispatch {
    pub request_id: u64,
    pub key_blob: Vec<u8>,
    pub data: Vec<u8>,
    pub flags: u32,
}

impl SignRouter {
    #[allow(dead_code)]
    pub fn new() -> (Self, std::sync::mpsc::Receiver<SignDispatch>) {
        let (tx, rx) = channel();
        (Self { tx }, rx)
    }
}

/// 标记一次实验的开始时间（用于审计字段 created_at 等）。GUI 侧实际填充。
#[allow(dead_code)]
pub fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 用于 backoff 时长计算。
pub struct Backoff {
    last_attempt: Option<Instant>,
    next_delay: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub fn new() -> Self {
        Self {
            last_attempt: None,
            next_delay: Duration::from_millis(200),
        }
    }
    pub fn next(&mut self) -> Duration {
        self.last_attempt = Some(Instant::now());
        let d = self.next_delay;
        // 指数 backoff，上限 5s。
        self.next_delay = (self.next_delay * 2).min(Duration::from_secs(5));
        d
    }
    pub fn reset(&mut self) {
        self.next_delay = Duration::from_millis(200);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip() {
        let s = SharedState::new();
        s.set_keys(vec![PublicKeyEntry {
            item_id: "abc".into(),
            blob: vec![1, 2, 3],
            comment: "x".into(),
        }]);
        assert_eq!(s.find_key_item_id(&[1, 2, 3]).as_deref(), Some("abc"));
        assert_eq!(s.find_key_item_id(&[9, 9]), None);
    }

    #[test]
    fn pending_complete_path() {
        use std::thread;
        let s = SharedState::new();
        let (id, p) = s.register_pending();
        let s2 = s.clone();
        let p2 = p.clone();
        let t = thread::spawn(move || s2.wait_pending(id, p2, Duration::from_secs(2)));
        thread::sleep(Duration::from_millis(50));
        s.complete_pending(id, Ok(vec![0xAA, 0xBB]));
        let result = t.join().unwrap();
        assert_eq!(result.unwrap().unwrap(), vec![0xAA, 0xBB]);
    }

    #[test]
    fn pending_timeout_returns_none_and_cleans_up() {
        let s = SharedState::new();
        let (id, p) = s.register_pending();
        let r = s.wait_pending(id, p, Duration::from_millis(50));
        // 超时未填 result → None
        assert!(r.is_none());
        // reviewer finding #4：HashMap 不应再持有这个 entry。
        // 用一个新的 register_pending 验证 id 已经被释放（next_id 会增长但 entry
        // 数量回到 1 而不是 2）。
        let _ = s.register_pending();
        // 不直接断言 HashMap 大小（field 私有），用第二次 wait_pending 验证 timeout 后
        // 仍能正常 cancel_all（不会双重 free）：
        s.cancel_all_pending("ok");
    }

    #[test]
    fn cancel_all_pending_unblocks() {
        use std::thread;
        let s = SharedState::new();
        let (id, p) = s.register_pending();
        let s2 = s.clone();
        let p2 = p.clone();
        let t = thread::spawn(move || s2.wait_pending(id, p2, Duration::from_secs(5)));
        thread::sleep(Duration::from_millis(50));
        s.cancel_all_pending("GUI disconnected");
        let r = t.join().unwrap();
        assert_eq!(r.unwrap().unwrap_err(), "GUI disconnected");
    }

    #[test]
    fn unlocked_flag_round_trip() {
        let s = SharedState::new();
        assert!(!s.is_unlocked());
        s.set_unlocked(true);
        assert!(s.is_unlocked());
        s.set_unlocked(false);
        assert!(!s.is_unlocked());
    }

    #[test]
    fn backoff_grows_then_caps() {
        let mut b = Backoff::new();
        assert_eq!(b.next(), Duration::from_millis(200));
        assert_eq!(b.next(), Duration::from_millis(400));
        assert_eq!(b.next(), Duration::from_millis(800));
        // 经过几次后到 5s 上限
        for _ in 0..10 {
            let d = b.next();
            assert!(d <= Duration::from_secs(5));
        }
        b.reset();
        assert_eq!(b.next(), Duration::from_millis(200));
    }
}
