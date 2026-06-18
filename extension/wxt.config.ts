import { defineConfig } from "wxt";

// 上架商店包与自托管包共用一份源码,靠 manifest.key 的有无区分扩展 ID:
//
//   - serve(wxt dev)      注入 key → 固定 dev id nlnkemblgkpcpepbholdkcmcfgjhgfda
//   - chrome-selfhost     注入同一把 key → 同样固定为 nlnkem... id。供「GitHub
//                         Release 手动加载」用:无论解压到哪个目录,id 恒定且已被
//                         desktop NMH 的 allowed_origins 收录,native messaging 直通。
//   - chrome(上架包)      不注入 key:商店为 item 维护自己的公钥与 ID,包里带不一致
//                         的 key 会被拒上传(「清单中 key 字段的值与当前内容不符」)。
//
// key 必须与 desktop/electron/src/main/nmh-install.ts 的 CHROME_MANIFEST_KEY
// 同步,二者共同决定 nlnkem... 这个被授权的 id。
const ZPASS_EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArlMje6Tpk7iDCihHmujNEAnNQd3X3eRlwmyOC3jcfY3OTR6o1x0uAOoLGKvilu71hOjwnVLXvekvpQvO/i5cg0NUkqJpgdBOZgGcb9Bd7VUxCiouG5STqJUkzT+0UxYwhUkcxTXcjaeEQ00i1PDlrnISzZVxM2YQQvTtrx4qhOYgsuVA2JlwfQ8Zf0bbSFlreyPwEBUjRd4LFCn2y9qO8MNI3PjoW5WQHXRKJeyg8QBSK+wcNQDChWSlymIYzgRVK5KdCKccGf33i5Q0t9Wy1l2ywQ1PVhST5OYN1FOjoyZf9DrzCnAbBTe4w5sQQJnfxiDyZ5k52A9LzvBKfL85/QIDAQAB";

export default defineConfig({
  // 自托管手动加载包(ZPass-extension-chrome-selfhost.zip)文件名靠 {{browser}}
  // 注入 chrome-selfhost 区分,避免覆盖上架包默认产物名。
  zip: {
    artifactTemplate: "{{name}}-{{version}}-{{browser}}.zip",
  },
  // key 仅在 serve(本地调试)与 chrome-selfhost(手动加载发布包)注入,使扩展 ID 钉成
  // chromeExtensionIdFromKey(key) = nlnkemblgkpcpepbholdkcmcfgjhgfda(见上方说明)。
  // 上架包(默认 -b chrome / wxt build)必须去掉 key。
  manifest: ({ command, browser }) => ({
    name: "ZPass",
    description: "Secure autofill for ZPass desktop vaults.",
    ...(command === "serve" || browser === "chrome-selfhost"
      ? { key: ZPASS_EXTENSION_KEY }
      : {}),
    permissions: ["nativeMessaging", "activeTab", "tabs", "storage"],
    host_permissions: ["http://*/*", "https://*/*"],
    // - save-popup.html 走 browser.windows.create({ type: "popup" })，
    //   不需要 web_accessible_resources 授权（仅扩展上下文加载）。
    // - inline-menu-list.html 由 content script 通过 closed shadowRoot
    //   挂的 iframe 加载，src 为 chrome-extension://<id>/inline-menu-list.html，
    //   宿主页脚本无法穿透 closed shadow 也无法读 iframe 内容，但 iframe
    //   src 加载本身需要 web_accessible_resources 授权。
    web_accessible_resources: [
      {
        resources: ["inline-menu-list.html"],
        matches: ["http://*/*", "https://*/*"],
      },
    ],
    browser_specific_settings: {
      gecko: {
        id: "zpass-extension@zerx-lab.local",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
    action: {
      default_title: "ZPass",
      default_popup: "popup.html",
    },
    // 品牌图标：7x7 圆点矩阵字母 Z (OTP FEEL)，与 desktop/website 同源。
    // 源文件 public/icon/icon.svg，PNG 由 scripts/generate-icons.mjs 栅格化生成。
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      96: "icon/96.png",
      128: "icon/128.png",
    },
  }),
});
