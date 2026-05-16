# ZPass 官网（website）

ZPass 官方网站，基于 [Astro](https://astro.build/) 5.x 构建，纯静态输出。
设计稿与原型源自同仓库的 [`../ZPassDesign/`](../ZPassDesign/)。

> **关于 ZPass**：一款基于零知识架构的跨平台密码管理器，端到端加密、支持自托管、完全开源（MIT）。

---

## 技术栈

- **框架**：Astro 5（静态站点生成）
- **语言**：TypeScript（strict）+ Astro 组件
- **样式**：纯 CSS + CSS 变量主题（dark / light），无 CSS 框架
- **字体**：Geist / Geist Mono（Google Fonts）
- **客户端脚本**：原生 TS / 内联 JS，无 React / Vue 等运行时
- **i18n**：Astro 原生 i18n（`en` 默认 + `zh` 走 `/zh/*` 前缀）

---

## 目录结构

```
website/
├── astro.config.mjs        # Astro 配置（含 i18n 路由）
├── package.json
├── tsconfig.json
├── public/                 # 静态资源（直接拷贝到 dist/）
│   └── demo/               # 实时 demo iframe 加载的 vault 原型
│       ├── zpass.html
│       └── src/*.jsx       # 原型 React 模块（Babel standalone 运行）
└── src/
    ├── i18n/
    │   └── strings.ts      # EN + ZH 全套文案 + 类型 + helper
    ├── styles/
    │   ├── tokens.css      # CSS 变量（颜色 / 字体 / 圆角 / 布局）
    │   └── global.css      # 组件样式（移植自设计稿 ZPass-Site.html）
    ├── layouts/
    │   └── BaseLayout.astro  # <html>/<head>、字体、reveal 动画脚本
    ├── components/
    │   ├── Nav.astro         # 顶部导航 + 语言切换
    │   ├── Hero.astro        # 主视觉 + 终端打字机面板
    │   ├── Install.astro     # 两张安装命令卡片（含一键复制）
    │   ├── Features.astro    # 6 格特性网格
    │   ├── How.astro         # 工作原理（SVG 流程图 + 三步循环高亮）
    │   ├── Live.astro        # 实时 demo iframe
    │   ├── Mobile.astro      # 移动端章节（手机外框 + 静态预览）
    │   ├── Security.astro    # 6 cell + 3 张审计卡
    │   ├── Pricing.astro     # 4 档定价
    │   ├── Changelog.astro   # 版本时间线
    │   ├── Faq.astro         # 手风琴问答
    │   └── Footer.astro      # 5 列页脚
    └── pages/
        ├── index.astro       # /        → 英文首页
        └── zh/
            └── index.astro   # /zh/     → 中文首页
```

---

## 本地开发

### 准备

需要 Node.js **18.17+** 或 **20.3+**（推荐 LTS）。当前开发使用 Node 24。

```sh
cd website
npm install
```

### 启动开发服务器

```sh
npm run dev
```

默认监听 `http://localhost:4321`。

- 英文首页：<http://localhost:4321/>
- 中文首页：<http://localhost:4321/zh/>
- 实时 demo（iframe 直链）：<http://localhost:4321/demo/zpass.html>

### 构建生产版本

```sh
npm run build       # 输出到 dist/
npm run preview     # 本地预览构建产物
```

---

## i18n 路由约定

由 `astro.config.mjs` 配置：

| 语言 | 路径前缀 | 示例 |
| --- | --- | --- |
| `en`（默认） | 无 | `/`、`/security` |
| `zh` | `/zh` | `/zh/`、`/zh/security` |

- 默认语言不带前缀（`prefixDefaultLocale: false`）
- `zh` 缺失页面回落到 `en`（`fallback.zh = "en"`）
- 切换语言时调用 `localizePath(path, target)`（见 `src/i18n/strings.ts`）

新增页面时，**两种语言都需要建对应文件**，例如：

```
src/pages/security.astro       → /security
src/pages/zh/security.astro    → /zh/security
```

---

## 设计系统速查

所有颜色、字体、圆角通过 CSS 变量定义在 `src/styles/tokens.css`：

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` | `#0c0c0d` | `#f5f5f3` |
| `--text` | `#ececec` | `#141416` |
| `--accent` | `#d4ff3a`（lime） | `#8ab10f` |
| `--font-sans` | Geist | Geist |
| `--font-mono` | Geist Mono | Geist Mono |

主题通过根元素属性切换：

```html
<html data-theme="dark" data-body="sans" style="--accent: #d4ff3a;">
```

`BaseLayout.astro` 接受 `theme` / `body` / `accent` props 透传到 `<html>`。

---

## 客户端交互（无框架）

所有交互通过 `<script>` / `is:inline` 实现，零运行时依赖：

| 组件 | 行为 |
| --- | --- |
| `BaseLayout` | `IntersectionObserver` 驱动 `.reveal` 滚动入场 |
| `Hero` | 终端打字机效果，链式触发下一步骤 |
| `Install` | `navigator.clipboard` 一键复制命令 |
| `How` | 三步循环高亮（自动 2.8s + 点击切换 + 进入视口才启动） |
| `Faq` | 手风琴折叠，同步 `aria-expanded` |
| `Nav` | 语言切换通过链接跳转，无需 JS |

---

## 实时 demo 说明

`Live.astro` 通过 `<iframe>` 加载 `/demo/zpass.html`，对应文件位于
`public/demo/`。这是从 `ZPassDesign/` 同步过来的设计原型，使用
React 18 + Babel standalone（CDN）渲染。

> **同步设计原型**：当 `ZPassDesign/ZPass.html` 或 `ZPassDesign/src/*.jsx`
> 有更新时，需手动复制对应文件到 `public/demo/` 与 `public/demo/src/` 下。
> 后续可考虑用 build 脚本自动化。

---

## 部署

构建产物为纯静态文件，可部署到任意静态托管：

- **Cloudflare Pages**：构建命令 `npm run build`，输出目录 `dist`
- **Vercel**：自动识别 Astro，无需额外配置
- **Netlify**：同上
- **自托管**：将 `dist/` 上传到 nginx/Caddy 等服务器

记得修改 `astro.config.mjs` 中的 `site` 字段为正式域名，影响：

- `<link rel="canonical">`
- `og:url` 等 meta
- 站点地图（如启用）

---

## 后续 TODO

- [ ] 拆分独立页面：`/security`、`/changelog`、`/pricing`、`/docs`
- [ ] 接入真实下载链接与 OS 自动检测
- [ ] 自动同步 `ZPassDesign/` → `public/demo/` 的构建脚本
- [ ] 加入 OG 图片（用 `@astrojs/og` 或 satori）
- [ ] 站点地图（`@astrojs/sitemap`）+ `robots.txt`
- [ ] 暗黑/亮色主题切换的客户端开关（设计稿 Tweaks 面板）
- [ ] Lighthouse / Pa11y CI 检查

---

## 许可证

源码 MIT。设计与文案版权归 ZPass 项目所有。