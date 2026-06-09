# Changelog · 更新日志（HarmonyOS 端）

This changelog tracks user-facing changes of the ZPass HarmonyOS client.
Sections mirror the website changelog (conventional commits → git-cliff), and entries are bilingual.

本文件记录 ZPass HarmonyOS 客户端面向用户的功能变化。分组方式对齐官网更新日志（约定式提交 → git-cliff），条目中英双语。

## [Unreleased]

### Features · 新功能

- **App protection settings** — three independent switches under a new "App Protection" group, all stored on-device and excluded from sync.
  **应用保护设置** —— 全新「应用保护」分组下的三个独立开关，均保存在本机、不参与同步。
  - **Background blur protection** — masks the UI when the app goes to the background so multitask cards / previews don't leak vault contents; auto-restores on return. No system permission required.
    **后台模糊保护** —— 切到后台时遮挡界面，多任务卡片 / 预览不泄露保险库内容；回到前台自动恢复。无需任何系统权限。
  - **Anti-peep protection** — turns on window privacy mode to block screenshots and screen recording, effective immediately in the foreground. Relies on the system-level privacy-window permission; silently degrades under third-party signing.
    **防窥保护** —— 开启窗口隐私模式，阻止截屏与录屏，前台即时生效。依赖系统级隐私窗口权限；三方签名下静默降级。
  - **Lock on background** — locks the vault the moment you leave the app; works together with trusted-device unlock.
    **切到后台锁定** —— 离开 App 即刻锁定保险库；与受信任设备解锁兼容。

### Changed · 优化

- **Reorganized the "Me" tab** into Spaces / App Protection / Sync / Appearance & Interaction / Data Management / About, aligning with mainstream password managers. Security items are split from sync, and appearance + interaction are merged.
  **重构「我的」页分组** 为 空间 / 应用保护 / 同步 / 外观与交互 / 数据管理 / 关于，对齐主流密码管理器；安全项与同步拆分，外观与交互合并。

### Removed · 移除

- **Item statistics** — removed the per-type item-count section from the "Me" tab.
  **条目统计** —— 移除「我的」页按类型计数的条目统计展示。
