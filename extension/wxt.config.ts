import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "ZPass",
    description: "Secure autofill for ZPass desktop vaults.",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArlMje6Tpk7iDCihHmujNEAnNQd3X3eRlwmyOC3jcfY3OTR6o1x0uAOoLGKvilu71hOjwnVLXvekvpQvO/i5cg0NUkqJpgdBOZgGcb9Bd7VUxCiouG5STqJUkzT+0UxYwhUkcxTXcjaeEQ00i1PDlrnISzZVxM2YQQvTtrx4qhOYgsuVA2JlwfQ8Zf0bbSFlreyPwEBUjRd4LFCn2y9qO8MNI3PjoW5WQHXRKJeyg8QBSK+wcNQDChWSlymIYzgRVK5KdCKccGf33i5Q0t9Wy1l2ywQ1PVhST5OYN1FOjoyZf9DrzCnAbBTe4w5sQQJnfxiDyZ5k52A9LzvBKfL85/QIDAQAB",
    permissions: ["nativeMessaging", "activeTab", "tabs", "storage"],
    host_permissions: ["http://*/*", "https://*/*"],
    web_accessible_resources: [
      {
        // notification-bar.html 是 content-script 注入的 iframe 源，
        // 需要授权它能被任何 http/https 页面加载。同时限定 matches
        // 避免被不受躲躲 origin 代加载。
        resources: ["notification-bar.html"],
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
  },
});
