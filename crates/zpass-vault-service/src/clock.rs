//! 单调时钟抽象。`SystemClock` 用于生产，`MockClock` 用于测试。

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// 测试用：可设置 / 推进的时钟。
pub struct MockClock {
    inner: AtomicI64,
}

impl MockClock {
    pub fn new(start_ms: i64) -> Self {
        Self {
            inner: AtomicI64::new(start_ms),
        }
    }
    pub fn set(&self, ms: i64) {
        self.inner.store(ms, Ordering::SeqCst);
    }
    pub fn advance(&self, ms: i64) {
        self.inner.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for MockClock {
    fn now_ms(&self) -> i64 {
        self.inner.load(Ordering::SeqCst)
    }
}
