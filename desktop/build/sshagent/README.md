# ZPass SSH Agent —— 系统服务集成模板

本目录包含 SSH agent 守护进程的系统服务集成模板，让 `zpass-agent` 能与 GUI 解耦、由 OS 服务管理器接管生命周期。

## 文件清单

| 文件 | 平台 | 用途 |
|---|---|---|
| `zpass-agent.service` | Linux | systemd user unit |
| `zpass-agent.socket` | Linux | systemd socket activation（关键，让空闲时 0 内存）|
| `com.zpass.agent.plist` | macOS | LaunchAgent plist |
| Windows | — | 暂用 Scheduled Task at login（未来加 .xml 模板）|

## 当前架构（MVP-2）

ZPass GUI 启用 SSH agent 服务时，会**自动 fork zpass-agent 子进程**（见 `sshagentsupervisor.go`）。这是最简单的部署方式，用户无需手动操作：

```
ZPass GUI (Wails 应用) 进程
├─ 监听控制通道 control.sock
└─ fork 子进程：
   └─ zpass-agent
      ├─ 监听 SSH agent socket agent.sock
      └─ 连接 control.sock 与 GUI 通信
```

**缺点**：关闭 GUI = agent 退出 = `ssh / git` 无法签名。

## 服务化部署（v3+ 推荐）

未来用户可以让 OS 服务管理器接管 agent，让 agent 独立于 GUI 存活：

```
                       systemd / launchd / Task Scheduler
                                    │
                          管理 zpass-agent 进程
                                    │
                                    ▼
                              zpass-agent ──── 监听 agent.sock（ssh/git 用）
                                    │
                                    ▼ 连接 control.sock
                              ZPass GUI（按需启动）
```

### Linux：systemd socket activation

```bash
# 1. 复制模板到 user systemd 配置目录
mkdir -p ~/.config/systemd/user
cp build/sshagent/zpass-agent.service ~/.config/systemd/user/
cp build/sshagent/zpass-agent.socket  ~/.config/systemd/user/

# 2. 修改 .service 里的 ExecStart 路径
#    指向已安装的 zpass-agent binary

# 3. 启用
systemctl --user daemon-reload
systemctl --user enable --now zpass-agent.socket

# 4. 配置 SSH 客户端
echo 'export SSH_AUTH_SOCK="$XDG_RUNTIME_DIR/zpass/agent.sock"' >> ~/.bashrc
```

**收益**：
- agent 进程只在第一个 ssh 连接时启动（socket activation）
- 空闲时 zpass-agent 进程不存在 → **0 MB 内存**
- systemd 自动重启崩溃的 agent

### macOS：LaunchAgent

```bash
# 1. 复制模板到 ~/Library/LaunchAgents/
cp build/sshagent/com.zpass.agent.plist ~/Library/LaunchAgents/

# 2. 修改 plist 里的 ProgramArguments 路径

# 3. 启用
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zpass.agent.plist
launchctl enable gui/$(id -u)/com.zpass.agent

# 4. 配置 SSH 客户端
echo 'export SSH_AUTH_SOCK="$HOME/Library/Application Support/ZPass/agent.sock"' >> ~/.zshrc
```

### Windows：Scheduled Task at login

```powershell
# 用 schtasks 命令注册任务：登录时启动 zpass-agent.exe
schtasks /create /tn "ZPass SSH Agent" `
  /tr "C:\Program Files\ZPass\zpass-agent.exe" `
  /sc onlogon /rl limited

# Scheduled Task 不支持 socket activation —— 进程常驻 ~10MB 内存
# 是当前在 Windows 上能达到的最优解
```

## 与 GUI 端的协调

无论 agent 是「GUI 子进程」还是「OS 服务」，控制通道协议是同一份。GUI 端 `SshAgentService.Enable()` 会：

1. **优先**：拉起子进程（MVP-2 默认）
2. **TODO v3+**：检测 systemd/launchd 是否已经管理 agent → 不重复 fork，直接等 agent 连进控制通道

## 安全注意

- 所有模板默认绑定到 **per-user**（user systemd unit / LaunchAgent / 当前用户 Scheduled Task），不要装到 system-wide
- `zpass-agent` 不需要 root / SYSTEM 权限
- capability token `~/.config/zpass/agent.cap` 权限严格保持 0600 不被其它用户读取

## 卸载

### Linux

```bash
systemctl --user disable --now zpass-agent.socket
rm ~/.config/systemd/user/zpass-agent.{service,socket}
systemctl --user daemon-reload
```

### macOS

```bash
launchctl bootout gui/$(id -u)/com.zpass.agent
rm ~/Library/LaunchAgents/com.zpass.agent.plist
```

### Windows

```powershell
schtasks /delete /tn "ZPass SSH Agent" /f
```
