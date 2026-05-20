# 12 — 测试策略

## 1. 总原则（参考 Zed）

借鉴 Zed 的下列 pattern：

- 每个 crate 都有 `#[cfg(test)]` 子模块 + `tests/` 集成测试目录。
- UI 测试统一走 `#[gpui::test]` + `TestAppContext`，**headless 可跑**，不要求 GPU。
- 时间相关代码用 `cx.executor().advance_clock(duration)` 推进，禁止 `std::thread::sleep` 出现在测试代码。
- 性能不敏感的随机性走 `seedable` rng，固定种子保证可复现。
- 覆盖率指标按 crate 类别区分（见本文 § 6）。

---

## 2. 必须移植的 Go 回归用例（Phase A 出场门槛）

`desktop/vaultservice_test.go`（1056 行，文件头自述「26 用例」覆盖了 vault 的关键回归）。下表区分两类用例：**直接移植**自 Go 已存在的命名测试函数（行 1–9），与**Rust 新增**的安全 / 一致性回归（行 10–13，部分以 Go 测试文件头的设计目标为参照，但 Go 当前 test 套件里**不是独立 named test**，所以视为新增）。

Phase A 退场前每一项都必须有等价 Rust 测试且通过。

### 2.1 直接移植自 Go 命名测试（9 条）

| #   | Rust 测试名                                       | 对应 Go 测试函数                                                                   |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | `test_status_before_init`                         | `TestStatus_BeforeInit`：首次启动，`initialized=false, unlocked=false, item_count=0` |
| 2   | `test_initialize_happy_path`                      | `TestInitialize_HappyPath`：Initialize 后立刻处于 unlocked 态，可读写              |
| 3   | `test_initialize_already_initialized`             | `TestInitialize_AlreadyInitialized`：重复 Initialize → 错误                        |
| 4   | `test_initialize_weak_password`                   | `TestInitialize_WeakPassword`：< 8 字符密码 → 错误                                  |
| 5   | `test_lock_wipes_dek`                             | `TestLock_WipesDEK`：Lock 后所有需要 DEK 的方法返回 `VaultError::Locked`           |
| 6   | `test_lock_idempotent`                            | `TestLock_Idempotent`：连续两次 Lock 不报错                                        |
| 7   | `test_unlock_wrong_password`                      | `TestUnlock_WrongPassword`：错密码 → `InvalidPassword`，不清空 DEK                  |
| 8   | `test_unlock_correct_password`                    | `TestUnlock_CorrectPassword`：正确密码恢复解锁态，原有 item 可读                   |
| 9   | `test_change_master_password_dek_preserved`       | `TestChangeMasterPassword_*`：改密后旧密码失败、新密码成功、**已有 item 仍可解密** |

### 2.2 Rust 新增回归用例（Go 测试套件中无独立同名测试）

| #   | Rust 测试名                                       | 安全 / 一致性目标                                                                  |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 10  | `test_aead_anti_swap`                             | AEAD 防搬移：手工把 item A 的 payload 写到 item B 的行，解密应失败（aad = id 校验）|
| 11  | `test_restart_survives`                           | 重启进程（重 Open DB + 新建 VaultService）仍能用同密码解锁，item 可读              |
| 12  | `test_no_plaintext_leakage`                       | DB 中除 id / 时间戳外无任何明文元数据（Go 文件头描述为「`TestDB_NoPlaintextLeakage`」的设计目标） |
| 13  | `test_now_ms_strictly_monotonic_within_ms`        | 同一毫秒内连续 100 次 `now_ms()`，每次结果 > 前一次                                |
| 14  | `test_now_ms_handles_clock_rollback`              | 模拟时钟回拨，`now_ms()` 仍严格递增                                                |
| 15  | `test_unlock_with_dek_verifies`                   | 传入正确 DEK 成功；传入错误 DEK（32 bytes 任意垃圾）返回 `InvalidPassword`         |
| 16  | `test_event_sink_panic_does_not_crash`            | sink panic 不影响 vault 主路径（与 `05a-vault-event-model.md` § 6 一致）           |

---

## 3. crate 级测试分布

| crate                  | 单元测试目录            | 集成测试目录                          | 重点                                            |
| ---------------------- | ----------------------- | ------------------------------------- | ----------------------------------------------- |
| `zpass-crypto`         | `src/**/*.rs` `#[cfg(test)]` | `tests/`                              | KDF / AEAD 标准向量、参数 validate、零化         |
| `zpass-vault-format`   | 内部                    | `tests/cbor_round_trip.rs`            | CBOR 编解码 round-trip、AAD 常量稳定性          |
| `zpass-vault-store`    | 内部                    | `tests/sqlite_schema.rs`              | schema 初始化、migration、约束                  |
| `zpass-vault-service`  | 内部                    | `tests/regression.rs`（移植 Go 12 用例） | 上述 § 2 所有用例                                |
| `zpass-otp`            | 内部                    | `tests/rfc_vectors.rs`                | RFC 4226 / 6238 / Steam 标准向量                |
| `zpass-passkey`        | 内部                    | `tests/webauthn_register_sign.rs`     | COSE 编解码、签名 verify                        |
| `zpass-trusted-device` | 内部（仅 windows）      | `tests/dpapi_round_trip.rs`           | DPAPI round-trip、wrong entropy 拒绝             |
| `zpass-ssh-agent-proto`| 内部                    | `tests/proto.rs`                      | 帧解析、HMAC 验证                                |
| `zpass-browser-bridge` | 内部                    | `tests/protocol.rs` `tests/domain.rs` | 鉴权恒定时间、域名匹配、黑名单                  |
| `zpass-config`         | 内部                    | `tests/atomic_write.rs`               | 写到一半 kill 测试（用 tempfile）               |
| `zpass-desktop`        | 内部                    | `tests/screens.rs`（`#[gpui::test]`） | 屏幕渲染 / 输入流 / 主题切换                    |
| `zpass-agent` bin      | 内部                    | `tests/sign_flow.rs`                   | 与 mock GUI 控制通道完整签名 round-trip          |
| `zpass-native-host` bin | 内部                   | `tests/forwarding.rs`                  | 帧格式 / 转发 / GUI 离线错误                     |

---

## 4. 关键测试范式

### 4.1 GPUI 测试

```rust
use gpui::TestAppContext;

#[gpui::test]
async fn welcome_screen_renders(cx: &mut TestAppContext) {
    let workspace = cx.add_window(|cx| Workspace::test_new(cx));
    workspace.update(cx, |w, cx| {
        let view = w.show_welcome(cx);
        assert!(view.read(cx).visible_buttons().contains("Create vault"));
    });
}
```

时间推进：

```rust
#[gpui::test]
async fn lock_after_idle_timeout(cx: &mut TestAppContext) {
    // ... set lock_timeout = 5 minutes
    cx.executor().advance_clock(Duration::from_secs(5 * 60 + 1));
    cx.run_until_parked();
    assert!(!app_state.vault.is_unlocked());
}
```

### 4.2 弱 KDF 注入

不开 cargo feature。`zpass-vault-service` 在集成测试中直接构造低参数的 `Argon2idParams`：

```rust
// crates/zpass-vault-service/tests/regression.rs
fn test_argon2id_params() -> Argon2idParams {
    Argon2idParams { memory_kib: 8 * 1024, iterations: 1, parallelism: 1, key_len: 32 }
}

fn setup_vault_with_weak_kdf(/* ... */) -> VaultService<InMemoryStore> {
    // 通过私有 ctor 注入 params；或 vault-service 提供 #[cfg(test)] new_with_params
}
```

> 关键约束：`new_with_params` 必须 `#[cfg(test)] pub fn`，不允许在 production 代码路径调到。详见 `04-crypto-contract.md` § 7。

### 4.3 In-memory store

```rust
// crates/zpass-vault-store/src/memory.rs（feature = "in-memory"，dev-dependency 视角）
pub struct InMemoryStore { /* 用 RwLock<HashMap> 模拟所有表 */ }
impl VaultStore for InMemoryStore { /* ... */ }
```

让 vault-service 集成测试避免每次 cargo test 都开 SQLite 文件。

### 4.4 时钟可控

```rust
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}
pub struct SystemClock;
pub struct MockClock { time: AtomicI64 }
```

`VaultService::new_with_clock(store, sinks, clock)` —— 仅 `#[cfg(test)] pub`。

---

## 5. 性能基线（仅信息性，非门槛）

在 release 模式 + i7-12700H：

| 操作                                  | 期望耗时                                  |
| ------------------------------------- | ----------------------------------------- |
| `unlock`（默认 Argon2id 参数）        | 200–400 ms                                |
| `unlock`（test 弱参数）               | < 5 ms                                    |
| `list_items`（1000 条 login）         | < 30 ms                                   |
| `create_item`                         | < 5 ms                                    |
| `change_master_password`              | 与 unlock 同量级                          |

UI 性能不在 spec 范围；GPUI 自带 frame profiler，Phase G 再调。

---

## 6. 覆盖率目标

| 类别                              | 目标行覆盖率 |
| --------------------------------- | ------------ |
| `zpass-crypto`                    | ≥ 90%        |
| `zpass-vault-format`              | ≥ 90%        |
| `zpass-vault-store`               | ≥ 85%        |
| `zpass-vault-service`             | ≥ 85%        |
| `zpass-otp` / `zpass-passkey`     | ≥ 85%        |
| `zpass-ssh-agent-proto`           | ≥ 80%        |
| `zpass-browser-bridge`            | ≥ 75%        |
| `zpass-desktop`（UI）             | ≥ 65%（GPUI 测试覆盖屏幕主路径即可） |
| 各 bin 的 main                    | best-effort  |

工具：`cargo llvm-cov`（无需 nightly）。CI 跑非 Windows 平台收集覆盖率即可（DPAPI 模块覆盖在 Windows runner）。

---

## 7. CI 流水线（最小集）

```yaml
jobs:
  fmt:           # cargo fmt --all -- --check
  clippy:        # cargo clippy --workspace --all-targets -- -D warnings
  test-linux:    # cargo test --workspace
  test-macos:    # 同上
  test-windows-dpapi:  # cargo test -p zpass-trusted-device -p zpass-vault-service -p zpass-vault-store
  no-std-check:  # cargo check -p zpass-crypto -p zpass-vault-format -p zpass-otp -p zpass-passkey --target thumbv7em-none-eabihf --no-default-features
  i18n-lint:    # check en.json + zh.json key 集合相等
  tokens-sync:   # python scripts/sync-tokens.py --check
```

> Phase A 即接通 fmt / clippy / test-linux / no-std-check 四条。

**关于 Windows CI runner**：

- 默认用 GitHub Actions `windows-latest`（Server 2022），有可用 Direct3D 11 软件渲染器。GPUI `TestAppContext` 在该 runner 上**理论上**可跑（与 Zed 主仓库 CI 一致），但出于稳定性，CI 上 Windows 任务仅跑**与 DPAPI 强相关**的 crate（`zpass-trusted-device`、`zpass-vault-store` 的 trusted_device 路径、`zpass-vault-service` 的 `unlock_with_dek`）。
- `zpass-desktop` 的 `#[gpui::test]` 集成测试只在 `test-linux` / `test-macos` 跑（这两个 runner 有 GPU 或软件后端，Zed 自己也用同样配置）。
- 如未来 Zed CI 转用其它 Windows GPU runner，本规划同步调整。

---

## 8. 与谁衔接

- 上一篇：[`11-gpui-ui-architecture.md`](./11-gpui-ui-architecture.md)
- 下一篇：[`13-migration-checklist.md`](./13-migration-checklist.md)
- 相关：[`14-build-and-validation.md`](./14-build-and-validation.md) —— 命令清单
