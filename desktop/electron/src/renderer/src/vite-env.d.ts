/// <reference types="vite/client" />

// Vite define 注入（见 vite.renderer.config.ts）：构建期内联的应用版本号常量，
// 权威来源为 desktop/package.json 的 version。
declare const __APP_VERSION__: string;
