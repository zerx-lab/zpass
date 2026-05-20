# 05a — VaultEventSink：事件总线

## 1. 解决的问题

Go 版本 `VaultService` 内部硬编码了两个 side-channel hook：

```go
// desktop/vaultservice.go:347
sshAgentNotifier SshAgentNotifier   // interface{ NotifyVaultUnlocked / NotifyVaultLocked / PushVaultKeys }

// desktop/vaultservice.go:355
emit func(event string, payload any)   // 给前端发 vault.*事件
```

这两条机制在 Rust 重写时不能照搬：

- 移动端没有 SSH agent 也没有 Wails event；vault-service 必须能在 mobile 编译。
- 「String 化的 event name + `any` payload」反序列化代价高、类型不安全。

---

## 2. 设计

引入一个**类型化** trait，所有订阅者实现它：

```rust
// crates/zpass-vault-service/src/events.rs

pub trait VaultEventSink: Send + Sync {
    fn on_event(&self, event: &VaultEvent);
}

#[derive(Debug, Clone)]
pub enum VaultEvent {
    Initialized,
    Unlocked,
    Locked,
    MasterPasswordChanged,
    ItemCreated { id: String, item_type: ItemType },
    ItemUpdated { id: String, item_type: ItemType },
    ItemDeleted { id: String },
    TrustedDeviceEnabled,
    TrustedDeviceDisabled,
    SshKeyDecryptedForSigning { item_id: String },  // 给审计用
}
```

`VaultService::new()` 接收 `Vec<Box<dyn VaultEventSink>>`，**每次发事件**遍历所有 sink 调用 `on_event`。

```rust
impl<S: VaultStore> VaultService<S> {
    pub fn new(store: S, sinks: Vec<Box<dyn VaultEventSink>>) -> Self {
        // ...
    }
}
```

---

## 3. 调用契约

### 3.1 同步 / 异步

- `on_event` 是**同步**调用，**在持有 vault 锁的情况下**触发。
- sink 实现**必须**在内部立即返回（< 100 µs 量级），重活下沉到自己的 goroutine / std::thread。

```rust
// 反例 — sink 内部调回 vault_service.list_items() 会死锁
impl VaultEventSink for SshAgentSink {
    fn on_event(&self, event: &VaultEvent) {
        match event {
            VaultEvent::Unlocked => {
                // ❌ 此处 vault 锁仍被持有；list_items 会自旋等永远拿不到
                let items = self.vault.list_items().unwrap();
                self.push_to_agent(items);
            }
            _ => {}
        }
    }
}

// 正例 — 把事件丢进自己的队列，自己线程消费
impl VaultEventSink for SshAgentSink {
    fn on_event(&self, event: &VaultEvent) {
        let _ = self.event_tx.try_send(event.clone());
    }
}
```

> 这是与 Go `SshAgentNotifier` 设计文档（`desktop/vaultservice.go:370-377` 注释）相同的契约：「实现必须异步处理，发现需要取 vault 数据时启 goroutine」。

### 3.2 错误处理

`on_event` 没有返回值。sink 内部如发生错误：

- 自己记录日志（用桌面层注入的 logger，不要 `eprintln!`）。
- 不应 panic；vault-service 在调用 `on_event` 时**用 `catch_unwind`** 兜底（避免单 sink panic 把整条 vault 写路径炸掉）。

```rust
// crates/zpass-vault-service/src/events.rs
pub(crate) fn emit_safe(sinks: &[Box<dyn VaultEventSink>], event: &VaultEvent) {
    for sink in sinks {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sink.on_event(event);
        }));
    }
}
```

#### 关于 `catch_unwind` 与锁的安全性

`emit_safe` 通常在 VaultService 持有写锁 / 读锁的临界区**末尾**调用（事件代表「状态变更已完成」）。

需要明确：

1. **lock guard 不会泄漏**：即便 sink panic 被 `catch_unwind` 捕获，Rust 的栈展开 + drop 顺序仍会让 `RwLockWriteGuard` 在它的作用域终止时释放，**不**留下死锁。`parking_lot` 锁不 poisoning，下次正常 `write()` 即可获得。
2. **不要把 `emit_safe` 调用挪到锁外**：把它挪到锁外会破坏「事件代表当前已落盘状态」的契约 —— 在 emit 和锁释放之间，其它写者可能介入，让订阅者看到的「世界」与事件不一致。
3. **sink 内部仍**不能**调回 vault**（已通过本文 § 3.1 反例说明）。这一条不依赖 `catch_unwind`，纯粹是锁不可重入的约束。

---

## 4. v1 的 sink 实现位置

| sink 实现                              | 落在哪 crate                           | 订阅的事件                                                                          |
| -------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `SshAgentSink`                         | `zpass-desktop` 的 `services` 模块     | `Unlocked` / `Locked` / `ItemCreated{type=Ssh}` / `ItemUpdated{type=Ssh}` / `ItemDeleted` / `MasterPasswordChanged` |
| `BrowserBridgeSink`                    | `zpass-desktop` 的 `services` 模块     | `Locked` / `Unlocked`（让浏览器扩展 popup 状态同步）                                |
| `GpuiEventSink`                        | `zpass-desktop` 的 `services` 模块     | 所有事件 → 转成 GPUI 内部 `cx.emit(...)` 给 UI 订阅                                 |
| `AuditSink`                            | `zpass-desktop` 的 `services` 模块     | `SshKeyDecryptedForSigning` / `Unlocked` / `Locked` 等需要审计的事件                |

> 全部落在 `zpass-desktop`。`zpass-vault-service` 本身只定义 trait，不实现任何 sink。这是 mobile 复用的关键 —— mobile 上桌面层不存在，但 vault 仍可用 `Vec::new()`（空 sink 列表）正常工作。

---

## 5. 与 Go 行为的映射

| Go 调用                                              | Rust event                                       |
| ---------------------------------------------------- | ------------------------------------------------ |
| `s.notifySshAgentSafe(\|n\| n.NotifyVaultUnlocked())` | `VaultEvent::Unlocked`                           |
| `s.notifySshAgentSafe(\|n\| n.NotifyVaultLocked())`   | `VaultEvent::Locked`                             |
| `s.emit("vault:itemCreated", payload)`               | `VaultEvent::ItemCreated { ... }`                |
| `s.emit("vault:itemUpdated", payload)`               | `VaultEvent::ItemUpdated { ... }`                |
| `s.emit("vault:itemDeleted", id)`                    | `VaultEvent::ItemDeleted { ... }`                |

---

## 6. 测试

在 `crates/zpass-vault-service/tests/events.rs`：

```rust
struct CapturingSink {
    captured: Arc<Mutex<Vec<VaultEvent>>>,
}
impl VaultEventSink for CapturingSink {
    fn on_event(&self, e: &VaultEvent) {
        self.captured.lock().unwrap().push(e.clone());
    }
}

#[test]
fn initialize_emits_unlocked() {
    let captured = Arc::new(Mutex::new(vec![]));
    let sink = Box::new(CapturingSink { captured: captured.clone() });
    let vault = VaultService::new(in_memory_store(), vec![sink]);
    vault.initialize("correct horse battery staple").unwrap();
    let events = captured.lock().unwrap();
    assert!(matches!(events[0], VaultEvent::Initialized));
    assert!(matches!(events[1], VaultEvent::Unlocked));
}
```

panic 兜底测试：

```rust
struct PanickingSink;
impl VaultEventSink for PanickingSink {
    fn on_event(&self, _: &VaultEvent) { panic!("intentional"); }
}

#[test]
fn vault_survives_panicking_sink() {
    let vault = VaultService::new(in_memory_store(), vec![Box::new(PanickingSink)]);
    vault.initialize("password 1234").unwrap();   // 不应整体崩溃
    assert!(vault.is_unlocked());
}
```

---

## 7. 与谁衔接

- 上一篇：[`05-vault-service-api.md`](./05-vault-service-api.md)
- 下一篇：[`06-otp.md`](./06-otp.md)
- 相关：[`08-ssh-agent.md`](./08-ssh-agent.md) / [`09-browser-bridge.md`](./09-browser-bridge.md) —— sink 的具体使用
