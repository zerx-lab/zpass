# ZPass 邮件模板

本目录存放上传到 listmonk (subscription.zerx.dev) 的 **Transactional 模板**源文件。

## 模板清单

| 文件 | listmonk 模板名 | 用途 |
|---|---|---|
| `confirm-subscription.html` | `ZPass – Confirm subscription` | 用户提交邮箱后，发给用户的双重确认链接邮件（替代 listmonk 默认的系统模板 `subscriber-optin.html`） |
| `welcome.html` | `ZPass – Welcome aboard` | 用户点击确认链接后发送的"订阅成功"欢迎邮件（listmonk 原生不会自动发，需外部触发） |

## 设计规范

邮件客户端（尤其是 Outlook / Gmail 网页版）对现代 CSS 支持有限。本目录的模板严格遵循：

- **全部颜色通过 `style=""` 内联**，不依赖 CSS 变量
- **表格 (`<table>`) 布局**，避免 `flex` / `grid`
- **字体**：首选 Geist → 回退到 `-apple-system, "Segoe UI", Roboto, sans-serif`；等宽首选 Geist Mono → 回退到 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
- **主色板**（与官网 `tokens.css` 暗色主题对齐）：
  - 背景 `#0c0c0d`
  - 卡面 `#111113`
  - 分隔线 `#232328`
  - 正文 `#ececec`
  - 次文 `#a8a8ac`
  - 强调 `#d4ff3a`（荧光黄绿） + 反向油墨 `#0c0c0d`
- **圆角**：仅用 `7px`（按钮）/ `10px`（卡片）
- **宽度**：主容器 `600px`，在 `@media (max-width: 620px)` 下退为 `100%`
- **`color-scheme: dark`** + `<meta name="color-scheme" content="dark">`，尽量阻止 Gmail iOS 反色

## 模板变量（listmonk Go template）

Transactional 模板（type=`tx`）**实测可用**变量（listmonk v5）：

- `{{ .Subscriber.Name }}` / `{{ .Subscriber.Email }}` / `{{ .Subscriber.FirstName }}` / `{{ .Subscriber.LastName }}`
- `{{ .Subscriber.Attribs.xxx }}`
- `{{ .Tx.Subject }}` / `{{ .Tx.Data.xxx }}` — 通过 `/api/tx` 的 `data` 字段注入的自定义变量

**⚠️ 注意**：`{{ .OptinURL }}` 和 `{{ .UnsubURL }}` 在 Transactional 模板里**不可用**，
运行时会报 `can't evaluate field OptinURL in type struct { Subscriber; Tx }`。
它们只存在于系统模板 `subscriber-optin.html` 的通知上下文里。
本目录两个模板因此改用 `{{ .Tx.Data.optin_url }}` 和 `{{ .Tx.Data.unsub_url }}`，
调用 `/api/tx` 时必须在 `data` 字段里显式传入。

## 如何推送到 listmonk

### 方式 A：UI 手工粘贴（一次性）

1. 登录 <https://subscription.zerx.dev/admin>
2. Campaigns → Templates → 新建
3. 类型选 **Transactional**
4. 复制对应 `.html` 文件整体粘贴到 Body 编辑器的 HTML 源码视图
5. Subject 填模板里 `<!-- SUBJECT: ... -->` 注释给出的默认主题

### 方式 B：REST API（推荐，可重复）

```bash
# 需要先在 Admin → Users 创建一个带 tx:send + templates:manage 权限的 API 用户，
# 拿到 username + token 后：
curl -u "api_user:TOKEN" \
  -H "Content-Type: application/json" \
  -X POST https://subscription.zerx.dev/api/templates \
  -d @- <<JSON
{
  "name": "ZPass – Confirm subscription",
  "type": "tx",
  "subject": "Confirm your ZPass subscription",
  "body": "$(cat confirm-subscription.html | jq -Rs .)"
}
JSON
```

已创建的模板 ID 记录在本 README 末尾，供 `/api/subscribe` 与未来的 `/api/tx` 触发器引用。

## 已部署模板 ID

- `confirm-subscription.html` → listmonk template **id = 5**（`ZPass – Confirm subscription`）
- `welcome.html` → listmonk template **id = 6**（`ZPass – Welcome aboard`）

## 维护脚本

- `push-templates-curl.nu` — 首次创建两个模板（POST /api/templates）
- `update-templates-curl.nu` — 本地 .html 改动后把内容同步到 listmonk（PUT /api/templates/:id）

运行方式（必须用 `--no-config-file` 绕开用户 nu 里对 `open` 的 alias）：
```sh
nu --no-config-file push-templates-curl.nu     # 首次创建
nu --no-config-file update-templates-curl.nu   # 之后每次改动 .html 同步上去
```

API 凭证目前硬编码在脚本里：`zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC`。
正式接入 website 后端时应改读 `import.meta.env.LISTMONK_API_TOKEN`。
