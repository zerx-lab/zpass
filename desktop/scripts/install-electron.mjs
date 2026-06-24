// Force Electron's binary download through the npmmirror CDN.
//
// The default GitHub release host frequently times out in mainland China,
// which manifests as a hang on "Downloading Electron binary...". The usual
// fix (`electron_mirror=...` in .npmrc) only works under npm: pnpm does NOT
// inject .npmrc config keys into install-script environments as
// `npm_config_*`, so @electron/get falls back to GitHub and stalls.
//
// Running electron's own install.js with ELECTRON_MIRROR set as a real
// process env var is the one path @electron/get reads reliably across npm
// and pnpm. It reuses any cached zip, so this is a no-op once installed.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

process.env.ELECTRON_MIRROR ||= "https://npmmirror.com/mirrors/electron/";

require("electron/install.js");
