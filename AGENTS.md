# ZPass — AI Agent 指南

ZPass 是一款基于**零知识架构**的跨平台密码管理器，本仓库包含两个子项目：

| 子目录 | 说明 | 技术栈 |
|---|---|---|
| [`ZPassDesign/`](./ZPassDesign/) | 高保真交互原型，零构建，浏览器直开 | React 18 + Babel Standalone |
| [`website/`](./website/) | 官方营销网站，纯静态输出 | Astro 5 + TypeScript |

详细说明分别见 [ZPassDesign/README.md](./ZPassDesign/README.md) 与 [website/README.md](./website/README.md)。

---

## 关键约定

### 设计系统

- **CSS 变量**（Design Tokens）定义在 `ZPassDesign/src/tokens.css` 和 `website/src/styles/tokens.css`，两者保持同步。
- 主题切换通过 `<html data-theme="dark|light">` 驱动，**不要**用内联样式覆盖 token。
- 字体：`Geist`（正文）、`Geist Mono`（密码/TOTP/键盘快捷键），**不引入其他字体**。
- 圆角：仅用 `5 / 7 / 10 / 14 px`，描边优先于填充，分隔靠 `--line`。

### ZPassDesign — 原型层

- 所有 `.jsx` 通过 Babel Standalone 在浏览器内编译，**无需构建工具**。
- 模块间通过 `window.ZPASS_*` 全局命名空间通信（见 [README § 模块通信](./ZPassDesign/README.md)）。
- 每个原型顶部有 `EDITMODE` 块（`/*EDITMODE-BEGIN*/…/*EDITMODE-END*/`），保存设计走查默认状态，**修改时保持该注释标记不变**。
- 启动：`python -m http.server 8000` 或 `npx serve .`，然后浏览器打开对应 HTML 入口。

### website — 官网层

- 框架：Astro 5，**全站静态预渲染**；仅 `src/pages/api/*.ts` 通过 `export const prerender = false` 启用 SSR。
- **无客户端框架**：所有交互用原生 TS / 内联 JS，`<script is:inline>` 或 `<script>`，不引入 React/Vue 运行时。
- i18n：`en`（默认，无前缀）、`zh`（`/zh/` 前缀）。新增页面**两种语言都要建文件**。文案统一在 [`src/i18n/strings.ts`](./website/src/i18n/strings.ts)。
- 样式：纯 CSS + CSS 变量，**不使用 Tailwind 或其他 CSS 框架**。
- 实时 Demo：`website/public/demo/` 是从 `ZPassDesign/` 手动同步的快照，更新设计后需一并同步。

### 常用命令

```sh
# website 开发
cd website && npm install
npm run dev        # http://localhost:4321
npm run build      # 生产构建 → dist/
npm run preview    # 预览构建产物

# ZPassDesign 原型预览
cd ZPassDesign && python -m http.server 8000
# 或
npx serve ZPassDesign
```

---

## 易踩坑

- `public/demo/` 是静态快照，**不会**随 `ZPassDesign/src/` 自动更新，记得手动同步。
- `astro.config.mjs` 中的 `site` 字段影响 canonical URL 和 OG meta，本地开发无需修改，**发布前务必确认**。
- ZPassDesign 的 `.jsx` 文件挂载到 `window.ZPASS_*`，加载顺序由 HTML 中 `<script>` 标签顺序决定，依赖文件必须在前。
- i18n 字符串新增键值后，`en` 和 `zh` 两个对象都需要补全，否则会 fallback 显示 key 名。
