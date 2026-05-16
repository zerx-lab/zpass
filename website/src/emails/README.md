# ZPass 邮件模板

本目录存放上传到 listmonk (subscription.zerx.dev) 的 **Transactional 模板**源文件。

> 即将发布版本已经移除「邮件订阅」功能（`Subscribe.astro` + `/api/subscribe` +
> `confirm-subscription.html` + `welcome.html` 等已删除），目前仅保留「联系我们」
> 表单使用的两个回执模板。

## 模板清单

| 文件 | listmonk 模板名 | 用途 |
|---|---|---|
| `contact-ack-template.json` | `ZPass – Contact Ack` | 「联系我们」表单提交成功后发给用户的回执邮件 |
| `contact-notify-template.json` | `ZPass – Contact Notify` | 同时发给运维信箱的内部通知邮件 |

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

## 如何推送到 listmonk

### UI 手工粘贴

1. 登录 <https://subscription.zerx.dev/admin>
2. Campaigns → Templates → 新建
3. 类型选 **Transactional**
4. 复制对应 `.json` 文件中 `body` 字段的内容（注意去掉 JSON 转义）
   粘贴到 Body 编辑器的 HTML 源码视图
5. Subject 按文件里的 `subject` 字段填写

### REST API（推荐，可重复）

```bash
# 需要先在 Admin → Users 创建一个带 tx:send + templates:manage 权限的 API 用户，
# 拿到 username + token 后：
curl -u "api_user:TOKEN" \
  -H "Content-Type: application/json" \
  -X POST https://subscription.zerx.dev/api/templates \
  --data-binary @contact-ack-template.json
```

API 凭证目前硬编码在 `src/pages/api/contact.ts` 中：
`zpass_website:LwtNpxGclhjPkTI1qmgF0tDOIcKEmZMC`。
正式接入 website 后端时应改读 `import.meta.env.LISTMONK_API_TOKEN`。
