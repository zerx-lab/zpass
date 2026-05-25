// Expo Config Plugin —— 在 prebuild 时把 libcryptocore.so 拷贝进 Android 工程
// 的 jniLibs 目录，让主 APK 在打包时自动包含 4 ABI 的 native lib。
//
// 为什么需要这个 plugin：
//   - phone/android/ 是 expo prebuild 的产物，在 phone/.gitignore 里
//   - 直接手放 .so 进 phone/android/app/src/main/jniLibs/ 会被下次 prebuild 抹掉
//   - 这里通过 expo config-plugins API 在 prebuild 流程中自动复制
//
// 触发方式：
//   1. 先在 cryptocore/ 跑 scripts/build-android.sh 产出 4 ABI .so
//   2. 在 phone/ 跑 `expo prebuild` 或 `expo run:android`，本 plugin 自动应用
//
// Android Gradle Plugin 默认会把 src/main/jniLibs/<abi>/*.so 打包进 APK，
// 不需要再改 build.gradle —— Kotlin 侧 System.loadLibrary("cryptocore") 在
// 运行期通过 APK 内 lib/<abi>/libcryptocore.so 解析。
//
// 如果 .so 不存在：plugin 不会失败（只 warn），允许 prebuild 继续，
// 用户可以先 prebuild 再补 .so；运行期 RustCryptoCore 初始化时 loadLibrary
// 会抛 UnsatisfiedLinkError，调用方需要 try/catch 回退到 hash-wasm/noble。

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

const LIB_NAME = "libcryptocore.so";
const ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];

/** 从 phone/plugins/ 推导出 cryptocore/build/jniLibs/<abi>/libcryptocore.so */
function resolveSourceSO(projectRoot, abi) {
  return path.resolve(
    projectRoot,
    "..",
    "cryptocore",
    "build",
    "jniLibs",
    abi,
    LIB_NAME,
  );
}

const withCryptocore = (config) => {
  config = withDangerousMod(config, [
    "android",
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const jniLibsRoot = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "jniLibs",
      );

      let copied = 0;
      const missing = [];
      for (const abi of ABIS) {
        const src = resolveSourceSO(projectRoot, abi);
        if (!fs.existsSync(src)) {
          missing.push(abi);
          continue;
        }
        const dstDir = path.join(jniLibsRoot, abi);
        fs.mkdirSync(dstDir, { recursive: true });
        const dst = path.join(dstDir, LIB_NAME);
        fs.copyFileSync(src, dst);
        copied++;
        console.log(`[with-cryptocore] 已复制 ${abi}/${LIB_NAME} → ${dst}`);
      }

      if (missing.length === ABIS.length) {
        console.warn(
          `[with-cryptocore] 所有 ABI 的 ${LIB_NAME} 都不存在。\n` +
            `  先在 cryptocore/ 跑 scripts/build-android.sh；` +
            `运行期 RustCryptoCore.loadLibrary 会抛 UnsatisfiedLinkError，` +
            `调用方需要回退到 JS 实现`,
        );
      } else if (missing.length > 0) {
        console.warn(
          `[with-cryptocore] 缺失以下 ABI（仅复制了 ${copied} 个）：${missing.join(", ")}\n` +
            `  在缺失 ABI 的设备上 RustCryptoCore 不可用`,
        );
      }

      return cfg;
    },
  ]);

  return config;
};

module.exports = withCryptocore;
