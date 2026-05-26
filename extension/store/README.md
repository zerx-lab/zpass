# Chrome Web Store 上架资源

ZPass 浏览器扩展上架 Chrome Web Store / Edge Add-ons 所需的全部资产。

## 文件清单

| 文件 | 尺寸 | 表单字段 | 备注 |
|---|---|---|---|
| `store-icon-128.png` | 128×128 | 商店图标 | 复用 `extension/public/icon/128.png`（7×7 圆点矩阵 Z，与桌面端 / 网站同源） |
| `promo-large-1400x560.png` | 1400×560 | 顶部宣传图块 | 可选，但推荐 —— 影响首页推荐位 |
| `promo-small-440x280.png` | 440×280 | 小型宣传图块 | 可选，但建议提供 —— 分类页缩略图 |
| `screenshot-1-inline-menu-1280x800.png` | 1280×800 | 屏幕截图 #1 | 内联自动填充菜单 |
| `screenshot-2-save-prompt-1280x800.png` | 1280×800 | 屏幕截图 #2 | 保存登录弹窗 |
| `screenshot-3-totp-1280x800.png` | 1280×800 | 屏幕截图 #3 | TOTP 一键填充 |
| `screenshot-4-passkey-1280x800.png` | 1280×800 | 屏幕截图 #4 | Passkey / WebAuthn 桥接 |
| `screenshot-5-popup-status-1280x800.png` | 1280×800 | 屏幕截图 #5 | 工具栏 popup 状态卡 |
| `listing-en.md` | — | 英文说明 / 标题 / 摘要 / 权限说明 | 直接复制粘贴到表单 |
| `listing-zh.md` | — | 中文说明 / 标题 / 摘要 / 权限说明 | 直接复制粘贴到表单 |

## 视觉规范（与项目设计系统保持一致）

- 背景：`#F7F8FA → #EEF0F3` 线性渐变（亮色品牌）
- 主文字：`#0A0A0A` · 次文字：`#5F6470` · 描边：`#D9DDE3` / `#E2E5EA`
- 字体：`Inter, system-ui, -apple-system, BlinkMacSystemFont`；等宽 `ui-monospace, 'SF Mono', Menlo, Consolas`
- 圆角：5 / 7 / 10 / 14 px（遵循 [`AGENTS.md`](../../AGENTS.md) 设计系统）
- 无 emoji、无 Unicode 装饰符号（与品牌铁律一致）

## 模块字段建议填法

```
Package title            ZPass
Package summary (EN)     Secure autofill for ZPass — a zero-knowledge,
                         local-first password manager. Logins, passkeys
                         & TOTP, end-to-end encrypted.
Category                 Productivity
Languages                English (en), 简体中文 (zh)
```

完整说明文案见 `listing-en.md` / `listing-zh.md`。
