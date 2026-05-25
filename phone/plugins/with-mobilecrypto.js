// Expo Config Plugin —— 在 prebuild 时把 mobilecrypto.aar 拷贝进 Android 工程
// 并修改 app/build.gradle 把 libs/ 目录加入 dependencies。
//
// 为什么需要这个 plugin：
//   - phone/android/ 是 expo prebuild 的产物，在 phone/.gitignore 里
//   - 直接手改 phone/android/app/build.gradle 会被下一次 prebuild 抹掉
//   - 这里通过 expo config-plugins API 在 prebuild 流程中安全地注入
//
// 触发方式：
//   1. 先在 mobilecrypto/ 跑 scripts/build-android.sh 产出 AAR
//   2. 在 phone/ 跑 `expo prebuild` 或 `expo run:android`，本 plugin 自动应用
//
// 如果 AAR 不存在：plugin 不会失败（只 warn），允许 prebuild 继续，
// 用户可以先 prebuild 再补 AAR；运行期 zpass-crypto 找不到原生模块会
// 自动回退到 hash-wasm / noble 路径，功能不破。

const fs = require("fs");
const path = require("path");
const {
  withAppBuildGradle,
  withDangerousMod,
} = require("@expo/config-plugins");
const {
  mergeContents,
} = require("@expo/config-plugins/build/utils/generateCode");

const AAR_FILENAME = "mobilecrypto.aar";

/** 从 phone/plugins/ 推导出 mobilecrypto/build/mobilecrypto.aar */
function resolveSourceAAR(projectRoot) {
  return path.resolve(projectRoot, "..", "mobilecrypto", "build", AAR_FILENAME);
}

/** 把 fileTree libs 注入到 app/build.gradle dependencies 块；mergeContents 保证幂等 */
function injectAarDependency(contents) {
  return mergeContents({
    src: contents,
    newSrc: `    implementation fileTree(dir: "libs", include: ["*.aar", "*.jar"])`,
    anchor: /dependencies\s*\{/,
    offset: 1,
    tag: "mobilecrypto-aar",
    comment: "//",
  }).contents;
}

const withMobilecrypto = (config) => {
  // 1) 把 mobilecrypto.aar 复制到两处：
  //    - phone/android/app/libs/         主 app 运行期打包 .so
  //    - phone/modules/zpass-crypto/android/libs/   zpass-crypto compileOnly
  //   （Android library 间 AAR 不传递，必须两边都持有）
  config = withDangerousMod(config, [
    "android",
    async (cfg) => {
      const src = resolveSourceAAR(cfg.modRequest.projectRoot);
      if (!fs.existsSync(src)) {
        console.warn(
          `[with-mobilecrypto] AAR 不存在：${src}\n` +
            `  先在 mobilecrypto/ 跑 scripts/build-android.sh；` +
            `跳过 AAR 复制（运行期会回退到 hash-wasm/noble）`,
        );
        return cfg;
      }
      const targets = [
        path.join(cfg.modRequest.platformProjectRoot, "app", "libs"),
        path.join(
          cfg.modRequest.projectRoot,
          "modules",
          "zpass-crypto",
          "android",
          "libs",
        ),
      ];
      for (const dir of targets) {
        fs.mkdirSync(dir, { recursive: true });
        const dst = path.join(dir, AAR_FILENAME);
        fs.copyFileSync(src, dst);
        console.log(`[with-mobilecrypto] 已复制 AAR → ${dst}`);
      }
      return cfg;
    },
  ]);

  // 2) 修改 app/build.gradle dependencies 块，让主 app 把 libs 里的 AAR
  //    打包进 APK；zpass-crypto module 在编译期会 compileOnly 引用同一份。
  config = withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = injectAarDependency(cfg.modResults.contents);
    return cfg;
  });

  return config;
};

module.exports = withMobilecrypto;
