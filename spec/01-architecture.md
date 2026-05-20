# 01 — 架构

## 1. 三进程模型

```
┌──────────────────────────────────────────────────────────────────┐
│ 用户桌面（Windows / macOS / Linux）                               │
│                                                                  │
│  ┌────────────────────┐    ┌─────────────────────┐               │
│  │  zpass-desktop     │◄──►│  zpass-agent        │               │
│  │   (GPUI GUI 进程)   │    │  (SSH 守护进程)      │               │
│  │  - 持有 DEK         │    │  - 监听 SSH socket   │               │
│  │  - 浏览器桥 HTTP    │    │  - 控制通道 → GUI    │               │
│  │  - 控制通道 listener │    │  - 无密钥状态        │               │
│  └────────┬───────────┘    └─────────────────────┘               │
│           │                          ▲                           │
│           │ HTTP (loopback + token)  │ Unix socket / Named pipe  │
│           ▼                          │                           │
│  ┌────────────────────┐              │                           │
│  │ zpass-native-host  │  ─stdin/stdout─►  浏览器扩展             │
│  │  (Chrome 桥二进制) │                                          │
│  │  - 无密钥状态       │                                          │
│  └────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────┘
```

三个二进制：

1. **`zpass-desktop`** — GUI 主进程，唯一持有 DEK。GPUI 渲染。
2. **`zpass-agent`** — SSH agent 守护进程，独立长驻，**不**持有 DEK；每次签名请求都通过控制通道询问 GUI。
3. **`zpass-native-host`** — Chrome / Firefox / Edge 的 stdio 「native messaging」host；**不**持有 DEK；把扩展请求通过 token 鉴权的 loopback HTTP 转给 GUI。

> 此拓扑与 Go 版完全对应（`main.go` 主进程 + `cmd/zpass-agent/` + `nativehost_main.go` + `nativebrowserbridge.go`），用户的 SSH agent / 扩展配置文件无需重新生成。

---

## 2. 进程为何这样分

| 进程               | 拆出的硬约束                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `zpass-agent`      | OpenSSH 等客户端通过 `SSH_AUTH_SOCK` 长连接，GUI 可被用户随时关闭；agent 必须能在 GUI 不在的时候至少响应「身份未解锁」                          |
| `zpass-native-host` | Chrome native-messaging 协议要求 host 进程**每次会话都重新拉起**，启动时间敏感（>200 ms 用户感知卡顿）。链 GPUI 会让二进制启动 1 秒级，体验完蛋 |

---

## 3. Workspace 布局

工作区根 `Cargo.toml` 落在**仓库根**（`/`），不是 `desktop_rs/`。这是因为 mobile 端 crate（`zpass-crypto` / `-vault-format` / `-vault-service` / `-otp` / `-passkey`）希望未来被 `phone/` 子项目以 path 形式直接引用，根工作区是最自然的位置。

```
zpass/
├── Cargo.toml                          # [workspace] members = ["crates/*", "desktop_rs/*"]
├── Cargo.lock                          # 提交到 git，所有平台一致
├── crates/
│   ├── zpass-crypto/                   # no_std + alloc；可移动端复用
│   ├── zpass-vault-format/             # no_std + alloc；可移动端复用
│   ├── zpass-vault-store/              # std + rusqlite；桌面
│   ├── zpass-vault-service/            # std；可移动端复用（不依赖 sqlite/trusted-device）
│   ├── zpass-otp/                      # no_std + alloc；可移动端复用
│   ├── zpass-passkey/                  # no_std + alloc；可移动端复用
│   ├── zpass-trusted-device/           # std + winapi（cfg gated）；桌面
│   ├── zpass-ssh-agent-proto/          # std；桌面 / 多端共享协议
│   ├── zpass-browser-bridge/           # std；桌面（GUI 内 HTTP server）
│   ├── zpass-config/                   # std；原子 JSON 读写（桌面）
│   └── zpass-platform/                 # std + 平台 cfg；路径解析等
├── desktop_rs/
│   ├── zpass-desktop/                  # bin: GPUI GUI 主程序
│   ├── zpass-agent/                    # bin: SSH 守护进程
│   └── zpass-native-host/              # bin: 浏览器 stdio 桥
└── spec/                               # 本目录
```

> 当前已存在的 `desktop_rs/Cargo.toml` + `desktop_rs/src/main.rs` 的 single-crate 骨架将在 Phase A 入场时**删除**，重做为上面的多 crate 结构。

---

## 4. Crate 依赖拓扑（必须无环）

```
                                ┌──────────────────────┐
                                │      zpass-crypto     │  no_std + alloc
                                └──────────┬───────────┘
                                           │
              ┌────────────────────────────┼──────────────────────────┐
              │                            │                          │
              ▼                            ▼                          ▼
   ┌──────────────────┐          ┌──────────────────┐        ┌────────────────┐
   │ zpass-vault-     │          │   zpass-otp       │        │ zpass-passkey  │  no_std + alloc
   │   format         │          │                   │        │                │
   └──────┬───────────┘          └──────────────────┘        └────────────────┘
          │                                ▲                          ▲
          ▼                                │                          │
   ┌──────────────────┐                    │                          │
   │ zpass-vault-     │                    │                          │
   │   store (sqlite) │ ──┐                │                          │
   └──────────────────┘   │   ┌────────────┴──────────────────────────┘
                          ▼   │
                   ┌──────────────────────┐
                   │  zpass-vault-service │  std；不依赖 trusted-device / browser-bridge / ssh-agent
                   └──────────┬───────────┘
                              │
        ┌─────────────────────┴───────────────────────────────────────┐
        │                                                             │
        ▼                                                             ▼
   ┌─────────────────────┐                              ┌──────────────────────────┐
   │ zpass-trusted-device│   ┌──────────────────────┐   │  zpass-browser-bridge    │
   │                     │   │ zpass-ssh-agent-proto│   │                          │
   └──────┬──────────────┘   └──────────┬───────────┘   └──────────┬───────────────┘
          │                             │                          │
          │  ┌──────────────────────────┴────────────┐              │
          │  │                                       │              │
          ▼  ▼                                       ▼              │
   ┌──────────────────────┐                  ┌───────────────────┐  │
   │   zpass-desktop      │                  │   zpass-agent     │  │
   │  (GPUI bin)          │ ──────────────►  │   (SSH daemon)    │  │
   └─────────┬────────────┘                  └───────────────────┘  │
             │                                                      │
             └──────────────────────────────────────────────────────┘
                          ▲
                          │
                  ┌───────┴────────────────┐
                  │  zpass-native-host     │  bin（仅依赖 zpass-browser-bridge 的协议类型）
                  └────────────────────────┘
```

**关键约束**（违反即拒绝合并）：

1. `zpass-vault-service` **不** import `zpass-trusted-device`。trusted-device 解锁通过 `VaultService::unlock_with_dek(dek)` 的口径，由桌面层串联（详见 `05-vault-service-api.md` § unlock_with_dek）。
2. `zpass-vault-service` **不** import `zpass-ssh-agent-proto` / `zpass-browser-bridge`。这两者通过 `VaultEventSink` trait 订阅（见 `05a-vault-event-model.md`）。
3. `zpass-native-host` **不** import `gpui` / `zpass-vault-service` / `zpass-vault-store`。仅依赖 `zpass-browser-bridge` 中的协议类型与 HTTP 客户端工具。
4. `zpass-crypto` / `-vault-format` / `-otp` / `-passkey` **不** 使用 `std`（启用 `#![no_std]` + `extern crate alloc`）。允许 dev-dependency 用 std。
5. `zpass-vault-service` 必须能 `cargo check --target armv7-linux-androideabi` 通过（不要求实际运行）。

---

## 5. 与 Go 版本的进程拓扑对照

| Rust 二进制         | Go 对应                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `zpass-desktop`     | `desktop/main.go`（Wails 主进程） + 各 `*service.go`                                  |
| `zpass-agent`       | `desktop/cmd/zpass-agent/`（独立 daemon 二进制）                                      |
| `zpass-native-host` | `desktop/nativehost_main.go`（同包内用 `//go:build nativehost` 切出的二进制）         |

Go 在「同 package 用 build tag 切出第二个 binary」（`!nativehost` / `nativehost`）。Rust 没有等价机制，所以拆为独立 crate；这恰好也满足「二进制小、启动快、零 GPUI 链接」的硬需求。

---

## 6. 异步策略

简短结论：**vault-service / vault-store / crypto / otp / passkey / trusted-device 全部同步**；GPUI 调用走 `cx.background_spawn(...)`；SSH agent 与浏览器桥的网络 IO 放在桌面层用 `std::thread` + `crossbeam-channel`（**不**引入 tokio 到根工作区）。

理由：

- Argon2id 是 CPU + 内存重度阻塞，async 无收益。
- 弱化对 tokio 的暴露面，避免 mobile target 把 tokio 也拉进 build graph。
- GPUI 自己就有 executor，跨整个 binary 用 tokio 会出现两个 executor 互踩。

例外的开放问题（不在 v1 决策）：SSH agent control channel 的 IO 是否本地起一个 tokio runtime（仅在 `zpass-agent` binary 内）？详见 `16-open-questions.md`。

---

## 7. 与 GPUI 的绑定层

`zpass-desktop` 是唯一 import `gpui` 的 crate。所有 vault / OTP / passkey 等业务调用通过**胶水层**（推荐放在 `zpass-desktop/src/services/`）封装为 GPUI 可用的 `Entity<T>` / `Task<T>` 形态。

胶水层只做三件事：

1. 把同步业务调用包到 `cx.background_spawn` 里。
2. 把业务事件订阅（`VaultEventSink`）转换为 GPUI 的 `cx.emit(Event::X)`。
3. 把 GPUI 的 `cx.executor().advance_clock(d)` 用于测试时间相关代码。

---

## 与谁衔接

- 下一篇：[`02-crates.md`](./02-crates.md) —— 每个 crate 的详细责任与依赖
- 相关：[`08-ssh-agent.md`](./08-ssh-agent.md) / [`09-browser-bridge.md`](./09-browser-bridge.md) —— 子进程协议
