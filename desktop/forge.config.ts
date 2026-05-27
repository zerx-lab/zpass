import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerAppImage } from "@reforged/maker-appimage";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { promises as fs } from "node:fs";
import { join } from "node:path";

// Locales we keep in the packaged app. Chromium *requires* en-US.pak as a
// fallback even if the UI is in another language — removing it breaks string
// lookups and shows boxes. zh-CN.pak covers the project's primary audience.
// To add a locale: drop its <lang>.pak name in here, no other change needed.
const KEEP_LOCALES = new Set(["en-US.pak", "zh-CN.pak"]);

// Electron Packager `afterExtract` hook: runs once Electron has been unpacked
// into the output dir, BEFORE app code is copied in. This is the right place
// to delete bundled-Electron files (locales, license dumps) because we're
// editing the Electron distribution itself, not our app's resources.
//
// Layout by platform (buildPath points at the dir below):
//   linux/win32  buildPath/locales/*.pak              buildPath/LICENSES.chromium.html
//   darwin       buildPath/Electron.app/Contents/Frameworks/Electron Framework.framework/
//                Versions/A/Resources/*.pak           and a LICENSES.chromium.html sibling
//
// We probe both layouts and silently skip whichever doesn't exist.
async function trimElectronExtras(buildPath: string): Promise<void> {
  const localesCandidates = [
    join(buildPath, "locales"),
    join(
      buildPath,
      "Electron.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Resources",
    ),
  ];
  for (const dir of localesCandidates) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    await Promise.all(
      entries
        .filter((n) => n.endsWith(".pak") && !KEEP_LOCALES.has(n))
        .map((n) => fs.rm(join(dir, n), { force: true })),
    );
  }

  // LICENSES.chromium.html is a ~20 MB legal-attribution dump that Chromium
  // ships next to the binary. Attribution still lives in the repo LICENSE
  // and can be surfaced via an About dialog when one is built — there's no
  // legal need to keep it at the app root as a giant HTML file.
  const licenseCandidates = [
    join(buildPath, "LICENSES.chromium.html"),
    join(
      buildPath,
      "Electron.app",
      "Contents",
      "Frameworks",
      "LICENSES.chromium.html",
    ),
  ];
  await Promise.all(licenseCandidates.map((p) => fs.rm(p, { force: true })));
}

// Forge config for the Relay Electron shell.
//
// The Go backend is shipped as a sidecar binary under `bin/<platform-arch>/`
// and copied into the app's resources at package time via `extraResource`.
// Build that binary with `task build:go` before running `task build`.
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Both fields drive Electron Packager's output layout:
    //   - `name`           -> determines `out/<name>-<platform>-<arch>/`
    //   - `executableName` -> the binary filename inside that dir + the
    //                         token Squirrel uses for app id (Windows)
    // We pin both to "zpass" (lowercase, FHS-safe) so downstream scripts
    // (scripts/make-arch.sh, install-desktop, future deb maker) don't need
    // to know about case quirks or the historical package.json name.
    name: "zpass",
    executableName: "zpass",
    // `icon` is base path; packager appends .png/.ico/.icns per platform.
    icon: "./assets/logo/zpass",
    extraResource: ["./bin", "./assets/logo"],
    // Windows PE VERSIONINFO. Without code signing the UAC "Publisher" line
    // stays "Unknown publisher" — that field reads strictly from the cert
    // Subject CN and cannot be set here. But UAC's large title, Task
    // Manager's process name, and the file-properties Details tab all read
    // from VERSIONINFO, so populating these turns "zpass.exe / unknown"
    // into "ZPass — Zero-knowledge password manager / ZPass" and removes
    // most of the "what is this thing" confusion before users hit the
    // SmartScreen / UAC dialogs.
    appCopyright: "Copyright (C) 2020-2026 Denver Technologies, Inc.",
    win32metadata: {
      CompanyName: "ZPass",
      FileDescription: "ZPass — Zero-knowledge password manager",
      OriginalFilename: "zpass.exe",
      ProductName: "ZPass",
      InternalName: "zpass",
    },
    // macOS ad-hoc 自签名. Apple Silicon (arm64) 强制要求所有原生可执行都必须
    // 通过 codesign, 哪怕只是无证书的 ad-hoc 签名 (identity '-'), 否则 Gatekeeper /
    // dyld 会拒绝加载, 表现为 Finder 弹 "App 已损坏, 无法打开". 我们没有付费的
    // Apple Developer ID, 这里只做 ad-hoc 兜底: 用户首次打开仍要在 "系统设置 ->
    // 隐私与安全性" 里手动放行 (或 `xattr -dr com.apple.quarantine /Applications/ZPass.app`),
    // 但不会再撞上 "已损坏" 这种硬阻断.
    //
    // 配置只在 darwin 平台被 Electron Packager 读取, 其它平台静默忽略, 因此不需
    // 要 if (process.platform === 'darwin') 包裹.
    osxSign: {
      identity: "-",
      optionsForFile: () => ({
        // 不传 entitlements: ad-hoc 签名跟 hardened runtime / notarization 不兼容,
        // 走默认 (inherit) 即可.
      }),
    },
    // Strip ~65 MB of unused locale .pak files and the 20 MB Chromium
    // license dump from the packaged app. See trimElectronExtras above.
    afterExtract: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        trimElectronExtras(buildPath).then(
          () => callback(),
          (err: unknown) =>
            callback(err instanceof Error ? err : new Error(String(err))),
        );
      },
    ],
  },
  rebuildConfig: {},
  // Per-platform makers. Electron Forge invokes each maker only on its
  // declared platforms, so a single `task make` run on a given OS produces
  // exactly the artifacts that OS can build.
  //
  //   linux   -> AppImage + .deb + .rpm (.pkg.tar.zst is produced separately
  //              by scripts/make-arch.sh; no Forge maker for pacman exists)
  //   win32   -> Squirrel.Windows (RELEASES + .nupkg + Setup.exe; auto-update capable)
  //   darwin  -> ZIP (no signing identity wired in yet)
  //
  // ZIP is also kept as a portable fallback on linux/win32.
  makers: [
    new MakerAppImage({
      options: {
        // Forge auto-discovers icon/categories from `extraResource` + package.json,
        // but being explicit avoids surprises across maker versions.
        icon: "./assets/logo/png/zpass-512.png",
        categories: ["Utility"],
      },
    }),
    new MakerDeb({
      options: {
        name: "zpass",
        productName: "ZPass",
        genericName: "Password Manager",
        description: "Zero-knowledge desktop password manager",
        homepage: "https://github.com/zerx-lab/zpass",
        maintainer: "zerx-lab",
        // 多尺寸 object → electron-installer-debian 装到
        // /usr/share/icons/hicolor/<NxN>/apps/zpass.png (而不是单文件
        // /usr/share/pixmaps/zpass.png), GNOME/KDE/任务栏才能按需挑分辨率.
        // Forge 的 MakerDebConfigOptions 把 icon 标成 string, 实际
        // electron-installer-debian 官方支持 {size: path} object.
        // @ts-expect-error upstream type 不全, runtime ok
        icon: {
          "16x16": "./assets/logo/png/zpass-16.png",
          "32x32": "./assets/logo/png/zpass-32.png",
          "48x48": "./assets/logo/png/zpass-48.png",
          "64x64": "./assets/logo/png/zpass-64.png",
          "128x128": "./assets/logo/png/zpass-128.png",
          "256x256": "./assets/logo/png/zpass-256.png",
          "512x512": "./assets/logo/png/zpass-512.png",
        },
        categories: ["Utility"],
        section: "utils",
        priority: "optional",
      },
    }),
    new MakerRpm({
      options: {
        name: "zpass",
        productName: "ZPass",
        genericName: "Password Manager",
        description: "Zero-knowledge desktop password manager",
        homepage: "https://github.com/zerx-lab/zpass",
        // 同 MakerDeb: 多尺寸 hicolor 注册而不是单张 pixmaps
        // @ts-expect-error upstream type 不全, runtime ok
        icon: {
          "16x16": "./assets/logo/png/zpass-16.png",
          "32x32": "./assets/logo/png/zpass-32.png",
          "48x48": "./assets/logo/png/zpass-48.png",
          "64x64": "./assets/logo/png/zpass-64.png",
          "128x128": "./assets/logo/png/zpass-128.png",
          "256x256": "./assets/logo/png/zpass-256.png",
          "512x512": "./assets/logo/png/zpass-512.png",
        },
        categories: ["Utility"],
        license: "MIT",
      },
    }),
    new MakerSquirrel({
      // `name` becomes the Squirrel app id; must be a valid file/dir token.
      name: "zpass",
      // `title` / `authors` / `description` populate the Setup.exe's own
      // VERSIONINFO and the Add/Remove Programs entry. Without these the
      // installer shows up as "zpass Setup" by an unknown author; with
      // them the user sees "ZPass" by "ZPass" in both places.
      title: "ZPass",
      authors: "ZPass",
      description: "Zero-knowledge desktop password manager",
      setupIcon: "./assets/logo/zpass.ico",
    }),
    new MakerZIP({}, ["darwin", "linux", "win32"]),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "electron/src/main/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "electron/src/preload/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    // Recommended Electron hardening. See:
    // https://www.electronjs.org/docs/latest/tutorial/fuses
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
